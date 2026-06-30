// src/__tests__/ui/block-pipeline.test.ts
// 统一输出管道 BlockPipeline 测试

import { describe, it, expect, vi } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import type { Block } from '../../ui/types.js';

/** mock 的 Renderer：记录所有 printMessage / appendStreamingMarkdown 调用 */
function mockRenderer() {
  const prints: { text: string; role?: string; style?: Record<string, unknown> }[] = [];
  const streamMarks: { text: string; isFinal: boolean }[] = [];
  const renderer = {
    printMessage: vi.fn((text: string, role?: string, style?: Record<string, unknown>) => {
      prints.push({ text, role, style });
    }),
    appendStreamingMarkdown: vi.fn((text: string, isFinal: boolean) => {
      streamMarks.push({ text, isFinal });
    }),
    finalizeStreaming: vi.fn(),
    appendStreaming: vi.fn(),
    flushNow: vi.fn(),
    clearMessages: vi.fn(),
  };
  return { renderer, prints, streamMarks };
}

describe('BlockPipeline', () => {
  describe('emit 路由 + 格式契约', () => {
    it('user_input → printMessage("❯ 你好", green bold)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'user_input', text: '你好' });
      expect(prints[0].text).toBe('❯ 你好');
      expect(prints[0].style).toMatchObject({ fg: 'green', bold: true });
    });

    it('thinking_start → printMessage("● Thinking…", magenta)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      expect(prints[0].text).toBe('● Thinking…');
      expect(prints[0].style).toMatchObject({ fg: 'magenta' });
    });

    it('thinking_delta → 不渲染（折叠），仅累积', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_delta', content: '用户问...' });
      expect(prints.length).toBe(0); // 不产生任何输出
    });

    it('thinking_end → printMessage("  Thought for Ns...", dim)，需先 thinking_start', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 2 });
      const summary = prints.find(p => p.text.includes('Thought for'));
      expect(summary).toBeDefined();
      expect(summary!.text).toBe('  Thought for 5s, read 2 files (ctrl+o to expand)');
      expect(summary!.style).toMatchObject({ dim: true });
    });

    it('thinking_end 未 thinking_start → 不输出摘要', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 0 });
      expect(prints.find(p => p.text.includes('Thought for'))).toBeUndefined();
    });

    it('assistant_text → appendStreamingMarkdown(text, isFinal, opts)', () => {
      const { renderer, streamMarks } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'assistant_text', text: '你好', isFinal: false });
      // 第三个参数是格式 opts（含 indent/firstLinePrefix）
      expect(renderer.appendStreamingMarkdown).toHaveBeenCalledWith(
        '你好', false, expect.objectContaining({ firstLinePrefix: '● ' }),
      );
    });

    it('tool_call → printMessage("● Bash(cmd)", magenta)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
      expect(prints[0].text).toBe('● Bash(ls)');
      expect(prints[0].style).toMatchObject({ fg: 'magenta' });
    });

    it('tool_result edit_file → printMessage("⎿  Added N lines...", dim)，含行数', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({
        kind: 'tool_result',
        name: 'edit_file',
        input: { path: 'a.ts', old_text: 'x', new_text: 'y\nz' },
        output: 'File edited: a.ts',
      });
      const resultLine = prints.find(p => p.text.includes('⎿'));
      expect(resultLine).toBeDefined();
      expect(resultLine!.text).toContain('Added');
      expect(resultLine!.style).toMatchObject({ dim: true });
    });

    it('tool_result run_bash → rawOutput 摘要', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'stdout line1' });
      const resultLine = prints.find(p => p.text.includes('stdout'));
      expect(resultLine).toBeDefined();
    });

    it('system → printMessage(text, default)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'system', text: '[Hook] started' });
      expect(prints[0].text).toBe('[Hook] started');
    });

    it('error → printMessage(text, red)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'error', text: '[Error] boom' });
      expect(prints[0].text).toBe('[Error] boom');
      expect(prints[0].style).toMatchObject({ fg: 'red' });
    });
  });

  describe('块间空行（集中化）', () => {
    it('首个块前不加空行', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'system', text: 'first' });
      // 第一个块：不应有空行 printMessage('')
      expect(prints[0].text).toBe('first');
      expect(prints.some(p => p.text === '')).toBe(false);
    });

    it('第二个块前加空行（thinking_start 在 system 之后）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'system', text: 'first' });
      p.emit({ kind: 'thinking_start' });
      // 第二个块（thinking_start）前应有空行
      const thinkingIdx = prints.findIndex(p => p.text === '● Thinking…');
      expect(thinkingIdx).toBeGreaterThan(0);
      expect(prints[thinkingIdx - 1].text).toBe('');
    });

    it('assistant_text 多次 delta 只加一次空行', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' }); // 建立块 1
      // assistant 流式块
      p.emit({ kind: 'assistant_text', text: 'a', isFinal: false });
      p.emit({ kind: 'assistant_text', text: 'ab', isFinal: false });
      p.emit({ kind: 'assistant_text', text: 'abc', isFinal: true });
      // assistant 块前应只有一个空行（thinking 与 assistant 之间）
      const emptyCount = prints.filter(p => p.text === '').length;
      expect(emptyCount).toBe(1);
    });

    it('tool_result 紧跟 tool_call 不加额外空行（结果续接调用）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1' });
      const emptyCount = prints.filter(p => p.text === '').length;
      expect(emptyCount).toBe(0); // 首块 tool_call，result 续接，无空行
    });
  });
});

