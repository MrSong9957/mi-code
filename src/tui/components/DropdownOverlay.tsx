// src/tui/components/DropdownOverlay.tsx
// 下拉菜单浮层（Claude Code Portal 模式）
//
// 物理本质：布局顶层的「便签」。
// 从 DropdownContext 读取候选数据，渲染在输入框上方。
// 与输入框分离——菜单变化时只重绘这里，输入框不受影响。
//
// Claude Code 的关键设计：
// - position="absolute"：不占位置，飘着
// - bottom="100%"：贴在输入框正上方
// - opaque={true}：不透明，防止下面内容透上来

import React from 'react';
import { Box, Text } from 'ink';
import { useDropdown } from '../state/dropdown-context.js';

const MAX_VISIBLE = 8;

export function DropdownOverlay(): React.ReactElement | null {
  const { visible, candidates, selectedIndex } = useDropdown();

  if (!visible || candidates.length === 0) return null;

  // 计算可见范围（滚动窗口）
  const startIndex = Math.max(0, selectedIndex - MAX_VISIBLE + 1);
  const visibleCandidates = candidates.slice(startIndex, startIndex + MAX_VISIBLE);

  return (
    <Box flexDirection="column">
      {visibleCandidates.map((c, i) => {
        const actualIndex = startIndex + i;
        const isSelected = actualIndex === selectedIndex;
        return (
          <Text key={c}>
            {isSelected
              ? <Text inverse bold>{`▸ /${c}`}</Text>
              : <Text dimColor>{`  /${c}`}</Text>}
          </Text>
        );
      })}
    </Box>
  );
}
