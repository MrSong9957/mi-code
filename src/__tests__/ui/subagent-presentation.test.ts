// src/__tests__/ui/subagent-presentation.test.ts
//
// AUTO-0025-transient Task 3:子代理完成展示纯函数测试。
//
// 验证 buildSubagentCompletionPresentation:把 spawn_agent 的 tool input/output/duration
// 转换为单行展示 + 完整输出(供 Ctrl+O)。malformed 输出返回 null(走通用降级)。

import { describe, it, expect } from 'vitest';
import { buildSubagentCompletionPresentation } from '../../ui/subagent-presentation.js';

describe('buildSubagentCompletionPresentation (AUTO-0025-transient Task 3)', () => {
  it('completed: description 优先,格式 ● Agent "desc" finished · duration', () => {
    expect(buildSubagentCompletionPresentation(
      { description: '查找 AgentTool 实现', prompt: 'long prompt' },
      '[Subagent status=completed]\n完整结果',
      147_000,
    )).toEqual({
      line: '● Agent "查找 AgentTool 实现" finished · 2m 27s',
      fullOutput: '完整结果',
    });
  });

  it('completed: 无 description 时用 prompt 的有意义首行', () => {
    const result = buildSubagentCompletionPresentation(
      { prompt: '正常任务描述' },
      '[Subagent status=completed]\n结果正文',
      5_000,
    );
    expect(result?.line).toBe('● Agent "正常任务描述" finished · 5s');
    expect(result?.fullOutput).toBe('结果正文');
  });

  it('incomplete: status 词为 incomplete,附 reason 上下文', () => {
    const result = buildSubagentCompletionPresentation(
      { prompt: '任务' },
      '[Subagent status=incomplete reason=max_turns]\npartial',
      2_000,
    );
    expect(result?.line).toBe('● Agent "任务" incomplete · 2s');
    expect(result?.fullOutput).toBe('partial');
  });

  it('unverified: status 词为 unverified', () => {
    const result = buildSubagentCompletionPresentation(
      { prompt: '检查' },
      '[Subagent status=unverified]\nno evidence',
      1_000,
    );
    expect(result?.line).toBe('● Agent "检查" unverified · 1s');
  });

  it('malformed output(无 envelope)返回 null,走通用降级', () => {
    expect(buildSubagentCompletionPresentation(
      { prompt: '正常任务' }, 'malformed output', 1_000,
    )).toBeNull();
  });

  it('label 优先级:description > prompt 有意义行 > Agent', () => {
    // 有 description
    expect(buildSubagentCompletionPresentation(
      { description: '描述', prompt: '提示' },
      '[Subagent status=completed]\nx', 1_000,
    )?.line).toContain('"描述"');
    // 无 description,有 prompt
    expect(buildSubagentCompletionPresentation(
      { prompt: '提示词' },
      '[Subagent status=completed]\nx', 1_000,
    )?.line).toContain('"提示词"');
    // prompt 无意义(纯符号/JSON),回退 Agent
    expect(buildSubagentCompletionPresentation(
      { prompt: '\n!!!\n{"task":"x"}' },
      '[Subagent status=incomplete reason=max_turns]\npartial', 2_000,
    )?.line).toBe('● Agent "Agent" incomplete · 2s');
  });

  it('duration 负数/NaN 按 0 处理,显示至少 1s', () => {
    expect(buildSubagentCompletionPresentation(
      { prompt: 'x' }, '[Subagent status=completed]\ny', -500,
    )?.line).toContain('· 1s');
    expect(buildSubagentCompletionPresentation(
      { prompt: 'x' }, '[Subagent status=completed]\ny', Number.NaN,
    )?.line).toContain('· 1s');
  });

  it('fullOutput 是 envelope 剥离后的正文(不含 [Subagent status=...])', () => {
    const result = buildSubagentCompletionPresentation(
      { description: 'd' },
      '[Subagent status=completed]\n第一行\n第二行',
      1_000,
    );
    expect(result?.fullOutput).toBe('第一行\n第二行');
    expect(result?.fullOutput).not.toContain('[Subagent');
  });

  it('emoji 描述不被损坏', () => {
    const result = buildSubagentCompletionPresentation(
      { description: '🔎 查找实现', prompt: 'p' },
      '[Subagent status=completed]\nout',
      1_000,
    );
    expect(result?.line).toContain('🔎 查找实现');
  });

  it('中文长描述完整保留(截断由 Ink 处理,纯函数不截断)', () => {
    const longDesc = '这是一个非常长的中文描述用于测试不截断'.repeat(3);
    const result = buildSubagentCompletionPresentation(
      { description: longDesc, prompt: 'p' },
      '[Subagent status=completed]\nout',
      1_000,
    );
    expect(result?.line).toContain(longDesc);
  });
});
