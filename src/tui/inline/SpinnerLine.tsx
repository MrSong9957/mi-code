// Inline mode spinner line builder (ANSI string output)
import {
  computeGlimmerIndex,
  computeShimmerSegments,
  measureShimmerMessage,
  toolUseFlashColor,
} from './shimmer.js';
import {
  formatSpinnerDuration,
  shouldShowSpinnerTimer,
  thinkingColorAt,
  thinkingStatusText,
  thoughtStatusText,
  totalSpinnerTokens,
  TICK_MS,
  type SpinnerMode,
} from '../state/spinner-store.js';
import {
  spinnerGlyphColor,
  spinnerGlyphColorAt,
  spinnerGlyphTextAt,
} from '../state/spinner-glyph.js';

const SHIMMER_SPEED = 200;
const SHIMMER_PAD = 10;

interface SpinnerTheme {
  active: string;
  shimmer: string;
  stalled: string;
  muted: string;
}

interface SpinnerLineOpts {
  time: number;
  mode: SpinnerMode;
  verb: string;
  label: string;
  stalled: boolean;
  stalledIntensity?: number;
  reducedMotion?: boolean;
  verbose?: boolean;
  activeTeammateCount?: number;
  displayedTokens?: number;
  teammateTokens?: number;
  thinkingEffort?: string | null;
  thinkingSummaryDurationMs?: number | null;
  thinkStartTime: number | null;
  theme: SpinnerTheme;
}

function parseRGB(color: string): { r: number; g: number; b: number } {
  const match = color.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!match) return THINKING_INACTIVE;
  return { r: +match[1], g: +match[2], b: +match[3] };
}

function toAnsiColor(rgb: string): string {
  const { r, g, b } = parseRGB(rgb);
  return `\x1b[38;2;${r};${g};${b}m`;
}

const THINKING_INACTIVE = { r: 153, g: 153, b: 153 };
const RESET = '\x1b[0m';

export function buildSpinnerLine(opts: SpinnerLineOpts): string {
  const reducedMotion = opts.reducedMotion ?? false;
  const glyphText = spinnerGlyphTextAt(opts.time, reducedMotion);
  const displayText = opts.label || opts.verb;

  // Shimmer
  const glimmerIndex = computeGlimmerIndex(opts.time, measureShimmerMessage(displayText), {
    speed: opts.mode === 'requesting' ? TICK_MS : SHIMMER_SPEED,
    cyclePad: SHIMMER_PAD,
    stalled: opts.stalled,
    direction: opts.mode === 'requesting' ? 'left-to-right' : 'right-to-left',
  });
  const { before, shimmer, after } = computeShimmerSegments(displayText, glimmerIndex);

  // Colors from theme
  const stalledIntensity = opts.stalledIntensity ?? (opts.stalled ? 1 : 0);
  const baseColorValue = spinnerGlyphColor(opts.theme.active, stalledIntensity);
  const shimmerColorValue = spinnerGlyphColor(opts.theme.shimmer, stalledIntensity);
  const baseColor = toAnsiColor(baseColorValue);
  const shimmerColor = toAnsiColor(shimmerColorValue);
  const glyphColor = toAnsiColor(spinnerGlyphColorAt(
    opts.theme.active,
    stalledIntensity,
    reducedMotion,
    opts.time,
  ));

  let line = `${glyphColor}${glyphText}${RESET}`;
  if (opts.mode === 'tool-use' && !opts.stalled) {
    line += `${toAnsiColor(toolUseFlashColor(
      opts.time,
      baseColorValue,
      shimmerColorValue,
    ))}${displayText} ${RESET}`;
  } else {
    line += `${baseColor}${before}${RESET}`;
    line += `${shimmerColor}${shimmer}${RESET}`;
    line += `${baseColor}${after} ${RESET}`;
  }

  // Dots, active thinking, or the temporary post-thinking summary.
  if (opts.mode === 'thinking' && opts.thinkStartTime !== null) {
    const color = thinkingColorAt(opts.time, opts.thinkStartTime);
    line += `${toAnsiColor(`rgb(${color.r},${color.g},${color.b})`)}(${thinkingStatusText(opts.thinkingEffort ?? null)})${RESET}`;
  } else if (opts.thinkingSummaryDurationMs !== null && opts.thinkingSummaryDurationMs !== undefined) {
    const color = thinkingColorAt(opts.time, null);
    line += `${toAnsiColor(`rgb(${color.r},${color.g},${color.b})`)}(${thoughtStatusText(opts.thinkingSummaryDurationMs)})${RESET}`;
  } else {
    const dotFrame = Math.floor(opts.time / 300) % 3;
    const dots = '.'.repeat(dotFrame + 1).padEnd(3);
    line += `${toAnsiColor(opts.theme.muted)}${dots}${RESET}`;
  }

  if (shouldShowSpinnerTimer(
    opts.time,
    opts.verbose ?? false,
    opts.activeTeammateCount ?? 0,
  )) {
    const totalTokens = totalSpinnerTokens(
      opts.displayedTokens ?? 0,
      opts.teammateTokens ?? 0,
    );
    const tokens = totalTokens > 0
      ? ` ${opts.mode === 'requesting' ? '↑' : '↓'} ${totalTokens}`
      : '';
    line += `${toAnsiColor(opts.theme.muted)}  ${formatSpinnerDuration(opts.time)}${tokens}${RESET}`;
  }

  return line;
}
