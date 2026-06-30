import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OutputGate } from '../../output/output-gate.js';

describe('OutputGate', () => {
  let gate: OutputGate;
  let writer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writer = vi.fn();
    gate = new OutputGate({
      rows: 24,
      cols: 80,
      writer,
    });
  });

  describe('send', () => {
    it('should queue message', () => {
      gate.send('system', 'test message');
      expect(gate.queueSize).toBe(1);
    });

    it('should normalize content', () => {
      gate.send('system', 'Hello\x00World');
      // 内容应该被标准化（移除 null 字节）
      expect(gate.queueSize).toBe(1);
    });
  });

  describe('flush', () => {
    it('should process all queued messages', () => {
      gate.send('system', 'msg1');
      gate.send('system', 'msg2');
      gate.flush();
      expect(writer).toHaveBeenCalledTimes(2);
      expect(gate.queueSize).toBe(0);
    });

    it('should process messages in priority order', () => {
      gate.send('system', 'low');
      gate.send('error', 'high');
      gate.send('assistant', 'mid');

      gate.flush();
      const calls = writer.mock.calls.map(c => c[0]);
      // error 应该最先被处理
      expect(calls[0]).toContain('high');
      expect(calls[1]).toContain('mid');
      expect(calls[2]).toContain('low');
    });

    it('should apply styles', () => {
      gate.send('error', 'test', { fg: 'red', bold: true });
      gate.flush();
      const output = writer.mock.calls[0]?.[0] ?? '';
      expect(output).toContain('\x1b['); // ANSI escape
      expect(output).toContain('test');
    });

    it('should handle empty queue', () => {
      gate.flush();
      expect(writer).not.toHaveBeenCalled();
    });
  });

  describe('normalize', () => {
    it('should remove null bytes', () => {
      expect(gate.normalize('Hello\x00World')).toBe('HelloWorld');
    });

    it('should handle empty string', () => {
      expect(gate.normalize('')).toBe('');
    });
  });

  describe('updateTermSize', () => {
    it('should update terminal size', () => {
      gate.updateTermSize({ rows: 40, cols: 120 });
      // 不应抛出错误
    });
  });
});
