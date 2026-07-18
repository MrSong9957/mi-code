import React from 'react';
import { Text } from 'ink';
import {
  reducedMotionColor,
  spinnerGlyphColor,
  spinnerGlyphTextAt,
} from '../state/spinner-glyph.js';

export interface SpinnerGlyphProps {
  time: number;
  activeColor: string;
  stalledIntensity: number;
  reducedMotion?: boolean;
}

/** Spinner 左侧符号：负责帧、reducedMotion 和 stalled 颜色，不负责文字 shimmer。 */
export function SpinnerGlyph({
  time,
  activeColor,
  stalledIntensity,
  reducedMotion = false,
}: SpinnerGlyphProps): React.ReactElement {
  const color = spinnerGlyphColor(activeColor, stalledIntensity);
  const visibleColor = reducedMotion ? reducedMotionColor(color, time) : color;
  return <Text color={visibleColor} bold>{spinnerGlyphTextAt(time, reducedMotion)}</Text>;
}
