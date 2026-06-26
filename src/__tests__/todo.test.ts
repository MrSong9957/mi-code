// TodoManager 测试
import { describe, it, expect, beforeEach } from 'vitest';
import { TodoManager, isTodoV2Enabled } from '../agent/todo.js';

describe('TodoManager', () => {
  let todo: TodoManager;

  beforeEach(() => {
    todo = new TodoManager();
  });

  it('should update todo list', () => {
    const result = todo.update([
      { id: '1', content: 'Task A', status: 'pending' },
      { id: '2', content: 'Task B', status: 'in_progress' },
    ]);
    expect(result).toContain('[ ] Task A');
    expect(result).toContain('[>] Task B');
  });

  it('should reject multiple in_progress', () => {
    const result = todo.update([
      { id: '1', content: 'Task A', status: 'in_progress' },
      { id: '2', content: 'Task B', status: 'in_progress' },
    ]);
    expect(result).toContain('Error');
  });

  it('should render completed tasks', () => {
    const result = todo.update([
      { id: '1', content: 'Task A', status: 'completed' },
    ]);
    expect(result).toContain('[x] Task A');
  });

  it('should reset rounds on todo update', () => {
    todo.incrementRounds();
    todo.incrementRounds();
    todo.update([]);
    expect(todo.needsReminder()).toBe(false);
  });

  it('should need reminder after 3 rounds', () => {
    todo.incrementRounds();
    todo.incrementRounds();
    todo.incrementRounds();
    expect(todo.needsReminder()).toBe(true);
    expect(todo.getReminder()).toContain('Update your todos');
  });

  it('should return empty for no todos', () => {
    expect(todo.render()).toBe('No todos yet.');
  });

  it('should return verification nudge when all tasks completed', () => {
    todo.update([
      { id: '1', content: 'Task A', status: 'completed' },
      { id: '2', content: 'Task B', status: 'completed' },
    ]);

    const nudge = todo.getVerificationNudge();
    expect(nudge).toContain('Verify your work');
  });

  it('should not return verification nudge when tasks remain', () => {
    todo.update([
      { id: '1', content: 'Task A', status: 'completed' },
      { id: '2', content: 'Task B', status: 'pending' },
    ]);

    expect(todo.getVerificationNudge()).toBeNull();
  });

  it('should not return verification nudge when no todos', () => {
    expect(todo.getVerificationNudge()).toBeNull();
  });
});

describe('TodoManager V2 - activeForm', () => {
  it('should render activeForm for in_progress task', () => {
    const todo = new TodoManager(2);
    const result = todo.update([
      { id: '1', content: 'Task A', status: 'in_progress', activeForm: 'Writing code...' },
    ]);

    expect(result).toContain('[>] Task A');
    expect(result).toContain('⟩ Writing code...');
  });

  it('should not render activeForm for pending task', () => {
    const todo = new TodoManager(2);
    const result = todo.update([
      { id: '1', content: 'Task A', status: 'pending', activeForm: 'Writing code...' },
    ]);

    expect(result).not.toContain('⟩');
  });
});

describe('TodoManager V2 - blockedBy', () => {
  it('should block task with unmet dependencies', () => {
    const todo = new TodoManager(2);
    const result = todo.update([
      { id: '1', content: 'Setup', status: 'pending' },
      { id: '2', content: 'Build', status: 'in_progress', blockedBy: ['1'] },
    ]);

    expect(result).toContain('Error');
    expect(result).toContain('blocked');
  });

  it('should allow task when dependencies met', () => {
    const todo = new TodoManager(2);
    const result = todo.update([
      { id: '1', content: 'Setup', status: 'completed' },
      { id: '2', content: 'Build', status: 'in_progress', blockedBy: ['1'] },
    ]);

    expect(result).not.toContain('Error');
    expect(result).toContain('[>] Build');
  });

  it('should render blocked status in list', () => {
    const todo = new TodoManager(2);
    const result = todo.update([
      { id: '1', content: 'Setup', status: 'pending' },
      { id: '2', content: 'Build', status: 'pending', blockedBy: ['1'] },
    ]);

    expect(result).toContain('blocked by: 1');
  });
});

describe('TodoManager V2 - version', () => {
  it('should report version 2 when forced', () => {
    const todo = new TodoManager(2);
    expect(todo.getVersion()).toBe(2);
  });

  it('should report version 1 when forced', () => {
    const todo = new TodoManager(1);
    expect(todo.getVersion()).toBe(1);
  });

  it('isTodoV2Enabled should return boolean', () => {
    expect(typeof isTodoV2Enabled()).toBe('boolean');
  });
});
