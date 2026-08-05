// 错误恢复机制测试
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyError,
  handleError,
  createRecoveryState,
  FailureInbox,
  MAX_RETRY_LIMIT,
  type RecoveryState,
  type ErrorType,
} from '../agent/recovery.js';
import { exponentialBackoff, jitteredBackoff, withBackoff, sleep } from '../agent/backoff.js';
import type { Message } from '../agent/types.js';

// ============================================================
// classifyError 测试
// ============================================================
describe('classifyError', () => {
  it('应识别 max_tokens 错误', () => {
    expect(classifyError(new Error('max_tokens_exceeded'))).toBe('max_tokens_exceeded');
    expect(classifyError(new Error('stop_reason: max_tokens'))).toBe('max_tokens_exceeded');
  });

  it('应识别 prompt_too_long 错误', () => {
    expect(classifyError(new Error('context_length_exceeded'))).toBe('prompt_too_long');
    expect(classifyError(new Error('context length exceeded'))).toBe('prompt_too_long');
    expect(classifyError(new Error('prompt is too long'))).toBe('prompt_too_long');
  });

  it('应识别 429 rate limit 错误', () => {
    expect(classifyError(new Error('429 Too Many Requests'))).toBe('rate_limited_429');
    expect(classifyError(new Error('rate_limit_exceeded'))).toBe('rate_limited_429');
    expect(classifyError(new Error('Too many requests'))).toBe('rate_limited_429');
  });

  it('未知错误归类为 unknown', () => {
    expect(classifyError(new Error('something broke'))).toBe('unknown');
    expect(classifyError('string error')).toBe('unknown');
    expect(classifyError(42)).toBe('unknown');
  });

  it('应从 provider 普通对象识别 429', () => {
    expect(classifyError({
      status: 429,
      error: { message: 'Too many requests' },
    })).toBe('rate_limited_429');
  });
});

// ============================================================
// FailureInbox 测试
// ============================================================
describe('FailureInbox', () => {
  let inbox: FailureInbox;

  beforeEach(() => {
    inbox = new FailureInbox();
  });

  it('初始状态为空', () => {
    expect(inbox.count).toBe(0);
    expect(inbox.getHistory()).toEqual([]);
  });

  it('应正确记录故障', () => {
    inbox.add('max_tokens_exceeded', 'overflow', 1, 'scale up');

    expect(inbox.count).toBe(1);
    const record = inbox.getHistory()[0]!;
    expect(record.errorType).toBe('max_tokens_exceeded');
    expect(record.message).toBe('overflow');
    expect(record.retryAttempt).toBe(1);
    expect(record.action).toBe('scale up');
    expect(record.timestamp).toBeGreaterThan(0);
  });

  it('应支持多条记录', () => {
    inbox.add('rate_limited_429', 'rate limit', 1, 'degrade');
    inbox.add('prompt_too_long', 'context full', 2, 'compact');

    expect(inbox.count).toBe(2);
    expect(inbox.getHistory()[0]!.errorType).toBe('rate_limited_429');
    expect(inbox.getHistory()[1]!.errorType).toBe('prompt_too_long');
  });

  it('clear 应清空记录', () => {
    inbox.add('unknown', 'err', 1, 'abort');
    inbox.clear();
    expect(inbox.count).toBe(0);
  });
});

// ============================================================
// RecoveryState 测试
// ============================================================
describe('createRecoveryState', () => {
  it('应创建默认状态', () => {
    const state = createRecoveryState();
    expect(state.maxTokens).toBe(8000);
    expect(state.currentModel).toBe('claude-sonnet-4-20250514');
    expect(state.defaultModel).toBe('claude-sonnet-4-20250514');
    expect(state.retryAttempt).toBe(0);
    expect(state.reactiveCompactUsed).toBe(false);
  });

  it('应支持自定义模型和 token 数', () => {
    const state = createRecoveryState('gpt-4', 4000);
    expect(state.currentModel).toBe('gpt-4');
    expect(state.maxTokens).toBe(4000);
  });
});

// ============================================================
// handleError 测试：max_tokens 恢复
// ============================================================
describe('handleError: max_tokens_exceeded', () => {
  it('应升级 maxTokens 并追加续写消息', () => {
    const state = createRecoveryState();
    const inbox = new FailureInbox();
    const messages: Message[] = [{ role: 'user', content: 'write code' }];

    const canRetry = handleError('max_tokens_exceeded', state, inbox, messages, m => m);

    expect(canRetry).toBe(true);
    expect(state.maxTokens).toBe(64000);
    expect(state.retryAttempt).toBe(1);
    // 应追加续写占位消息
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('Continue exactly from where you left off');
    // 应记录故障
    expect(inbox.count).toBe(1);
    expect(inbox.getHistory()[0]!.action).toContain('append continuation');
  });
});

// ============================================================
// handleError 测试：prompt_too_long 恢复
// ============================================================
describe('handleError: prompt_too_long', () => {
  it('应触发 reactive compact', () => {
    const state = createRecoveryState();
    const inbox = new FailureInbox();
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    const compactFn = vi.fn((m: Message[]): Message[] => [{ role: 'user', content: '[compacted]' }]);

    const canRetry = handleError('prompt_too_long', state, inbox, messages, compactFn);

    expect(canRetry).toBe(true);
    expect(compactFn).toHaveBeenCalled();
    expect(state.reactiveCompactUsed).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('[compacted]');
  });

  it('第二次 prompt_too_long 应放弃', () => {
    const state = createRecoveryState();
    state.reactiveCompactUsed = true;
    const inbox = new FailureInbox();
    const messages: Message[] = [];

    const canRetry = handleError('prompt_too_long', state, inbox, messages, m => m);

    expect(canRetry).toBe(false);
    expect(inbox.getHistory()[0]!.action).toBe('abort');
  });
});

// ============================================================
// handleError 测试：429 恢复
// ============================================================
describe('handleError: rate_limited_429', () => {
  it('前两次 retry 保持 primary model；第三次降级到 fallback（A62）', () => {
    const state = createRecoveryState();
    const inbox = new FailureInbox();
    const messages: Message[] = [];

    // 第 1 次 429: retryAttempt 0→1, 保持 primary
    let canRetry = handleError('rate_limited_429', state, inbox, messages, m => m);
    expect(canRetry).toBe(true);
    expect(state.currentModel).toBe('claude-sonnet-4-20250514');

    // 第 2 次 429: retryAttempt 1→2, 保持 primary
    canRetry = handleError('rate_limited_429', state, inbox, messages, m => m);
    expect(canRetry).toBe(true);
    expect(state.currentModel).toBe('claude-sonnet-4-20250514');

    // 第 3 次 429: retryAttempt 2→3, 降级到 fallback
    canRetry = handleError('rate_limited_429', state, inbox, messages, m => m);
    expect(canRetry).toBe(true);
    expect(state.currentModel).toBe('claude-3-5-haiku');
    expect(inbox.getHistory()[2]!.action).toContain('degrade model');
  });
});

// ============================================================
// handleError 测试：未知错误
// ============================================================
describe('handleError: unknown', () => {
  it('未知错误应放弃自愈', () => {
    const state = createRecoveryState();
    const inbox = new FailureInbox();
    const messages: Message[] = [];

    const canRetry = handleError('unknown', state, inbox, messages, m => m);

    expect(canRetry).toBe(false);
    expect(inbox.getHistory()[0]!.action).toBe('abort');
  });
});

// ============================================================
// handleError 测试：重试上限
// ============================================================
describe('handleError: 重试上限', () => {
  it('超过 MAX_RETRY_LIMIT 应放弃', () => {
    const state = createRecoveryState();
    state.retryAttempt = MAX_RETRY_LIMIT;
    const inbox = new FailureInbox();
    const messages: Message[] = [];

    const canRetry = handleError('max_tokens_exceeded', state, inbox, messages, m => m);

    expect(canRetry).toBe(false);
    expect(inbox.getHistory()[0]!.action).toBe('abort');
    // 不应修改消息
    expect(messages).toHaveLength(0);
  });
});

// ============================================================
// backoff 测试
// ============================================================
describe('退避策略', () => {
  describe('exponentialBackoff', () => {
    it('应返回指数递增的延迟', () => {
      expect(exponentialBackoff(0)).toBe(1000);
      expect(exponentialBackoff(1)).toBe(2000);
      expect(exponentialBackoff(2)).toBe(4000);
      expect(exponentialBackoff(3)).toBe(8000);
    });

    it('不应超过最大延迟', () => {
      expect(exponentialBackoff(20)).toBeLessThanOrEqual(30000);
    });
  });

  describe('jitteredBackoff', () => {
    it('应返回 0 到指数延迟之间的随机值', () => {
      for (let i = 0; i < 50; i++) {
        const delay = jitteredBackoff(2); // max = 4000
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(4000);
      }
    });
  });

  describe('withBackoff', () => {
    it('成功时应直接返回结果', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await withBackoff(fn, { maxRetries: 3, useJitter: false });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('失败后重试成功应返回结果', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('ok');

      const result = await withBackoff(fn, { maxRetries: 3, useJitter: false });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('超过重试次数应抛出最后的错误', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));

      await expect(
        withBackoff(fn, { maxRetries: 2, useJitter: false }),
      ).rejects.toThrow('persistent failure');
      expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });
  });
});
