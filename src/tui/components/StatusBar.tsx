// src/tui/components/StatusBar.tsx
// 状态栏：mode | model | dir | branch | [进度条] pct%
//
// 物理本质：footer 最底一行，会话元信息的「仪表盘」。
// 选区高亮：订阅 selectionStore，当选区覆盖状态栏行时整行用 SelectionText 切片
// （蓝底黑字覆盖原彩色）；无相交时保持多段彩色。

import React from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { Text } from 'ink';
import type { StatusBarData } from '../types.js';
import { SelectionText } from './SelectionText.js';
import type { SelectionStore, Point } from '../state/selection-store.js';

const BAR_WIDTH = 10;

const MODE_COLOR = '#78e6e6';
const MODEL_COLOR = '#8cbeff';
const DIR_COLOR = '#c8a0ff';
const BRANCH_COLOR = '#ffe16e';
const FILL_COLOR = '#78e6e6';
const EMPTY_COLOR = '#8c8c8c';

const _noopStore = createStore<{ anchor: Point | null; focus: Point | null }>(() => ({
  anchor: null, focus: null,
}));

function splitBar(pct: number): { filled: string; empty: string; label: string } {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * BAR_WIDTH);
  return {
    filled: '█'.repeat(filled),
    empty: '░'.repeat(BAR_WIDTH - filled),
    label: `${Math.round(clamped * 100)}%`,
  };
}

function statusBarContent(status: StatusBarData): string {
  const bar = splitBar(status.contextPct);
  return `${status.mode} │ ${status.model} │ ${status.dir} │ ${status.branch} │ ${bar.filled}${bar.empty} ${bar.label}`;
}

export interface StatusBarProps {
  status: StatusBarData;
  selectionStore?: SelectionStore;
  globalRow?: number;
}

export function StatusBar({ status, selectionStore, globalRow }: StatusBarProps): React.ReactElement {
  const sel = useStore(
    selectionStore ?? _noopStore,
    useShallow((s: { anchor: Point | null; focus: Point | null }) => ({ anchor: s.anchor, focus: s.focus })),
  );

  const intersects = globalRow !== undefined && sel.anchor && sel.focus
    && Math.min(sel.anchor.row, sel.focus.row) <= globalRow
    && Math.max(sel.anchor.row, sel.focus.row) >= globalRow;

  if (intersects) {
    return (
      <SelectionText
        content={statusBarContent(status)}
        globalRow={globalRow}
        selectionStore={selectionStore}
      />
    );
  }

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
