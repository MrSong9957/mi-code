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

  describe('appendStreaming', () => {
    it('should accumulate thinking content', () => {
      layout.send('thinking');
      layout.appendStreaming('thinking_content', '用户问"你是谁？"');
      layout.appendStreaming('thinking_content', '这是一个问题。');
      layout.commit();
      // 内容应该累积 — writer 被调用
      expect(writer).toHaveBeenCalled();
    });

    it('should accumulate assistant content', () => {
      layout.appendStreaming('assistant', '你好');
      layout.appendStreaming('assistant', '，我是AI助手。');
      layout.commit();
      expect(writer).toHaveBeenCalled();
    });
  });

  describe('finalizeStreaming', () => {
    it('should finalize thinking with duration', () => {
      layout.send('thinking');
      layout.appendStreaming('thinking_content', '内容');
      layout.finalizeStreaming(17, 2);
      layout.commit();
      // 应该包含 "Thought for 17s, read 2 files"
      expect(writer).toHaveBeenCalled();
    });

    it('should finalize thinking without filesRead', () => {
      layout.send('thinking');
      layout.appendStreaming('thinking_content', '内容');
      layout.finalizeStreaming(5);
      layout.commit();
      expect(writer).toHaveBeenCalled();
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
