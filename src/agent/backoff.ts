// 退避策略：防止重试风暴
//
// 物理本质：堵车时的"交替放行"。
// 第 1 次重试等 1 秒，第 2 次等 2 秒，第 3 次等 4 秒……
// 加上随机抖动（jitter），防止 100 个子代理同时重试引发二次踩踏。

/** 基础延迟（毫秒） */
const BASE_DELAY_MS = 1000;

/** 最大延迟（毫秒） */
const MAX_DELAY_MS = 30_000;

/**
 * 基础指数退避：2^attempt * 1000ms
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
