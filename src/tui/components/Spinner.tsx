import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import {
  TICK_MS,
  thinkingStatusText,
  thoughtStatusText,
} from '../state/spinner-store.js';
import { formatSpinnerMetrics } from '../state/spinner-metrics.js';
import type {
  SpinnerAnimationView,
  SpinnerAuxiliaryLine,
  SpinnerView,
} from '../state/spinner-view.js';
import { selectSpinnerView } from '../state/spinner-view.js';
import { useTheme } from '../state/theme-context.js';
import { useLocale } from '../../locale/context.js';
import {
  computeGlimmerIndex,
  measureShimmerMessage,
  toolUseFlashOpacity,
} from '../inline/shimmer.js';
import { GlimmerMessage } from './GlimmerMessage.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
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
  const { t } = useLocale();
  const translator = { t };
  const displayText = animation.label || animation.verb;
  const messageWidth = measureShimmerMessage(displayText);
  const glimmerIndex = computeGlimmerIndex(animation.time, messageWidth, {
    speed: animation.mode === 'requesting' ? TICK_MS : SHIMMER_SPEED,
    cyclePad: SHIMMER_PAD,
    stalled: animation.stalled,
    direction: animation.mode === 'requesting' ? 'left-to-right' : 'right-to-left',
  });

  // Claude Code 样式：verb 后固定 …；thinking 或 thinking summary 时显示状态括号，
  // 否则追加 metrics 段（时长 + token，括号包裹）。
  const isThinking = animation.mode === 'thinking' && animation.thinkStartTime !== null;
  const isThinkingSummary = animation.thinkingSummaryDurationMs !== null;
  const thinkingText = isThinking
    ? thinkingStatusText(animation.thinkingEffort, translator)
    : isThinkingSummary
      ? thoughtStatusText(animation.thinkingSummaryDurationMs!, translator)
      : null;
  const metrics = formatSpinnerMetrics(
    animation.time,
    animation.displayedTokens,
    animation.teammateTokens,
    animation.mode,
  );

  return (
    <Text>
      <SpinnerGlyph
        time={animation.time}
        activeColor={theme.spinnerActive}
        stalledIntensity={animation.stalledIntensity}
        reducedMotion={animation.reducedMotion}
      />
      <GlimmerMessage
        message={`${displayText}…`}
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
            thinkStartTime={isThinking ? animation.thinkStartTime : null}
            text={thinkingText}
          />
        : <Text color={theme.textMuted}>{` ${metrics}`}</Text>}
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
