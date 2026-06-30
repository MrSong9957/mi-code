// src/__tests__/ui/block-pipeline.test.ts
// 统一输出管道 BlockPipeline 测试

import { describe, it, expect, vi } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import type { Block } from '../../ui/types.js';

/** mock 的 UILayout：记录所有调用，便于断言路由 */
function mockLayout() {
  const calls: { method: string; args: unknown[] }[] = [];
  const layout = {
    send: vi.fn((...args: unknown[]) => { calls.push({ method: 'send', args }); }),
    appendStreaming: vi.fn((...args: unknown[]) => { calls.push({ method: 'appendStreaming', args }); }),
    appendStreamingMarkdown: vi.fn((...args: unknown[]) => { calls.push({ method: 'appendStreamingMarkdown', args }); }),
    finalizeStreaming: vi.fn((...args: unknown[]) => { calls.push({ method: 'finalizeStreaming', args }); }),
    clear: vi.fn(),
    commit: vi.fn(),
  };
  return { layout, calls };
}

describe('BlockPipeline', () => {
  describe('emit 路由（转发 UILayout）', () => {
    it('user_input → layout.send("input", text)', () => {
      const { layout, calls } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({ kind: 'user_input', text: '你好' });
      expect(layout.send).toHaveBeenCalledWith('input', '你好');
      expect(calls.some(c => c.method === 'send')).toBe(true);
    });

    it('thinking_start → layout.send("thinking")', () => {
      const { layout } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({ kind: 'thinking_start' });
      expect(layout.send).toHaveBeenCalledWith('thinking');
    });

    it('thinking_delta → layout.appendStreaming("thinking_content", content)', () => {
      const { layout } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({ kind: 'thinking_delta', content: '用户问...' });
      expect(layout.appendStreaming).toHaveBeenCalledWith('thinking_content', '用户问...');
    });

    it('thinking_end → layout.finalizeStreaming(duration, filesRead)', () => {
      const { layout } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 2 });
      expect(layout.finalizeStreaming).toHaveBeenCalledWith(5, 2);
    });

    it('assistant_text → layout.appendStreamingMarkdown(text, isFinal)', () => {
      const { layout } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({ kind: 'assistant_text', text: '你好', isFinal: false });
      expect(layout.appendStreamingMarkdown).toHaveBeenCalledWith('你好', false);
    });

    it('tool_call → layout.send("tool_call", "", {toolName, toolInput})', () => {
      const { layout } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
      expect(layout.send).toHaveBeenCalledWith('tool_call', '', { toolName: 'run_bash', toolInput: { command: 'ls' } });
    });

    it('tool_result → layout.send("tool_result", "", meta)，meta 由 buildToolResultBlock 计算', () => {
      const { layout } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({
        kind: 'tool_result',
        name: 'edit_file',
        input: { path: 'a.ts', old_text: 'x', new_text: 'y\nz' },
        output: 'File edited: a.ts',
      });
      // 应被 send 到 tool_result，meta 含 linesAdded（来自 buildToolResultBlock）
      expect(layout.send).toHaveBeenCalled();
      const callArgs = (layout.send as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[0]).toBe('tool_result');
      expect(callArgs[2]).toHaveProperty('linesAdded');
    });

    it('tool_result 无 input → meta 走 rawOutput 分支', () => {
      const { layout } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'stdout...' });
      const callArgs = (layout.send as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[2]).toHaveProperty('rawOutput', 'stdout...');
    });

    it('system → layout.send("system", text)', () => {
      const { layout } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({ kind: 'system', text: '[Hook] started' });
      expect(layout.send).toHaveBeenCalledWith('system', '[Hook] started');
    });

    it('error → layout.send("error", text)', () => {
      const { layout } = mockLayout();
      const p = new BlockPipeline(layout);
      p.emit({ kind: 'error', text: '[Error] boom' });
      expect(layout.send).toHaveBeenCalledWith('error', '[Error] boom');
    });
  });
});
