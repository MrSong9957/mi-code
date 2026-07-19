// src/tui/inline-v2/SelectOverlayV2.tsx
//
// V2 inline 模式的交互式选择器(独立组件,自订阅 selectStore)。
//
// 物理本质:visible 时渲染 title + 选项列表 + 操作提示,替代 spinner+footer 占据活动区。
// 用户按 ↑↓ 移动 → store.cycle/cyclePrev → 本组件重渲染高亮项;
// Enter → store.confirm → 触发 onConfirm 回调并关闭。
//
// 设计与 alt-screen Footer 的区别:这是独立 overlay,visible 时由父组件 <InlineAppV2>
// 用条件渲染切换(只渲染 <SelectOverlayV2>,不渲染 spinner+footer)。这样 select 关闭后,
// 活动 input/spinner 不需要"重新计算 y 偏移"——它们一直在,只是被 overlay 覆盖渲染。
//
// 加 memo:store 引用 + cols 都稳定时,父重渲染不传新 props,memo 拦截。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { getTheme } from '../../utils/theme.js';
import { displayWidth } from '../inline/text-layout.js';
import type { SelectStore } from '../state/select-store.js';

const SELECT_LEFT_PAD = 2;

export interface SelectOverlayV2Props {
  store: SelectStore;
  cols: number;
}

export const SelectOverlayV2 = React.memo(function SelectOverlayV2({
  store,
  cols,
}: SelectOverlayV2Props): React.ReactElement | null {
  // 用 useShallow 让 selector 输出引用稳定(避免 React 18 getSnapshot 警告)
  const select = useStore(store, useShallow((s) => ({
    visible: s.visible,
    title: s.title,
    options: s.options,
    index: s.index,
  })));

  if (!select.visible || select.options.length === 0) return null;

  const theme = getTheme();
  const suggestionColor = theme.suggestion;

  // 命令名列宽度:最长 label + padding,上限终端 40%
  const labelMaxWidth = Math.min(
    Math.max(...select.options.map((o) => displayWidth(o.label)), 0) + 3,
    Math.floor(cols * 0.4),
  );

  return (
    <Box flexDirection="column">
      <Text bold>{`${' '.repeat(SELECT_LEFT_PAD)}${select.title}`}</Text>
      {select.options.map((opt, i) => {
        const isSelected = i === select.index;
        const labelPad = ' '.repeat(Math.max(0, labelMaxWidth - displayWidth(opt.label)));
        const desc = opt.description ?? '';
        if (isSelected) {
          return (
            <Text key={opt.value} color={suggestionColor}>
              {`${' '.repeat(SELECT_LEFT_PAD)}> ${opt.label}${labelPad}  ${desc}`}
            </Text>
          );
        }
        return (
          <Text key={opt.value}>
            {`${' '.repeat(SELECT_LEFT_PAD)}${opt.label}`}
            {desc ? <Text dimColor>{`${labelPad}  ${desc}`}</Text> : labelPad}
          </Text>
        );
      })}
      <Text dimColor>{`${' '.repeat(SELECT_LEFT_PAD)}↑↓ navigate · Enter confirm · Esc cancel`}</Text>
    </Box>
  );
});
