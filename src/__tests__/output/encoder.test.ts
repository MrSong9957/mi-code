import { describe, it, expect } from 'vitest';
import { Encoder } from '../../output/encoder.js';

describe('Encoder', () => {
  describe('normalize', () => {
    it('should pass through valid UTF-8', () => {
      const input = 'Hello 你好 🌍';
      expect(Encoder.normalize(input)).toBe(input);
    });

    it('should handle empty string', () => {
      expect(Encoder.normalize('')).toBe('');
    });

    it('should remove null bytes', () => {
      expect(Encoder.normalize('Hello\x00World')).toBe('HelloWorld');
    });

    it('should preserve ANSI escape sequences', () => {
      const input = '\x1b[31mRed\x1b[0m';
      expect(Encoder.normalize(input)).toBe(input);
    });
  });

  describe('isGarbled', () => {
    it('should detect garbled text', () => {
      expect(Encoder.isGarbled('�����ڲ����ⲿ���')).toBe(true);
    });

    it('should not flag valid text', () => {
      expect(Encoder.isGarbled('Hello World')).toBe(false);
    });

    it('should not flag valid Chinese', () => {
      expect(Encoder.isGarbled('你好世界')).toBe(false);
    });
  });

  describe('decodeBuffer', () => {
    it('should decode valid UTF-8 buffer', () => {
      const buf = Buffer.from('Hello 你好', 'utf8');
      expect(Encoder.decodeBuffer(buf)).toBe('Hello 你好');
    });

    it('should fall back to GBK for non-UTF-8 buffer', () => {
      // GBK 编码的 "你好" = 0xC4E3 0xBAC3
      const buf = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]);
      const result = Encoder.decodeBuffer(buf);
      expect(result).toBe('你好');
    });

    it('should decode GBK error messages', () => {
      // GBK 编码的 "不是内部或外部命令" 的部分字节
      const buf = Buffer.from([0xB2, 0xBB, 0xCA, 0xC7]);
      const result = Encoder.decodeBuffer(buf);
      // 应该能解码，不会返回乱码
      expect(result).not.toContain('�');
    });

    it('should handle mixed content gracefully', () => {
      // 纯 ASCII 内容
      const buf = Buffer.from('Hello World', 'utf8');
      expect(Encoder.decodeBuffer(buf)).toBe('Hello World');
    });

    it('should handle empty buffer', () => {
      const buf = Buffer.alloc(0);
      expect(Encoder.decodeBuffer(buf)).toBe('');
    });

    it('should decode UTF-8 multibyte characters', () => {
      // UTF-8 编码的 "🌍" = 0xF0 0x9F 0x8C 0x8D
      const buf = Buffer.from([0xF0, 0x9F, 0x8C, 0x8D]);
      expect(Encoder.decodeBuffer(buf)).toBe('🌍');
    });
  });
});
