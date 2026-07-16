import React from 'react';
import { Text } from 'ink';
import { computeShimmerSegments } from '../inline/shimmer.js';

export interface GlimmerMessageProps {
  message: string;
  glimmerIndex: number;
  baseColor: string;
  shimmerColor: string;
}

export function GlimmerMessage({
  message,
  glimmerIndex,
  baseColor,
  shimmerColor,
}: GlimmerMessageProps): React.ReactElement | null {
  if (!message) return null;

  const { before, shimmer, after } = computeShimmerSegments(message, glimmerIndex);

  return (
    <Text>
      {before && <Text color={baseColor}>{before}</Text>}
      {shimmer && <Text color={shimmerColor}>{shimmer}</Text>}
      {after && <Text color={baseColor}>{after}</Text>}
    </Text>
  );
}
