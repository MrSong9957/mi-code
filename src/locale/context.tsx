import React, { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { createTranslator } from './translator.js';
import type { Language, LanguageStore, Translator } from './types.js';

const LocaleStoreContext = createContext<LanguageStore | null>(null);

export interface LocaleProviderProps {
  store: LanguageStore;
  children?: React.ReactNode;
}

export function LocaleProvider({ store, children }: LocaleProviderProps): React.ReactElement {
  return React.createElement(LocaleStoreContext.Provider, { value: store }, children);
}

export function useLocale(): { language: Language; t: Translator['t'] } {
  const store = useContext(LocaleStoreContext);
  if (!store) {
    throw new Error('useLocale must be used within LocaleProvider');
  }

  const language = useSyncExternalStore(
    store.subscribe,
    () => store.getState().language,
    () => store.getState().language,
  );
  const translator = useMemo(() => createTranslator(store), [store]);

  return { language, t: translator.t };
}
