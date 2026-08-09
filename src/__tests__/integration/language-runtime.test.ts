// 集成测试:跨层组合 ConfigStore + (外部创建的) LanguageStore + Translator + 命令路径
// + LocaleProvider + response-language-preference 提示辅助。
//
// 只验证跨层 WIRING/ORDERING。不重复验证 translator 的插值/回退/缺失键/资源 canonical
// 形状(那些在 src/__tests__/locale/ 中)。
//
// 三条用例对应 plan Task 12:
//   A. /language 成功 → React 输出、translator、下一轮 prompt、config 持久化 全部更新
//   B. /language 持久化失败 → React、runtime 语言、下一轮 prompt 全部保持旧语言
//   C. 切换 store 后,进行中的 prompt 快照仍是旧语言,下一次 prompt 调用使用新资源
import React from 'react';
import { Text } from 'ink';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { ConfigStore } from '../../config/store.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import { LocaleProvider, useLocale } from '../../locale/context.js';
import { executeCommand } from '../../commands/executor.js';
import type { CommandContext, CommandResult } from '../../commands/executor.js';
import type { Command } from '../../commands/parser.js';
import { getResponseLanguagePreference } from '../../prompts/response-language-preference.js';

function languageCommand(args: string[]): Command {
  return { name: 'language', args };
}

/**
 * 子组件:通过 LocaleProvider 订阅 store,渲染本地化的"回复语言偏好"字符串。
 * 用来证明 LanguageStore → React 的接线在跨层组合下生效。
 */
function ResponseLanguagePreferenceLabel(): React.ReactElement {
  const { t } = useLocale();
  return React.createElement(Text, null, t('agent.responseLanguagePreference'));
}

describe('i18n runtime integration (cross-layer wiring)', () => {
  let tempDir: string;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    // 显式 temp 目录隔离真实 ConfigStore 的磁盘写盘(模式参考 src/__tests__/config.test.ts)。
    // Windows 上 os.homedir() 对运行时改 USERPROFILE 不可靠,显式传 tempDir 给构造函数才是真相源;
    // 此处同时设置 USERPROFILE 只是双保险,清理在 afterEach。
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-lang-runtime-'));
    originalUserprofile = process.env.USERPROFILE;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    if (originalUserprofile) {
      process.env.USERPROFILE = originalUserprofile;
    } else {
      delete process.env.USERPROFILE;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test A: /language 成功 → React、translator、下一轮 prompt、config 持久化 全部更新
  //
  // 组合真实(隔离 temp)ConfigStore + 全新 LanguageStore('zh-CN') + translator。
  // 渲染 <LocaleProvider> 子组件,执行 /language en-US,验证四层同时更新。
  // ──────────────────────────────────────────────────────────────────────────
  it('/language persistence success updates React output, translator feedback, next prompt, and config', () => {
    const configStore = new ConfigStore(tempDir);
    const languageStore = createLanguageStore('zh-CN');
    const translator = createTranslator(languageStore);
    const ctx: CommandContext = { languageStore, translator };

    const { lastFrame } = render(
      React.createElement(
        LocaleProvider,
        { store: languageStore },
        React.createElement(ResponseLanguagePreferenceLabel),
      ),
    );

    // 前置:zh 框架(LanguageStore 初始 'zh-CN' 反映到 React)
    expect(lastFrame()).toContain('请始终用中文回复。');

    // 走真实命令路径:config.setLanguage('en-US') 成功后才 languageStore.setLanguage('en-US')
    let result: CommandResult = { message: '' };
    act(() => {
      result = executeCommand(languageCommand(['en-US']), configStore, ctx);
    });

    // (1) React 框架已更新为英文 —— 证明 LanguageStore → React 接线
    expect(lastFrame()).toContain('Always respond in English.');
    // (2) 命令结果消息为英文 —— 证明 translator 在 setLanguage 后反映新语言的成功反馈
    expect(result.message).toBe('Language switched to en-US.');
    // (3) 下一轮 prompt 调用使用新 locale —— 证明 getResponseLanguagePreference 反映新语言
    expect(getResponseLanguagePreference(translator)).toBe('Always respond in English.');
    // (4) 持久化已发生 —— 证明跨层到 ConfigStore 磁盘
    expect(configStore.getLanguage()).toBe('en-US');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test B: 持久化失败 → React、runtime 语言、下一轮 prompt 全部保持旧语言
  //
  // 仅 mock ConfigStore.setLanguage 使其抛错;其余真实。
  // 排序不变性:handleLanguage 中 config.setLanguage 在 languageStore.setLanguage 之前,
  // 因此抛错时 translator 用旧语言生成 persistError,且 languageStore 完全不被 mutate。
  // ──────────────────────────────────────────────────────────────────────────
  it.each([
    ['中文', 'zh-CN'],
    ['英文', 'en-US'],
    ['zh-CN', 'zh-CN'],
    ['en-US', 'en-US'],
  ] as const)('/language %s persists and applies canonical %s', (input, language) => {
    const configStore = new ConfigStore(tempDir);
    const languageStore = createLanguageStore('zh-CN');
    const translator = createTranslator(languageStore);
    const ctx: CommandContext = { languageStore, translator };

    executeCommand(languageCommand([input]), configStore, ctx);

    expect(configStore.getLanguage()).toBe(language);
    expect(languageStore.getState().language).toBe(language);
  });

  it('/language persistence failure leaves React, runtime language, and next prompt unchanged (zh)', () => {
    const languageStore = createLanguageStore('zh-CN');
    const translator = createTranslator(languageStore);
    const ctx: CommandContext = { languageStore, translator };

    // 仅 mock 一个会抛错的 setLanguage(其余字段不影响 /language 路径,故无需完整 ConfigStore)
    const setLanguageSpy = vi.fn(() => {
      throw new Error('disk full');
    });
    const configStore = { setLanguage: setLanguageSpy } as unknown as ConfigStore;

    const { lastFrame } = render(
      React.createElement(
        LocaleProvider,
        { store: languageStore },
        React.createElement(ResponseLanguagePreferenceLabel),
      ),
    );
    expect(lastFrame()).toContain('请始终用中文回复。');

    let result: CommandResult = { message: '' };
    act(() => {
      result = executeCommand(languageCommand(['en-US']), configStore, ctx);
    });

    // (1) 命令返回错误消息,且用的是 OLD 语言 zh
    //    (plan: "Save/validation failure returns a message generated before the store update")
    //    注意:资源里是全角冒号'：',这是本地化文案的一部分。
    expect(result.message).toBe('保存语言 en-US 失败：disk full');
    // (2) React 框架仍是中文 —— LanguageStore 未被 mutate
    expect(lastFrame()).toContain('请始终用中文回复。');
    expect(lastFrame()).not.toContain('Always respond in English.');
    // (3) getResponseLanguagePreference 仍是中文偏好 —— translator 未变
    expect(getResponseLanguagePreference(translator)).toBe('请始终用中文回复。');
    // (4) languageStore.getState().language 仍是 'zh-CN'
    expect(languageStore.getState().language).toBe('zh-CN');
    // 排序证据:config.setLanguage 被调一次,但 LanguageStore 的 setLanguage 因早退从未触达
    expect(setLanguageSpy).toHaveBeenCalledOnce();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test C: 进行中的 prompt 快照在 store 切换后仍是旧语言;下一次 prompt 调用使用新资源
  //
  // 用真实 helper + 真实 store + 真实 translator 组合(Task 8 单元测试的集成镜像)。
  // 快照字符串是不可变的 —— 进行中的 prompt 不会被追溯改写。
  // ──────────────────────────────────────────────────────────────────────────
  it('in-flight prompt snapshot stays old-language after a store switch; the next prompt uses new resource', () => {
    const languageStore = createLanguageStore('zh-CN');
    const translator = createTranslator(languageStore);

    // 切换前快照进行中的 prompt(immutable string)
    const firstPrompt = getResponseLanguagePreference(translator);
    expect(firstPrompt).toBe('请始终用中文回复。');

    languageStore.getState().setLanguage('en-US');

    // 进行中的 prompt 快照保持不变 —— 证明它没有被追溯重新本地化
    expect(firstPrompt).toBe('请始终用中文回复。');

    // 下一次 prompt 调用使用新 resource
    const secondPrompt = getResponseLanguagePreference(translator);
    expect(secondPrompt).toBe('Always respond in English.');
  });
});
