// 单测：colors.ts —— fg/bg ANSI 码生成 + theme token 解析 + truecolor/256/16 三级
//
// 物理本质：fg/bg 是"颜料挤出机"——给它一个 token（或颜色名），
// 按当前终端能力挤出对应的颜料管代码：
//   - truecolor：\x1b[38;2;R;G;Bm（1600 万色）
//   - ansi256：\x1b[38;5;Nm（256 色）
//   - ansi16：\x1b[36m（16 色，最保守）

import { describe, it, expect, beforeEach } from 'vitest';
import { fg, bg, setColorLevel, getColorLevel, RESET, BOLD, DIM } from '../renderer/colors.js';
import { setTheme } from '../renderer/theme.js';

describe('colors', () => {
  beforeEach(() => {
    setTheme('dark');
    setColorLevel('ansi16'); // 测试默认 16 色，向后兼容
  });

  describe('样式码常量', () => {
    it('RESET / BOLD / DIM 返回正确 ANSI 码', () => {
      expect(RESET).toBe('\x1b[0m');
      expect(BOLD).toBe('\x1b[1m');
      expect(DIM).toBe('\x1b[2m');
    });
  });

  describe('ansi16 模式（16 色，向后兼容）', () => {
    it('fg(accent) → \\x1b[36m（cyan）', () => {
      expect(fg('accent')).toBe('\x1b[36m');
    });
    it('fg(brand) → \\x1b[35m（magenta）', () => {
      expect(fg('brand')).toBe('\x1b[35m');
    });
    it('fg(success) → \\x1b[32m（green）', () => {
      expect(fg('success')).toBe('\x1b[32m');
    });
    it('fg(warn) → \\x1b[33m（yellow）', () => {
      expect(fg('warn')).toBe('\x1b[33m');
    });
    it('fg(error) → \\x1b[31m（red）', () => {
      expect(fg('error')).toBe('\x1b[31m');
    });
    it('fg(muted) → \\x1b[90m（gray）', () => {
      expect(fg('muted')).toBe('\x1b[90m');
    });
    it('fg(border) → \\x1b[90m（gray）', () => {
      expect(fg('border')).toBe('\x1b[90m');
    });
    it('fg(text) → 空串（默认前景，无码）', () => {
      expect(fg('text')).toBe('');
    });
    it('直接颜色名 cyan 仍兼容', () => {
      expect(fg('cyan')).toBe('\x1b[36m');
    });
    it('undefined / 未知 → 空串', () => {
      expect(fg(undefined)).toBe('');
      expect(fg('nonexistent')).toBe('');
    });
  });

  describe('truecolor 模式（RGB）', () => {
    beforeEach(() => {
      setColorLevel('truecolor');
    });

    it('fg(brand) → \\x1b[38;2;215;119;87m（claude 橙）', () => {
      expect(fg('brand')).toBe('\x1b[38;2;215;119;87m');
    });

    it('fg(accent) → \\x1b[38;2;177;185;249m（浅蓝紫）', () => {
      expect(fg('accent')).toBe('\x1b[38;2;177;185;249m');
    });

    it('fg(error) → \\x1b[38;2;255;107;128m', () => {
      expect(fg('error')).toBe('\x1b[38;2;255;107;128m');
    });

    it('fg(text) → \\x1b[38;2;230;230;230m（浅灰）', () => {
      expect(fg('text')).toBe('\x1b[38;2;230;230;230m');
    });

    it('直接颜色名 cyan → truecolor 近似 RGB', () => {
      // cyan 的 RGB 近似 [0,255,255]
      expect(fg('cyan')).toBe('\x1b[38;2;0;255;255m');
    });

    it('undefined / 未知 → 空串', () => {
      expect(fg(undefined)).toBe('');
      expect(fg('nonexistent')).toBe('');
    });
  });

  describe('ansi256 模式（256 色）', () => {
    beforeEach(() => {
      setColorLevel('ansi256');
    });

    it('fg(brand) → \\x1b[38;5;N（claude 橙的 256 色近似）', () => {
      const out = fg('brand');
      expect(out).toMatch(/^\x1b\[38;5;\d+m$/);
    });

    it('fg(accent) → \\x1b[38;5;N', () => {
      const out = fg('accent');
      expect(out).toMatch(/^\x1b\[38;5;\d+m$/);
    });

    it('fg(text) → \\x1b[38;5;N（浅灰的 256 色近似）', () => {
      const out = fg('text');
      expect(out).toMatch(/^\x1b\[38;5;\d+m$/);
    });
  });

  describe('setColorLevel / getColorLevel', () => {
    it('默认 ansi16', () => {
      setColorLevel('ansi16');
      expect(getColorLevel()).toBe('ansi16');
    });
    it('可切换 truecolor', () => {
      setColorLevel('truecolor');
      expect(getColorLevel()).toBe('truecolor');
    });
  });

  describe('bg() 背景色', () => {
    it('ansi16: bg(gray) → \\x1b[100m', () => {
      expect(bg('gray')).toBe('\x1b[100m');
    });
    it('truecolor: bg(accent) → \\x1b[48;2;177;185;249m', () => {
      setColorLevel('truecolor');
      expect(bg('accent')).toBe('\x1b[48;2;177;185;249m');
    });
    it('undefined → 空串', () => {
      expect(bg(undefined)).toBe('');
    });
  });
});
