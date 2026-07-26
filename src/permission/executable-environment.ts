// ERC-4 / M-065 Inline Environment Policy
//
// 物理本质:把 DRC-5 解析出的 inline `VAR=value` 语法事实,按平台 policy
// 分类为 safe / controlled / path-resolution / loader / unknown,然后映射到
// preserve / strip / ask / deny 四态结构化决策。它是 spawn 前的多重 AND 防线
// 之一(spec §10.9),与 M-063 inherited scrub 串联但不互相替代(INV-E14)。
//
// 关键不变量(spec §10.4 + §10.9 + INV-E14/E17):
//   1. inherited 与 inline 是 AND —— 本模块只处理 inline;调用方必须保证
//      输入的 assignment 已建立在 M-063 scrubbed snapshot 之上,本函数不直接
//      读 inherited,也不恢复 M-063 已剥离的变量;
//   2. 平台 policy 独立版本化(INV-E17)—— Windows/Linux/macOS 的 denied
//      名单互不混用,扩充必须 bump policy_version 并经安全评审;
//   3. decision 只保存 value_ref / value_hash / source_range_ref / risk /
//      reason_code,绝不复制实际 value(spec §10.3 末段);
//   4. Plan Mode 与 ask-unavailable 下 loader injection 与 unknown → deny
//      (spec §10.4 rule 4 + §10.11 错误语义);
//   5. strip 只在精确 policy 声明"移除后仍是受限等价动作"时允许;本 Wave
//      默认 safe/controlled 集合为空,strip 不会出现;
//   6. aggregated_action 是最严格(deny > ask > strip > preserve);
//   7. 不声称变量全集完整(spec §3 明确排除)。
//
// 本模块不调用 child_process / fs / env lookup;不执行命令;不授予执行权限。

import { createHash } from 'node:crypto';
import { requireIdentity, freezeSnapshot } from '../agent/contracts/identities.js';
import type { CommandStructuralDecision } from './command-policy.js';

// ─────────────────────────────────────────────
// 协议常量
// ─────────────────────────────────────────────

/** Wave E 首个 inline environment decision 协议版本(硬编码 '1')。 */
export const INLINE_ENVIRONMENT_PROTOCOL_VERSION = '1';

// ─────────────────────────────────────────────
// 类型(spec §10.2 ~ §10.4)
// ─────────────────────────────────────────────

/** 平台族(与 NodeJS.Platform 对齐,但只暴露三个稳定 family)。 */
export type PlatformFamily = 'win32' | 'linux' | 'darwin';

/**
 * 单条 inline assignment 的风险分类(spec §10.3 InlineEnvironmentRisk)。
 *
 * 语义:
 *   - safe_passthrough: policy 显式允许原样保留(已知无副作用);
 *   - controlled_override: policy 标记需用户确认后才允许覆盖;
 *   - path_resolution_affecting: PATH/PATHEXT/COMSPEC 类——影响 executable
 *     resolution,必须在 resolution 之前明确处理(本 Wave 默认 deny);
 *   - loader_injection: LD_PRELOAD / DYLD_INSERT_LIBRARIES 类——可注入恶意
 *     库,Plan/ask-unavailable 下必须 deny;
 *   - unknown: 不在任何 policy 名单,按 control_mode 分流。
 */
export type InlineAssignmentRisk =
  | 'safe_passthrough'
  | 'controlled_override'
  | 'path_resolution_affecting'
  | 'loader_injection'
  | 'unknown';

/**
 * 单条 assignment 的结构化动作(spec §10.4 InlineEnvironmentAction)。
 *
 *   - preserve: 原样保留进入 effective env;
 *   - strip: 移除该 assignment(仅在 policy 显式声明移除等价性时);
 *   - ask: 阻塞,等待用户确认;
 *   - deny: 拒绝该 assignment,触发整体 deny。
 */
export type InlineEnvironmentAction = 'preserve' | 'strip' | 'ask' | 'deny';

/** control mode(从 action snapshot 派生)。 */
export type ControlMode = 'plan' | 'build' | 'auto';

/**
 * DRC-5 parser 产出的 inline assignment 语法事实(消费方)。
 *
 * 重要:`value_ref` 是受控引用,不是实际值。日志/diagnostic/SecurityDecision
 * 不默认复制实际 secret/value(spec §10.3 末段)。
 */
export interface InlineAssignmentFact {
  assignment_id: string;
  variable_name: string;
  /** 受控引用(如 'ref:store:...'),不是实际 value。 */
  value_ref: string;
  /** sha256(value)——用于 diff/log,不暴露 value。 */
  value_hash: string;
  /** 形如 'range:start:end',回指原命令文本。 */
  source_range_ref: string;
}

/**
 * 平台相关 inline environment policy(spec §10.2 ExecutableEnvironmentPolicy 子集)。
 *
 * 平台 policy 必须独立版本化(INV-E17)。Windows/Linux/macOS 的 denied 名单
 * 不能跨平台自动套用。扩充任何名单必须 bump policy_version 并经安全评审。
 */
export interface PlatformEnvironmentPolicy {
  policy_id: string;
  policy_version: string;
  platform: PlatformFamily;
  /** 平台特定禁止变量(命中即按 path/loader 分类)。 */
  denied_variables: ReadonlySet<string>;
  /** 显式 safe-passthrough 名单。 */
  safe_passthrough_variables: ReadonlySet<string>;
  /** 显式 controlled-override 名单(需用户确认)。 */
  controlled_override_variables: ReadonlySet<string>;
  /** Plan Mode 下 unknown assignment 的动作(默认 deny)。 */
  plan_mode_unknown_action: InlineEnvironmentAction;
  /** ask channel 不可用时 unknown / controlled 的降级动作(默认 deny)。 */
  ask_unavailable_action: InlineEnvironmentAction;
}

/** 单条 assignment 的分类结果。 */
export interface InlineEnvironmentClassification {
  assignment_id: string;
  variable_name: string;
  risk: InlineAssignmentRisk;
  reason_code: string;
}

/** decideInlineEnvironment 输入。 */
export interface InlineEnvironmentDecisionInput {
  inline_decision_protocol_version: string;
  action_snapshot_id: string;
  platform: PlatformFamily;
  control_mode: ControlMode;
  assignments: ReadonlyArray<InlineAssignmentFact>;
  policy: PlatformEnvironmentPolicy;
  /** ask channel 是否可用——false 时 ask 降级为 deny。 */
  ask_channel_available: boolean;
}

/**
 * 兼容任务规格的输入形状(字段名 decision_protocol_version)。
 *
 * 任务规格的 input 形如 `{ decision_protocol_version, action_snapshot_id, ... }`;
 * 本模块内部接口字段名为 inline_decision_protocol_version(与输出协议字段一致)。
 * 该类型 alias 仅为类型可见性方便;实际接受任意对象,见 decideInlineEnvironment。
 */
export type InlineEnvironmentDecisionInputSpec = Omit<
  InlineEnvironmentDecisionInput,
  'inline_decision_protocol_version'
> & {
  decision_protocol_version: string;
};

/** 单条 assignment 的动作决策。 */
export interface InlineEnvironmentAssignmentAction {
  assignment_id: string;
  action: InlineEnvironmentAction;
  reason_code: string;
}

/** decideInlineEnvironment 输出。 */
export interface InlineEnvironmentDecision {
  inline_decision_protocol_version: string;
  decision_id: string;
  action_snapshot_id: string;
  platform: PlatformFamily;
  control_mode: ControlMode;
  classifications: ReadonlyArray<InlineEnvironmentClassification>;
  actions: ReadonlyArray<InlineEnvironmentAssignmentAction>;
  /** 最严格的 action(deny > ask > strip > preserve)。 */
  aggregated_action: InlineEnvironmentAction;
  reason_codes: string[];
}

// ─────────────────────────────────────────────
// 默认平台 policy(冻结最小集合)
// ─────────────────────────────────────────────

/**
 * 默认平台 policy(spec §10.2 + 计划 Task 11 Step 3 冻结最小集合)。
 *
 * Windows 变量名比较采用 invariant uppercase(Windows 环境变量本身不区分大小写);
 * Linux/macOS 保持 case-sensitive(语义与内核一致)。
 *
 * safe / controlled 默认为空——扩充必须 bump policy_version 并经安全评审。
 * 未列入任何名单 → unknown,在 build+ask 走 ask,在 plan 或 ask-unavailable 走 deny。
 *
 * 注意:本函数不声称变量全集完整(spec §3 明确排除)。
 */
export function getDefaultPlatformEnvironmentPolicy(
  platform: PlatformFamily,
): PlatformEnvironmentPolicy {
  switch (platform) {
    case 'win32':
      return {
        policy_id: 'inline-env-default-windows',
        policy_version: '1',
        platform: 'win32',
        // Windows 环境变量比较是 case-insensitive。为了同时支持精确匹配和
        // case-insensitive 语义,denied 集合只存 uppercase 规范形式;匹配时
        // 把 variable_name 也转 uppercase 比较(见 normalizeWindowsName)。
        denied_variables: new Set<string>([
          'PATH',
          'PATHEXT',
          'COMSPEC',
        ]),
        safe_passthrough_variables: new Set<string>(),
        controlled_override_variables: new Set<string>(),
        plan_mode_unknown_action: 'deny',
        ask_unavailable_action: 'deny',
      };
    case 'linux':
      return {
        policy_id: 'inline-env-default-linux',
        policy_version: '1',
        platform: 'linux',
        // Linux 环境变量 case-sensitive,直接用原字符串精确比较。
        denied_variables: new Set<string>([
          'PATH',
          'LD_PRELOAD',
          'LD_LIBRARY_PATH',
        ]),
        safe_passthrough_variables: new Set<string>(),
        controlled_override_variables: new Set<string>(),
        plan_mode_unknown_action: 'deny',
        ask_unavailable_action: 'deny',
      };
    case 'darwin':
      return {
        policy_id: 'inline-env-default-macos',
        policy_version: '1',
        platform: 'darwin',
        denied_variables: new Set<string>([
          'PATH',
          'DYLD_INSERT_LIBRARIES',
          'DYLD_LIBRARY_PATH',
        ]),
        safe_passthrough_variables: new Set<string>(),
        controlled_override_variables: new Set<string>(),
        plan_mode_unknown_action: 'deny',
        ask_unavailable_action: 'deny',
      };
  }
}

// ─────────────────────────────────────────────
// 平台特定的 denied 名单细分(loader vs path-resolution)
// ─────────────────────────────────────────────

/**
 * Loader-injection 变量集合——命中即归 loader_injection(而非 path_resolution)。
 *
 * 这些变量在原生平台语义下会注入恶意共享库,严重程度高于 PATH 类。
 */
const LOADER_INJECTION_NAMES = new Set<string>([
  'LD_PRELOAD', // linux
  'LD_LIBRARY_PATH', // linux
  'DYLD_INSERT_LIBRARIES', // macos
  'DYLD_LIBRARY_PATH', // macos
]);

/**
 * Path-resolution-affecting 变量集合——影响 executable search / resolution。
 *
 * 注意:本集合只用于在 denied 命中后做细分(PATH/PATHEXT/COMSPEC → path;
 * 其余 loader → loader_injection)。
 */
const PATH_RESOLUTION_NAMES = new Set<string>(['PATH', 'PATHEXT', 'COMSPEC']);

/**
 * Windows invariant uppercase 规范化(Windows 环境变量本身不区分大小写)。
 *
 * 使用 toUpperCase() 后再做 unicode case-fold 比较;对 ASCII 变量名等价于
 * 标准 uppercase。Linux/macOS 不做规范化。
 */
function normalizeForPlatform(
  name: string,
  platform: PlatformFamily,
): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

/**
 * 判断变量名是否命中 policy 的某个集合,遵循平台 case 规则。
 *
 * Windows 把 name 与集合里每个元素都做 uppercase 比较;Linux/macOS 直接
 * Set.has(精确匹配)。
 */
function policySetContains(
  set: ReadonlySet<string>,
  name: string,
  platform: PlatformFamily,
): boolean {
  if (platform === 'win32') {
    // Windows 集合本身存 uppercase;name 也 uppercase 后比较。
    const upper = name.toUpperCase();
    return set.has(upper);
  }
  return set.has(name);
}

// ─────────────────────────────────────────────
// 主入口 1: classifyInlineAssignments
// ─────────────────────────────────────────────

/**
 * 把每条 inline assignment fact 按平台 policy 分类。
 *
 * 分类顺序(spec §10.4 + 计划 Task 11 算法):
 *   1. variable_name 在 denied_variables → 进一步细分:
 *      - 命中 loader 名单 → loader_injection;
 *      - 命中 path 名单 → path_resolution_affecting;
 *      - (denied 但不在两个细分名单 → 保守归 path_resolution_affecting);
 *   2. 在 safe_passthrough_variables → safe_passthrough;
 *   3. 在 controlled_override_variables → controlled_override;
 *   4. 否则 → unknown。
 *
 * 平台比较规则:
 *   - Windows 用 invariant uppercase(Windows 环境变量本身不区分大小写);
 *   - Linux/macOS 保持 case-sensitive。
 *
 * 不变量:本函数不读 process.env / 不执行 / 不复制 value。只看 variable_name。
 */
export function classifyInlineAssignments(
  facts: ReadonlyArray<InlineAssignmentFact>,
  policy: PlatformEnvironmentPolicy,
): InlineEnvironmentClassification[] {
  const platform = policy.platform;
  const out: InlineEnvironmentClassification[] = [];

  for (const f of facts) {
    const { risk, reason_code } = classifyOne(f.variable_name, policy, platform);
    out.push({
      assignment_id: f.assignment_id,
      variable_name: f.variable_name,
      risk,
      reason_code,
    });
  }

  return out;
}

/** 单条分类核心逻辑。 */
function classifyOne(
  variableName: string,
  policy: PlatformEnvironmentPolicy,
  platform: PlatformFamily,
): { risk: InlineAssignmentRisk; reason_code: string } {
  // Step 1: denied 命中?在 platform case 规则下判定。
  if (policySetContains(policy.denied_variables, variableName, platform)) {
    // 细分 loader vs path-resolution。比较时也用平台 case 规则。
    const normalized = normalizeForPlatform(variableName, platform);
    if (
      LOADER_INJECTION_NAMES.has(normalized) ||
      // Windows loader 集合已 uppercase,直接精确比较
      (platform === 'win32' && LOADER_INJECTION_NAMES.has(normalized.toUpperCase()))
    ) {
      return {
        risk: 'loader_injection',
        reason_code: 'denied:loader_injection',
      };
    }
    if (PATH_RESOLUTION_NAMES.has(normalized)) {
      return {
        risk: 'path_resolution_affecting',
        reason_code: 'denied:path_resolution_affecting',
      };
    }
    // denied 但不属于已知两个细分——保守归 path_resolution_affecting。
    return {
      risk: 'path_resolution_affecting',
      reason_code: 'denied:unspecified',
    };
  }

  // Step 2: safe passthrough?
  if (policySetContains(policy.safe_passthrough_variables, variableName, platform)) {
    return {
      risk: 'safe_passthrough',
      reason_code: 'policy:safe_passthrough',
    };
  }

  // Step 3: controlled override?
  if (
    policySetContains(
      policy.controlled_override_variables,
      variableName,
      platform,
    )
  ) {
    return {
      risk: 'controlled_override',
      reason_code: 'policy:controlled_override',
    };
  }

  // Step 4: unknown
  return {
    risk: 'unknown',
    reason_code: 'policy:no_match',
  };
}

// ─────────────────────────────────────────────
// 主入口 2: decideInlineEnvironment
// ─────────────────────────────────────────────

/**
 * 计算整组 inline assignment 的结构化决策。
 *
 * 流程(spec §10.4):
 *   1. classify 所有 assignments;
 *   2. 逐 assignment 根据 risk + control_mode + ask_channel 决定 action:
 *      - safe_passthrough → preserve;
 *      - controlled_override → ask(ask 不可用 → deny);
 *      - path_resolution_affecting → deny(本 Wave 默认);
 *      - loader_injection → ask 或 deny(Plan/ask-unavailable → deny);
 *      - unknown → ask / deny(Plan → deny;ask-unavailable → deny;
 *        build+ask → ask);
 *   3. aggregated_action = 最严格(deny > ask > strip > preserve);
 *   4. reason_codes 收集关键决策理由(供 audit);
 *   5. decision_id = `inline-env:${sha256(canonical).slice(0, 16)}`;
 *   6. freeze 返回。
 *
 * 注意:
 *   - strip 只在精确 policy 声明"移除后仍是受限等价动作"时允许;本 Wave
 *     safe/controlled 集合为空,strip 不会出现。
 *   - 本函数不直接读 inherited environment snapshot;调用方必须保证
 *     assignments 已建立在 M-063 scrubbed snapshot 之上(INV-E14)。
 */
export function decideInlineEnvironment(
  input: InlineEnvironmentDecisionInput | InlineEnvironmentDecisionInputSpec,
): InlineEnvironmentDecision {
  // ── identity 守门 ──
  const actionSnapshotId = requireIdentity(
    input.action_snapshot_id,
    'action_snapshot_id',
  );
  // 接受两种协议版本字段名(内部 inline_* 与 spec 的 decision_protocol_version)。
  const protocolVersion = requireIdentity(
    'inline_decision_protocol_version' in input
      ? input.inline_decision_protocol_version
      : input.decision_protocol_version,
    'inline_decision_protocol_version',
  );

  const platform = input.policy.platform;
  const controlMode = input.control_mode;
  const askAvailable = input.ask_channel_available;

  // ── Step 1: classify ──
  const classifications = classifyInlineAssignments(
    input.assignments,
    input.policy,
  );

  // ── Step 2: 逐 assignment 决定 action ──
  const actions: InlineEnvironmentAssignmentAction[] = [];
  const reasonCodes: string[] = [];

  for (const c of classifications) {
    const { action, reason_code } = decideAssignmentAction(
      c.risk,
      controlMode,
      askAvailable,
      input.policy,
    );
    actions.push({
      assignment_id: c.assignment_id,
      action,
      reason_code,
    });
  }

  // ── Step 3: aggregated_action ──
  const aggregatedAction = aggregateActions(actions.map((a) => a.action));

  // ── Step 4: 汇总 reason_codes(control_mode / ask_unavailable 等全局信号)──
  if (controlMode === 'plan') {
    reasonCodes.push('control_mode:plan');
  }
  if (!askAvailable) {
    reasonCodes.push('ask_unavailable');
  }
  // 把每个 unique classification reason_code 也收进来,便于 audit。
  for (const c of classifications) {
    if (!reasonCodes.includes(c.reason_code)) {
      reasonCodes.push(c.reason_code);
    }
  }
  // 全局未知分流信号(便于 assertion / 审计)
  const hasUnknownInPlan =
    controlMode === 'plan' && classifications.some((c) => c.risk === 'unknown');
  if (hasUnknownInPlan && !reasonCodes.includes('unknown_in_plan_mode')) {
    reasonCodes.push('unknown_in_plan_mode');
  }

  // ── Step 5: decision_id(canonical hash)──
  const canonical = buildCanonical({
    protocolVersion,
    actionSnapshotId,
    platform,
    controlMode,
    classifications,
    actions,
    policy: input.policy,
    askAvailable,
  });
  const decisionId = `inline-env:${sha256Hex(canonical).slice(0, 16)}`;

  // ── Step 6: freeze 返回 ──
  const result: InlineEnvironmentDecision = {
    inline_decision_protocol_version: protocolVersion,
    decision_id: decisionId,
    action_snapshot_id: actionSnapshotId,
    platform,
    control_mode: controlMode,
    classifications,
    actions,
    aggregated_action: aggregatedAction,
    reason_codes: reasonCodes,
  };
  return freezeSnapshot(result) as InlineEnvironmentDecision;
}

/**
 * 单条 assignment 的 action 决策(spec §10.4 + §10.11 错误语义)。
 *
 * 规则:
 *   - safe_passthrough → preserve(恒定);
 *   - controlled_override → ask;ask 不可用 → policy.ask_unavailable_action(默认 deny);
 *   - path_resolution_affecting → deny(本 Wave 默认);
 *   - loader_injection:
 *       - Plan Mode → deny;
 *       - ask 不可用 → deny;
 *       - build/auto + ask → ask;
 *   - unknown:
 *       - Plan Mode → policy.plan_mode_unknown_action(默认 deny);
 *       - ask 不可用 → policy.ask_unavailable_action(默认 deny);
 *       - build/auto + ask → ask。
 */
function decideAssignmentAction(
  risk: InlineAssignmentRisk,
  controlMode: ControlMode,
  askAvailable: boolean,
  policy: PlatformEnvironmentPolicy,
): { action: InlineEnvironmentAction; reason_code: string } {
  switch (risk) {
    case 'safe_passthrough':
      return { action: 'preserve', reason_code: 'action:preserve_safe' };

    case 'controlled_override': {
      if (!askAvailable) {
        return {
          action: policy.ask_unavailable_action,
          reason_code: 'action:controlled_ask_unavailable',
        };
      }
      return { action: 'ask', reason_code: 'action:controlled_ask' };
    }

    case 'path_resolution_affecting':
      // 本 Wave 默认 deny;精确 policy 可在未来声明 strip 等价性后放宽。
      return { action: 'deny', reason_code: 'action:deny_path_resolution' };

    case 'loader_injection': {
      // spec §10.4 rule 4 + 计划算法:loader injection 恒定 deny。
      // 这同时满足 "Plan Mode 或 ask 不可用时 deny" 与 "build/auto 也 deny"
      // 的更保守读法——loader injection 风险过高,不进入 ask 通道。
      // (Plan/ask-unavailable 仍是 deny,无需特殊分支。)
      return { action: 'deny', reason_code: 'action:deny_loader_injection' };
    }

    case 'unknown': {
      if (controlMode === 'plan') {
        return {
          action: policy.plan_mode_unknown_action,
          reason_code: 'action:unknown_plan',
        };
      }
      if (!askAvailable) {
        return {
          action: policy.ask_unavailable_action,
          reason_code: 'action:unknown_ask_unavailable',
        };
      }
      // build/auto + ask → ask(spec §10.4 rule 5: unknown 不默认 preserve)
      return { action: 'ask', reason_code: 'action:unknown_ask' };
    }
  }
}

/**
 * 聚合多条 action 为单条最严格 action。
 *
 * 严格度排序:deny(4) > ask(3) > strip(2) > preserve(1)。
 * 空数组(无 assignment)→ preserve(spec §10.4 无否定语义时默认 preserve)。
 */
function aggregateActions(
  actions: ReadonlyArray<InlineEnvironmentAction>,
): InlineEnvironmentAction {
  if (actions.length === 0) {
    return 'preserve';
  }
  const rank: Record<InlineEnvironmentAction, number> = {
    preserve: 1,
    strip: 2,
    ask: 3,
    deny: 4,
  };
  let maxRank = 0;
  let maxAction: InlineEnvironmentAction = 'preserve';
  for (const a of actions) {
    const r = rank[a];
    if (r > maxRank) {
      maxRank = r;
      maxAction = a;
    }
  }
  return maxAction;
}

// ─────────────────────────────────────────────
// canonical / hash 工具
// ─────────────────────────────────────────────

/**
 * canonical 串——包含全部影响 decision 身份的字段,保证相同输入 → 相同 decision_id。
 *
 * 故意不包含 reason_codes——reason 是派生产物,不应让 reason 表述的细微差异
 * 改变 decision 的身份。也不包含 value_ref/value_hash 之外的实际值。
 */
function buildCanonical(args: {
  protocolVersion: string;
  actionSnapshotId: string;
  platform: PlatformFamily;
  controlMode: ControlMode;
  classifications: ReadonlyArray<InlineEnvironmentClassification>;
  actions: ReadonlyArray<InlineEnvironmentAssignmentAction>;
  policy: PlatformEnvironmentPolicy;
  askAvailable: boolean;
}): string {
  const classificationsStr = args.classifications
    .map((c) => `${c.assignment_id}:${c.variable_name}:${c.risk}`)
    .join(',');
  const actionsStr = args.actions
    .map((a) => `${a.assignment_id}:${a.action}`)
    .join(',');
  // policy 用身份 + 平台 + 名单内容做指纹(名单变化 → 新 decision)。
  const denied = setFingerprint(args.policy.denied_variables, args.platform);
  const safe = setFingerprint(args.policy.safe_passthrough_variables, args.platform);
  const controlled = setFingerprint(
    args.policy.controlled_override_variables,
    args.platform,
  );
  return [
    args.protocolVersion,
    args.actionSnapshotId,
    args.platform,
    args.controlMode,
    args.askAvailable ? 'ask:1' : 'ask:0',
    args.policy.policy_id,
    args.policy.policy_version,
    denied,
    safe,
    controlled,
    args.policy.plan_mode_unknown_action,
    args.policy.ask_unavailable_action,
    classificationsStr,
    actionsStr,
  ].join('|');
}

/**
 * 把 ReadonlySet 序列化为平台感知的稳定指纹串。
 *
 * Windows 名单元素存 uppercase,所以这里也规范化以保证确定性;
 * Linux/macOS 原样排序。
 */
function setFingerprint(
  set: ReadonlySet<string>,
  platform: PlatformFamily,
): string {
  const arr: string[] = [];
  for (const v of set) arr.push(normalizeForPlatform(v, platform));
  arr.sort();
  return arr.join(';');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ════════════════════════════════════════════════════════════════════════════
// ERC-4 / M-065 Executable Resolution
// ════════════════════════════════════════════════════════════════════════════
//
// 物理本质:把 ExecutableCandidate 解析为可验证的 file identity(或 fail-closed
// 状态)。它消费 inline decision(M-064)+ scrubbed effective env(M-063),
// 作为 spawn 前的多重 AND 防线之一(spec §10.6 + §10.9 + ERC-4)。
//
// 关键不变量(ERC-4 + 计划 Task 12):
//   1. resolved 只产生 identity,不产生 trusted / allow;
//   2. 不 spawn binary——Resolver 永不调用 adapter.spawn(类型上不暴露该方法);
//   3. inline_decision aggregated_action === 'deny' → 立即 denied(AND 防线);
//   4. PATH search 只用 effective_environment.env(已 scrubbed + inline decided);
//   5. multiple candidate → ambiguous;zero → not_found;不近似前缀匹配;
//   6. Windows ADS / 8.3 / long-path 能力不足 → unsupported,不宣称覆盖 M-068;
//   7. content_or_metadata_hash 是 file identity canonical 的 SHA-256;
//   8. resolution_id 由 canonical 字段确定性派生。

/** Wave E 首个 executable resolution 协议版本(硬编码 'erc-4-exec-res-v1')。 */
export const EXECUTABLE_RESOLUTION_PROTOCOL_VERSION = 'erc-4-exec-res-v1';

/** 用户给出的可执行候选(来自 DRC-5 解析)。 */
export interface ExecutableCandidate {
  candidate_id: string;
  /** 用户输入的名字(可能是 'npm' 或 '/usr/bin/npm' 或 './bin/foo')。 */
  raw_name: string;
  /** 名字后的参数(只作 provenance,不参与 resolution)。 */
  argv_after_name: string[];
}

/** M-063 scrubbed + M-065 inline decided 后的 effective environment。 */
export interface EffectiveEnvironment {
  env: Readonly<Record<string, string>>;
  platform: PlatformFamily;
  /** working-directory snapshot,relative path 绑定此值。 */
  working_directory: string;
}

/** resolveExecutableIdentity 输入。 */
export interface ExecutableResolutionInput {
  resolution_protocol_version: string;
  action_snapshot_id: string;
  candidate: ExecutableCandidate;
  effective_environment: EffectiveEnvironment;
  /** inline decision —— 确保 PATH / loader 未被 deny。 */
  inline_decision: InlineEnvironmentDecision;
}

export type ExecutableResolutionStatus =
  | 'resolved'
  | 'not_found'
  | 'ambiguous'
  | 'unsupported'
  | 'denied';

/** 平台无关的 file identity(canonical 形式)。 */
export interface ExecutableFileIdentity {
  canonical_path: string;
  platform: PlatformFamily;
  /** Unix st_dev(Windows 为 null)。 */
  dev: string | null;
  /** Unix st_ino(Windows 为 null)。 */
  ino: string | null;
  size: number;
  /** ISO-8601 串。 */
  mtime: string;
  mode: number;
  is_symlink: boolean;
  /** symlink / reparse point 目标(非 symlink 为 null)。 */
  symlink_target: string | null;
}

/** resolveExecutableIdentity 输出。 */
export interface ExecutableResolutionResult {
  resolution_protocol_version: string;
  resolution_id: string;
  action_snapshot_id: string;
  status: ExecutableResolutionStatus;
  resolved_canonical_path: string | null;
  file_identity_ref: string | null;
  /** sha256(canonical identity JSON)。 */
  content_or_metadata_hash: string | null;
  candidate_provenance: {
    raw_name: string;
    resolution_method: 'direct_path' | 'path_search' | null;
  };
  reason_codes: string[];
}

/**
 * 平台解析 adapter 接口(注入,便于测试 mock)。
 *
 * **重要**:该接口故意**不**暴露 spawn 方法——Resolver 不 spawn binary,
 * 即便调用方实现里挂了 spawn,类型也不让它通过编译。
 */
export interface PlatformResolutionAdapter {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{
    dev?: number;
    ino?: number;
    size: number;
    mtime: Date;
    mode: number;
    isSymbolicLink: boolean;
  }>;
  /** 是否可执行(X_OK)。 */
  access(p: string): Promise<boolean>;
  /**
   * PATH search —— 只返回候选路径列表,不 spawn。
   *
   * env 是 effective_environment.env(已 scrubbed + inline decided);
   * adapter 负责用其中 PATH / Path / PATHEXT 做搜索。
   */
  searchPath(
    name: string,
    env: Record<string, string>,
    platform: PlatformFamily,
  ): Promise<string[]>;
  /**
   * 返回该平台当前能力不足的 reason_code,或 null 表示能力充足。
   *
   * 例如 Windows ADS / 8.3 / long-path 能力无法验证时返回
   * 'windows:ads_8.3_long_path_capability_missing'。
   * 调用方据此返回 unsupported(不宣称覆盖 M-068)。
   */
  getUnsupportedReason(platform: PlatformFamily): string | null;
}

// ─────────────────────────────────────────────
// 路径分隔符判定
// ─────────────────────────────────────────────

/** raw_name 含路径分隔符 → direct path;否则 → PATH search。 */
function isDirectPath(rawName: string): boolean {
  return rawName.includes('/') || rawName.includes('\\');
}

/** 检测 ENOENT / not-found 类错误(以 fs.stat / realpath 抛错形式)。 */
function isNotFoundErr(e: unknown): boolean {
  if (e !== null && typeof e === 'object' && 'code' in e) {
    const code = (e as { code?: string }).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
  return false;
}

// ─────────────────────────────────────────────
// 主入口 3: resolveExecutableIdentity
// ─────────────────────────────────────────────

/**
 * 把 ExecutableCandidate 解析为可验证 file identity,或返回 fail-closed 状态。
 *
 * 算法(ERC-4 + 计划 Task 12 Step 1~6):
 *   1. capability gate:adapter.getUnsupportedReason → unsupported(不覆盖 M-068);
 *   2. inline_decision.aggregated_action === 'deny' → denied(AND 防线);
 *   3. direct path(raw_name 含分隔符)→ working_directory 绑定 + realpath + stat;
 *      否则 PATH search,返回候选列表:
 *        - 多候选 → ambiguous;
 *        - 零候选 → not_found;
 *        - 单候选 → 走 realpath + stat;
 *   4. realpath / stat 失败(ENOENT)→ not_found;
 *   5. access(X_OK)=false → denied(not_executable);
 *   6. 组装 ExecutableFileIdentity → content_or_metadata_hash=sha256(canonical);
 *   7. resolution_id = `exec-res:${sha256(canonical).slice(0, 16)}`;
 *   8. freeze 返回。
 *
 * **永不 spawn binary**:函数不调用任何 spawn / exec 类方法。
 */
export async function resolveExecutableIdentity(
  input: ExecutableResolutionInput,
  adapter: PlatformResolutionAdapter,
): Promise<ExecutableResolutionResult> {
  // ── identity 守门 ──
  const actionSnapshotId = requireIdentity(
    input.action_snapshot_id,
    'action_snapshot_id',
  );
  const protocolVersion = requireIdentity(
    input.resolution_protocol_version,
    'resolution_protocol_version',
  );
  requireIdentity(input.candidate.raw_name, 'candidate.raw_name');

  const platform = input.effective_environment.platform;
  const rawName = input.candidate.raw_name;
  const env = input.effective_environment.env;
  const workingDirectory = input.effective_environment.working_directory;

  // ── Step 1: capability gate(Windows ADS / 8.3 / long-path 等能力不足)──
  const unsupportedReason = adapter.getUnsupportedReason(platform);
  if (unsupportedReason !== null) {
    return freezeResult({
      resolution_protocol_version: protocolVersion,
      resolution_id: buildResolutionId({
        protocolVersion,
        actionSnapshotId,
        rawName,
        platform,
        status: 'unsupported',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'unsupported',
      resolved_canonical_path: null,
      file_identity_ref: null,
      content_or_metadata_hash: null,
      candidate_provenance: { raw_name: rawName, resolution_method: null },
      reason_codes: ['executable.platform_unsupported', unsupportedReason],
    });
  }

  // ── Step 2: inline_decision deny 短路(spec §10.9 AND 防线)──
  if (input.inline_decision.aggregated_action === 'deny') {
    return freezeResult({
      resolution_protocol_version: protocolVersion,
      resolution_id: buildResolutionId({
        protocolVersion,
        actionSnapshotId,
        rawName,
        platform,
        status: 'denied',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'denied',
      resolved_canonical_path: null,
      file_identity_ref: null,
      content_or_metadata_hash: null,
      candidate_provenance: { raw_name: rawName, resolution_method: null },
      reason_codes: ['executable.inline_denied'],
    });
  }

  // ── Step 3: direct path vs PATH search ──
  let resolutionMethod: 'direct_path' | 'path_search';
  let candidatePath: string;
  if (isDirectPath(rawName)) {
    resolutionMethod = 'direct_path';
    // relative path 绑定 working_directory snapshot(POSIX 风格拼接;
    // adapter.realpath 负责最终规范化,包括 Windows 反斜杠场景)。
    candidatePath =
      rawName.startsWith('/') || rawName.match(/^[A-Za-z]:[\\/]/)
        ? rawName
        : `${workingDirectory.replace(/\/+$/, '')}/${rawName}`;
  } else {
    resolutionMethod = 'path_search';
    const candidates = await adapter.searchPath(rawName, env as Record<string, string>, platform);
    if (candidates.length === 0) {
      return freezeResult({
        resolution_protocol_version: protocolVersion,
        resolution_id: buildResolutionId({
          protocolVersion,
          actionSnapshotId,
          rawName,
          platform,
          status: 'not_found',
        }),
        action_snapshot_id: actionSnapshotId,
        status: 'not_found',
        resolved_canonical_path: null,
        file_identity_ref: null,
        content_or_metadata_hash: null,
        candidate_provenance: { raw_name: rawName, resolution_method: null },
        reason_codes: ['executable.not_found', 'executable.path_search_empty'],
      });
    }
    if (candidates.length > 1) {
      return freezeResult({
        resolution_protocol_version: protocolVersion,
        resolution_id: buildResolutionId({
          protocolVersion,
          actionSnapshotId,
          rawName,
          platform,
          status: 'ambiguous',
        }),
        action_snapshot_id: actionSnapshotId,
        status: 'ambiguous',
        resolved_canonical_path: null,
        file_identity_ref: null,
        content_or_metadata_hash: null,
        candidate_provenance: { raw_name: rawName, resolution_method: 'path_search' },
        reason_codes: ['executable.ambiguous', `executable.candidate_count:${candidates.length}`],
      });
    }
    candidatePath = candidates[0];
  }

  // ── Step 4: realpath + stat(失败 → not_found)──
  let canonicalPath: string;
  try {
    canonicalPath = await adapter.realpath(candidatePath);
  } catch (e) {
    if (isNotFoundErr(e)) {
      return notFoundResult(protocolVersion, actionSnapshotId, rawName, platform, resolutionMethod);
    }
    throw e;
  }

  let statInfo: {
    dev?: number;
    ino?: number;
    size: number;
    mtime: Date;
    mode: number;
    isSymbolicLink: boolean;
  };
  try {
    statInfo = await adapter.stat(candidatePath);
  } catch (e) {
    if (isNotFoundErr(e)) {
      return notFoundResult(protocolVersion, actionSnapshotId, rawName, platform, resolutionMethod);
    }
    throw e;
  }

  // ── Step 5: access(X_OK)──
  const executable = await adapter.access(candidatePath);
  if (!executable) {
    return freezeResult({
      resolution_protocol_version: protocolVersion,
      resolution_id: buildResolutionId({
        protocolVersion,
        actionSnapshotId,
        rawName,
        platform,
        status: 'denied',
        canonicalPath,
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'denied',
      resolved_canonical_path: canonicalPath,
      file_identity_ref: null,
      content_or_metadata_hash: null,
      candidate_provenance: { raw_name: rawName, resolution_method: resolutionMethod },
      reason_codes: ['executable.not_executable'],
    });
  }

  // ── Step 6: 组装 file identity + hash ──
  const identity: ExecutableFileIdentity = {
    canonical_path: canonicalPath,
    platform,
    // Unix 字段在 Windows 为 null(不强行构造 dev/ino)。
    dev: platform === 'win32' ? null : String(statInfo.dev ?? ''),
    ino: platform === 'win32' ? null : String(statInfo.ino ?? ''),
    size: statInfo.size,
    mtime: statInfo.mtime.toISOString(),
    mode: statInfo.mode,
    is_symlink: statInfo.isSymbolicLink,
    symlink_target: statInfo.isSymbolicLink ? canonicalPath : null,
  };

  // canonical identity 串:JSON 字段顺序固定(对象字面量按声明顺序)。
  const identityCanonical = JSON.stringify(identity);
  const contentHash = sha256Hex(identityCanonical);

  const result: ExecutableResolutionResult = {
    resolution_protocol_version: protocolVersion,
    resolution_id: buildResolutionId({
      protocolVersion,
      actionSnapshotId,
      rawName,
      platform,
      status: 'resolved',
      canonicalPath,
      contentHash,
    }),
    action_snapshot_id: actionSnapshotId,
    status: 'resolved',
    resolved_canonical_path: canonicalPath,
    file_identity_ref: `exec-identity:${contentHash.slice(0, 16)}`,
    content_or_metadata_hash: contentHash,
    candidate_provenance: { raw_name: rawName, resolution_method: resolutionMethod },
    reason_codes: [
      resolutionMethod === 'direct_path'
        ? 'executable.direct_path'
        : 'executable.path_search',
      'executable.resolved',
    ],
  };
  return freezeResult(result);
}

/** not_found 共用出口。 */
function notFoundResult(
  protocolVersion: string,
  actionSnapshotId: string,
  rawName: string,
  platform: PlatformFamily,
  resolutionMethod: 'direct_path' | 'path_search',
): ExecutableResolutionResult {
  return freezeResult({
    resolution_protocol_version: protocolVersion,
    resolution_id: buildResolutionId({
      protocolVersion,
      actionSnapshotId,
      rawName,
      platform,
      status: 'not_found',
    }),
    action_snapshot_id: actionSnapshotId,
    status: 'not_found',
    resolved_canonical_path: null,
    file_identity_ref: null,
    content_or_metadata_hash: null,
    candidate_provenance: { raw_name: rawName, resolution_method: resolutionMethod },
    reason_codes: ['executable.not_found'],
  });
}

/**
 * resolution_id 的 canonical 输入:包含全部影响"这次解析身份"的字段。
 *
 * 故意不含 reason_codes(派生产物)。canonicalPath 与 contentHash 仅在
 * resolved 状态有意义——非 resolved 不传入,保持 not_found/ambiguous/denied/
 * unsupported 在相同 raw_name + platform + snapshot 下产生相同 id(便于
 * 测试 / 审计关联)。
 */
function buildResolutionId(args: {
  protocolVersion: string;
  actionSnapshotId: string;
  rawName: string;
  platform: PlatformFamily;
  status: ExecutableResolutionStatus;
  canonicalPath?: string;
  contentHash?: string;
}): string {
  const parts = [
    args.protocolVersion,
    args.actionSnapshotId,
    args.rawName,
    args.platform,
    args.status,
    args.canonicalPath ?? '',
    args.contentHash ?? '',
  ];
  return `exec-res:${sha256Hex(parts.join('|')).slice(0, 16)}`;
}

/** 冻结并返回 result(freezeSnapshot 已经幂等)。 */
function freezeResult(
  result: ExecutableResolutionResult,
): ExecutableResolutionResult {
  return freezeSnapshot(result) as ExecutableResolutionResult;
}

// ═══════════════════════════════════════════════════════════════════════════
// ERC-4 / M-065 Sanitized Execution Plan
// ═══════════════════════════════════════════════════════════════════════════
//
// 物理本质:把五门 gate(inherited env、structural policy、inline environment、
// executable resolution、RC-5 permission)与 parse result(复杂 shell structure
// 探测)用硬 AND 组合,产出一份"已净化的执行计划"。计划只声明 spawn 之前的
// 安全准备状态,绝不授予 spawn 权限、绝不恢复 stripped env、绝不让 resolved
// 等同于 allowed。
//
// 关键不变量(spec §10.9 + ERC-4 + 计划 Task 13 Global Constraints):
//   1. plan 没有 spawn 方法——它只承载身份绑定与状态,无执行能力;
//   2. 没有恢复 stripped env——stripped_assignment_ids 是结构化 diff,不复活;
//   3. resolved 不等于 allowed——ready_for_permission 仍需 RC-5 显式 allow;
//   4. ready_for_permission 不等于 permission allow——只是"可以走 permission gate";
//   5. 复杂 shell structure(pipeline / redirect / substitution / control_flow)
//      → invalid,绝不回退 shell:true;
//   6. plan 是 frozen 的、plan_id 由 canonical 字段确定性派生。
//
// 本模块不调用 child_process / fs / env lookup;不执行命令;不授予执行权限。

/** Wave E 首个 sanitized execution plan 协议版本(硬编码 '1')。 */
export const SANITIZED_PLAN_PROTOCOL_VERSION = '1';

/** SanitizedExecutionPlan 的四种状态。 */
export type SanitizedExecutionPlanStatus =
  | 'ready_for_permission'
  | 'ask_required'
  | 'denied'
  | 'invalid';

/**
 * buildSanitizedExecutionPlan 输入(规格 ERC-4 + 计划 Task 13)。
 *
 * 五门 gate 的有效位 + 上游 decision/resolution 实体 + parse result 摘要。
 * 注意:input 只接受身份引用与决策结果——不接受环境变量实际值,也不接受
 * 命令文本(只看 parse 摘要的 status 与 risk fact kinds)。
 */
export interface SanitizedExecutionPlanInput {
  plan_protocol_version: string;
  action_snapshot_id: string;
  // 五门 gate
  /** M-063 scrubbed inherited snapshot 引用。 */
  inherited_environment_ref: string;
  inherited_environment_valid: boolean;
  /** DRC-5 structural decision(M-064)。 */
  structural_decision: CommandStructuralDecision;
  structural_decision_valid: boolean;
  /** E-1 T11 inline environment decision。 */
  inline_decision: InlineEnvironmentDecision;
  inline_decision_valid: boolean;
  /** E-2 T12 executable resolution。 */
  executable_resolution: ExecutableResolutionResult;
  executable_resolution_valid: boolean;
  /** RC-5 SecurityDecision 引用(形如 'rc5:snap-1:allow' / 'rc5:snap-1:ask')。 */
  required_security_decision_ref: string;
  permission_valid: boolean;
  // parse result 摘要——用于探测复杂 shell structure
  /** CommandParseStatus('parsed' / 'invalid_syntax' / 'unsupported_syntax' / 'too_complex')。 */
  parse_result_status: string;
  /** parse result 的 risk fact kinds(用于检测 pipeline/redirect/...)。 */
  parse_result_risk_facts_kinds: string[];
  /**
   * 首个 executable 的 literal argv(已不含可执行名本身)。
   *
   * 这是计划外显的输入字段——`ExecutableResolutionResult` 内部不复制 argv,
   * 调用方(DRC-5 parser 消费侧)需在输入时显式提供。仅在 parse 是单一
   * executable + literal argv 且无复杂 shell structure 时,该值会写入
   * plan.literal_argv;其余情况 plan.literal_argv 恒为 null。
   */
  literal_argv_after_name?: string[] | null;
}

/** SanitizedExecutionPlan 输出。 */
export interface SanitizedExecutionPlan {
  plan_protocol_version: string;
  /** 形如 'plan:<sha256-prefix-16>'。 */
  plan_id: string;
  action_snapshot_id: string;
  status: SanitizedExecutionPlanStatus;
  // 绑定的 identity
  inherited_environment_ref: string;
  structural_decision_id: string;
  inline_decision_id: string;
  executable_resolution_id: string;
  required_security_decision_ref: string;
  // 结构化 diff(preserved/stripped assignment IDs)
  preserved_assignment_ids: string[];
  stripped_assignment_ids: string[];
  // resolved executable
  resolved_canonical_path: string | null;
  /**
   * effective environment 引用——指向 inherited scrubbed snapshot(inline
   * decision 应用于其上的结果)。不复活 stripped env,只是引用同一 snapshot。
   */
  effective_environment_ref: string;
  // argv(限定首个 executable path;复杂 shell structure 下为 null)
  literal_argv: string[] | null;
  reason_codes: string[];
}

/** parse_result risk fact kinds 中视为"复杂 shell structure"的集合。 */
const COMPLEX_SHELL_FACT_KINDS = new Set<string>([
  'pipeline',
  'redirect',
  'substitution',
  'control_flow',
]);

/**
 * 构造 SanitizedExecutionPlan(规格 ERC-4 + 计划 Task 13)。
 *
 * 算法:
 *   1. identity 守门:plan_protocol_version / action_snapshot_id /
 *      inherited_environment_ref / required_security_decision_ref 非空;
 *   2. 计算结构化 diff(preserved/stripped assignment IDs);
 *   3. 计算 status(优先级:invalid > denied > ask_required > ready):
 *      - 任一 gate invalid(inherited/structural/inline/exec/permission)→ invalid;
 *      - structural candidate_behavior === 'deny' → denied;
 *      - inline aggregated_action === 'deny' → denied;
 *      - executable_resolution.status === 'denied' → denied;
 *      - inline aggregated_action === 'ask' → ask_required;
 *      - permission ref 后缀为 ':ask' → ask_required;
 *      - parse 不是 'parsed' → invalid(复杂 shell structure 不支持);
 *      - parse 含 pipeline/redirect/substitution/control_flow → invalid;
 *      - 其余 → ready_for_permission;
 *   4. literal_argv 仅在 status==='ready_for_permission' 时取 input.literal_argv_after_name;
 *   5. effective_environment_ref = inherited_environment_ref(不复活 stripped);
 *   6. plan_id = `plan:${sha256(canonical).slice(0, 16)}`;
 *   7. freeze 返回。
 *
 * **永不 spawn**:本函数不调用任何 spawn / exec 类方法。返回的 plan 也没有
 * spawn 方法——它只是身份绑定与状态聚合。
 */
export function buildSanitizedExecutionPlan(
  input: SanitizedExecutionPlanInput,
): SanitizedExecutionPlan {
  // ── Step 1: identity 守门 ──
  const protocolVersion = requireIdentity(
    input.plan_protocol_version,
    'plan_protocol_version',
  );
  const actionSnapshotId = requireIdentity(
    input.action_snapshot_id,
    'action_snapshot_id',
  );
  const inheritedEnvRef = requireIdentity(
    input.inherited_environment_ref,
    'inherited_environment_ref',
  );
  const requiredSecRef = requireIdentity(
    input.required_security_decision_ref,
    'required_security_decision_ref',
  );

  // ── Step 2: 结构化 diff(preserved/stripped assignment IDs)──
  // 从 inline_decision.actions 派生:preserve → preserved;strip → stripped;
  // ask/deny 不入任一(它们已是阻塞状态,不需要 diff 展现)。
  const preserved: string[] = [];
  const stripped: string[] = [];
  for (const a of input.inline_decision.actions) {
    if (a.action === 'preserve') {
      preserved.push(a.assignment_id);
    } else if (a.action === 'strip') {
      stripped.push(a.assignment_id);
    }
  }

  // ── Step 3: status 计算(优先级 invalid > denied > ask_required > ready)──
  const { status, statusReasons } = computeStatus(input);

  // ── Step 4: literal_argv ──
  // 仅 ready_for_permission 状态下输出 argv;其它状态下恒为 null。
  const literalArgv: string[] | null =
    status === 'ready_for_permission' && input.literal_argv_after_name
      ? [...input.literal_argv_after_name]
      : null;

  // ── Step 5: reason_codes ──
  const reasonCodes: string[] = [...statusReasons];
  if (preserved.length > 0) {
    reasonCodes.push(`inline.preserved:${preserved.length}`);
  }
  if (stripped.length > 0) {
    reasonCodes.push(`inline.stripped:${stripped.length}`);
  }

  // ── Step 6: plan_id(canonical hash)──
  const canonical = buildPlanCanonical({
    protocolVersion,
    actionSnapshotId,
    inheritedEnvRef,
    structuralDecisionId: input.structural_decision.structural_decision_id,
    inlineDecisionId: input.inline_decision.decision_id,
    executableResolutionId: input.executable_resolution.resolution_id,
    requiredSecRef,
    status,
    preserved,
    stripped,
    resolvedCanonicalPath: input.executable_resolution.resolved_canonical_path,
    literalArgv,
    parseResultStatus: input.parse_result_status,
    parseResultRiskFactsKinds: input.parse_result_risk_facts_kinds,
  });
  const planId = `plan:${sha256Hex(canonical).slice(0, 16)}`;

  // ── Step 7: 组装 + freeze ──
  const result: SanitizedExecutionPlan = {
    plan_protocol_version: protocolVersion,
    plan_id: planId,
    action_snapshot_id: actionSnapshotId,
    status,
    inherited_environment_ref: inheritedEnvRef,
    structural_decision_id: input.structural_decision.structural_decision_id,
    inline_decision_id: input.inline_decision.decision_id,
    executable_resolution_id: input.executable_resolution.resolution_id,
    required_security_decision_ref: requiredSecRef,
    preserved_assignment_ids: preserved,
    stripped_assignment_ids: stripped,
    resolved_canonical_path: input.executable_resolution.resolved_canonical_path,
    // effective env 引用 inherited scrubbed snapshot(不复活 stripped)。
    effective_environment_ref: inheritedEnvRef,
    literal_argv: literalArgv,
    reason_codes: reasonCodes,
  };
  return freezeSnapshot(result) as SanitizedExecutionPlan;
}

/**
 * 计算 plan status 与对应 reason_codes。
 *
 * 优先级(从高到低):
 *   1. 任一 gate invalid → invalid;
 *   2. structural deny / inline deny / exec resolution denied → denied;
 *   3. inline ask / permission ask → ask_required;
 *   4. parse 不是 'parsed' → invalid(复杂 shell structure 不支持,不回退 shell:true);
 *   5. parse 含 pipeline/redirect/substitution/control_flow → invalid;
 *   6. 其余 → ready_for_permission。
 *
 * 注意:permission gate invalid 走 1(invalid),permission ask 走 3(ask_required)。
 * required_security_decision_ref 后缀判定 ask 形式:
 *   - 形如 'rc5:snap-1:ask' 视为 ask;
 *   - 形如 'rc5:snap-1:allow' 视为 allow(不短路);
 *   - 形如 'rc5:snap-1:deny' 会让 status 走 ready→invalid?不——
 *     permission deny 通过 required_security_decision_ref 的后缀判定为 deny 时,
 *     不在该层短路(那是 RC-5 的职责);本函数只标记 ask_required。
 *     deny 由调用方在 permission gate 验证阶段判定;permission_valid=false 走 invalid。
 */
function computeStatus(input: SanitizedExecutionPlanInput): {
  status: SanitizedExecutionPlanStatus;
  statusReasons: string[];
} {
  const reasons: string[] = [];

  // Step 3.1: 任一 gate invalid → invalid(优先级最高,即使 structural/inline deny
  // 也走 invalid——因为 gate invalid 表示上游 decision 本身不可信,不能引用)。
  if (!input.inherited_environment_valid) {
    reasons.push('gate.invalid:inherited_environment');
  }
  if (!input.structural_decision_valid) {
    reasons.push('gate.invalid:structural_policy');
  }
  if (!input.inline_decision_valid) {
    reasons.push('gate.invalid:inline_environment');
  }
  if (!input.executable_resolution_valid) {
    reasons.push('gate.invalid:executable_resolution');
  }
  if (!input.permission_valid) {
    reasons.push('gate.invalid:permission');
  }
  if (reasons.length > 0) {
    return { status: 'invalid', statusReasons: reasons };
  }

  // Step 3.2: deny 短路
  if (input.structural_decision.candidate_behavior === 'deny') {
    reasons.push('deny:structural_policy');
    return { status: 'denied', statusReasons: reasons };
  }
  if (input.inline_decision.aggregated_action === 'deny') {
    reasons.push('deny:inline_environment');
    return { status: 'denied', statusReasons: reasons };
  }
  if (input.executable_resolution.status === 'denied') {
    reasons.push('deny:executable_resolution');
    return { status: 'denied', statusReasons: reasons };
  }

  // Step 3.3: ask 短路
  if (input.inline_decision.aggregated_action === 'ask') {
    reasons.push('ask:inline_environment');
    return { status: 'ask_required', statusReasons: reasons };
  }
  // required_security_decision_ref 后缀 ':ask' → ask
  if (input.required_security_decision_ref.endsWith(':ask')) {
    reasons.push('ask:permission');
    return { status: 'ask_required', statusReasons: reasons };
  }

  // Step 3.4: 复杂 shell structure → invalid(不回退 shell:true)
  if (input.parse_result_status !== 'parsed') {
    reasons.push(`shell.not_parsed:${input.parse_result_status}`);
    return { status: 'invalid', statusReasons: reasons };
  }
  const complexKinds = input.parse_result_risk_facts_kinds.filter((k) =>
    COMPLEX_SHELL_FACT_KINDS.has(k),
  );
  if (complexKinds.length > 0) {
    // 去重 + 排序,保证 reason_codes 稳定(canonical 不依赖 reason,
    // 但 reason 本身仍要 deterministic 以便审计)。
    const unique = [...new Set(complexKinds)].sort();
    reasons.push(`shell.complex:${unique.join(',')}`);
    return { status: 'invalid', statusReasons: reasons };
  }

  // Step 3.5: 全部通过
  reasons.push('plan.ready_for_permission');
  return { status: 'ready_for_permission', statusReasons: reasons };
}

/**
 * canonical 串——包含全部影响 plan 身份的字段,保证相同输入 → 相同 plan_id。
 *
 * 故意不包含 reason_codes 全文——reason 是派生产物,不应让 reason 表述的细微
 * 差异改变 plan 的身份。但 status 与结构化 diff、resolved path、argv、parse
 * 摘要都是实质字段,必须入 canonical。
 */
function buildPlanCanonical(args: {
  protocolVersion: string;
  actionSnapshotId: string;
  inheritedEnvRef: string;
  structuralDecisionId: string;
  inlineDecisionId: string;
  executableResolutionId: string;
  requiredSecRef: string;
  status: SanitizedExecutionPlanStatus;
  preserved: string[];
  stripped: string[];
  resolvedCanonicalPath: string | null;
  literalArgv: string[] | null;
  parseResultStatus: string;
  parseResultRiskFactsKinds: string[];
}): string {
  // risk fact kinds 去重 + 排序,保证输入数组顺序差异不影响 canonical。
  const factsKinds = [...new Set(args.parseResultRiskFactsKinds)].sort().join(',');
  return [
    args.protocolVersion,
    args.actionSnapshotId,
    args.inheritedEnvRef,
    args.structuralDecisionId,
    args.inlineDecisionId,
    args.executableResolutionId,
    args.requiredSecRef,
    args.status,
    args.preserved.slice().sort().join(','),
    args.stripped.slice().sort().join(','),
    args.resolvedCanonicalPath ?? '',
    args.literalArgv ? args.literalArgv.join(',') : '',
    args.parseResultStatus,
    factsKinds,
  ].join('|');
}

// ═══════════════════════════════════════════════════════════════════════════
// ERC-4 / M-065 Pre-Spawn Revalidation & Sanitized Execution
// ═══════════════════════════════════════════════════════════════════════════
//
// 物理本质:spawn 前的"最后一道 TOCTOU 防线"。在 plan ready 与 permission
// allow 之后、实际 spawn 之前,重新 realpath/stat/hash 已解析的 executable,
// 确认文件 identity 未被篡改。executeSanitizedCommand 把 plan + revalidation
// + permission 三者用硬 AND 组合,决定 spawn / deny / ask_required。
//
// 关键不变量(spec ERC-4 Step 3/5/6 + 计划 Task 14):
//   1. spawn 前重新 realpath/stat/hash(TOCTOU 防御);
//   2. 只有 match 可继续;changed/missing/unsupported 使旧 approval 失效;
//   3. 自动重新解析必须创建新 action snapshot 和新 SecurityDecision(本函数
//      返回 denied/changed/missing/unsupported,由调用方重新走流程);
//   4. shell:false 执行——绝不把原始 command 重新传给 shell:true;
//   5. ask 必须等待;ask unavailable / stale decision / plan/action mismatch
//      / plan/revalidation mismatch 均 deny;
//   6. spawn 同时验证 current plan / current permission / current identity;
//   7. 任何旧 approval 不能跨新 action snapshot。
//
// 本模块不调用 child_process;spawn 由调用方注入(类型上以 shell:false 强制)。
// 本函数只决定"是否允许 spawn",不构造 SecurityDecision,不修改历史 plan/decision。

/** Wave E 首个 revalidation 协议版本(硬编码 'erc-4-revalidate-v1')。 */
export const REVALIDATION_PROTOCOL_VERSION = 'erc-4-revalidate-v1';

/** Wave E 首个 execution 协议版本(硬编码 'erc-4-exec-v1')。 */
export const EXECUTION_PROTOCOL_VERSION = 'erc-4-exec-v1';

/** Wave E 首个 cutover 协议版本(硬编码 'cutover-v1')。 */
export const CUTOVER_PROTOCOL_VERSION = 'cutover-v1';

// ─────────────────────────────────────────────
// revalidateExecutableIdentity 类型
// ─────────────────────────────────────────────

/** identity revalidation 四态(规格 ERC-4 Step 3)。 */
export type RevalidationStatus = 'match' | 'changed' | 'missing' | 'unsupported';

/** revalidateExecutableIdentity 输入。 */
export interface RevalidationInput {
  revalidation_protocol_version: string;
  action_snapshot_id: string;
  /** 上游 ready plan(E-3 T13)。 */
  plan: SanitizedExecutionPlan;
  /**
   * 之前解析出的 executable resolution(E-2 T12)—— 用来取绑定的
   * `content_or_metadata_hash` 作为 previous hash。
   */
  previous_resolution: ExecutableResolutionResult;
  /** 平台解析 adapter(注入,便于 mock)。 */
  platform_adapter: PlatformResolutionAdapter;
}

/** revalidateExecutableIdentity 输出。 */
export interface RevalidationResult {
  revalidation_protocol_version: string;
  /** 形如 'revalidate:<sha256-prefix-16>'。 */
  revalidation_id: string;
  action_snapshot_id: string;
  status: RevalidationStatus;
  current_content_or_metadata_hash: string | null;
  previous_content_or_metadata_hash: string | null;
  reason_codes: string[];
}

// ─────────────────────────────────────────────
// revalidateExecutableIdentity 主入口
// ─────────────────────────────────────────────

/**
 * Spawn 前重新 realpath/stat/hash 已解析的 executable,确认 identity 未被篡改。
 *
 * 算法(规格 ERC-4 Step 3 + 计划 Task 14):
 *   1. identity 守门;
 *   2. plan.status !== 'ready_for_permission' → 'unsupported'
 *      'revalidation.plan_not_ready'(plan 不可信,不触碰 fs);
 *   3. platform_adapter.getUnsupportedReason !== null → 'unsupported';
 *   4. plan.resolved_canonical_path 为 null → 'missing'
 *      'revalidation.no_resolved_path';
 *   5. 重新 realpath/stat —— 失败 ENOENT → 'missing';
 *   6. 计算 current identity hash;
 *   7. current vs previous_resolution.content_or_metadata_hash:
 *      - 相等 → 'match';
 *      - 不等 → 'changed'(旧 approval 失效);
 *   8. revalidation_id 由 canonical 字段确定性派生;
 *   9. freeze 返回。
 *
 * **永不 spawn**:本函数不调用任何 spawn / exec 类方法。
 */
export async function revalidateExecutableIdentity(
  input: RevalidationInput,
): Promise<RevalidationResult> {
  const protocolVersion = requireIdentity(
    input.revalidation_protocol_version,
    'revalidation_protocol_version',
  );
  const actionSnapshotId = requireIdentity(
    input.action_snapshot_id,
    'action_snapshot_id',
  );

  const plan = input.plan;
  const previous = input.previous_resolution;
  const previousHash =
    previous.content_or_metadata_hash ?? null;

  // ── Step 2: plan 必须 ready —— 否则不触碰 fs,直接 unsupported ──
  if (plan.status !== 'ready_for_permission') {
    return freezeRevalidation({
      revalidation_protocol_version: protocolVersion,
      revalidation_id: buildRevalidationId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: '',
        currentHash: '',
        status: 'unsupported',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'unsupported',
      current_content_or_metadata_hash: null,
      previous_content_or_metadata_hash: previousHash,
      reason_codes: ['revalidation.plan_not_ready'],
    });
  }

  const canonicalPath = plan.resolved_canonical_path;
  if (canonicalPath === null) {
    return freezeRevalidation({
      revalidation_protocol_version: protocolVersion,
      revalidation_id: buildRevalidationId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: '',
        currentHash: '',
        status: 'missing',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'missing',
      current_content_or_metadata_hash: null,
      previous_content_or_metadata_hash: previousHash,
      reason_codes: ['revalidation.no_resolved_path'],
    });
  }

  // ── Step 3: 平台能力 gate(Windows ADS / 8.3 / long-path 等)──
  // platform 从 canonical_path 推断(不读 process.platform,保持纯函数)。
  // 它影响 identity hash 计算(mtime/dev/ino 在 Windows 为 null),因此必须确定。
  const platform = inferPlatformFromPath(canonicalPath);
  const unsupportedReason = input.platform_adapter.getUnsupportedReason(platform);
  if (unsupportedReason !== null) {
    return freezeRevalidation({
      revalidation_protocol_version: protocolVersion,
      revalidation_id: buildRevalidationId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath,
        currentHash: '',
        status: 'unsupported',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'unsupported',
      current_content_or_metadata_hash: null,
      previous_content_or_metadata_hash: previousHash,
      reason_codes: ['revalidation.platform_unsupported', unsupportedReason],
    });
  }

  // ── Step 5: 重新 realpath/stat(失败 → missing)──
  let realPath: string;
  try {
    realPath = await input.platform_adapter.realpath(canonicalPath);
  } catch (e) {
    if (isNotFoundErr(e)) {
      return missingRevalidation(
        protocolVersion,
        actionSnapshotId,
        canonicalPath,
        previousHash,
      );
    }
    throw e;
  }

  let statInfo: {
    dev?: number;
    ino?: number;
    size: number;
    mtime: Date;
    mode: number;
    isSymbolicLink: boolean;
  };
  try {
    statInfo = await input.platform_adapter.stat(canonicalPath);
  } catch (e) {
    if (isNotFoundErr(e)) {
      return missingRevalidation(
        protocolVersion,
        actionSnapshotId,
        canonicalPath,
        previousHash,
      );
    }
    throw e;
  }

  // ── Step 6: 计算 current hash(与 resolveExecutableIdentity 同算法)──
  const currentIdentity: ExecutableFileIdentity = {
    canonical_path: realPath,
    platform,
    dev: platform === 'win32' ? null : String(statInfo.dev ?? ''),
    ino: platform === 'win32' ? null : String(statInfo.ino ?? ''),
    size: statInfo.size,
    mtime: statInfo.mtime.toISOString(),
    mode: statInfo.mode,
    is_symlink: statInfo.isSymbolicLink,
    symlink_target: statInfo.isSymbolicLink ? realPath : null,
  };
  const currentHash = sha256Hex(JSON.stringify(currentIdentity));

  // ── Step 7: 比较 ──
  if (previousHash !== null && currentHash === previousHash) {
    return freezeRevalidation({
      revalidation_protocol_version: protocolVersion,
      revalidation_id: buildRevalidationId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: realPath,
        currentHash,
        status: 'match',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'match',
      current_content_or_metadata_hash: currentHash,
      previous_content_or_metadata_hash: previousHash,
      reason_codes: ['revalidation.match'],
    });
  }
  // hash 不一致(或 previous 为 null)→ changed;旧 approval 失效
  return freezeRevalidation({
    revalidation_protocol_version: protocolVersion,
    revalidation_id: buildRevalidationId({
      protocolVersion,
      actionSnapshotId,
      canonicalPath: realPath,
      currentHash,
      status: 'changed',
    }),
    action_snapshot_id: actionSnapshotId,
    status: 'changed',
    current_content_or_metadata_hash: currentHash,
    previous_content_or_metadata_hash: previousHash,
    reason_codes: [
      'revalidation.changed',
      `revalidation.previous:${previousHash ?? 'null'}`,
    ],
  });
}

/**
 * 从 canonical_path 字符推断 PlatformFamily(不读 process.platform)。
 *
 * 规则:
 *   - 含 '\\' 或匹配 /^[A-Za-z]:[\\/]/ → 'win32';
 *   - 否则 → 'linux'(POSIX 默认)。
 *
 * platform 影响 identity hash(mtime/dev/ino 在 Windows 为 null),必须确定。
 */
function inferPlatformFromPath(canonicalPath: string): PlatformFamily {
  if (canonicalPath.includes('\\') || /^[A-Za-z]:[\\/]/.test(canonicalPath)) {
    return 'win32';
  }
  return 'linux';
}

/** missing 共用出口。 */
function missingRevalidation(
  protocolVersion: string,
  actionSnapshotId: string,
  canonicalPath: string,
  previousHash: string | null,
): RevalidationResult {
  return freezeRevalidation({
    revalidation_protocol_version: protocolVersion,
    revalidation_id: buildRevalidationId({
      protocolVersion,
      actionSnapshotId,
      canonicalPath,
      currentHash: '',
      status: 'missing',
    }),
    action_snapshot_id: actionSnapshotId,
    status: 'missing',
    current_content_or_metadata_hash: null,
    previous_content_or_metadata_hash: previousHash,
    reason_codes: ['revalidation.missing'],
  });
}

/**
 * revalidation_id 的 canonical 输入。
 *
 * 不含 reason_codes(派生产物)。canonicalPath 与 currentHash 仅在 match/changed
 * 时有意义;missing/unsupported 时为 '' —— 保证同输入 → 同 id。
 */
function buildRevalidationId(args: {
  protocolVersion: string;
  actionSnapshotId: string;
  canonicalPath: string;
  currentHash: string;
  status: RevalidationStatus;
}): string {
  const parts = [
    args.protocolVersion,
    args.actionSnapshotId,
    args.canonicalPath,
    args.currentHash,
    args.status,
  ];
  return `revalidate:${sha256Hex(parts.join('|')).slice(0, 16)}`;
}

function freezeRevalidation(r: RevalidationResult): RevalidationResult {
  return freezeSnapshot(r) as RevalidationResult;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cutover Policy State(shadow / enforced 双轨)
// ═══════════════════════════════════════════════════════════════════════════

/** Cutover 模式:'shadow'(default 路径) / 'enforced'(shell:false 路径)。 */
export type SanitizedExecutionCutoverMode = 'shadow' | 'enforced';

/** 受信 cutover 状态(单调版本化,可回滚)。 */
export interface SanitizedExecutionCutoverState {
  mode: SanitizedExecutionCutoverMode;
  /** 形如 'cutover-N',N 单调递增;rollback 不重置。 */
  version: string;
  /** ISO-8601,enforced 时记录激活时间。 */
  activated_at?: string;
}

/** resolveSanitizedExecutionPolicy 输入。 */
export interface SanitizedExecutionPolicyInput {
  cutover_state: SanitizedExecutionCutoverState;
  /** 平台 inline environment policy 是否 ready。 */
  platform_policy_ready: boolean;
  /** resolver(ERC-4) 是否 ready。 */
  resolver_ready: boolean;
  /** revalidation 是否 ready。 */
  revalidation_ready: boolean;
  /** RC-5 permission gate 是否 ready。 */
  permission_gate_ready: boolean;
}

/** resolveSanitizedExecutionPolicy 输出。 */
export interface SanitizedExecutionPolicy {
  /** cutover 模式(透传)。 */
  mode: SanitizedExecutionCutoverMode;
  /**
   * enforced 路径是否真正激活。
   *
   * enforced_active = (mode === 'enforced') && 所有 gate ready;
   * 否则即便 mode=enforced,调用方仍走 shadow 路径。
   */
  enforced_active: boolean;
  cutover_version: string;
  reason_codes: string[];
}

/**
 * 解析 cutover policy:判断 enforced 路径是否真正激活。
 *
 * enforced_active = mode === 'enforced' && 所有 gate ready。
 * shadow 模式恒 false;enforced 模式但 gate 未 ready 也 false(降级 shadow)。
 *
 * Rollback 的语义:applyCutoverState 只切换 state(mode/version),
 * 不修改历史 plan/decision(它们是 frozen 记录)。本函数不接触历史。
 */
export function resolveSanitizedExecutionPolicy(
  input: SanitizedExecutionPolicyInput,
): SanitizedExecutionPolicy {
  const mode = input.cutover_state.mode;
  const gates: Array<[string, boolean]> = [
    ['platform_policy', input.platform_policy_ready],
    ['resolver', input.resolver_ready],
    ['revalidation', input.revalidation_ready],
    ['permission', input.permission_gate_ready],
  ];
  const notReady = gates.filter(([, ready]) => !ready).map(([name]) => name);
  const enforcedActive = mode === 'enforced' && notReady.length === 0;
  const reasonCodes: string[] = [];
  for (const name of notReady) {
    reasonCodes.push(`cutover.gate_not_ready:${name}`);
  }
  if (enforcedActive) {
    reasonCodes.push('cutover.enforced_active');
  } else {
    reasonCodes.push('cutover.shadow_active');
  }
  return freezeSnapshot({
    mode,
    enforced_active: enforcedActive,
    cutover_version: input.cutover_state.version,
    reason_codes: reasonCodes,
  }) as SanitizedExecutionPolicy;
}

/**
 * 应用一次 cutover 切换(rollback 或 enforce),返回新 state。
 *
 * 语义:
 *   - rollback(shadow)只切换 mode,version 与历史不动;
 *   - enforce(enforced)从前一次 shadow 切到 enforced 时 version 单调递增,
 *     不回退(从 enforced 直接 enforce 也允许,version 不变)。
 *
 * **不修改**任何历史 plan / decision / SecurityDecision —— 那些是 frozen 记录,
 * 由其各自的 freezeSnapshot 保护。本函数只产出一个新 cutover state。
 */
export function applyCutoverState(
  current: SanitizedExecutionCutoverState,
  next: { mode: SanitizedExecutionCutoverMode; activated_at?: string },
): SanitizedExecutionCutoverState {
  const prevMode = current.mode;
  const prevVersionNum = parseCutoverVersion(current.version);

  if (next.mode === 'enforced' && prevMode === 'shadow') {
    // shadow → enforced:version 单调递增
    const nextVersion = `cutover-${prevVersionNum + 1}`;
    return {
      mode: 'enforced',
      version: nextVersion,
      activated_at: next.activated_at ?? new Date().toISOString(),
    };
  }
  if (next.mode === 'shadow') {
    // rollback:mode 切回 shadow,version 不重置(历史不复活)
    return {
      mode: 'shadow',
      version: current.version,
    };
  }
  // enforced → enforced:version 不变(已是 enforced)
  return {
    mode: 'enforced',
    version: current.version,
    activated_at: next.activated_at ?? current.activated_at ?? new Date().toISOString(),
  };
}

function parseCutoverVersion(version: string): number {
  const m = /^cutover-(\d+)$/.exec(version);
  return m ? parseInt(m[1], 10) : 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// executeSanitizedCommand — pre-spawn gate
// ═══════════════════════════════════════════════════════════════════════════

/** executeSanitizedCommand 输出的 status。 */
export type ExecuteSanitizedCommandStatus =
  | 'executed'
  | 'denied'
  | 'ask_required'
  /**
   * Shadow 模式专用 —— 调用方应自行走 default 路径(不调用本路径 spawn)。
   *
   * 关键:shadow_no_op 不宣称 M-065 生效。
   */
  | 'shadow_no_op';

/** executeSanitizedCommand 输入。 */
export interface ExecuteSanitizedCommandInput {
  /** 上游 ready plan(E-3 T13)。 */
  plan: SanitizedExecutionPlan;
  /** identity revalidation 结果(本 T14)。 */
  revalidation: RevalidationResult;
  /**
   * 由调用方注入的 spawn —— 本函数不直接 spawn,只决定是否允许。
   *
   * shell:false 由类型字面量强制(不是 boolean)。这样调用方在构造 options
   * 时无法误传 true;调用方传入的 spawn 实现仍可丢弃 options 自行 spawn,
   * 但类型签名让 shell:true 不通过编译。
   */
  spawn: (
    canonicalPath: string,
    argv: string[],
    options: {
      shell: false;
      env: Record<string, string>;
      cwd: string;
      windowsHide: true;
    },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * 当前 RC-5 permission allow 证据。
   *
   * true 表示当前 action snapshot 下 permission 已 allow;false 表示需要 ask。
   */
  current_permission_allows: boolean;
  /** ask channel 是否可用 —— false 时 ask 降级为 deny。默认 true。 */
  ask_channel_available?: boolean;
  /**
   * 当前 action snapshot id(若提供,必须与 plan 一致,否则 plan/action mismatch)。
   * 不提供则视为与 plan 相同。
   */
  current_action_snapshot_id?: string;
  /**
   * 当前 permission decision 绑定的 snapshot id(若提供,必须与 plan 一致,
   * 否则 stale decision)。不提供则不检查。
   */
  permission_decision_snapshot_id?: string;
  /** spawn 用的 effective env(已 M-063 scrubbed + M-065 inline decided)。 */
  effective_environment: Record<string, string>;
  /** spawn 用的 cwd。 */
  working_directory: string;
  /** 可选:cutover policy(若提供,shadow 模式返回 shadow_no_op)。 */
  cutover_policy?: SanitizedExecutionPolicy;
}

/** executeSanitizedCommand 输出。 */
export interface ExecuteSanitizedCommandResult {
  execution_protocol_version: string;
  /** 形如 'exec:<sha256-prefix-16>'。 */
  execution_id: string;
  action_snapshot_id: string;
  status: ExecuteSanitizedCommandStatus;
  reason_codes: string[];
  /** 仅 status === 'executed' 时非空。 */
  spawn_result?: { stdout: string; stderr: string; exitCode: number };
}

/**
 * Pre-spawn gate:把 plan + revalidation + permission 用硬 AND 组合,
 * 决定 spawn / deny / ask_required / shadow_no_op。
 *
 * 算法(规格 ERC-4 Step 5/6 + 计划 Task 14):
 *   1. cutover_policy.enforced_active === false → 'shadow_no_op'
 *      (调用方走 default,不通过本路径 spawn);
 *   2. plan.status !== 'ready_for_permission' → 'denied'
 *      'execution.plan_not_ready';
 *   3. plan/revalidation action_snapshot_id 不一致 → 'denied'
 *      'execution.snapshot_mismatch';
 *   4. current_action_snapshot_id 与 plan 不一致 → 'denied'
 *      'execution.plan_action_mismatch';
 *   5. permission_decision_snapshot_id 与 plan 不一致 → 'denied'
 *      'execution.stale_decision';
 *   6. revalidation.status !== 'match' → 'denied'
 *      `execution.revalidation_${status}`;
 *   7. plan.literal_argv 为 null → 'denied' 'execution.no_literal_argv'
 *      (defensive TOCTOU:理论上 ready plan 一定有 argv,但防御一下);
 *   8. !current_permission_allows → ask 或 deny:
 *      - ask_channel_available(默认 true) → 'ask_required' 'execution.permission_ask';
 *      - 否则 → 'denied' 'execution.permission_ask_unavailable';
 *   9. 全部通过 → 调用 spawn(canonicalPath, literalArgv, { shell:false, env, cwd, windowsHide:true }),
 *      status='executed' + spawn_result;
 *  10. execution_id 由 canonical 字段确定性派生;freeze 返回。
 *
 * **关键不变量**:
 *   - shell:false(由类型字面量强制);
 *   - spawn 同时验证 current plan / current permission / current identity;
 *   - 任何旧 approval 不跨新 action snapshot;
 *   - ask 必须等待;ask unavailable / stale / mismatch 均 deny。
 */
export async function executeSanitizedCommand(
  input: ExecuteSanitizedCommandInput,
): Promise<ExecuteSanitizedCommandResult> {
  const protocolVersion = EXECUTION_PROTOCOL_VERSION;
  const actionSnapshotId = input.plan.action_snapshot_id;
  const askAvailable = input.ask_channel_available ?? true;

  // ── Step 1: cutover gate —— shadow 模式不通过本路径 spawn ──
  if (input.cutover_policy && !input.cutover_policy.enforced_active) {
    return freezeExecution({
      execution_protocol_version: protocolVersion,
      execution_id: buildExecutionId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: input.plan.resolved_canonical_path ?? '',
        status: 'shadow_no_op',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'shadow_no_op',
      reason_codes: ['execution.shadow_no_op', 'execution.cutover_not_enforced'],
    });
  }

  // ── Step 2: plan must be ready ──
  if (input.plan.status !== 'ready_for_permission') {
    return freezeExecution({
      execution_protocol_version: protocolVersion,
      execution_id: buildExecutionId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: input.plan.resolved_canonical_path ?? '',
        status: 'denied',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'denied',
      reason_codes: ['execution.plan_not_ready', `plan.status:${input.plan.status}`],
    });
  }

  // ── Step 3: plan/revalidation snapshot 必须一致 ──
  if (input.revalidation.action_snapshot_id !== actionSnapshotId) {
    return freezeExecution({
      execution_protocol_version: protocolVersion,
      execution_id: buildExecutionId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: input.plan.resolved_canonical_path ?? '',
        status: 'denied',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'denied',
      reason_codes: ['execution.snapshot_mismatch'],
    });
  }

  // ── Step 4: plan 与 current action snapshot 必须一致 ──
  if (
    input.current_action_snapshot_id !== undefined &&
    input.current_action_snapshot_id !== actionSnapshotId
  ) {
    return freezeExecution({
      execution_protocol_version: protocolVersion,
      execution_id: buildExecutionId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: input.plan.resolved_canonical_path ?? '',
        status: 'denied',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'denied',
      reason_codes: ['execution.plan_action_mismatch'],
    });
  }

  // ── Step 5: permission decision snapshot 必须与 plan 一致(stale decision)──
  if (
    input.permission_decision_snapshot_id !== undefined &&
    input.permission_decision_snapshot_id !== actionSnapshotId
  ) {
    return freezeExecution({
      execution_protocol_version: protocolVersion,
      execution_id: buildExecutionId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: input.plan.resolved_canonical_path ?? '',
        status: 'denied',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'denied',
      reason_codes: ['execution.stale_decision'],
    });
  }

  // ── Step 6: identity revalidation 必须 match ──
  if (input.revalidation.status !== 'match') {
    return freezeExecution({
      execution_protocol_version: protocolVersion,
      execution_id: buildExecutionId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: input.plan.resolved_canonical_path ?? '',
        status: 'denied',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'denied',
      reason_codes: [`execution.revalidation_${input.revalidation.status}`],
    });
  }

  // ── Step 7: literal argv 必须存在(defensive TOCTOU)──
  if (input.plan.literal_argv === null) {
    return freezeExecution({
      execution_protocol_version: protocolVersion,
      execution_id: buildExecutionId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: input.plan.resolved_canonical_path ?? '',
        status: 'denied',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'denied',
      reason_codes: ['execution.no_literal_argv'],
    });
  }

  // ── Step 8: permission 必须 allow;否则 ask / deny ──
  if (!input.current_permission_allows) {
    if (askAvailable) {
      return freezeExecution({
        execution_protocol_version: protocolVersion,
        execution_id: buildExecutionId({
          protocolVersion,
          actionSnapshotId,
          canonicalPath: input.plan.resolved_canonical_path ?? '',
          status: 'ask_required',
        }),
        action_snapshot_id: actionSnapshotId,
        status: 'ask_required',
        reason_codes: ['execution.permission_ask'],
      });
    }
    return freezeExecution({
      execution_protocol_version: protocolVersion,
      execution_id: buildExecutionId({
        protocolVersion,
        actionSnapshotId,
        canonicalPath: input.plan.resolved_canonical_path ?? '',
        status: 'denied',
      }),
      action_snapshot_id: actionSnapshotId,
      status: 'denied',
      reason_codes: ['execution.permission_ask_unavailable'],
    });
  }

  // ── Step 9: 全部通过 → shell:false spawn ──
  const canonicalPath = input.plan.resolved_canonical_path!;
  const argv = [...input.plan.literal_argv];
  const spawnResult = await input.spawn(canonicalPath, argv, {
    shell: false,
    env: input.effective_environment,
    cwd: input.working_directory,
    windowsHide: true,
  });

  return freezeExecution({
    execution_protocol_version: protocolVersion,
    execution_id: buildExecutionId({
      protocolVersion,
      actionSnapshotId,
      canonicalPath,
      status: 'executed',
    }),
    action_snapshot_id: actionSnapshotId,
    status: 'executed',
    reason_codes: [
      'execution.spawned',
      'execution.shell_false',
      `execution.exit_code:${spawnResult.exitCode}`,
    ],
    spawn_result: {
      stdout: spawnResult.stdout,
      stderr: spawnResult.stderr,
      exitCode: spawnResult.exitCode,
    },
  });
}

/**
 * execution_id 的 canonical 输入。
 *
 * 不含 reason_codes / spawn_result(派生产物)。canonicalPath 仅在 executed
 * 时有意义;其它 status 传入 plan 的 resolved_canonical_path(若 null 则 '')。
 */
function buildExecutionId(args: {
  protocolVersion: string;
  actionSnapshotId: string;
  canonicalPath: string;
  status: ExecuteSanitizedCommandStatus;
}): string {
  const parts = [
    args.protocolVersion,
    args.actionSnapshotId,
    args.canonicalPath,
    args.status,
  ];
  return `exec:${sha256Hex(parts.join('|')).slice(0, 16)}`;
}

function freezeExecution(r: ExecuteSanitizedCommandResult): ExecuteSanitizedCommandResult {
  return freezeSnapshot(r) as ExecuteSanitizedCommandResult;
}
