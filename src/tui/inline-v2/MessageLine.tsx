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
import { Box, Text } from 'ink';
import { renderFinalizedLine } from '../inline/text-layout.js';
import type { TuiMessage } from '../types.js';

export interface MessageLineProps {
  msg: TuiMessage;
  cols: number;
}

export function MessageLine({ msg, cols }: MessageLineProps): React.ReactElement {
  // AUTO-0025-transient Task 3:agent-completion 单行渲染(truncate,不换行)。
  // 物理本质:完成的子代理只展示一行 ● Agent "..." finished · Ns,过长截断。
  //
  // AUTO-0025 Phase B review 修正:
  // 1. ask_user_question 复用 agent-completion kind,含父标题+子项多行。单行特判会截断
  //    丢失子项。修复:仅当 lines 恰好 1 行时走 truncate 单行模式(spawn_agent 行为不变);
  //    多行 fall through 到默认多行渲染。
  // 2. 单行 truncate 分支末尾补 '\n',与默认分支(每行 + '\n')输出契约一致,
  //    保证 agent-completion 消息之间也有空行间隔(issue 3:连续 spawn_agent 紧贴)。
  if (msg.kind === 'agent-completion' && msg.lines.length <= 1) {
    const line = msg.lines[0];
    // width 限制 + truncate-end 截断超长内容;末尾 '\n' 产生空行间隔(issue 3)。
    // 不用 height={1}(会吞掉 \n 产生的空行)。
    return (
      <Box width={cols}>
        <Text wrap="truncate-end">{(line?.content ?? '● Agent finished') + '\n'}</Text>
      </Box>
    );
  }
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
