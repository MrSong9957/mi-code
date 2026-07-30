import { describe, expect, it, vi } from 'vitest';
import { StreamEventBus, type ErrorEvent } from '../agent/stream-event-bus.js';

const failure: ErrorEvent = {
  errorType: 'unknown',
  message: 'provider failed',
  recoverable: false,
};

describe('StreamEventBus error channel', () => {
  it('没有 error listener 时 emitError 不改变控制流', () => {
    const bus = new StreamEventBus();
    expect(() => bus.emitError(failure)).not.toThrow();
  });

  it('有 listener 时投递一次，off 后不再投递', () => {
    const bus = new StreamEventBus();
    const listener = vi.fn();

    bus.onError(listener);
    bus.emitError(failure);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(failure);

    bus.offError(listener);
    bus.emitError(failure);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
