import { describe, expect, it } from 'vitest';
import { systemPrompt as systemPromptTemplate } from '../../prompts/index.js';
import { createLanguageStore, createTranslator } from '../../locale/index.js';
import { enUS } from '../../locale/resources/en-US.js';
import { zhCN } from '../../locale/resources/zh-CN.js';
import { getResponseLanguagePreference } from '../../prompts/response-language-preference.js';

describe('getResponseLanguagePreference', () => {
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
