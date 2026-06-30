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

/** 从 prints 找第一条非空内容（跳过块间空行） */
function firstContent(prints: { text: string }[]): { text: string } | undefined {
  return prints.find(p => p.text !== '');
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

    it('thinking_start → printMessage("● Thinking…", magenta)；首个模型块前有空行', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      // 第一个模型块前强制有空行（前面有 banner/用户输入）
      expect(prints[0].text).toBe('');
      const content = firstContent(prints);
      expect(content!.text).toBe('● Thinking…');
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

    it('tool_call → printMessage("● Bash(cmd)", magenta)；首个模型块前有空行', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
      expect(prints[0].text).toBe(''); // 首个模型块前空行
      const content = firstContent(prints);
      expect(content!.text).toBe('● Bash(ls)');
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

    // 注：system / error 不再是 Block kind——非模型内容（banner/hook/错误）
    // 直接走 UILayout.send，不经 pipeline。
  });

  describe('块间空行（集中化）', () => {
    it('首个模型块前有空行（前面总有 banner/用户输入）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      // 第一个模型块：强制加空行（pipeline 假设前面有非模型内容）
      expect(prints[0].text).toBe('');
      const content = firstContent(prints);
      expect(content!.text).toBe('● Thinking…');
    });

    it('第二个块前加空行（tool_call 在 thinking_end 之后）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
      // tool_call 前应有空行（thinking_end 的 finalize 分隔已被 justFinalized 抵消，
      // 但 tool_call openModelBlock 仍会在已有内容前加空行）
      const toolIdx = prints.findIndex(p => p.text.includes('Bash'));
      expect(toolIdx).toBeGreaterThan(0);
    });

    it('assistant_text 多次 delta 只加一次空行', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' }); // 建立块 1（含首块空行）
      // assistant 流式块
      p.emit({ kind: 'assistant_text', text: 'a', isFinal: false });
      p.emit({ kind: 'assistant_text', text: 'ab', isFinal: false });
      p.emit({ kind: 'assistant_text', text: 'abc', isFinal: true });
      // 空行数：首块 1（thinking 前）+ thinking→assistant 间 1 = 2
      const emptyCount = prints.filter(p => p.text === '').length;
      expect(emptyCount).toBe(2);
    });

    it('tool_result 紧跟 tool_call 不加额外空行（结果续接调用）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1' });
      const emptyCount = prints.filter(p => p.text === '').length;
      expect(emptyCount).toBe(1); // 仅首块 tool_call 前的空行，result 续接不另加
    });

    it('finalizeStreaming 后下一个块不出现双重空行', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // thinking 块（finalizeStreaming 会插分隔行）
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
      // 下一个块（assistant_text）
      p.emit({ kind: 'assistant_text', text: '你好', isFinal: true });
      // thinking 与 assistant 之间不应有连续两个空行
      const empties = prints.map(p => p.text === '');
      let consecutiveDouble = false;
      for (let i = 0; i < empties.length - 1; i++) {
        if (empties[i] && empties[i + 1]) { consecutiveDouble = true; break; }
      }
      expect(consecutiveDouble).toBe(false);
    });
  });
});

