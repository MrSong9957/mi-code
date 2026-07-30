// src/cli/format-error.ts
// 错误消息展示格式化（从 index.ts 抽出的纯函数，便于 TDD 测试）
//
// 物理本质：错误信息的「裁缝」。
// 原始错误对象像一团乱麻（含堆栈、内部字段），本函数把它裁成干净的一行文字，
// 只保留用户需要看到的核心信息（message），丢掉调试用的堆栈。
//
// 实现已委托给共享工具 src/utils/error-message.ts 的 formatUnknownError，
// 保留本导出仅为兼容现有 import 路径（src/index.ts）。新代码应直接 import 共享函数。

import { formatUnknownError } from '../utils/error-message.js';

/**
 * 把任意错误值格式化为干净的展示字符串。
 *
 * - Error 实例 → .message（不含堆栈）；.message 为空时退化为 .name
 * - 普通对象 → JSON 序列化（脱敏 + 循环引用保护）
 * - 其它 → String(value)
 * - 超过 300 字符 → 截断 + …
 *
 * @param err 任意错误值（unknown）
 * @returns 干净的展示字符串
 */
export function formatErrorForDisplay(err: unknown): string {
  return formatUnknownError(err);
}
