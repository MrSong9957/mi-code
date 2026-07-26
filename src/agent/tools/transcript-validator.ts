// src/agent/tools/transcript-validator.ts
// Task 10 (M-070 / BRC-5): Tool Transcript Validator.
//
// 物理本质: tool use/result 配对的因果完整性校验。在 Provider send、persistence、
// compaction、finalization 四个 checkpoint 前扫描 transcript snapshot,把每个
// ToolUseBlock 与其 ToolResultBlock 配对,分类出 6 种 pair state,映射到
// accepted/blocked/rejected。
//
// 关键边界 (来自 spec §11):
//   - validator 不合成 tool result。
//   - validator 不判 tool 业务结果是否正确。
//   - validator 不决定 partial/failed Outcome (那是 RC-4 的事)。
//   - validator 不读 summary 文本判定完成 —— 只有 ToolResultBlock 算作 result。
//   - pending_execution 只能从 executing_facts.executing_tool_call_ids 推出,
//     绝不靠猜。
//
// 状态优先级: rejected > blocked > accepted。
//
// 确定性: 同一 transcript_snapshot_id + checkpoint + validator_policy_id +
// validator_policy_version 必须返回相同的 status / pair_records / reason_codes,
// 以及相同的 validation_id (基于上述字段的 sha256 哈希)。

import { createHash } from 'node:crypto';
import type { Message, ToolResultBlock, ToolUseBlock } from '../types.js';
import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

/** 单个 tool use/result 配对的分类状态。 */
export type ToolPairState =
  | 'pending_execution'
  | 'paired'
  | 'missing_result'
  | 'orphan_result'
  | 'duplicate_result'
  | 'identity_conflict';

/** 四个强制校验点。 */
export type TranscriptCheckpoint =
  | 'before_provider_send'
  | 'before_persistence'
  | 'before_compaction'
  | 'before_finalization';

/** 单个 tool use/result 配对的记录。 */
export interface ToolPairRecord {
  session_id: string;
  turn_id: string;
  /** 工具名 (来自 ToolUseBlock.name)。 */
  tool_id: string;
  /** 配对键 = ToolUseBlock.id === ToolResultBlock.tool_use_id。 */
  tool_call_id: string;
  /** 包含 ToolUseBlock 的 message 的稳定引用。 */
  tool_use_message_ref: string;
  /** 包含最终 ToolResultBlock 的 message 的引用;未配对时为 null。 */
  tool_result_message_ref: string | null;
  state: ToolPairState;
  /** 执行 journal 引用;本 validator 不消费,留给 RC-4/执行 journal,当前为 null。 */
  execution_state_ref: string | null;
}

/** 一次校验的不可变结果。 */
export interface ToolTranscriptValidation {
  validation_protocol_version: string;
  validation_id: string;
  transcript_snapshot_id: string;
  checkpoint: TranscriptCheckpoint;
  status: 'accepted' | 'blocked' | 'rejected';
  validator_policy_id: string;
  validator_policy_version: string;
  pair_records: ReadonlyArray<ToolPairRecord>;
  reason_codes: string[];
}

/** 不可变的 transcript snapshot 输入。 */
export interface ToolTranscriptSnapshot {
  transcript_snapshot_id: string;
  session_id: string;
  turn_id: string;
  messages: ReadonlyArray<Message>;
}

/** validator policy 身份 (来自 Authority)。 */
export interface ValidatorPolicyIdentity {
  validator_policy_id: string;
  validator_policy_version: string;
}

/** 独立执行 journal 的已知事实。 */
export interface ExecutionJournalFacts {
  // Map of tool_call_id -> true, indicating the tool is known to be currently executing.
  // When present, a missing result is classified 'pending_execution' (blocked),
  // not 'missing_result' (rejected).
  executing_tool_call_ids: ReadonlySet<string>;
}

/** 协议版本硬编码。 */
const VALIDATION_PROTOCOL_VERSION = '1';

/** validation_id 前缀。 */
const VALIDATION_ID_PREFIX = 'tv:';

const CHECKPOINTS: ReadonlySet<TranscriptCheckpoint> = new Set<TranscriptCheckpoint>([
  'before_provider_send',
  'before_persistence',
  'before_compaction',
  'before_finalization',
]);

/**
 * 对一份 transcript snapshot 执行 tool use/result 配对校验。
 *
 * 不合成 result、不判业务对错、不读 summary 文本、不决定 Outcome。
 * 输出三层深冻结,确定性可复现。
 */
export function validateToolTranscript(
  snapshot: ToolTranscriptSnapshot,
  options: {
    checkpoint: TranscriptCheckpoint;
  } & ValidatorPolicyIdentity & { executing_facts?: ExecutionJournalFacts },
): ToolTranscriptValidation {
  // 身份校验 —— 都必须是非空字符串。
  const transcript_snapshot_id = requireIdentity(
    snapshot.transcript_snapshot_id,
    'transcript_snapshot_id',
  );
  const session_id = requireIdentity(snapshot.session_id, 'session_id');
  const turn_id = requireIdentity(snapshot.turn_id, 'turn_id');
  const validator_policy_id = requireIdentity(
    options.validator_policy_id,
    'validator_policy_id',
  );
  const validator_policy_version = requireIdentity(
    options.validator_policy_version,
    'validator_policy_version',
  );

  // checkpoint 枚举校验 (TS 类型已约束,但运行时防御)。
  if (!CHECKPOINTS.has(options.checkpoint)) {
    throw new Error(`checkpoint must be one of the known checkpoints`);
  }

  const executing = options.executing_facts?.executing_tool_call_ids ?? new Set<string>();

  // ---------- 第一遍: 扫描 messages,收集 use / result 事实 ----------
  //
  // 按 message 在 transcript 中的物理顺序遍历,给每条 message 一个稳定引用
  // (msg@<index>)。use / result 的归属基于它们的物理位置,不依赖时间戳。
  //
  // 同一 use id 出现多次 → identity_conflict (session 内 tool_call_id 唯一)。
  // 同一 use id 的多个 result → duplicate_result (一个 use 最多一个最终 result)。
  // result 引用了不存在的 use id → orphan_result。

  interface UseFact {
    tool_call_id: string;
    tool_id: string;
    use_message_ref: string;
    // 当 result 已落到此 use 时,记录第一个 result 的 message ref。
    first_result_message_ref: string | null;
    result_count: number;
  }

  interface ResultFact {
    tool_use_id: string;
    result_message_ref: string;
  }

  const useOrder: string[] = []; // 按 use 首次出现的 tool_call_id 顺序
  const uses = new Map<string, UseFact>();
  const duplicateUseIds = new Set<string>(); // 同一 tool_call_id 出现多次 use
  const orphanResults: ResultFact[] = []; // 引用了不存在 use 的 result
  const resultsInOrder: ResultFact[] = [];

  const messages = snapshot.messages;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg === null || msg === undefined) continue;
    const msgRef = `msg@${i}`;
    const content = msg.content;
    if (!Array.isArray(content)) continue; // string content (纯文本消息) 没有块

    for (const block of content) {
      if (block === null || block === undefined) continue;
      if (block.type === 'tool_use') {
        const useBlock = block as ToolUseBlock;
        const id = useBlock.id;
        if (uses.has(id)) {
          // session 内 tool_call_id 唯一 —— 第二次出现记为 conflict。
          duplicateUseIds.add(id);
          continue;
        }
        uses.set(id, {
          tool_call_id: id,
          tool_id: useBlock.name,
          use_message_ref: msgRef,
          first_result_message_ref: null,
          result_count: 0,
        });
        useOrder.push(id);
      } else if (block.type === 'tool_result') {
        const resultBlock = block as ToolResultBlock;
        const refId = resultBlock.tool_use_id;
        const fact: ResultFact = { tool_use_id: refId, result_message_ref: msgRef };
        resultsInOrder.push(fact);
        const use = uses.get(refId);
        if (use === undefined) {
          // result 引用了不存在的 use —— orphan (可能稍后才出现 use,先暂存)
          orphanResults.push(fact);
        } else {
          use.result_count += 1;
          if (use.first_result_message_ref === null) {
            use.first_result_message_ref = msgRef;
          }
        }
      }
      // text / image / 其他类型: 都不算 tool result,忽略。
    }
  }

  // ---------- 第二遍: 处理结果后置出现的情况 ----------
  //
  // 上面在遍历到 result 时,若 use 尚未出现,标为 orphan。但 result 可能
  // 在物理顺序上先于 use 出现 (理论上 provider 不该这么做,但 validator
  // 只验证身份/配对,不验证时序)。因此做一次"延迟重认领":对每条 orphan
  // result,如果它的 use id 在最终扫描后存在,把它从 orphan 改为"挂载到 use"。
  //
  // 注意: 即使 result 先于 use 出现,只要 id 匹配且只此一份,仍算 paired。
  // identity_conflict 仅适用于"同一 id 出现多次 use"。
  const stillOrphans: ResultFact[] = [];
  for (const orphan of orphanResults) {
    const use = uses.get(orphan.tool_use_id);
    if (use === undefined) {
      stillOrphans.push(orphan); // 真正的 orphan —— 没有匹配的 use
    } else {
      // 延迟认领 —— use 在 result 之后出现,但 id 匹配。
      use.result_count += 1;
      if (use.first_result_message_ref === null) {
        use.first_result_message_ref = orphan.result_message_ref;
      }
    }
  }

  // ---------- 第三遍: 为每个 use 构造 ToolPairRecord ----------
  //
  // 状态分类:
  //   - identity_conflict: 该 use 的 tool_call_id 出现了 >1 次 use (即使是第一次出现的 use 也标 conflict)
  //   - duplicate_result: 该 use 有 >1 个 result
  //   - paired: 恰好 1 个 result
  //   - missing_result / pending_execution: 0 个 result
  //       - 若 executing 含此 tool_call_id -> pending_execution (blocked)
  //       - 否则 -> missing_result (rejected)
  //
  // 优先级 (对单个 record): identity_conflict > duplicate_result > paired/(missing|pending)
  // (identity_conflict 是结构错误,优先于重复结果;重复结果优先于单纯的配对状态。)
  //
  // orphan result 不挂在 use 上,单独作为 record 输出 (state = orphan_result)。
  // spec §11.3 不变量 2: "一个 result 必须引用同一 session 中一个已存在 use"
  // → orphan 是协议失败 (rejected)。

  const pairRecords: ToolPairRecord[] = [];

  for (const tool_call_id of useOrder) {
    const use = uses.get(tool_call_id)!;
    let state: ToolPairState;
    if (duplicateUseIds.has(tool_call_id)) {
      state = 'identity_conflict';
    } else if (use.result_count > 1) {
      state = 'duplicate_result';
    } else if (use.result_count === 1) {
      state = 'paired';
    } else {
      // result_count === 0
      state = executing.has(tool_call_id) ? 'pending_execution' : 'missing_result';
    }
    pairRecords.push({
      session_id,
      turn_id,
      tool_id: use.tool_id,
      tool_call_id,
      tool_use_message_ref: use.use_message_ref,
      tool_result_message_ref: use.first_result_message_ref,
      state,
      execution_state_ref: null,
    });
  }

  // orphan result —— 每条单独一个 record (tool_id 未知,因为没 use 可查)。
  for (const orphan of stillOrphans) {
    pairRecords.push({
      session_id,
      turn_id,
      tool_id: '',
      tool_call_id: orphan.tool_use_id,
      tool_use_message_ref: '', // 没有匹配的 use
      tool_result_message_ref: orphan.result_message_ref,
      state: 'orphan_result',
      execution_state_ref: null,
    });
  }

  // ---------- reason_codes ----------
  //
  // 结构化: pair.<state>:<tool_call_id>。accepted 时为空数组。
  // 顺序: 先按 state 排序 (rejected-class 优先显示),再按 tool_call_id。
  // 最终 reason_codes 数组在 validation_id 哈希前会再排序一次,保证确定性。

  const reasonCodes: string[] = [];
  for (const r of pairRecords) {
    if (r.state === 'paired') continue;
    reasonCodes.push(`pair.${r.state}:${r.tool_call_id}`);
  }

  // ---------- 状态映射 (rejected > blocked > accepted) ----------
  const hasRejected = pairRecords.some(
    (r) =>
      r.state === 'missing_result' ||
      r.state === 'orphan_result' ||
      r.state === 'duplicate_result' ||
      r.state === 'identity_conflict',
  );
  const hasBlocked = pairRecords.some((r) => r.state === 'pending_execution');
  const status: 'accepted' | 'blocked' | 'rejected' = hasRejected
    ? 'rejected'
    : hasBlocked
      ? 'blocked'
      : 'accepted';

  // ---------- 确定性 validation_id ----------
  //
  // 哈希字段 (顺序敏感):
  //   transcript_snapshot_id | checkpoint | validator_policy_id | validator_policy_version
  //   | canonical pair records (sorted by tool_call_id, each "<tool_call_id>|<state>")
  //   | canonical reason_codes (sorted)
  //
  // 注意: pair_records 数组的物理顺序不影响 id —— 只用 sorted 视图。
  // 这保证 "重新排序 messages 但配对内容相同" 的等价 transcript 产生相同的 id。

  const canonicalPairs = pairRecords
    .map((r) => `${r.tool_call_id}|${r.state}`)
    .sort()
    .join(',');
  const canonicalReasons = [...reasonCodes].sort().join(',');

  const hashInput = [
    transcript_snapshot_id,
    options.checkpoint,
    validator_policy_id,
    validator_policy_version,
    canonicalPairs,
    canonicalReasons,
  ].join('|');
  const hash = createHash('sha256').update(hashInput, 'utf8').digest('hex');
  const validation_id = VALIDATION_ID_PREFIX + hash;

  // ---------- 组装并深冻结 ----------
  const validation: ToolTranscriptValidation = {
    validation_protocol_version: VALIDATION_PROTOCOL_VERSION,
    validation_id,
    transcript_snapshot_id,
    checkpoint: options.checkpoint,
    status,
    validator_policy_id,
    validator_policy_version,
    pair_records: pairRecords,
    reason_codes: reasonCodes,
  };

  // 冻结顺序: 先每个 record (无嵌套对象),再 pair_records 数组,再 reason_codes,
  // 最后顶层 validation 对象。freezeSnapshot 递归冻结,会一并处理。
  for (const r of validation.pair_records) {
    freezeSnapshot(r);
  }
  freezeSnapshot(validation.pair_records);
  freezeSnapshot(validation.reason_codes);
  return freezeSnapshot(validation);
}
