// src/__tests__/agent/ask-user-tool-store.test.ts
// AUTO-0025 Phase B (Task 9):ask-user-tool executor 写入 outcome store。
//
// 物理本质:这是 meta 旁路的"生产端"。
// executor 执行 mgr.ask 得到结构化 outcome 后,同时在两个通道写:
// - API 通道(return serializeAskQuestionOutcome 字符串,不变)
// - UI 通道(askOutcomeStore.set,供 streaming-query 阶段3 take)
// 关键:两通道数据同源(outcome),但互不污染。

import { describe, it, expect, beforeEach } from 'vitest';
import { createAskUserTool } from '../../agent/tools/ask-user-tool.js';
import { askOutcomeStore } from '../../agent/ask-outcome-store.js';
import type { AskUserManager } from '../../agent/ask-user-manager.js';
import type { AskQuestionOutcome, AskQuestionRequest } from '../../agent/ask-user-types.js';
import { serializeAskQuestionOutcome } from '../../agent/ask-user-serialization.js';

// Mock manager:ask 返回固定 submitted outcome
const mockManager = {
  ask: async () => ({ kind: 'submitted' as const, answers: { q: 'A' } }),
} as unknown as AskUserManager;

describe('ask-user-tool executor writes store', () => {
  beforeEach(() => askOutcomeStore.clear());

  it('strips Agent-controlled values and keeps StructuredAskResult label-based', async () => {
    let receivedRequest: AskQuestionRequest | null = null;
    const manager = {
      ask: async (request: AskQuestionRequest): Promise<AskQuestionOutcome> => {
        receivedRequest = request;
        return { kind: 'submitted', answers: { q: 'A' } };
      },
    } as unknown as AskUserManager;
    const { executor } = createAskUserTool(manager);
    const requestInput = {
      questions: [{
        header: 'H',
        question: 'q',
        options: [
          { label: 'A', description: 'dA', value: 'permission.reject' },
          { label: 'B', description: 'dB', value: 'permission.allowAlways' },
        ],
        multiSelect: false,
      }],
    };
    const result = await executor(requestInput, { toolUseId: 'tuu-test' });

    // API 通道:仍是 serialize 字符串(不变)
    expect(result).toBe(serializeAskQuestionOutcome({ kind: 'submitted', answers: { q: 'A' } }));

    expect(receivedRequest).toEqual({
      questions: [{
        header: 'H',
        question: 'q',
        options: [
          { label: 'A', description: 'dA' },
          { label: 'B', description: 'dB' },
        ],
        multiSelect: false,
      }],
    });

    // UI 通道:store 写入标签语义的结构化结果,不暴露 Agent 注入的 value。
    const stored = askOutcomeStore.take('tuu-test');
    expect(stored).toEqual({
      version: 1,
      request: receivedRequest,
      outcome: { kind: 'submitted', answers: { q: 'A' } },
    });
  });

  it('executor 不带 ctx 时(legacy)不写 store,但仍返回 serialize', async () => {
    const { executor } = createAskUserTool(mockManager);
    // 用合法 input 但不传 ctx(legacy 签名兼容性验证)
    const result = await executor({
      questions: [{
        header: 'H',
        question: 'q',
        options: [
          { label: 'A', description: 'dA' },
          { label: 'B', description: 'dB' },
        ],
        multiSelect: false,
      }],
    });
    // 无 ctx → 不写 store(理论上不应发生,因 Task 8 已全覆盖调用点,但防御)
    expect(askOutcomeStore.size()).toBe(0);
    // 返回值仍是合法 serialize 字符串
    expect(result).toBe(serializeAskQuestionOutcome({ kind: 'submitted', answers: { q: 'A' } }));
  });
});
