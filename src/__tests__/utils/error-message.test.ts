import { describe, expect, it } from 'vitest';
import { formatUnknownError } from '../../utils/error-message.js';

describe('formatUnknownError', () => {
  it('保留 Error message 且不输出 stack', () => {
    const output = formatUnknownError(new Error('Invalid API Key'));
    expect(output).toBe('Invalid API Key');
    expect(output).not.toContain(' at ');
  });

  it('序列化 provider 普通对象并保留分类字段', () => {
    const output = formatUnknownError({
      status: 429,
      code: 'rate_limit_exceeded',
      error: { message: 'Too many requests' },
    });
    expect(output).toContain('"status":429');
    expect(output).toContain('rate_limit_exceeded');
    expect(output).toContain('Too many requests');
    expect(output).not.toBe('[object Object]');
  });

  it('循环引用不会抛异常', () => {
    const value: Record<string, unknown> = { status: 503 };
    value.self = value;
    expect(formatUnknownError(value)).toContain('[Circular]');
  });

  it.each([
    'apiKey',
    'api_key',
    'authorization',
    'token',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'password',
    'privateKey',
    'private_key',
    'secret',
    'clientSecret',
    'client_secret',
    'cookie',
    'set-cookie',
  ])('脱敏敏感字段 %s', (key) => {
    const output = formatUnknownError({ status: 401, [key]: 'sensitive-value' });
    expect(output).not.toContain('sensitive-value');
    expect(output).toContain('[REDACTED]');
  });

  it('对象无法产生 JSON 文本时使用稳定 fallback', () => {
    const noJsonOutput = formatUnknownError({
      toJSON() {
        return undefined;
      },
    });
    const serializationFailure = formatUnknownError({ value: 1n });

    expect(noJsonOutput).toBe('[Unserializable error object]');
    expect(serializationFailure).toBe('[Unserializable error object]');
    expect(noJsonOutput).not.toBe('[object Object]');
    expect(serializationFailure).not.toBe('[object Object]');
  });

  it('默认截断到 300 字符加省略号', () => {
    const output = formatUnknownError({ message: 'x'.repeat(500) });
    expect(output).toHaveLength(301);
    expect(output.endsWith('…')).toBe(true);
  });

  it('尊重自定义 maxLength', () => {
    const output = formatUnknownError('x'.repeat(100), 50);
    expect(output).toBe(`${'x'.repeat(50)}…`);
    expect(output).toHaveLength(51);
  });
});
