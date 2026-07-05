// src/__tests__/tui/messages-store.test.ts
// messages-store：TuiMessage 列表管理（追加/流式累加/清空）

import { describe, it, expect } from 'vitest';
import { createMessagesStore } from '../../tui/state/messages-store.js';
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
});
