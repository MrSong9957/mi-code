// Inline mode spinner line builder (ANSI string output)
import { computeGlimmerIndex, computeShimmerSegments } from './shimmer.js';
import { SPINNER_FRAMES } from '../state/spinner-store.js';

const SHIMMER_SPEED = 200;
const SHIMMER_PAD = 10;
const THINKING_GLOW_PERIOD_S = 2;

interface SpinnerTheme {
  active: string;
  shimmer: string;
  stalled: string;
  muted: string;
}

interface SpinnerLineOpts {
  time: number;
  mode: 'thinking' | 'generating' | 'tool';
  verb: string;
  label: string;
  stalled: boolean;
  thinkStartTime: number | null;
  theme: SpinnerTheme;
}

function parseRGB(color: string): { r: number; g: number; b: number } {
  const match = color.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!match) return { r: 153, g: 153, b: 153 };
  return { r: +match[1], g: +match[2], b: +match[3] };
}

function interpolateColor(
  c1: { r: number; g: number; b: number },
  c2: { r: number; g: number; b: number },
  t: number,
): string {
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function toAnsiColor(rgb: string): string {
  const { r, g, b } = parseRGB(rgb);
  return `\x1b[38;2;${r};${g};${b}m`;
}

const THINKING_INACTIVE = { r: 153, g: 153, b: 153 };
const THINKING_INACTIVE_SHIMMER = { r: 185, g: 185, b: 185 };
const RESET = '\x1b[0m';

export function buildSpinnerLine(opts: SpinnerLineOpts): string {
  const frame = SPINNER_FRAMES[Math.floor(opts.time / 120) % SPINNER_FRAMES.length];
  const displayText = opts.label || opts.verb;

  // Shimmer
  const glimmerIndex = computeGlimmerIndex(opts.time, displayText.length, {
    speed: SHIMMER_SPEED,
    cyclePad: SHIMMER_PAD,
    stalled: opts.stalled,
  });
  const { before, shimmer, after } = computeShimmerSegments(displayText, glimmerIndex);

  // Colors from theme
  const baseColor = opts.stalled ? toAnsiColor(opts.theme.stalled) : toAnsiColor(opts.theme.active);
  const shimmerColor = toAnsiColor(opts.theme.shimmer);

  let line = `${baseColor}${frame} ${RESET}`;
  line += `${baseColor}${before}${RESET}`;
  line += `${shimmerColor}${shimmer}${RESET}`;
  line += `${baseColor}${after}${RESET}`;

  // Dots or thinking
  if (opts.mode === 'thinking' && opts.thinkStartTime !== null) {
    const elapsed = opts.time - opts.thinkStartTime;
    const THINKING_DELAY_TICKS = 60;
    const elapsedSec = Math.max(0, elapsed - THINKING_DELAY_TICKS) * 0.05;
    const opacity = elapsed < THINKING_DELAY_TICKS
      ? 0
      : (Math.sin(elapsedSec * Math.PI * 2 / THINKING_GLOW_PERIOD_S) + 1) / 2;
    const thinkColor = interpolateColor(THINKING_INACTIVE, THINKING_INACTIVE_SHIMMER, opacity);
    line += ` ${thinkColor}(thinking)${RESET}`;
  } else {
    const dotFrame = Math.floor(opts.time / 300) % 3;
    const dots = '.'.repeat(dotFrame + 1).padEnd(3);
    line += `${toAnsiColor(opts.theme.muted)}${dots}${RESET}`;
  }

  return line;
}
