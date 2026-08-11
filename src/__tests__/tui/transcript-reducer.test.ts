import { describe, expect, it } from 'vitest';
import {
  completeActivity,
  type AgentBlock,
  type AssistantBlock,
  type PendingAgent,
  type PendingTool,
  type ToolBlock,
  type ToolPresentation,
} from '../../tui/transcript-types.js';
import {
  emptyModel,
  startTool,
  resolveTool,
  startAgent,
  resolveAgent,
  cancelAgent,
  deferThinking,
  flushDeferredThinking,
  appendBoundaryBlock,
  selectCommittedTranscript,
  orderToolPresentations,
  summarizeThinking,
  shouldCommitThinking,
  THINKING_COMMIT_THRESHOLD_MS,
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

describe('agent lifecycle (startAgent / resolveAgent / cancelAgent)', () => {
  it('startAgent pushes a PendingAgent activity item and never groups', () => {
    let model = emptyModel();
    model = startAgent(model, { activityId: 'agent-1', agentUseId: 'a1', label: 'explore' });
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      kind: 'pending-agent',
      id: 'agent-1',
      label: 'explore',
    });

    // A second agent does NOT group with the first — each is standalone.
    model = startAgent(model, { activityId: 'agent-2', agentUseId: 'a2', label: 'plan' });
    expect(model.items.filter(i => i.kind === 'pending-agent')).toHaveLength(2);
  });

  it('resolveAgent completes the matching PendingAgent to an AgentBlock with the provided status', () => {
    let model = startAgent(emptyModel(), {
      activityId: 'a1', agentUseId: 'a1', label: 'explore',
    });
    model = resolveAgent(model, 'a1', {
      label: 'explore',
      status: 'completed',
      summary: 'found 3 files',
      durationMs: 5000,
    });
    expect(model.items.some(i => i.kind === 'pending-agent')).toBe(false);
    const block = model.items.find(i => i.kind === 'agent') as AgentBlock | undefined;
    expect(block).toBeDefined();
    expect(block!).toMatchObject({
      kind: 'agent',
      id: 'a1',
      label: 'explore',
      status: 'completed',
      summary: 'found 3 files',
      durationMs: 5000,
    });
  });

  it('resolveAgent on unknown agentUseId returns model unchanged', () => {
    const model = startAgent(emptyModel(), {
      activityId: 'a1', agentUseId: 'a1', label: 'explore',
    });
    const next = resolveAgent(model, 'nonexistent', { label: 'x', status: 'completed' });
    expect(next).toBe(model);
  });

  it('cancelAgent completes to an AgentBlock with status cancelled and the provided label', () => {
    let model = startAgent(emptyModel(), {
      activityId: 'a1', agentUseId: 'a1', label: 'explore',
    });
    model = cancelAgent(model, 'a1', 'explore');
    expect(model.items.some(i => i.kind === 'pending-agent')).toBe(false);
    const block = model.items.find(i => i.kind === 'agent') as AgentBlock | undefined;
    expect(block).toBeDefined();
    expect(block!).toMatchObject({
      kind: 'agent',
      id: 'a1',
      label: 'explore',
      status: 'cancelled',
    });
  });

  it('startAgent closes open tool groups and flushes deferred thinking (boundary behavior)', () => {
    let model = startTool(emptyModel(), {
      activityId: 'tg1', toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' },
    });
    model = deferThinking(model, thinkingSummary(2_000));
    model = startAgent(model, { activityId: 'a1', agentUseId: 'a1', label: 'explore' });
    // Open glob group closed (still pending-tool closed), deferred thinking flushed as system block.
    expect(model.items.some(i => i.kind === 'pending-tool' && i.closed)).toBe(true);
    expect(model.items.some(i => i.kind === 'system' && i.subkind === 'thinking-summary')).toBe(true);
    expect(model.items.some(i => i.kind === 'pending-agent')).toBe(true);
    expect(model.deferredThinking).toEqual([]);
  });

  it('completeActivity(PendingAgent) returns a minimal AgentBlock (type-level completeness)', () => {
    const pending: PendingAgent = { id: 'a1', kind: 'pending-agent', label: 'explore' };
    const block = completeActivity(pending);
    expect(block.kind).toBe('agent');
    expect(block.id).toBe('a1');
    expect(block.label).toBe('explore');
    expect(block.status).toBe('unknown');
  });
});

describe('tool presentation ordering', () => {
  it('orders success, then empty, then error, then cancelled, preserving relative order within each', () => {
    const s1: ToolPresentation = { toolUseId: 's1', toolName: 'glob', summary: 's1', details: [], status: 'success' };
    const e1: ToolPresentation = { toolUseId: 'e1', toolName: 'glob', summary: 'e1', details: [], status: 'empty' };
    const err1: ToolPresentation = { toolUseId: 'err1', toolName: 'glob', summary: 'err1', details: [], status: 'error' };
    const cancelled: ToolPresentation = { toolUseId: 'cancelled', toolName: 'spawn_agent', summary: 'spawn_agent → cancelled', details: [], status: 'cancelled' };
    const s2: ToolPresentation = { toolUseId: 's2', toolName: 'glob', summary: 's2', details: [], status: 'success' };
    const ordered = orderToolPresentations([cancelled, err1, s2, e1, s1]);
    expect(ordered.map(p => p.toolUseId)).toEqual(['s2', 's1', 'e1', 'err1', 'cancelled']);
    expect(orderToolPresentations([cancelled, err1, s1]).map(p => p.status))
      .toEqual(['success', 'error', 'cancelled']);
  });
});

describe('thinking metadata summary', () => {
  // Updated from "<2000ms" cutoff to "<1000ms" cutoff (Task 2 unified the
  // threshold). Intent unchanged: a single short entry is hidden.
  it('returns null for a single entry below 1000ms', () => {
    expect(summarizeThinking([{ durationMs: 500 }])).toBeNull();
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

describe('thinking commit threshold (single 1000ms rule)', () => {
  it('exposes a single 1000ms threshold', () => {
    expect(THINKING_COMMIT_THRESHOLD_MS).toBe(1000);
    expect(shouldCommitThinking(999)).toBe(false);
    expect(shouldCommitThinking(1000)).toBe(true);
  });
  it('shows a single grouped entry only at >=1s (was hidden below 2000ms)', () => {
    expect(summarizeThinking([{ durationMs: 1_500 }])).toBe('Thought 1.5s'); // RED: old rule returned null
    expect(summarizeThinking([{ durationMs: 500 }])).toBeNull();
  });
  it('gates multi-entry by aggregate total, not "always show"', () => {
    expect(summarizeThinking([{ durationMs: 300 }, { durationMs: 400 }])).toBeNull(); // 700 < 1000
    expect(summarizeThinking([{ durationMs: 600 }, { durationMs: 600 }])).toBe('Thought 1.2s (2 entries)');
  });
  it('flushDeferredThinking drops standalone summaries <1s', () => {
    const model = {
      ...emptyModel(),
      deferredThinking: [thinkingSummary(300), thinkingSummary(2_000)],
    };
    const flushed = flushDeferredThinking(model);
    expect(flushed.items).toHaveLength(1);
    expect((flushed.items[0] as { durationMs: number }).durationMs).toBe(2_000);
  });
  // Path 3 (ungroupable tool) has its own commit/flush site — it is NOT routed
  // through flushDeferredThinking, so it needs a direct threshold regression test.
  it('startTool path 3 drops a <1s deferred summary before an ungroupable tool', () => {
    let model = deferThinking(emptyModel(), thinkingSummary(300));
    model = startTool(model, {
      activityId: 't1', toolUseId: 'tu1', toolName: 'run_bash', input: { command: 'ls' },
    });
    expect(
      model.items.filter(
        item => item.kind === 'system' && item.subkind === 'thinking-summary',
      ),
    ).toEqual([]);
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      kind: 'pending-tool',
      toolName: 'run_bash',
      closed: true,
    });
  });
  it('startTool path 3 keeps a >=1s deferred summary before an ungroupable tool', () => {
    let model = deferThinking(emptyModel(), thinkingSummary(2_000));
    model = startTool(model, {
      activityId: 't1', toolUseId: 'tu1', toolName: 'run_bash', input: { command: 'ls' },
    });
    const summaries = model.items.filter(
      item => item.kind === 'system' && item.subkind === 'thinking-summary',
    );
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as { durationMs: number }).durationMs).toBe(2_000);
    // summary emitted via path 3 is positioned before the ungroupable tool
    const summaryIndex = model.items.findIndex(
      item => item.kind === 'system' && item.subkind === 'thinking-summary',
    );
    const toolIndex = model.items.findIndex(
      item => item.kind === 'pending-tool' && item.toolName === 'run_bash',
    );
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeLessThan(toolIndex);
  });
});
