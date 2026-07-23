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

  // AUTO-0025 Phase B review 修正:agent-completion 多行场景必须渲染所有行。
  // 历史 bug:MessageLine 对 agent-completion kind 硬编码单行渲染(只取 lines[0]),
  // 为 spawn_agent 的 ● Agent "..." finished · Ns 设计。但 ask_user_question 复用该 kind
  // 且含父标题+子项多行,被截断丢失子项。修复:单行保持 truncate,多行走默认多行渲染。
  describe('agent-completion kind 渲染', () => {
    it('单行(spawn_agent):保持 truncate 单行渲染', () => {
      const msg = makeMessage({
        uuid: 'msg-spawn',
        role: 'tool',
        kind: 'agent-completion',
        lines: [{ content: '● Agent "查找" finished · 5s', style: {}, indent: 0 }],
      });
      const { lastFrame } = render(<MessageLine msg={msg} cols={80} />);
      expect(lastFrame()).toContain('Agent "查找" finished');
    });

    it('多行(ask_user_question):渲染父标题 + 所有子项', () => {
      const msg = makeMessage({
        uuid: 'msg-ask',
        role: 'tool',
        kind: 'agent-completion',
        lines: [
          { content: '● Answered 2 questions', style: {}, indent: 0 },
          { content: '⎿  日志库 → winston', style: {}, indent: 2, raw: true },
          { content: '⎿  日志级别 → debug', style: {}, indent: 2, raw: true },
        ],
      });
      const { lastFrame } = render(<MessageLine msg={msg} cols={80} />);
      const frame = lastFrame() ?? '';
      // 父标题
      expect(frame).toContain('Answered 2 questions');
      // 子项必须渲染(当前 bug:只有父标题,子项丢失)
      expect(frame).toContain('日志库 → winston');
      expect(frame).toContain('日志级别 → debug');
    });
  });

  // PR2 review:assistant 多段文本续行必须有 2 空格缩进(非顶格)。
  // 根因:renderFinalizedLine 非溢出分支不按 \n 拆分续行,直接单行输出导致续行顶格。
  describe('assistant 续行缩进', () => {
    it('多段文本:首行 ● 前缀,续行 2 空格缩进(非顶格)', () => {
      const msg = makeMessage({
        uuid: 'msg-cont',
        role: 'assistant',
        lines: [{ content: '● 第一行内容\n第二行内容', style: {}, indent: 0 }],
      });
      const { lastFrame } = render(<MessageLine msg={msg} cols={80} />);
      const frame = lastFrame() ?? '';
      // 首行带 ● 前缀
      expect(frame).toContain('● 第一行内容');
      // 续行必须 2 空格缩进(不是顶格)。检查"第二行内容"前有 2 空格。
      // frame 含 \n 分隔的行,续行应是 "  第二行内容"
      expect(frame).toContain('  第二行内容');
      // 禁止:续行顶格(无缩进)。"第二行内容" 前不应是行首(无前导空格)
      const lines = frame.split('\n');
      const contLine = lines.find(l => l.includes('第二行内容'));
      expect(contLine).toBeDefined();
      expect(contLine!.startsWith('  ')).toBe(true);
    });
  });
});
