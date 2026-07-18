import type { SpinnerContextSnapshot, SpinnerState } from './spinner-store.js';

export type SpinnerAuxiliaryKind =
  | 'teammate'
  | 'task'
  | 'tip'
  | 'budget'
  | 'next-task';

export interface SpinnerAuxiliaryLine {
  kind: SpinnerAuxiliaryKind;
  content: string;
}

export interface SpinnerAnimationView {
  time: number;
  mode: SpinnerState['mode'];
  verb: string;
  label: string;
  thinkStartTime: number | null;
  thinkingEffort: string | null;
  thinkingSummaryDurationMs: number | null;
  stalled: boolean;
  stalledIntensity: number;
  reducedMotion: boolean;
  verbose: boolean;
  activeTeammateCount: number;
  displayedTokens: number;
  teammateTokens: number;
}

export interface SpinnerView {
  active: boolean;
  variant: SpinnerContextSnapshot['variant'];
  animation: SpinnerAnimationView | null;
  auxiliaryLines: readonly SpinnerAuxiliaryLine[];
  rowCount: number;
}

export function selectSpinnerTip(
  time: number,
  context: SpinnerContextSnapshot,
): string | null {
  const elapsedSnapshot = Math.floor(Math.max(0, time) / 1000) * 1000;
  if (elapsedSnapshot >= 1_800_000) {
    return 'Use /clear to start fresh when switching topics...';
  }
  if (elapsedSnapshot >= 30_000 && !context.hasUsedBtw) {
    return 'Tip: Use /btw to ask a quick side question...';
  }
  return context.spinnerTip;
}

export function selectSpinnerView(state: SpinnerState): SpinnerView {
  const { context } = state;
  if (!state.active) {
    return {
      active: false,
      variant: context.variant,
      animation: null,
      auxiliaryLines: [],
      rowCount: 0,
    };
  }

  const activeTeammateCount = context.teammates.filter(
    member => member.status === 'working',
  ).length;
  const animation: SpinnerAnimationView = {
    time: state.time,
    mode: state.mode,
    verb: state.verb,
    label: state.label,
    thinkStartTime: state.thinkStartTime,
    thinkingEffort: state.thinkingEffort,
    thinkingSummaryDurationMs: state.thinkingSummary?.durationMs ?? null,
    stalled: state.stalled,
    stalledIntensity: state.stalledIntensity,
    reducedMotion: state.reducedMotion,
    verbose: state.verbose,
    activeTeammateCount,
    displayedTokens: state.displayedTokens,
    teammateTokens: state.teammateTokens,
  };

  if (context.variant === 'brief') {
    return {
      active: true,
      variant: 'brief',
      animation,
      auxiliaryLines: [],
      rowCount: 1,
    };
  }

  const auxiliaryLines: SpinnerAuxiliaryLine[] = [];
  const teammates = context.teammates.filter(member => member.status !== 'shutdown');
  if (teammates.length > 0) {
    teammates.forEach((member, index) => {
      const branch = index === teammates.length - 1 ? '└─' : '├─';
      auxiliaryLines.push({
        kind: 'teammate',
        content: `  ${branch} ${member.name} (${member.role}) · ${member.status}`,
      });
    });
  } else {
    context.tasks
      .filter(task => task.status !== 'completed')
      .forEach(task => {
        const marker = task.status === 'in_progress' ? '[>]' : '[ ]';
        const activeForm = task.status === 'in_progress' && task.activeForm
          ? ` · ${task.activeForm}`
          : '';
        const owner = task.owner ? ` @${task.owner}` : '';
        const blocked = task.blockedBy.length > 0
          ? ` (blocked by: ${task.blockedBy.join(', ')})`
          : '';
        auxiliaryLines.push({
          kind: 'task',
          content: `  ${marker} ${task.content}${activeForm}${owner}${blocked}`,
        });
      });
  }

  const tip = selectSpinnerTip(state.time, context);
  if (tip) auxiliaryLines.push({ kind: 'tip', content: tip });
  if (context.budgetText) {
    auxiliaryLines.push({ kind: 'budget', content: context.budgetText });
  }
  if (context.nextTaskText) {
    auxiliaryLines.push({ kind: 'next-task', content: context.nextTaskText });
  }

  return {
    active: true,
    variant: 'normal',
    animation,
    auxiliaryLines,
    rowCount: 1 + auxiliaryLines.length,
  };
}
