// src/agent/prompt/registry.ts
// AUTO-0025 Wave A (Task 2):RC-1 Prompt Asset Registry.
//
// 物理本质:buildPromptAssetRegistry 是 prompt 资产清单的"受控入口"。
// 输入是 in-memory 的 PromptAssetRecord[](不读任何外部 vendor prompt 库),
// 输出是一份冻结的、按 (asset_id, asset_version) 升序的、仅含 approved 资产的快照。
//
// 关键不变量(对应 spec §7.4 / §7.6):
//   1. registry_snapshot_id 必须是非空字符串(借 requireIdentity 守门)。
//   2. 同 (asset_id, asset_version) + 不同 content_ref 视为冲突 → throw(message 含 asset_id@asset_version);
//      同 (asset_id, asset_version) + 同 content_ref 视为重复 → 仅保留一份(去重)。
//   3. approved 资产必须 license 非空、evidence_refs 全部已知、target_capabilities 全部已知;
//      任一违反即视为整体 fatal(整次 build 抛错,不部分加载)。
//   4. 输出仅含 approved;unverified/candidate/rejected/retired 一律排除
//      (candidate 即使缺 evidence 也是"静默排除",不是 fatal)。
//   5. 输出按 (asset_id, asset_version) 升序排列,使用 localeCompare 保证确定性。
//   6. 每条记录深拷贝(structuredClone)后再冻结 —— 不就地冻结调用方输入。
//   7. 输出快照整体经 freezeSnapshot 深冻结(数组 + 每条记录 + 嵌套对象/数组均不可变)。
//   8. 绝不引入 protocol_version;asset_version 与 protocol_version 正交(INV-A1)。

import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

export type PromptEvaluationStatus =
  | 'unverified'
  | 'candidate'
  | 'approved'
  | 'rejected'
  | 'retired';

export interface PromptAssetRecord {
  asset_id: string;
  asset_version: string;
  source: {
    kind: 'mi-code' | 'claude-reference' | 'external';
    locator: string;
    license: string | null;
  };
  purpose: string;
  owner: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
  target_models: string[];
  target_capabilities: string[];
  prohibited_placements: string[];
  adaptation_notes: string;
  evaluation: {
    status: PromptEvaluationStatus;
    evidence_refs: string[];
  };
  content_ref: string;
}

export interface PromptAssetRegistrySnapshot {
  registry_snapshot_id: string;
  assets: readonly Readonly<PromptAssetRecord>[];
}

export interface BuildPromptAssetRegistryInput {
  registry_snapshot_id: string;
  records: readonly PromptAssetRecord[];
  known_evidence_refs: ReadonlySet<string>;
  known_capabilities: ReadonlySet<string>;
}

/**
 * 把 (asset_id, asset_version) 折叠成单一的稳定键,用于去重/冲突检测与排序。
 *
 * 注意:asset_version 是字符串比较,不做语义版本解析 —— spec 只要求确定性排序。
 */
function assetKey(asset_id: string, asset_version: string): string {
  return `${asset_id}@${asset_version}`;
}

/**
 * 构建一份冻结的、仅含 approved 资产的 prompt registry 快照。
 *
 * 失败语义:
 *   - 冲突 / approved 校验失败 / registry_snapshot_id 非法 → throw(整体 fatal,不部分加载)。
 *   - candidate / unverified / rejected / retired / candidate 缺 evidence → 静默排除(不抛错)。
 */
export function buildPromptAssetRegistry(
  input: BuildPromptAssetRegistryInput,
): PromptAssetRegistrySnapshot {
  // 1) registry_snapshot_id 守门 —— 复用 requireIdentity(避免在 prompt 模块里再造字符串校验)。
  const registry_snapshot_id = requireIdentity(
    input.registry_snapshot_id,
    'registry_snapshot_id',
  );

  // 2) 第一遍扫描:冲突检测 + 去重 + approved 完整性校验。
  //    保持首次出现的顺序(随后再排序),以确保去重逻辑可预测。
  const seen = new Map<string, PromptAssetRecord>(); // key -> 首次出现的记录
  for (const record of input.records) {
    const key = assetKey(record.asset_id, record.asset_version);
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, record);
      continue;
    }
    // 同 (asset_id, asset_version):content_ref 不同 → 冲突;相同 → 去重(保留首次)。
    if (existing.content_ref !== record.content_ref) {
      throw new Error(
        `conflicting content_ref for asset_id@asset_version: ${key} ` +
          `(${existing.content_ref} vs ${record.content_ref})`,
      );
    }
    // 否则视为重复,丢弃后续拷贝。
  }

  // 3) 第二遍:筛选 approved,并对其执行强不变量校验。
  //    candidate 等非 approved 状态直接跳过 —— 即使缺 evidence 也是"静默排除",不抛错。
  const approved: PromptAssetRecord[] = [];
  for (const record of seen.values()) {
    if (record.evaluation.status !== 'approved') {
      continue;
    }
    assertApprovedInvariants(record, input.known_evidence_refs, input.known_capabilities);
    approved.push(record);
  }

  // 4) 排序:按 (asset_id, asset_version) 升序,使用 localeCompare 保证确定性的稳定输出。
  approved.sort((a, b) => {
    const byId = a.asset_id.localeCompare(b.asset_id);
    if (byId !== 0) return byId;
    return a.asset_version.localeCompare(b.asset_version);
  });

  // 5) 深拷贝每条记录,避免冻结调用方输入或与外部可变引用共享。
  //    structuredClone 在 Node 17+ 内置,会递归拷贝普通对象/数组(满足 PromptAssetRecord 的形状)。
  const cloned = approved.map((record) => structuredClone(record) as PromptAssetRecord);

  // 6) 组装快照 + 整体深冻结(freezeSnapshot 会递归冻结 assets 数组、每条记录及其嵌套数组/对象)。
  return freezeSnapshot<PromptAssetRegistrySnapshot>({
    registry_snapshot_id,
    assets: cloned,
  });
}

/**
 * 对单条 approved 资产执行 spec §7.4 的强不变量校验。
 * 任一违反即抛错(由调用方保证"整体 fatal,不部分加载")。
 */
function assertApprovedInvariants(
  record: PromptAssetRecord,
  known_evidence_refs: ReadonlySet<string>,
  known_capabilities: ReadonlySet<string>,
): void {
  const key = assetKey(record.asset_id, record.asset_version);

  // 3a) license 必须是非空字符串(mi-code 的 ISC 总是已知;external/claude-reference 必须显式 license)。
  if (
    record.source.license === null ||
    typeof record.source.license !== 'string' ||
    record.source.license.trim().length === 0
  ) {
    throw new Error(
      `approved asset ${key} requires a non-empty source.license ` +
        `(kind=${record.source.kind})`,
    );
  }

  // 3b) 每条 evidence_ref 必须在已知 evidence 集合中(approved 资产不能引用未登记的评估证据)。
  for (const ref of record.evaluation.evidence_refs) {
    if (!known_evidence_refs.has(ref)) {
      throw new Error(
        `approved asset ${key} references unknown evidence_ref: ${ref}`,
      );
    }
  }

  // 3c) 每条 target_capability 必须在已知 capability 集合中
  //     (approved 资产不能声明尚未建模的能力,否则下游 placement 无法判定)。
  for (const cap of record.target_capabilities) {
    if (!known_capabilities.has(cap)) {
      throw new Error(
        `approved asset ${key} declares unknown target_capability: ${cap}`,
      );
    }
  }
}
