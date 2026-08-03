// Task 14: Compatibility Corpus 与 Shadow Cutover（A83、A85）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §10 A83/A85、
//          implementation plan Task 14。
//
// 锁定行为：
//   - authority 只允许 legacy | shadow | enforced（计划 Step 3）
//   - resolveAuthority：undefined/空串 -> enforced；显式合法值 trim 后返回；
//     非法值 fail-safe 到 enforced（不静默回到会放行的 legacy）
//   - A83：compatibility corpus 覆盖 build/plan/security 基线行为
//   - A85：shadow 记录 disagreement 但返回 legacy authority；
//     candidate failure 不能改变/broaden legacy 结果
//   - enforced 才允许新链成为 authority
import { describe, test, expect } from 'vitest';
import {
  resolveAuthority,
  evaluateAuthority,
} from '../../permission/cutover.js';
import { PermissionChecker } from '../../permission/checker.js';
import { AUTO_COMPAT_CORPUS } from './fixtures/auto-compat-corpus.js';

// ─── authority resolution ─────────────────────────────────────────────────────

describe('authority default and explicit resolution are deterministic', () => {
  test('undefined -> enforced (production default)', () => {
    expect(resolveAuthority(undefined)).toBe('enforced');
  });

  test('empty string -> enforced', () => {
    expect(resolveAuthority('')).toBe('enforced');
  });

  test('explicit legacy', () => {
    expect(resolveAuthority('legacy')).toBe('legacy');
  });

  test('explicit shadow', () => {
    expect(resolveAuthority('shadow')).toBe('shadow');
  });

  test('explicit enforced', () => {
    expect(resolveAuthority('enforced')).toBe('enforced');
  });

  test('case-sensitive: LEGACY is not valid -> enforced (fail-safe)', () => {
    // 非法显式值 fail-safe 到 enforced，不静默回到会放行的 legacy
    expect(resolveAuthority('LEGACY')).toBe('enforced');
  });

  test('experimental -> enforced (fail-safe)', () => {
    expect(resolveAuthority('experimental')).toBe('enforced');
  });

  test('trimmed enforced', () => {
    expect(resolveAuthority('  enforced  ')).toBe('enforced');
  });

  test('trimmed shadow', () => {
    expect(resolveAuthority('  shadow  ')).toBe('shadow');
  });
});

// ─── A85: shadow records disagreement but returns legacy authority ────────────

describe('[A85] shadow records disagreement but returns legacy authority', () => {
  test('legacy=allow + candidate=deny → authoritative=allow + disagreement recorded', async () => {
    const result = await evaluateAuthority('shadow', {
      legacy: { behavior: 'allow', reason_code: 'test.legacy.allow' },
      candidate: { behavior: 'deny', reason_code: 'test.candidate.deny' },
    });
    expect(result.authoritative.behavior).toBe('allow');
    expect(result.observations).toContainEqual(expect.objectContaining({
      kind: 'permission_disagreement',
      legacy: 'allow',
      candidate: 'deny',
    }));
  });

  test('legacy=deny + candidate=allow → authoritative=deny + disagreement recorded', async () => {
    const result = await evaluateAuthority('shadow', {
      legacy: { behavior: 'deny', reason_code: 'test.legacy.deny' },
      candidate: { behavior: 'allow', reason_code: 'test.candidate.allow' },
    });
    expect(result.authoritative.behavior).toBe('deny');
    expect(result.observations).toContainEqual(expect.objectContaining({
      kind: 'permission_disagreement',
      legacy: 'deny',
      candidate: 'allow',
    }));
  });

  test('legacy and candidate agree → no disagreement observation', async () => {
    const result = await evaluateAuthority('shadow', {
      legacy: { behavior: 'allow', reason_code: 'test' },
      candidate: { behavior: 'allow', reason_code: 'test' },
    });
    expect(result.authoritative.behavior).toBe('allow');
    expect(result.observations.filter((o) => o.kind === 'permission_disagreement')).toHaveLength(0);
  });

  test('candidate failure cannot change or broaden legacy result', async () => {
    const result = await evaluateAuthority('shadow', {
      legacy: { behavior: 'deny', reason_code: 'test.legacy.deny' },
      candidate: Promise.reject(new Error('candidate resolver crashed')),
    });
    expect(result.authoritative.behavior).toBe('deny');
    expect(result.observations).toContainEqual(expect.objectContaining({
      kind: 'candidate_error',
    }));
  });
});

// ─── enforced returns candidate ───────────────────────────────────────────────

describe('enforced returns candidate as authority', () => {
  test('enforced uses candidate decision', async () => {
    const result = await evaluateAuthority('enforced', {
      legacy: { behavior: 'allow', reason_code: 'legacy' },
      candidate: { behavior: 'deny', reason_code: 'candidate' },
    });
    expect(result.authoritative.behavior).toBe('deny');
  });

  test('legacy uses legacy decision (ignores candidate)', async () => {
    const result = await evaluateAuthority('legacy', {
      legacy: { behavior: 'allow', reason_code: 'legacy' },
      candidate: { behavior: 'deny', reason_code: 'candidate' },
    });
    expect(result.authoritative.behavior).toBe('allow');
    // legacy 不求 candidate，不应有 disagreement observation
    expect(result.observations).toHaveLength(0);
  });
});

// ─── A83: compatibility corpus ────────────────────────────────────────────────

describe('[A83] compatibility corpus preserves expected build/plan/security decisions', () => {
  test('every corpus sample matches expected decision', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    for (const sample of AUTO_COMPAT_CORPUS) {
      checker.setMode(sample.mode);
      const decision = checker.check(sample.tool, sample.input);
      expect(decision.behavior, `${sample.id}: expected ${sample.expectedBehavior}`).toBe(sample.expectedBehavior);
    }
  });
});
