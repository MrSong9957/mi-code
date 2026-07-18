import { describe, expect, it, vi } from 'vitest';
import {
  TURN_COMPLETION_VERBS,
  TurnDurationMessage,
  createTurnDurationMessage,
} from '../../tui/state/turn-duration-message.js';

describe('turn duration message', () => {
  it('创建时固定一次完成动词、时长、前导空行和 dim 样式', () => {
    const random = vi.fn(() => 0.5);

    const message = createTurnDurationMessage({
      uuid: 'msg-7', durationMs: 9_000, prependBlankLine: true, random,
    });

    expect(TURN_COMPLETION_VERBS).toHaveLength(8);
    expect(random).toHaveBeenCalledTimes(1);
    expect(message).toMatchObject({
      uuid: 'msg-7', role: 'system', kind: 'turn-duration',
      verb: 'Cooked', durationMs: 9_000, finalized: true,
    });
    expect(message.lines).toEqual([
      { content: '', style: {}, indent: 0 },
      { content: '✻ Cooked for 9s', style: { dim: true }, indent: 0 },
    ]);
    expect(TurnDurationMessage(message.verb, message.durationMs))
      .toEqual(message.lines[1]);
    expect(random).toHaveBeenCalledTimes(1);
  });
});
