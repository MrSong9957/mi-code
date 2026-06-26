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

/** 危险 bash 命令模式（单一来源，permission 与 hooks 共享） */
export const DANGEROUS_BASH_PATTERNS = [
  /sudo\s/,
  /rm\s+-rf/,
  /\$\(/, // 命令替换
  /`[^`]+`/, // 反引号命令替换
  />\s*\/etc\//, // 写入系统目录
  /mkfs/,
  /dd\s+/,
  /:(){ :\|:& };/, // fork bomb
];

/** 检测 bash 命令是否命中危险模式 */
export function isDangerousBash(command: string): boolean {
  return DANGEROUS_BASH_PATTERNS.some((p) => p.test(command));
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
