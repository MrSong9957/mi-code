// Inline mode spinner line builder (ANSI string output)
import sliceAnsi from 'slice-ansi';
import {
  computeGlimmerIndex,
  computeShimmerSegments,
  measureShimmerMessage,
  toolUseFlashColor,
} from './shimmer.js';
import {
  thinkingColorAt,
  thinkingStatusText,
  thoughtStatusText,
  TICK_MS,
  type SpinnerMode,
} from '../state/spinner-store.js';
import { formatSpinnerMetrics } from '../state/spinner-metrics.js';
import {
  spinnerGlyphColor,
  spinnerGlyphColorAt,
  spinnerGlyphTextAt,
} from '../state/spinner-glyph.js';
import type { SpinnerView } from '../state/spinner-view.js';
import { getUsableWidth } from '../state/wrap-line.js';
import { getTheme, type Theme } from '../../utils/theme.js';

const SHIMMER_SPEED = 200;
const SHIMMER_PAD = 10;

interface SpinnerTheme {
  active: string;
  shimmer: string;
  stalled: string;
  muted: string;
}

export interface SpinnerLineOpts {
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
  const match = color.match(
    /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/,
  );
  if (!match) return THINKING_INACTIVE;
  return { r: +match[1], g: +match[2], b: +match[3] };
}

function toAnsiColor(rgb: string): string {
  const { r, g, b } = parseRGB(rgb);
  return `\x1b[38;2;${r};${g};${b}m`;
}

const THINKING_INACTIVE = { r: 153, g: 153, b: 153 };
const RESET = '\x1b[0m';

function spinnerThemeFrom(theme: Theme): SpinnerTheme {
  return {
    active: theme.spinnerActive,
    shimmer: theme.spinnerShimmer,
    stalled: theme.spinnerStalled,
    muted: theme.textMuted,
  };
}

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
    // tool-use：整体呼吸灯覆盖 displayText，加 …（与 responding 等一致）。
    line += `${toAnsiColor(toolUseFlashColor(
      opts.time,
      baseColorValue,
      shimmerColorValue,
    ))}${displayText}…${RESET}`;
  } else {
    // 其他模式：shimmer 分段 + 省略号（对齐 Claude Code 的 "Verb…"）。
    line += `${baseColor}${before}${RESET}`;
    line += `${shimmerColor}${shimmer}${RESET}`;
    line += `${baseColor}${after}…${RESET}`;
  }

  // 状态括号段：thinking 摘要 / thinking 实时 / 否则不显示。
  // 注意：thinking 阶段不显示 metrics（Claude Code 行为：思考时只显示 "thinking" 状态）。
  if (opts.thinkingSummaryDurationMs !== null && opts.thinkingSummaryDurationMs !== undefined) {
    const color = thinkingColorAt(opts.time, null);
    line += ` ${toAnsiColor(`rgb(${color.r},${color.g},${color.b})`)}(${thoughtStatusText(opts.thinkingSummaryDurationMs)})${RESET}`;
  } else if (opts.mode === 'thinking' && opts.thinkStartTime !== null) {
    const color = thinkingColorAt(opts.time, opts.thinkStartTime);
    line += ` ${toAnsiColor(`rgb(${color.r},${color.g},${color.b})`)}(${thinkingStatusText(opts.thinkingEffort ?? null)})${RESET}`;
  } else {
    // 非 thinking 状态：追加 Claude Code 样式的 metrics 段（时长 + token）。
    const metrics = formatSpinnerMetrics(
      opts.time,
      opts.displayedTokens ?? 0,
      opts.teammateTokens ?? 0,
      opts.mode,
    );
    line += `${toAnsiColor(opts.theme.muted)} ${metrics}${RESET}`;
  }

  return line;
}

export function buildSpinnerLines(
  view: SpinnerView,
  cols: number,
  theme: SpinnerTheme = spinnerThemeFrom(getTheme()),
): string[] {
  if (!view.active || !view.animation) return [];

  const usableWidth = getUsableWidth(cols);
  const main = buildSpinnerLine({ ...view.animation, theme });
  const muted = toAnsiColor(theme.muted);
  const auxiliary = view.auxiliaryLines.map(line =>
    `${muted}\x1b[2m${sliceAnsi(line.content, 0, usableWidth)}${RESET}`,
  );

  return [main, ...auxiliary].map(line => sliceAnsi(line, 0, usableWidth));
}
