import type { Translator, TranslationKey } from '../locale/types.js';

const REASON_KEYS: Record<string, TranslationKey> = {
  'permission.command_unresolvable_var': 'permission.reasons.commandUnresolvableVar',
};

export function presentPermissionReason(
  translator: Translator,
  reasonCode: string,
  humanReason: string,
): string {
  const key = REASON_KEYS[reasonCode];
  return key ? translator.t(key) : humanReason;
}
