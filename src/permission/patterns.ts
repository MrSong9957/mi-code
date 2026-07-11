// 权限匹配工具与共享常量
//
// 物理本质：安检员的工具箱。
// - 危险命令清单（黑名单对照表）
// - glob 模式匹配器（查通行证）
// - 路径围栏检测器（看有没有翻墙）
//
// 此模块是危险命令模式的唯一来源，permission/checker.ts 与 hooks/builtins.ts 共享。

import { resolve, sep } from 'path';
import type { PermissionRule } from './types.js';
import { normalizeBashForCheck } from './bash-normalize.js';

/** 危险 bash 命令模式（单一来源，permission 与 hooks 共享） */
export const DANGEROUS_BASH_PATTERNS = [
  /sudo\s/,
  /rm\s+-rf/,
  /\$\(/, // 命令替换
  /`[^`]+`/, // 反引号命令替换
  />\s*\/etc\//, // 写入系统目录
  /mkfs/,
  /dd\s+/,
  /:\(\)\{ :\|:& \};/, // fork bomb（括号必须转义为字面量，否则 () 被当成捕获组）
];

/**
 * 检测 bash 命令是否命中危险模式
 *
 * 双层防御（Phase 3 归一化检测）：
 *   ① 对原始 command 跑正则（保留旧行为，不破坏现有测试）
 *   ② 对归一化后的 command 跑正则（消除引号拼接混淆：'r''m' → rm）
 *
 * 物理本质：安检员既看原始标签，也看拼回原样后的内容。
 * 任一层命中即危险。
 *
 * 此函数被 checker.ts（闸门1）与 hooks/builtins.ts（PreToolUse）共享调用，
 * 两处都自动获得归一化能力——单点修改，两处生效。
 */
export function isDangerousBash(command: string): boolean {
  if (DANGEROUS_BASH_PATTERNS.some((p) => p.test(command))) return true;
  const normalized = normalizeBashForCheck(command);
  if (normalized !== command) {
    return DANGEROUS_BASH_PATTERNS.some((p) => p.test(normalized));
  }
  return false;
}

/**
 * 写操作 bash 命令模式（plan 模式 / 子代理只读角色下要拦的写动作）
 *
 * 物理：所有"会留下文件痕迹"的命令——创建/删除/复制/移动文件、改权限、
 * 改 git 状态、装包、重定向写入、原地修改、dd 写盘。即使命令本身不"危险"，
 * 在 plan 模式或 explore 角色子代理中也不应执行。
 *
 * 这是跨模式的硬规则（在 PermissionChecker 闸门 1 拦截），与 mode 无关。
 * 由 isWriteBash 检测，与 DANGEROUS_BASH（极端破坏）区分开。
 */
export const WRITE_BASH_PATTERNS = [
  /\bmkdir\b/,                                                              // 创建目录
  /\btouch\b/,                                                              // 创建文件
  /\brm\b/,                                                                 // 删除（含单文件）
  /\bcp\b/,                                                                 // 复制
  /\bmv\b/,                                                                 // 移动/重命名
  /\bchmod\b/,                                                              // 改权限
  /\bchown\b/,                                                              // 改所有者
  /\bgit\s+(add|commit|push|pull|merge|rebase|checkout|reset|stash|rm|mv)\b/, // git 写操作
  /\bnpm\s+(install|publish|uninstall|i\s|add|remove)\b/,                   // npm 改包
  /\byarn\s+(add|remove|install|publish)\b/,
  /\bpnpm\s+(add|remove|install)\b/,
  /\bpip3?\s+install\b/,
  />\s*\S/,                                                                 // 输出重定向（>file、>>file）
  /\|\s*tee\b/,                                                             // tee 写文件
  /\bsed\s+(-i|--in-place)\b/,                                              // sed 原地修改
  /\bawk\s+.*\binplace\b/,                                                  // GNU awk inplace（-i inplace）
  /\bperl\s+-i\b/,                                                          // perl 原地修改
  /\btruncate\s+-s\b/,                                                      // truncate 截断文件
  /\binstall\s+-m\b/,                                                       // install 命令（设权限装文件）
];

/** 检测 bash 命令是否包含写操作（plan 模式 / 只读子代理角色用） */
export function isWriteBash(command: string): boolean {
  return WRITE_BASH_PATTERNS.some((p) => p.test(command));
}

/**
 * 将简单 glob 模式转换为正则表达式
 *
 * 支持的通配符：
 * - `*` 匹配任意字符（含分隔符）
 * - `?` 匹配单个字符
 * - 其余字符按字面量转义
 *
 * 物理本质：把"模糊描述"翻译成"精确规则"。
 */
export function globToRegex(pattern: string): RegExp {
  let regex = '';
  for (const ch of pattern) {
    if (ch === '*') regex += '.*';
    else if (ch === '?') regex += '.';
    else regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${regex}$`);
}

/** 检查路径是否在指定工作目录之外（含 `..` 穿越检测） */
export function isPathOutsideWorkspace(filePath: string, workdir: string): boolean {
  const resolved = resolve(workdir, filePath);
  const normalizedWorkdir = resolve(workdir);
  // 统一用平台尾部分隔符比较，避免 /a/b 误判 /a/bb 为内部
  const prefix = normalizedWorkdir.endsWith(sep) ? normalizedWorkdir : normalizedWorkdir + sep;
  return resolved !== normalizedWorkdir && !resolved.startsWith(prefix);
}

/**
 * 判断一条权限规则是否匹配当前工具调用
 *
 * 匹配逻辑：
 * 1. rule.tool 必须精确等于 toolName
 * 2. rule.path（若有）：glob 匹配 input.path
 * 3. rule.content（如有）：glob 匹配 input.command（bash）或 input.content
 *
 * 未指定 path/content 的规则只按 tool 匹配（覆盖该工具所有调用）。
 */
export function matchesRule(
  rule: PermissionRule,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (rule.tool !== toolName) return false;

  // path 字段匹配 input.path
  if (rule.path !== undefined) {
    const target = (input.path as string) || '';
    if (!globToRegex(rule.path).test(target)) return false;
  }

  // content 字段匹配 input.command（bash）或 input.content
  if (rule.content !== undefined) {
    const target = (input.command as string) || (input.content as string) || '';
    if (!globToRegex(rule.content).test(target)) return false;
  }

  return true;
}
