// src/__tests__/subagent-explicit-delegation.test.ts
//
// AUTO-0025 Task 5:显式子代理委派的结构化 status 契约测试。
//
// 物理本质:验证 spawn_agent 工具输出的"工单状态戳"格式,让主 agent 能可靠区分
// 子代理成功/失败,从而在用户显式要求子代理时不静默 fallback。
//
// 设计决策:不写完整的 main-agent E2E 测试来验证"主 agent 拿到 status=incomplete 后
// 不调用自己的 read_file"。原因:那是 prompt 层面的软约束(主 system prompt 里有规则文本),
// LLM 是否遵守取决于模型对指令的遵循度,用 scripted mock 测只是在测 mock 行为,
// 不是测真实 LLM 行为。真实行为在 Task 6 手动验证里确认。
// 这里只锁定"status 戳可被主 agent 解析"的硬契约。

import { describe, it, expect } from 'vitest';
import { formatSubagentResult } from '../agent/tools/spawn-agent-tool.js';
import type { SubagentResult } from '../agent/subagent.js';

function makeResult(overrides: Partial<SubagentResult>): SubagentResult {
  return {
    text: '',
    isBackground: false,
    status: 'completed',
    terminationReason: 'end_turn',
    evidence: { toolCallCount: 0, successfulToolResultCount: 0 },
    ...overrides,
  };
}

describe('formatSubagentResult status 契约 (AUTO-0025 Task 5)', () => {
  it('completed: 前缀含 status=completed,无 reason', () => {
    const out = formatSubagentResult(makeResult({
      status: 'completed',
      text: 'found 3 skills',
      terminationReason: 'end_turn',
    }));
    expect(out).toContain('[Subagent status=completed]');
    expect(out).not.toContain('reason=');
    expect(out).toContain('found 3 skills');
  });

  it('incomplete: 前缀含 status=incomplete + reason=max_turns', () => {
    const out = formatSubagentResult(makeResult({
      status: 'incomplete',
      text: 'partial findings',
      terminationReason: 'max_turns',
    }));
    expect(out).toContain('[Subagent status=incomplete reason=max_turns]');
    expect(out).toContain('partial findings');
  });

  it('incomplete: reason 映射到 user_abort', () => {
    const out = formatSubagentResult(makeResult({
      status: 'incomplete',
      text: 'aborted',
      terminationReason: 'user_abort',
    }));
    expect(out).toContain('[Subagent status=incomplete reason=user_abort]');
  });

  it('unverified: 前缀含 status=unverified,无 reason(诊断价值低)', () => {
    const out = formatSubagentResult(makeResult({
      status: 'unverified',
      text: 'no evidence',
      terminationReason: 'end_turn',
    }));
    expect(out).toContain('[Subagent status=unverified]');
    expect(out).not.toContain('reason=');
  });

  it('background: 不加 status 戳(非最终结果)', () => {
    const out = formatSubagentResult(makeResult({
      status: 'background',
      text: '[Subagent launched in background]',
      terminationReason: 'background',
    }));
    expect(out).not.toContain('[Subagent status=');
    expect(out).toContain('[Subagent launched in background]');
  });

  it('status 戳在首行,summary 在后续行(便于主 agent 解析)', () => {
    const out = formatSubagentResult(makeResult({
      status: 'completed',
      text: 'line1\nline2',
    }));
    const lines = out.split('\n');
    expect(lines[0]).toBe('[Subagent status=completed]');
    expect(lines[1]).toBe('line1');
    expect(lines[2]).toBe('line2');
  });
});
