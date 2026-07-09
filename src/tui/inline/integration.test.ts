import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    write: vi.fn((s: string) => { written.push(s); return true; }),
  };
}

describe('InlineRenderer integration: full REPL cycle', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('append message → render footer → commit → append next message', () => {
    // 1. Append first user message
    renderer.appendLine('user message 1');
    expect(mock.write).toHaveBeenLastCalledWith('user message 1\n');

    // 2. Render footer
    renderer.renderFooter('response 1', 5, 'sending | gpt-4');
    expect(mock.written.length).toBeGreaterThan(1);

    // 3. Commit footer (只重置状态，不写内容)
    renderer.commitFooter();

    // 4. Append next user message — should appear as new appendLine
    renderer.appendLine('user message 2');
    expect(mock.write).toHaveBeenLastCalledWith('user message 2\n');
  });

  it('streaming with footer redraw: render footer, rewrite lines, commit', () => {
    // Render footer
    renderer.renderFooter('partial', 0, 'streaming | model');
    const afterFirstRender = mock.written.length;

    // Rewrite the current line multiple times (simulating streaming)
    renderer.rewriteCurrentLine('partial res');
    renderer.rewriteCurrentLine('partial resp');
    renderer.rewriteCurrentLine('partial resp|');

    // All rewrites should have produced CR+erase sequences
    const rewrites = mock.written.slice(afterFirstRender);
    for (const chunk of rewrites) {
      expect(chunk).toContain('\r\x1b[K');
    }

    // Commit (只重置状态)
    renderer.commitFooter();

    // After commit, appending should work cleanly
    renderer.appendLine('done');
    expect(mock.write).toHaveBeenLastCalledWith('done\n');
  });
});
