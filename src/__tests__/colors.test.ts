// 单测：colors.ts —— fg/bg ANSI 码生成 + theme token 解析（16 色单级）
//
// 物理本质：fg/bg 是"颜料挤出机"——给它一个 token（或颜色名），
// 挤出对应的 16 色 ANSI 颜料管代码（如 \x1b[36m）。

import { describe, it, expect, beforeEach } from 'vitest';
import { fg, bg, fgAnsi, bgAnsi, RESET, BOLD, DIM } from '../renderer/colors.js';
import { setTheme } from '../renderer/theme.js';

describe('colors', () => {
  beforeEach(() => {
    setTheme('dark');
  });

  describe('样式码常量', () => {
    it('RESET / BOLD / DIM 返回正确 ANSI 码', () => {
      expect(RESET).toBe('\x1b[0m');
      expect(BOLD).toBe('\x1b[1m');
      expect(DIM).toBe('\x1b[2m');
    });
  });

  describe('fg() semantic token（主题解析）', () => {
    it('brand → \\x1b[36m（cyan，mi-code 主色）', () => {
      expect(fg('brand')).toBe('\x1b[36m');
    });
    it('brandDim → \\x1b[96m（cyanBright）', () => {
      expect(fg('brandDim')).toBe('\x1b[96m');
    });
    it('brandShimmer → \\x1b[37m（white，文档定义）', () => {
      expect(fg('brandShimmer')).toBe('\x1b[37m');
    });
    it('text → \\x1b[37m（white）', () => {
      expect(fg('text')).toBe('\x1b[37m');
    });
    it('textDim → \\x1b[90m（blackBright/gray）', () => {
      expect(fg('textDim')).toBe('\x1b[90m');
    });
    it('success → \\x1b[32m（green）', () => {
      expect(fg('success')).toBe('\x1b[32m');
    });
    it('error → \\x1b[31m（red）', () => {
      expect(fg('error')).toBe('\x1b[31m');
    });
    it('warning → \\x1b[33m（yellow）', () => {
      expect(fg('warning')).toBe('\x1b[33m');
    });
    it('info → \\x1b[34m（blue）', () => {
      expect(fg('info')).toBe('\x1b[34m');
    });
    it('border → \\x1b[36m（cyan）', () => {
      expect(fg('border')).toBe('\x1b[36m');
    });
    it('subtle → \\x1b[90m（gray）', () => {
      expect(fg('subtle')).toBe('\x1b[90m');
    });
    it('codeKeyword → \\x1b[35m（magenta）', () => {
      expect(fg('codeKeyword')).toBe('\x1b[35m');
    });
    it('codeNumber → \\x1b[36m（cyan）', () => {
      expect(fg('codeNumber')).toBe('\x1b[36m');
    });
  });

  describe('fg() 兼容旧接口（直接颜色名 + ansi:xxx）', () => {
    it('直接颜色名 cyan → \\x1b[36m', () => {
      expect(fg('cyan')).toBe('\x1b[36m');
    });
    it('直接颜色名 gray → \\x1b[90m', () => {
      expect(fg('gray')).toBe('\x1b[90m');
    });
    it('ansi:cyan 剥前缀 → \\x1b[36m', () => {
      expect(fg('ansi:cyan')).toBe('\x1b[36m');
    });
    it('ansi:blackBright → \\x1b[90m', () => {
      expect(fg('ansi:blackBright')).toBe('\x1b[90m');
    });
    it('undefined / 未知 → 空串', () => {
      expect(fg(undefined)).toBe('');
      expect(fg('nonexistent')).toBe('');
    });
  });

  describe('bg() 背景色', () => {
    it('bg(gray) → \\x1b[100m', () => {
      expect(bg('gray')).toBe('\x1b[100m');
    });
    it('bg(border) → \\x1b[46m（cyan 背景）', () => {
      expect(bg('border')).toBe('\x1b[46m');
    });
    it('bg undefined → 空串', () => {
      expect(bg(undefined)).toBe('');
    });
  });

  describe('fgAnsi / bgAnsi（原始码）', () => {
    it('fgAnsi(brand) → "36"', () => {
      expect(fgAnsi('brand')).toBe('36');
    });
    it('fgAnsi(cyan) → "36"（兼容）', () => {
      expect(fgAnsi('cyan')).toBe('36');
    });
    it('bgAnsi(gray) → "100"', () => {
      expect(bgAnsi('gray')).toBe('100');
    });
    it('fgAnsi(undefined) → 空串', () => {
      expect(fgAnsi(undefined)).toBe('');
    });
  });
});
