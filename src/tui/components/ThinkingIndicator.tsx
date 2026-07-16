import React from 'react';
import { Text } from 'ink';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function interpolateColor(c1: RGB, c2: RGB, t: number): RGB {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
  };
}

export function toRGBColor(c: RGB): string {
  return `rgb(${c.r},${c.g},${c.b})`;
}

const THINKING_INACTIVE: RGB = { r: 153, g: 153, b: 153 };
const THINKING_INACTIVE_SHIMMER: RGB = { r: 185, g: 185, b: 185 };
const THINKING_GLOW_PERIOD_S = 2;

export interface ThinkingIndicatorProps {
  /** Spinner store time (50ms tick), used for sine wave calculation */
  storeTime: number;
  /** Timestamp when thinking started (Date.now()), null if not thinking */
  thinkStartTime: number | null;
  /** Text to display (e.g. "thinking") */
  text: string;
  /** Whether to wrap text in parentheses: (text) vs text */
  showParens?: boolean;
}

export function ThinkingIndicator({
  storeTime,
  thinkStartTime,
  text,
  showParens = false,
}: ThinkingIndicatorProps): React.ReactElement | null {
  if (!text) return null;

  // Use storeTime (50ms tick) for animation, not Date.now()
  // thinkStartTime is storeTime when thinking began; compute elapsed from store clock
  const elapsed = thinkStartTime !== null ? storeTime - thinkStartTime : 0;
  const THINKING_DELAY_TICKS = 60;  // 3000ms / 50ms = 60 ticks
  const elapsedSec = Math.max(0, elapsed - THINKING_DELAY_TICKS) * 0.05;  // ticks * 50ms = seconds
  const thinkingOpacity = elapsed < THINKING_DELAY_TICKS
    ? 0
    : (Math.sin(elapsedSec * Math.PI * 2 / THINKING_GLOW_PERIOD_S) + 1) / 2;

  const color = toRGBColor(interpolateColor(THINKING_INACTIVE, THINKING_INACTIVE_SHIMMER, thinkingOpacity));

  if (showParens) {
    return (
      <>
        <Text dimColor>(</Text>
        <Text color={color}>{text}</Text>
        <Text dimColor>)</Text>
      </>
    );
  }

  return <Text color={color}>{`(${text})`}</Text>;
}
