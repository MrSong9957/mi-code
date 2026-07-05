// src/tui/components/StatusBar.tsx
// 状态栏：mode / model / branch / dir / contextUsage / 工具状态 / 提示
//
// 物理本质：footer 最底一行，对齐 Claude Code 的底部状态栏。
// 布局：左侧 mode + model，右侧 branch + dir；contextUsage 高时警示色。

import React from 'react';
import { Text } from 'ink';
import type { StatusBarData } from '../types.js';

export function StatusBar({ status }: { status: StatusBarData }): React.ReactElement {
  const left = `${status.mode} · ${status.model}`;
  const right = `${status.branch} · ${status.dir}`;
  const ctxPct = Math.round(status.contextUsage * 100);
  const ctxText = ctxPct > 0 ? ` · ctx ${ctxPct}%` : '';
  return (
    <Text dimColor>
      {left}
      {ctxText}
      {'  '}
      {right}
      {status.toolStatus ? `  · ${status.toolStatus.name}` : ''}
      {status.hint ? `  · ${status.hint}` : ''}
    </Text>
  );
}
