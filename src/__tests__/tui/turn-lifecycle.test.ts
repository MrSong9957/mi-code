import { describe, expect, it, vi } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { stopSpinnerAndAppendCompletion } from '../../tui/bootstrap.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { finalizeTurnLifecycle, handleTurnLoopEnd } from '../../tui/turn-lifecycle.js';

describe('turn lifecycle', () => {
  it('keeps loop end cleanup-only and finalizes Thinking before one completion message', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const messagesStore = createMessagesStore();
      const spinnerStore = createSpinnerStore();
      const pipeline = new BlockPipeline(new PipelineToStoreAdapter(messagesStore));
      const activeToolIds = new Set(['tool-1']);
      const events: string[] = [];
      const lifecycle = {
        activeToolIds,
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

      spinnerStore.getState().start('thinking');
      pipeline.emit({ kind: 'thinking_start' });
      vi.setSystemTime(9_000);

      handleTurnLoopEnd(lifecycle);
      expect(activeToolIds.size).toBe(0);
      expect(events).toEqual(['tools:false']);
      expect(spinnerStore.getState().active).toBe(true);
      expect(messagesStore.getState().messages.filter(message => message.kind === 'turn-duration'))
        .toHaveLength(0);

      const finalizedThinking = finalizeTurnLifecycle(lifecycle, {
        thinkingActive: true,
        thinkingContent: 'still thinking',
        thinkingStart: 0,
      });
      finalizeTurnLifecycle(lifecycle, finalizedThinking);

      expect(finalizedThinking).toEqual({ thinkingActive: false, thinkingContent: '' });
      expect(events).toEqual([
        'tools:false',
        'tools:false', 'thinking_end:9', 'stop',
        'tools:false', 'stop',
      ]);
      const messages = messagesStore.getState().messages;
      const completion = messages.filter(message => message.kind === 'turn-duration');
      expect(completion).toHaveLength(1);
      expect(completion[0]!.lines.map(line => line.content)).toEqual([
        '', '✻ Cooked for 9s',
      ]);
      const allLines = messages.flatMap(message => message.lines);
      expect(allLines.findIndex(line => line.content.includes('thought for 9s')))
        .toBeLessThan(allLines.findIndex(line => line.content === '✻ Cooked for 9s'));
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });
});
