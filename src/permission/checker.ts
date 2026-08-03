// PermissionChecker：执行工具前检查权限
//
// 实现 s07 新版四步管道：
//   1. 硬 deny（内置危险命令 / 写工作区外路径）
//   2. 用户 deny 规则
//   3. 模式检查（plan 禁写、auto 放行）
//   4. 用户 allow 规则 → 剩余按默认（写操作 ask、只读 allow）
//
// 物理比喻：银行柜台的层层审核。
// 前台一眼看出黑名单（硬 deny）→ 经理复核风控（用户 deny）→
// 按业务规则分流（mode）→ VIP 快速通道（allow）→ 其余走人工（ask）。

import type { PermissionMode, PermissionRule, PermissionDecision } from './types.js';
import { WRITE_TOOLS, READ_ONLY_TOOLS, DELEGATION_TOOLS } from './types.js';
import { isDangerousBash, isWriteBash, isPathOutsideWorkspace, matchesRule } from './patterns.js';
import { extractBashPaths } from './bash-paths.js';
import {
  createSecurityDecision,
  SECURITY_PROTOCOL_VERSION,
  type SecurityDecision,
} from './decisions.js';

/**
 * 内部 evaluation mode（设计 §2 / Task 3）。
 * - build/plan/auto：用户可见模式
 * - acceptEdits：内部 fast-path，discretionary allow 写操作（不暴露 CLI/TUI）
 * - bypassPermissions：内部，放行普通写但不绕过 protected settings / explicit ask / requiresInteraction
 * - dontAsk：内部，不弹窗（Task 3 预留，resolver 使用）
 *
 * checkWithEvaluationMode 用这些值；check() 仍只接受 PermissionMode。
 */
export type PermissionEvaluationMode = PermissionMode | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';

/** PermissionChecker 构造参数 */
export interface PermissionCheckerOptions {
  mode?: PermissionMode;
  rules?: PermissionRule[];
  workdir?: string;
  /** plan 模式下唯一允许写入的目录（plan 文件白名单） */
  planDir?: string;
  /**
   * Wave D Task 14 (M-064 / DRC-5): Command Structural Policy Hook。
   *
   * 传入后, 在 run_bash 工具的现有 4 步管道之后作为第 5 道闸门调用。
   * hook 接收 command + control_mode, 返回 'allow' | 'ask' | 'deny' | null。
   *   - null = hook 不适用(LEGACY 放行, 由前 4 步决定)
   *   - 'deny'/'ask' 覆盖之前的 allow(更严格)
   *   - 'allow' 不覆盖之前的 deny/ask(只能放宽, 不能放松硬门)
   *
   * hook 由调用方负责构造 CommandPolicyEvaluationInput + 调用 composeCommandStructuralDecision。
   * 不传时(LEGACY)跳过 command structural policy, 保持向后兼容。
   * 生产主路径(index.ts)在 DRC-5 Activation Gate 通过后传入此 hook。
   */
  commandPolicyHook?: (
    command: string,
    controlMode: PermissionEvaluationMode,
  ) => 'allow' | 'ask' | 'deny' | null;
}

/** 文件写入类工具（用于路径越界预检 + plan 目录白名单） */
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/** 带路径的文件类工具（闸门 1 越界预检：读+写统一硬拦截） */
const FILE_PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

/**
 * requiresUserInteraction 工具集（Task 3 A14）。
 * 这些工具的本质是“需要用户交互”，任何 evaluation mode（含 bypassPermissions）都不能放行，
 * 必须保持 ask。
 */
const REQUIRES_INTERACTION_TOOLS = new Set(['ask_user_question']);

/**
 * 受保护设置路径前缀（Task 3 A12）。
 * 这些路径是项目/仓库的关键配置，bypassPermissions 也不能放行写操作，必须 ask。
 * 物理本质：改这些文件 = 改权限/仓库边界，不能静默。
 */
const PROTECTED_SETTING_PATHS = ['.git/', '.git\\', '.micode/', '.micode\\'];

export class PermissionChecker {
  private mode: PermissionMode;
  private rules: PermissionRule[];
  private workdir: string;
  private planDir: string | null;
  private commandPolicyHook: PermissionCheckerOptions['commandPolicyHook'];

  constructor(options: PermissionCheckerOptions = {}) {
    this.mode = options.mode ?? 'build';
    this.rules = options.rules ? [...options.rules] : [];
    this.workdir = options.workdir ?? process.cwd();
    this.planDir = options.planDir ?? null;
    this.commandPolicyHook = options.commandPolicyHook;
  }

  /** 设置权限模式 */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** 获取当前模式 */
  getMode(): PermissionMode {
    return this.mode;
  }

  /** 设置 plan 目录（plan 模式下的写入白名单根目录） */
  setPlanDir(dir: string | null): void {
    this.planDir = dir;
  }

  /** 获取 plan 目录 */
  getPlanDir(): string | null {
    return this.planDir;
  }

  /** 获取全部规则（副本） */
  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  /** 替换全部规则 */
  setRules(rules: PermissionRule[]): void {
    this.rules = [...rules];
  }

  /** 追加一条规则 */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  /**
   * 检查权限：使用当前 mode 调用内部管道。
   *
   * 返回 { behavior, reason }：
   * - deny：调用方直接拦截，不执行
   * - ask：调用方应询问用户
   * - allow：直接执行
   */
  check(toolName: string, input: Record<string, unknown>): PermissionDecision {
    return this.checkInternal(toolName, input, this.mode);
  }

  /**
   * Task 3 A12-A14：按指定 evaluation mode 检查权限。
   *
   * evaluationMode 可为 build/plan/auto（用户可见模式）或 acceptEdits/bypassPermissions/dontAsk
   * （内部 evaluation mode，不暴露 CLI/TUI）。
   *
   * 不变量（设计 §5、§10 A12-A14）：
   *   - protected settings 写：任何 mode（含 bypassPermissions）都 ask；
   *   - explicit ask 规则：任何 mode（含 bypassPermissions）都 ask；
   *   - requiresUserInteraction 工具：任何 mode 都 ask；
   *   - acceptEdits/bypassPermissions：普通写 discretionary allow。
   */
  checkWithEvaluationMode(
    toolName: string,
    input: Record<string, unknown>,
    evaluationMode: PermissionEvaluationMode,
  ): PermissionDecision {
    return this.checkInternal(toolName, input, evaluationMode);
  }

  /**
   * 唯一同步权限管道（设计 §5，顺序不可重排）：
   *
   *   tool/raw strong rules → parsed subcommand strong rules
   *   → raw-input safety/requiresInteraction → too-complex fallback
   *   → discretionary allow → ordinary allow → ask
   *
   * 关键不变量：
   *   - deny 直接终止，不能被后续 mode/allow/ask 覆盖；
   *   - compound Bash 任一子命令命中 deny/ask，整命令对应 deny/ask；
   *   - AST too-complex 不能提前吞掉 raw deny/ask/可由 raw input 判断的 safety/interaction；
   *   - auto 不再无条件 allow；未决 write → ask。
   */
  private checkInternal(
    toolName: string,
    input: Record<string, unknown>,
    evaluationMode: PermissionEvaluationMode,
  ): PermissionDecision {
    // ── 闸门 1：tool/raw strong rules（deny 优先于 ask，不可被后续覆盖） ──
    //
    // 先扫所有 deny 规则，再扫 ask 规则；任一 deny 命中直接返回。
    // 对 run_bash compound 命令，按子命令逐一匹配（A10）。
    for (const rule of this.rules) {
      if (rule.behavior === 'deny' && this.ruleMatchesWithSubcommands(rule, toolName, input)) {
        return { behavior: 'deny', reason: `Matched deny rule (tool=${rule.tool})`, reason_code: 'permission.rule_deny' };
      }
    }
    for (const rule of this.rules) {
      if (rule.behavior === 'ask' && this.ruleMatchesWithSubcommands(rule, toolName, input)) {
        return { behavior: 'ask', reason: `Matched ask rule (tool=${rule.tool})`, reason_code: 'permission.explicit_ask' };
      }
    }

    // ── 闸门 2：parsed subcommand strong rules（commandPolicyHook / AST 子命令） ──
    //
    // commandPolicyHook 对 run_bash 做 AST 子命令级 policy；返回 deny/ask 时直接生效。
    // 但 too-complex（返回 null）不提前吞掉闸门 1 的 deny/ask（已在闸门 1 处理），
    // 也不吞掉闸门 3 的 raw safety/interaction。
    if (this.commandPolicyHook && toolName === 'run_bash') {
      const command = (input.command as string) || '';
      const astBehavior = this.commandPolicyHook(command, evaluationMode);
      if (astBehavior === 'deny') {
        return { behavior: 'deny', reason: 'Command structural policy denied (AST gate)', reason_code: 'permission.command_policy_denied' };
      }
      if (astBehavior === 'ask') {
        return { behavior: 'ask', reason: 'Command structural policy requires review (AST gate)', reason_code: 'permission.command_policy_denied' };
      }
      // 'allow' 或 null：继续（不放松硬门；null = too-complex，由闸门 3/兜底 ask 处理）
    }

    // ── 闸门 3：raw-input safety / requiresInteraction（内置硬约束） ──
    //
    // 这些可由 raw input 确定，必须在 too-complex fallback 之前求值；
    // too-complex 不能吞掉它们（设计 §5）。
    if (toolName === 'run_bash') {
      const command = (input.command as string) || '';
      // 3a. 危险命令黑名单（sudo/rm-rf/$()/fork bomb...）—— deny
      if (isDangerousBash(command)) {
        return { behavior: 'deny', reason: 'Dangerous command blocked by built-in policy', reason_code: 'permission.dangerous_command' };
      }
      // 3b. 路径围栏：解析命令路径参数；越界 deny，解析失败/变量未知 ask（too-complex fallback）
      const { paths, parseFailed, unresolvableVars } = extractBashPaths(command);
      if (parseFailed) {
        return { behavior: 'ask', reason: 'Bash command unparseable, needs review', reason_code: 'permission.command_unparseable' };
      }
      if (unresolvableVars) {
        return { behavior: 'ask', reason: 'Bash command has unresolvable variable, needs review', reason_code: 'permission.command_unresolvable_var' };
      }
      for (const p of paths) {
        if (isPathOutsideWorkspace(p, this.workdir)) {
          return { behavior: 'deny', reason: `Bash touches path outside workspace: ${p}`, reason_code: 'permission.path_outside_workspace' };
        }
      }
    }
    if (FILE_PATH_TOOLS.has(toolName)) {
      const filePath = (input.path as string) || '';
      if (filePath && isPathOutsideWorkspace(filePath, this.workdir)) {
        const op = toolName === 'read_file' ? 'Reading' : 'Writing';
        return { behavior: 'deny', reason: `${op} outside workspace is blocked by built-in policy`, reason_code: 'permission.path_outside_workspace' };
      }
    }
    // 3c. requiresUserInteraction 工具：任何 evaluation mode 都 ask（A14）
    if (REQUIRES_INTERACTION_TOOLS.has(toolName)) {
      return { behavior: 'ask', reason: 'Tool requires user interaction', reason_code: 'permission.requires_interaction' };
    }
    // 3d. protected settings 写：任何 evaluation mode（含 bypassPermissions）都 ask（A12）
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const filePath = ((input.path as string) || '').replace(/\\/g, '/');
      if (PROTECTED_SETTING_PATHS.some((prefix) => filePath.startsWith(prefix.replace(/\\/g, '/')))) {
        return { behavior: 'ask', reason: 'Protected settings cannot be auto-approved', reason_code: 'permission.protected_settings' };
      }
    }

    // ── 闸门 4：discretionary allow（按 evaluation mode / 用户可见 mode） ──
    //
    // plan / acceptEdits / bypassPermissions 各自的 discretionary allow；
    // auto 模式不再无条件 allow（A15：未决 write → ask），与 build 一样走 ordinary allow + 兜底 ask。
    if (evaluationMode === 'plan') {
      // plan 目录白名单
      if (FILE_WRITE_TOOLS.has(toolName) && this.planDir) {
        const filePath = (input.path as string) || '';
        if (filePath && !isPathOutsideWorkspace(filePath, this.planDir)) {
          return { behavior: 'allow', reason: 'Plan mode allows writing inside plan dir', reason_code: 'permission.default' };
        }
      }
      if (toolName === 'run_bash') {
        const command = (input.command as string) || '';
        if (isWriteBash(command)) {
          return { behavior: 'deny', reason: 'Plan mode blocks write bash commands', reason_code: 'permission.plan_write_blocked' };
        }
        return { behavior: 'allow', reason: 'Plan mode allows read-only bash commands', reason_code: 'permission.default' };
      }
      if (WRITE_TOOLS.includes(toolName)) {
        return { behavior: 'deny', reason: 'Plan mode blocks write operations', reason_code: 'permission.plan_write_blocked' };
      }
      return { behavior: 'allow', reason: 'Plan mode allows read operations', reason_code: 'permission.default' };
    }

    if (evaluationMode === 'acceptEdits' || evaluationMode === 'bypassPermissions') {
      // discretionary allow：普通写放行（受保护设置已在闸门 3d 拦截）
      if (toolName === 'run_bash') {
        // 写 bash 仍按 acceptEdits 放行（plan 才拦）；bypassPermissions 同样
        return { behavior: 'allow', reason: `${evaluationMode} allows this operation`, reason_code: 'permission.default' };
      }
      if (FILE_WRITE_TOOLS.has(toolName) || WRITE_TOOLS.includes(toolName)) {
        return { behavior: 'allow', reason: `${evaluationMode} allows write operations`, reason_code: 'permission.default' };
      }
      // 非写工具继续走 ordinary allow / 兜底
    }

    // build / auto：auto 不再有特殊无条件 allow，与 build 同流程（A15）

    // ── 闸门 5：ordinary allow 规则 ──
    for (const rule of this.rules) {
      if (rule.behavior === 'allow' && this.ruleMatchesWithSubcommands(rule, toolName, input)) {
        return { behavior: 'allow', reason: `Matched allow rule (tool=${rule.tool})`, reason_code: 'permission.rule_allow' };
      }
    }

    // ── 闸门 6：delegation / read-only 默认 allow（build/auto） ──
    if (DELEGATION_TOOLS.includes(toolName)) {
      return { behavior: 'allow', reason: 'Delegation tools are allowed by default in build mode', reason_code: 'permission.default' };
    }
    if (READ_ONLY_TOOLS.includes(toolName)) {
      return { behavior: 'allow', reason: 'Read operations are safe by default', reason_code: 'permission.default' };
    }

    // ── 兜底：未决写 → ask（A15）──
    return { behavior: 'ask', reason: 'Write operation needs user confirmation', reason_code: 'permission.user_confirmation_required' };
  }

  /**
   * 规则匹配（含 compound bash 子命令逐一匹配，A10）。
   *
   * 对 run_bash，命令可能含 `&&` / `;` / `|` 连接的多个子命令；
   * 任一子命令命中规则即视为整命令命中（compound 任一 deny -> 整命令 deny）。
   * 非 run_bash 工具直接用 matchesRule。
   */
  private ruleMatchesWithSubcommands(
    rule: PermissionRule,
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    if (toolName !== 'run_bash' || rule.tool !== 'run_bash') {
      return matchesRule(rule, toolName, input);
    }
    const command = (input.command as string) || '';
    // 先整体匹配
    if (matchesRule(rule, toolName, input)) return true;
    // 拆分 compound 子命令，逐一匹配
    const subcommands = command.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean);
    for (const sub of subcommands) {
      if (matchesRule(rule, toolName, { command: sub })) return true;
    }
    return false;
  }

  /**
   * 结构化决策：返回 SecurityDecision（RC-5, spec §11）。
   *
   * 与 legacy `check()` 的关系：
   *   - 复用同一个四步管道（调 `this.check()`），绝不重复实现；
   *   - 把 legacy `{ behavior, reason }` 映射成 `SecurityDecision`。
   *
   * 不变量：
   *   1. 不在内部生成随机 ID —— snapshot_id / decision_id / policy_id / policy_version
   *      全部来自 `context`；
   *   2. reason_code 是稳定机器码（不是 reason 字符串本身）；
   *   3. human_reason 直接取 legacy reason，但本方法绝不基于 human_reason 做分支；
   *   4. 输出 NEVER 含 approved 字段（Wave A 不实现 ask 通道）。
   *
   * @param toolName  工具名
   * @param input     工具输入（与 check() 完全相同）
   * @param context   身份字段：decision_id / action_snapshot_id / policy_id / policy_version
   */
  checkDecision(
    toolName: string,
    input: Record<string, unknown>,
    context: {
      decision_id: string;
      action_snapshot_id: string;
      policy_id: string;
      policy_version: string;
    },
  ): SecurityDecision {
    // 1. 复用 legacy 四步管道——绝不重复实现规则评估
    const legacy = this.check(toolName, input);

    // 2. 映射 legacy → 稳定 (reason_code, risk_kind, deciding_layer)
    //    直读 legacy.reason_code(check() 每个 return 同源产出);risk_kind/deciding_layer
    //    按对照表查 META。不再用子串匹配 reason 文本。
    const mapped = mapLegacyReason(legacy);

    // 3. provenance：规则匹配的派生信息不易在 check() 外拿到（check() 只返回 reason），
    //    所以这里用稳定占位 'permission:rules'；非规则匹配的默认走 'permission:builtin''。
    //    allow 必须有 provenance（spec §11.6.5），所以 allow 永远带非空 provenance。
    const provenance =
      legacy.behavior === 'allow'
        ? ['permission:rules']
        : mapped.reasonCode === 'permission.default'
          ? ['permission:builtin']
          : ['permission:rules'];

    // 4. 构造结构化决策单（createSecurityDecision 内部做 deep copy + freeze）
    return createSecurityDecision({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: context.decision_id,
      action: {
        kind: 'tool_call',
        subject_id: toolName,
        snapshot_id: context.action_snapshot_id,
      },
      behavior: legacy.behavior,
      deciding_layer: mapped.decidingLayer,
      risk_kind: mapped.riskKind,
      policy_id: context.policy_id,
      policy_version: context.policy_version,
      reason_code: mapped.reasonCode,
      human_reason: legacy.reason,
      provenance_refs: provenance,
    });
  }
}

/**
 * 直读 PermissionDecision.reason_code(由 check() 同源产出)。
 *
 * 不再用子串匹配 reason 文本——check() 现在每个 return 直接带 reason_code,
 * 本函数只透传 + 按对照表补 risk_kind/deciding_layer。
 * risk_kind/deciding_layer 保持现有审计语义(见对照表),禁止用 reason_code.split 重算。
 */
function mapLegacyReason(legacy: PermissionDecision): {
  reasonCode: string;
  riskKind: string;
  decidingLayer: string;
} {
  const rc = legacy.reason_code;
  // 仅给"有独立审计语义"的码补 risk_kind/deciding_layer;其余统一 default。
  // 对照 security-decision-integration.test.ts 已锁定的值。
  const META: Record<string, { riskKind: string; decidingLayer: string }> = {
    'permission.dangerous_command': { riskKind: 'dangerous_command', decidingLayer: 'command' },
    'permission.path_outside_workspace': { riskKind: 'path_violation', decidingLayer: 'path' },
    'permission.command_unparseable': { riskKind: 'unparseable_command', decidingLayer: 'command' },
    'permission.command_unresolvable_var': { riskKind: 'unresolvable_variable', decidingLayer: 'command' },
    'permission.plan_write_blocked': { riskKind: 'mode_violation', decidingLayer: 'permission' },
    'permission.rule_deny': { riskKind: 'rule_deny', decidingLayer: 'permission' },
    'permission.rule_allow': { riskKind: 'rule_allow', decidingLayer: 'permission' },
    'permission.user_confirmation_required': { riskKind: 'workspace_mutation', decidingLayer: 'permission' },
  };
  const meta = META[rc] ?? { riskKind: 'default', decidingLayer: 'permission' };
  return { reasonCode: rc, riskKind: meta.riskKind, decidingLayer: meta.decidingLayer };
}
