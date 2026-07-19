// src/__tests__/tui/inline-v2/streaming-text.test.tsx
//
// <StreamingText> 单元测试(Stage 4 Task 4.1)。
//
// 物理本质:V2 inline 流式正文渲染组件,把末条未固化消息的 streamingText
// 经 wrapStreamingTextTrimmed / wrapThinkingTextTrimmed 转成 ANSI 行,
// 返回真正的 React 元素交给 Ink createIncremental 行级 diff。
//
// 加 memo:输入相同 text 时不重渲染。
// 与 V0 <InlineApp> 区别:V0 把 ANSI 直接写 stdout,这里返回 React 元素。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { StreamingText } from '../../../tui/inline-v2/StreamingText.js';

describe('<StreamingText>', () => {
  it('text=undefined 时不渲染', () => {
    const { lastFrame } = render(<StreamingText text={undefined} role="assistant" cols={80} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('text 空串时不渲染', () => {
    const { lastFrame } = render(<StreamingText text="" role="assistant" cols={80} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('渲染 assistant 流式文本', () => {
    // wrapStreamingTextTrimmed 只显示到最后一个 \n 的完整行;
    // 没换行符时返回占位 ● ,所以这里给一个含 \n 的文本。
    const { lastFrame } = render(
      <StreamingText text={'hello world\nsecond line\n'} role="assistant" cols={80} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
    expect(frame).toContain('second');
  });

  it('渲染 thinking 流式文本(dim)', () => {
    const { lastFrame } = render(
      <StreamingText text={'thinking...\ngoing\n'} role="thinking" cols={80} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
    expect(frame).toContain('going');
  });

  it('text 变化时 frame 跟着变(无换行 → 有换行)', () => {
    // 无换行 → 占位;有换行 → 真内容。验证文本变化时组件确实重渲染。
    const { lastFrame, rerender } = render(
      <StreamingText text={'incomplete line'} role="assistant" cols={80} />,
    );
    const frame1 = lastFrame() ?? '';

    rerender(<StreamingText text={'incomplete line\nnow complete\n'} role="assistant" cols={80} />);
    const frame2 = lastFrame() ?? '';

    // 第二帧应包含 "now complete"(刚出现完整行)
    expect(frame2).toContain('now complete');
    // 两帧不同
    expect(frame1).not.toBe(frame2);
  });
});
