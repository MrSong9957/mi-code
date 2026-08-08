import type { StoreApi } from 'zustand/vanilla';
import { zhCN } from './resources/zh-CN.js';

export type Language = 'zh-CN' | 'en-US';

export const DEFAULT_LANGUAGE: Language = 'zh-CN';

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'] as const satisfies readonly Language[];

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.includes(value as Language);
}

export type CanonicalResources = typeof zhCN;

type DotNestedKeys<T> = T extends string
  ? never
  : {
      [K in keyof T & string]:
        T[K] extends string
          ? K
          : `${K}.${DotNestedKeys<T[K]>}`;
    }[keyof T & string];

export type TranslationKey = DotNestedKeys<CanonicalResources>;

export interface Translator {
  t(key: TranslationKey, params?: Record<string, string | number>): string;
}

export interface LanguageState {
  language: Language;
  setLanguage: (language: Language) => void;
}

export type LanguageStore = StoreApi<LanguageState>;
