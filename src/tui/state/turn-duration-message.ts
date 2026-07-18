import type { FormattedLine } from '../../ui/types.js';
import type { TuiMessage } from '../types.js';

export function formatSpinnerDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export const TURN_COMPLETION_VERBS = [
  'Baked', 'Brewed', 'Churned', 'Cogitated',
  'Cooked', 'Crunched', 'Sautéed', 'Worked',
] as const;

export type TurnCompletionVerb = typeof TURN_COMPLETION_VERBS[number];

export interface SystemTurnDurationMessage extends TuiMessage {
  kind: 'turn-duration';
  verb: TurnCompletionVerb;
  durationMs: number;
}

export interface CreateTurnDurationMessageInput {
  uuid: string;
  durationMs: number;
  prependBlankLine: boolean;
  random?: () => number;
}

export function TurnDurationMessage(
  verb: TurnCompletionVerb,
  durationMs: number,
): FormattedLine {
  return {
    content: `✻ ${verb} for ${formatSpinnerDuration(durationMs)}`,
    style: { dim: true },
    indent: 0,
  };
}

export function createTurnDurationMessage({
  uuid, durationMs, prependBlankLine, random = Math.random,
}: CreateTurnDurationMessageInput): SystemTurnDurationMessage {
  const verb = TURN_COMPLETION_VERBS[
    Math.floor(random() * TURN_COMPLETION_VERBS.length)
  ]!;
  return {
    uuid,
    role: 'system',
    kind: 'turn-duration',
    verb,
    durationMs,
    finalized: true,
    lines: [
      ...(prependBlankLine ? [{ content: '', style: {}, indent: 0 }] : []),
      TurnDurationMessage(verb, durationMs),
    ],
  };
}
