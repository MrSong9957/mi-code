// 单测：theme.ts —— Theme 类型、dark 主题、REGISTRY、getTheme/setTheme
//
// 物理本质：theme 是「色票本」——给每个语义角色（品牌、文本、错误等）
// 贴上一个 16 色 ANSI 名标签。换主题就是换一本色票本，所有组件自动跟随变色。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  dark,
  THEME_REGISTRY,
  getCurrentTheme,
  getTheme,
  setTheme,
  getActiveThemeName,
  resolveThemeColor,
  type Theme,
} from '../renderer/theme.js';

describe('theme', () => {
  describe('dark 默认主题（保持 cyan 主色，16 色）', () => {
    it('品牌色 brand = ansi:cyan（mi-code 主色，不换橙）', () => {
      expect(dark.brand).toBe('ansi:cyan');
    });

    it('brandDim = ansi:cyanBright（主色亮化）', () => {
      expect(dark.brandDim).toBe('ansi:cyanBright');
    });

    it('brandShimmer = ansi:white（动画用最亮）', () => {
      expect(dark.brandShimmer).toBe('ansi:white');
    });

    it('text = ansi:white', () => {
      expect(dark.text).toBe('ansi:white');
    });

    it('textDim = ansi:blackBright（gray）', () => {
      expect(dark.textDim).toBe('ansi:blackBright');
    });

    it('subtle = ansi:blackBright', () => {
      expect(dark.subtle).toBe('ansi:blackBright');
    });

    it('success = ansi:green', () => {
      expect(dark.success).toBe('ansi:green');
    });

    it('error = ansi:red', () => {
      expect(dark.error).toBe('ansi:red');
    });

    it('warning = ansi:yellow', () => {
      expect(dark.warning).toBe('ansi:yellow');
    });

    it('info = ansi:blue', () => {
      expect(dark.info).toBe('ansi:blue');
    });

    it('border = ansi:cyan', () => {
      expect(dark.border).toBe('ansi:cyan');
    });

    it('borderFocused = ansi:white', () => {
      expect(dark.borderFocused).toBe('ansi:white');
    });

    it('background 默认透明（undefined）', () => {
      expect(dark.background).toBeUndefined();
    });

    it('代码高亮 token 齐全', () => {
      expect(dark.codeKeyword).toBe('ansi:magenta');
      expect(dark.codeString).toBe('ansi:green');
      expect(dark.codeComment).toBe('ansi:blackBright');
      expect(dark.codeFunction).toBe('ansi:yellow');
      expect(dark.codeNumber).toBe('ansi:cyan');
      expect(dark.codeOperator).toBe('ansi:white');
    });
  });

  describe('THEME_REGISTRY', () => {
    it('包含 dark 主题', () => {
      expect(THEME_REGISTRY.dark).toBe(dark);
    });
  });

  describe('getCurrentTheme / getTheme / setTheme', () => {
    beforeEach(() => {
      setTheme('dark');
    });

    it('getCurrentTheme 默认返回 dark', () => {
      expect(getCurrentTheme()).toBe(dark);
    });

    it('getTheme("dark") 返回 dark 主题', () => {
      expect(getTheme('dark')).toBe(dark);
    });

    it('getTheme(unknown) 回退 dark', () => {
      expect(getTheme('nonexistent')).toBe(dark);
    });

    it('setTheme("dark") 返回 true', () => {
      expect(setTheme('dark')).toBe(true);
    });

    it('setTheme(unknown) 返回 false 且不改当前主题', () => {
      const before = getCurrentTheme();
      expect(setTheme('nonexistent')).toBe(false);
      expect(getCurrentTheme()).toBe(before);
    });

    it('getActiveThemeName 返回当前主题名', () => {
      expect(getActiveThemeName()).toBe('dark');
    });
  });

  describe('resolveThemeColor', () => {
    beforeEach(() => {
      setTheme('dark');
    });

    it('semantic token → 主题值（brand → ansi:cyan）', () => {
      expect(resolveThemeColor('brand')).toBe('ansi:cyan');
    });

    it('semantic token error → ansi:red', () => {
      expect(resolveThemeColor('error')).toBe('ansi:red');
    });

    it('直接 ansi:xxx 名原样返回', () => {
      expect(resolveThemeColor('ansi:magenta')).toBe('ansi:magenta');
    });

    it('text → ansi:white（主题值）', () => {
      expect(resolveThemeColor('text')).toBe('ansi:white');
    });

    it('未知 token → 空串', () => {
      expect(resolveThemeColor('nonexistent')).toBe('');
    });

    it('undefined → 空串', () => {
      expect(resolveThemeColor(undefined)).toBe('');
    });

    it('codeKeyword → ansi:magenta', () => {
      expect(resolveThemeColor('codeKeyword')).toBe('ansi:magenta');
    });
  });
});
