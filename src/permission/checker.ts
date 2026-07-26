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
import { WRITE_TOOLS, READ_ONLY_TOOLS } from './types.js';
import { isDangerousBash, isWriteBash, isPathOutsideWorkspace, matchesRule } from './patterns.js';
import { extractBashPaths } from './bash-paths.js';
import {
  createSecurityDecision,
  SECURITY_PROTOCOL_VERSION,
  type SecurityDecision,
} from './decisions.js';

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
    controlMode: PermissionMode,
  ) => 'allow' | 'ask' | 'deny' | null;
}

/** 文件写入类工具（用于路径越界预检 + plan 目录白名单） */
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/** 带路径的文件类工具（闸门 1 越界预检：读+写统一硬拦截） */
const FILE_PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

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
   * 检查权限：四步管道
   *
   * 返回 { behavior, reason }：
   * - deny：调用方直接拦截，不执行
   * - ask：调用方应询问用户
   * - allow：直接执行
   */
  check(toolName: string, input: Record<string, unknown>): PermissionDecision {
    // ── 闸门 0：Wave D Task 14 (M-064 / DRC-5) Command Structural Policy ──
    //
    // 物理本质: "安检前的 X 光机"。在现有 4 步管道之前, 对 run_bash 做结构化 AST
    // policy 检查。这是最严格的前置门:
    //   - hook 返回 'deny'/'ask' → 直接返回(不进入后续管道, 更严格)
    //   - hook 返回 'allow'/null → 继续走原 4 步管道(hook 不放松硬门)
    //
    // hook 由调用方提供(负责构造 CommandPolicyEvaluationInput + 调用
    // composeCommandStructuralDecision)。不传时 LEGACY 跳过, 4 步管道行为不变。
    // 生产路径在 DRC-5 Activation Gate 通过后传入此 hook。
    if (this.commandPolicyHook && toolName === 'run_bash') {
      const command = (input.command as string) || '';
      const astBehavior = this.commandPolicyHook(command, this.mode);
      if (astBehavior === 'deny') {
        return { behavior: 'deny', reason: 'Command structural policy denied (AST gate)' };
      }
      if (astBehavior === 'ask') {
        return { behavior: 'ask', reason: 'Command structural policy requires review (AST gate)' };
      }
      // 'allow' 或 null: 继续走原管道(不放松硬门)
    }

    // ── 闸门 1：硬 deny（内置安全策略，不可被规则/模式绕过） ──
    if (toolName === 'run_bash') {
      const command = (input.command as string) || '';
      // 1a. 危险命令黑名单（sudo/rm-rf/$()/fork bomb...）
      if (isDangerousBash(command)) {
        return { behavior: 'deny', reason: 'Dangerous command blocked by built-in policy' };
      }
      // 1b. 路径围栏（Phase 1：解析 + 路径越界检测）
      // 解析命令里的路径参数，发现指向工作区外的 → deny；
      // 解析失败/变量未知 → ask（不自动放行，升级人审）。
      const { paths, parseFailed, unresolvableVars } = extractBashPaths(command);
      if (parseFailed) {
        return { behavior: 'ask', reason: 'Bash command unparseable, needs review' };
      }
      if (unresolvableVars) {
        return { behavior: 'ask', reason: 'Bash command has unresolvable variable, needs review' };
      }
      for (const p of paths) {
        if (isPathOutsideWorkspace(p, this.workdir)) {
          return { behavior: 'deny', reason: `Bash touches path outside workspace: ${p}` };
        }
      }
    }
    if (FILE_PATH_TOOLS.has(toolName)) {
      const filePath = (input.path as string) || '';
      if (filePath && isPathOutsideWorkspace(filePath, this.workdir)) {
        const op = toolName === 'read_file' ? 'Reading' : 'Writing';
        return { behavior: 'deny', reason: `${op} outside workspace is blocked by built-in policy` };
      }
    }

    // ── 闸门 2：用户 deny 规则 ──
    for (const rule of this.rules) {
      if (rule.behavior === 'deny' && matchesRule(rule, toolName, input)) {
        return { behavior: 'deny', reason: `Matched deny rule (tool=${rule.tool})` };
      }
    }

    // ── 闸门 3：模式检查 ──
    if (this.mode === 'plan') {
      // plan 目录白名单：write_file/edit_file 目标在 planDir 内则放行
      // （让 AI 能用 write_file 写 plan 文件，但不能写其它）
      if (FILE_WRITE_TOOLS.has(toolName) && this.planDir) {
        const filePath = (input.path as string) || '';
        if (filePath && !isPathOutsideWorkspace(filePath, this.planDir)) {
          return { behavior: 'allow', reason: 'Plan mode allows writing inside plan dir' };
        }
      }
      // run_bash 精细判定：写命令（mkdir/echo>/git commit/...）deny，只读命令（ls/cat/grep）allow
      // 这是 plan 模式与 explore 角色子代理的核心：允许只读探索，但拦任何文件改动。
      if (toolName === 'run_bash') {
        const command = (input.command as string) || '';
        if (isWriteBash(command)) {
          return { behavior: 'deny', reason: 'Plan mode blocks write bash commands' };
        }
        return { behavior: 'allow', reason: 'Plan mode allows read-only bash commands' };
      }
      if (WRITE_TOOLS.includes(toolName)) {
        return { behavior: 'deny', reason: 'Plan mode blocks write operations' };
      }
      return { behavior: 'allow', reason: 'Plan mode allows read operations' };
    }

    if (this.mode === 'auto') {
      // auto 模式：危险命令已在闸门1挡住，其余自动放行
      return { behavior: 'allow', reason: 'Auto mode allows this operation' };
    }

    // ── 闸门 4：用户 allow 规则 ──
    for (const rule of this.rules) {
      if (rule.behavior === 'allow' && matchesRule(rule, toolName, input)) {
        return { behavior: 'allow', reason: `Matched allow rule (tool=${rule.tool})` };
      }
    }

    // ── 默认行为（default 模式未命中规则时） ──
    // 用户 ask 规则显式要求确认
    for (const rule of this.rules) {
      if (rule.behavior === 'ask' && matchesRule(rule, toolName, input)) {
        return { behavior: 'ask', reason: `Matched ask rule (tool=${rule.tool})` };
      }
    }

    if (READ_ONLY_TOOLS.includes(toolName)) {
      return { behavior: 'allow', reason: 'Read operations are safe by default' };
    }

    // 写操作需用户确认
    return { behavior: 'ask', reason: 'Write operation needs user confirmation' };
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

    // 2. 映射 legacy.reason → 稳定 (reason_code, risk_kind, deciding_layer)
    //    用大小写不敏感的子串匹配；顺序敏感（先匹配更具体的危险类）。
    const mapped = mapLegacyReason(legacy.reason);

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
 * 把 legacy check() 的自由文本 reason 映射成稳定机器码（spec §11.7）。
 *
 * 注意：用大小写不敏感的子串匹配；顺序敏感——危险类必须先于通用类匹配。
 * human_reason 保留原文本，但不参与本函数的任何分支判断（这里只看 reason 字符串本身，
 * 不看 human_reason；分支依据是 reason_code 而非 reason 文本）。
 */
function mapLegacyReason(reason: string): {
  reasonCode: string;
  riskKind: string;
  decidingLayer: string;
} {
  const r = reason.toLowerCase();
  // 顺序敏感：危险命令 → 路径 → 不可解析 → plan → deny 规则 → allow 规则 → user 确认 → 默认
  if (r.includes('dangerous command')) {
    return {
      reasonCode: 'permission.dangerous_command',
      riskKind: 'dangerous_command',
      decidingLayer: 'command',
    };
  }
  if (r.includes('outside')) {
    return {
      reasonCode: 'permission.path_outside_workspace',
      riskKind: 'path_violation',
      decidingLayer: 'path',
    };
  }
  if (r.includes('unparseable') || r.includes('cannot parse')) {
    return {
      reasonCode: 'permission.command_unparseable',
      riskKind: 'unparseable_command',
      decidingLayer: 'command',
    };
  }
  if (r.includes('plan mode')) {
    return {
      reasonCode: 'permission.plan_write_blocked',
      riskKind: 'mode_violation',
      decidingLayer: 'permission',
    };
  }
  if (r.includes('deny rule')) {
    return {
      reasonCode: 'permission.rule_deny',
      riskKind: 'rule_deny',
      decidingLayer: 'permission',
    };
  }
  if (r.includes('allow rule')) {
    return {
      reasonCode: 'permission.rule_allow',
      riskKind: 'rule_allow',
      decidingLayer: 'permission',
    };
  }
  if (r.includes('user confirmation') || r.includes('write operation')) {
    return {
      reasonCode: 'permission.user_confirmation_required',
      riskKind: 'workspace_mutation',
      decidingLayer: 'permission',
    };
  }
  return {
    reasonCode: 'permission.default',
    riskKind: 'default',
    decidingLayer: 'permission',
  };
}
