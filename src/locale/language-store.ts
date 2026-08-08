import { createStore } from 'zustand/vanilla';
import type { Language, LanguageStore, LanguageState } from './types.js';

export function createLanguageStore(initialLanguage: Language): LanguageStore {
  return createStore<LanguageState>((set) => ({
    language: initialLanguage,
    setLanguage: (language) => set({ language }),
  }));
}
