import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { useSpinnerClock } from '../../tui/hooks/useSpinnerClock.js';
import { createSpinnerStore, type SpinnerStore } from '../../tui/state/spinner-store.js';

function ClockHarness({ store }: { store: SpinnerStore }): React.ReactElement {
  useSpinnerClock(store);
  return <></>;
}

describe('useSpinnerClock', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('only advances while active and clears its interval after stop and unmount', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const view = render(<ClockHarness store={store} />);

    vi.advanceTimersByTime(150);
    expect(store.getState().time).toBe(150);

    store.getState().stop();
    view.rerender(<ClockHarness store={store} />);
    expect(vi.getTimerCount()).toBe(0);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150);
    expect(store.getState().time).toBe(0);

    view.unmount();
    vi.advanceTimersByTime(150);
    expect(store.getState().time).toBe(0);
    clearIntervalSpy.mockRestore();
  });

  it('clears its active interval on unmount', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const view = render(<ClockHarness store={store} />);

    view.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    clearIntervalSpy.mockRestore();
  });

  it('does not advance a paused spinner', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const view = render(<ClockHarness store={store} />);
    vi.advanceTimersByTime(100);
    store.getState().pause();

    vi.advanceTimersByTime(150);
    expect(store.getState().time).toBe(100);
    view.unmount();
  });
});
