// src/tui/state/presentation-channel.ts
// Pure derived presentation layer over the CURRENT TranscriptBlock union only.
// Classifies a block into a presentation channel, and provides the normal-mode
// visibility predicate. No new block kinds, no production render behavior change.

import type { TranscriptBlock } from '../transcript-types.js';

/** Derived presentation channel for a transcript block. */
export type PresentationChannel = 'conversation' | 'activity' | 'diagnostics';

/**
 * Classify a transcript block into its presentation channel.
 *
 * - conversation: user / assistant text
 * - activity: tools, asks, turn-duration, thinking-summaries, error notifications
 * - diagnostics: non-error (normal/undefined tone) notifications
 *
 * The switch MUST be exhaustive over the CURRENT TranscriptBlock union
 * (`user | assistant | tool | ask | system | turn-duration`). New kinds
 * introduced in later tasks will force TypeScript to extend this switch.
 */
export function presentationChannel(block: TranscriptBlock): PresentationChannel {
  switch (block.kind) {
    case 'user':
    case 'assistant':
      return 'conversation';
    case 'tool':
    case 'ask':
    case 'turn-duration':
      return 'activity';
    case 'system':
      return block.subkind === 'notification' && block.tone !== 'error' ? 'diagnostics' : 'activity';
  }
}

/**
 * Whether a block is visible in normal (non-verbose) presentation mode.
 * Hides only non-error diagnostics; everything else is visible.
 */
export function isVisibleInNormalMode(block: TranscriptBlock): boolean {
  return presentationChannel(block) !== 'diagnostics';
}
