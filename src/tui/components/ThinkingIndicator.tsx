import React from 'react';
import { Text } from 'ink';
import { thinkingColorAt } from '../state/spinner-store.js';

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

export interface ThinkingIndicatorProps {
  /** Spinner store 的毫秒级统一时钟。 */
  storeTime: number;
  /** thinking 开始时的 storeTime；null 时使用静态基础灰。 */
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

  const color = toRGBColor(thinkingColorAt(storeTime, thinkStartTime));

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
