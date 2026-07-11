// src/tui/components/SuggestionBar.tsx
// 斜杠命令下拉菜单：输入 / 后自动弹出，竖排显示候选命令
//
// 物理本质：输入框上方的「命令速查表」。
// 用户输入 / 时弹出全部命令，继续输入实时过滤；
// 上下箭头选择，Enter 确认，Esc 关闭。
// 最多显示 8 行，超出部分滚动。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import type { CompletionStore } from '../state/completion-store.js';

const MAX_VISIBLE = 8;

export interface SuggestionBarProps {
  store: CompletionStore;
}

export function SuggestionBar({ store }: SuggestionBarProps): React.ReactElement | null {
  const visible = useStore(store, (s) => s.visible);
  const candidates = useStore(store, (s) => s.candidates);
  const index = useStore(store, (s) => s.index);

  if (!visible || candidates.length === 0) return null;

  // 计算可见范围（滚动窗口）
  const startIndex = Math.max(0, index - MAX_VISIBLE + 1);
  const visibleCandidates = candidates.slice(startIndex, startIndex + MAX_VISIBLE);

  return (
    <Box flexDirection="column">
      {visibleCandidates.map((c, i) => {
        const actualIndex = startIndex + i;
        const isSelected = actualIndex === index;
        return (
          <Text key={c}>
            {isSelected
              ? <Text inverse bold>{`▸/${c}`}</Text>
              : <Text dimColor>{`  /${c}`}</Text>}
          </Text>
        );
      })}
    </Box>
  );
}
