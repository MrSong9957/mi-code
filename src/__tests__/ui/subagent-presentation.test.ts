// src/__tests__/ui/subagent-presentation.test.ts
//
// AUTO-0025-transient Task 3:子代理完成展示纯函数测试。
//
// 验证 buildSubagentCompletionPresentation:把 spawn_agent 的 tool input/output/duration
// 转换为单行展示 + 完整输出(供 Ctrl+O)。malformed 输出返回 null(走通用降级)。

import { describe, it, expect } from 'vitest';
import {
  buildSubagentCompletionPresentation,
  buildSubagentExecutionPresentation,
} from '../../ui/subagent-presentation.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import type { Language, Translator } from '../../locale/types.js';
import type { SubagentExecutionResult } from '../../agent/subagent.js';

const translatorFor = (language: Language): Translator => createTranslator(createLanguageStore(language));

describe('buildSubagentCompletionPresentation (AUTO-0025-transient Task 3)', () => {
  it('completed: description 优先,格式 ● Agent "desc" finished · duration', () => {
    expect(buildSubagentCompletionPresentation(
      { description: '查找 AgentTool 实现', prompt: 'long prompt' },
      '[Subagent status=completed]\n完整结果',
      147_000,
      translatorFor('en-US'),
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
      translatorFor('en-US'),
    );
    expect(result?.line).toBe('● Agent "正常任务描述" finished · 5s');
    expect(result?.fullOutput).toBe('结果正文');
  });

  it('incomplete: status 词为 incomplete,附 reason 上下文', () => {
    const result = buildSubagentCompletionPresentation(
      { prompt: '任务' },
      '[Subagent status=incomplete reason=max_turns]\npartial',
      2_000,
      translatorFor('en-US'),
    );
    expect(result?.line).toBe('● Agent "任务" incomplete · 2s');
    expect(result?.fullOutput).toBe('partial');
  });

  it('unverified: status 词为 unverified', () => {
    const result = buildSubagentCompletionPresentation(
      { prompt: '检查' },
      '[Subagent status=unverified]\nno evidence',
      1_000,
      translatorFor('en-US'),
    );
    expect(result?.line).toBe('● Agent "检查" unverified · 1s');
  });

  it('malformed output(无 envelope)返回 null,走通用降级', () => {
    expect(buildSubagentCompletionPresentation(
      { prompt: '正常任务' }, 'malformed output', 1_000, translatorFor('en-US'),
    )).toBeNull();
  });

  it('zh-CN 本地化 status 和 duration 单位,但保留原始 description 与 fullOutput', () => {
    const result = buildSubagentCompletionPresentation(
      { description: 'Deploy Agent / 部署代理', prompt: 'ignored prompt' },
      '[Subagent status=completed]\nraw child output / 原始输出',
      147_000,
      translatorFor('zh-CN'),
    );

    expect(result).toEqual({
      line: '● 子代理 "Deploy Agent / 部署代理" 已完成 · 2 分 27 秒',
      fullOutput: 'raw child output / 原始输出',
    });
  });

  it('en-US 本地化 status 和 duration 单位,但保留原始 description', () => {
    const result = buildSubagentCompletionPresentation(
      { description: '审阅实现' },
      '[Subagent status=incomplete reason=max_turns]\npartial',
      60_000,
      translatorFor('en-US'),
    );

    expect(result?.line).toBe('● Agent "审阅实现" incomplete · 1m');
  });

  it('label 优先级:description > prompt 有意义行 > Agent', () => {
    // 有 description
    expect(buildSubagentCompletionPresentation(
      { description: '描述', prompt: '提示' },
      '[Subagent status=completed]\nx', 1_000, translatorFor('en-US'),
    )?.line).toContain('"描述"');
    // 无 description,有 prompt
    expect(buildSubagentCompletionPresentation(
      { prompt: '提示词' },
      '[Subagent status=completed]\nx', 1_000, translatorFor('en-US'),
    )?.line).toContain('"提示词"');
    // prompt 无意义(纯符号/JSON),回退 Agent
    expect(buildSubagentCompletionPresentation(
      { prompt: '\n!!!\n{"task":"x"}' },
      '[Subagent status=incomplete reason=max_turns]\npartial', 2_000, translatorFor('en-US'),
    )?.line).toBe('● Agent "Agent" incomplete · 2s');
  });

  it('label 回退随语言本地化:zh "代理" / en "Agent"(completion builder,description 与 prompt 均无意义)', () => {
    // zh-CN 回退 "代理"
    expect(buildSubagentCompletionPresentation(
      { prompt: '\n!!!\n{"task":"x"}' },
      '[Subagent status=completed]\npartial', 1_000, translatorFor('zh-CN'),
    )?.line).toBe('● 子代理 "代理" 已完成 · 1 秒');

    // en-US 回退 "Agent"
    expect(buildSubagentCompletionPresentation(
      { prompt: '\n!!!\n{"task":"x"}' },
      '[Subagent status=completed]\npartial', 1_000, translatorFor('en-US'),
    )?.line).toBe('● Agent "Agent" finished · 1s');
  });

  it('duration 负数/NaN 按 0 处理,显示至少 1s', () => {
    expect(buildSubagentCompletionPresentation(
      { prompt: 'x' }, '[Subagent status=completed]\ny', -500, translatorFor('en-US'),
    )?.line).toContain('· 1s');
    expect(buildSubagentCompletionPresentation(
      { prompt: 'x' }, '[Subagent status=completed]\ny', Number.NaN, translatorFor('en-US'),
    )?.line).toContain('· 1s');
  });

  it('fullOutput 是 envelope 剥离后的正文(不含 [Subagent status=...])', () => {
    const result = buildSubagentCompletionPresentation(
      { description: 'd' },
      '[Subagent status=completed]\n第一行\n第二行',
      1_000,
      translatorFor('en-US'),
    );
    expect(result?.fullOutput).toBe('第一行\n第二行');
    expect(result?.fullOutput).not.toContain('[Subagent');
  });

  it('emoji 描述不被损坏', () => {
    const result = buildSubagentCompletionPresentation(
      { description: '🔎 查找实现', prompt: 'p' },
      '[Subagent status=completed]\nout',
      1_000,
      translatorFor('en-US'),
    );
    expect(result?.line).toContain('🔎 查找实现');
  });

  it('中文长描述完整保留(截断由 Ink 处理,纯函数不截断)', () => {
    const longDesc = '这是一个非常长的中文描述用于测试不截断'.repeat(3);
    const result = buildSubagentCompletionPresentation(
      { description: longDesc, prompt: 'p' },
      '[Subagent status=completed]\nout',
      1_000,
      translatorFor('en-US'),
    );
    expect(result?.line).toContain(longDesc);
  });
});

describe('buildSubagentExecutionPresentation locale', () => {
  it('dispatch: zh-CN 本地化 status 和 duration 单位,但保留 raw label', () => {
    const result: SubagentExecutionResult = {
      kind: 'dispatch',
      receipt: {
        protocol_version: '1',
        execution_mode: 'background',
        task_id: 'task-1',
        accepted: true,
      },
    };

    const presentation = buildSubagentExecutionPresentation(
      { description: 'Background Agent Label' },
      result,
      90_000,
      translatorFor('zh-CN'),
    );

    expect(presentation).toEqual({
      line: '● 子代理 "Background Agent Label" 已派发 · 1 分 30 秒',
      fullOutput: '',
    });
  });

  it('completion: en-US 本地化 completed status,但保留 report.summary', () => {
    const result: SubagentExecutionResult = {
      kind: 'completion',
      report: {
        protocol_version: '1',
        subject: { kind: 'subagent', id: 's1' },
        outcome: 'completed',
        termination_reason: 'end_turn',
        execution_mode: 'foreground',
        verification: {
          required_level: 'V2',
          achieved_level: 'V2',
          status: 'passed',
          evidence_refs: ['ref-1'],
          failure_kind: null,
        },
        deliverables: [],
        summary: 'raw summary output',
        remaining_uncertainty: [],
      },
    };

    const presentation = buildSubagentExecutionPresentation(
      { prompt: 'Review branch' },
      result,
      1_000,
      translatorFor('en-US'),
    );

    expect(presentation).toEqual({
      line: '● Agent "Review branch" finished · 1s',
      fullOutput: 'raw summary output',
    });
  });

  it('execution builder label 回退随语言本地化:zh "代理" / en "Agent"(description 与 prompt 均无意义)', () => {
    const completion: SubagentExecutionResult = {
      kind: 'completion',
      report: {
        protocol_version: '1',
        subject: { kind: 'subagent', id: 's1' },
        outcome: 'completed',
        termination_reason: 'end_turn',
        execution_mode: 'foreground',
        verification: {
          required_level: 'V0',
          achieved_level: 'V0',
          status: 'skipped',
          evidence_refs: [],
          failure_kind: null,
        },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      },
    };
    const dispatch: SubagentExecutionResult = {
      kind: 'dispatch',
      receipt: {
        protocol_version: '1',
        execution_mode: 'background',
        task_id: 'task-bg',
        accepted: true,
      },
    };
    const noMeaningful = { prompt: '\n!!!\n{"task":"x"}' };

    // completion builder:zh "代理"
    expect(buildSubagentExecutionPresentation(
      noMeaningful, completion, 1_000, translatorFor('zh-CN'),
    ).line).toBe('● 子代理 "代理" 已完成 · 1 秒');
    // completion builder:en "Agent"
    expect(buildSubagentExecutionPresentation(
      noMeaningful, completion, 1_000, translatorFor('en-US'),
    ).line).toBe('● Agent "Agent" finished · 1s');
    // dispatch builder:zh "代理"
    expect(buildSubagentExecutionPresentation(
      noMeaningful, dispatch, 1_000, translatorFor('zh-CN'),
    ).line).toBe('● 子代理 "代理" 已派发 · 1 秒');
    // dispatch builder:en "Agent"
    expect(buildSubagentExecutionPresentation(
      noMeaningful, dispatch, 1_000, translatorFor('en-US'),
    ).line).toBe('● Agent "Agent" dispatched · 1s');
  });

  it('status-line 类别标签随语言本地化:zh "子代理" / en "Agent"(不再硬编码 Agent)', () => {
    // 用一个明确的 description 作为 label,隔离 status-line 前缀词的断言。
    // status line 模板:`● <statusLineLabel> "<label>" <status> · <duration>`
    // zh:`● 子代理 "..." 已完成 · ...`  en:`● Agent "..." finished · ...`

    // ── completion builder (legacy, regex 解析) ──
    expect(buildSubagentCompletionPresentation(
      { description: '明确标签' },
      '[Subagent status=completed]\n正文',
      5_000,
      translatorFor('zh-CN'),
    )?.line).toBe('● 子代理 "明确标签" 已完成 · 5 秒');
    expect(buildSubagentCompletionPresentation(
      { description: '明确标签' },
      '[Subagent status=completed]\n正文',
      5_000,
      translatorFor('en-US'),
    )?.line).toBe('● Agent "明确标签" finished · 5s');

    // ── execution builder, completion 分支 ──
    const completion: SubagentExecutionResult = {
      kind: 'completion',
      report: {
        protocol_version: '1',
        subject: { kind: 'subagent', id: 's1' },
        outcome: 'completed',
        termination_reason: 'end_turn',
        execution_mode: 'foreground',
        verification: {
          required_level: 'V0',
          achieved_level: 'V0',
          status: 'skipped',
          evidence_refs: [],
          failure_kind: null,
        },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      },
    };
    expect(buildSubagentExecutionPresentation(
      { description: '明确标签' }, completion, 5_000, translatorFor('zh-CN'),
    ).line).toBe('● 子代理 "明确标签" 已完成 · 5 秒');
    expect(buildSubagentExecutionPresentation(
      { description: '明确标签' }, completion, 5_000, translatorFor('en-US'),
    ).line).toBe('● Agent "明确标签" finished · 5s');

    // ── execution builder, dispatch 分支 ──
    const dispatch: SubagentExecutionResult = {
      kind: 'dispatch',
      receipt: {
        protocol_version: '1',
        execution_mode: 'background',
        task_id: 'task-bg',
        accepted: true,
      },
    };
    expect(buildSubagentExecutionPresentation(
      { description: '明确标签' }, dispatch, 5_000, translatorFor('zh-CN'),
    ).line).toBe('● 子代理 "明确标签" 已派发 · 5 秒');
    expect(buildSubagentExecutionPresentation(
      { description: '明确标签' }, dispatch, 5_000, translatorFor('en-US'),
    ).line).toBe('● Agent "明确标签" dispatched · 5s');

    // 关键:zh 状态行不再硬编码 'Agent'(出现 '子代理' 而非紧邻 ● 的 'Agent')
    const zhLine = buildSubagentExecutionPresentation(
      { description: '明确标签' }, completion, 5_000, translatorFor('zh-CN'),
    ).line;
    expect(zhLine.startsWith('● Agent ')).toBe(false);
    expect(zhLine.startsWith('● 子代理 ')).toBe(true);
  });
});
