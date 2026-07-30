import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  completeActivity,
  isActivityItem,
  isTranscriptBlock,
  type AskBlock,
  type PendingThinking,
  type PendingTool,
  type StreamingAssistant,
  type ToolBlock,
} from '../../tui/transcript-types.js';

describe('transcript lifecycle types', () => {
  it('maps each activity kind to one deterministic transcript kind', () => {
    const assistant: StreamingAssistant = {
      id: 'a1', kind: 'streaming-assistant', text: 'hello',
    };
    expect(completeActivity(assistant)).toMatchObject({
      id: 'a1', kind: 'assistant', text: 'hello',
    });

    const tool: PendingTool = {
      id: 't1',
      kind: 'pending-tool',
      toolName: 'glob',
      closed: true,
      entries: [{
        toolUseId: 'u1',
        input: { pattern: '*.ts' },
        presentation: {
          toolUseId: 'u1',
          toolName: 'glob',
          summary: '*.ts → 2 files',
          details: [],
          status: 'success',
        },
      }],
      thinking: [],
    };
    expect(completeActivity(tool)).toMatchObject({
      id: 't1', kind: 'tool', toolName: 'glob',
    });

    const thinking: PendingThinking = {
      id: 'th1',
      kind: 'pending-thinking',
      text: 'private reasoning',
      summary: 'Thought for 2s',
      durationMs: 2_000,
    };
    expect(completeActivity(thinking)).toMatchObject({
      id: 'th1',
      kind: 'system',
      subkind: 'thinking-summary',
      groupBoundary: 'transparent',
    });
  });

  it('exposes disjoint runtime guards', () => {
    const ask: AskBlock = {
      id: 'q1',
      kind: 'ask',
      summary: 'Answered 1 question',
      items: ['Auth → OAuth'],
    };
    expect(isTranscriptBlock(ask)).toBe(true);
    expect(isActivityItem(ask)).toBe(false);
    expectTypeOf<ToolBlock['presentations']>().toMatchTypeOf<
      readonly { toolUseId: string }[]
    >();
  });
});
