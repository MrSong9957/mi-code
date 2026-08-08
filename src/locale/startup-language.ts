import { DEFAULT_LANGUAGE, isLanguage, type Language } from './types.js';

export function resolveStartupLanguage(
  cliLanguage: Language | undefined,
  configLanguage: unknown,
): Language {
  if (isLanguage(cliLanguage)) return cliLanguage;
  if (isLanguage(configLanguage)) return configLanguage;
  return DEFAULT_LANGUAGE;
}

export type StartupLanguageSelection =
  | { language: Language }
  | { error: string; exitCode: 1 };

export function resolveStartupLanguageSelection(
  cliLanguage: Language | undefined,
  languageError: string | undefined,
  configLanguage: unknown,
): StartupLanguageSelection {
  if (languageError) {
    return { error: languageError, exitCode: 1 };
  }

  return { language: resolveStartupLanguage(cliLanguage, configLanguage) };
}
