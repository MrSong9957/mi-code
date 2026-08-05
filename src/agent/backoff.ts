// 退避策略：防止重试风暴
//
// 物理本质：堵车时的"交替放行"。
// 第 1 次重试等 1 秒，第 2 次等 2 秒，第 3 次等 4 秒……
// 加上随机抖动（jitter），防止 100 个子代理同时重试引发二次踩踏。
//
// Task 11（设计 §9 / A57-A63）：共享 API retry policy。
//   - getRetryDelay：base cap 32000ms，jitter 后 [base, base*1.25)，
//     Retry-After 非负时优先。
//   - isRetryableApiError：529/429/overload 可重试；400 context overflow 可重试；
//     AbortError 永不重试；其余 4xx/5xx 不可重试。
//   - RetrySleeper：signal abort 时 wait 立即 reject AbortError。
//   classifier 与 foreground 共用 delay/error policy，但 classifier retry 固定
//   复用同一已绑定 ModelRef，永不跨模型 fallback。

/** 基础延迟（毫秒） */
const BASE_DELAY_MS = 1000;

/** 最大 base 延迟（毫秒）——设计 §9 A59：base cap 32000ms */
const MAX_BASE_DELAY_MS = 32_000;

/** 旧 API 兼容：保留 30000ms 作为 jitteredBackoff 上限（不破坏既有调用） */
const MAX_DELAY_MS = 30_000;

/**
 * 基础指数退避：2^attempt * 1000ms（旧 API，cap 30000ms）
 *
 * attempt=0 → 1s, attempt=1 → 2s, attempt=2 → 4s
 */
export function exponentialBackoff(attempt: number): number {
  const delay = Math.pow(2, attempt) * BASE_DELAY_MS;
  return Math.min(delay, MAX_DELAY_MS);
}

/**
 * 带抖动的指数退避（Full Jitter）
 *
 * 物理本质：堵车放行时，每辆车随机等 0 到理论延迟之间的时间。
 * 这样 100 个请求不会在同一瞬间涌出，而是分散在时间窗口内。
 *
 * 公式：random(0, 2^attempt * baseDelay)
 */
export function jitteredBackoff(attempt: number): number {
  const maxDelay = exponentialBackoff(attempt);
  return Math.floor(Math.random() * maxDelay);
}

/**
 * 延迟执行
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Task 11: 共享 API retry policy（设计 §9 / A57-A63） ─────────────────────

/**
 * 计算 retry delay（设计 §9 A59）。
 *
 * 公式：
 *   base = min(1000 * 2^attempt, 32000)
 *   无 Retry-After 时：floor(base + random() * 0.25 * base)
 *   有正 Retry-After 时：取 Retry-After（非正值忽略）
 *
 * jitter 后范围 [base, base*1.25)，base 达 cap 时为 [32000, 40000)。
 *
 * @param attempt 当前重试次数（0-based）
 * @param random 随机数生成器 [0, 1)，默认 Math.random
 * @param retryAfterMs 服务端 Retry-After（毫秒），非正时忽略
 */
export function getRetryDelay(
  attempt: number,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number {
  // Retry-After 非正值时忽略（不覆盖计算延迟）
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return retryAfterMs;
  }
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BASE_DELAY_MS);
  return Math.floor(base + random() * 0.25 * base);
}

/**
 * 判断一个 API 错误是否可重试（设计 §9 A58）。
 *
 * 可重试：
 *   - 429（rate limit）
 *   - 529（overloaded）
 *   - 400 + context overflow / context_length_exceeded
 *   - 5xx（500/502/503/504）——服务端临时故障
 *
 * 不可重试：
 *   - AbortError（signal abort，永不重试）
 *   - 普通 400（client error）
 *   - 401/403（auth/permission）
 */
export function isRetryableApiError(error: unknown): boolean {
  // AbortError 永不重试（设计 §9：signal abort 不触发 retry）
  if (error instanceof Error && error.name === 'AbortError') return false;

  // 提取 status 与 message
  const status = extractHttpStatus(error);
  const msg = extractErrorMessage(error).toLowerCase();

  // 429 / rate limit
  if (status === 429 || msg.includes('429') || msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return true;
  }
  // 529 / overloaded
  if (status === 529 || msg.includes('529') || msg.includes('overloaded') || msg.includes('overload')) {
    return true;
  }
  // 5xx 服务端临时故障：502/503/504 可重试；500（服务端 bug）与 529（已单独处理）不在此判定
  if (status === 502 || status === 503 || status === 504) {
    return true;
  }
  // 400 + context overflow（可重试，走 compact 路径）
  if (status === 400 || msg.includes('context overflow') || msg.includes('context_length_exceeded') || msg.includes('context length') || msg.includes('prompt_too_long') || msg.includes('too long')) {
    if (msg.includes('context') || msg.includes('overflow') || msg.includes('too long') || msg.includes('prompt_too_long') || msg.includes('context_length')) {
      return true;
    }
    return false;
  }
  // 连接错误可重试（临时网络故障）
  if (msg.includes('connection') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network') || msg.includes('econnreset') || msg.includes('socket')) {
    return true;
  }
  return false;
}

/** 从 error 对象提取 HTTP status code */
function extractHttpStatus(error: unknown): number | undefined {
  if (!error) return undefined;
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
  }
  return undefined;
}

/** 从 error 对象提取 message */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 可注入的 retry sleeper 接口（设计 §9）。
 *
 * wait(delayMs, signal)：
 *   - signal 已 aborted 或被 abort 时立即 reject AbortError（不等待剩余 delay）；
 *   - 正常完成时 resolve。
 *
 * classifier retry loop 把同一 per-resolution AbortSignal 同时传给
 * provider RPC 和 retrySleeper.wait(delayMs, signal)。
 */
export interface RetrySleeperInterface {
  wait(delayMs: number, signal?: AbortSignal): Promise<void>;
}

/**
 * 默认 RetrySleeper 实现（设计 §9）。
 *
 * signal abort 时 wait 立即 reject AbortError，不等待剩余 delay。
 */
export class RetrySleeper implements RetrySleeperInterface {
  wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(makeAbortError());
    }
    if (delayMs <= 0) {
      // signal 在 0 delay 时也需要检查（race condition）
      return signal ? Promise.resolve() : Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(makeAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** 构造 AbortError */
function makeAbortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * 带退避的重试包装器
 *
 * 物理本质：打电话占线 → 挂掉 → 等一会 → 再打。
 * 等多久由退避策略决定，最多重试 maxRetries 次。
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; useJitter?: boolean } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const useJitter = options.useJitter ?? true;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = useJitter ? jitteredBackoff(attempt) : exponentialBackoff(attempt);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}
