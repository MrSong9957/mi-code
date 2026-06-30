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
  });
});
