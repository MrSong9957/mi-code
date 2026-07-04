// 单测：theme.ts —— Theme 接口、dark 主题（truecolor + 降级）、REGISTRY
//
// 物理本质：theme 是「色票本」——给每个语义角色（强调、错误、提示等）
// 贴上一组颜色标签（truecolor RGB / 256 色 / 16 色三套备）。
// 换主题就是换一本色票本，所有组件自动跟随变色。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  darkTheme,
  THEME_REGISTRY,
  getTheme,
  setTheme,
  resolveTokenRgb,
  resolveTokenAnsi16,
  type ColorToken,
  type Theme,
} from '../renderer/theme.js';

describe('theme', () => {
  describe('darkTheme 默认主题（Claude Code 风格 truecolor）', () => {
    it('name 为 "dark"', () => {
      expect(darkTheme.name).toBe('dark');
    });

    it('所有 ColorToken 都有定义', () => {
      const required: ColorToken[] = [
        'accent', 'brand', 'success', 'warn', 'error',
        'muted', 'text', 'prompt', 'border',
      ];
      for (const token of required) {
        expect(darkTheme.tokens[token], `token ${token} 未定义`).toBeDefined();
      }
    });

    it('brand = claude 橙 rgb(215,119,87)（assistant ● / banner / 工具名）', () => {
      expect(darkTheme.tokens.brand.rgb).toEqual([215, 119, 87]);
    });

    it('accent = 浅蓝紫 rgb(177,185,249)（边框/状态栏强调）', () => {
      expect(darkTheme.tokens.accent.rgb).toEqual([177, 185, 249]);
    });

    it('success = 亮绿 rgb(78,186,101)', () => {
      expect(darkTheme.tokens.success.rgb).toEqual([78, 186, 101]);
    });

    it('warn = 琥珀 rgb(255,193,7)', () => {
      expect(darkTheme.tokens.warn.rgb).toEqual([255, 193, 7]);
    });

    it('error = 亮红 rgb(255,107,128)', () => {
      expect(darkTheme.tokens.error.rgb).toEqual([255, 107, 128]);
    });

    it('muted = 中灰 rgb(153,153,153)', () => {
      expect(darkTheme.tokens.muted.rgb).toEqual([153, 153, 153]);
    });

    it('text = 浅灰 rgb(230,230,230)（非纯白，降低刺眼感）', () => {
      expect(darkTheme.tokens.text.rgb).toEqual([230, 230, 230]);
    });

    it('prompt = 亮绿 rgb(78,186,101)', () => {
      expect(darkTheme.tokens.prompt.rgb).toEqual([78, 186, 101]);
    });

    it('border = 中灰 rgb(136,136,136)', () => {
      expect(darkTheme.tokens.border.rgb).toEqual([136, 136, 136]);
    });

    it('每个 token 都有 ansi16 降级值', () => {
      const required: ColorToken[] = [
        'accent', 'brand', 'success', 'warn', 'error',
        'muted', 'text', 'prompt', 'border',
      ];
      for (const token of required) {
        const ansi16 = darkTheme.tokens[token].ansi16;
        // text 的 ansi16 为空串（默认前景），其余应为 FG_MAP key
        if (token === 'text') {
          expect(ansi16).toBe('');
        } else {
          expect(ansi16, `token ${token} 缺 ansi16 降级`).toBeTruthy();
        }
      }
    });
  });

  describe('THEME_REGISTRY', () => {
    it('包含 dark 主题', () => {
      expect(THEME_REGISTRY.get('dark')).toBe(darkTheme);
    });
  });

  describe('getTheme / setTheme', () => {
    beforeEach(() => {
      setTheme('dark');
    });

    it('getTheme 默认返回 darkTheme', () => {
      expect(getTheme()).toBe(darkTheme);
    });

    it('setTheme("dark") 返回 true', () => {
      expect(setTheme('dark')).toBe(true);
    });

    it('setTheme(unknown) 返回 false 且不改变当前主题', () => {
      const before = getTheme();
      expect(setTheme('nonexistent-theme')).toBe(false);
      expect(getTheme()).toBe(before);
    });
  });

  describe('resolveTokenRgb / resolveTokenAnsi16', () => {
    beforeEach(() => {
      setTheme('dark');
    });

    it('resolveTokenRgb("brand") → [215,119,87]', () => {
      expect(resolveTokenRgb('brand')).toEqual([215, 119, 87]);
    });

    it('resolveTokenRgb("text") → [230,230,230]', () => {
      expect(resolveTokenRgb('text')).toEqual([230, 230, 230]);
    });

    it('resolveTokenRgb 未知 token → null', () => {
      expect(resolveTokenRgb('nonexistent' as ColorToken)).toBeNull();
    });

    it('resolveTokenAnsi16("brand") → "magenta"', () => {
      expect(resolveTokenAnsi16('brand')).toBe('magenta');
    });

    it('resolveTokenAnsi16("text") → ""（默认前景）', () => {
      expect(resolveTokenAnsi16('text')).toBe('');
    });

    it('resolveTokenAnsi16 未知 token → ""', () => {
      expect(resolveTokenAnsi16('nonexistent' as ColorToken)).toBe('');
    });
  });
});
