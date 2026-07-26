// BRC-6 / M-063 子进程环境清洗——Child-Process Environment Gate
//
// 物理本质：安检员的"通行名单"。
//   父进程的环境变量是一大袋行李，里面混着大量 secret（API_KEY、TOKEN、
//   AWS_*、AZURE_*、CREDENTIALS...）。子进程不需要也不应该看到这些。
//   本模块是 spawn 之前的最后一道关卡——按显式 allow/deny 策略构造一份
//   "最小必需 + 显式允许"的 sanitized environment，交给 spawn 的 env 选项。
//
// 关键不变量（spec §12.2）：
//   1. 父环境不得整包传入子进程——只传递 sanitized 集合；
//   2. allow/deny 按 launcher kind 审计，绝不照搬任何外部工具的变量列表；
//   3. 日志 / 决策单只携带变量 NAME 与 reason code，绝不携带 secret VALUE
//      （types 中所有字段都是 string[] of NAMES，结构上无法表达 value）；
//   4. inline VAR=value 是 M-065（Wave E）的职责，本模块只处理"继承环境"；
//   5. 任何异常（policy 缺失、scrubber 异常、required 缺失、unknown launcher）
//      → deny launch（sanitized_environment = null）；
//   6. wrapper 所需变量必须以显式 required list 进入策略审计。
//
// 决策单复用 Wave A 的 SecurityDecision 词汇（identity + freeze），但不依赖
// createSecurityDecision 的全部字段——这里只需要一个确定性的 decision_ref。

import { requireIdentity, freezeSnapshot } from '../agent/contracts/identities.js';

/** 合法的 launcher_kind 集合。任何其它值 → deny。 */
const ALLOWED_LAUNCHER_KINDS = new Set<string>(['shell_tool', 'background']);

/**
 * 输入：调用 spawn 的位置需要为本次 launch 构造的全部身份与数据。
 *
 * 注意 `required_variable_names` 字段：策略（policy）是 per-launcher-kind 的
 * required/optional 真相来源；本字段是 CALLER-ASSERTED 的"额外 required"
 * （合并到 policy.required 之后再校验），允许调用方在策略默认集之上要求更多变量。
 * 不要把策略的 required 集合拷贝到这里——策略本身就是真相源。
 */
export interface ChildProcessEnvironmentInput {
  launch_snapshot_id: string;
  launcher_kind: 'shell_tool' | 'background';
  executable_ref: string;
  /** 父进程环境（read-only 输入）。决策函数绝不修改此对象。 */
  parent_environment: Record<string, string>;
  /** Caller-asserted 额外 required 变量（与 policy.required 取并集）。 */
  required_variable_names: readonly string[];
  environment_policy_id: string;
  environment_policy_version: string;
}

/**
 * 输出：env gate 的正式决策单。
 *
 * `sanitized_environment === null` 表示 deny（launch 不能继续）。
 * 所有数组字段只承载变量 NAME，绝不承载 VALUE。
 */
export interface ChildProcessEnvironmentDecision {
  launch_snapshot_id: string;
  /** 确定性派生：`'env:' + launch_snapshot_id`。 */
  security_decision_ref: string;
  /** null when denied。freeze 后不可变。 */
  sanitized_environment: Record<string, string> | null;
  /** 计算后允许进入子进程的变量名集合（denied_patterns 仍会从中剥离）。 */
  allowed_variable_names: string[];
  /** 被剥离的变量名集合：包含 (a) 不在 allowed set 的继承变量；(b) 命中 denied_patterns 的变量。 */
  removed_variable_names: string[];
  /** 缺失的 required 变量名（非空 → deny）。 */
  missing_required_variable_names: string[];
}

/**
 * 环境策略：按 launcher_kind 索引的 required/optional 集合 + 全局 denied_patterns。
 *
 * required/optional 都是 `Record<launcher_kind, string[]>`，key 必须是合法的
 * launcher_kind（'shell_tool' / 'background'）。本接口不强制 key 一定齐全——
 * 缺 key 的 launcher_kind 会在 decide 时 deny（"policy missing for launcher_kind"）。
 *
 * denied_patterns 是一组 RegExp，命中即剥离（即便变量在 allowed 集合里也会被移除）。
 */
export interface EnvironmentPolicy {
  environment_policy_id: string;
  environment_policy_version: string;
  /** Per-launcher-kind required variable name sets. */
  required: Readonly<Record<string, readonly string[]>>;
  /** Per-launcher-kind optional variable name sets. */
  optional: Readonly<Record<string, readonly string[]>>;
  /** Names matching these patterns are ALWAYS removed (even if in optional). */
  denied_patterns: readonly RegExp[];
}

/** 默认 denied patterns（spec §12.2 第 7 条）。 */
const DEFAULT_DENIED_PATTERNS: readonly RegExp[] = [
  /^.*_API_KEY$/i,
  /^.*_TOKEN$/i,
  /^.*_SECRET$/i,
  /^PASSWORD$/i,
  /^AWS_.*$/i,
  /^AZURE_.*$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
];

/** 平台族：windows vs unix。 */
function platformFamily(platform: NodeJS.Platform): 'windows' | 'unix' {
  return platform === 'win32' ? 'windows' : 'unix';
}

/**
 * 默认 per-platform 环境策略（spec §12.2 / Wave B plan Task 12 Step 3）。
 *
 * shell_tool 与 background 共享同一份 per-platform 变量集合（区分是为了
 * 未来能独立版本化/收紧；当前最小集合一致）。
 *
 * 版本：每次 required/optional 集合变化必须 bump version。
 */
export function getDefaultEnvironmentPolicy(platform: NodeJS.Platform): EnvironmentPolicy {
  const family = platformFamily(platform);
  if (family === 'windows') {
    return {
      environment_policy_id: 'child-env-default',
      environment_policy_version: '1',
      required: {
        shell_tool: ['PATH', 'SystemRoot', 'ComSpec'],
        background: ['PATH', 'SystemRoot', 'ComSpec'],
      },
      optional: {
        shell_tool: ['PATHEXT', 'TEMP', 'TMP'],
        background: ['PATHEXT', 'TEMP', 'TMP'],
      },
      denied_patterns: DEFAULT_DENIED_PATTERNS,
    };
  }
  // unix (linux / darwin / ...)
  return {
    environment_policy_id: 'child-env-default',
    environment_policy_version: '1',
    required: {
      shell_tool: ['PATH'],
      background: ['PATH'],
    },
    optional: {
      shell_tool: ['HOME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL'],
      background: ['HOME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL'],
    },
    denied_patterns: DEFAULT_DENIED_PATTERNS,
  };
}

/** 构造 deny 决策（sanitized_environment = null）。 */
function denyDecision(
  launch_snapshot_id: string,
  allowed: string[],
  removed: string[],
  missing_required: string[],
): ChildProcessEnvironmentDecision {
  return {
    launch_snapshot_id,
    security_decision_ref: `env:${launch_snapshot_id}`,
    sanitized_environment: null,
    allowed_variable_names: allowed,
    removed_variable_names: removed,
    missing_required_variable_names: missing_required,
  };
}

/**
 * 计算子进程环境决策。
 *
 * 校验/计算顺序（spec §12.2 规则 1-11）：
 *   1. identity 字段非空（requireIdentity）—— launch_snapshot_id / launcher_kind /
 *      executable_ref / environment_policy_id / environment_policy_version；
 *      同时校验 input.environment_policy_* 与 policy.environment_policy_* 一致。
 *   2. launcher_kind 必须是 'shell_tool' | 'background'，其它 → deny；
 *   3. policy.required[launcher_kind] 必须存在，否则 → deny（policy missing）；
 *   4. allowed = required ∪ optional（含 caller-asserted extras）；
 *   5. 对每个 required 名字，缺失 → 加入 missing_required；
 *   6. missing_required 非空 → deny；
 *   7. 应用 denied_patterns：命中即从 sanitized_environment 移除并记入 removed；
 *   8. security_decision_ref = 'env:' + launch_snapshot_id（确定性）；
 *   9. removed 还包含"父环境里不在 allowed set"的变量名（仅 NAME）；
 *   10. 只承载 NAMES，绝不承载 VALUES（结构保证）；
 *   11. freezeSnapshot 深冻结。
 *
 * 异常语义：身份校验失败 → throw（让调用方知道传错）。逻辑性 deny（policy
 * missing / required 缺失 / unknown launcher）→ 返回 deny decision，不抛错。
 */
export function decideChildProcessEnvironment(
  input: ChildProcessEnvironmentInput,
  policy: EnvironmentPolicy,
): ChildProcessEnvironmentDecision {
  // ── 1. identity 校验 ──
  requireIdentity(input.launch_snapshot_id, 'launch_snapshot_id');
  requireIdentity(input.launcher_kind, 'launcher_kind');
  requireIdentity(input.executable_ref, 'executable_ref');
  requireIdentity(input.environment_policy_id, 'environment_policy_id');
  requireIdentity(input.environment_policy_version, 'environment_policy_version');

  // policy 自身身份（防御性：坏 policy → deny 而不是 silently 放行）
  requireIdentity(policy.environment_policy_id, 'policy.environment_policy_id');
  requireIdentity(policy.environment_policy_version, 'policy.environment_policy_version');

  // input 与 policy 的身份必须一致（防 caller 传错 policy）
  if (
    input.environment_policy_id !== policy.environment_policy_id ||
    input.environment_policy_version !== policy.environment_policy_version
  ) {
    throw new Error(
      `environment policy identity mismatch: input=` +
        `${input.environment_policy_id}@${input.environment_policy_version} vs ` +
        `policy=${policy.environment_policy_id}@${policy.environment_policy_version}`,
    );
  }

  // ── 2. launcher_kind 严格校验 ──
  if (!ALLOWED_LAUNCHER_KINDS.has(input.launcher_kind)) {
    // unknown launcher → deny（spec §12.2 规则 2 + §12.5 错误语义）
    return denyDecision(input.launch_snapshot_id, [], [], []);
  }

  // ── 3. policy lookup per launcher_kind ──
  const requiredForKind = policy.required[input.launcher_kind];
  const optionalForKind = policy.optional[input.launcher_kind];
  if (!Array.isArray(requiredForKind)) {
    // policy 没有为该 launcher_kind 定义 required → policy missing → deny
    return denyDecision(input.launch_snapshot_id, [], [], []);
  }
  const optionalArr = Array.isArray(optionalForKind) ? optionalForKind : [];

  // ── 4. allowed = required ∪ optional ∪ caller-asserted extras ──
  // caller-asserted extras 视作额外的 required（缺了也要 deny），见下面 step 5。
  const callerExtras = Array.isArray(input.required_variable_names)
    ? input.required_variable_names
    : [];
  // 合并 + 去重，保持稳定的可预测顺序（required 先，optional 后，extras 已并入 required）。
  const requiredSet: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (name: string) => {
    if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
      seen.add(name);
      requiredSet.push(name);
    }
  };
  for (const n of requiredForKind) pushUnique(n);
  for (const n of callerExtras) pushUnique(n);

  const allowedList: string[] = [...requiredSet];
  for (const n of optionalArr) {
    if (typeof n === 'string' && n.length > 0 && !seen.has(n)) {
      seen.add(n);
      allowedList.push(n);
    }
  }
  const allowedLookup = new Set(allowedList);

  // ── 5/6. required 缺失检查 ──
  const missing_required_variable_names: string[] = [];
  for (const name of requiredSet) {
    if (!(name in input.parent_environment)) {
      missing_required_variable_names.push(name);
    }
  }
  if (missing_required_variable_names.length > 0) {
    // required 缺失 → deny。removed 仍记录"父环境里不在 allowed 集合"的变量名（仅 NAME）。
    const removedFromParent: string[] = [];
    for (const parentName of Object.keys(input.parent_environment)) {
      if (!allowedLookup.has(parentName)) {
        removedFromParent.push(parentName);
      }
    }
    return denyDecision(
      input.launch_snapshot_id,
      allowedList,
      removedFromParent,
      missing_required_variable_names,
    );
  }

  // ── 7. 构造 sanitized_environment + 应用 denied_patterns ──
  const sanitized_environment: Record<string, string> = {};
  const patternRemoved: string[] = [];
  for (const name of allowedList) {
    if (!(name in input.parent_environment)) continue; // optional 缺失：跳过
    // denied_patterns 命中 → 剥离（即便在 allowed set 里）
    let denied = false;
    for (const pat of policy.denied_patterns) {
      try {
        if (pat.test(name)) {
          denied = true;
          break;
        }
      } catch {
        // scrubber 异常 → fail closed：视为命中（剥离），并记入 removed
        denied = true;
        break;
      }
    }
    if (denied) {
      patternRemoved.push(name);
      continue;
    }
    sanitized_environment[name] = input.parent_environment[name];
  }

  // ── 9. removed 还包含"父环境里不在 allowed 集合"的变量名 ──
  const removed_variable_names: string[] = [...patternRemoved];
  for (const parentName of Object.keys(input.parent_environment)) {
    if (!allowedLookup.has(parentName)) {
      removed_variable_names.push(parentName);
    }
  }

  // ── 8/10/11. 装配 + freeze ──
  const decision: ChildProcessEnvironmentDecision = {
    launch_snapshot_id: input.launch_snapshot_id,
    security_decision_ref: `env:${input.launch_snapshot_id}`,
    sanitized_environment,
    allowed_variable_names: allowedList,
    removed_variable_names,
    missing_required_variable_names,
  };
  return freezeSnapshot(decision) as ChildProcessEnvironmentDecision;
}
