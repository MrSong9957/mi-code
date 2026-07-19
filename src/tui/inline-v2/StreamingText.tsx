// src/tui/inline-v2/StreamingText.tsx
//
// V2 inline 流式文本渲染。
//
// 物理本质:活动区里的"草稿",每帧被 Ink createIncremental 行级 diff 覆写。
// 用 wrapStreamingTextTrimmed / wrapThinkingTextTrimmed(已有纯函数)
// 把末条未固化消息的 streamingText 转成 ANSI 行,再交给 Ink <Text> 透传。
//
// 与 V0 <InlineApp> 区别:V0 把 ANSI 字符串直接 rewriteStreamingLines() 写 stdout,
// 这里返回真正的 React 元素,Ink reconciler 自动 diff 上一帧,只改变化的行。
//
// 加 memo:输入相同 text 不重渲染;输入变化(流式 token 到达)时重渲染。
// 注意:本组件的 props 由 <InlineAppV2> 父组件传入,父组件用 selector 订阅
// messagesStore 末条 streamingText,token 到达 → 父重渲染 → 传新 text → 本组件重渲染。

import React from 'react';
import { Text } from 'ink';
import { wrapStreamingTextTrimmed, wrapThinkingTextTrimmed } from '../inline/text-layout.js';

export interface StreamingTextProps {
  /** 末条未固化消息的 streamingText。undefined/空字符串时不渲染。 */
  text: string | undefined;
  /** 角色:assistant 走流式 trim 折行(行首 ●);thinking 走灰色 dim 折行。 */
  role: 'assistant' | 'thinking';
  cols: number;
}

export const StreamingText = React.memo(function StreamingText({
  text,
  role,
  cols,
}: StreamingTextProps): React.ReactElement | null {
  if (text === undefined || text === '') return null;
  const lines = role === 'thinking'
    ? wrapThinkingTextTrimmed(text, cols)
    : wrapStreamingTextTrimmed(text, cols);
  return (
    <Text>
      {lines.map((line, i) => (
        <Text key={i}>{line + '\n'}</Text>
      ))}
    </Text>
  );
});
