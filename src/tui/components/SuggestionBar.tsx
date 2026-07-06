// src/tui/components/SuggestionBar.tsx
// 斜杠命令候选条：input 以 / 开头且 TAB 触发时显示
//
// 物理本质：一行候选预览。当前选中项 inverse（SGR 7 反色）+ bold 高亮。
// 选TAB循环 index；选中项回写到 input-store（在 use-input-handler 的 onTab 里做）。

import React from 'react';
import { Text } from 'ink';
import { useStore } from 'zustand/react';
import type { CompletionStore } from '../state/completion-store.js';

export interface SuggestionBarProps {
  store: CompletionStore;
}

export function SuggestionBar({ store }: SuggestionBarProps): React.ReactElement | null {
  const visible = useStore(store, (s) => s.visible);
  const candidates = useStore(store, (s) => s.candidates);
  const index = useStore(store, (s) => s.index);

  if (!visible || candidates.length === 0) return null;
  return (
    <Text>
      {candidates.map((c, i) => (
        <Text key={c}>
          {i === index
            ? <Text inverse bold>{c}</Text>
            : <Text dimColor>{c}</Text>}
          {i < candidates.length - 1 ? <Text dimColor>  </Text> : null}
        </Text>
      ))}
    </Text>
  );
}
