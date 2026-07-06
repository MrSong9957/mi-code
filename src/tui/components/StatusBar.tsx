// src/tui/components/StatusBar.tsx
// 状态栏：mode | model | dir | branch | [进度条] pct%
//
// 物理本质：footer 最底一行，会话元信息的「仪表盘」。
// 多色高亮：每段独立 <Text color bold>，对齐旧 src/renderer/status-bar.ts 的 RGB 调色板。
// 分隔符用 box-drawing │（视觉上比 ASCII | 更精致）。

import React from 'react';
import { Text } from 'ink';
import type { StatusBarData } from '../types.js';

const BAR_WIDTH = 10;

// 旧调色板（status-bar.ts 的 RGB → Ink hex）
const MODE_COLOR = '#78e6e6';   // 亮青（模式：build/plan/auto）
const MODEL_COLOR = '#8cbeff';  // 亮蓝（模型名）
const DIR_COLOR = '#c8a0ff';    // 亮紫（工作目录）
const BRANCH_COLOR = '#ffe16e'; // 亮黄（git 分支）
const FILL_COLOR = '#78e6e6';   // 进度条填充（同 mode）
const EMPTY_COLOR = '#8c8c8c';  // 进度条空 / 分隔符

/** 把 contextPct [0,1] 渲染成填充/空两段字符串 */
function splitBar(pct: number): { filled: string; empty: string; label: string } {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * BAR_WIDTH);
  return {
    filled: '█'.repeat(filled),
    empty: '░'.repeat(BAR_WIDTH - filled),
    label: `${Math.round(clamped * 100)}%`,
  };
}

export function StatusBar({ status }: { status: StatusBarData }): React.ReactElement {
  const bar = splitBar(status.contextPct);
  return (
    <Text>
      <Text color={MODE_COLOR} bold>{status.mode}</Text>
      <Text color={EMPTY_COLOR}> │ </Text>
      <Text color={MODEL_COLOR} bold>{status.model}</Text>
      <Text color={EMPTY_COLOR}> │ </Text>
      <Text color={DIR_COLOR} bold>{status.dir}</Text>
      <Text color={EMPTY_COLOR}> │ </Text>
      <Text color={BRANCH_COLOR} bold>{status.branch}</Text>
      <Text color={EMPTY_COLOR}> │ </Text>
      <Text color={FILL_COLOR} bold>{bar.filled}</Text>
      <Text color={EMPTY_COLOR}>{bar.empty}</Text>
      <Text color={EMPTY_COLOR}> {bar.label}</Text>
    </Text>
  );
}
