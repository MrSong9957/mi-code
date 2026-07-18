import { describe, it, expect, vi } from 'vitest';
import { createMessagesStore } from '../../tui/state/messages-store.js';
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
});
