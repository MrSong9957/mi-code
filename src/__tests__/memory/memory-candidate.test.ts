// TypedMemoryCandidate 测试 (CRC-3 / M-043)
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-policy-contracts-wave-c-design.md
//   - §9.6 Typed Auto Memory
//   - §9.7 Memory candidate 不变量 1~7
//   - §9.8 错误语义
//   - §17.3 CRC-3 验收 5/6/7
//
// candidate 只是待评估输入,不是 admitted/stored/selected/used memory (INV-C7)。
// 这里不测 M-044 admission,只测 candidate 构造期的不变量与拒绝条件。

import { describe, it, expect } from 'vitest';
import {
  createTypedMemoryCandidate,
  type CreateTypedMemoryCandidateInput,
  type TypedMemoryCandidate,
  MEMORY_CANDIDATE_PROTOCOL_VERSION,
} from '../../memory/candidates.js';

// 基线合法输入:其它用例在其上覆盖单字段。
const validInput: CreateTypedMemoryCandidateInput = {
  source_context_id: 'ctx-1',
  type: 'user_preference',
  claim: 'prefers tabs over spaces',
  scope_ref: 'workspace-1',
  evidence_refs: ['ev-1'],
  confidence: 0.8,
  observed_at: '2026-07-26T00:00:00Z',
  expires_at: null,
  context_refs: [],
  invalidation_conditions: [],
  sensitivity_labels: [],
  writer_kind: 'auto_memory_writer',
};

describe('createTypedMemoryCandidate — happy path', () => {
  it('creates a valid user_preference candidate', () => {
    const c = createTypedMemoryCandidate(validInput);
    expect(c.type).toBe('user_preference');
    expect(c.memory_candidate_id).toMatch(/^mem:[a-f0-9]{16}$/);
    expect(c.memory_candidate_protocol_version).toBe(MEMORY_CANDIDATE_PROTOCOL_VERSION);
    expect(c.source_context_id).toBe('ctx-1');
    expect(c.claim).toBe('prefers tabs over spaces');
    expect(c.scope_ref).toBe('workspace-1');
    expect(c.evidence_refs).toEqual(['ev-1']);
    expect(c.confidence).toBe(0.8);
    expect(c.observed_at).toBe('2026-07-26T00:00:00Z');
    expect(c.expires_at).toBeNull();
    expect(c.context_refs).toEqual([]);
    expect(c.invalidation_conditions).toEqual([]);
    expect(c.sensitivity_labels).toEqual([]);
  });

  it('supports all four frozen types', () => {
    const types = ['user_preference', 'project_fact', 'workflow_pattern', 'failure_observation'] as const;
    for (const type of types) {
      const input: CreateTypedMemoryCandidateInput = {
        ...validInput,
        type,
        // failure_observation 需要额外字段
        context_refs: type === 'failure_observation' ? ['ctx-a'] : [],
        invalidation_conditions: type === 'failure_observation' ? ['cond-1'] : [],
      };
      const c = createTypedMemoryCandidate(input);
      expect(c.type).toBe(type);
    }
  });

  it('produces a frozen (immutable) candidate', () => {
    const c = createTypedMemoryCandidate(validInput);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.evidence_refs)).toBe(true);
    expect(Object.isFrozen(c.context_refs)).toBe(true);
  });

  it('id is deterministic for identical canonical input', () => {
    const a = createTypedMemoryCandidate(validInput);
    const b = createTypedMemoryCandidate({ ...validInput });
    expect(a.memory_candidate_id).toBe(b.memory_candidate_id);
  });

  it('id changes when claim changes', () => {
    const a = createTypedMemoryCandidate(validInput);
    const b = createTypedMemoryCandidate({ ...validInput, claim: 'prefers spaces over tabs' });
    expect(a.memory_candidate_id).not.toBe(b.memory_candidate_id);
  });
});

describe('createTypedMemoryCandidate — writer authorization', () => {
  it('rejects writer that is not auto_memory_writer', () => {
    expect(() =>
      createTypedMemoryCandidate({ ...validInput, writer_kind: 'memory_manager' }),
    ).toThrow(/writer_not_authorized|writer/i);
  });

  it('rejects empty writer_kind', () => {
    expect(() => createTypedMemoryCandidate({ ...validInput, writer_kind: '' })).toThrow(
      /writer_not_authorized|writer/i,
    );
  });
});

describe('createTypedMemoryCandidate — type validation', () => {
  it('rejects unknown memory type', () => {
    expect(() =>
      createTypedMemoryCandidate({ ...validInput, type: 'random_thought' as never }),
    ).toThrow(/type/i);
  });
});

describe('createTypedMemoryCandidate — claim validation', () => {
  it('rejects empty claim', () => {
    expect(() => createTypedMemoryCandidate({ ...validInput, claim: '' })).toThrow(/claim/i);
  });

  it('rejects whitespace-only claim', () => {
    expect(() => createTypedMemoryCandidate({ ...validInput, claim: '   \t  ' })).toThrow(/claim/i);
  });
});

describe('createTypedMemoryCandidate — confidence validation (INV 1)', () => {
  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid confidence %s',
    (confidence) => {
      expect(() => createTypedMemoryCandidate({ ...validInput, confidence })).toThrow(/confidence/i);
    },
  );

  it('accepts boundary values 0 and 1', () => {
    expect(() => createTypedMemoryCandidate({ ...validInput, confidence: 0 })).not.toThrow();
    expect(() => createTypedMemoryCandidate({ ...validInput, confidence: 1 })).not.toThrow();
  });
});

describe('createTypedMemoryCandidate — evidence validation (INV 2)', () => {
  it('rejects empty evidence_refs', () => {
    expect(() => createTypedMemoryCandidate({ ...validInput, evidence_refs: [] })).toThrow(
      /evidence/i,
    );
  });
});

describe('createTypedMemoryCandidate — sensitive content rejection (INV 5)', () => {
  it.each([
    'the secret is xyz',
    'contains a credential',
    'the API_KEY is xyz',
    'user password was leaked',
    'long-lived token here',
    'api key value',
    'THE SECRET VALUE', // 大小写不敏感
  ])('rejects claim containing sensitive keyword: %s', (claim) => {
    expect(() => createTypedMemoryCandidate({ ...validInput, claim })).toThrow(
      /sensitive|secret|credential|api_key|token|password/i,
    );
  });

  it('rejects when sensitivity_labels themselves contain sensitive keyword', () => {
    // 标签里被显式标 secret 也不形成 candidate:标签不是脱敏出口。
    expect(() =>
      createTypedMemoryCandidate({ ...validInput, sensitivity_labels: ['secret'] }),
    ).toThrow(/sensitive|secret/i);
  });

  it.each([
    'a normal preference about tabs',
    'uses two-space indentation',
    'project uses vitest', // 'uses' 不应误命中
    'tokenized streaming is preferred', // 'tokenized' 含 'token' 子串 — 规格要求关键词检测,
                                        // 这里希望 tokenized 不被误判,验证是否为整词匹配
  ])('does not over-block benign claim: %s', (claim) => {
    // 注意:若实现采用子串匹配,'tokenized' 会被误判。这里记录期望行为。
    // 当前实现采用单词边界匹配以减少误判。
    expect(() => createTypedMemoryCandidate({ ...validInput, claim })).not.toThrow();
  });
});

describe('createTypedMemoryCandidate — raw tool dump rejection (INV 5)', () => {
  it('rejects claim starting with [Tool', () => {
    expect(() =>
      createTypedMemoryCandidate({ ...validInput, claim: '[Tool result: ...]' }),
    ).toThrow(/tool|dump/i);
  });

  it('rejects claim containing tool_result code fence', () => {
    expect(() =>
      createTypedMemoryCandidate({
        ...validInput,
        claim: 'something\n```tool_result\n{ "stdout": "..." }\n```',
      }),
    ).toThrow(/tool|dump/i);
  });
});

describe('createTypedMemoryCandidate — failure_observation requirements (INV 3)', () => {
  it('rejects failure_observation without context_refs', () => {
    expect(() =>
      createTypedMemoryCandidate({
        ...validInput,
        type: 'failure_observation',
        context_refs: [],
        invalidation_conditions: ['cond-1'],
      }),
    ).toThrow(/failure_observation.*context|context/i);
  });

  it('rejects failure_observation without invalidation_conditions', () => {
    expect(() =>
      createTypedMemoryCandidate({
        ...validInput,
        type: 'failure_observation',
        context_refs: ['ctx-a'],
        invalidation_conditions: [],
      }),
    ).toThrow(/failure_observation.*invalidation|invalidation/i);
  });

  it('rejects failure_observation missing both context and invalidation', () => {
    expect(() =>
      createTypedMemoryCandidate({
        ...validInput,
        type: 'failure_observation',
        context_refs: [],
        invalidation_conditions: [],
      }),
    ).toThrow(/failure_observation/i);
  });

  it('accepts failure_observation with context and invalidation on completed turn', () => {
    expect(() =>
      createTypedMemoryCandidate({
        ...validInput,
        type: 'failure_observation',
        context_refs: ['ctx-a'],
        invalidation_conditions: ['cond-1'],
        turn_outcome: 'completed',
      }),
    ).not.toThrow();
  });
});

describe('createTypedMemoryCandidate — cancelled turn rejection (INV 4)', () => {
  it('rejects failure_observation on cancelled turn', () => {
    expect(() =>
      createTypedMemoryCandidate({
        ...validInput,
        type: 'failure_observation',
        context_refs: ['ctx-a'],
        invalidation_conditions: ['cond-1'],
        turn_outcome: 'cancelled',
      }),
    ).toThrow(/cancelled/i);
  });

  it('allows non-failure types on cancelled turn', () => {
    expect(() =>
      createTypedMemoryCandidate({ ...validInput, type: 'user_preference', turn_outcome: 'cancelled' }),
    ).not.toThrow();
  });
});

describe('createTypedMemoryCandidate — INV-C7 no mutation methods', () => {
  // candidate 不具有 store/merge/delete/admit 方法 —— 它不是 admitted/stored/selected/used memory。
  it('does not expose store/merge/delete/admit methods', () => {
    const c = createTypedMemoryCandidate(validInput);
    expect(c).not.toHaveProperty('store');
    expect(c).not.toHaveProperty('merge');
    expect(c).not.toHaveProperty('delete');
    expect(c).not.toHaveProperty('admit');
  });

  it('TypedMemoryCandidate type carries no method signatures', () => {
    // 类型层面保证:candidate 只有数据字段。运行期再验证一次。
    const c: TypedMemoryCandidate = createTypedMemoryCandidate(validInput);
    const keys = Object.keys(c).sort();
    expect(keys).toEqual(
      [
        'confidence',
        'context_refs',
        'evidence_refs',
        'expires_at',
        'invalidation_conditions',
        'memory_candidate_id',
        'memory_candidate_protocol_version',
        'observed_at',
        'scope_ref',
        'sensitivity_labels',
        'source_context_id',
        'type',
        'claim',
      ].sort(),
    );
  });
});
