// 单测：colors.ts —— fg/bg ANSI 码生成 + theme token 解析
//
// 物理本质：fg/bg 是"颜料挤出机"——给它一个颜色名或语义 token，
// 它挤出对应的 ANSI 颜料管代码（如 \x1b[36m）。
// theme 化后，'accent' / 'cyan' 两种入参都能挤出同一管颜料。

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

  describe('fg() 直接颜色名（兼容旧接口）', () => {
    it('cyan → \\x1b[36m', () => {
      expect(fg('cyan')).toBe('\x1b[36m');
    });
    it('green → \\x1b[32m', () => {
      expect(fg('green')).toBe('\x1b[32m');
    });
    it('red → \\x1b[31m', () => {
      expect(fg('red')).toBe('\x1b[31m');
    });
    it('magenta → \\x1b[35m', () => {
      expect(fg('magenta')).toBe('\x1b[35m');
    });
    it('gray → \\x1b[90m', () => {
      expect(fg('gray')).toBe('\x1b[90m');
    });
    it('yellow → \\x1b[33m', () => {
      expect(fg('yellow')).toBe('\x1b[33m');
    });
    it('undefined / 未知颜色 → 空串', () => {
      expect(fg(undefined)).toBe('');
      expect(fg('nonexistent')).toBe('');
    });
  });

  describe('fg() theme token 解析', () => {
    it('accent → 等价于 cyan（\\x1b[36m）', () => {
      expect(fg('accent')).toBe('\x1b[36m');
    });
    it('brand → 等价于 magenta（\\x1b[35m）', () => {
      expect(fg('brand')).toBe('\x1b[35m');
    });
    it('success → 等价于 green（\\x1b[32m）', () => {
      expect(fg('success')).toBe('\x1b[32m');
    });
    it('warn → 等价于 yellow（\\x1b[33m）', () => {
      expect(fg('warn')).toBe('\x1b[33m');
    });
    it('error → 等价于 red（\\x1b[31m）', () => {
      expect(fg('error')).toBe('\x1b[31m');
    });
    it('muted → 等价于 gray（\\x1b[90m）', () => {
      expect(fg('muted')).toBe('\x1b[90m');
    });
    it('prompt → 等价于 green（\\x1b[32m）', () => {
      expect(fg('prompt')).toBe('\x1b[32m');
    });
    it('border → 等价于 gray（\\x1b[90m）', () => {
      expect(fg('border')).toBe('\x1b[90m');
    });
    it('text → 空串（无 fg 码）', () => {
      expect(fg('text')).toBe('');
    });
  });

  describe('fg() 优先级：FG_MAP 直接命中 > theme token', () => {
    // 'cyan' 既是 FG_MAP key 又不是 theme token，应直接走 FG_MAP。
    // 如果未来有 token 叫 'cyan'（不会发生，但理论上），FG_MAP 优先保证向后兼容。
    it('直接颜色名 cyan 不被误判为 token', () => {
      expect(fg('cyan')).toBe('\x1b[36m');
    });
  });

  describe('bg() 背景色', () => {
    it('bg gray → \\x1b[100m', () => {
      expect(bg('gray')).toBe('\x1b[100m');
    });
    it('bg undefined → 空串', () => {
      expect(bg(undefined)).toBe('');
    });
    it('bg 也支持 theme token（accent → cyan 背景 \\x1b[46m）', () => {
      expect(bg('accent')).toBe('\x1b[46m');
    });
  });

  describe('fgAnsi / bgAnsi（原始码，供 setCell 手动构建）', () => {
    it('fgAnsi cyan → "36"', () => {
      expect(fgAnsi('cyan')).toBe('36');
    });
    it('fgAnsi accent → "36"（token 解析）', () => {
      expect(fgAnsi('accent')).toBe('36');
    });
    it('bgAnsi gray → "100"', () => {
      expect(bgAnsi('gray')).toBe('100');
    });
    it('fgAnsi undefined → 空串', () => {
      expect(fgAnsi(undefined)).toBe('');
    });
  });
});
