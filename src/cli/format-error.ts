// src/cli/format-error.ts
// 错误消息展示格式化（从 index.ts 抽出的纯函数，便于 TDD 测试）
//
// 物理本质：错误信息的「裁缝」。
// 原始错误对象像一团乱麻（含堆栈、内部字段），本函数把它裁成干净的一行文字，
// 只保留用户需要看到的核心信息（message），丢掉调试用的堆栈。
//
// 防御边界：
// - Error 实例：取 .message（丢掉堆栈），空 message 时退化为 .name
// - 超长字符串：截断到 MAX_LEN + …，防止屏幕被刷屏
// - 非 Error 值（字符串/对象/null）：String() 强转后截断

/** 错误展示的最大长度（超出截断为 …） */
const MAX_ERROR_DISPLAY_LEN = 300;

/**
 * 把任意错误值格式化为干净的展示字符串。
 *
 * - Error 实例 → .message（不含堆栈）；.message 为空时退化为 .name
 * - 其它 → String(value)
 * - 超过 MAX_ERROR_DISPLAY_LEN 字符 → 截断 + …
 *
 * @param err 任意错误值（unknown）
 * @returns 干净的展示字符串
 */
export function formatErrorForDisplay(err: unknown): string {
  let message: string;
  if (err instanceof Error) {
    // 只取 message，丢弃 .stack（堆栈是给开发者调试的，不该刷屏用户终端）
    message = err.message || err.name;
  } else {
    message = String(err);
  }
  if (message.length > MAX_ERROR_DISPLAY_LEN) {
    return message.slice(0, MAX_ERROR_DISPLAY_LEN) + '…';
  }
  return message;
}
