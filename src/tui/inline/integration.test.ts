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
});
