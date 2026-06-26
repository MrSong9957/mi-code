// 自组织代理系统测试
import { describe, it, expect, beforeEach } from 'vitest';
import { TodoManager } from '../agent/todo.js';
import { InboxManager } from '../agent/inbox.js';
import { createIdleTool } from '../agent/tools/idle-tool.js';
import { createClaimTaskTool } from '../agent/tools/claim-task-tool.js';
import { createDefaultRegistry } from '../agent/tool-registry.js';

describe('TodoManager - 自组织扩展', () => {
  let todo: TodoManager;

  beforeEach(() => {
    todo = new TodoManager();
    todo.update([
      { id: '1', content: 'Task A', status: 'pending' },
      { id: '2', content: 'Task B', status: 'pending' },
      { id: '3', content: 'Task C', status: 'completed' },
    ]);
  });

  it('should claim an unassigned task', () => {
    const result = todo.claim('1', 'alice');

    expect(result).toContain('Claimed');
    expect(result).toContain('Task A');
    expect(result).toContain('alice');

    const items = todo.getItems();
    expect(items[0]!.owner).toBe('alice');
    expect(items[0]!.status).toBe('in_progress');
  });

  it('should reject claiming already claimed task', () => {
    todo.claim('1', 'alice');
    const result = todo.claim('1', 'bob');

    expect(result).toContain('Error');
    expect(result).toContain('alice');
  });

  it('allow same owner to re-claim', () => {
    todo.claim('1', 'alice');
    const result = todo.claim('1', 'alice');

    expect(result).toContain('Claimed');
  });

  it('should return unclaimed tasks', () => {
    todo.claim('1', 'alice');
    const unclaimed = todo.getUnclaimed();

    expect(unclaimed.length).toBe(1);
    expect(unclaimed[0]!.id).toBe('2');
  });

  it('should not include completed tasks in unclaimed', () => {
    const unclaimed = todo.getUnclaimed();

    expect(unclaimed.every(t => t.status !== 'completed')).toBe(true);
  });

  it('should get tasks by owner', () => {
    todo.claim('1', 'alice');
    todo.claim('2', 'alice');

    const aliceTasks = todo.getByOwner('alice');
    expect(aliceTasks.length).toBe(2);
  });

  it('should return error for non-existent task', () => {
    const result = todo.claim('999', 'alice');
    expect(result).toContain('Error');
  });
});

describe('InboxManager', () => {
  let inbox: InboxManager;

  beforeEach(() => {
    inbox = new InboxManager();
  });

  it('should send and receive messages', () => {
    inbox.send('alice', 'bob', 'Hello Bob');

    expect(inbox.hasMessages('bob')).toBe(true);
    expect(inbox.hasMessages('alice')).toBe(false);

    const messages = inbox.receive('bob');
    expect(messages.length).toBe(1);
    expect(messages[0]!.from).toBe('alice');
    expect(messages[0]!.content).toBe('Hello Bob');
  });

  it('should clear inbox after receive', () => {
    inbox.send('alice', 'bob', 'msg1');
    inbox.receive('bob');

    expect(inbox.hasMessages('bob')).toBe(false);
    expect(inbox.receive('bob').length).toBe(0);
  });

  it('should accumulate multiple messages', () => {
    inbox.send('alice', 'bob', 'msg1');
    inbox.send('alice', 'bob', 'msg2');

    const messages = inbox.receive('bob');
    expect(messages.length).toBe(2);
  });

  it('should isolate inboxes per agent', () => {
    inbox.send('alice', 'bob', 'for bob');
    inbox.send('alice', 'charlie', 'for charlie');

    expect(inbox.hasMessages('bob')).toBe(true);
    expect(inbox.hasMessages('charlie')).toBe(true);
    expect(inbox.hasMessages('alice')).toBe(false);
  });
});

describe('idle tool', () => {
  it('should return IDLE_REQUESTED', async () => {
    const { executor } = createIdleTool();
    const result = await executor({});
    expect(result).toBe('IDLE_REQUESTED');
  });
});

describe('claim_task tool', () => {
  it('should call todoManager.claim', async () => {
    const todo = new TodoManager();
    todo.update([{ id: '1', content: 'Test', status: 'pending' }]);

    const { executor } = createClaimTaskTool(todo, 'agent-1');
    const result = await executor({ task_id: '1' });

    expect(result).toContain('Claimed');
    expect(todo.getItems()[0]!.owner).toBe('agent-1');
  });
});

describe('createDefaultRegistry - 自组织工具', () => {
  it('should register idle and claim_task tools when todoManager and agentName provided', () => {
    const todo = new TodoManager();
    const registry = createDefaultRegistry(todo, 'agent-1');

    const definitions = registry.getDefinitions();
    const names = definitions.map(d => d.name);

    expect(names).toContain('idle');
    expect(names).toContain('claim_task');
  });

  it('should not register claim_task when no agentName', () => {
    const todo = new TodoManager();
    const registry = createDefaultRegistry(todo);

    const definitions = registry.getDefinitions();
    const names = definitions.map(d => d.name);

    expect(names).toContain('idle');
    expect(names).not.toContain('claim_task');
  });

  it('should not register idle when no todoManager', () => {
    const registry = createDefaultRegistry();

    const definitions = registry.getDefinitions();
    const names = definitions.map(d => d.name);

    expect(names).not.toContain('idle');
  });
});
