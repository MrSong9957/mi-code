import { describe, it, expect, vi } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { stopSpinnerAndAppendCompletion } from '../../tui/bootstrap.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { renderFinalizedLine } from '../../tui/inline/text-layout.js';

describe('bootstrap spinner completion message', () => {
  it('在已有消息后追加空行，再追加 dim 的完成行', () => {
    const store = createMessagesStore();
    store.getState().appendLine('assistant', {
      content: '● 你好',
      style: { fg: 'brand' },
      indent: 0,
    });

    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      store.getState().appendTurnDurationMessage(9_000);
    } finally {
      random.mockRestore();
    }

    const messages = store.getState().messages;
    const completion = messages[1]!;
    const lines = messages.flatMap(m => m.lines);
    const completionIdx = lines.findIndex(l => l.content === '✻ Cooked for 9s');

    expect(completion).toMatchObject({ role: 'system', kind: 'turn-duration', finalized: true });
    expect(completion.lines).toHaveLength(2);
    expect(completionIdx).toBeGreaterThan(0);
    expect(lines[completionIdx - 1]!.content).toBe('');
    expect(lines[completionIdx]!.style).toMatchObject({ dim: true });

    const rendered = renderFinalizedLine('system', lines[completionIdx]!, 80).join('\n');
    expect(rendered).toContain('\x1b[2m');
  });

  it('keeps Thinking summary before the independent completion message and ignores repeated stops', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const messagesStore = createMessagesStore();
      const pipeline = new BlockPipeline(new PipelineToStoreAdapter(messagesStore));
      const spinnerStore = createSpinnerStore();

      spinnerStore.getState().start('thinking');
      pipeline.emit({ kind: 'thinking_start' });
      // AUTO-0025-transient:加非空 delta 让 thinking 进 visible 态(否则不产摘要)
      pipeline.emit({ kind: 'thinking_delta', content: '实质思考' });
      pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
      vi.setSystemTime(9_000);
      stopSpinnerAndAppendCompletion(spinnerStore, messagesStore);
      stopSpinnerAndAppendCompletion(spinnerStore, messagesStore);

      const messages = messagesStore.getState().messages;
      const completion = messages.filter(message => message.kind === 'turn-duration');
      expect(completion).toHaveLength(1);
      expect(completion[0]!.lines.map(line => line.content)).toEqual([
        '', '✻ Cooked for 9s',
      ]);
      const allLines = messages.flatMap(message => message.lines);
      expect(allLines.findIndex(line => line.content.includes('Thought for 1s')))
        .toBeLessThan(allLines.findIndex(line => line.content === '✻ Cooked for 9s'));
      expect(completion[0]!.lines[1]!.style).toMatchObject({ dim: true });
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });
});
