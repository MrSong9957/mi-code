import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpinnerContextSnapshot } from '../../tui/state/spinner-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { selectSpinnerTip, selectSpinnerView } from '../../tui/state/spinner-view.js';

const baseContext: SpinnerContextSnapshot = {
  variant: 'normal',
  teammates: [],
  tasks: [],
  spinnerTip: 'custom tip',
  hasUsedBtw: false,
  budgetText: null,
  nextTaskText: null,
};

describe('spinner-view', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('inactive 为零行，brief 只有主行', () => {
    const store = createSpinnerStore();
    expect(selectSpinnerView(store.getState()).rowCount).toBe(0);

    store.getState().setContext({ ...baseContext, variant: 'brief' });
    store.getState().start('responding');

    const view = selectSpinnerView(store.getState());
    expect(view.rowCount).toBe(1);
    expect(view.auxiliaryLines).toEqual([]);
  });

  it('normal 优先展示非 shutdown teammate，否则回退未完成 task', () => {
    const store = createSpinnerStore();
    store.getState().setContext({
      ...baseContext,
      teammates: [
        { name: 'alice', role: 'coder', status: 'working' },
        { name: 'gone', role: 'coder', status: 'shutdown' },
      ],
      tasks: [{
        id: '1', content: 'Ship', status: 'pending', owner: null,
        activeForm: null, blockedBy: [],
      }],
    });
    store.getState().start('responding');
    expect(selectSpinnerView(store.getState()).auxiliaryLines
      .filter(line => line.kind === 'teammate').map(line => line.content))
      .toEqual(['  └─ alice (coder) · working']);

    store.getState().setContext({
      ...baseContext,
      tasks: [
        {
          id: '1', content: 'Ship', status: 'in_progress', owner: 'alice',
          activeForm: 'Shipping', blockedBy: [],
        },
        {
          id: '2', content: 'Done', status: 'completed', owner: null,
          activeForm: null, blockedBy: [],
        },
      ],
    });
    expect(selectSpinnerView(store.getState()).auxiliaryLines[0]!.content)
      .toBe('  [>] Ship · Shipping @alice');
  });

  it('Tip 按 30m、30s、自定义文本优先级决策', () => {
    expect(selectSpinnerTip(29_000, baseContext)).toBe('custom tip');
    expect(selectSpinnerTip(30_000, baseContext))
      .toBe('Tip: Use /btw to ask a quick side question...');
    expect(selectSpinnerTip(30_000, { ...baseContext, hasUsedBtw: true }))
      .toBe('custom tip');
    expect(selectSpinnerTip(1_799_999, baseContext))
      .toBe('Tip: Use /btw to ask a quick side question...');
    expect(selectSpinnerTip(1_800_000, { ...baseContext, hasUsedBtw: true }))
      .toBe('Use /clear to start fresh when switching topics...');
  });

  it('pause 冻结有效 time 和 Tip，resume 后才跨过 30 秒阈值', () => {
    const store = createSpinnerStore();
    store.getState().setContext(baseContext);
    store.getState().start('responding');
    vi.advanceTimersByTime(29_999);
    store.getState().tick();
    expect(store.getState().time).toBe(29_999);
    expect(selectSpinnerTip(store.getState().time, store.getState().context)).toBe('custom tip');

    store.getState().pause();
    vi.advanceTimersByTime(10_000);
    store.getState().tick();
    expect(store.getState().time).toBe(29_999);
    expect(selectSpinnerTip(store.getState().time, store.getState().context)).toBe('custom tip');

    store.getState().resume();
    vi.advanceTimersByTime(1);
    store.getState().tick();
    expect(store.getState().time).toBe(30_000);
    expect(selectSpinnerTip(store.getState().time, store.getState().context))
      .toBe('Tip: Use /btw to ask a quick side question...');
  });

  it('normal 按活动区、Tip、Budget、NextTask 排序', () => {
    const store = createSpinnerStore();
    store.getState().setContext({
      ...baseContext,
      budgetText: 'Budget: 50%',
      nextTaskText: 'Next: verify',
    });
    store.getState().start('responding');

    expect(selectSpinnerView(store.getState()).auxiliaryLines).toEqual([
      { kind: 'tip', content: 'custom tip' },
      { kind: 'budget', content: 'Budget: 50%' },
      { kind: 'next-task', content: 'Next: verify' },
    ]);
  });

  it('normal 的每个可见 content 都是一条物理行且 rowCount 精确', () => {
    const store = createSpinnerStore();
    store.getState().setContext({
      ...baseContext,
      teammates: [{ name: 'alice\r\nbob', role: 'coder\nlead', status: 'working' }],
      spinnerTip: 'tip\rhere', budgetText: 'budget\r\nhere', nextTaskText: 'next\nhere',
    });
    store.getState().start('responding');

    const teammateView = selectSpinnerView(store.getState());
    for (const line of teammateView.auxiliaryLines) {
      expect(line.content).not.toMatch(/[\r\n]/);
    }
    expect(teammateView.rowCount).toBe(1 + teammateView.auxiliaryLines.length);

    store.getState().setContext({
      ...baseContext,
      tasks: [{
        id: '1', content: 'Ship\r\nnow', status: 'in_progress', owner: 'alice\nowner',
        activeForm: 'Shipping\rdetail', blockedBy: ['blocker\r\none', 'blocker\ntwo'],
      }],
      spinnerTip: 'tip\rhere', budgetText: 'budget\r\nhere', nextTaskText: 'next\nhere',
    });

    const taskView = selectSpinnerView(store.getState());
    for (const line of taskView.auxiliaryLines) {
      expect(line.content).not.toMatch(/[\r\n]/);
    }
    expect(taskView.rowCount).toBe(1 + taskView.auxiliaryLines.length);
  });

  it('动画使用 store 的有效 time，并从 working context 成员推导活跃 teammate 数', () => {
    const store = createSpinnerStore();
    store.getState().setContext({
      ...baseContext,
      teammates: [
        { name: 'alice', role: 'coder', status: 'working' },
        { name: 'bob', role: 'reviewer', status: 'idle' },
        { name: 'carol', role: 'coder', status: 'working' },
      ],
    });
    store.getState().start('responding');
    vi.advanceTimersByTime(50);
    store.getState().tick();

    expect(selectSpinnerView(store.getState()).animation).toMatchObject({
      time: 50,
      activeTeammateCount: 2,
    });
  });
});
