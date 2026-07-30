import type { FormattedLine } from '../../ui/types.js';
import type { TuiMessage } from '../types.js';
import type { TurnDurationBlock } from '../transcript-types.js';
import { formatSpinnerDuration } from './spinner-store.js';

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

/**
 * 构造一个生命周期安全的 TurnDurationBlock（语义时间线块）。
 *
 * 与 {@link createTurnDurationMessage} 的区别:产物是纯数据块(TurnDurationBlock),
 * 不含渲染行(lines),由 Task 4+ 的语义 store/渲染层消费。
 * verb 选取逻辑与现有消息版本完全一致(同样的确定性测试 seam),不改变可见文案。
 */
export function createTurnDurationBlock({
  uuid, durationMs, prependBlankLine, random = Math.random,
}: CreateTurnDurationMessageInput): TurnDurationBlock {
  const verb = TURN_COMPLETION_VERBS[
    Math.floor(random() * TURN_COMPLETION_VERBS.length)
  ]!;
  return {
    id: uuid,
    kind: 'turn-duration',
    durationMs,
    verb,
    prependBlankLine,
  };
}
