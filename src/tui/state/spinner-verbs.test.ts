// spinner 动词词库测试
//
// 对标 Claude Code 的 SPINNER_VERBS（204 个 -ing 动词，均匀随机选一个做 spinner 文字）。
// 本项目精选词库（不追求全量 204，保证词感和 -ing 形式）。

import { describe, it, expect } from 'vitest';
import { SPINNER_VERBS, sampleVerb, getSpinnerVerbs } from './spinner-verbs.js';

describe('SPINNER_VERBS 词库', () => {
  it('非空且有足够多的词（至少 20）', () => {
    expect(SPINNER_VERBS.length).toBeGreaterThanOrEqual(20);
  });

  it('全部是 -ing 形式（现在进行时）', () => {
    for (const v of SPINNER_VERBS) {
      expect(v.endsWith('ing')).toBe(true);
    }
  });

  it('无重复', () => {
    const set = new Set(SPINNER_VERBS);
    expect(set.size).toBe(SPINNER_VERBS.length);
  });

  it('首字母大写（spinner 展示用）', () => {
    for (const v of SPINNER_VERBS) {
      expect(v[0]).toMatch(/[A-Z]/);
    }
  });
});

describe('sampleVerb：均匀随机选词', () => {
  it('返回值在词库内', () => {
    for (let i = 0; i < 50; i++) {
      const v = sampleVerb();
      expect(SPINNER_VERBS).toContain(v);
    }
  });

  it('多次调用能命中不同词（验证非恒定返回）', () => {
    const samples = new Set<string>();
    for (let i = 0; i < 100; i++) samples.add(sampleVerb());
    // 100 次抽样至少命中 5 个不同词（词库 ≥20，概率上必然）
    expect(samples.size).toBeGreaterThanOrEqual(5);
  });
});

describe('getSpinnerVerbs：词库访问（预留 settings 覆盖钩子）', () => {
  it('默认返回内置词库的副本', () => {
    const verbs = getSpinnerVerbs();
    expect(verbs).toEqual([...SPINNER_VERBS]);
    // 副本：修改不影响原库
    verbs.push('Hacking');
    expect(SPINNER_VERBS).not.toContain('Hacking');
  });
});
