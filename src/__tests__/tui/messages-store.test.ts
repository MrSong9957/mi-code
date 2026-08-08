// src/__tests__/tui/messages-store.test.ts
// 语义时间线 store 测试:TimelineItem 列表管理(工具分组/流式/清空/撤回)
//
// 物理本质:验证语义 store 的核心行为契约。
// 不再断言 FormattedLine 字符串行,而是断言 TimelineItem 的 kind/status/text。

import { describe, it, expect, vi } from 'vitest';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { buildToolPresentation } from '../../ui/tool-presentation.js';
import { selectCommittedTranscript } from '../../tui/state/transcript-reducer.js';
import type { ToolPresentation } from '../../tui/transcript-types.js';

const enTranslator = createTranslator(createLanguageStore('en-US'));

describe('messages-store (semantic timeline)', () => {
  it('初始:空时间线', () => {
    const store = createMessagesStore();
    expect(store.getState().model.items).toEqual([]);
  });

  it('startTool + resolveTool 产出 ToolBlock', () => {
    const store = createMessagesStore();
    store.getState().startTool({
      toolUseId: 'g1',
      toolName: 'glob',
      input: { pattern: '*.ts' },
    });
    const presentation = buildToolPresentation({
      toolUseId: 'g1', toolName: 'glob',
      input: { pattern: '*.ts' }, output: 'src/a.ts',
    }, enTranslator);
    store.getState().resolveTool('g1', presentation);
    store.getState().closeOpenToolGroup();

    const items = store.getState().model.items;
    expect(items[0]).toMatchObject({
      kind: 'tool',
      toolName: 'glob',
      presentations: [{ summary: '*.ts → 1 file' }],
    });
  });

  it('相邻同名 groupable 调用合并为一个 PendingTool', () => {
    const store = createMessagesStore();
    store.getState().startTool({ toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' } });
    store.getState().startTool({ toolUseId: 'g2', toolName: 'glob', input: { pattern: '*.json' } });

    const pending = store.getState().model.items.filter(i => i.kind === 'pending-tool');
    expect(pending).toHaveLength(1);
  });

  it('不同名工具各自独立', () => {
    const store = createMessagesStore();
    store.getState().startTool({ toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' } });
    store.getState().startTool({ toolUseId: 'r1', toolName: 'read_file', input: { path: 'a.ts' } });

    const pending = store.getState().model.items.filter(i => i.kind === 'pending-tool');
    expect(pending).toHaveLength(2);
  });

  it('startAssistant + finishAssistant 产出 AssistantBlock', () => {
    const store = createMessagesStore();
    store.getState().startAssistant('hello');
    // 流式中:有 streaming-assistant 活动项
    expect(store.getState().model.items.some(i => i.kind === 'streaming-assistant')).toBe(true);

    store.getState().finishAssistant();
    const items = store.getState().model.items;
    expect(items[items.length - 1]).toMatchObject({ kind: 'assistant', text: 'hello' });
  });

  it('finishAsk 写入 AskBlock', () => {
    const store = createMessagesStore();
    store.getState().finishAsk('q1', {
      id: 'q1',
      kind: 'ask',
      summary: 'Answered 1 question',
      items: ['Auth → OAuth'],
    });
    const items = store.getState().model.items;
    expect(items[0]).toMatchObject({ kind: 'ask', summary: 'Answered 1 question' });
  });

  it('thinking start → finish defer 后可附加到工具组', () => {
    const store = createMessagesStore();
    store.getState().startThinking('Thinking…');
    store.getState().finishThinking({
      id: 'th1',
      kind: 'system',
      subkind: 'thinking-summary',
      text: 'Thought for 1s',
      durationMs: 1000,
      groupBoundary: 'transparent',
    });
    // deferred 后:startTool 应把它附加到 PendingTool
    store.getState().startTool({ toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' } });
    const item = store.getState().model.items[0];
    expect(item).toMatchObject({
      kind: 'pending-tool',
      thinking: [{ durationMs: 1000 }],
    });
  });

  it('clear:清空时间线', () => {
    const store = createMessagesStore();
    store.getState().startAssistant('hi');
    store.getState().clear();
    expect(store.getState().model.items).toEqual([]);
  });

  it('rewindLastUserTurn:删末条 user 及其后全部', () => {
    const store = createMessagesStore();
    store.getState().appendTranscript({ id: 'u1', kind: 'user', text: '你好' });
    store.getState().appendTranscript({ id: 's1', kind: 'system', subkind: 'notification', text: 'thinking', groupBoundary: 'break' });
    store.getState().rewindLastUserTurn();
    expect(store.getState().model.items).toEqual([]);
  });

  it('rewindLastUserTurn:保留 user 之前的消息', () => {
    const store = createMessagesStore();
    store.getState().appendTranscript({ id: 'a1', kind: 'assistant', text: '上次回复' });
    store.getState().appendTranscript({ id: 'u1', kind: 'user', text: '第二次提问' });
    store.getState().rewindLastUserTurn();
    const items = store.getState().model.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('assistant');
  });

  it('rewindLastUserTurn:无 user 时幂等', () => {
    const store = createMessagesStore();
    store.getState().appendTranscript({ id: 's1', kind: 'system', subkind: 'notification', text: 'banner', groupBoundary: 'break' });
    store.getState().rewindLastUserTurn();
    expect(store.getState().model.items.length).toBe(1);
  });

  it('appendTurnDurationMessage 写入 turn-duration 块', () => {
    const store = createMessagesStore();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      store.getState().appendTurnDurationMessage(9_000);
      const items = store.getState().model.items;
      const td = items.find(i => i.kind === 'turn-duration');
      expect(td).toMatchObject({ kind: 'turn-duration', verb: 'Cooked', durationMs: 9_000 });
    } finally {
      random.mockRestore();
    }
  });

  it('resolveTool 未知 toolUseId 返回 false', () => {
    const store = createMessagesStore();
    store.getState().startTool({ toolUseId: 't1', toolName: 'glob', input: {} });
    const presentation: ToolPresentation = {
      toolUseId: 'missing', toolName: 'glob', summary: 's', details: [], status: 'success',
    };
    expect(store.getState().resolveTool('missing', presentation)).toBe(false);
  });

  it('selectCommittedTranscript 返回已固化前缀', () => {
    const store = createMessagesStore();
    store.getState().startTool({ toolUseId: 'g1', toolName: 'glob', input: {} });
    // pending-tool 是活动项,committed 应为空
    expect(selectCommittedTranscript(store.getState().model.items)).toEqual([]);
  });
});
