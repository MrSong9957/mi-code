// 单测：theme.ts —— Theme 接口、dark 主题、REGISTRY、getTheme/setTheme
//
// 物理本质：theme 是「色票本」——给每个语义角色（强调、错误、提示等）
// 贴上一个颜色名标签。换主题就是换一本色票本，所有组件自动跟随变色。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  darkTheme,
  THEME_REGISTRY,
  getTheme,
  setTheme,
  type ColorToken,
  type Theme,
} from '../renderer/theme.js';

describe('theme', () => {
  describe('darkTheme 默认主题', () => {
    it('name 为 "dark"', () => {
      expect(darkTheme.name).toBe('dark');
    });

    it('所有 ColorToken 都有映射值', () => {
      const required: ColorToken[] = [
        'accent', 'brand', 'success', 'warn', 'error',
        'muted', 'text', 'prompt', 'border',
      ];
      for (const token of required) {
        expect(darkTheme.tokens[token]).toBeDefined();
      }
    });

    it('accent 映射到 cyan（视觉不变约束）', () => {
      expect(darkTheme.tokens.accent).toBe('cyan');
    });

    it('brand 映射到 magenta（assistant ● / banner）', () => {
      expect(darkTheme.tokens.brand).toBe('magenta');
    });

    it('success 映射到 green（提示符 / 工具完成 / 字符串）', () => {
      expect(darkTheme.tokens.success).toBe('green');
    });

    it('warn 映射到 yellow（标题 / 数字 / 工具运行中）', () => {
      expect(darkTheme.tokens.warn).toBe('yellow');
    });

    it('error 映射到 red', () => {
      expect(darkTheme.tokens.error).toBe('red');
    });

    it('muted 映射到 gray', () => {
      expect(darkTheme.tokens.muted).toBe('gray');
    });

    it('text 为空串（默认前景，无 fg 码）', () => {
      expect(darkTheme.tokens.text).toBe('');
    });

    it('prompt 映射到 green', () => {
      expect(darkTheme.tokens.prompt).toBe('green');
    });

    it('border 映射到 gray', () => {
      expect(darkTheme.tokens.border).toBe('gray');
    });
  });

  describe('THEME_REGISTRY', () => {
    it('包含 dark 主题', () => {
      expect(THEME_REGISTRY.get('dark')).toBe(darkTheme);
    });
  });

  describe('getTheme / setTheme', () => {
    beforeEach(() => {
      // 每个 test 前重置回 dark，避免 test 间状态泄漏
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

    it('setTheme 成功后 getTheme 返回新主题', () => {
      const custom: Theme = {
        name: 'test-light',
        tokens: { ...darkTheme.tokens, accent: 'white' },
      };
      THEME_REGISTRY.set('test-light', custom);
      expect(setTheme('test-light')).toBe(true);
      expect(getTheme()).toBe(custom);
      // 清理
      THEME_REGISTRY.delete('test-light');
    });
  });

  describe('resolveToken（token → 颜色名）', () => {
    it('resolveToken("accent") 返回当前主题的 cyan', async () => {
      const { resolveToken } = await import('../renderer/theme.js');
      setTheme('dark');
      expect(resolveToken('accent')).toBe('cyan');
    });

    it('resolveToken 未知 token 返回空串', async () => {
      const { resolveToken } = await import('../renderer/theme.js');
      expect(resolveToken('nonexistent' as ColorToken)).toBe('');
    });
  });
});
