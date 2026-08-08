/**
 * 运行时主题切换回归测试
 *
 * 验证 /theme 命令能正确切换主题，且非法参数不破坏状态。
 */
import { describe, it, expect } from 'vitest';
import { createThemeStore } from '../tui/state/theme-store.js';
import { executeCommand } from '../commands/executor.js';
import type { Command } from '../commands/parser.js';
import type { ConfigStore } from '../config/store.js';
import { createLanguageStore } from '../locale/language-store.js';
import { createTranslator } from '../locale/translator.js';

describe('运行时主题切换', () => {
  it('/theme light 切换 store 为 light', () => {
    const store = createThemeStore('dark');
    const cmd: Command = { name: 'theme', args: ['light'] };
    const result = executeCommand(cmd, { themeStore: store });
    expect(store.getState().themeName).toBe('light');
    expect(result.message).toContain('light');
  });

  it('/theme still uses the supplied themeStore when language runtime fields are present', () => {
    const themeStore = createThemeStore('dark');
    const languageStore = createLanguageStore('zh-CN');
    const cmd: Command = { name: 'theme', args: ['light'] };

    const result = executeCommand(cmd, {
      themeStore,
      languageStore,
      translator: createTranslator(languageStore),
    });

    expect(themeStore.getState().themeName).toBe('light');
    expect(languageStore.getState().language).toBe('zh-CN');
    expect(result.message).toContain('light');
  });

  it('/theme still uses the third-argument command context used by index dispatch', () => {
    const themeStore = createThemeStore('dark');
    const languageStore = createLanguageStore('zh-CN');
    const cmd: Command = { name: 'theme', args: ['light'] };

    const result = executeCommand(cmd, {} as ConfigStore, {
      themeStore,
      languageStore,
      translator: createTranslator(languageStore),
    });

    expect(themeStore.getState().themeName).toBe('light');
    expect(languageStore.getState().language).toBe('zh-CN');
    expect(result.message).toContain('light');
  });

  it('/theme dark 切换回 dark', () => {
    const store = createThemeStore('light');
    const cmd: Command = { name: 'theme', args: ['dark'] };
    const result = executeCommand(cmd, { themeStore: store });
    expect(store.getState().themeName).toBe('dark');
    expect(result.message).toContain('dark');
  });

  it('/theme dark → light → dark 连续切换', () => {
    const store = createThemeStore('dark');
    executeCommand({ name: 'theme', args: ['light'] }, { themeStore: store });
    expect(store.getState().themeName).toBe('light');
    executeCommand({ name: 'theme', args: ['dark'] }, { themeStore: store });
    expect(store.getState().themeName).toBe('dark');
  });

  it('/theme invalid 报错且不改变状态', () => {
    const store = createThemeStore('dark');
    const cmd: Command = { name: 'theme', args: ['invalid'] };
    const result = executeCommand(cmd, { themeStore: store });
    expect(result.message).toContain('Usage');
    expect(store.getState().themeName).toBe('dark');
  });

  it('/theme 无参数 报错', () => {
    const store = createThemeStore('dark');
    const cmd: Command = { name: 'theme', args: [] };
    const result = executeCommand(cmd, { themeStore: store });
    expect(result.message).toContain('Usage');
    expect(store.getState().themeName).toBe('dark');
  });

  it('无 themeStore 时不崩溃', () => {
    const cmd: Command = { name: 'theme', args: ['light'] };
    // ctx 里没有 themeStore，走 config 路径，返回 Unknown command（不崩溃）
    const result = executeCommand(cmd, {});
    expect(result.message).toContain('Unknown command');
  });

  it('theme 在 COMMAND_NAMES 中', async () => {
    const { COMMAND_NAMES } = await import('../commands/executor.js');
    expect(COMMAND_NAMES).toContain('theme');
  });
});
