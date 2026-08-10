import { describe, expect, it } from 'vitest';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import type { TranslationKey } from '../../locale/types.js';
import { zhCN } from '../../locale/resources/zh-CN.js';
import { enUS } from '../../locale/resources/en-US.js';

function createMissingKey(): TranslationKey {
  return 'agent.missingTranslation' as unknown as TranslationKey;
}

describe('createTranslator', () => {
  it('reads the current language from the store on each call', () => {
    const store = createLanguageStore('zh-CN');
    const translator = createTranslator(store);

    expect(translator.t('agent.responseLanguagePreference')).toBe(zhCN.agent.responseLanguagePreference);

    store.getState().setLanguage('en-US');

    expect(translator.t('agent.responseLanguagePreference')).toBe(enUS.agent.responseLanguagePreference);
  });

  it('replaces known template parameters', () => {
    const store = createLanguageStore('en-US');
    const translator = createTranslator(store);

    expect(translator.t('confirmation.greetByName', { name: 'Ada' })).toBe('Hello, Ada!');
  });

  it('keeps missing template parameters in place', () => {
    const store = createLanguageStore('zh-CN');
    const translator = createTranslator(store);

    expect(translator.t('confirmation.greetByName')).toBe('你好，{name}！');
  });

  it('falls back to zh-CN when the current language text is missing', () => {
    const store = createLanguageStore('en-US');
    const translator = createTranslator(store);

    expect(translator.t('status.fallbackDemo')).toBe('使用中文回退');
  });

  it('returns the missing-translation marker when a key is missing everywhere', () => {
    const store = createLanguageStore('zh-CN');
    const translator = createTranslator(store);

    expect(translator.t(createMissingKey())).toBe('?missing translation: agent.missingTranslation?');
  });

  it('never throws for omitted params or unknown keys', () => {
    const store = createLanguageStore('zh-CN');
    const translator = createTranslator(store);

    expect(() => translator.t('confirmation.greetByName')).not.toThrow();
    expect(() => translator.t(createMissingKey())).not.toThrow();
  });
});
