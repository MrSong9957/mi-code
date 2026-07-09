// formatErrorForDisplay 测试（RED 阶段）
//
// 验证错误展示格式化的核心契约：
// 1. Error 实例只取 .message（不含堆栈）
// 2. 空 message 退化为 .name
// 3. 超长字符串截断到 300 + …
// 4. 非 Error 值安全转字符串

import { describe, it, expect } from 'vitest';
import { formatErrorForDisplay } from '../../cli/format-error.js';

describe('formatErrorForDisplay', () => {
  it('Error 实例只取 message，不含堆栈', () => {
    const err = new Error('Invalid API Key');
    const result = formatErrorForDisplay(err);
    expect(result).toBe('Invalid API Key');
    // 关键：不含堆栈（at Object.<anonymous> ...）
    expect(result).not.toContain('at ');
    expect(result).not.toContain('Error: Invalid API Key');
  });

  it('Error 含 ERR_UNHANDLED_ERROR 时只显示 message', () => {
    // 模拟用户遇到的错误形态
    const err = new Error("401 {\"error\":{\"message\":\"Invalid API Key\"}}");
    const result = formatErrorForDisplay(err);
    expect(result).toBe("401 {\"error\":{\"message\":\"Invalid API Key\"}}");
    expect(result).not.toContain('ERR_UNHANDLED_ERROR');
    expect(result).not.toContain('\n    at');
  });

  it('空 message 的 Error 退化为 name', () => {
    const err = new Error('');
    const result = formatErrorForDisplay(err);
    expect(result).toBe('Error');
  });

  it('超长字符串截断到 300 字符 + …', () => {
    const longMessage = 'x'.repeat(500);
    const err = new Error(longMessage);
    const result = formatErrorForDisplay(err);
    expect(result.length).toBe(301); // 300 + …（单字符）
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('x'.repeat(300))).toBe(true);
  });

  it('非 Error 字符串值安全转字符串', () => {
    expect(formatErrorForDisplay('plain string')).toBe('plain string');
    expect(formatErrorForDisplay(42)).toBe('42');
  });

  it('null/undefined 安全处理', () => {
    expect(formatErrorForDisplay(null)).toBe('null');
    expect(formatErrorForDisplay(undefined)).toBe('undefined');
  });

  it('刚好 300 字符不截断（边界）', () => {
    const exact = 'y'.repeat(300);
    const err = new Error(exact);
    const result = formatErrorForDisplay(err);
    expect(result).toBe(exact);
    expect(result).not.toContain('…');
  });
});
