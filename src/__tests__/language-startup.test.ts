import { describe, expect, it } from 'vitest';
import {
  resolveStartupLanguage,
  resolveStartupLanguageSelection,
} from '../locale/startup-language.js';

describe('resolveStartupLanguage', () => {
  it('prefers a valid CLI language over config', () => {
    expect(resolveStartupLanguage('en-US', 'zh-CN')).toBe('en-US');
  });

  it('falls back to config when CLI language is absent', () => {
    expect(resolveStartupLanguage(undefined, 'en-US')).toBe('en-US');
  });

  it('falls back to default when config language is invalid', () => {
    expect(resolveStartupLanguage(undefined, 'fr-FR')).toBe('zh-CN');
  });

  it('keeps a valid CLI language when config language is invalid', () => {
    expect(resolveStartupLanguage('zh-CN', 'fr-FR')).toBe('zh-CN');
  });
});

describe('resolveStartupLanguageSelection', () => {
  it('returns a nonzero startup error instead of falling back when CLI language is invalid', () => {
    expect(resolveStartupLanguageSelection(
      undefined,
      'Unsupported language: fr-FR. Supported values: zh-CN, en-US.',
      'en-US',
    )).toEqual({
      error: 'Unsupported language: fr-FR. Supported values: zh-CN, en-US.',
      exitCode: 1,
    });
  });
});
