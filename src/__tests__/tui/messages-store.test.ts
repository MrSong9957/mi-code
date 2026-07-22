// src/__tests__/tui/messages-store.test.ts
// messages-store：TuiMessage 列表管理（追加/流式累加/清空）

import { describe, it, expect, vi } from 'vitest';
import { createMessagesStore, isAppendableMessage } from '../../tui/state/messages-store.js';
import { createTurnDurationMessage } from '../../tui/state/turn-duration-message.js';
import type { FormattedLine } from '../../ui/types.js';

const LINE = (content: string, fg?: string): FormattedLine => ({ content, style: fg ? { fg } : {}, indent: 0 });

describe('messages-store', () => {
  it('初始：空消息列表', () => {
    const store = createMessagesStore();
    expect(store.getState().messages).toEqual([]);
  });

  it('appendMessage：追加一条消息（生成 uuid，finalized=true）', () => {
    const store = createMessagesStore();
    store.getState().appendMessage('user', [LINE('❯ 你好', 'success')]);
    const msgs = store.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.lines[0]!.content).toBe('❯ 你好');
    expect(msgs[0]!.finalized).toBe(true);
    expect(msgs[0]!.uuid).toBeTruthy();
  });

  it('appendLines：往末条消息追加行（无消息时新建）', () => {
    const store = createMessagesStore();
    store.getState().appendLine('system', LINE('banner'));
    store.getState().appendLine('system', LINE('第二行'));
    const msgs = store.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.lines.length).toBe(2);
    expect(msgs[0]!.lines[1]!.content).toBe('第二行');
  });

  it('appendLine 不同 role：新建消息（断块）', () => {
    const store = createMessagesStore();
    store.getState().appendLine('user', LINE('用户'));
    store.getState().appendLine('assistant', LINE('● 助手'));
    expect(store.getState().messages.length).toBe(2);
  });

  it('startStreaming：开一条流式 assistant（finalized=false, streamingText=initialText）', () => {
    const store = createMessagesStore();
    store.getState().startStreaming('● ');
    const msgs = store.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('assistant');
    expect(msgs[0]!.finalized).toBe(false);
    expect(msgs[0]!.streamingText).toBe('● ');
  });

  it('updateStreaming：更新末条流式的 streamingText', () => {
    const store = createMessagesStore();
    store.getState().startStreaming('');
    store.getState().updateStreaming('hello');
    store.getState().updateStreaming('hello world');
    const m = store.getState().messages[0]!;
    expect(m.streamingText).toBe('hello world');
    expect(m.finalized).toBe(false);
  });

  it('finalizeStreaming：固化末条流式（finalized=true，lines 固化，streamingText 清除）', () => {
    const store = createMessagesStore();
    store.getState().startStreaming('');
    store.getState().updateStreaming('hello');
    store.getState().finalizeStreaming([LINE('● hello', 'brand')]);
    const m = store.getState().messages[0]!;
    expect(m.finalized).toBe(true);
    expect(m.streamingText).toBeUndefined();
    expect(m.lines[0]!.content).toBe('● hello');
  });

  it('updateStreaming 无流式消息时：忽略（不崩）', () => {
    const store = createMessagesStore();
    store.getState().updateStreaming('hello');
    expect(store.getState().messages).toEqual([]);
  });

  it('clear：清空所有消息', () => {
    const store = createMessagesStore();
    store.getState().appendMessage('system', [LINE('a')]);
    store.getState().appendMessage('user', [LINE('b')]);
    store.getState().clear();
    expect(store.getState().messages).toEqual([]);
  });

  it('rewindLastUserTurn:无 assistant 时,删末条 user 及其后全部', () => {
    const store = createMessagesStore();
    store.getState().appendLine('user', LINE('❯ 你好'));
    store.getState().appendLine('system', LINE('thinking...'));
    store.getState().rewindLastUserTurn();
    expect(store.getState().messages).toEqual([]);
  });

  it('rewindLastUserTurn:保留 user 之前的消息', () => {
    const store = createMessagesStore();
    store.getState().appendLine('assistant', LINE('● 上次回复'));
    store.getState().appendLine('user', LINE('❯ 第二次提问'));
    store.getState().appendLine('system', LINE('banner'));
    store.getState().rewindLastUserTurn();
    const msgs = store.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('assistant');
    expect(msgs[0]!.lines[0]!.content).toBe('● 上次回复');
  });

  it('rewindLastUserTurn:无 user 时幂等(空操作)', () => {
    const store = createMessagesStore();
    store.getState().appendLine('system', LINE('banner'));
    store.getState().rewindLastUserTurn();
    expect(store.getState().messages.length).toBe(1);
  });

  it('rewindLastUserTurn:连续两次第二次幂等', () => {
    const store = createMessagesStore();
    // 用 appendMessage 确保是两条独立 user 消息(appendLine 同 role 会合并为一条)
    store.getState().appendMessage('user', [LINE('❯ q1')]);
    store.getState().appendMessage('user', [LINE('❯ q2')]);
    store.getState().rewindLastUserTurn();
    expect(store.getState().messages.length).toBe(1);
    store.getState().rewindLastUserTurn();
    expect(store.getState().messages).toEqual([]);
    store.getState().rewindLastUserTurn(); // 第三次:已空
    expect(store.getState().messages).toEqual([]);
  });

  it('rewindLastUserTurn:移除进行中的流式 assistant(user + 未 finalize 的 assistant 一起删)', () => {
    const store = createMessagesStore();
    store.getState().appendMessage('user', [LINE('❯ q')]);
    store.getState().startStreaming('partial response');
    // 此时 messages = [user(finalized), assistant(finalized=false, streamingText='partial')]
    store.getState().rewindLastUserTurn();
    // user 之后的流式 assistant 也一起删除
    expect(store.getState().messages).toEqual([]);
  });

  it('finalizeStreamingAsInterrupted:末条流式固化为 [interrupted]', () => {
    const store = createMessagesStore();
    store.getState().appendLine('user', LINE('❯ q'));
    store.getState().startStreaming('');
    store.getState().updateStreaming('部分内容');
    store.getState().finalizeStreamingAsInterrupted();
    const msgs = store.getState().messages;
    // user 还在,assistant 末条已固化
    expect(msgs.length).toBe(2);
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.finalized).toBe(true);
    expect(msgs[1]!.streamingText).toBeUndefined();
    // streamingText 内容被保留为 line
    const contents = msgs[1]!.lines.map((l) => l.content);
    expect(contents).toContain('部分内容');
    expect(contents).toContain('[interrupted]');
  });

  it('finalizeStreamingAsInterrupted:无流式消息时空操作', () => {
    const store = createMessagesStore();
    store.getState().appendLine('user', LINE('❯ q'));
    store.getState().finalizeStreamingAsInterrupted();
    // 没崩,也没新增
    expect(store.getState().messages.length).toBe(1);
  });

  it('finalizeStreamingAsInterrupted:无 streamingText 时只加 [interrupted]', () => {
    const store = createMessagesStore();
    store.getState().startStreaming(''); // 空流式
    store.getState().finalizeStreamingAsInterrupted();
    const m = store.getState().messages[0]!;
    expect(m.finalized).toBe(true);
    expect(m.lines.some((l) => l.content === '[interrupted]')).toBe(true);
  });

  it('appendTurnDurationMessage 始终创建独立消息且只补一个前导空行', () => {
    const store = createMessagesStore();
    store.getState().appendLine('system', LINE('thought for 1s (ctrl+o to expand)'));
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      store.getState().appendTurnDurationMessage(9_000);

      const messages = store.getState().messages;
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({ kind: 'turn-duration', verb: 'Cooked' });
      expect(messages[1]!.lines.map(line => line.content)).toEqual([
        '', '✻ Cooked for 9s',
      ]);

      store.getState().appendLine('system', LINE('next'));
      expect(store.getState().messages).toHaveLength(3);
      expect(store.getState().messages[1]!.lines).toHaveLength(2);
    } finally {
      random.mockRestore();
    }
  });

  it('末行已经为空时不重复添加完成消息前导空行', () => {
    const store = createMessagesStore();
    store.getState().appendMessage('assistant', [LINE('● answer'), LINE('')]);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      store.getState().appendTurnDurationMessage(1_000);
      expect(store.getState().messages.at(-1)!.lines[0]!.content).toBe('✻ Baked for 1s');
    } finally {
      random.mockRestore();
    }
  });
  it('pending tool: \u521b\u5efa\u5373\u53ef\u89c1\uff0c\u5e76\u6309 toolUseId \u539f\u5730\u5b8c\u6210', () => {
    const store = createMessagesStore();
    const firstId = store.getState().appendPendingTool('t1', [LINE('\u25cf spawn_agent')]);
    const secondId = store.getState().appendPendingTool('t2', [LINE('\u25cf read_file')]);

    expect([firstId, secondId]).toEqual(['msg-1', 'msg-2']);
    expect(store.getState().messages).toMatchObject([
      { uuid: firstId, kind: 'tool-progress', toolUseId: 't1', finalized: false },
      { uuid: secondId, kind: 'tool-progress', toolUseId: 't2', finalized: false },
    ]);

    expect(store.getState().resolvePendingTool('t2', [LINE('\u25ba result two')])).toBe(true);
    expect(store.getState().messages).toMatchObject([
      { toolUseId: 't1', finalized: false },
      { toolUseId: 't2', finalized: true, lines: [{ content: '\u25ba result two' }] },
    ]);
  });

  it('pending tool: \u672a\u77e5 toolUseId \u4e0d\u8bef\u4fee\u6539\u5176\u4ed6\u6d88\u606f', () => {
    const store = createMessagesStore();
    store.getState().appendPendingTool('t1', [LINE('\u25cf first')]);
    store.getState().appendPendingTool('t2', [LINE('\u25cf second')]);

    expect(store.getState().resolvePendingTool('missing', [LINE('\u25ba wrong')])).toBe(false);
    expect(store.getState().messages).toMatchObject([
      { toolUseId: 't1', finalized: false, lines: [{ content: '\u25cf first' }] },
      { toolUseId: 't2', finalized: false, lines: [{ content: '\u25cf second' }] },
    ]);
  });

  // ────────────────────────────────────────────────────────────────────
  // AUTO-0025-transient Task 1:thinking 临时行是单例,按 kind 移除。
  //
  // 物理本质:任意时刻最多一条 thinking-progress 活动行。重复 start 幂等,
  // remove 按 kind 移除(不依赖末条位置),不影响 pending 工具消息。
  // ────────────────────────────────────────────────────────────────────

  it('thinking progress is unique and removed by kind without touching pending tools', () => {
    const store = createMessagesStore();
    store.getState().appendPendingTool('tool-1', [LINE('● spawn_agent')]);
    store.getState().startStreamingThinking('Thinking…');
    store.getState().startStreamingThinking('Thinking…');

    expect(store.getState().messages.filter(m => m.kind === 'thinking-progress')).toHaveLength(1);
    expect(store.getState().removeStreamingThinking()).toBe(true);
    expect(store.getState().messages.some(m => m.kind === 'thinking-progress')).toBe(false);
    expect(store.getState().messages.some(m => m.toolUseId === 'tool-1')).toBe(true);
    expect(store.getState().removeStreamingThinking()).toBe(false);
  });
});

describe('isAppendableMessage', () => {
  // 防御边界：appendLine 的续接判定依赖此 type guard。
  // turn-duration 消息写入后即使 appendLine('system', ...) 同 role 也不能合并，
  // 否则完成消息 "✻ Cooked for 9s" 后续会被污染。
  // 未来若新增第二种专用 kind，必须在此 guard 显式排除。
  it('普通消息（无 kind）允许续接', () => {
    const plain = {
      uuid: 'm1', role: 'system' as const,
      lines: [LINE('x')], finalized: true,
    };
    expect(isAppendableMessage(plain)).toBe(true);
  });

  it('turn-duration 完成消息禁止续接', () => {
    const duration = createTurnDurationMessage({
      uuid: 'm-td', durationMs: 5_000,
      prependBlankLine: false, random: () => 0,
    });
    expect(isAppendableMessage(duration)).toBe(false);
  });

  it('流式消息（finalized=false）虽然 isAppendableMessage 返回 true，但 appendLine 自身还有 finalized 守卫', () => {
    // 即便 type guard 通过，appendLine 仍要求 last.finalized === true 才续接，
    // 所以流式中的 assistant 不会被 appendLine 误并。
    const streaming = {
      uuid: 'm-stream', role: 'assistant' as const,
      lines: [], finalized: false, streamingText: 'partial',
    };
    expect(isAppendableMessage(streaming)).toBe(true); // kind 无定义
  });
});
