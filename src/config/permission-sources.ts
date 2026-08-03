// Config Sources 与安全持久化（Task 9 / 设计 §9.1-§9.4、§10 A65-A73）
//
// 物理本质：四套独立决策域的"来源合并器"。每套有自己的 precedence，禁止混用：
//   1. permission rule（§9.1）：behavior precedence（deny > ask > allow）+ source provenance
//   2. startup mode（§9.2）：CLI > resumed > userDefault > build（在 mode-transition.ts 实现）
//   3. policy gate（§9.3）：gate 只降级不授权（在 mode-transition.ts 实现）
//   4. classifier config（§9.4）：只信任 user/local/flag/policy，排除 project/command/session/cliArg/sdk
//
// 本模块只做"纯逻辑合并"，不读文件系统、不写盘、不调用 provider。
// 文件 I/O 与原子写在 ConfigStore（store.ts）中实现。
//
// 不变量：
//   - mergePermissionRules 只按 behavior + source precedence 合并，不负责 startup mode / policy gate / classifier config
//   - projectClassifierConfigSources 只采用 user/local/flag/policy，排除其余来源
//   - sdkSettings 本期 DROP-DEFER：不进入 schema，不建立 SDK trust boundary
//   - mergeRawConfig 保留未知字段，undefined 删除键

import type { PermissionRule } from '../permission/types.js';
import type { ClassifierProviderCapabilities } from '../permission/classifier-provider.js';
import { unsupportedClassifierCapabilities } from '../permission/classifier-provider.js';

// ─── §9.1 permission rule source precedence ──────────────────────────────────

/**
 * 权限规则的权威 source provenance 顺序（设计 §9.1）。
 * 行为相同且 normalized scope 重叠时，此顺序决定权威性（前 > 后）。
 * `cliArg` 只表示启动 mode flag，不是规则来源；`sdkSettings` 本期舍弃。
 */
export const PERMISSION_RULE_SOURCE_PRECEDENCE = [
  'policySettings',
  'flagSettings',
  'command',
  'session',
  'localSettings',
  'projectSettings',
  'userSettings',
] as const;

export type PermissionRuleSource = (typeof PERMISSION_RULE_SOURCE_PRECEDENCE)[number];

/** 判断一个字符串是否是合法的 permission rule source（设计 §9.1） */
export function isPermissionRuleSource(s: string): s is PermissionRuleSource {
  return (PERMISSION_RULE_SOURCE_PRECEDENCE as readonly string[]).includes(s);
}

/** 带来源标记的合并后规则（用于 rule merge 输出与后续 checker 消费） */
export interface MergedPermissionRule extends PermissionRule {
  readonly source: PermissionRuleSource;
}

/** mergePermissionRules 输入：带来源的规则数组 */
export type SourcedPermissionRules = readonly MergedPermissionRule[];

/**
 * 行为优先级（deny 最高，allow 最低）。
 * 来源 precedence 不能把 deny/ask 降级——设计 §9.1。
 */
const BEHAVIOR_RANK: Record<PermissionRule['behavior'], number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

/**
 * 合并多来源权限规则（设计 §9.1 / A65）。
 *
 * 合并语义：
 *   1. behavior precedence 优先：deny > ask > allow，任一来源的 deny 高于任何 ask/allow。
 *   2. 行为相同且 scope 重叠时，按 source provenance 排序（policy 最权威，user 最末）。
 *
 * 本函数不负责 startup mode、policy gate 或 classifier config——那些是独立决策域。
 * 输出保持来源标记，供 checker 与 audit 使用。
 */
export function mergePermissionRules(rules: SourcedPermissionRules): MergedPermissionRule[] {
  // 按 source provenance 排序（policy 最前 = 最权威）
  const sourceRank = (src: PermissionRuleSource): number =>
    PERMISSION_RULE_SOURCE_PRECEDENCE.indexOf(src);
  const sorted = [...rules].sort((a, b) => {
    // 行为优先：deny 最前
    const br = BEHAVIOR_RANK[a.behavior] - BEHAVIOR_RANK[b.behavior];
    if (br !== 0) return br;
    // 同行为按 source provenance
    return sourceRank(a.source) - sourceRank(b.source);
  });
  return sorted;
}

// ─── §9.4 classifier config trusted sources ──────────────────────────────────

/**
 * classifier config 的可信来源集合（设计 §9.4）。
 * 只采用 policySettings / userSettings / localSettings / flagSettings。
 * 排除 projectSettings / command / session / cliArg / sdkSettings / tool/file/MCP。
 */
export const CLASSIFIER_TRUSTED_SOURCES = ['userSettings', 'localSettings', 'flagSettings', 'policySettings'] as const;

/**
 * classifier config 来源投影的稳定 section 顺序（设计 §9.4）。
 * user -> local -> flag -> policy。
 */
const CLASSIFIER_SECTION_ORDER = CLASSIFIER_TRUSTED_SOURCES;

/** classifier 单来源的输入片段 */
export interface ClassifierSourceSection {
  readonly rules?: readonly string[];
  readonly classifierModel?: string;
}

/** classifier source projection 的完整输入（所有可能来源） */
export interface ClassifierConfigSourcesInput {
  readonly userSettings?: ClassifierSourceSection;
  readonly localSettings?: ClassifierSourceSection;
  readonly flagSettings?: ClassifierSourceSection;
  readonly projectSettings?: ClassifierSourceSection;
  readonly command?: ClassifierSourceSection;
  readonly session?: ClassifierSourceSection;
  readonly cliArg?: ClassifierSourceSection;
  readonly sdkSettings?: ClassifierSourceSection;
  readonly policySettings?: ClassifierSourceSection;
}

/** 被排除的来源记录（用于 audit） */
export interface RejectedClassifierSource {
  readonly source: string;
  readonly reason: string;
}

/** classifier config 投影结果（设计 §9.4） */
export interface ProjectedClassifierConfig {
  /** 按 user -> local -> flag -> policy 顺序拼接的 rule sections（跳过空段） */
  readonly rules: readonly string[];
  /** classifierModel：按可信来源顺序取首个非空（flag > local > user） */
  readonly classifierModel?: string;
  /** 被排除的来源记录 */
  readonly rejected: readonly RejectedClassifierSource[];
}

/** 投影 classifier config sources（设计 §9.4 / A70 / A79）。
 *
 * 只采用 user/local/flag/policy，按 user -> local -> flag -> policy 稳定顺序拼接 rules。
 * classifierModel 按 flag > local > user 取首个非空（policy 的 model 也可信，但优先级最低）。
 * project/command/session/cliArg/sdk 全部排除并记录到 rejected。
 * 组织 policy section 位置固定（最后），不可被排除来源替换。
 */
export function projectClassifierConfigSources(
  input: ClassifierConfigSourcesInput,
): ProjectedClassifierConfig {
  const rejected: RejectedClassifierSource[] = [];
  const excludedSources: Array<keyof ClassifierConfigSourcesInput> = [
    'projectSettings', 'command', 'session', 'cliArg', 'sdkSettings',
  ];
  for (const src of excludedSources) {
    if (input[src]) {
      rejected.push({
        source: src,
        reason: `${src} is not a classifier-trusted config source (design §9.4)`,
      });
    }
  }

  // rules：按 user -> local -> flag -> policy 顺序拼接（跳过空段）
  const rules: string[] = [];
  for (const src of CLASSIFIER_SECTION_ORDER) {
    const section = input[src];
    if (section?.rules && section.rules.length > 0) {
      rules.push(...section.rules);
    }
  }

  // classifierModel：flag > local > user > policy（取首个非空）
  // 设计 §9.4 稳定顺序 user -> local -> flag -> policy；model 优先级 flag > local > user
  // 取可信来源中首个非空 classifierModel
  const modelOrder: Array<keyof ClassifierConfigSourcesInput> = ['flagSettings', 'localSettings', 'userSettings', 'policySettings'];
  let classifierModel: string | undefined;
  for (const src of modelOrder) {
    if (input[src]?.classifierModel) {
      classifierModel = input[src]!.classifierModel;
      break;
    }
  }

  return { rules, ...(classifierModel !== undefined ? { classifierModel } : {}), rejected };
}

// ─── A71/A80: auto-mode rule sections merge ───────────────────────────────────

/** auto-mode 单来源 rule section */
export interface AutoModeRuleSource {
  readonly source: (typeof CLASSIFIER_TRUSTED_SOURCES)[number];
  readonly rules: readonly string[];
}

/**
 * 合并可信来源的 auto-mode rule sections（设计 §10 A80 / A71）。
 *
 * 语义（设计 §10 A80）：
 *   - 非空 user rules replace 默认规则段；
 *   - 空 user 段回退默认（即不替换）；
 *   - 组织 policy 规则位置固定（最后）。
 *
 * 输出顺序：user -> local -> flag -> policy（设计 §9.4 稳定 section 顺序）。
 */
export function mergeAutoModeRules(sources: readonly AutoModeRuleSource[]): string[] {
  // 是否有非空 user 段（replace 语义）
  const userSection = sources.find((s) => s.source === 'userSettings');
  const userReplacesDefaults = userSection !== undefined && userSection.rules.length > 0;

  const result: string[] = [];
  // 按 CLASSIFIER_SECTION_ORDER 稳定顺序拼接
  for (const src of CLASSIFIER_SECTION_ORDER) {
    const section = sources.find((s) => s.source === src);
    if (!section) continue;
    // 空段：如果是 user 段且为空，跳过（不 replace defaults）
    if (section.rules.length === 0) continue;
    result.push(...section.rules);
  }

  // 如果 user 未 replace defaults 且没有其他段提供 rules，result 已为空（正常）
  // userReplacesDefaults 标记仅用于测试断言语义，不影响拼接逻辑（非空段都会拼入）
  void userReplacesDefaults; // 语义标记：非空 user replace，空 user fallback
  return result;
}

// ─── classifier provider metadata（静态，无 discovery RPC） ────────────────────

/** provider config 中与 classifier 相关的字段 */
export interface ProviderMetadataInput {
  readonly fastClassifierModel?: string;
  readonly classifierCapabilities?: Partial<ClassifierProviderCapabilities>;
}

/** adapter 静态声明的 metadata（可选） */
export interface AdapterMetadata {
  readonly fastClassifierModel?: string;
  readonly classifierCapabilities?: Partial<ClassifierProviderCapabilities>;
}

/** discovery 回调（测试时注入，证明它不被调用） */
export interface ProviderMetadataDiscovery {
  readonly discovery?: () => void;
}

/** 静态加载的 classifier provider metadata */
export interface StaticProviderMetadata {
  readonly fastClassifierModel?: string;
  readonly capabilities: ClassifierProviderCapabilities;
}

/**
 * 静态加载 classifier provider metadata（设计 §7.3 / A70 provider metadata）。
 *
 * 只合并 adapter/config 静态声明的 capability；unknown 归一为 unsupported。
 * 禁止网络探测 RPC——discovery 参数只为证明它不被调用。
 */
export function loadStaticClassifierProviderMetadata(
  providerConfig: ProviderMetadataInput,
  adapter: AdapterMetadata,
  _options: ProviderMetadataDiscovery = {},
): StaticProviderMetadata {
  // fastClassifierModel：provider config 优先，adapter 兜底
  const fastClassifierModel = providerConfig.fastClassifierModel ?? adapter.fastClassifierModel;

  // capabilities：合并 provider config + adapter 静态声明；任一来源声明即支持
  const merged: Partial<ClassifierProviderCapabilities> = {
    ...adapter.classifierCapabilities,
    ...providerConfig.classifierCapabilities,
  };

  // 无任何声明 -> unsupported
  const hasAnyDeclaration =
    merged.reasoningControl !== undefined ||
    merged.decodingControl !== undefined ||
    merged.promptCache !== undefined ||
    merged.minimumOutputTokens !== undefined;
  const capabilities: ClassifierProviderCapabilities = hasAnyDeclaration
    ? {
        reasoningControl: !!merged.reasoningControl,
        decodingControl: !!merged.decodingControl,
        promptCache: !!merged.promptCache,
        ...(merged.minimumOutputTokens !== undefined ? { minimumOutputTokens: merged.minimumOutputTokens } : {}),
      }
    : unsupportedClassifierCapabilities();

  return {
    ...(fastClassifierModel !== undefined ? { fastClassifierModel } : {}),
    capabilities,
  };
}

// ─── A68/A69: raw config merge ────────────────────────────────────────────────

/**
 * 合并两个 raw config 对象（设计 §10 / A68/A69）。
 *
 * 语义：
 *   - 未知字段保留（A68：schema-invalid fields retain raw values）；
 *   - base 中的字段如果 patch 提供（包括 undefined），用 patch 覆盖；
 *   - patch 中显式 undefined 表示删除该键（A69）；
 *   - 不做 schema 校验——保留原始值，schema 校验在 ConfigStore.load 负责。
 */
export function mergeRawConfig(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── A73: legacy config loading ───────────────────────────────────────────────

/** legacy 权限配置的兼容形状 */
interface LegacyPermissionConfig {
  readonly mode?: string;
  readonly rules?: unknown[];
}

/** legacy 配置的兼容形状 */
export interface LegacyConfig {
  readonly permissions?: LegacyPermissionConfig;
  readonly [key: string]: unknown;
}

/** legacy 加载结果（permissions 至少有 mode） */
export interface LoadedLegacyConfig {
  readonly permissions: {
    readonly mode: 'build' | 'plan' | 'auto';
    readonly rules: readonly unknown[];
  };
  readonly [key: string]: unknown;
}

const VALID_LEGACY_MODES: ReadonlyArray<'build' | 'plan' | 'auto'> = ['build', 'plan', 'auto'];

/**
 * 加载 legacy 配置（设计 §10 / A73）。
 *
 * 向后兼容：
 *   - 旧文件无 auto 字段时保留 build/plan 行为；
 *   - legacy 'default' 迁移为 'build'；
 *   - 非法 mode 回退 'build'；
 *   - 空配置默认 'build'。
 */
export function loadLegacyConfig(raw: LegacyConfig): LoadedLegacyConfig {
  const perm = raw.permissions;
  const rawMode = perm?.mode;
  let mode: 'build' | 'plan' | 'auto';
  if (rawMode === 'default' || rawMode === undefined) {
    mode = 'build';
  } else if ((VALID_LEGACY_MODES as readonly string[]).includes(rawMode)) {
    mode = rawMode as 'build' | 'plan' | 'auto';
  } else {
    mode = 'build';
  }
  const rules = Array.isArray(perm?.rules) ? perm!.rules : [];
  return { ...raw, permissions: { mode, rules } };
}
