import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import {
  TICK_MS,
  formatSpinnerDuration,
  shouldShowSpinnerTimer,
  thinkingStatusText,
  thoughtStatusText,
  totalSpinnerTokens,
} from '../state/spinner-store.js';
import type {
  SpinnerAnimationView,
  SpinnerAuxiliaryLine,
  SpinnerView,
} from '../state/spinner-view.js';
import { selectSpinnerView } from '../state/spinner-view.js';
import { useTheme } from '../state/theme-context.js';
import {
  computeGlimmerIndex,
  measureShimmerMessage,
  toolUseFlashOpacity,
} from '../inline/shimmer.js';
import { GlimmerMessage } from './GlimmerMessage.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
import { DotsCycle } from './DotsCycle.js';
import { SpinnerGlyph } from './SpinnerGlyph.js';
import type { SpinnerStore } from '../state/spinner-store.js';

const SHIMMER_SPEED = 200;
const SHIMMER_PAD = 10;

export interface SpinnerProps {
  store: SpinnerStore;
}

export function SpinnerAnimationRow({ animation }: {
  animation: SpinnerAnimationView;
}): React.ReactElement {
  const theme = useTheme();
  const displayText = animation.label || animation.verb;
  const messageWidth = measureShimmerMessage(displayText);
  const glimmerIndex = computeGlimmerIndex(animation.time, messageWidth, {
    speed: animation.mode === 'requesting' ? TICK_MS : SHIMMER_SPEED,
    cyclePad: SHIMMER_PAD,
    stalled: animation.stalled,
    direction: animation.mode === 'requesting' ? 'left-to-right' : 'right-to-left',
  });
  const showMetrics = shouldShowSpinnerTimer(
    animation.time,
    animation.verbose,
    animation.activeTeammateCount,
  );
  const totalTokens = totalSpinnerTokens(
    animation.displayedTokens,
    animation.teammateTokens,
  );
  const tokens = totalTokens > 0
    ? ` ${animation.mode === 'requesting' ? '↑' : '↓'} ${totalTokens}`
    : '';
  const thinkingText = animation.mode === 'thinking'
    ? thinkingStatusText(animation.thinkingEffort)
    : animation.thinkingSummaryDurationMs !== null
      ? thoughtStatusText(animation.thinkingSummaryDurationMs)
      : null;

  return (
    <Text>
      <SpinnerGlyph
        time={animation.time}
        activeColor={theme.spinnerActive}
        stalledIntensity={animation.stalledIntensity}
        reducedMotion={animation.reducedMotion}
      />
      <GlimmerMessage
        message={displayText}
        glimmerIndex={glimmerIndex}
        baseColor={theme.spinnerActive}
        shimmerColor={theme.spinnerShimmer}
        flashOpacity={animation.mode === 'tool-use' && !animation.stalled
          ? toolUseFlashOpacity(animation.time)
          : undefined}
        stalledIntensity={animation.stalledIntensity}
      />
      {thinkingText
        ? <ThinkingIndicator
            storeTime={animation.time}
            thinkStartTime={animation.mode === 'thinking'
              ? animation.thinkStartTime
              : null}
            text={thinkingText}
          />
        : <DotsCycle time={animation.time} color={theme.textMuted} />}
      {showMetrics
        ? <Text color={theme.textMuted}>{`  ${formatSpinnerDuration(animation.time)}${tokens}`}</Text>
        : null}
    </Text>
  );
}

export function BriefSpinner({ animation }: {
  animation: SpinnerAnimationView;
}): React.ReactElement {
  return <SpinnerAnimationRow animation={animation} />;
}

function MutedLine({ line }: {
  line: SpinnerAuxiliaryLine;
}): React.ReactElement {
  const theme = useTheme();
  return <Text color={theme.textMuted} dimColor>{line.content}</Text>;
}

export function TeammateSpinnerTree({ lines }: {
  lines: readonly SpinnerAuxiliaryLine[];
}): React.ReactElement {
  return <>{lines.map((line, index) =>
    <MutedLine key={`teammate-${index}`} line={line} />)}</>;
}

export function TaskListV2({ lines }: {
  lines: readonly SpinnerAuxiliaryLine[];
}): React.ReactElement {
  return <>{lines.map((line, index) =>
    <MutedLine key={`task-${index}`} line={line} />)}</>;
}

export function Tip({ line }: {
  line: SpinnerAuxiliaryLine | undefined;
}): React.ReactElement | null {
  return line ? <MutedLine line={line} /> : null;
}

export function Budget({ line }: {
  line: SpinnerAuxiliaryLine | undefined;
}): React.ReactElement | null {
  return line ? <MutedLine line={line} /> : null;
}

export function NextTask({ line }: {
  line: SpinnerAuxiliaryLine | undefined;
}): React.ReactElement | null {
  return line ? <MutedLine line={line} /> : null;
}

export function SpinnerWithVerbInner({ view }: {
  view: SpinnerView;
}): React.ReactElement {
  const teammates = view.auxiliaryLines.filter(line => line.kind === 'teammate');
  const tasks = view.auxiliaryLines.filter(line => line.kind === 'task');
  const tip = view.auxiliaryLines.find(line => line.kind === 'tip');
  const budget = view.auxiliaryLines.find(line => line.kind === 'budget');
  const nextTask = view.auxiliaryLines.find(line => line.kind === 'next-task');

  return (
    <Box flexDirection="column">
      <SpinnerAnimationRow animation={view.animation!} />
      <TeammateSpinnerTree lines={teammates} />
      <TaskListV2 lines={tasks} />
      <Tip line={tip} />
      <Budget line={budget} />
      <NextTask line={nextTask} />
    </Box>
  );
}

export function SpinnerWithVerb({ view }: {
  view: SpinnerView;
}): React.ReactElement | null {
  if (!view.active || !view.animation) return null;
  return view.variant === 'brief'
    ? <BriefSpinner animation={view.animation} />
    : <SpinnerWithVerbInner view={view} />;
}

export function Spinner({ store }: SpinnerProps): React.ReactElement | null {
  const state = useStore(store);
  const view = useMemo(() => selectSpinnerView(state), [state]);
  return <SpinnerWithVerb view={view} />;
}
