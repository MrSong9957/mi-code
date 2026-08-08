// formatUnknownError 本地化测试（RED → GREEN）
//
// 验证：
// 1. 传入 translator 时，'[Unserializable error object]' marker 跟随语言本地化
// 2. raw 错误文本（Error.message）保持不变
// 3. 不传 translator 时（向后兼容）保持英文默认 marker
// 4. [REDACTED] / [Circular] 技术标记不本地化

import { describe, expect, it } from 'vitest';
import { formatUnknownError } from '../../utils/error-message.js';
import { createLanguageStore, createTranslator } from '../../locale/index.js';

describe('formatUnknownError 本地化', () => {
  it('传入中文 translator 时，序列化失败 marker 本地化为中文', () => {
    const translator = createTranslator(createLanguageStore('zh-CN'));
    // BigInt 无法 JSON 序列化 → 触发 fallback marker
    const output = formatUnknownError({ value: 1n }, undefined, translator);
    expect(output).toContain('[无法序列化的错误对象]');
    expect(output).not.toContain('[Unserializable error object]');
  });

  it('传入英文 translator 时，marker 保持英文', () => {
    const translator = createTranslator(createLanguageStore('en-US'));
    const output = formatUnknownError({ value: 1n }, undefined, translator);
    expect(output).toContain('[Unserializable error object]');
  });

  it('不传 translator 时保持英文默认 marker（向后兼容）', () => {
    const output = formatUnknownError({ value: 1n });
    expect(output).toBe('[Unserializable error object]');
  });

  it('raw Error.message 保持不变（不本地化）', () => {
    const translator = createTranslator(createLanguageStore('zh-CN'));
    const output = formatUnknownError(new Error('denied'), undefined, translator);
    expect(output).toBe('denied');
  });

  it('toJSON 返回 undefined 时同样本地化 marker', () => {
    const translator = createTranslator(createLanguageStore('zh-CN'));
    const output = formatUnknownError({ toJSON() { return undefined; } }, undefined, translator);
    expect(output).toContain('[无法序列化的错误对象]');
  });

  it('技术标记 [REDACTED] / [Circular] 不本地化', () => {
    const translator = createTranslator(createLanguageStore('zh-CN'));
    // 循环引用 → [Circular] 必须保持英文技术标记
    const value: Record<string, unknown> = { status: 503 };
    value.self = value;
    const output = formatUnknownError(value, undefined, translator);
    expect(output).toContain('[Circular]');
    // 敏感字段 → [REDACTED] 必须保持英文技术标记
    const redacted = formatUnknownError({ apiKey: 'secret-value' }, undefined, translator);
    expect(redacted).toContain('[REDACTED]');
  });
});
