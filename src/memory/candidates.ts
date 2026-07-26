// TypedMemoryCandidate (CRC-3 / M-043)
//
// 物理本质:候选记忆的"门卫 + 内容寻址 ID 生成器"。
//
// 这个文件只做两件事:
//   1. 校验调用方传入的字段是否满足 §9.7 的不变量 —— 不满足就 throw,
//      candidate 根本不会形成。
//   2. 把通过校验的字段冻结成不可变对象,并用内容寻址 (sha256) 算出
//      `memory_candidate_id`,让相同语义的 candidate 可被去重。
//
// 这个文件 *不* 做的事 (INV-C7 / §9.7-7):
//   - 不存储、不合并、不删除、不 admit 任何 candidate。
//   - 不把旧 MemoryManager 条目自动分类成新类型 (历史迁移是 Wave D)。
//   - 不实现 admission policy (M-044)。
//   - 不赋予 candidate 任何 Authority —— candidate 只是待评估的输入。
//
// 规格来源:docs/superpowers/specs/2026-07-26-agent-policy-contracts-wave-c-design.md
//   §9.6 / §9.7 / §9.8 / §17.3

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../agent/contracts/identities.js';

/**
 * candidate 协议版本。结构变化时递增。
 * 这是 candidate 的 schema 标记,与 Authority 无关 —— 读端必须自行决定是否信任。
 */
export const MEMORY_CANDIDATE_PROTOCOL_VERSION = '1';

/**
 * mi-code 冻结的四个初始 candidate type。
 *
 * 这些类型由"当前使用语义"定义,不是 Claude 四类记忆的搬运 (§9.7-9)。
 */
export type AutoMemoryType =
  | 'user_preference'
  | 'project_fact'
  | 'workflow_pattern'
  | 'failure_observation';

const AUTO_MEMORY_TYPES: ReadonlySet<AutoMemoryType> = new Set<AutoMemoryType>([
  'user_preference',
  'project_fact',
  'workflow_pattern',
  'failure_observation',
]);

/**
 * BRC-3 中允许创建 memory candidate 的唯一 writer kind。
 * 任何其它 writer (例如 memory_manager 本身、UI、外部脚本) 都不能直接构造 candidate。
 */
export const AUTO_MEMORY_WRITER_KIND = 'auto_memory_writer';

/**
 * 已构造完成的 candidate —— 不可变,只携带数据字段,无任何 mutation 方法。
 *
 * INV-C7:candidate ≠ admitted/stored/selected/used memory。
 */
export interface TypedMemoryCandidate {
  memory_candidate_protocol_version: string;
  memory_candidate_id: string;
  source_context_id: string;
  type: AutoMemoryType;
  claim: string;
  scope_ref: string;
  evidence_refs: string[];
  confidence: number;
  observed_at: string;
  expires_at: string | null;
  context_refs: string[];
  invalidation_conditions: string[];
  sensitivity_labels: string[];
}

/**
 * turn 的结果。用于 cancelled turn 不得生成 failure_observation 的判定 (§9.7-4)。
 * 未提供时按"非 cancelled"处理。
 */
export type TurnOutcome = 'completed' | 'failed' | 'cancelled';

/**
 * 构造 candidate 的输入。除列出的字段外还需要:
 *   - writer_kind:必须等于 BRC-3 `auto_memory_writer`,否则直接拒绝。
 *   - turn_outcome:可选,用于 cancelled turn 检测。
 */
export interface CreateTypedMemoryCandidateInput {
  source_context_id: string;
  type: AutoMemoryType;
  claim: string;
  scope_ref: string;
  evidence_refs: string[];
  confidence: number;
  observed_at: string;
  expires_at: string | null;
  context_refs: string[];
  invalidation_conditions: string[];
  sensitivity_labels: string[];
  writer_kind: string;
  turn_outcome?: TurnOutcome | null;
}

/**
 * sensitive 关键词列表 (§9.7-5)。
 *
 * 检测策略:整词匹配 (单词边界),大小写不敏感。
 * 不做正则复杂匹配,也不做语义判断 —— 简单关键词即可。
 * 整词匹配是为了避免误伤 'tokenized' / 'secretive'-ish 这类正常词的子串。
 */
const SENSITIVE_KEYWORDS: readonly string[] = [
  'secret',
  'credential',
  'api_key',
  'apikey', // 常见无下划线写法,等价处理
  'api key', // 带空格的自然写法 (claim 里几乎不会出现字面 api_key)
  'token',
  'password',
  'passwd', // 常见简写
];

/**
 * raw tool dump 检测规则 (§9.7-5):
 *   - claim 以 `[Tool` 开头 (例如 "[Tool result: ...]")
 *   - claim 含有 ```tool_result code fence
 *
 * 命中任一即拒绝 —— candidate 必须是人类/agent 提炼后的 claim,不是工具原始输出。
 */
function looksLikeRawToolDump(claim: string): boolean {
  if (claim.startsWith('[Tool')) return true;
  if (claim.includes('```tool_result')) return true;
  return false;
}

function containsSensitiveKeyword(text: string): boolean {
  // \b 在 JS 正则里对 ASCII 单词边界生效。i = 大小写不敏感。
  // 用关键词 union 一次性扫描,避免多次编译。
  const pattern = new RegExp(
    `\\b(${SENSITIVE_KEYWORDS.join('|')})\\b`,
    'i',
  );
  return pattern.test(text);
}

/**
 * 计算 candidate 的内容寻址 id。
 *
 * canonical JSON 覆盖所有语义字段 (不含 writer_kind / turn_outcome ——
 * 它们是"构造期授权/上下文",不是 candidate 的内容)。
 * 字段顺序固定,保证相同语义 → 相同 id → 可去重。
 */
function computeCandidateId(fields: {
  source_context_id: string;
  type: AutoMemoryType;
  claim: string;
  scope_ref: string;
  evidence_refs: string[];
  confidence: number;
  observed_at: string;
  expires_at: string | null;
  context_refs: string[];
  invalidation_conditions: string[];
  sensitivity_labels: string[];
}): string {
  const canonical = JSON.stringify({
    source_context_id: fields.source_context_id,
    type: fields.type,
    claim: fields.claim,
    scope_ref: fields.scope_ref,
    evidence_refs: fields.evidence_refs,
    confidence: fields.confidence,
    observed_at: fields.observed_at,
    expires_at: fields.expires_at,
    context_refs: fields.context_refs,
    invalidation_conditions: fields.invalidation_conditions,
    sensitivity_labels: fields.sensitivity_labels,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `mem:${hash.slice(0, 16)}`;
}

/**
 * 创建一个 TypedMemoryCandidate。
 *
 * 失败时 throw Error,错误消息包含可被测试断言的关键词
 * (writer / type / claim / confidence / evidence / sensitive / failure_observation / cancelled / tool|dump)。
 *
 * 成功时返回 *已冻结* 的 candidate —— 调用方拿到的对象不可变,且无 mutation 方法。
 */
export function createTypedMemoryCandidate(
  input: CreateTypedMemoryCandidateInput,
): TypedMemoryCandidate {
  // 1. writer 检查 —— 只有 BRC-3 auto_memory_writer 可创建 (§9.8)
  if (input.writer_kind !== AUTO_MEMORY_WRITER_KIND) {
    throw new Error(
      `memory.writer_not_authorized: only '${AUTO_MEMORY_WRITER_KIND}' may create a typed memory candidate (got '${input.writer_kind}')`,
    );
  }

  // 2. type 验证 —— 防止 'random_thought' 之类未冻结类型 (§9.8 unknown memory type)
  if (!AUTO_MEMORY_TYPES.has(input.type)) {
    throw new Error(
      `memory.unknown_type: '${String(input.type)}' is not a frozen AutoMemoryType`,
    );
  }

  // 3. 字符串字段非空校验 (复用 Wave A 原语 —— 不重新发明空字符串判断)
  requireIdentity(input.source_context_id, 'source_context_id');
  requireIdentity(input.scope_ref, 'scope_ref');
  requireIdentity(input.observed_at, 'observed_at');

  // claim 非空 + 非纯空白 (不变量隐含于"claim 必须是已提炼的陈述")
  if (typeof input.claim !== 'string' || input.claim.trim().length === 0) {
    throw new Error('memory.empty_claim: claim must be a non-empty string');
  }

  // 4. confidence 范围 [0,1],且必须是有限数 (§9.7-1)
  if (
    typeof input.confidence !== 'number' ||
    Number.isNaN(input.confidence) ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw new Error(
      `memory.invalid_confidence: confidence must be a finite number in [0,1] (got ${String(input.confidence)})`,
    );
  }

  // 5. evidence 非空 (§9.7-2) —— 没证据不形成 candidate
  if (!Array.isArray(input.evidence_refs) || input.evidence_refs.length === 0) {
    throw new Error('memory.empty_evidence: evidence_refs must contain at least one entry');
  }

  // 6. secret / credential / 短期 token 检测 (§9.7-5)
  //    claim 与 sensitivity_labels 都要查 —— 标签不是"脱敏出口"。
  if (containsSensitiveKeyword(input.claim)) {
    throw new Error(
      'memory.contains_sensitive: claim contains a secret/credential/api_key/token/password keyword',
    );
  }
  for (const label of input.sensitivity_labels) {
    if (typeof label === 'string' && containsSensitiveKeyword(label)) {
      throw new Error(
        `memory.contains_sensitive: sensitivity_label '${label}' carries a sensitive keyword`,
      );
    }
  }

  // 7. raw tool dump 检测 (§9.7-5)
  if (looksLikeRawToolDump(input.claim)) {
    throw new Error(
      'memory.raw_tool_dump: claim looks like raw tool output, not a distilled claim',
    );
  }

  // 8. failure_observation 特殊要求 (§9.7-3)
  if (input.type === 'failure_observation') {
    if (!Array.isArray(input.context_refs) || input.context_refs.length === 0) {
      throw new Error(
        'failure_observation.requires_context: failure_observation must carry non-empty context_refs',
      );
    }
    if (
      !Array.isArray(input.invalidation_conditions) ||
      input.invalidation_conditions.length === 0
    ) {
      throw new Error(
        'failure_observation.requires_invalidation: failure_observation must carry non-empty invalidation_conditions',
      );
    }
  }

  // 9. cancelled turn 不得生成 failure_observation (§9.7-4)
  //    failure observation 在 cancelled turn 上没有可信证据基础。
  if (input.type === 'failure_observation' && input.turn_outcome === 'cancelled') {
    throw new Error(
      'failure_observation.cancelled_turn: cannot form failure_observation on a cancelled turn',
    );
  }

  // 10. 计算内容寻址 id,组装最终 candidate 并冻结。
  const candidate: TypedMemoryCandidate = {
    memory_candidate_protocol_version: MEMORY_CANDIDATE_PROTOCOL_VERSION,
    memory_candidate_id: computeCandidateId({
      source_context_id: input.source_context_id,
      type: input.type,
      claim: input.claim,
      scope_ref: input.scope_ref,
      evidence_refs: input.evidence_refs,
      confidence: input.confidence,
      observed_at: input.observed_at,
      expires_at: input.expires_at,
      context_refs: input.context_refs,
      invalidation_conditions: input.invalidation_conditions,
      sensitivity_labels: input.sensitivity_labels,
    }),
    source_context_id: input.source_context_id,
    type: input.type,
    claim: input.claim,
    scope_ref: input.scope_ref,
    evidence_refs: input.evidence_refs,
    confidence: input.confidence,
    observed_at: input.observed_at,
    expires_at: input.expires_at,
    context_refs: input.context_refs,
    invalidation_conditions: input.invalidation_conditions,
    sensitivity_labels: input.sensitivity_labels,
  };

  // 冻结:candidate 一旦形成就不可变 (INV-C7 + §9.7-7)。
  // 调用方拿不到任何 mutator —— 想"修改"必须重新构造一个新 candidate。
  return freezeSnapshot(candidate);
}
