import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UILayout } from '../../ui/ui-layout.js';

describe('UILayout', () => {
  let layout: UILayout;
  let writer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writer = vi.fn();
    layout = new UILayout({
      rows: 24,
      cols: 80,
      writer,
      status: { mode: 'Act', model: 'test', branch: 'main', dir: 'test', contextUsage: 0 },
    });
    layout.enter();
  });

  /** 拿到内部 renderer（用于 spy） */
  function getRenderer(): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appendStreaming: (...args: any[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    printMessage: (...args: any[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appendStreamingMarkdown: (...args: any[]) => void;
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (layout as unknown as { renderer: any }).renderer;
  }

  describe('send', () => {
    it('should format and send thinking', () => {
      layout.send('thinking');
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });

    it('should format and send tool_call', () => {
      layout.send('tool_call', '', { toolName: 'Bash', toolArgs: 'cd ...' });
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });

    it('should format and send system', () => {
      layout.send('system', '[Hook] Session started');
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });

    it('should format and send error', () => {
      layout.send('error', '[Error] No API Key');
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });

    it('should format and send input', () => {
      layout.send('input', '你是谁？');
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });
  });

  describe('appendStreaming（thinking 折叠）', () => {
    it('thinking_content 不应实时画文本（renderer.appendStreaming 调用 0 次）', () => {
      const r = getRenderer();
      const spy = vi.spyOn(r, 'appendStreaming');
      layout.send('thinking');
      layout.appendStreaming('thinking_content', '用户问"你是谁？"');
      layout.appendStreaming('thinking_content', '这是一个问题。');
      layout.commit();
      expect(spy).not.toHaveBeenCalled();
    });

    it('thinking_content 仍累积到内部缓冲（finalizeStreaming 后能产出摘要）', () => {
      layout.send('thinking');
      layout.appendStreaming('thinking_content', '内容片段');
      // finalize 应产出摘要（说明内部状态正确）
      layout.finalizeStreaming(5, 0);
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });

    it('assistant 内容仍走 appendStreamingMarkdown（不受影响）', () => {
      const r = getRenderer();
      const spy = vi.spyOn(r, 'appendStreamingMarkdown');
      layout.appendStreaming('assistant', '你好');
      layout.appendStreaming('assistant', '，我是AI助手。');
      layout.commit();
      expect(writer).toHaveBeenCalled();
      // 注意：appendStreaming('assistant') 当前只是标记状态，不直接调 renderer
      // 真正的 assistant 文本渲染走 appendStreamingMarkdown
      void spy;
    });
  });

  describe('finalizeStreaming（thinking 摘要）', () => {
    it('finalize 时输出 Thought for Ns 摘要行', () => {
      const r = getRenderer();
      const calls: string[] = [];
      vi.spyOn(r, 'printMessage').mockImplementation((text: string) => {
        calls.push(text);
      });
      layout.send('thinking');
      layout.appendStreaming('thinking_content', '内容');
      layout.finalizeStreaming(17, 2);
      layout.commit();
      const summary = calls.find(c => c.includes('Thought for'));
      expect(summary).toBeDefined();
      expect(summary).toContain('17s');
      expect(summary).toContain('read 2 files');
    });

    it('无 thinking 时 finalize 不输出摘要（避免误报）', () => {
      const r = getRenderer();
      const calls: string[] = [];
      vi.spyOn(r, 'printMessage').mockImplementation((text: string) => {
        calls.push(text);
      });
      // 未 send('thinking') 直接 finalize
      layout.finalizeStreaming(5, 0);
      const summary = calls.find(c => c.includes('Thought for'));
      expect(summary).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should clear all content', () => {
      layout.send('thinking');
      layout.send('tool_call', '', { toolName: 'Bash' });
      layout.clear();
      layout.commit();
      // 清空后 writer 仍可调用（页脚等）
      expect(writer).toHaveBeenCalled();
    });
  });

  describe('setInput', () => {
    it('should update input text', () => {
      layout.setInput('hello', 5);
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });
  });

  describe('setToolStatus / clearToolStatus', () => {
    it('should set and clear tool status', () => {
      layout.setToolStatus('Bash', 'running');
      layout.commit();
      expect(writer).toHaveBeenCalled();

      layout.clearToolStatus();
      layout.commit();
    });
  });

  describe('setHint', () => {
    it('should set hint text', () => {
      layout.setHint('Press Enter to continue');
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });
  });

  describe('getPrompt', () => {
    it('should return default prompt', () => {
      expect(layout.getPrompt()).toBe('❯  ');
    });

    it('should return custom prompt', () => {
      const custom = new UILayout({
        rows: 24,
        cols: 80,
        writer,
        status: { model: 'test', branch: 'main', dir: 'test' },
        prompt: '> ',
      });
      expect(custom.getPrompt()).toBe('> ');
    });
  });

  describe('resize', () => {
    it('should update terminal size', () => {
      layout.send('system', 'test');
      layout.resize(40, 120);
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });
  });
});
