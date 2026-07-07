// AskUserManager + ask_user_question 工具测试
//
// 物理本质：验证"服务员提问-顾客应答"状态机的所有状态迁移。
// 用 mock UI 回调（不依赖真实 layout/pipeline），单测纯逻辑。
import { describe, it, expect, vi } from 'vitest';
import { AskUserManager } from '../agent/ask-user-manager.js';
import { createAskUserTool } from '../agent/tools/ask-user-tool.js';

/** 构造一个 mock UI 与 manager */
function makeManager() {
  const prints: string[] = [];
  const hints: (string | undefined)[] = [];
  const ui = {
    printLine: vi.fn((s: string) => { prints.push(s); }),
    setHint: vi.fn((s: string | undefined) => { hints.push(s); }),
  };
  return { manager: new AskUserManager(ui), prints, hints, ui };
}

describe('AskUserManager 状态机', () => {
  it('初始状态无 pending', () => {
    const { manager } = makeManager();
    expect(manager.hasPending()).toBe(false);
    expect(manager.getPending()).toBeNull();
  });

  it('ask() 后立即有 pending，UI 收到问题与 hint', async () => {
    const { manager, prints, hints } = makeManager();
    // 不 await，否则会卡住
    const p = manager.ask({
      id: 'q1', header: 'Mode', question: 'Use Redis?',
      options: ['yes', 'no'],
    });

    expect(manager.hasPending()).toBe(true);
    expect(manager.getPending()?.question).toBe('Use Redis?');
    // 问题 + 两个选项已渲染
    expect(prints).toContain('❓ Use Redis?');
    expect(prints).toContain('   1. yes');
    expect(prints).toContain('   2. no');
    // hint 已设置
    expect(hints[hints.length - 1]).toMatch(/answer/i);

    // resolve 后 promise settle
    manager.resolve('yes');
    await expect(p).resolves.toBe('yes');
    expect(manager.hasPending()).toBe(false);
  });

  it('resolve() 后清除 hint', async () => {
    const { manager, hints } = makeManager();
    const p = manager.ask({ id: 'q1', header: 'H', question: 'Q?' });
    manager.resolve('answer');
    await p;
    // 最后一次 setHint 调用应是 undefined（清除）
    expect(hints[hints.length - 1]).toBeUndefined();
  });

  it('cancel() resolve 空串', async () => {
    const { manager } = makeManager();
    const p = manager.ask({ id: 'q1', header: 'H', question: 'Q?' });
    manager.cancel();
    await expect(p).resolves.toBe('');
    expect(manager.hasPending()).toBe(false);
  });

  it('resolve() 在无 pending 时不抛错', () => {
    const { manager } = makeManager();
    expect(() => manager.resolve('x')).not.toThrow();
  });

  it('ask() 在已有 pending 时覆盖旧的（旧 resolver 收到空串）', async () => {
    const { manager } = makeManager();
    const p1 = manager.ask({ id: 'q1', header: 'A', question: 'A?' });
    // 第二次 ask 时，旧的应被 settle
    const p2 = manager.ask({ id: 'q2', header: 'B', question: 'B?' });

    // 旧的应 resolve 空串
    await expect(p1).resolves.toBe('');
    expect(manager.getPending()?.question).toBe('B?');

    // 第二个正常 resolve
    manager.resolve('b-answer');
    await expect(p2).resolves.toBe('b-answer');
  });

  it('无 options 时不渲染选项列表，hint 文案不同', async () => {
    const { manager, prints, hints } = makeManager();
    const p = manager.ask({ id: 'q1', header: 'H', question: 'Free-form?' });
    // 仅问题行，无 "1." / "2." 选项行
    expect(prints.filter(s => /^\s+\d+\./.test(s))).toEqual([]);
    expect(hints[hints.length - 1]).toMatch(/answer/i);
    manager.resolve('x');
    await p;
  });
});

describe('createAskUserTool', () => {
  it('definition 字段正确', () => {
    const { manager } = makeManager();
    const { definition } = createAskUserTool(manager);
    expect(definition.name).toBe('ask_user_question');
    expect(definition.parameters.required).toEqual(['question']);
  });

  it('executor 调 mgr.ask → resolve → 返回答案', async () => {
    const { manager } = makeManager();
    const { executor } = createAskUserTool(manager);
    // 不 await，否则会卡住
    const p = executor({ question: 'Cache strategy?', header: 'Cache' });
    // mgr 已 pending，且问题文案已传给 UI
    expect(manager.hasPending()).toBe(true);
    expect(manager.getPending()?.question).toBe('Cache strategy?');
    // 模拟用户回答
    manager.resolve('redis');
    await expect(p).resolves.toBe('redis');
  });

  it('空回答 → 返回 "(no answer)"', async () => {
    const { manager } = makeManager();
    const { executor } = createAskUserTool(manager);
    const p = executor({ question: 'Q?' });
    manager.resolve('');
    await expect(p).resolves.toBe('(no answer)');
  });

  it('options 数组被透传给 mgr', async () => {
    const { manager } = makeManager();
    const { executor } = createAskUserTool(manager);
    const p = executor({ question: 'Pick', options: ['a', 'b', 'c'] });
    expect(manager.getPending()?.options).toEqual(['a', 'b', 'c']);
    manager.resolve('b');
    await p;
  });

  it('缺少 question 字段 → 返回 Error', async () => {
    const { manager } = makeManager();
    const { executor } = createAskUserTool(manager);
    const result = await executor({});
    expect(result).toMatch(/Error/i);
    // 不应进入 pending
    expect(manager.hasPending()).toBe(false);
  });
});
