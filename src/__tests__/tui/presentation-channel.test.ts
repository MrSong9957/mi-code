import { describe, expect, it } from 'vitest';
import { presentationChannel, isVisibleInNormalMode } from '../../tui/state/presentation-channel.js';
import type { TranscriptBlock } from '../../tui/transcript-types.js';

const user = (id = 'u'): TranscriptBlock => ({ id, kind: 'user', text: 'hi' });
const tool = (id = 't'): TranscriptBlock => ({ id, kind: 'tool', toolName: 'read_file', presentations: [], thinking: [] });
const thinkingSummary = (id = 'ts'): TranscriptBlock => ({ id, kind: 'system', subkind: 'thinking-summary', text: 'Thought for 2s', durationMs: 2000, groupBoundary: 'transparent' });
const hookOk = (id = 'h'): TranscriptBlock => ({ id, kind: 'system', subkind: 'notification', text: '[Hook] x done', groupBoundary: 'break' });
const hookErr = (id = 'he'): TranscriptBlock => ({ id, kind: 'system', subkind: 'notification', text: 'blocked', groupBoundary: 'break', tone: 'error' });

describe('presentationChannel', () => {
  it('classifies conversation vs activity vs diagnostics', () => {
    expect(presentationChannel(user())).toBe('conversation');
    expect(presentationChannel(tool())).toBe('activity');
    expect(presentationChannel(thinkingSummary())).toBe('activity');
    expect(presentationChannel(hookOk())).toBe('diagnostics');
    expect(presentationChannel(hookErr())).toBe('activity');
  });

  it('classifies agent as activity', () => {
    const agent: TranscriptBlock = { id: 'a1', kind: 'agent', label: 'explore', status: 'completed' };
    expect(presentationChannel(agent)).toBe('activity');
  });

  it('classifies turn-status as activity', () => {
    const turnStatus: TranscriptBlock = {
      id: 'ts1',
      kind: 'turn-status',
      status: 'partial',
      line: '⚠ Partial',
    };
    expect(presentationChannel(turnStatus)).toBe('activity');
  });
});

describe('isVisibleInNormalMode', () => {
  it('hides only non-error diagnostics', () => {
    expect(isVisibleInNormalMode(user())).toBe(true);
    expect(isVisibleInNormalMode(tool())).toBe(true);
    expect(isVisibleInNormalMode(hookErr())).toBe(true);
    expect(isVisibleInNormalMode(hookOk())).toBe(false);
  });
});
