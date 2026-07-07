// src/tui/components/StatusBar.tsx
// 状态栏：mode | model | dir | branch | [进度条] pct%
//
// 物理本质：footer 最底一行，会话元信息的「仪表盘」。
// 选区高亮：当选区覆盖状态栏时，整行经 SelectionText 切片，选中段蓝底黑字（覆盖原彩色）。
// 无选区时保持多段彩色（对齐旧调色板）。

import React from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { Text } from 'ink';
import type { StatusBarData } from '../types.js';
import { SelectionText } from './SelectionText.js';
import type { SelectionStore, Point } from '../state/selection-store.js';

const BAR_WIDTH = 10;

// 旧调色板（status-bar.ts 的 RGB → Ink hex）
const MODE_COLOR = '#78e6e6';   // 亮青（模式：build/plan/auto）
const MODEL_COLOR = '#8cbeff';  // 亮蓝（模型名）
const DIR_COLOR = '#c8a0ff';    // 亮紫（工作目录）
const BRANCH_COLOR = '#ffe16e'; // 亮黄（git 分支）
const FILL_COLOR = '#78e6e6';   // 进度条填充（同 mode）
const EMPTY_COLOR = '#8c8c8c';  // 进度条空 / 分隔符

/** 占位 store（selectionStore 缺省时） */
const _noopStore = createStore<{ anchor: Point | null; focus: Point | null }>(() => ({
  anchor: null, focus: null,
}));

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

/** 拼出状态栏的完整纯文本（与 row-text-map 的 statusBarText 一致），用于选区切片 */
function statusBarContent(status: StatusBarData): string {
  const bar = splitBar(status.contextPct);
  return `${status.mode} │ ${status.model} │ ${status.dir} │ ${status.branch} │ ${bar.filled}${bar.empty} ${bar.label}`;
}

export interface StatusBarProps {
  status: StatusBarData;
  /** 选区 store（由 Footer 注入） */
  selectionStore?: SelectionStore;
  /** 状态栏的全局行号（由 Footer 算好传入） */
  globalRow?: number;
}

export function StatusBar({ status, selectionStore, globalRow }: StatusBarProps): React.ReactElement {
  const sel = useStore(
    selectionStore ?? _noopStore,
    useShallow((s: { anchor: Point | null; focus: Point | null }) => ({ anchor: s.anchor, focus: s.focus })),
  );

  // 选区与状态栏相交时，整行用 SelectionText 切片（选中段蓝底黑字覆盖彩色）
  const intersects = globalRow !== undefined && sel.anchor && sel.focus
    && Math.min(sel.anchor.row, sel.focus.row) <= globalRow
    && Math.max(sel.anchor.row, sel.focus.row) >= globalRow;

  if (intersects) {
    return (
      <SelectionText
        content={statusBarContent(status)}
        globalRow={globalRow}
        anchor={sel.anchor}
        focus={sel.focus}
      />
    );
  }

  // 无选区相交：保持多段彩色
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
