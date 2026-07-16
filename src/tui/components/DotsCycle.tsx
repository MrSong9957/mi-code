import React from 'react';
import { Text } from 'ink';

export interface DotsCycleProps {
  time: number;
  color: string;
}

export function DotsCycle({ time, color }: DotsCycleProps): React.ReactElement {
  const dotFrame = Math.floor(time / 300) % 3;
  const dots = '.'.repeat(dotFrame + 1).padEnd(3);

  return <Text color={color}>{dots}</Text>;
}
