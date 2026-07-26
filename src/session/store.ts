// 会话持久化层：JSONL 落盘 + 读取
//
// 物理本质：会话日志本。每轮对话结束往本上 append 一条消息（user/assistant），
// resume 时翻开本子读出所有条目，把历史喂给模型继续对话。
//
// 路径：~/.micode/sessions/<sessionId>.jsonl
// 格式：每行一个 JSON 对象 { role, content, timestamp }

import { readFile, appendFile, mkdir, readdir, stat } from 'fs/promises';
import { readFileSync, readdirSync, statSync, existsSync as existsSyncFs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { Message } from '../agent/types.js';
import type { ToolTranscriptValidation } from '../agent/tools/transcript-validator.js';
import type { PendingSecurityDecision } from '../permission/runtime-gate.js';

/** 会话文件里每行的记录（Message + 时间戳） */
interface SessionRecord {
  role: 'user' | 'assistant';
  content: string | unknown[];
  timestamp: number;
}

/** list() 返回的会话摘要 */
export interface SessionSummary {
  id: string;
  firstUserInput: string;
  messageCount: number;
  mtime: number;  // 最后修改时间
}

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(baseDir?: string) {
    const base = baseDir ?? join(homedir(), '.micode');
    this.sessionsDir = join(base, 'sessions');
  }

  /** 往会话 append 一条消息。会话文件不存在则创建。 */
  async append(sessionId: string, message: Message): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const filePath = this.sessionPath(sessionId);
    const record: SessionRecord = {
      role: message.role,
      content: message.content as string | unknown[],
      timestamp: Date.now(),
    };
    const line = JSON.stringify(record) + '\n';
    await appendFile(filePath, line, 'utf8');
  }

  /**
   * Wave B Task 11 (M-070 / BRC-5): 结构化 append 路径,带 `before_persistence` checkpoint。
   *
   * 物理本质: "先体检再上账"。往会话日志本写一条之前,先要求调用方出示一份
   * `before_persistence` checkpoint 上的 accepted validation —— 证明这条消息参与的
   * transcript 配对完整(use/result 都成对)。配对不完整的消息不允许落盘成"成对"语义,
   * 防止后续 resume 读到一个假装已配对、实则缺失 result 的历史。
   *
   * 要求(任意一条不满足都 fail-closed 抛错,不写盘):
   *   - validation.checkpoint === 'before_persistence'
   *   - validation.status === 'accepted'
   *
   * 失败时抛出结构化错误 `{ code: 'tool_transcript.invalid', checkpoint: 'before_persistence' }`。
   *
   * 注意:
   *   - validator 不合成 result、不决定 partial/failed Outcome(RC-4 的事),它只校验配对。
   *   - 老的 `append()` 方法保持不变,留给 legacy 调用方(尚未接入 checkpoint 的路径)。
   *   - 这里只校验 validation 的身份字段,不重新扫描 messages —— validator 本身已做了
   *     确定性校验,这里信任那份冻结的结果(frozen validation 不可变)。
   */
  async appendValidatedTranscript(
    sessionId: string,
    message: Message,
    validation: ToolTranscriptValidation,
  ): Promise<void> {
    if (
      validation.checkpoint !== 'before_persistence' ||
      validation.status !== 'accepted'
    ) {
      throw {
        code: 'tool_transcript.invalid',
        checkpoint: 'before_persistence',
      };
    }
    // 校验通过 —— 走与 append() 完全相同的落盘逻辑
    await this.append(sessionId, message);
  }

  /** 读取整个会话的消息列表（按 append 顺序）。不存在返回空数组。 */
  async load(sessionId: string): Promise<Message[]> {
    const filePath = this.sessionPath(sessionId);
    if (!existsSync(filePath)) return [];
    const text = await readFile(filePath, 'utf8');
    const messages: Message[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as SessionRecord;
        messages.push({ role: rec.role, content: rec.content as Message['content'] });
      } catch {
        // 跳过损坏行（部分写入等）
      }
    }
    return messages;
  }

  // ═══════════════════════════════════════════
  // Wave B Task 13 (M-066): pending-decision sidecar 持久化
  // ═══════════════════════════════════════════
  // 物理本质:会话日志本旁边的"待审单据夹"。
  // 主日志 <id>.jsonl 只存 Provider 可见的消息(user/assistant turn);
  // 待审单据 <id>.pending-decisions.jsonl 单独存放(每行一个 PendingSecurityDecision),
  // 供 gate 在 ask 阻塞期间记录、resume 时读出 awaiting_user 单据。
  //
  // 两条文件 MUST NOT 混合:list() 只看 .jsonl(主日志),load() 只读 .jsonl。

  /** 往 sidecar 文件 append 一条 pending decision。文件不存在则创建。 */
  async appendPendingDecision(sessionId: string, pending: PendingSecurityDecision): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const filePath = this.pendingDecisionsPath(sessionId);
    const line = JSON.stringify(pending) + '\n';
    await appendFile(filePath, line, 'utf8');
  }

  /** 读取 sidecar 文件的所有 pending decisions(按 append 顺序)。不存在返回空数组。 */
  async loadPendingDecisions(sessionId: string): Promise<readonly PendingSecurityDecision[]> {
    const filePath = this.pendingDecisionsPath(sessionId);
    if (!existsSync(filePath)) return [];
    const text = await readFile(filePath, 'utf8');
    const pendings: PendingSecurityDecision[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        pendings.push(JSON.parse(trimmed) as PendingSecurityDecision);
      } catch {
        // 跳过损坏行(部分写入等)
      }
    }
    return pendings;
  }

  /** sidecar 文件完整路径(与主日志 <id>.jsonl 同目录,不同后缀) */
  private pendingDecisionsPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.pending-decisions.jsonl`);
  }

  /** 列出所有会话摘要（按 mtime 降序，最近在前）。 */
  async list(): Promise<SessionSummary[]> {
    if (!existsSync(this.sessionsDir)) return [];
    const files = await readdir(this.sessionsDir);
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      // Wave B Task 13: 显式过滤 sidecar(<id>.pending-decisions.jsonl),
      // 它也是 .jsonl 后缀但绝不是主会话日志。
      if (!file.endsWith('.jsonl')) continue;
      if (file.endsWith('.pending-decisions.jsonl')) continue;
      const id = file.slice(0, -6); // 去掉 .jsonl
      const filePath = join(this.sessionsDir, file);
      try {
        const st = await stat(filePath);
        const text = await readFile(filePath, 'utf8');
        const lines = text.split('\n').filter(l => l.trim());
        const firstLine = lines[0];
        let firstUserInput = '';
        if (firstLine) {
          const rec = JSON.parse(firstLine) as SessionRecord;
          firstUserInput = typeof rec.content === 'string' ? rec.content : '(结构化内容)';
        }
        summaries.push({
          id,
          firstUserInput,
          messageCount: lines.length,
          mtime: st.mtimeMs,
        });
      } catch {
        // 跳过损坏文件
      }
    }
    // 按 mtime 降序
    summaries.sort((a, b) => b.mtime - a.mtime);
    return summaries;
  }

  /** 获取最近一个会话的 id（mtime 最大）。无会话返回 null。 */
  async getLastSessionId(): Promise<string | null> {
    const list = await this.list();
    return list.length > 0 ? list[0]!.id : null;
  }

  /** 会话文件完整路径 */
  private sessionPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  // ═══════ 同步版本（启动时用，避免顶层 await） ═══════

  /** 同步读取整个会话消息列表。不存在返回空数组。 */
  loadSync(sessionId: string): Message[] {
    const filePath = this.sessionPath(sessionId);
    if (!existsSyncFs(filePath)) return [];
    const text = readFileSync(filePath, 'utf8');
    const messages: Message[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as SessionRecord;
        messages.push({ role: rec.role, content: rec.content as Message['content'] });
      } catch {
        // 跳过损坏行
      }
    }
    return messages;
  }

  /** 同步获取最近一个会话的 id。无会话返回 null。 */
  getLastSessionIdSync(): string | null {
    if (!existsSyncFs(this.sessionsDir)) return null;
    let latest: { id: string; mtime: number } | null = null;
    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.jsonl')) continue;
      // Wave B Task 13: 同 list(),过滤 sidecar。
      if (file.endsWith('.pending-decisions.jsonl')) continue;
      const id = file.slice(0, -6);
      try {
        const st = statSync(join(this.sessionsDir, file));
        if (!latest || st.mtimeMs > latest.mtime) {
          latest = { id, mtime: st.mtimeMs };
        }
      } catch {
        // 跳过
      }
    }
    return latest ? latest.id : null;
  }
}
