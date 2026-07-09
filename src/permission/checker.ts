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

/** PermissionChecker 构造参数 */
export interface PermissionCheckerOptions {
  mode?: PermissionMode;
  rules?: PermissionRule[];
  workdir?: string;
  /** plan 模式下唯一允许写入的目录（plan 文件白名单） */
  planDir?: string;
}

/** 文件写入类工具（用于路径越界预检） */
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export class PermissionChecker {
  private mode: PermissionMode;
  private rules: PermissionRule[];
  private workdir: string;
  private planDir: string | null;

  constructor(options: PermissionCheckerOptions = {}) {
    this.mode = options.mode ?? 'build';
    this.rules = options.rules ? [...options.rules] : [];
    this.workdir = options.workdir ?? process.cwd();
    this.planDir = options.planDir ?? null;
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
    // ── 闸门 1：硬 deny（内置安全策略，不可被规则/模式绕过） ──
    if (toolName === 'run_bash') {
      const command = (input.command as string) || '';
      if (isDangerousBash(command)) {
        return { behavior: 'deny', reason: 'Dangerous command blocked by built-in policy' };
      }
    }
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const filePath = (input.path as string) || '';
      if (filePath && isPathOutsideWorkspace(filePath, this.workdir)) {
        return { behavior: 'deny', reason: 'Writing outside workspace is blocked by built-in policy' };
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
}
