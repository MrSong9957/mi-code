import { describe, expect, it } from 'vitest';
import {
  completeActivity,
  type AssistantBlock,
  type PendingTool,
  type ToolBlock,
  type ToolPresentation,
} from '../../tui/transcript-types.js';
import {
  emptyModel,
  startTool,
  resolveTool,
  deferThinking,
  flushDeferredThinking,
  appendBoundaryBlock,
  selectCommittedTranscript,
  orderToolPresentations,
  summarizeThinking,
  type ThinkingSummaryBlock,
} from '../../tui/state/transcript-reducer.js';

function thinkingSummary(durationMs: number): ThinkingSummaryBlock {
  return {
    id: `thinking-${durationMs}`,
    kind: 'system',
    subkind: 'thinking-summary',
    text: `Thought for ${durationMs / 1_000}s`,
    durationMs,
    groupBoundary: 'transparent',
  };
}

function globPresentation(toolUseId: string): ToolPresentation {
  return {
    toolUseId,
    toolName: 'glob',
    summary: `${toolUseId}.ts → 1 file`,
    details: [{ kind: 'path', path: `${toolUseId}.ts` }],
    status: 'success',
  };
}

function pendingTool(
  id: string,
  toolName: string,
  toolUseIds: readonly string[],
): PendingTool {
  return {
    id,
    kind: 'pending-tool',
    toolName,
    closed: false,
    entries: toolUseIds.map(toolUseId => ({
      toolUseId,
      input: { pattern: `${toolUseId}.ts` },
    })),
    thinking: [],
  };
}

function completePendingTool(
  pending: PendingTool,
  presentations: readonly ToolPresentation[],
): ToolBlock {
  if (pending.entries.length !== presentations.length) {
    throw new Error('Fixture presentations must match pending entries');
  }
  return completeActivity({
    ...pending,
    closed: true,
    entries: pending.entries.map((entry, index) => ({
      ...entry,
      presentation: presentations[index]!,
    })),
  });
}

describe('transcript reducer grouping', () => {
  it('adds adjacent same-name calls to one PendingTool despite parameter differences', () => {
    let model = emptyModel();
    model = startTool(model, { activityId: 'tg1', toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' } });
    model = startTool(model, { activityId: 'tg2', toolUseId: 'g2', toolName: 'glob', input: { pattern: '*.json' } });
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      kind: 'pending-tool',
      toolName: 'glob',
      entries: [{ toolUseId: 'g1' }, { toolUseId: 'g2' }],
    });
  });

  it('closes a group on assistant text or a different tool', () => {
    let model = startTool(emptyModel(), {
      activityId: 'tg1', toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' },
    });
    model = appendBoundaryBlock(model, { id: 'a1', kind: 'assistant', text: 'Now inspect it.' });
    model = startTool(model, {
      activityId: 'tg2', toolUseId: 'g2', toolName: 'glob', input: { pattern: '*.json' },
    });
    expect(model.items.filter(item => item.kind === 'pending-tool')).toHaveLength(2);
  });

  it('attaches deferred thinking to a matching read-only group', () => {
    let model = deferThinking(emptyModel(), thinkingSummary(1_000));
    model = startTool(model, {
      activityId: 'tg1', toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' },
    });
    expect(model.deferredThinking).toEqual([]);
    expect(model.items[0]).toMatchObject({
      kind: 'pending-tool',
      thinking: [{ durationMs: 1_000 }],
    });
  });

  it('flushes deferred thinking before non-tool content', () => {
    let model = deferThinking(emptyModel(), thinkingSummary(1_000));
    model = appendBoundaryBlock(model, { id: 'a1', kind: 'assistant', text: 'Done.' });
    expect(model.items.map(item => item.kind)).toEqual(['system', 'assistant']);
  });

  it('atomically closes a resolved open group before appending a boundary', () => {
    let model = startTool(emptyModel(), {
      activityId: 'tg1',
      toolUseId: 'g1',
      toolName: 'glob',
      input: { pattern: '*.ts' },
    });
    model = resolveTool(model, 'g1', globPresentation('g1'));
    expect(model.items[0]?.kind).toBe('pending-tool');

    model = appendBoundaryBlock(model, {
      id: 'a1',
      kind: 'assistant',
      text: 'Done.',
    });
    expect(model.items.map(item => item.kind)).toEqual(['tool', 'assistant']);
  });

  it('closes but does not complete an unresolved group at a boundary', () => {
    let model = startTool(emptyModel(), {
      activityId: 'tg1',
      toolUseId: 'g1',
      toolName: 'glob',
      input: { pattern: '*.ts' },
    });

    expect(() => {
      model = appendBoundaryBlock(model, {
        id: 'a1',
        kind: 'assistant',
        text: 'Waiting for the result.',
      });
    }).not.toThrow();
    expect(model.items[0]).toMatchObject({
      kind: 'pending-tool',
      closed: true,
      entries: [{ toolUseId: 'g1' }],
    });
    expect(model.items[0]?.kind === 'pending-tool'
      ? model.items[0].entries[0]?.presentation
      : 'wrong-kind').toBeUndefined();
    expect(model.items[1]).toMatchObject({ kind: 'assistant' });
    expect(selectCommittedTranscript(model.items)).toEqual([]);

    model = resolveTool(model, 'g1', globPresentation('g1'));
    expect(model.items.map(item => item.kind)).toEqual(['tool', 'assistant']);
    expect(selectCommittedTranscript(model.items).map(item => item.kind))
      .toEqual(['tool', 'assistant']);
  });

  it('withholds later transcript blocks until an earlier activity settles', () => {
    const pending = pendingTool('p1', 'glob', ['g1']);
    const later: AssistantBlock = { id: 'a1', kind: 'assistant', text: 'later' };
    expect(selectCommittedTranscript([pending, later])).toEqual([]);

    const completed = completePendingTool(pending, [globPresentation('g1')]);
    expect(selectCommittedTranscript([completed, later])).toEqual([completed, later]);
  });
});

describe('tool presentation ordering', () => {
  it('orders success, then empty, then error, preserving relative order within each', () => {
    const s1: ToolPresentation = { toolUseId: 's1', toolName: 'glob', summary: 's1', details: [], status: 'success' };
    const e1: ToolPresentation = { toolUseId: 'e1', toolName: 'glob', summary: 'e1', details: [], status: 'empty' };
    const err1: ToolPresentation = { toolUseId: 'err1', toolName: 'glob', summary: 'err1', details: [], status: 'error' };
    const s2: ToolPresentation = { toolUseId: 's2', toolName: 'glob', summary: 's2', details: [], status: 'success' };
    const ordered = orderToolPresentations([err1, s2, e1, s1]);
    expect(ordered.map(p => p.toolUseId)).toEqual(['s2', 's1', 'e1', 'err1']);
  });
});

describe('thinking metadata summary', () => {
  it('returns null for a single entry below 2000ms', () => {
    expect(summarizeThinking([{ durationMs: 1_000 }])).toBeNull();
  });
  it('returns Thought Ns for a single entry at 2000ms', () => {
    expect(summarizeThinking([{ durationMs: 2_000 }])).toBe('Thought 2s');
  });
  it('aggregates multiple entries', () => {
    expect(summarizeThinking([{ durationMs: 1_000 }, { durationMs: 2_000 }])).toBe('Thought 3s (2 entries)');
  });
  it('returns null for empty', () => {
    expect(summarizeThinking([])).toBeNull();
  });
});
