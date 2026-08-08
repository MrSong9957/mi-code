import type { Translator } from '../locale/types.js';

export function getResponseLanguagePreference(translator: Translator): string {
  return translator.t('agent.responseLanguagePreference');
}
