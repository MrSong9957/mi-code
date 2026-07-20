// src/tui/inline-v2/MessageLine.tsx
//
// V2 路径下单条已固化消息渲染。
//
// 物理本质:<Static items={...}> 的 children render prop 返回的组件。
// 用 renderFinalizedLine(已有纯函数,src/tui/inline/text-layout.ts)转 ANSI,
// Ink <Text> 透传 ANSI 字符串(POC 已验证 — Ink 的 ansi-tokenizer 原样输出 SGR 码)。
//
// 与 V0 的 <InlineApp> 区别:V0 把 ANSI 字符串直接写进 stdout(副作用),
// 这里返回真正的 React 元素,交给 Ink reconciler + <Static> 管理写入时机。

import React from 'react';
import { Text } from 'ink';
import { renderFinalizedLine } from '../inline/text-layout.js';
import type { TuiMessage } from '../types.js';

export interface MessageLineProps {
  msg: TuiMessage;
  cols: number;
}

export function MessageLine({ msg, cols }: MessageLineProps): React.ReactElement {
  return (
    <Text>
      {msg.lines.flatMap((line, lineIdx) =>
        renderFinalizedLine(msg.role, line, cols).map((ansiLine, i) => (
          <Text key={`${lineIdx}-${i}`}>{ansiLine + '\n'}</Text>
        ))
      )}
    </Text>
  );
}
