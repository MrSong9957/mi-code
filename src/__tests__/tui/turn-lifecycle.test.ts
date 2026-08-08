// src/__tests__/tui/turn-lifecycle.test.ts
//
// AUTO-0025-transient Task 2:turn-level thinking 状态 + 统一清理。
//
// 验证:startTurnThinking/finishTurnThinking 幂等、duration 向下取整、
// 乱序工具调用只 emit 一次 thinking_end、finalizeTurnLifecycle 一次摘要 + 一次 completion。

import { describe, expect, it, vi } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import { stopSpinnerAndAppendCompletion } from '../../tui/bootstrap.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import {
  finalizeTurnLifecycle,
  finishTurnThinking,
  handleTurnLoopEnd,
  idleTurnThinking,
  startTurnThinking,
  type TurnLifecycle,
} from '../../tui/turn-lifecycle.js';

function createTestPipeline(messagesStore: ReturnType<typeof createMessagesStore>): BlockPipeline {
  return new BlockPipeline(
    new PipelineToStoreAdapter(messagesStore),
    createTranslator(createLanguageStore('zh-CN')),
  );
}

function makeLifecycle(
  pipeline: BlockPipeline,
  spinnerStore: ReturnType<typeof createSpinnerStore>,
  messagesStore: ReturnType<typeof createMessagesStore>,
): {
  lifecycle: TurnLifecycle;
  events: string[];
} {
  const events: string[] = [];
  const lifecycle: TurnLifecycle = {
    activeToolIds: new Set(['tool-1']),
    setSpinnerHasActiveTools: (hasActiveTools: boolean) => {
      events.push(`tools:${hasActiveTools}`);
    },
    emitThinkingEnd: (durationSec: number) => {
      events.push(`thinking_end:${durationSec}`);
      pipeline.emit({ kind: 'thinking_end', durationSec, filesRead: 0 });
    },
    stopSpinner: () => {
      events.push('stop');
      stopSpinnerAndAppendCompletion(spinnerStore, messagesStore);
    },
    now: Date.now,
  };
  return { lifecycle, events };
}

describe('TurnThinkingState 纯函数 (AUTO-0025-transient)', () => {
  it('startTurnThinking 幂等:已 active 返回原状态', () => {
    const s1 = startTurnThinking(idleTurnThinking(), 1_000);
    const s2 = startTurnThinking(s1, 2_000);
    expect(s2).toBe(s1);
    expect(s2).toEqual({ active: true, startedAtMs: 1_000 });
  });

  it('finishTurnThinking 幂等:未 active 返回空闲态,不 emit', () => {
    const events: string[] = [];
    const lifecycle: TurnLifecycle = {
      activeToolIds: new Set(),
      setSpinnerHasActiveTools: () => {},
      emitThinkingEnd: (sec) => { events.push(`thinking_end:${sec}`); },
      stopSpinner: () => {},
      now: () => 5_000,
    };
    const result = finishTurnThinking(lifecycle, idleTurnThinking());
    expect(result).toEqual(idleTurnThinking());
    expect(events).toEqual([]);
  });

  it('duration 向下取整:1500ms → emit 1(不夸大)', () => {
    const events: string[] = [];
    const lifecycle: TurnLifecycle = {
      activeToolIds: new Set(),
      setSpinnerHasActiveTools: () => {},
      emitThinkingEnd: (sec) => { events.push(`thinking_end:${sec}`); },
      stopSpinner: () => {},
      now: () => 1_500,
    };
    const state = startTurnThinking(idleTurnThinking(), 0);
    finishTurnThinking(lifecycle, state);
    expect(events).toEqual(['thinking_end:1']);
  });
});

describe('turn lifecycle 集成', () => {
  it('loop-end 只清工具,finalize 一次摘要 + 一次 completion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const messagesStore = createMessagesStore();
      const spinnerStore = createSpinnerStore();
      const pipeline = createTestPipeline(messagesStore);
      const { lifecycle, events } = makeLifecycle(pipeline, spinnerStore, messagesStore);

      spinnerStore.getState().start('thinking');
      pipeline.emit({ kind: 'thinking_start' });
      pipeline.emit({ kind: 'thinking_delta', content: '实质内容' });
      vi.setSystemTime(9_000);

      handleTurnLoopEnd(lifecycle);
      expect(events).toEqual(['tools:false']);
      expect(spinnerStore.getState().active).toBe(true);

      let thinking = startTurnThinking(idleTurnThinking(), 0);
      thinking = finalizeTurnLifecycle(lifecycle, thinking);
      // 幂等:第二次不再 emit thinking_end
      thinking = finalizeTurnLifecycle(lifecycle, thinking);

      expect(thinking).toEqual(idleTurnThinking());
      expect(events).toEqual([
        'tools:false',
        'tools:false', 'thinking_end:9', 'stop',
        'tools:false', 'stop',
      ]);
      const messages = messagesStore.getState().messages;
      const completion = messages.filter(m => m.kind === 'turn-duration');
      expect(completion).toHaveLength(1);
      // Thought 摘要(大写)在 completion 之前
      const allLines = messages.flatMap(m => m.lines);
      expect(allLines.findIndex(l => l.content.includes('Thought for 9s')))
        .toBeLessThan(allLines.findIndex(l => l.content === '✻ Cooked for 9s'));
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('无 start 的 delta 前隐式 start', () => {
    // 验证:no-start delta 场景,调用方应先 startTurnThinking 再 emit delta
    const state = idleTurnThinking();
    // 模拟 index.ts 的隐式 start 路径
    const started = startTurnThinking(state, Date.now());
    expect(started.active).toBe(true);
  });

  it('duration 边界:startedAtMs=0, now=1500 → thinking_end:1 + Thought for 1s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const messagesStore = createMessagesStore();
      const pipeline = createTestPipeline(messagesStore);
      const spinnerStore = createSpinnerStore();
      const { lifecycle } = makeLifecycle(pipeline, spinnerStore, messagesStore);

      pipeline.emit({ kind: 'thinking_start' });
      pipeline.emit({ kind: 'thinking_delta', content: 'x' });
      vi.setSystemTime(1_500);

      const state = startTurnThinking(idleTurnThinking(), 0);
      finishTurnThinking(lifecycle, state);

      // Task 6:thinking summary 被 defer,需 flush 才进 items。
      // finishTurnThinking 只 emit thinking_end(不 stopSpinner),故检查 deferred。
      const deferred = messagesStore.getState().model.deferredThinking;
      // floor(1500/1000)=1,摘要显示 Thought for 1s
      expect(deferred.some(s => s.text.includes('Thought for 1s'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
