// 会话持久化层：JSONL 落盘 + 读取
//
// 物理本质：会话日志本。每轮对话结束往本上 append 一条消息（user/assistant），
// resume 时翻开本子读出所有条目，把历史喂给模型继续对话。
//
// 路径：~/.micode/sessions/<sessionId>.jsonl
// 格式：每行一个 JSON 对象 { role, content, timestamp }

import { readFile, appendFile, mkdir, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { Message } from '../agent/types.js';

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

  /** 列出所有会话摘要（按 mtime 降序，最近在前）。 */
  async list(): Promise<SessionSummary[]> {
    if (!existsSync(this.sessionsDir)) return [];
    const files = await readdir(this.sessionsDir);
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
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
}
