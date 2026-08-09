import { describe, expect, it } from 'vitest';
import { systemPrompt as systemPromptTemplate } from '../../prompts/index.js';
import { createLanguageStore, createTranslator } from '../../locale/index.js';
import { enUS } from '../../locale/resources/en-US.js';
import { zhCN } from '../../locale/resources/zh-CN.js';
import { getResponseLanguagePreference } from '../../prompts/response-language-preference.js';

describe('getResponseLanguagePreference', () => {
  it.each([
    [
      'zh-CN',
      '默认使用中文回复自然语言内容；用户明确要求其他回复语言时，以用户要求为准；项目规则另有要求时，以项目规则为准。',
    ],
    [
      'en-US',
      'Use English by default for natural-language responses. If the user explicitly requests another response language, follow that request. If project rules require another response language, follow those rules.',
    ],
  ] as const)(
    'provides a default response-language preference for %s',
    (language, expectedPreference) => {
      const translator = createTranslator(createLanguageStore(language));

      expect(getResponseLanguagePreference(translator)).toBe(expectedPreference);
    },
  );

  it('uses one shared translator and store across runtime language switches', () => {
    const languageStore = createLanguageStore('zh-CN');
    const translator = createTranslator(languageStore);

    expect(getResponseLanguagePreference(translator)).toBe(
      zhCN.agent.responseLanguagePreference,
    );

    languageStore.getState().setLanguage('en-US');

    expect(getResponseLanguagePreference(translator)).toBe(
      enUS.agent.responseLanguagePreference,
    );
  });

  it('keeps the first prompt snapshot old while the next prompt uses the new language', () => {
    const languageStore = createLanguageStore('zh-CN');
    const translator = createTranslator(languageStore);
    const buildSystemPrompt = () =>
      [systemPromptTemplate, getResponseLanguagePreference(translator)].join('\n');

    const firstPrompt = buildSystemPrompt();

    languageStore.getState().setLanguage('en-US');

    const secondPrompt = buildSystemPrompt();

    expect(firstPrompt).toContain(zhCN.agent.responseLanguagePreference);
    expect(firstPrompt).not.toContain(enUS.agent.responseLanguagePreference);
    expect(secondPrompt).toContain(enUS.agent.responseLanguagePreference);
    expect(secondPrompt).not.toContain(zhCN.agent.responseLanguagePreference);
  });
});
