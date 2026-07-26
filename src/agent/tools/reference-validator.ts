// src/agent/tools/reference-validator.ts
// Wave D Task 8 (M-028 / DRC-3): Tool Reference Manifest.
//
// 物理本质:buildToolReferenceManifest 把"调用方已经从结构化 asset metadata /
// compiler reference token / 确定性 render scan 中收集到的工具引用声明"
// 压成一份稳定、确定、可追溯的 ToolReferenceManifest。
//
// 边界(对应 spec §9.1 / §9.6):
//   - DRC-3 manifest 只记录引用,不验证 manual 完整性(INV-D10);也不实现
//     few-shot(M-025)或 policy projection(M-026)—— 那是独立契约。
//   - manifest 不改 Prompt 内容、tool order、visibility 或 permission(spec §9.5 rule 11)。
//   - deterministic_render_scan 只识别"已登记"的 canonical name,本函数不做自然语言
//     猜测;scanner 是否猜测由调用方负责(spec §9.6 末条)。
//   - 调用方负责把已收集好的 declarations 传进来;本函数只做校验、派生与冻结。
//
// 关键不变量(对应 spec §9.2 / §9.5 / §9.6):
//   1. 每个 Prompt tool reference 必须解析到唯一 tool_id(spec §9.5 rule 1)。
//   2. 同一 canonical name 不得映射到多个 tool_id(spec §9.6 'canonical 漂移')。
//   3. tool_id 在同一 section 内唯一(spec §9.5 rule 1)。
//   4. reference_id / reference_manifest_id 由 canonical 输入确定性派生
//      (spec §9.5 rule 12:同一不可变输入 → 相同结果)。
//   5. 重命名工具必须形成新 manifest/asset version(spec §9.5 rule 8)。
//   6. records 按 (section_id ASC, tool_id ASC) 排序(确定性输出)。
//   7. 编译期 source_kind 是封闭域;deterministic scan 不补登记(spec §9.6)。
//   8. 输出整体经 freezeSnapshot 深冻结。
//
// 本模块只导出 buildToolReferenceManifest;compiler 接入由 Task 9 处理。

import { createHash } from 'node:crypto';

import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

// ---------------------------------------------------------------------------
// Public types (frozen by spec §9.2)
// ---------------------------------------------------------------------------

/** reference 的来源(封闭域,spec §9.2)。 */
export type ToolReferenceSourceKind =
  | 'structured_asset_metadata'
  | 'compiler_reference_token'
  | 'deterministic_render_scan';

/** 调用方收集到的一条工具引用声明。 */
export interface ToolReferenceDeclaration {
  section_id: string;
  /** 如 'tool:run_bash'。稳定 ID,不是 display-name 猜测。 */
  tool_id: string;
  /** 如 'run_bash'。必须与 final tool definition 一致(spec §9.5 rule 3)。 */
  canonical_tool_name: string;
  source_kind: ToolReferenceSourceKind;
  /** 如 'asset:tools@1'。manual/description asset 身份(spec §9.5 rule 4)。 */
  evidence_ref: string;
}

export interface ToolReferenceManifestInput {
  compiled_prompt_snapshot_id: string;
  declarations: ToolReferenceDeclaration[];
}

/** manifest 中的一条 record。比 declaration 多一个 reference_id。 */
export interface ToolReferenceRecord {
  reference_id: string;
  section_id: string;
  tool_id: string;
  canonical_tool_name: string;
  source_kind: ToolReferenceSourceKind;
  evidence_ref: string;
}

export interface ToolReferenceManifest {
  reference_manifest_protocol_version: string;
  reference_manifest_id: string;
  compiled_prompt_snapshot_id: string;
  records: ToolReferenceRecord[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** manifest 协议版本(硬编码 '1',与 CRC-4 projection 协议版本风格一致)。 */
export const REFERENCE_MANIFEST_PROTOCOL_VERSION = '1';

/**
 * source_kind 的封闭域(spec §9.2)。任何不在集合内的值 → invalid。
 * 有意使用 ReadonlySet + 显式列表,使新增来源必须修改这里(封闭域不变量)。
 */
const ALLOWED_SOURCE_KINDS: ReadonlySet<ToolReferenceSourceKind> = new Set([
  'structured_asset_metadata',
  'compiler_reference_token',
  'deterministic_render_scan',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 派生 reference_id(spec §9.5 rule 12 确定性)。
 *
 * 规则:
 *   - 单个 canonical name 通常对应一条 reference,使用 `ref:<canonical_tool_name>`
 *     形式,可读且稳定(同一 canonical → 同一 reference_id)。
 *   - 当同一 canonical name 出现在多个 section(已被 canonical_ambiguous / duplicate
 *     校验排除冲突后,这里只会处理"合法多 section 引用同一 tool"的情况,实际上
 *     上游校验已经保证唯一),仍以 canonical 为主键,确保跨 section 引用同一工具
 *     得到同一 reference_id(便于追溯)。
 *
 * 设计取舍:不把 section_id / evidence_ref 纳入 reference_id —— reference_id 表示
 * "这个工具在本次 manifest 中的逻辑身份",与它出现在哪个 section、用哪个 asset
 * 版本无关。section/asset 信息保留在 record 字段中,供调用方追溯。
 */
function buildReferenceId(canonical_tool_name: string): string {
  return `ref:${canonical_tool_name}`;
}

/**
 * 派生确定性 reference_manifest_id。
 *
 * canonical 输入(顺序固定):protocol 版本 + compiled_prompt_snapshot_id +
 * 已排序 records 的 (section_id, tool_id, canonical_tool_name, source_kind,
 * evidence_ref, reference_id)。任一字段变化 → 不同 manifest_id,从而满足
 * spec §9.5 rule 8(重命名 → 新 manifest version)与 rule 12(同输入 → 同结果)。
 */
function buildManifestId(
  compiled_prompt_snapshot_id: string,
  sortedRecords: ReadonlyArray<ToolReferenceRecord>,
): string {
  const lines: string[] = [
    `protocol=${REFERENCE_MANIFEST_PROTOCOL_VERSION}`,
    `compiled_prompt_snapshot_id=${compiled_prompt_snapshot_id}`,
  ];
  for (const r of sortedRecords) {
    lines.push(
      `record=${r.section_id}|${r.tool_id}|${r.canonical_tool_name}|${r.source_kind}|${r.evidence_ref}|${r.reference_id}`,
    );
  }
  const hash = sha256Hex(lines.join('\n'));
  return `manifest:${hash.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 把已收集到的工具引用声明组装成不可变 ToolReferenceManifest。失败时 throw
 * (spec §9.6:任一校验失败 → invalid,绝不返回半成品 / 静默补登记)。
 *
 * @throws Error('compiled_prompt_snapshot_id must be ...')  当 snapshot id 缺失
 * @throws Error('reference.invalid_source_kind: ...')       当 source_kind 越界
 * @throws Error('reference.duplicate_tool_id: ...')         当同 section 内 tool_id 重复
 * @throws Error('reference.canonical_ambiguous: ...')       当一 canonical 映射多 tool_id
 * @throws Error('reference.duplicate_reference_id: ...')    当派生的 reference_id 重复(防御性)
 */
export function buildToolReferenceManifest(
  input: ToolReferenceManifestInput,
): ToolReferenceManifest {
  // 1) identity 守门:compiled_prompt_snapshot_id 非空(spec §9.5 rule 7:Prompt
  //    section 与 tool view 必须属于同一 request snapshot —— 这里要求调用方
  //    传一个非空 snapshot id 作为锚点)。
  const compiled_prompt_snapshot_id = requireIdentity(
    input.compiled_prompt_snapshot_id,
    'compiled_prompt_snapshot_id',
  );

  // 2) per-declaration 校验。先拷贝,再校验,使调用方对原数组的后续修改不影响产物。
  const declarations: ToolReferenceDeclaration[] = input.declarations.map(
    (d) => ({ ...d }),
  );

  // 累积器:用于跨 declaration 的重复 / 漂移检测。
  // - sectionToolKey:同一 (section_id, tool_id) 即重复(spec §9.5 rule 1)。
  // - canonicalToTool:canonical name → tool_id 映射,用于检测一个 name 映射多 tool_id。
  // - referenceIdSeen:派生 reference_id 唯一性(防御性;正常情况下 canonical 唯一即可保证)。
  const sectionToolKeys = new Set<string>();
  const canonicalToTool = new Map<string, string>();
  const referenceIdSeen = new Set<string>();

  const records: ToolReferenceRecord[] = [];

  for (const decl of declarations) {
    // 2a) 字段非空校验。任一缺失即 throw,带字段名便于诊断。
    const section_id = requireIdentity(decl.section_id, 'section_id');
    const tool_id = requireIdentity(decl.tool_id, 'tool_id');
    const canonical_tool_name = requireIdentity(
      decl.canonical_tool_name,
      'canonical_tool_name',
    );
    const evidence_ref = requireIdentity(decl.evidence_ref, 'evidence_ref');

    // 2b) source_kind 必须在封闭域内(spec §9.6:deterministic scan 不猜测;
    //     未知来源必须显式拒绝,不能静默补登记)。
    if (!ALLOWED_SOURCE_KINDS.has(decl.source_kind)) {
      throw new Error(
        `reference.invalid_source_kind: '${decl.source_kind}' is not one of ` +
          `[structured_asset_metadata, compiler_reference_token, deterministic_render_scan] ` +
          `(tool_id=${tool_id}, section_id=${section_id})`,
      );
    }
    const source_kind = decl.source_kind;

    // 2c) 同一 (section_id, tool_id) 重复 → invalid(spec §9.5 rule 1)。
    const sectionToolKey = `${section_id}\u0000${tool_id}`;
    if (sectionToolKeys.has(sectionToolKey)) {
      throw new Error(
        `reference.duplicate_tool_id: tool_id='${tool_id}' appears more than once ` +
          `in section_id='${section_id}'`,
      );
    }
    sectionToolKeys.add(sectionToolKey);

    // 2d) canonical name → tool_id 必须稳定;一个 name 映射多个 tool_id → invalid
    //     (spec §9.6 'canonical 漂移' / '一个 name 对应多个 tool ID')。
    //     注意:同一 canonical 在不同 section 指向同一 tool_id 是合法的
    //     (manifest 会保留两条 record,reference_id 相同 → 在 2e 防御性捕获)。
    const existingToolForCanonical = canonicalToTool.get(canonical_tool_name);
    if (existingToolForCanonical !== undefined && existingToolForCanonical !== tool_id) {
      throw new Error(
        `reference.canonical_ambiguous: canonical_tool_name='${canonical_tool_name}' ` +
          `maps to multiple tool ids ('${existingToolForCanonical}' and '${tool_id}')`,
      );
    }
    canonicalToTool.set(canonical_tool_name, tool_id);

    // 2e) 派生 reference_id(基于 canonical name,确定性)。
    const reference_id = buildReferenceId(canonical_tool_name);

    // 同一 canonical name 在多个 section 出现(指向同一 tool_id,合法情况)会导致
    // reference_id 重复。这违反"每条 record 有唯一 reference_id"的可寻址性,
    // 直接拒绝,要求调用方合并引用(同 tool 在多 section 出现时,manifest 只记录
    // 逻辑身份,不应重复登记)。
    if (referenceIdSeen.has(reference_id)) {
      throw new Error(
        `reference.duplicate_reference_id: reference_id='${reference_id}' ` +
          `derived for canonical_tool_name='${canonical_tool_name}' already exists ` +
          `(same canonical name must not be declared across multiple records; ` +
          `merge into a single declaration)`,
      );
    }
    referenceIdSeen.add(reference_id);

    records.push({
      reference_id,
      section_id,
      tool_id,
      canonical_tool_name,
      source_kind,
      evidence_ref,
    });
  }

  // 3) records 按 (section_id ASC, tool_id ASC) 排序(确定性输出,spec §9.5 rule 12)。
  //    使用 localeCompare 保证字符串比较的确定性(与 Wave A/B/C 排序风格一致)。
  const sortedRecords = [...records].sort((a, b) => {
    const bySection = a.section_id.localeCompare(b.section_id);
    if (bySection !== 0) {
      return bySection;
    }
    return a.tool_id.localeCompare(b.tool_id);
  });

  // 4) 派生 reference_manifest_id(确定性)。
  const reference_manifest_id = buildManifestId(
    compiled_prompt_snapshot_id,
    sortedRecords,
  );

  // 5) 组装 + 深冻结。freezeSnapshot 会递归冻结 records 数组与每条 record。
  return freezeSnapshot<ToolReferenceManifest>({
    reference_manifest_protocol_version: REFERENCE_MANIFEST_PROTOCOL_VERSION,
    reference_manifest_id,
    compiled_prompt_snapshot_id,
    records: sortedRecords,
  });
}

// ===========================================================================
// Wave D Task 9 (M-028 / DRC-3): Final Request Reference Gate
//
// validateToolReferences 把已经编译好的 Prompt 工具引用 manifest 对齐到本次
// request 的 final tool view,确认 Prompt 里出现的每个工具引用在最终可见工具
// 集合里仍然存在、canonical name 没漂移。校验失败 → invalid,调用方不得发送请求。
//
// 物理边界(spec §9.3 / §9.5 / §9.6 / INV-D9):
//   - 只看 final tool view 派生出的 included_tool_ids / tool_name_to_id,
//     绝不以 base Registry 代替(INV-D9)。base registry 里"存在"不等于本次
//     request 看得见。
//   - 不接入 streaming-query —— 真实"拦截发送"由主代理统一做。本函数只产出
//     ToolReferenceValidation 这种纯数据,由调用方翻译成发送决策。
//   - 不实现 render scan、manual identity resolution、policy projection match
//     的真实逻辑(分别留接口:undeclared_rendered_reference_refs 暂为空,
//     manual_identity_resolved / policy_projection_matches 暂为 true)。
//     这些是 Wave E 的接入面,本任务只把"看 final view"这条核心断言做对。
//
// 关键不变量:
//   1. 四个 snapshot id 都必须非空(spec §9.3 末段:所有输入必须绑定同一 request
//      snapshot)。空 → throw,因为这不是"校验失败",而是调用方契约违反。
//   2. snapshot 一致性:final_tool_view.tool_view_snapshot_id / manifest 的
//      compiled_prompt_snapshot_id 和 reference_manifest_id 必须与 input 上的
//      声明一致。不一致 → invalid(spec §9.5 rule 7)。
//   3. no-tools 特例:no_tool_validation_id 非空时,manifest.records 必须为空、
//      final_tool_view.included_tool_ids 必须为空(spec §9.5 rule 6)。
//   4. 逐 record 检查 visible_in_final_view 与 canonical_name_matches。
//   5. 同一不可变输入 → 同一 validation_id(确定性,spec §9.5 rule 12)。
//   6. 输出整体深冻结;不修改输入(包括 manifest 的 records 数组、Set、Map)。
// ===========================================================================

/** validation 协议版本(硬编码 '1',与 manifest 协议版本风格一致)。 */
export const TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION = '1';

/** 校验器看到的 final tool view(本次 request 决议出的可见工具集合)。 */
export interface ToolReferenceFinalToolView {
  tool_view_snapshot_id: string;
  /** 本次 request 实际包含的 tool_id 集合(base registry 里的工具不一定在内)。 */
  included_tool_ids: ReadonlySet<string>;
  /** canonical name → tool_id 的最终绑定。 */
  tool_name_to_id: ReadonlyMap<string, string>;
}

/** validateToolReferences 的输入(spec §9.3 + final tool view / manifest 引用)。 */
export interface ToolReferenceValidationInput {
  validation_protocol_version: string;
  request_snapshot_id: string;
  compiled_prompt_snapshot_id: string;
  final_tool_view_snapshot_id: string;
  reference_manifest_id: string;
  /** 已构建好的 manifest;其内部 snapshot id 必须与本 input 一致。 */
  manifest: ToolReferenceManifest;
  /** 本次 request 的 final tool view(INV-D9:唯一权威的可见性来源)。 */
  final_tool_view: ToolReferenceFinalToolView;
  /** 当前 request 已派生的 policy projection ids(暂未做匹配,仅透传)。 */
  tool_policy_projection_ids: string[];
  /** no-tool request contract 的 id;非空表示本次是 no-tools 请求。 */
  no_tool_validation_id: string | null;
}

/** 单条 reference 的逐项检查结果(spec §9.4)。 */
export interface ToolReferenceCheckRecord {
  reference_id: string;
  tool_id: string;
  visible_in_final_view: boolean;
  canonical_name_matches: boolean;
  manual_identity_resolved: boolean;
  policy_projection_matches: boolean;
}

/** validateToolReferences 的输出(spec §9.4)。 */
export interface ToolReferenceValidation {
  validation_protocol_version: string;
  validation_id: string;
  request_snapshot_id: string;
  compiled_prompt_snapshot_id: string;
  final_tool_view_snapshot_id: string;
  reference_manifest_id: string;
  status: 'valid' | 'invalid';
  checked_records: ReadonlyArray<ToolReferenceCheckRecord>;
  orphan_reference_ids: string[];
  undeclared_rendered_reference_refs: string[];
  diagnostics: string[];
}

/**
 * 派生确定性 validation_id。
 *
 * canonical 输入(顺序固定):protocol 版本 + 四个 snapshot id(reference_manifest_id
 * 已隐含 manifest 内容的 hash,所以无需把每条 record 再展开)。任一字段变化 →
 * 不同 validation_id,从而满足 spec §9.5 rule 12。前缀反映 status,方便调用方在
 * telemetry / 日志里一眼区分。
 */
function buildValidationId(
  protocolVersion: string,
  request_snapshot_id: string,
  compiled_prompt_snapshot_id: string,
  final_tool_view_snapshot_id: string,
  reference_manifest_id: string,
  status: 'valid' | 'invalid',
): string {
  const lines: string[] = [
    `protocol=${protocolVersion}`,
    `request_snapshot_id=${request_snapshot_id}`,
    `compiled_prompt_snapshot_id=${compiled_prompt_snapshot_id}`,
    `final_tool_view_snapshot_id=${final_tool_view_snapshot_id}`,
    `reference_manifest_id=${reference_manifest_id}`,
  ];
  const hash = sha256Hex(lines.join('\n'));
  return `${status}:${hash.slice(0, 16)}`;
}

/**
 * 校验 Prompt 工具引用 manifest 是否对齐本次 request 的 final tool view。
 *
 * 失败语义(spec §9.6):
 *   - identity 字段缺失/空 → throw(调用方契约违反,非校验失败);
 *   - snapshot 不一致 → invalid + diagnostic;
 *   - no-tools 但 manifest 非空 / final view 非空 → invalid + diagnostic;
 *   - reference 不可见 → invalid + 记入 orphan_reference_ids;
 *   - canonical 漂移 → invalid + diagnostic;
 *   - 其它一律 valid。
 *
 * 输出整体经 freezeSnapshot 深冻结;输入不被修改(只读取 manifest.records 与
 * final_tool_view 的 Set/Map)。
 */
export function validateToolReferences(
  input: ToolReferenceValidationInput,
): ToolReferenceValidation {
  // 1) identity 守门:四个 snapshot id 必须非空(spec §9.3 末段)。
  //    这里用 throw 而不是 invalid,因为这些字段缺失是调用方契约违反,
  //    不是"本次 request 校验失败"。requireIdentity 抛带字段名的错误。
  const validation_protocol_version = requireIdentity(
    input.validation_protocol_version,
    'validation_protocol_version',
  );
  const request_snapshot_id = requireIdentity(
    input.request_snapshot_id,
    'request_snapshot_id',
  );
  const compiled_prompt_snapshot_id = requireIdentity(
    input.compiled_prompt_snapshot_id,
    'compiled_prompt_snapshot_id',
  );
  const final_tool_view_snapshot_id = requireIdentity(
    input.final_tool_view_snapshot_id,
    'final_tool_view_snapshot_id',
  );
  const reference_manifest_id = requireIdentity(
    input.reference_manifest_id,
    'reference_manifest_id',
  );

  const diagnostics: string[] = [];

  // 2) snapshot 一致性(spec §9.5 rule 7):manifest 与 final_tool_view 的内部
  //    snapshot id 必须与 input 上的声明一致。任一不一致 → invalid(不 throw,
  //    因为这可能是"上游传错了快照"的真实运行场景,调用方需要 invalid 而不是栈)。
  const manifest = input.manifest;
  const finalToolView = input.final_tool_view;

  let snapshotConsistent = true;
  if (manifest.compiled_prompt_snapshot_id !== compiled_prompt_snapshot_id) {
    diagnostics.push(
      `reference.manifest_snapshot_mismatch: manifest.compiled_prompt_snapshot_id=` +
        `'${manifest.compiled_prompt_snapshot_id}' !== input.compiled_prompt_snapshot_id=` +
        `'${compiled_prompt_snapshot_id}'`,
    );
    snapshotConsistent = false;
  }
  if (manifest.reference_manifest_id !== reference_manifest_id) {
    diagnostics.push(
      `reference.manifest_id_mismatch: manifest.reference_manifest_id=` +
        `'${manifest.reference_manifest_id}' !== input.reference_manifest_id=` +
        `'${reference_manifest_id}'`,
    );
    snapshotConsistent = false;
  }
  if (finalToolView.tool_view_snapshot_id !== final_tool_view_snapshot_id) {
    diagnostics.push(
      `reference.tool_view_snapshot_mismatch: final_tool_view.tool_view_snapshot_id=` +
        `'${finalToolView.tool_view_snapshot_id}' !== input.final_tool_view_snapshot_id=` +
        `'${final_tool_view_snapshot_id}'`,
    );
    snapshotConsistent = false;
  }

  // 3) no-tools 特例(spec §9.5 rule 6):no_tool_validation_id 非空表示本次是
  //    no-tools 请求,此时 manifest.records 必须为空、final_tool_view.included_tool_ids
  //    必须为空。否则 protocol error(用 invalid 表达,因为这是"运行时观测到的
  //    不一致",而非调用方契约违反)。
  let noToolsConsistent = true;
  if (input.no_tool_validation_id !== null) {
    if (manifest.records.length > 0) {
      diagnostics.push(
        `reference.no_tools_manifest_not_empty: no_tool_validation_id=` +
          `'${input.no_tool_validation_id}' but manifest has ${manifest.records.length} record(s)`,
      );
      noToolsConsistent = false;
    }
    if (finalToolView.included_tool_ids.size > 0) {
      diagnostics.push(
        `reference.no_tools_view_not_empty: no_tool_validation_id=` +
          `'${input.no_tool_validation_id}' but final_tool_view has ` +
          `${finalToolView.included_tool_ids.size} included tool(s)`,
      );
      noToolsConsistent = false;
    }
  }

  // 4) 逐 record 检查(spec §9.5 rule 1/2/3)。只读取,不修改输入的 manifest.records。
  const checkedRecords: ToolReferenceCheckRecord[] = [];
  const orphanReferenceIds: string[] = [];
  let recordsConsistent = true;

  for (const record of manifest.records) {
    // 4a) visible_in_final_view: tool_id 必须在 final tool view 的 included 集合里
    //     (INV-D9:唯一权威是 final view,不是 base registry)。
    const visible = finalToolView.included_tool_ids.has(record.tool_id);

    // 4b) canonical_name_matches: final view 里同名工具必须解析到同一个 tool_id。
    //     若 final view 里没有该名字,或者解析到别的 tool_id,都视为漂移。
    const resolvedToolId = finalToolView.tool_name_to_id.get(record.canonical_tool_name);
    const canonicalMatches =
      resolvedToolId !== undefined && resolvedToolId === record.tool_id;

    // manual_identity_resolved / policy_projection_matches:Wave E 接入面,本任务
    // 暂时返回 true,使核心断言(visible/canonical)成为唯一 invalid 来源。
    const manualIdentityResolved = true;
    const policyProjectionMatches = true;

    checkedRecords.push({
      reference_id: record.reference_id,
      tool_id: record.tool_id,
      visible_in_final_view: visible,
      canonical_name_matches: canonicalMatches,
      manual_identity_resolved: manualIdentityResolved,
      policy_projection_matches: policyProjectionMatches,
    });

    if (!visible) {
      orphanReferenceIds.push(record.reference_id);
      recordsConsistent = false;
    }
    if (!canonicalMatches) {
      // canonical 漂移单独诊断,便于调用方区分"工具不可见"与"名字绑错"。
      const resolvedDesc =
        resolvedToolId === undefined ? '<absent>' : resolvedToolId;
      diagnostics.push(
        `reference.canonical_drift: reference_id='${record.reference_id}' ` +
          `canonical_tool_name='${record.canonical_tool_name}' ` +
          `tool_id='${record.tool_id}' but final_tool_view resolves to ` +
          `'${resolvedDesc}'`,
      );
      recordsConsistent = false;
    }
  }

  // 5) status:任一 snapshot 不一致 / no-tools 不一致 / record 不一致 → invalid。
  const status: 'valid' | 'invalid' =
    snapshotConsistent && noToolsConsistent && recordsConsistent ? 'valid' : 'invalid';

  // 6) validation_id:确定性派生。前缀反映 status。
  const validation_id = buildValidationId(
    validation_protocol_version,
    request_snapshot_id,
    compiled_prompt_snapshot_id,
    final_tool_view_snapshot_id,
    reference_manifest_id,
    status,
  );

  // 7) undeclared_rendered_reference_refs:本任务不实现 render scan,留空数组。
  const undeclared_rendered_reference_refs: string[] = [];

  // 8) 组装 + 深冻结。
  return freezeSnapshot<ToolReferenceValidation>({
    validation_protocol_version,
    validation_id,
    request_snapshot_id,
    compiled_prompt_snapshot_id,
    final_tool_view_snapshot_id,
    reference_manifest_id,
    status,
    checked_records: checkedRecords,
    orphan_reference_ids: orphanReferenceIds,
    undeclared_rendered_reference_refs,
    diagnostics,
  });
}
