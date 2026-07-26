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
import { createHash, randomBytes } from 'node:crypto';
import type { Message } from '../agent/types.js';
import type { ToolTranscriptValidation } from '../agent/tools/transcript-validator.js';
import type { PendingSecurityDecision } from '../permission/runtime-gate.js';
import {
  deserializeMetaLifecycleRecord,
  serializeMetaLifecycleRecord,
  type MetaMessageLifecycleRecord,
} from '../agent/context/retention.js';

// ─── Wave G T2 hash helper ─────────────────────────────────────────────────
// 物理本质:把 store-local 的 record canonical 化成稳定字符串再 sha256,
// 用于 mint 出 `durable:`, `attempt:`, `swap:` 等 ID。canonical 形式按 key 字典序
// 输出,数组按出现顺序 — 与 retention.ts 的 canonicalJson 同语义(此处独立实现避免反向依赖)。

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

// ═══════════════════════════════════════════════════════════════════════════
// Wave G Task 2 (GRC-1 §7.21~§7.23): reconstruction transaction 持久化类型
// ═══════════════════════════════════════════════════════════════════════════
// 物理本质:Wave G 在 SessionStore 旁边新增"重建账本"。每个 session 一个独立的
// <id>.reconstruction.jsonl 文件,append-only,按 `record_kind` discriminator 区分:
//   - precompact       : savePreCompactSnapshot 写入(durable recovery point)
//   - attempt_begin    : beginReconstructionAttempt 写入(idempotent key 锚定)
//   - state_transition : appendReconstructionState 写入(append-only,不改旧 record)
//   - restored_snapshot: T9 publish 路径写入(loadRestoredWorkingSetSnapshot 读出)
//   - active_pointer   : compareAndSwapActiveWorkingSet 写入(单进程 CAS)
//
// 类型策略:这些 store-local 类型与 T1 (src/agent/context/reconstruction.ts)
// 的类型 structurally compatible。SessionStore 只关心能否读写这些字段,
// 不反向 import T1(避免循环依赖)。T1 完成后,其类型可直接喂给本 store 的方法。

/**
 * Reconstruction attempt 的有限状态机(Wave G 规格 §7.21)。
 * - `assembled`     : transaction 刚 begin,snapshot 已组装,未校验
 * - `validated`     : postflight validation 通过
 * - `publishing`    : 进入 atomic publish path(正在写 restored_snapshot + CAS)
 * - `published`     : publish ack durable,CAS swap 完成
 * - `failed`        : 任意阶段失败(validation/postflight/CAS)
 */
export type ReconstructionState =
  | 'assembled'
  | 'validated'
  | 'publishing'
  | 'published'
  | 'failed';

/**
 * Pre-compact snapshot —— durable recovery point。
 * 由调用方在 compact 之前拍下,作为 reconstruction 的起点。
 * 本 store 仅持久化此结构,不理解其语义。
 */
export interface PreCompactSnapshot {
  precompact_protocol_version: string;
  precompact_snapshot_id: string;
  session_id: string;
  session_snapshot_id: string;
  pinned_working_set_refs: string[];
  eviction_frontier_ref: string;
  captured_at: string;
}

/**
 * Post-compact reconstruction transaction —— 一次重建尝试的逻辑主体。
 * `idempotency_key` 是 beginReconstructionAttempt 的去重锚点:
 * 相同 key 第二次调用返回同一 attempt,不创建新 transaction。
 */
export interface PostCompactReconstructionTransaction {
  reconstruction_transaction_protocol_version: string;
  reconstruction_transaction_id: string;
  session_id: string;
  precompact_snapshot_id: string;
  idempotency_key: string;
  target_context_snapshot_id: string;
  restoration_directive_ref: string;
}

/**
 * Durable acknowledgement —— save* 方法返回的"已落盘"回执。
 * ack_id 是 record_id + 时间戳 + nonce 的 sha256 截短,确保两次 save 即使内容相同
 * 也产生不同 ack_id(防止调用方误以为旧 ack 是新 ack)。
 */
export interface DurableAcknowledgement {
  ack_protocol_version: string;          // 'mi.durable/1'
  ack_id: string;                        // 'durable:' + sha256(...).slice(0,16)
  record_id: string;                     // 被持久化的 record/snapshot id
  session_id: string;
  committed_at: string;                  // ISO timestamp
  sidecar_ref: string;                   // 'reconstruction.jsonl' 等标识
}

/**
 * Transaction attempt 状态(对应 PreCompactSnapshot + transactions)。
 * latest_state / latest_state_record_id 通过扫描 attempt_begin + 所有
 * state_transition records 计算得出(append-only,不修改旧 record)。
 */
export interface AttemptRecord {
  attempt_protocol_version: string;      // 'mi.attempt/1'
  attempt_id: string;                    // 'attempt:' + sha256(idempotency_key).slice(0,16)
  session_id: string;
  reconstruction_transaction_id: string;
  idempotency_key: string;
  precompact_snapshot_id: string;
  latest_state: ReconstructionState;
  latest_state_record_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Append-only state transition record。
 * `from_state` / `to_state` 描述一次状态跃迁;`payload_ref` 可选地引用
 * 相关 snapshot_id / candidate_id(如 'restored-ws-1')。
 * 任何 record 一经写入即不可变 — 修正只能再 append 一条新 record。
 */
export interface ReconstructionStateRecord {
  state_record_protocol_version: string; // 'mi.state_record/1'
  state_record_id: string;               // 'strec:' + sha256(...).slice(0,16)
  reconstruction_transaction_id: string;
  session_id: string;
  from_state: ReconstructionState | null;
  to_state: ReconstructionState;
  reason_codes: string[];
  transitioned_at: string;
  // 可选 payload ref(snapshot_id / candidate_id 等)
  payload_ref: string | null;
}

/**
 * Active working set pointer swap 的结果。
 * swap_status 三态:
 *   - `swapped`            : CAS 成功,active pointer 已切到 new_active_id
 *   - `cas_failed`         : expectedPreviousId 不匹配当前 pointer,未写入
 *   - `idempotent_replay`  : 同 idempotency_key + 同 newSnapshotId 已 publish 过,回放
 */
export interface ActiveWorkingSetSwapResult {
  swap_protocol_version: string;         // 'mi.swap/1'
  swap_id: string;
  session_id: string;
  swap_status: 'swapped' | 'cas_failed' | 'idempotent_replay';
  previous_active_id: string | null;
  new_active_id: string;
  transaction_id: string;
  idempotency_key: string;
  swapped_at: string;
}

/**
 * 持久化的 restored working set record(T9 publish path 写入)。
 * 完整 restored snapshot payload(规格 §7.22)。
 * SessionStore 只持久化 + 按 ID 查找,不解释其字段语义。
 */
export interface RestoredWorkingSetSnapshotRecord {
  record_protocol_version: string;       // 'mi.restored_ws_record/1'
  restored_working_set_snapshot_id: string;
  session_id: string;
  reconstruction_transaction_id: string;
  target_context_snapshot_id: string;
  // 完整 restored snapshot payload(规格 §7.22)
  bounded_memory_entrypoint_snapshot_ref: string | null;
  meta_context_message_refs: string[];
  compact_summary_ref: string;
  current_user_message_ref: string;
  execution_state_refs: string[];
  omission_manifest_ref: string;
  request_budget_snapshot_id: string;
  postflight_validation_ref: string;
  publish_ack_ref: string;
  restored_hash: string;
  created_at: string;
}

// ─── reconstruction.jsonl 内部 record 形状(discriminator: record_kind) ─────
// 所有 line type 都把 record_kind 作为最外层 discriminator,record 字段作为同级
// 平铺(便于人类 grep / 测试直接 JSON.parse 单行查看完整字段)。

interface PrecompactLine {
  record_kind: 'precompact';
  precompact_protocol_version: string;
  precompact_snapshot_id: string;
  session_id: string;
  session_snapshot_id: string;
  pinned_working_set_refs: string[];
  eviction_frontier_ref: string;
  captured_at: string;
  committed_at: string;
  ack_id: string;
}

interface AttemptBeginLine {
  record_kind: 'attempt_begin';
  attempt_protocol_version: string;
  attempt_id: string;
  session_id: string;
  reconstruction_transaction_id: string;
  idempotency_key: string;
  precompact_snapshot_id: string;
  latest_state: ReconstructionState;
  latest_state_record_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StateTransitionLine {
  record_kind: 'state_transition';
  state_record_protocol_version: string;
  state_record_id: string;
  reconstruction_transaction_id: string;
  session_id: string;
  from_state: ReconstructionState | null;
  to_state: ReconstructionState;
  reason_codes: string[];
  transitioned_at: string;
  payload_ref: string | null;
}

interface RestoredSnapshotLine {
  record_kind: 'restored_snapshot';
  record_protocol_version: string;
  restored_working_set_snapshot_id: string;
  session_id: string;
  reconstruction_transaction_id: string;
  target_context_snapshot_id: string;
  bounded_memory_entrypoint_snapshot_ref: string | null;
  meta_context_message_refs: string[];
  compact_summary_ref: string;
  current_user_message_ref: string;
  execution_state_refs: string[];
  omission_manifest_ref: string;
  request_budget_snapshot_id: string;
  postflight_validation_ref: string;
  publish_ack_ref: string;
  restored_hash: string;
  created_at: string;
}

interface ActivePointerLine {
  record_kind: 'active_pointer';
  swap_id: string;
  session_id: string;
  swap_status: 'swapped' | 'cas_failed' | 'idempotent_replay';
  previous_active_id: string | null;
  new_active_id: string;
  transaction_id: string;
  idempotency_key: string;
  swapped_at: string;
}

type ReconstructionLine =
  | PrecompactLine
  | AttemptBeginLine
  | StateTransitionLine
  | RestoredSnapshotLine
  | ActivePointerLine;

// ─── store-local hash helpers(独立实现,避免反向依赖 retention.ts) ──────────

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    .join(',')}}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function mintId(prefix: string, content: string): string {
  return `${prefix}:${sha256Hex(content).slice(0, 16)}`;
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

  // ═══════════════════════════════════════════
  // Wave E Task 2 (M-038 / ERC-1 §7.5): meta-lifecycle sidecar 持久化
  // ═══════════════════════════════════════════
  // 物理本质:会话日志本旁边的"meta 生命周期存档柜"。
  // 主日志 <id>.jsonl 只存 Provider 可见的消息(user/assistant turn);
  // meta 生命周期记录 <id>.meta-lifecycle.jsonl 单独存放,
  // 供 ERC-1 serializer round-trip 在 resume 时读出 resident/reload_required/invalidated 状态。
  //
  // 三条不变量(spec ERC-1 §7.5):
  //   - meta message 不计入 user turn(countUserTurns 只看主日志 .jsonl)。
  //   - load()/loadSync()/list() 绝不读 meta-lifecycle sidecar(隔离)。
  //   - 写入侧永远用 serializeMetaLifecycleRecord 包成 envelope(fail closed 反序列化)。

  /**
   * 往 meta-lifecycle sidecar append 一条 lifecycle record。
   * 文件不存在则创建。record 通过 `serializeMetaLifecycleRecord` 落盘,
   * resume 时由 `loadMetaLifecycle` 反序列化并 fail-closed 校验。
   */
  async saveMetaLifecycle(
    record: MetaMessageLifecycleRecord,
    sessionId: string,
  ): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const filePath = this.metaLifecyclePath(sessionId);
    const line = serializeMetaLifecycleRecord(record) + '\n';
    await appendFile(filePath, line, 'utf8');
  }

  /**
   * 读取 meta-lifecycle sidecar 的所有 record(按 append 顺序)。
   * 不存在返回空数组。每行通过 `deserializeMetaLifecycleRecord` 反序列化,
   * 任何一行损坏/篡改/未知协议版本 → 整体 fail closed 抛错,
   * 不静默降级为普通 user message(spec ERC-1 §7.5 rule 4 / §7.8)。
   */
  async loadMetaLifecycle(
    sessionId: string,
  ): Promise<MetaMessageLifecycleRecord[]> {
    const filePath = this.metaLifecyclePath(sessionId);
    if (!existsSync(filePath)) return [];
    const text = await readFile(filePath, 'utf8');
    const records: MetaMessageLifecycleRecord[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // fail closed: 不静默跳过任何损坏行。一行出错 → 整个 sidecar 不可信。
      records.push(deserializeMetaLifecycleRecord(trimmed));
    }
    return records;
  }

  /**
   * 统计主日志中的 user turn 数量。Meta lifecycle record 不计入
   * (它落在独立 sidecar,从不进入主 conversation jsonl)。
   * 不存在会话文件时返回 0。
   */
  async countUserTurns(sessionId: string): Promise<number> {
    const filePath = this.sessionPath(sessionId);
    if (!existsSync(filePath)) return 0;
    const text = await readFile(filePath, 'utf8');
    let count = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as SessionRecord;
        if (rec.role === 'user') count += 1;
      } catch {
        // 跳过损坏行(与 load() 一致的行为)
      }
    }
    return count;
  }

  /** meta-lifecycle sidecar 文件完整路径(与主日志同目录,不同后缀) */
  private metaLifecyclePath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.meta-lifecycle.jsonl`);
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
      // Wave E Task 2: 同样过滤 meta-lifecycle sidecar(<id>.meta-lifecycle.jsonl)。
      if (file.endsWith('.meta-lifecycle.jsonl')) continue;
      // Wave G Task 2: 同样过滤 reconstruction sidecar(<id>.reconstruction.jsonl)。
      if (file.endsWith('.reconstruction.jsonl')) continue;
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
      // Wave E Task 2: 同样过滤 meta-lifecycle sidecar。
      if (file.endsWith('.meta-lifecycle.jsonl')) continue;
      // Wave G Task 2: 同样过滤 reconstruction sidecar。
      if (file.endsWith('.reconstruction.jsonl')) continue;
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

  // ═══════════════════════════════════════════════════════════════════════
  // Wave G Task 2 (GRC-1 §7.21~§7.23): reconstruction sidecar 持久化
  // ═══════════════════════════════════════════════════════════════════════
  // 物理本质:SessionStore 旁边的"重建账本"。
  // 主日志 <id>.jsonl 只存 Provider 可见的消息;
  // 重建账本 <id>.reconstruction.jsonl 单独存放,append-only,
  // 按 record_kind discriminator 区分 5 种 record(precompact / attempt_begin /
  // state_transition / restored_snapshot / active_pointer)。
  //
  // 不变量(Wave G 规格):
  //   - INV-G14 Publish 原子:CAS 失败不半工作集(active pointer 不动)
  //   - INV-G15 旧 snapshot 可恢复:publish ack durable 前旧 snapshot 保持 active
  //   - INV-G16 Retry 幂等:相同 idempotency key 不重复 publish
  //   - §7.13 rule 6:publish ack 只能由 atomic publish path 产生
  //   - §7.23 Recovery:进程在 publish 前退出 → 旧 snapshot active;
  //                     进程在 pointer swap 后退出 → 依据 durable ack 恢复新 snapshot
  //
  // 与主日志 / 其他 sidecar 严格隔离:list() / load() / loadSync() /
  // getLastSessionIdSync() 绝不读 reconstruction.jsonl(已加入过滤名单)。
  //
  // 并发模型:本实现是单进程原子(append-only + 扫描),不防多进程并发。
  // 多进程 CAS 需要文件锁,不在 Wave G 范围。

  /** reconstruction sidecar 文件完整路径(与主日志同目录,不同后缀) */
  private reconstructionPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.reconstruction.jsonl`);
  }

  /**
   * 读 reconstruction.jsonl 所有行,JSON.parse 成 ReconstructionLine。
   * Fail-closed:任何一行 JSON 损坏 → 抛错(与 loadMetaLifecycle 一致),
   * 不静默跳过 — 否则可能让 attempt 看起来"少了一条 transition"。
   */
  private async readReconstructionLines(
    sessionId: string,
  ): Promise<ReconstructionLine[]> {
    const filePath = this.reconstructionPath(sessionId);
    if (!existsSync(filePath)) return [];
    const text = await readFile(filePath, 'utf8');
    const lines: ReconstructionLine[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // fail closed:不静默跳过损坏行(与 loadMetaLifecycle 一致)
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(`reconstruction.malformed_line: not valid JSON`);
      }
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as { record_kind?: unknown }).record_kind !== 'string'
      ) {
        throw new Error('reconstruction.malformed_line: missing record_kind');
      }
      lines.push(parsed as ReconstructionLine);
    }
    return lines;
  }

  /** Append 一行到 reconstruction.jsonl(目录不存在则创建)。 */
  private async appendReconstructionLine(
    sessionId: string,
    line: ReconstructionLine,
  ): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const filePath = this.reconstructionPath(sessionId);
    const text = JSON.stringify(line) + '\n';
    await appendFile(filePath, text, 'utf8');
  }

  // ─── 公开 API ────────────────────────────────────────────────────────────

  /**
   * 1. 保存 pre-compact snapshot(durable recovery point)。
   *
   * 写入 `precompact` record(snapshot 字段平铺到 line 顶层),返回 DurableAcknowledgement。
   * ack_id = sha256(record_id + committed_at + nonce).slice(0,16),确保两次
   * save 即使内容相同也有不同 ack(防止调用方误把旧 ack 当新 ack)。
   */
  async savePreCompactSnapshot(
    snapshot: PreCompactSnapshot,
    sessionId: string,
  ): Promise<DurableAcknowledgement> {
    const committedAt = new Date().toISOString();
    const nonce = randomBytes(8).toString('hex');
    const ackId = mintId(
      'durable',
      canonicalJson({
        record_id: snapshot.precompact_snapshot_id,
        committed_at: committedAt,
        nonce,
      }),
    );
    const line: PrecompactLine = {
      record_kind: 'precompact',
      precompact_protocol_version: snapshot.precompact_protocol_version,
      precompact_snapshot_id: snapshot.precompact_snapshot_id,
      session_id: snapshot.session_id,
      session_snapshot_id: snapshot.session_snapshot_id,
      pinned_working_set_refs: snapshot.pinned_working_set_refs,
      eviction_frontier_ref: snapshot.eviction_frontier_ref,
      captured_at: snapshot.captured_at,
      committed_at: committedAt,
      ack_id: ackId,
    };
    await this.appendReconstructionLine(sessionId, line);
    return {
      ack_protocol_version: 'mi.durable/1',
      ack_id: ackId,
      record_id: snapshot.precompact_snapshot_id,
      session_id: sessionId,
      committed_at: committedAt,
      sidecar_ref: 'reconstruction.jsonl',
    };
  }

  /**
   * 2. 加载 pre-compact snapshot(按 precompact_snapshot_id)。
   * 扫描 reconstruction.jsonl 找最后一个匹配的 precompact record。
   * 不存在或 id 不匹配 → null。
   */
  async loadPreCompactSnapshot(
    sessionId: string,
    precompactSnapshotId: string,
  ): Promise<PreCompactSnapshot | null> {
    const lines = await this.readReconstructionLines(sessionId);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (
        line.record_kind === 'precompact' &&
        line.precompact_snapshot_id === precompactSnapshotId
      ) {
        return {
          precompact_protocol_version: line.precompact_protocol_version,
          precompact_snapshot_id: line.precompact_snapshot_id,
          session_id: line.session_id,
          session_snapshot_id: line.session_snapshot_id,
          pinned_working_set_refs: line.pinned_working_set_refs,
          eviction_frontier_ref: line.eviction_frontier_ref,
          captured_at: line.captured_at,
        };
      }
    }
    return null;
  }

  /**
   * 3. 开始 reconstruction attempt(Idempotent)。
   *
   * Algorithm:
   *   1. 扫描 reconstruction.jsonl,找 attempt_begin 且 idempotency_key 匹配
   *   2. 找到 → 重新计算 latest_state(扫描所有 state_transition)返回已有 attempt
   *   3. 未找到 → append 新 attempt_begin record,返回新 AttemptRecord
   *
   * INV-G16:相同 idempotency_key 不创建新 attempt,不修改旧 record。
   */
  async beginReconstructionAttempt(
    transaction: PostCompactReconstructionTransaction,
  ): Promise<AttemptRecord> {
    const sessionId = transaction.session_id;
    const idempotencyKey = transaction.idempotency_key;
    const attemptId = mintId('attempt', idempotencyKey);

    // 1. 扫描已有 attempt
    const existing = await this.loadReconstructionAttempt(sessionId, idempotencyKey);
    if (existing !== null) {
      return existing;
    }

    // 2. 创建新 attempt
    const now = new Date().toISOString();
    const attempt: AttemptRecord = {
      attempt_protocol_version: 'mi.attempt/1',
      attempt_id: attemptId,
      session_id: sessionId,
      reconstruction_transaction_id: transaction.reconstruction_transaction_id,
      idempotency_key: idempotencyKey,
      precompact_snapshot_id: transaction.precompact_snapshot_id,
      latest_state: 'assembled',
      latest_state_record_id: null,
      created_at: now,
      updated_at: now,
    };
    const line: AttemptBeginLine = {
      record_kind: 'attempt_begin',
      ...attempt,
    };
    await this.appendReconstructionLine(sessionId, line);
    return attempt;
  }

  /**
   * 4. Append state transition record(append-only,不修改旧 record)。
   *
   * 写入 `state_transition` record。后续 loadReconstructionAttempt 调用会
   * 通过扫描这些 record 重新计算 attempt.latest_state(最后一条的 to_state)。
   * 不修改 attempt_begin record 自身(append-only)。
   */
  async appendReconstructionState(
    record: ReconstructionStateRecord,
    sessionId: string,
  ): Promise<void> {
    const line: StateTransitionLine = {
      record_kind: 'state_transition',
      state_record_protocol_version: record.state_record_protocol_version,
      state_record_id: record.state_record_id,
      reconstruction_transaction_id: record.reconstruction_transaction_id,
      session_id: record.session_id,
      from_state: record.from_state,
      to_state: record.to_state,
      reason_codes: record.reason_codes,
      transitioned_at: record.transitioned_at,
      payload_ref: record.payload_ref,
    };
    await this.appendReconstructionLine(sessionId, line);
  }

  /**
   * 5. 按 idempotency key 查找 attempt。
   *
   * 扫描 reconstruction.jsonl:
   *   1. 找 attempt_begin record 且 idempotency_key 匹配
   *   2. 扫描所有 state_transition record(同 transaction_id),取最后一条的 to_state
   *   3. 用最后一条 transition 的 transitioned_at 作为 updated_at
   *
   * 找不到 → null。
   */
  async loadReconstructionAttempt(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<AttemptRecord | null> {
    const lines = await this.readReconstructionLines(sessionId);

    // 找 attempt_begin(取最后一个匹配的)
    let attempt: AttemptRecord | null = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (
        line.record_kind === 'attempt_begin' &&
        line.idempotency_key === idempotencyKey
      ) {
        attempt = {
          attempt_protocol_version: line.attempt_protocol_version,
          attempt_id: line.attempt_id,
          session_id: line.session_id,
          reconstruction_transaction_id: line.reconstruction_transaction_id,
          idempotency_key: line.idempotency_key,
          precompact_snapshot_id: line.precompact_snapshot_id,
          latest_state: line.latest_state,
          latest_state_record_id: line.latest_state_record_id,
          created_at: line.created_at,
          updated_at: line.updated_at,
        };
        break;
      }
    }
    if (attempt === null) return null;

    // 扫描同 transaction_id 的 state_transition(append-only,按顺序)
    const txId = attempt.reconstruction_transaction_id;
    let latestState: ReconstructionState = attempt.latest_state;
    let latestStateRecordId: string | null = attempt.latest_state_record_id;
    let updatedAt: string = attempt.updated_at;
    for (const line of lines) {
      if (
        line.record_kind === 'state_transition' &&
        line.reconstruction_transaction_id === txId
      ) {
        latestState = line.to_state;
        latestStateRecordId = line.state_record_id;
        updatedAt = line.transitioned_at;
      }
    }
    return {
      ...attempt,
      latest_state: latestState,
      latest_state_record_id: latestStateRecordId,
      updated_at: updatedAt,
    };
  }

  /**
   * 6. 获取 active working set pointer(指向最后一次 publish 的 restored snapshot)。
   *
   * 扫描 reconstruction.jsonl,返回最后一个 active_pointer record 的 new_active_id。
   * 没有 → null(还没 publish 过,旧 snapshot 仍 active)。
   */
  async getActiveWorkingSetId(sessionId: string): Promise<string | null> {
    const lines = await this.readReconstructionLines(sessionId);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (line.record_kind === 'active_pointer') {
        // cas_failed / idempotent_replay 不更新 pointer — 只 swapped 才反映新 active
        if (line.swap_status === 'swapped') {
          return line.new_active_id;
        }
        // 否则继续往前找最近的 swapped pointer
      }
    }
    return null;
  }

  /**
   * 7. 设置 active working set pointer(单进程原子 — compare-and-swap)。
   *
   * Algorithm(INV-G14 Publish 原子 / INV-G16 Retry 幂等):
   *   1. 扫描已有 active_pointer,找最近一次 swapped 的 new_active_id = current
   *   2. 扫描所有 active_pointer,看是否有相同 idempotency_key 的"已决"pointer:
   *      - 同 key + 同 new_active_id → idempotent_replay(回放相同 publish,不写新 record)
   *      - 同 key + 不同 new_active_id → cas_failed(同 key 不允许切到不同 snapshot)
   *   3. 否则比较 expectedPreviousId === current:
   *      - 匹配 → 写新 active_pointer record(swap_status='swapped')
   *      - 不匹配 → 写 active_pointer record(swap_status='cas_failed'),active 不变
   *
   * 注:cas_failed 时也写一条 record(audit trail),但 active pointer 不变
   * (getActiveWorkingSetId 只看 swap_status='swapped')。
   */
  async compareAndSwapActiveWorkingSet(input: {
    sessionId: string;
    expectedPreviousId: string | null;
    newSnapshotId: string;
    transactionId: string;
    idempotencyKey: string;
  }): Promise<ActiveWorkingSetSwapResult> {
    const { sessionId } = input;
    const lines = await this.readReconstructionLines(sessionId);

    // 1. 计算 current active(最后一条 swapped pointer 的 new_active_id)
    let currentActiveId: string | null = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (line.record_kind === 'active_pointer' && line.swap_status === 'swapped') {
        currentActiveId = line.new_active_id;
        break;
      }
    }

    // 2. idempotency 检查:扫描同 idempotency_key 的"已决"pointer(swapped/replay)
    //    - 同 key + 同 new_active_id → idempotent_replay
    //    - 同 key + 不同 new_active_id → cas_failed(同 key 切不同 snapshot)
    let replayedSwapId: string | null = null;
    let replayedSwappedAt: string | null = null;
    let replayedPreviousActiveId: string | null = null;
    let sameKeyDifferentSnapshot = false;
    for (const line of lines) {
      if (line.record_kind !== 'active_pointer') continue;
      if (line.idempotency_key !== input.idempotencyKey) continue;
      // 只看已决的 pointer(swapped 或 idempotent_replay) — cas_failed 不算"已决"
      if (
        line.swap_status !== 'swapped' &&
        line.swap_status !== 'idempotent_replay'
      ) {
        continue;
      }
      if (line.new_active_id === input.newSnapshotId) {
        replayedSwapId = line.swap_id;
        replayedSwappedAt = line.swapped_at;
        // 捕获原始 previous_active_id(spec §7.21 rule: replay 返回与首次相同的现场)。
        replayedPreviousActiveId = line.previous_active_id;
      } else {
        sameKeyDifferentSnapshot = true;
      }
    }

    const swappedAt = new Date().toISOString();
    const swapId = mintId(
      'swap',
      canonicalJson({
        idempotency_key: input.idempotencyKey,
        new_snapshot_id: input.newSnapshotId,
        // nonce 确保两个不同的 swap(同 key 但不同 snapshot_id)swap_id 不同;
        // 但 idempotent replay 不会走到这里 — replay 直接返回原 swap_id
        nonce: randomBytes(8).toString('hex'),
      }),
    );

    // 3a. idempotent replay:回放相同 publish,不写新 record
    if (replayedSwapId !== null) {
      return {
        swap_protocol_version: 'mi.swap/1',
        swap_id: replayedSwapId,
        session_id: sessionId,
        swap_status: 'idempotent_replay',
        // 返回首次 swap 时的 previous_active_id(不是 currentActiveId)—— 让重放
        // 与首次 publish 返回完全相同的结果,使依赖 previous_active 的派生值
        // (如 publish_ack_id)在 retry 时保持确定性(spec §7.24 idempotency rule)。
        previous_active_id: replayedPreviousActiveId,
        new_active_id: input.newSnapshotId,
        transaction_id: input.transactionId,
        idempotency_key: input.idempotencyKey,
        swapped_at: replayedSwappedAt!,
      };
    }

    // 3b. 同 key + 不同 snapshot → cas_failed(写 audit record)
    if (sameKeyDifferentSnapshot) {
      const line: ActivePointerLine = {
        record_kind: 'active_pointer',
        swap_id: swapId,
        session_id: sessionId,
        swap_status: 'cas_failed',
        previous_active_id: currentActiveId,
        new_active_id: input.newSnapshotId,
        transaction_id: input.transactionId,
        idempotency_key: input.idempotencyKey,
        swapped_at: swappedAt,
      };
      await this.appendReconstructionLine(sessionId, line);
      return {
        swap_protocol_version: 'mi.swap/1',
        swap_id: swapId,
        session_id: sessionId,
        swap_status: 'cas_failed',
        previous_active_id: currentActiveId,
        new_active_id: input.newSnapshotId,
        transaction_id: input.transactionId,
        idempotency_key: input.idempotencyKey,
        swapped_at: swappedAt,
      };
    }

    // 4. CAS 检查:expectedPreviousId === current
    if (input.expectedPreviousId !== currentActiveId) {
      // cas_failed:写 audit record(但 active pointer 不变)
      const line: ActivePointerLine = {
        record_kind: 'active_pointer',
        swap_id: swapId,
        session_id: sessionId,
        swap_status: 'cas_failed',
        previous_active_id: currentActiveId,
        new_active_id: input.newSnapshotId,
        transaction_id: input.transactionId,
        idempotency_key: input.idempotencyKey,
        swapped_at: swappedAt,
      };
      await this.appendReconstructionLine(sessionId, line);
      return {
        swap_protocol_version: 'mi.swap/1',
        swap_id: swapId,
        session_id: sessionId,
        swap_status: 'cas_failed',
        previous_active_id: currentActiveId,
        new_active_id: input.newSnapshotId,
        transaction_id: input.transactionId,
        idempotency_key: input.idempotencyKey,
        swapped_at: swappedAt,
      };
    }

    // 5. CAS 成功:写 swapped pointer
    const line: ActivePointerLine = {
      record_kind: 'active_pointer',
      swap_id: swapId,
      session_id: sessionId,
      swap_status: 'swapped',
      previous_active_id: currentActiveId,
      new_active_id: input.newSnapshotId,
      transaction_id: input.transactionId,
      idempotency_key: input.idempotencyKey,
      swapped_at: swappedAt,
    };
    await this.appendReconstructionLine(sessionId, line);
    return {
      swap_protocol_version: 'mi.swap/1',
      swap_id: swapId,
      session_id: sessionId,
      swap_status: 'swapped',
      previous_active_id: currentActiveId,
      new_active_id: input.newSnapshotId,
      transaction_id: input.transactionId,
      idempotency_key: input.idempotencyKey,
      swapped_at: swappedAt,
    };
  }

  /**
   * 8. 加载已发布的 restored working set snapshot(按 ID)。
   *
   * T9 publish path 把 restored_snapshot record 写入 reconstruction.jsonl,
   * 本方法按 restored_working_set_snapshot_id 查找。
   * 不存在 → null。
   */
  async loadRestoredWorkingSetSnapshot(
    sessionId: string,
    snapshotId: string,
  ): Promise<RestoredWorkingSetSnapshotRecord | null> {
    const lines = await this.readReconstructionLines(sessionId);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (
        line.record_kind === 'restored_snapshot' &&
        line.restored_working_set_snapshot_id === snapshotId
      ) {
        return {
          record_protocol_version: line.record_protocol_version,
          restored_working_set_snapshot_id: line.restored_working_set_snapshot_id,
          session_id: line.session_id,
          reconstruction_transaction_id: line.reconstruction_transaction_id,
          target_context_snapshot_id: line.target_context_snapshot_id,
          bounded_memory_entrypoint_snapshot_ref:
            line.bounded_memory_entrypoint_snapshot_ref,
          meta_context_message_refs: line.meta_context_message_refs,
          compact_summary_ref: line.compact_summary_ref,
          current_user_message_ref: line.current_user_message_ref,
          execution_state_refs: line.execution_state_refs,
          omission_manifest_ref: line.omission_manifest_ref,
          request_budget_snapshot_id: line.request_budget_snapshot_id,
          postflight_validation_ref: line.postflight_validation_ref,
          publish_ack_ref: line.publish_ack_ref,
          restored_hash: line.restored_hash,
          created_at: line.created_at,
        };
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Wave G Task 9 (GRC-1 §7.21~§7.23): atomic publish 持久化辅助
  // ═══════════════════════════════════════════════════════════════════════
  // 物理本质:T9 publish path 的三步:
  //   1. saveRestoredWorkingSetSnapshot —— 把 restored snapshot payload 落盘
  //      (必须先于 CAS,保证 active pointer 一旦切到新 snapshot 就可加载)。
  //   2. compareAndSwapActiveWorkingSet —— 原子切 active pointer(已由 T2 提供)。
  //   3. savePublishAcknowledgement —— 写 publish ack record(state_transition 形态),
  //      把 ack 绑定到 transaction / candidate / restored snapshot / target context /
  //      published hash / commit time。
  //
  // 三步**不是文件级原子**(JSONL append-only 没有事务);但通过"CAS 失败不半
  // 工作集"+"ack durable 前 active 不切"的顺序保证,我们达到等价语义(spec §7.21
  // rule 1-7):
  //   - INV-G14 Publish 原子:CAS 失败 → 旧 snapshot 仍 active(active pointer 不动)。
  //   - INV-G15 旧 snapshot 可恢复:在 ack durable 之前 active pointer 未被切走。
  //   - 进程在 step 1 后退出但 step 2 前 → restored snapshot 已落盘但 active 未切;
  //     重启后 getActiveWorkingSetId 仍返回旧 snapshot(无 active_pointer record)。
  //   - 进程在 step 2 后退出但 step 3 前 → active pointer 已指向新 snapshot,但 ack
  //     缺失;recovery 用 loadRestoredWorkingSetSnapshot 重建 ack(spec §7.23)。
  //
  // save* 方法的幂等性:
  //   - saveRestoredWorkingSetSnapshot:相同 restored_working_set_snapshot_id 第二次
  //     写入 → no-op(已有同样 record,不重复 append;不同字段值则也 no-op —— restored
  //     snapshot 不可变,二次写入应当字段相同)。
  //   - savePublishAcknowledgement:相同 publish_ack_id 第二次写入 → no-op。

  /**
   * 9. 保存 restored working set snapshot record(T9 publish step 1)。
   *
   * 物理上把 restored snapshot payload 追加到 reconstruction.jsonl。在 CAS 之前
   * 调用 —— 保证 compareAndSwapActiveWorkingSet 成功后 active pointer 指向的
   * snapshot 一定可加载。
   *
   * 幂等性:同 restored_working_set_snapshot_id 的 record 已存在时 → no-op(不
   * 重复 append)。
   */
  async saveRestoredWorkingSetSnapshot(
    snapshot: RestoredWorkingSetSnapshotRecord,
    sessionId: string,
  ): Promise<void> {
    // 幂等检查:同 id 的 restored_snapshot 已存在 → 不重复写入。
    const existing = await this.loadRestoredWorkingSetSnapshot(
      sessionId,
      snapshot.restored_working_set_snapshot_id,
    );
    if (existing !== null) {
      return;
    }
    const line: RestoredSnapshotLine = {
      record_kind: 'restored_snapshot',
      record_protocol_version: snapshot.record_protocol_version,
      restored_working_set_snapshot_id: snapshot.restored_working_set_snapshot_id,
      session_id: sessionId,
      reconstruction_transaction_id: snapshot.reconstruction_transaction_id,
      target_context_snapshot_id: snapshot.target_context_snapshot_id,
      bounded_memory_entrypoint_snapshot_ref:
        snapshot.bounded_memory_entrypoint_snapshot_ref,
      meta_context_message_refs: snapshot.meta_context_message_refs,
      compact_summary_ref: snapshot.compact_summary_ref,
      current_user_message_ref: snapshot.current_user_message_ref,
      execution_state_refs: snapshot.execution_state_refs,
      omission_manifest_ref: snapshot.omission_manifest_ref,
      request_budget_snapshot_id: snapshot.request_budget_snapshot_id,
      postflight_validation_ref: snapshot.postflight_validation_ref,
      publish_ack_ref: snapshot.publish_ack_ref,
      restored_hash: snapshot.restored_hash,
      created_at: snapshot.created_at,
    };
    await this.appendReconstructionLine(sessionId, line);
  }

  /**
   * 10. 按 publish_ack_id 查找 durable publish acknowledgement record。
   *
   * publish ack 是一条 state_transition record,以 reason_codes[0]='publish.ack'
   * 标识,payload_ref 携带 restored_working_set_snapshot_id。本方法扫描所有
   * publish ack,找第一个 state_record_id === publishAckId 的。
   *
   * 不存在 → null。
   */
  async loadPublishAcknowledgement(
    sessionId: string,
    publishAckId: string,
  ): Promise<ReconstructionStateRecord | null> {
    const lines = await this.readReconstructionLines(sessionId);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (
        line.record_kind === 'state_transition' &&
        line.state_record_id === publishAckId &&
        line.to_state === 'published'
      ) {
        return {
          state_record_protocol_version: line.state_record_protocol_version,
          state_record_id: line.state_record_id,
          reconstruction_transaction_id: line.reconstruction_transaction_id,
          session_id: line.session_id,
          from_state: line.from_state,
          to_state: line.to_state,
          reason_codes: line.reason_codes,
          transitioned_at: line.transitioned_at,
          payload_ref: line.payload_ref,
        };
      }
    }
    return null;
  }

  /**
   * 11. 保存 durable publish acknowledgement record(T9 publish step 3)。
   *
   * 物理上是 state_transition record(to_state='published'),reason_codes[0]
   * 携带 'publish.ack' 标识,payload_ref 指向 restored_working_set_snapshot_id。
   * replay 时用 loadPublishAcknowledgement 重新构造 ack。
   *
   * 幂等性:同 publish_ack_id(state_record_id)的 record 已存在 → no-op。
   */
  async savePublishAcknowledgement(
    record: ReconstructionStateRecord,
    sessionId: string,
  ): Promise<void> {
    // 幂等检查。
    const existing = await this.loadPublishAcknowledgement(
      sessionId,
      record.state_record_id,
    );
    if (existing !== null) {
      return;
    }
    await this.appendReconstructionState(record, sessionId);
  }
}
