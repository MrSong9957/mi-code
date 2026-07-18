import React from 'react';
import { Text } from 'ink';
import { computeShimmerSegments, interpolateShimmerColor } from '../inline/shimmer.js';
import { spinnerGlyphColor } from '../state/spinner-glyph.js';

export interface GlimmerMessageProps {
  message: string;
  glimmerIndex: number;
  baseColor: string;
  shimmerColor: string;
  flashOpacity?: number;
  stalledIntensity?: number;
}

export function GlimmerMessage({
  message,
  glimmerIndex,
  baseColor,
  shimmerColor,
  flashOpacity,
  stalledIntensity = 0,
}: GlimmerMessageProps): React.ReactElement | null {
  if (!message) return null;

  const visibleBaseColor = spinnerGlyphColor(baseColor, stalledIntensity);
  const visibleShimmerColor = spinnerGlyphColor(shimmerColor, stalledIntensity);

  if (flashOpacity !== undefined) {
    const flashColor = interpolateShimmerColor(visibleBaseColor, visibleShimmerColor, flashOpacity);
    return <Text color={flashColor}>{message} </Text>;
  }

  const { before, shimmer, after } = computeShimmerSegments(message, glimmerIndex);

  return (
    <Text>
      {before && <Text color={visibleBaseColor}>{before}</Text>}
      {shimmer && <Text color={visibleShimmerColor}>{shimmer}</Text>}
      {after && <Text color={visibleBaseColor}>{after}</Text>}
      <Text color={visibleBaseColor}> </Text>
    </Text>
  );
}
