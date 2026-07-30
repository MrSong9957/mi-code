// 共享错误格式化：把任意 thrown value 安全、脱敏、限长地转成单行文本。
//
// 物理本质：错误信息的"安检通道"。
// 上游可能抛出任何形态（Error / 普通对象 / 字符串 / 循环引用 / 含敏感字段），
// 本函数统一裁成一条干净、不泄露机密、长度可控的诊断文本，
// 供 UI 展示、错误事件投递、子代理回执等所有"错误文本边界"复用。

const DEFAULT_MAX_LENGTH = 300;

/**
 * 敏感字段名（大小写不敏感，支持 snake/kebab/camel 三种命名）。
 * 命中即替换为 [REDACTED]，禁止把密钥/凭证/cookie 写进用户可见文本。
 */
const SENSITIVE_FIELD = /^(?:apiKey|api_key|api-key|authorization|token|accessToken|access_token|access-token|refreshToken|refresh_token|refresh-token|password|privateKey|private_key|private-key|secret|clientSecret|client_secret|client-secret|(?:set-)?cookie)$/i;

/**
 * 把普通对象序列化为 JSON 文本。
 * - 命中敏感字段的值 → '[REDACTED]'
 * - 检测到循环引用 → '[Circular]'
 * - JSON.stringify 失败（如 BigInt）或返回 undefined → 抛错由上层兜底
 */
function serializeObject(value: object): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (key, nested) => {
    if (key && SENSITIVE_FIELD.test(key)) return '[REDACTED]';
    if (typeof nested === 'object' && nested !== null) {
      if (seen.has(nested)) return '[Circular]';
      seen.add(nested);
    }
    return nested;
  });
  return serialized ?? '[Unserializable error object]';
}

/**
 * 把任意 thrown value 格式化为安全、脱敏、限长的展示字符串。
 *
 * - Error 实例 → .message（不含堆栈）；.message 为空时退化为 .name
 * - 字符串 → 原样
 * - 普通对象 → JSON 序列化（脱敏 + 循环引用保护）；序列化失败 → '[Unserializable error object]'
 * - 其它（number / boolean / null / undefined）→ String(value)
 * - 超过 maxLength 字符 → 截断 + '…'
 *
 * @param error 任意 thrown value
 * @param maxLength 最大字符数（默认 300）；非法值回退到默认
 */
export function formatUnknownError(
  error: unknown,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string {
  let message: string;
  if (error instanceof Error) {
    message = error.message || error.name;
  } else if (typeof error === 'string') {
    message = error;
  } else if (typeof error === 'object' && error !== null) {
    try {
      message = serializeObject(error);
    } catch {
      message = '[Unserializable error object]';
    }
  } else {
    message = String(error);
  }

  const safeMaxLength = Number.isFinite(maxLength)
    ? Math.max(0, Math.floor(maxLength))
    : DEFAULT_MAX_LENGTH;
  return message.length > safeMaxLength
    ? `${message.slice(0, safeMaxLength)}…`
    : message;
}
