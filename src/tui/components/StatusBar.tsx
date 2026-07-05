// src/tui/components/StatusBar.tsx
// 状态栏：mode | model | dir | branch | [进度条] pct%
//
// 物理本质：footer 最底一行，会话元信息的「仪表盘」。
// 用户规格：模式 | 模型 | 目录(末两级) | 分支 | 上下文进度条百分比。
// 进度条 10 格：█ 满 / ░ 空，contextPct ∈ [0,1]。

import React from 'react';
import { Text } from 'ink';
import type { StatusBarData } from '../types.js';

const BAR_WIDTH = 10;

/** 把 contextPct [0,1] 渲染成 10 格进度条 + 百分比，如 [█████░░░░░] 50% */
function progressBar(pct: number): string {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * BAR_WIDTH);
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}] ${Math.round(clamped * 100)}%`;
}

export function StatusBar({ status }: { status: StatusBarData }): React.ReactElement {
  return (
    <Text dimColor>
      {status.mode} | {status.model} | {status.dir} | {status.branch} | {progressBar(status.contextPct)}
    </Text>
  );
}
