import { enUS } from './resources/en-US.js';
import { zhCN } from './resources/zh-CN.js';
import type { CanonicalResources, Language, LanguageStore, TranslationKey, Translator } from './types.js';

function readLeaf(resources: CanonicalResources, key: string): string | undefined {
  let current: unknown = resources;

  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === 'string' ? current : undefined;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    if (!params || !(name in params)) {
      return match;
    }
    return String(params[name]);
  });
}

function resourcesFor(language: Language): CanonicalResources {
  return language === 'en-US' ? enUS : zhCN;
}

export function createTranslator(store: LanguageStore): Translator {
  return {
    t(key: TranslationKey, params?: Record<string, string | number>): string {
      const language = store.getState().language;
      const current = readLeaf(resourcesFor(language), key);
      const fallback = readLeaf(zhCN, key);
      const template = current && current.length > 0 ? current : fallback;

      if (!template) {
        return `?missing translation: ${key}?`;
      }

      return interpolate(template, params);
    },
  };
}
