// src/__tests__/tui/inline-v2/message-line.test.tsx
//
// <MessageLine> 单元测试:V2 路径下已固化消息渲染。
//
// 物理本质:<Static items={...}> 的 children render prop 返回的组件。
// 通过 renderFinalizedLine(已有纯函数,src/tui/inline/text-layout.ts)转 ANSI,
// Ink <Text> 透传 ANSI 字符串(POC 已验证)。
//
// 用 ink-testing-library 的 render/lastFrame 断言渲染内容。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { MessageLine } from '../../../tui/inline-v2/MessageLine.js';
import type { TuiMessage } from '../../../tui/types.js';

function makeMessage(overrides: Partial<TuiMessage>): TuiMessage {
  return {
    uuid: 'msg-x',
    role: 'assistant',
    lines: [],
    finalized: true,
    ...overrides,
  };
}

describe('<MessageLine>', () => {
  it('渲染 assistant 普通行', () => {
    const msg = makeMessage({
      uuid: 'msg-1',
      role: 'assistant',
      lines: [{ content: 'hello world', style: {}, indent: 0 }],
    });
    const { lastFrame } = render(<MessageLine msg={msg} cols={80} />);
    expect(lastFrame()).toContain('hello world');
  });

  it('多行消息渲染所有行', () => {
    const msg = makeMessage({
      uuid: 'msg-2',
      role: 'user',
      lines: [
        { content: 'line 1', style: {}, indent: 0 },
        { content: 'line 2', style: {}, indent: 0 },
      ],
    });
    const { lastFrame } = render(<MessageLine msg={msg} cols={80} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line 1');
    expect(frame).toContain('line 2');
  });

  it('空 lines 数组渲染空内容', () => {
    const msg = makeMessage({
      uuid: 'msg-3',
      role: 'system',
      lines: [],
    });
    const { lastFrame } = render(<MessageLine msg={msg} cols={80} />);
    // 不崩溃即可
    expect(lastFrame()).toBeDefined();
  });
});
