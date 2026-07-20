import { describe, expect, it } from 'vitest';
import { EMPTY_SPINNER_CONTEXT } from '../../tui/state/spinner-store.js';
import { readSpinnerContext } from '../../tui/spinner-context.js';

describe('runtime spinner context', () => {
  it('精确复制 TeammateManager 与 TodoManager 的当前快照', () => {
    const teammates = [{ name: 'alice', role: 'coder', status: 'working' as const }];
    const tasks = [{
      id: 'task-1', content: 'Ship context bridge', status: 'in_progress' as const,
      owner: undefined, activeForm: undefined, blockedBy: ['task-0'], worktree: 'ignored',
    }];

    const snapshot = readSpinnerContext(
      { list: () => teammates },
      { getItems: () => tasks },
      EMPTY_SPINNER_CONTEXT,
    );
    teammates[0]!.name = 'mutated';
    tasks[0]!.blockedBy.push('mutated');

    expect(snapshot).toEqual({
      variant: 'normal',
      teammates: [{ name: 'alice', role: 'coder', status: 'working' }],
      tasks: [{
        id: 'task-1', content: 'Ship context bridge', status: 'in_progress',
        owner: null, activeForm: null, blockedBy: ['task-0'],
      }],
      spinnerTip: null,
      hasUsedBtw: false,
      budgetText: null,
      nextTaskText: null,
    });
  });

  it('manager 读取失败时保留最后一个完整快照', () => {
    const fallback = {
      ...EMPTY_SPINNER_CONTEXT,
      teammates: [{ name: 'saved', role: 'reviewer', status: 'idle' as const }],
    };

    expect(readSpinnerContext(
      { list: () => { throw new Error('team unavailable'); } },
      { getItems: () => [] },
      fallback,
    )).toBe(fallback);
  });
});
