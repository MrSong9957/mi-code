// src/__tests__/tui/inline-v2/read-grouping.test.ts
// Read 聚合显示适配器:连续 read_file tool message 在渲染时合并成一个 block
//
// 物理本质:display adapter,不改 message 数据,只改渲染前的 items 分组。
// 解决问题:连续多个 Read 各占一个 ● 块,占用垂直空间。
//
// 约束(Static append-only):
//   <Static> 已渲染的 item 不可变,聚合必须基于"已 finalized 的连续段",
//   段被非 Read 打断时锁定。这是显示层回溯合并,不涉及 pending/生命周期。

import { describe, it, expect } from 'vitest';
import type { TuiMessage } from '../../../tui/types.js';
import { groupConsecutiveReadMessages } from '../../../tui/inline-v2/InlineAppV2.js';

/** 构造 finalized read_file tool message 的辅助。 */
function readMsg(uuid: string, path: string, entries: string[]): TuiMessage {
  const resultLines = entries.map((e, i) => ({
    content: i === 0 ? `⎿  ${e}` : `   ${e}`,
    style: { dim: true },
    indent: 2,
    raw: true,
  }));
  return {
    uuid,
    role: 'tool',
    kind: 'tool-progress',
    toolUseId: `tu-${uuid}`,
    lines: [
      { content: `● Read(${path})`, style: { fg: 'brand' }, indent: 0 },
      ...resultLines,
    ],
    finalized: true,
  };
}

/** 构造 finalized assistant message。 */
function assistantMsg(uuid: string, text: string): TuiMessage {
  return {
    uuid,
    role: 'assistant',
    lines: [{ content: `● ${text}`, style: { fg: 'brand' }, indent: 0 }],
    finalized: true,
  };
}

/** 构造 finalized 非 Read 工具 message(Bash 等)。 */
function bashMsg(uuid: string, cmd: string): TuiMessage {
  return {
    uuid,
    role: 'tool',
    kind: 'tool-progress',
    toolUseId: `tu-${uuid}`,
    lines: [
      { content: `● Bash(${cmd})`, style: { fg: 'brand' }, indent: 0 },
      { content: '⎿  done', style: { dim: true }, indent: 2, raw: true },
    ],
    finalized: true,
  };
}

/** 构造 finalized thinking_summary message(role=system,与修复后真实结构一致)。 */
function thinkingMsg(uuid: string, sec = 1): TuiMessage {
  return {
    uuid,
    role: 'system',
    lines: [{ content: `  Thought for ${sec}s (ctrl+o to expand)`, style: { dim: true }, indent: 2 }],
    finalized: true,
  };
}

describe('groupConsecutiveReadMessages', () => {
  it('空数组 → 空结果', () => {
    expect(groupConsecutiveReadMessages([])).toEqual([]);
  });

  it('单个 Read → 不聚合,原样保留为 message item', () => {
    const m = readMsg('msg-1', 'src', ['agent/', 'tools/']);
    const result = groupConsecutiveReadMessages([m]);
    expect(result).toEqual([{ kind: 'message', msg: m }]);
    // 不应出现 read-group
    expect(result.some(r => r.kind === 'read-group')).toBe(false);
  });

  it('连续 2 个 Read → 聚合成一个 read-group', () => {
    const m1 = readMsg('msg-1', 'src', ['agent/', 'tools/']);
    const m2 = readMsg('msg-2', 'src/agent', ['scheduler/']);
    const result = groupConsecutiveReadMessages([m1, m2]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'read-group', msgs: [m1, m2] });
  });

  it('连续 3 个 Read → 聚合成一个 read-group(验收主场景)', () => {
    const m1 = readMsg('msg-1', 'src', ['agent/']);
    const m2 = readMsg('msg-2', 'src/agent', ['scheduler/']);
    const m3 = readMsg('msg-3', 'src/utils', ['a.ts']);
    const result = groupConsecutiveReadMessages([m1, m2, m3]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'read-group', msgs: [m1, m2, m3] });
  });

  it('非 Read 工具(Bash)打断连续 Read → 分段聚合', () => {
    const r1 = readMsg('msg-1', 'a', ['x']);
    const bash = bashMsg('msg-2', 'ls');
    const r2 = readMsg('msg-3', 'b', ['y']);
    const result = groupConsecutiveReadMessages([r1, bash, r2]);
    // 三段:两个独立 Read(各 1 个不聚合)+ Bash
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: 'message', msg: r1 });
    expect(result[1]).toEqual({ kind: 'message', msg: bash });
    expect(result[2]).toEqual({ kind: 'message', msg: r2 });
  });

  it('assistant 文本打断连续 Read → 分段', () => {
    const r1 = readMsg('msg-1', 'a', ['x']);
    const a1 = assistantMsg('msg-2', '回复');
    const r2 = readMsg('msg-3', 'b', ['y']);
    const result = groupConsecutiveReadMessages([r1, a1, r2]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: 'message', msg: r1 });
    expect(result[1]).toEqual({ kind: 'message', msg: a1 });
    expect(result[2]).toEqual({ kind: 'message', msg: r2 });
  });

  it('混合序列:Read 段 + Bash + Read 段 + assistant', () => {
    const r1 = readMsg('msg-1', 'a', ['x']);
    const r2 = readMsg('msg-2', 'b', ['y']);
    const bash = bashMsg('msg-3', 'pwd');
    const r3 = readMsg('msg-4', 'c', ['z']);
    const r4 = readMsg('msg-5', 'd', ['w']);
    const a1 = assistantMsg('msg-6', '完成');
    const result = groupConsecutiveReadMessages([r1, r2, bash, r3, r4, a1]);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ kind: 'read-group', msgs: [r1, r2] });
    expect(result[1]).toEqual({ kind: 'message', msg: bash });
    expect(result[2]).toEqual({ kind: 'read-group', msgs: [r3, r4] });
    expect(result[3]).toEqual({ kind: 'message', msg: a1 });
  });

  it('role !== tool 的 message(即使 content 像 Read)不参与聚合', () => {
    // 假设 system message 碰巧以 ● Read( 开头(不应发生,但防御)
    const fake: TuiMessage = {
      uuid: 'msg-1',
      role: 'system',
      lines: [{ content: '● Read(weird)', style: {}, indent: 0 }],
      finalized: true,
    };
    const real = readMsg('msg-2', 'src', ['x']);
    const result = groupConsecutiveReadMessages([fake, real]);
    // fake 不参与聚合(role 不是 tool),real 单独
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kind: 'message', msg: fake });
    expect(result[1]).toEqual({ kind: 'message', msg: real });
  });

  // ── thinking_summary 不打断聚合(AUTO-0025 真实时序适配)──
  // 模型每次工具调用前会 thinking,产生 role=system 的 thinking_summary。
  // 它是工具调用的伴随状态,不属于"用户内容流",不应阻止同批 Read 聚合。
  // 但 thinking_summary 本身保留显示(不合并进 read-group,不丢弃)。

  it('Read → Thinking → Read → Thinking → Read:thinking_summary 不打断,3 Read 聚合', () => {
    const t1 = thinkingMsg('msg-1');
    const r1 = readMsg('msg-2', 'src', ['a']);
    const t2 = thinkingMsg('msg-3');
    const r2 = readMsg('msg-4', 'src/agent', ['b']);
    const t3 = thinkingMsg('msg-5');
    const r3 = readMsg('msg-6', 'src/ui', ['c']);
    const result = groupConsecutiveReadMessages([t1, r1, t2, r2, t3, r3]);

    // 3 个 Read 聚合成一个 read-group
    const group = result.find(r => r.kind === 'read-group');
    expect(group).toBeDefined();
    expect(group!.kind === 'read-group' && group.msgs).toEqual([r1, r2, r3]);

    // 所有 thinking_summary 都保留为独立 message item(不丢弃)
    const thoughts = result.filter(r => r.kind === 'message');
    expect(thoughts).toHaveLength(3);
    expect(thoughts.every(r => r.kind === 'message' && r.msg.role === 'system')).toBe(true);
  });

  it('Read → Thinking → Bash → Read:Bash 打断,形成两个独立 Read(各不聚合)', () => {
    const r1 = readMsg('msg-1', 'a', ['x']);
    const t1 = thinkingMsg('msg-2');
    const bash = bashMsg('msg-3', 'ls');
    const t2 = thinkingMsg('msg-4');
    const r2 = readMsg('msg-5', 'b', ['y']);
    const result = groupConsecutiveReadMessages([r1, t1, bash, t2, r2]);

    // Bash 打断:两侧 Read 各只 1 个,不满足 ≥2,保持原样
    expect(result.some(r => r.kind === 'read-group')).toBe(false);
    // r1 和 r2 都是独立 message
    const readItems = result.filter(r => r.kind === 'message' && r.msg.lines[0]?.content.startsWith('● Read('));
    expect(readItems).toHaveLength(2);
    // thinking 保留
    const thoughts = result.filter(r => r.kind === 'message' && r.msg.role === 'system');
    expect(thoughts).toHaveLength(2);
  });

  it('Read → Assistant → Read:assistant 打断,两个独立 Read', () => {
    const r1 = readMsg('msg-1', 'a', ['x']);
    const a1 = assistantMsg('msg-2', '回复');
    const r2 = readMsg('msg-3', 'b', ['y']);
    const result = groupConsecutiveReadMessages([r1, a1, r2]);

    expect(result.some(r => r.kind === 'read-group')).toBe(false);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: 'message', msg: r1 });
    expect(result[1]).toEqual({ kind: 'message', msg: a1 });
    expect(result[2]).toEqual({ kind: 'message', msg: r2 });
  });
});
