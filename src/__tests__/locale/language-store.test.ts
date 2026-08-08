import { describe, expect, it } from 'vitest';
import { createLanguageStore } from '../../locale/language-store.js';

describe('createLanguageStore', () => {
  it('starts with zh-CN and updates to en-US', () => {
    const store = createLanguageStore('zh-CN');

    expect(store.getState().language).toBe('zh-CN');

    store.getState().setLanguage('en-US');

    expect(store.getState().language).toBe('en-US');
  });
});
