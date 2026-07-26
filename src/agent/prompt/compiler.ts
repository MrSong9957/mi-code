// src/agent/prompt/compiler.ts
// Wave B Task 1 — BRC-1 Prompt Compilation.
//
// 物理本质:compilePromptSnapshot 把上游"已选择、已批准、已确定顺序"的
// PromptSectionInput[] 结构化组装为不可变 CompiledPromptSnapshot。
//
// 边界(对应 spec §7.1 / §7.6):
//   - BRC-1 只做结构化组装。它不做 precedence(M-002)、conditions(M-004)、
//     cache scope(M-003) —— 那些属于 Wave C。
//   - 输入是 in-memory 的 PromptSectionInput[];compiler 不读任何外部
//     vendor prompt 库,也不从候选集合自行选择 section。
//   - 调用方负责把已 approved、已选择、已确定顺序的 section 传进来;
//     compiler 只做校验与组装。
//
// 关键不变量(对应 spec §7.4 / §7.5):
//   1. 复制输入(深拷贝 sections)在任何校验/冻结之前进行(spec §7.4 rule 1)。
//   2. 空 section content 必须拒绝(spec §7.4 rule 9)。
//   3. 同一 snapshot 内 section_id 唯一(spec §7.4 rule 1 / §7.5)。
//   4. 同一 snapshot 内 ordinal 唯一;section_id 仅作确定性兜底,不掩盖重复 ordinal
//      (spec §7.4 rule 3 / §7.5)。
//   5. placement 只允许 system plane(system_static / system_dynamic);
//      meta_context / conversation / tool_plane 必须与 system plane 保持分离
//      (spec §7.4 rule 7 / §7.5)。
//   6. content_hash 必须与 sha256(content) 一致(spec §7.4 rule 4 / §7.5)。
//   7. 每个 section 的 asset_ref 必须经 lookup.isApproved(...) 为 true;
//      未批准资产不能因被传入 compiler 而自动变 approved(spec §7.4 rule 8 / §7.5)。
//   8. 编译顺序为 (ordinal ASC, section_id ASC)(spec §7.4 rule 3)。
//   9. aggregate_hash 覆盖有序 section 的 identity、asset version、placement、content_hash
//      (spec §7.4 rule 5)。拼接方式见 computeAggregateHash 的注释。
//  10. compiled_prompt_snapshot_id 由 aggregate_hash 确定性派生(见 buildCompiledSnapshotId 的注释)。
//  11. compiler_protocol_version / registry_snapshot_id / request_snapshot_id 经 requireIdentity 守门
//      (spec §7.4 rule 11)。
//  12. 输出整体经 freezeSnapshot 深冻结(spec §7.4 rule 12)。
//  13. section_order 是排序后的 section_id 数组(spec §7.4 rule 13)。

import { createHash } from 'node:crypto';

import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

// ---------------------------------------------------------------------------
// Public types (frozen by spec §7.2 / §7.3)
// ---------------------------------------------------------------------------

export interface PromptSectionInput {
  section_id: string;
  asset_ref: {
    asset_id: string;
    asset_version: string;
  };
  placement: 'system_static' | 'system_dynamic';
  authority: string;
  trust: string;
  retention: string;
  ordinal: number;
  content: string;
  content_hash: string;
  provenance_refs: string[];
}

export interface PromptCompilationInput {
  compiler_protocol_version: string;
  registry_snapshot_id: string;
  request_snapshot_id: string;
  sections: PromptSectionInput[];
}

export interface CompiledPromptSnapshot {
  compiler_protocol_version: string;
  compiled_prompt_snapshot_id: string;
  registry_snapshot_id: string;
  request_snapshot_id: string;
  sections: ReadonlyArray<PromptSectionInput>;
  section_order: string[];
  aggregate_hash: string;
}

export interface PromptAssetApprovalLookup {
  isApproved(ref: { asset_id: string; asset_version: string }): boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** placement 的封闭域(spec §7.2):只允许 system plane。 */
const ALLOWED_PLACEMENTS: ReadonlySet<string> = new Set([
  'system_static',
  'system_dynamic',
]);

/**
 * compiled_prompt_snapshot_id 的派生规则(spec §7.4 rule 10):
 *   compiled_prompt_snapshot_id = 'compiled:' + aggregate_hash
 * 这是一个纯字符串前缀拼接;aggregate_hash 已经是 64 位 hex,所以派生是确定性的。
 */
const COMPILED_ID_PREFIX = 'compiled:';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 派生 compiled_prompt_snapshot_id(spec §7.4 rule 10)。
 *
 * 规则:`'compiled:' + aggregate_hash`。aggregate_hash 已是确定性 64 位 hex,
 * 因此前缀拼接也是确定性的;相同 logical input → 相同 aggregate_hash → 相同 ID。
 */
function buildCompiledSnapshotId(aggregate_hash: string): string {
  return `${COMPILED_ID_PREFIX}${aggregate_hash}`;
}

/**
 * 计算 aggregate_hash(spec §7.4 rule 5 / rule 9)。
 *
 * 拼接规则(确定性,与 Provider 无关):
 *   - 输入:已按 (ordinal ASC, section_id ASC) 排序的 sections。
 *   - 对每个 section,构造一行:
 *       `${section_id}|${asset_id}:${asset_version}|${placement}|${content_hash}`
 *   - 用 `\n` 连接所有行,再对整个字符串做 sha256(hex)。
 *
 * 覆盖维度(spec §7.4 rule 5):section identity(section_id)、asset version、
 * placement、content hash。authority / trust / retention / ordinal / content 原文
 * 不直接进入拼接 —— 它们要么已经反映在 content_hash 里(content),
 * 要么不影响"这段 prompt 文本最终长什么样"(authority/trust/retention 是元数据)。
 * ordinal 通过"先排序再拼接"间接参与(顺序变化 → 行序变化 → hash 变化)。
 */
function computeAggregateHash(
  sortedSections: ReadonlyArray<PromptSectionInput>,
): string {
  const payload = sortedSections
    .map(
      (s) =>
        `${s.section_id}|${s.asset_ref.asset_id}:${s.asset_ref.asset_version}|${s.placement}|${s.content_hash}`,
    )
    .join('\n');
  return sha256Hex(payload);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 把上游已选择/已批准/已确定顺序的 sections 组装为不可变 CompiledPromptSnapshot。
 *
 * 失败语义(spec §7.5):任一校验失败 → 整次 compile 抛错(不部分编译、不静默去重)。
 * 输入捕获后,调用方对原数组/对象的修改不影响已生成的快照(spec §7.5 末条 / §7.4 rule 1)。
 */
export function compilePromptSnapshot(
  input: PromptCompilationInput,
  lookup: PromptAssetApprovalLookup,
): CompiledPromptSnapshot {
  // 11) protocol / registry / request identity 守门。
  //     在拷贝 sections 之前先做,使失败尽早发生;但 requireIdentity 不消费 sections。
  const compiler_protocol_version = requireIdentity(
    input.compiler_protocol_version,
    'compiler_protocol_version',
  );
  const registry_snapshot_id = requireIdentity(
    input.registry_snapshot_id,
    'registry_snapshot_id',
  );
  const request_snapshot_id = requireIdentity(
    input.request_snapshot_id,
    'request_snapshot_id',
  );

  // 1) 深拷贝 sections —— 必须在任何校验/冻结之前进行,使调用方对原数组的后续修改
  //    (例如 push 新 section)不影响本次编译产物(spec §7.4 rule 1 / §7.5)。
  //    structuredClone 会递归拷贝普通对象/数组(满足 PromptSectionInput 的形状)。
  const sections: PromptSectionInput[] = input.sections.map(
    (section) => structuredClone(section) as PromptSectionInput,
  );

  // 2~7) per-section 校验。任一违反即抛错。
  const seenSectionIds = new Set<string>();
  const seenOrdinals = new Set<number>();
  for (const section of sections) {
    // 2) 空 content 必须拒绝(spec §7.4 rule 9)。
    //    注意:这里只校验"空字符串";上游若决定不注入,应直接省略该 section。
    if (typeof section.content !== 'string' || section.content.length === 0) {
      throw new Error(
        `empty section content is not allowed: section_id=${section.section_id} ` +
          `(upstream must omit the section instead of passing empty content)`,
      );
    }

    // 3) section_id 在 snapshot 内唯一(spec §7.4 rule 1 / §7.5)。
    if (seenSectionIds.has(section.section_id)) {
      throw new Error(
        `duplicate section_id within snapshot: ${section.section_id}`,
      );
    }
    seenSectionIds.add(section.section_id);

    // 4) ordinal 在 snapshot 内唯一;section_id 不能掩盖重复 ordinal
    //    (spec §7.4 rule 3 / §7.5)。
    if (seenOrdinals.has(section.ordinal)) {
      throw new Error(
        `duplicate ordinal within snapshot: ordinal=${section.ordinal} ` +
          `(section_id is only a deterministic tiebreaker and must not mask duplicate ordinals)`,
      );
    }
    seenOrdinals.add(section.ordinal);

    // 5) placement 必须在封闭域内(spec §7.4 rule 7 / §7.5)。
    //    显式拒绝 meta_context / conversation / tool_plane,确保 system/meta/conversation/tool
    //    plane 不会混成一个字符串平面。
    if (!ALLOWED_PLACEMENTS.has(section.placement)) {
      throw new Error(
        `unsupported placement '${section.placement}' for section_id=${section.section_id}: ` +
          `only system_static / system_dynamic are allowed (meta/conversation/tool planes must stay separate)`,
      );
    }

    // 6) content_hash 必须与 sha256(content) 一致(spec §7.4 rule 4 / §7.5)。
    const recomputed = sha256Hex(section.content);
    if (recomputed !== section.content_hash) {
      throw new Error(
        `content_hash mismatch for section_id=${section.section_id}: ` +
          `expected ${recomputed}, got ${section.content_hash}`,
      );
    }

    // 7) asset_ref 必须经 lookup 为 approved(spec §7.4 rule 8 / §7.5)。
    //    未批准资产不能因被传入 compiler 而自动变 approved。
    if (!lookup.isApproved(section.asset_ref)) {
      throw new Error(
        `asset is not approved: asset_id=${section.asset_ref.asset_id} ` +
          `asset_version=${section.asset_ref.asset_version} (section_id=${section.section_id})`,
      );
    }
  }

  // 8) 编译顺序:(ordinal ASC, section_id ASC)。section_id 仅作确定性兜底。
  //    使用 localeCompare 保证 section_id 比较的确定性(与 Wave A registry 排序一致)。
  const sorted = [...sections].sort((a, b) => {
    if (a.ordinal !== b.ordinal) {
      return a.ordinal < b.ordinal ? -1 : 1;
    }
    return a.section_id.localeCompare(b.section_id);
  });

  // 13) section_order:排序后的 section_id 数组。
  const section_order = sorted.map((s) => s.section_id);

  // 9) aggregate_hash:覆盖有序 section identity / asset version / placement / content_hash。
  const aggregate_hash = computeAggregateHash(sorted);

  // 10) compiled_prompt_snapshot_id:由 aggregate_hash 确定性派生。
  const compiled_prompt_snapshot_id = buildCompiledSnapshotId(aggregate_hash);

  // 12) 组装 + 深冻结。freezeSnapshot 会递归冻结 sections 数组、每个 section 及其嵌套对象/数组
  //     (asset_ref、provenance_refs)和 section_order 数组。
  return freezeSnapshot<CompiledPromptSnapshot>({
    compiler_protocol_version,
    compiled_prompt_snapshot_id,
    registry_snapshot_id,
    request_snapshot_id,
    sections: sorted,
    section_order,
    aggregate_hash,
  });
}
