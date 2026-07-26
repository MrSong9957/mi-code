// src/agent/context/bounded-memory-render.ts
// FRC-1 Task 5 — Deterministic Render.
//
// 物理本质:把 bounded memory 的 navigation items + verified claims 渲染成
// 不可变、确定性、可审计的 RenderedMemorySection,使其能作为 system message
// 的 dynamic 部分被注入到 prompt 里。
//
// 边界(对应 spec §7.13 / §7.14、Task 5):
//   - T5 只做"渲染":接收已经选好、已经按 budget 切好的 navigation/claims,
//     输出一段确定性的 markdown/comment 文本 + 测量值。
//   - T5 不做选片(T1)、不做 budget 切分(T4)、不做 prompt compiler 接线(Task 8)。
//   - 渲染必须确定性:相同 input + profile → 字节相同、content_hash 相同。
//   - 渲染必须安全:memory 正文不能闭合包装器,也不能伪造 system/security/completion 语义。
//
// 关键不变量(对应 spec §7.13 / §7.14、Task 5):
//   1. section_id / authority / placement 都是封闭常量(INV-F8)。
//      authority 永远是 'memory',不能被提升为 system/project_instruction/...。
//   2. approved 的是 RenderProfileAsset(模板/标签/字段顺序),不是动态 Memory 正文。
//   3. 没有第二套"估算 renderer":createRendererAdaptor 必须复用
//      renderMemoryNavigationFragment / renderVerifiedClaimFragment,
//      以保证 T4 计量 fragment bytes/lines 与最终 combined render 字节级一致。
//   4. content_hash = sha256(content) hex。bytes = UTF-8 字节长。lines 按简单规则计算。
//   5. escape 不改写语义(只对结构 token 加反斜杠),hash 基于最终 render。
//   6. rendered_at 仅用于审计,不参与 hash,且通过把 hash 建在 content 上间接保证。
//   7. partial render(truncated=true)必须携带非 null overflow_manifest_ref,
//      且 content 末尾追加机器可追踪的 marker;omitted 只用 count,不列具体 identity。
//   8. 输出整体经 freezeSnapshot 深冻结。

import { createHash } from 'node:crypto';

import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

// Task 8: Prompt Compiler handoff —— 仅 import type,避免运行时循环依赖。
// T8 的输入类型 BoundedMemoryEntrypointSnapshot / MemoryEntrypointState 来自
// bounded-memory.ts(已通过 createRendererAdaptor / renderMemoryEntrypoint 反向被其
// import,所以这里只能用 type-only import,避免 ES module live binding 触发循环)。
import type {
  BoundedMemoryEntrypointSnapshot,
  MemoryEntrypointState,
} from './bounded-memory.js';
// T8 的输出类型 PromptSectionInput 来自 BRC-1 compiler.ts(独立模块,不反向 import
// 本文件,因此 type-only import 即可)。
import type { PromptSectionInput } from '../prompt/compiler.js';

// ---------------------------------------------------------------------------
// Public types (本地 working type;与 T1/T4 导出形状兼容,T6 接线时统一适配)
// ---------------------------------------------------------------------------

/** 单条 navigation item 的渲染输入(来自 T1 bounded memory record)。 */
export interface RenderNavigationItem {
  memory_record_id: string;
  record_version: number;
  selection_rank: number;
  /** 'user_preference' | 'project_fact' 等(自由字符串,渲染时会 escape) */
  memory_type: string;
  scope_ref: string;
  topic_key_refs: ReadonlyArray<string>;
  keyword_key_refs: ReadonlyArray<string>;
  observed_at: string;
  expires_at: string | null;
  detail_content_hash: string;
  provenance_refs: ReadonlyArray<string>;
  durability_evidence_ref: string;
}

/** 单条 verified claim 的渲染输入(来自 T4 budget 切片)。 */
export interface RenderVerifiedClaim {
  claim_projection_id: string;
  memory_record_id: string;
  record_version: number;
  retrieval_id: string;
  memory_use_decision_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  verified_claim_ref: string;
  content_ref: string;
  content_hash: string;
  provenance_refs: ReadonlyArray<string>;
  freshness_ref: string;
}

/**
 * Renderer adaptor 形状(与 T4 MemoryBudgetFragmentRenderer 结构相同)。
 * 注意:T5 在自己文件里定义此接口,T6 接线时让 T4 import 它即可。
 */
export interface MemoryBudgetFragmentRenderer {
  renderNavigation(item: RenderNavigationItem): string;
  renderVerifiedClaim(claim: RenderVerifiedClaim): string;
}

/** 测量结果:UTF-8 字节数 + 行数。 */
export interface RenderFragmentMeasurement {
  bytes: number;
  lines: number;
}

/** Overflow 描述(由 T4 budget 切分产生)。 */
export interface RenderOverflowMarker {
  truncated: boolean;
  /** truncated=true 时必须非 null */
  overflow_manifest_ref: string | null;
  omitted_navigation_count: number;
  omitted_claim_count: number;
}

/**
 * Approved render profile/template(spec §7.13 / Task 8)。
 * 定义固定标签、字段顺序、escaping 规则、包装器、overflow marker。
 * 这是"被 approved 的资产",不是动态 Memory 正文 —— Memory 正文永远走 escape。
 */
export interface RenderProfileAsset {
  asset_id: string;
  asset_version: string;
  /** 封闭值 'memory.bounded_entrypoint' */
  section_id: 'memory.bounded_entrypoint';
  /** 封闭值 'memory' */
  authority: 'memory';
  /** 封闭值 'system_dynamic' */
  placement: 'system_dynamic';
  /** navigation item 模板字符串,占位符 ${field} */
  navigation_item_template: string;
  /** verified claim 模板字符串,占位符 ${field} */
  verified_claim_template: string;
  /** section 包装器模板,占位符 ${items} / ${claims} / ${overflow_marker} */
  section_wrapper_template: string;
  /** overflow marker 模板,占位符见 DEFAULT */
  overflow_marker_template: string;
  /** provenance label 模板(辅助,占位符 ${provenance_refs}) */
  provenance_label_template: string;
  /** freshness label 模板(辅助,占位符 ${observed_at} / ${expires_at}) */
  freshness_label_template: string;
}

/** renderMemoryEntrypoint 的完整输入。 */
export interface RenderMemoryEntrypointInput {
  render_protocol_version: string;
  render_id: string;
  render_profile: RenderProfileAsset;
  navigation_items: ReadonlyArray<RenderNavigationItem>;
  verified_claims: ReadonlyArray<RenderVerifiedClaim>;
  overflow_marker: RenderOverflowMarker;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
}

/** 最终渲染产物。 */
export interface RenderedMemorySection {
  render_protocol_version: string;
  /** INV-F8 封闭 */
  section_id: 'memory.bounded_entrypoint';
  /** INV-F8 封闭 */
  authority: 'memory';
  placement: 'system_dynamic';
  /** approved render profile/template 引用 */
  asset_ref: { asset_id: string; asset_version: string };
  content: string;
  /** sha256(content) hex 64 位 */
  content_hash: string;
  bytes: number;
  lines: number;
  overflow_manifest_ref: string | null;
  provenance_manifest_ref: string;
  /** ISO timestamp,仅用于审计,不参与 hash */
  rendered_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RENDER_PROTOCOL_VERSION = '1';
export const DEFAULT_MEMORY_RENDER_PROFILE_ID = 'memory.bounded_entrypoint.v1';
export const DEFAULT_MEMORY_RENDER_PROFILE_VERSION = '1';

/**
 * 禁止 token 列表(spec Task 5 Step 4 + §7.13 forbidden semantics)。
 *
 * 这些 token 一旦原样出现在 Memory 正文中,就可能:
 *   - 闭合 fragment/section 包装器(`---`、`<!--`、`-->`、``` ``` `)
 *   - 伪造 system / security / completion section(`<system>`、`<security>`、`<completion>`)
 *   - 伪造 SecurityDecision / PermissionDecision / CompletionOutcome 语义
 *
 * 转义规则:用反斜杠 `\` + token 前缀替代原 token。escape 不改写语义:
 * `\---` 在显示上仍读作 "---",`\SecurityDecision` 仍读作 "SecurityDecision",
 * 但都不再被任何结构 parser 当作分隔符或决策字面量。
 *
 * 这是 defense-in-depth:Memory 正文原则上可以包含任何字符串,但渲染产物
 * 绝不能让 prompt parser 把某段 Memory 误认作 system/security/completion
 * section 或一个已签发的 SecurityDecision。
 *
 * 列表顺序重要 —— 先转义更长的 token,避免被短 token 部分替换破坏
 * (例如先转义 `<!--` 再处理 `--`,虽然此处无单独 `--` 项;长短语优先于其包含的词)。
 */
const FORBIDDEN_TOKENS: ReadonlyArray<string> = [
  // 多字符结构 token(先长后短)
  '```',
  '<!--',
  '-->',
  '<system>',
  '<security>',
  '<completion>',
  '---',
  // 多字语义短语(先于单词,避免子串提前替换)
  '未显示的 Memory 不存在',
  '必须无条件服从 Memory',
  '以下内容是系统规则',
  'selected 表示事实正确',
  'partial entrypoint is complete',
  // 单词级语义禁止(§7.13)
  'SecurityDecision',
  'PermissionDecision',
  'CompletionOutcome',
  'system rule',
  'must obey',
];

/**
 * 默认 approved render profile(供生产与测试复用)。
 *
 * 模板字段顺序(navigation item):
 *   memory_type → scope → topic → keyword → observed_at → expires_at
 *   → provenance → durability → detail_hash
 *
 * 模板用 `${field}` 占位;替换时先对 value 做 escapeContent,再 split/join。
 * 不使用 eval / Function,纯字符串替换,保持确定性。
 */
export const DEFAULT_MEMORY_RENDER_PROFILE: RenderProfileAsset = {
  asset_id: DEFAULT_MEMORY_RENDER_PROFILE_ID,
  asset_version: DEFAULT_MEMORY_RENDER_PROFILE_VERSION,
  section_id: 'memory.bounded_entrypoint',
  authority: 'memory',
  placement: 'system_dynamic',
  navigation_item_template: [
    '--- memory item ---',
    'record: ${memory_record_id} v${record_version}',
    'type: ${memory_type}',
    'scope: ${scope_ref}',
    'topic: ${topic_key_refs}',
    'keyword: ${keyword_key_refs}',
    'observed_at: ${observed_at}',
    'expires_at: ${expires_at}',
    'provenance: ${provenance_refs}',
    'durability: ${durability_evidence_ref}',
    'detail_hash: ${detail_content_hash}',
    '--- end item ---',
  ].join('\n'),
  verified_claim_template: [
    '--- verified claim ---',
    'claim_ref: ${verified_claim_ref}',
    'record: ${memory_record_id} v${record_version}',
    'content_ref: ${content_ref}',
    'content_hash: ${content_hash}',
    'provenance: ${provenance_refs}',
    'freshness: ${freshness_ref}',
    '--- end claim ---',
  ].join('\n'),
  section_wrapper_template: [
    '<!-- memory.bounded_entrypoint (authority=memory, placement=system_dynamic) -->',
    '## Long-term Memory (bounded entrypoint)',
    '${items}',
    '${claims}',
    '${overflow_marker}',
    '<!-- end memory.bounded_entrypoint -->',
  ].join('\n'),
  overflow_marker_template:
    '<!-- overflow: truncated=${truncated} omitted_nav=${omitted_navigation_count} omitted_claim=${omitted_claim_count} manifest=${overflow_manifest_ref} -->',
  provenance_label_template: 'provenance: ${provenance_refs}',
  freshness_label_template:
    'freshness: observed=${observed_at} expires=${expires_at}',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 对 Memory 正文做确定性 escape(spec Task 5 Step 4)。
 *
 * 策略:对每个 forbidden token,把它替换成 `\` + token。
 * 这样原 token 不再原样出现(parser 不会把它当作结构分隔符 / 伪造 section 标签),
 * 但人类阅读时仍能看出原内容(`\---` 读作 "---")。
 *
 * 不做 HTML/URL/JS escape —— Memory 是 plain text,不是 HTML。
 */
function escapeContent(value: string): string {
  let result = value;
  for (const token of FORBIDDEN_TOKENS) {
    // split/join 等价于 replaceAll,但避免 RegExp 元字符问题(token 是字面量)。
    result = result.split(token).join('\\' + token);
  }
  return result;
}

/**
 * 模板占位符替换(确定性,不用 eval)。
 *
 * 规则:对 `${key}` 形式的占位符,用 values[key] 替换。替换前对 value 调用
 * escapeContent(value),以保证 Memory 正文里的 forbidden token 都被转义。
 *
 * - value 是 string → escape 后替换
 * - value 是 number → String(value) 替换(数字无 forbidden token 风险)
 * - value 是 null/undefined → 用 '' 替换(避免 "null" 字面污染)
 * - value 是 Array<string> → 用 ', ' 连接,再整体 escape(每元素已无结构风险,
 *   但连接后可能产生 forbidden token?不会 —— 连接符是 ', ',元素本身已 escape
 *   过的话不会再组合出新 token。这里对每元素 escape 后再 join 更安全)
 */
function substitute(
  template: string,
  values: Readonly<Record<string, string | number | null | undefined | ReadonlyArray<string>>>,
): string {
  let result = template;
  for (const [key, raw] of Object.entries(values)) {
    const placeholder = '${' + key + '}';
    const replacement = renderValue(raw);
    result = result.split(placeholder).join(replacement);
  }
  return result;
}

/**
 * 与 substitute 相同,但对 value 不做 escape —— 用于"我们自己生成的结构字符串"
 * (例如已渲染的 fragment 列表、overflow marker)。这些字符串是由本模块的
 * fragment renderer 产生的,内部的 forbidden token 是结构所需(例如 wrapper
 * 注释 `<!-- memory.bounded_entrypoint ... -->`),不应再次转义。
 *
 * 调用方必须确保传入的 value 不是 Memory 正文(memory 正文必须经 escape)。
 */
function substituteRaw(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [key, raw] of Object.entries(values)) {
    const placeholder = '${' + key + '}';
    result = result.split(placeholder).join(raw);
  }
  return result;
}

/** 把单个 value 规范成已 escape 的字符串。 */
function renderValue(
  raw: string | number | null | undefined | ReadonlyArray<string>,
): string {
  if (raw === null || raw === undefined) {
    return '';
  }
  if (typeof raw === 'number') {
    return String(raw);
  }
  if (Array.isArray(raw)) {
    // 先对每个元素 escape,再用 ', ' 连接 —— 避免元素拼接出 forbidden token。
    return raw.map((element) => escapeContent(String(element))).join(', ');
  }
  return escapeContent(String(raw));
}

// ---------------------------------------------------------------------------
// Public fragment renderers
// ---------------------------------------------------------------------------

/**
 * 渲染单条 navigation item fragment(spec §7.13)。
 *
 * 必须表达:memory_type / scope_ref / provenance / freshness / navigation
 * metadata(topic/keyword) / detail_content_hash。所有用户提供的值都先 escape。
 *
 * 此函数同时被 createRendererAdaptor 调用 —— 即 T4 的 fragment 计量与此处
 * 的最终 render 字节级一致(没有"估算 renderer"和"最终 renderer"两套实现)。
 */
export function renderMemoryNavigationFragment(
  item: RenderNavigationItem,
  profile: RenderProfileAsset,
): string {
  return substitute(profile.navigation_item_template, {
    memory_record_id: item.memory_record_id,
    record_version: item.record_version,
    selection_rank: item.selection_rank,
    memory_type: item.memory_type,
    scope_ref: item.scope_ref,
    topic_key_refs: item.topic_key_refs,
    keyword_key_refs: item.keyword_key_refs,
    observed_at: item.observed_at,
    // null → '' (escape 后仍是 '')
    expires_at: item.expires_at,
    detail_content_hash: item.detail_content_hash,
    provenance_refs: item.provenance_refs,
    durability_evidence_ref: item.durability_evidence_ref,
  });
}

/**
 * 渲染单条 verified claim fragment(spec §7.13)。
 *
 * T5 阶段只渲染标识(claim_ref / content_ref / content_hash),不伪造 claim
 * 正文 —— 实际 content_body 在 Task 8 之后接入 claim_lookup 时才注入。
 * 这里只显示 content_ref + content_hash 摘要,保证完整性可校验。
 */
export function renderVerifiedClaimFragment(
  claim: RenderVerifiedClaim,
  profile: RenderProfileAsset,
): string {
  return substitute(profile.verified_claim_template, {
    claim_projection_id: claim.claim_projection_id,
    memory_record_id: claim.memory_record_id,
    record_version: claim.record_version,
    retrieval_id: claim.retrieval_id,
    memory_use_decision_id: claim.memory_use_decision_id,
    current_context_snapshot_id: claim.current_context_snapshot_id,
    project_version_ref: claim.project_version_ref,
    verified_claim_ref: claim.verified_claim_ref,
    content_ref: claim.content_ref,
    content_hash: claim.content_hash,
    provenance_refs: claim.provenance_refs,
    freshness_ref: claim.freshness_ref,
  });
}

/**
 * 创建一个符合 MemoryBudgetFragmentRenderer 形状的 adaptor(T4 注入用)。
 *
 * 关键:adaptor.renderNavigation / renderVerifiedClaim 必须与生产
 * renderMemoryNavigationFragment / renderVerifiedClaimFragment 字节级一致,
 * 即 adaptor 只是把 profile 闭包进去,渲染逻辑完全共用同一函数。
 */
export function createRendererAdaptor(
  profile: RenderProfileAsset,
): MemoryBudgetFragmentRenderer {
  return {
    renderNavigation: (item: RenderNavigationItem) =>
      renderMemoryNavigationFragment(item, profile),
    renderVerifiedClaim: (claim: RenderVerifiedClaim) =>
      renderVerifiedClaimFragment(claim, profile),
  };
}

// ---------------------------------------------------------------------------
// Public section renderer
// ---------------------------------------------------------------------------

/**
 * 渲染整个 memory bounded entrypoint section(spec §7.13 / §7.14、Task 5)。
 *
 * 确定性:相同 input + profile → 字节相同、content_hash 相同。
 *   - 不读取时间(除 rendered_at 字段,该字段仅用于审计,不进入 content_hash)
 *   - 不读取全局 mutable 状态
 *   - content_hash = sha256(content);bytes = UTF-8 字节长;
 *     lines = content === '' ? 0 : content.split('\n').length
 *
 * 失败语义:profile / identity 字段不合法 → 抛错,不做 partial render。
 */
export function renderMemoryEntrypoint(
  input: RenderMemoryEntrypointInput,
): RenderedMemorySection {
  // identity 守门
  const render_protocol_version = requireIdentity(
    input.render_protocol_version,
    'render_protocol_version',
  );
  const render_id = requireIdentity(input.render_id, 'render_id');
  const task_snapshot_id = requireIdentity(
    input.task_snapshot_id,
    'task_snapshot_id',
  );
  const current_context_snapshot_id = requireIdentity(
    input.current_context_snapshot_id,
    'current_context_snapshot_id',
  );

  const profile = input.render_profile;
  // profile 必须自洽:asset / 封闭字段一致
  requireIdentity(profile.asset_id, 'render_profile.asset_id');
  requireIdentity(profile.asset_version, 'render_profile.asset_version');
  if (profile.section_id !== 'memory.bounded_entrypoint') {
    throw new Error(
      `render_profile.section_id must be 'memory.bounded_entrypoint', got '${profile.section_id}'`,
    );
  }
  if (profile.authority !== 'memory') {
    throw new Error(
      `render_profile.authority must be 'memory' (INV-F8 closed), got '${profile.authority}'`,
    );
  }
  if (profile.placement !== 'system_dynamic') {
    throw new Error(
      `render_profile.placement must be 'system_dynamic' (closed), got '${profile.placement}'`,
    );
  }

  const overflow = input.overflow_marker;
  // partial render 必须携带 manifest_ref(truncated=true 时强制非 null)
  if (
    overflow.truncated &&
    (overflow.overflow_manifest_ref === null ||
      overflow.overflow_manifest_ref.trim().length === 0)
  ) {
    throw new Error(
      'overflow_marker.overflow_manifest_ref must be non-null when truncated=true',
    );
  }

  // 1) 渲染每个 navigation item fragment(走 escape)
  const navFragments = input.navigation_items.map((item) =>
    renderMemoryNavigationFragment(item, profile),
  );
  // 2) 渲染每个 verified claim fragment(走 escape)
  const claimFragments = input.verified_claims.map((claim) =>
    renderVerifiedClaimFragment(claim, profile),
  );
  // 3) 渲染 overflow marker(truncated=false 也输出 marker,只是 truncated=false;
  //    manifest_ref=null 时输出 manifest= 以保持格式一致,便于 parser)。
  //    注意:overflow_marker_template 是 approved 模板,由我们生成结构注释
  //    `<!-- overflow: ... -->`,这里替换的是 truncated/count/manifest_ref,
  //    这些是结构值,不是 Memory 正文,所以用 substituteRaw 避免二次转义。
  const overflowStr = substituteRaw(profile.overflow_marker_template, {
    truncated: overflow.truncated ? 'true' : 'false',
    omitted_navigation_count: String(overflow.omitted_navigation_count),
    omitted_claim_count: String(overflow.omitted_claim_count),
    overflow_manifest_ref: overflow.overflow_manifest_ref ?? '',
  });

  // 4) 组装:items / claims / overflow_marker 各占一段(空数组 → 空字符串)。
  //    这三段都是本模块已渲染的产物(fragment 内部 Memory 正文已 escape;
  //    overflow marker 是结构注释),因此 wrapper 替换用 substituteRaw,
  //    避免把 wrapper 自身的结构注释(如 `<!-- end memory.bounded_entrypoint -->`)
  //    也错误地转义。
  const itemsBlock = navFragments.join('\n');
  const claimsBlock = claimFragments.join('\n');

  const content = substituteRaw(profile.section_wrapper_template, {
    items: itemsBlock,
    claims: claimsBlock,
    overflow_marker: overflowStr,
  });

  // 5) 测量(确定性)
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content === '' ? 0 : content.split('\n').length;
  const content_hash = sha256Hex(content);

  // 6) provenance_manifest_ref:由所有 fragment 的 provenance_refs 汇总派生。
  //    这里以稳定字符串拼接后 sha256,确保确定性。task/context/render_id 都进入,
  //    让 manifest 在不同 render 间可区分。
  const provenancePayload = [
    `render:${render_id}`,
    `task:${task_snapshot_id}`,
    `ctx:${current_context_snapshot_id}`,
    `project:${input.project_version_ref ?? ''}`,
    ...input.navigation_items.flatMap((item) =>
      item.provenance_refs.map((ref) => `nav:${item.memory_record_id}:${ref}`),
    ),
    ...input.verified_claims.flatMap((claim) =>
      claim.provenance_refs.map(
        (ref) => `claim:${claim.claim_projection_id}:${ref}`,
      ),
    ),
  ].join('\n');
  const provenance_manifest_ref = `provenance:${sha256Hex(provenancePayload)}`;

  // 7) rendered_at 仅用于审计 —— 这里用一个稳定占位(current_context_snapshot_id 派生)
  //    而不是 new Date().toISOString(),以保证整次 render 在相同 input 下完全确定性。
  //    审计时间由调用方在 wrap 时覆盖(Task 8 接线时由 prompt compiler 注入真实时间)。
  const rendered_at = current_context_snapshot_id;

  // 8) 组装 + 深冻结
  return freezeSnapshot<RenderedMemorySection>({
    render_protocol_version,
    section_id: 'memory.bounded_entrypoint',
    authority: 'memory',
    placement: 'system_dynamic',
    asset_ref: {
      asset_id: profile.asset_id,
      asset_version: profile.asset_version,
    },
    content,
    content_hash,
    bytes,
    lines,
    overflow_manifest_ref: overflow.overflow_manifest_ref,
    provenance_manifest_ref,
    rendered_at,
  });
}

// ===========================================================================
// §9 Task 8: Prompt Compiler Handoff
//
// 物理本质:把 T6 的 BoundedMemoryEntrypointSnapshot(ready/partial/empty)+
// T5 的 approved RenderProfileAsset + 调用方提供的 rendered_content,组装为
// BRC-1 PromptSectionInput,让 Memory section 以 system_dynamic placement 进入
// BRC-1 compiler 而不丢失 Authority / overflow / provenance。
//
// 边界(对应 spec §7.14 / §7.15、Task 8):
//   - T8 只做"组装":它不调用 compilePromptSnapshot,不重新 select Memory,
//     不读取未投影的 detail,不修改 snapshot/render_profile。
//   - T8 只通过 PromptSectionInput 接口与 compiler 对接。所有"compiler 不能做的事"
//     由结构保证:compiler 拿到的就是封闭值 section_id/authority/placement +
//     content + content_hash + provenance_refs,没有任何 Memory 决策能力。
//   - 调用方负责:分配 ordinal / 提供 trust/retention / 提供 rendered_content
//     (调用方从 snapshot.rendered_section_ref 解析得到),并保证 rendered_content
//     的 hash 与 snapshot.rendered_section_hash 一致(T8 校验)。
//
// 关键不变量(对应 spec §7.14 INV-F8 / §7.15 / Task 8):
//   1. authority 永远是 'memory'(封闭,INV-F8),不能被 render_profile 改成其他值。
//   2. section_id 永远是 'memory.bounded_entrypoint'(封闭)。
//   3. placement 永远是 'system_dynamic'(封闭)。
//   4. asset_ref 指向 approved immutable render-profile/template,**不**指向 Memory 正文。
//   5. content 来自调用方提供的 rendered_content,但 sha256(content) 必须等于
//      snapshot.rendered_section_hash —— 防止调用方篡改内容。
//   6. partial 状态下,provenance_refs 必须包含 snapshot.overflow_manifest_ref
//      (让 compiler 看到的 section 仍携带 overflow 标识)。
//   7. empty 状态下,section=null(省略 section,INV-F12 不造内容)。
//   8. prepared / rejected 状态下,抛结构化 handoff error(不允许 handoff)。
// ===========================================================================

/**
 * T8 handoff 协议版本(spec §7.15 + Task 8 Step 4)。
 * 独立于 entrypoint_protocol_version / render_protocol_version,允许 handoff
 * schema 演进而无需重建 snapshot。
 */
export const MEMORY_HANDOFF_PROTOCOL_VERSION = 'mi.memory.handoff/1';

/**
 * handoff error(spec §7.15 + Task 8 Step 4)。
 *
 * prepared / rejected 状态不能 handoff;content hash mismatch 阻止 handoff。
 * error 形状是结构化的,让上层(T9 Activation Gate)能基于 reason_code 做决策
 * (例如:rejected 不改变 TurnOutcome,只记 metadata diagnostic)。
 */
export interface MemoryPromptHandoffError {
  /** 'handoff.not_ready' / 'handoff.rejected' / 'handoff.content_hash_mismatch' */
  reason_code: string;
  /** 人类可读的补充说明(数值上下文不入 code,可入 message) */
  message: string;
  /** 触发 error 的 snapshot state(便于上层诊断) */
  snapshot_state: MemoryEntrypointState;
  snapshot_id: string;
  handoff_protocol_version: string;
}

/**
 * handoff 成功结果(spec §7.15 + Task 8 Step 4)。
 *
 * - section=null 表示省略 section(empty 状态;INV-F12 不造内容)。
 * - section 非空表示 ready/partial 状态,compiler 可以编入。
 * - reason_codes 携带 'handoff.*' 程序化 code,用于 metadata-only diagnostic。
 */
export interface MemoryPromptHandoffResult {
  handoff_protocol_version: string;
  /** 内容寻址 id:'handoff:' + sha256(...).slice(0,16) */
  handoff_id: string;
  /** null 当 snapshot.state='empty'(省略 section) */
  section: PromptSectionInput | null;
  /** 诊断信息(用于 metadata-only diagnostic) */
  snapshot_state: MemoryEntrypointState;
  snapshot_id: string;
  overflow_manifest_ref: string | null;
  /** 'handoff.*' 程序化 code,如 'handoff.empty_omitted' / 'handoff.partial_overflow_preserved' */
  reason_codes: ReadonlyArray<string>;
}

/**
 * T8 handoff 的输入。
 *
 * - snapshot:T6 输出的 BoundedMemoryEntrypointSnapshot(state ∈ ready/partial/empty/
 *   prepared/rejected;后两者会 throw)。
 * - render_profile:T5 的 approved RenderProfileAsset(调用方保证已 approved;
 *   T8 不调用 isApproved —— 那是 compiler 的工作)。
 * - rendered_content:调用方从 snapshot.rendered_section_ref 解析得到的渲染正文。
 *   T8 校验 sha256(rendered_content) === snapshot.rendered_section_hash。
 *   empty 状态下 rendered_content 应为 ''(或 snapshot.rendered_section_hash === null)。
 * - ordinal:section ordinal(调用方分配,compiler 内 ordinal 唯一)。
 * - trust:来自上游 use metadata。
 * - retention:来自 lifecycle policy。
 * - provenance_refs:转发给 section 的额外 provenance(调用方提供)。
 *
 * 关键决策(规格 §7.15):T6 snapshot 不直接携带 content(避免大段文本污染 immutable
 * identity);因此 T8 接受独立的 rendered_content 参数,并校验 hash 一致。这是
 * "方案 A"(方案 B 需要修改 T6,已冻结)。
 */
export interface MemoryPromptHandoffInput {
  snapshot: BoundedMemoryEntrypointSnapshot;
  render_profile: RenderProfileAsset;
  /** 调用方提供,校验 sha256 === snapshot.rendered_section_hash */
  rendered_content: string;
  /** section ordinal(调用方分配) */
  ordinal: number;
  /** 来自上游 use metadata */
  trust: string;
  /** 来自 lifecycle policy */
  retention: string;
  /** 转发给 section 的额外 provenance */
  provenance_refs: ReadonlyArray<string>;
}

/**
 * T8 entry:把 T6 snapshot + T5 approved render_profile + 调用方 rendered_content
 * 组装为 BRC-1 PromptSectionInput。
 *
 * State handling(spec §7.15 + Task 8 Step 4):
 *   | State     | 行为                                                     |
 *   |-----------|----------------------------------------------------------|
 *   | ready     | section 非空;校验 hash;provenance 转发输入 + manifest  |
 *   | partial   | section 非空;校验 hash;**必须**保留 overflow_manifest_ref |
 *   | empty     | section=null;返回 result 但不抛错(INV-F12)            |
 *   | prepared  | throw { reason_code: 'handoff.not_ready', ... }         |
 *   | rejected  | throw { reason_code: 'handoff.rejected', ... }          |
 *
 * Hash validation(spec §7.15):ready/partial 时
 *   sha256(rendered_content) === snapshot.rendered_section_hash,否则 throw
 *   { reason_code: 'handoff.content_hash_mismatch' }。
 *
 * 这个函数 *不* 做的事(规格 §7.15 + Task 8 Step 5):
 *   - 不调用 compilePromptSnapshot(那是 compiler 的工作)。
 *   - 不调用 PromptAssetApprovalLookup.isApproved(那是 compiler 的工作)。
 *   - 不重新 select Memory / 不读未投影 detail / 不修改 snapshot/render_profile。
 *   - 不恢复 do_not_use/needs_refresh claim(结构保证:section 只含 rendered_content)。
 *   - 不移除 overflow 标记(partial 必须把 overflow_manifest_ref 放入 provenance_refs)。
 *
 * @throws MemoryPromptHandoffError 当 state='prepared'/'rejected' 或 hash mismatch
 */
export function toMemoryPromptSection(
  input: MemoryPromptHandoffInput,
): MemoryPromptHandoffResult {
  const snapshot = input.snapshot;
  const profile = input.render_profile;
  const protocol = MEMORY_HANDOFF_PROTOCOL_VERSION;

  // identity 守门:snapshot id / render_profile asset id 必须非空。
  // 不做全部字段校验(snapshot 由 T6 深冻结且已校验;profile 由 T5 校验)。
  requireIdentity(snapshot.entrypoint_snapshot_id, 'snapshot.entrypoint_snapshot_id');
  requireIdentity(profile.asset_id, 'render_profile.asset_id');
  requireIdentity(profile.asset_version, 'render_profile.asset_version');

  // INV-F8 封闭值校验:即使调用方通过类型断言绕过,也拒绝非封闭值。
  // 这是 defense-in-depth —— RenderProfileAsset 的类型签名已经声明封闭值,
  // 但运行时仍校验,防止跨边界(mock/JSON 注入)出错。
  if (profile.authority !== 'memory') {
    throw makeHandoffError(
      'handoff.invalid_authority',
      `render_profile.authority must be 'memory' (INV-F8 closed), got '${profile.authority}'`,
      snapshot.state,
      snapshot.entrypoint_snapshot_id,
    );
  }
  if (profile.section_id !== 'memory.bounded_entrypoint') {
    throw makeHandoffError(
      'handoff.invalid_section_id',
      `render_profile.section_id must be 'memory.bounded_entrypoint' (closed), got '${profile.section_id}'`,
      snapshot.state,
      snapshot.entrypoint_snapshot_id,
    );
  }
  if (profile.placement !== 'system_dynamic') {
    throw makeHandoffError(
      'handoff.invalid_placement',
      `render_profile.placement must be 'system_dynamic' (closed), got '${profile.placement}'`,
      snapshot.state,
      snapshot.entrypoint_snapshot_id,
    );
  }

  // State handling:prepared / rejected → throw structured error
  if (snapshot.state === 'prepared') {
    throw makeHandoffError(
      'handoff.not_ready',
      "prepared state is not handoff-ready: snapshot must reach ready/partial/empty via T4/T5 pipeline",
      snapshot.state,
      snapshot.entrypoint_snapshot_id,
    );
  }
  if (snapshot.state === 'rejected') {
    throw makeHandoffError(
      'handoff.rejected',
      'snapshot is rejected: rejected build cannot be handed off to compiler',
      snapshot.state,
      snapshot.entrypoint_snapshot_id,
    );
  }

  // empty → section=null(省略 section;INV-F12 不造内容)
  if (snapshot.state === 'empty') {
    // empty 时 snapshot.rendered_section_hash 应为 null;若调用方传非空 rendered_content,
    // 说明上游不一致 —— 但 empty 仍然省略 section,只在 reason_codes 记 warning。
    const reasonCodes: string[] = ['handoff.empty_omitted'];
    if (input.rendered_content.length > 0) {
      reasonCodes.push('handoff.empty_with_nonblank_content');
    }
    return freezeSnapshot<MemoryPromptHandoffResult>({
      handoff_protocol_version: protocol,
      handoff_id: computeHandoffId({
        protocol,
        snapshotId: snapshot.entrypoint_snapshot_id,
        state: snapshot.state,
        contentHash: null,
        ordinal: input.ordinal,
      }),
      section: null,
      snapshot_state: snapshot.state,
      snapshot_id: snapshot.entrypoint_snapshot_id,
      overflow_manifest_ref: null,
      reason_codes: reasonCodes,
    });
  }

  // ready / partial → 组装 PromptSectionInput
  // Hash validation:sha256(rendered_content) === snapshot.rendered_section_hash
  const expectedHash = snapshot.rendered_section_hash;
  if (expectedHash === null) {
    // ready/partial 必须有 rendered_section_hash;null 说明 snapshot 不一致
    throw makeHandoffError(
      'handoff.content_hash_mismatch',
      `snapshot.state='${snapshot.state}' requires non-null rendered_section_hash, got null`,
      snapshot.state,
      snapshot.entrypoint_snapshot_id,
    );
  }
  const actualHash = sha256Hex(input.rendered_content);
  if (actualHash !== expectedHash) {
    throw makeHandoffError(
      'handoff.content_hash_mismatch',
      `sha256(rendered_content) !== snapshot.rendered_section_hash: expected ${expectedHash}, got ${actualHash}`,
      snapshot.state,
      snapshot.entrypoint_snapshot_id,
    );
  }

  // 组装 provenance_refs:输入 refs + overflow_manifest_ref(partial 时强制包含)
  // ready 时也包含 overflow_manifest_ref(若 snapshot 提供),保持 traceability;
  // partial 时必须包含(spec §7.15:partial 必须保留 overflow manifest ref)。
  const overflowRef = snapshot.overflow_manifest_ref;
  const provenanceRefs: string[] = [...input.provenance_refs];
  if (overflowRef && overflowRef.length > 0 && !provenanceRefs.includes(overflowRef)) {
    provenanceRefs.push(overflowRef);
  }

  // 同时把 provenance_manifest_ref 加入,便于审计(spec §7.15:Provenance metadata 转发)
  const provManifestRef = snapshot.provenance_manifest_ref;
  if (
    provManifestRef &&
    provManifestRef.length > 0 &&
    !provenanceRefs.includes(provManifestRef)
  ) {
    provenanceRefs.push(provManifestRef);
  }

  // INV-F8 封闭值:authority/section_id/placement 用字面量,**不**从 profile 转发,
  // 保证即使 profile 字段被运行时篡改,section 输出仍是封闭值。
  const section: PromptSectionInput = {
    section_id: 'memory.bounded_entrypoint',
    asset_ref: {
      asset_id: profile.asset_id,
      asset_version: profile.asset_version,
    },
    placement: 'system_dynamic',
    authority: 'memory',
    trust: input.trust,
    retention: input.retention,
    ordinal: input.ordinal,
    content: input.rendered_content,
    content_hash: actualHash,
    provenance_refs: provenanceRefs,
  };

  // reason codes:基于 state + 是否保留 overflow
  const reasonCodes: string[] = [];
  if (snapshot.state === 'partial') {
    reasonCodes.push('handoff.partial');
    if (overflowRef && overflowRef.length > 0) {
      reasonCodes.push('handoff.partial_overflow_preserved');
    } else {
      // partial 必须有 overflow_manifest_ref(spec §7.15);缺则记 warning,
      // 但仍组装 section(因为 snapshot 已经是 partial,我们不能再 reject)。
      reasonCodes.push('handoff.partial_overflow_missing');
    }
  } else if (snapshot.state === 'ready') {
    reasonCodes.push('handoff.ready');
  }

  return freezeSnapshot<MemoryPromptHandoffResult>({
    handoff_protocol_version: protocol,
    handoff_id: computeHandoffId({
      protocol,
      snapshotId: snapshot.entrypoint_snapshot_id,
      state: snapshot.state,
      contentHash: actualHash,
      ordinal: input.ordinal,
    }),
    section,
    snapshot_state: snapshot.state,
    snapshot_id: snapshot.entrypoint_snapshot_id,
    overflow_manifest_ref: overflowRef.length > 0 ? overflowRef : null,
    reason_codes: reasonCodes,
  });
}

// ---------------------------------------------------------------------------
// T8 internal helpers
// ---------------------------------------------------------------------------

/**
 * 构造结构化 handoff error(spec §7.15)。
 *
 * 注意:这个函数返回一个 MemoryPromptHandoffError 对象,但 T8 通过 throw 抛出。
 * 调用方可以用 try/catch 捕获并读取 reason_code 做决策。
 *
 * 由于 TypeScript 的 throw 只能抛值,我们直接 throw 这个对象(不是 Error 子类)
 * —— 这与 spec 的"结构化 handoff error"语义一致:reason_code 是程序化 code,
 * 不是 Error.message。
 */
function makeHandoffError(
  reasonCode: string,
  message: string,
  snapshotState: MemoryEntrypointState,
  snapshotId: string,
): MemoryPromptHandoffError {
  return {
    reason_code: reasonCode,
    message,
    snapshot_state: snapshotState,
    snapshot_id: snapshotId,
    handoff_protocol_version: MEMORY_HANDOFF_PROTOCOL_VERSION,
  };
}

/**
 * 计算 handoff_id(规格 Task 8 Step 4)。
 * canonical 覆盖:protocol + snapshot_id + state + content_hash + ordinal。
 * 不含 trust/retention/provenance(它们是调用方 metadata,不影响 handoff identity)。
 */
function computeHandoffId(fields: {
  protocol: string;
  snapshotId: string;
  state: MemoryEntrypointState;
  contentHash: string | null;
  ordinal: number;
}): string {
  const canonical = JSON.stringify({
    v: fields.protocol,
    snapshot_id: fields.snapshotId,
    state: fields.state,
    content_hash: fields.contentHash,
    ordinal: fields.ordinal,
  });
  const hash = sha256Hex(canonical);
  return `handoff:${hash.slice(0, 16)}`;
}
