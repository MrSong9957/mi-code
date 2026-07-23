// src/__tests__/agent/ask-outcome-store.test.ts
// AUTO-0025 Phase B (Task 6):askOutcomeStore 三级清理(take 删 + finally sweep + TTL 5min)。
//
// 物理本质:ask_user_question 的结构化 outcome 是"双通道分叉点",
// executor 暂存到此处,streaming-query 阶段3 take 后消费。
// 关键不变量:turn 结束后 store 必须为空(无 orphan),否则内存泄漏。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { askOutcomeStore } from '../../agent/ask-outcome-store.js';
import type { StructuredAskResult } from '../../agent/ask-user-types.js';

describe('askOutcomeStore', () => {
  beforeEach(() => askOutcomeStore.clear());

  const makeResult = (header: string): StructuredAskResult => ({
    version: 1,
    request: { questions: [{ header, question: 'q', options: [], multiSelect: false }] },
    outcome: { kind: 'submitted', answers: { q: header } },
  });

  it('set + take:一次性消费', () => {
    askOutcomeStore.set('idA', makeResult('A'));
    expect(askOutcomeStore.take('idA')?.outcome.answers.q).toBe('A');
    expect(askOutcomeStore.take('idA')).toBeUndefined(); // 已消费
  });

  it('并发隔离:set(A)/set(B)/take(A)=>A/take(B)=>B', () => {
    askOutcomeStore.set('idA', makeResult('A'));
    askOutcomeStore.set('idB', makeResult('B'));
    expect(askOutcomeStore.take('idA')?.outcome.answers.q).toBe('A');
    expect(askOutcomeStore.take('idB')?.outcome.answers.q).toBe('B');
  });

  it('sweep:删除超 TTL 的 entry', () => {
    vi.useFakeTimers();
    askOutcomeStore.set('old', makeResult('old'));
    vi.advanceTimersByTime(6 * 60 * 1000); // 6min > TTL 5min
    askOutcomeStore.sweep();
    expect(askOutcomeStore.take('old')).toBeUndefined();
    vi.useRealTimers();
  });

  it('sweep:保留未过期的 entry', () => {
    vi.useFakeTimers();
    askOutcomeStore.set('fresh', makeResult('fresh'));
    vi.advanceTimersByTime(2 * 60 * 1000); // 2min < TTL
    askOutcomeStore.sweep();
    expect(askOutcomeStore.take('fresh')?.outcome.answers.q).toBe('fresh');
    vi.useRealTimers();
  });

  it('clear:全清', () => {
    askOutcomeStore.set('x', makeResult('x'));
    askOutcomeStore.clear();
    expect(askOutcomeStore.take('x')).toBeUndefined();
  });

  it('size:反映 entry 数量(供 turn 结束后无残留验证)', () => {
    expect(askOutcomeStore.size()).toBe(0);
    askOutcomeStore.set('a', makeResult('a'));
    askOutcomeStore.set('b', makeResult('b'));
    expect(askOutcomeStore.size()).toBe(2);
    askOutcomeStore.take('a');
    expect(askOutcomeStore.size()).toBe(1);
    askOutcomeStore.take('b');
    // 模拟 turn 结束:全部消费后 store 应空(防内存泄漏的核心断言)
    expect(askOutcomeStore.size()).toBe(0);
  });
});
