// src/__tests__/agent/prompt-compiler.test.ts
// Wave B Task 1 — BRC-1 Prompt Compilation.
//
// 物理本质:compilePromptSnapshot 把"上游已选择、已批准、已确定顺序"的
// PromptSectionInput[] 组装成不可变 CompiledPromptSnapshot。
// 这里覆盖 spec §7.4 的所有 builder 规则,以及对应的错误语义。
//
// 注意:BRC-1 只负责结构化组装,不负责 precedence(M-002)、conditions(M-004)
// 或 cache scope(M-003) —— 那些属于 Wave C,本测试不涉及。

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compilePromptSnapshot,
  type PromptAssetApprovalLookup,
  type PromptSectionInput,
} from '../../agent/prompt/compiler.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** 构造一个最小合法 section,便于各 case 局部覆盖。 */
function makeSection(overrides: Partial<PromptSectionInput> = {}): PromptSectionInput {
  return {
    section_id: 'section',
    asset_ref: { asset_id: 'asset', asset_version: '1' },
    placement: 'system_static',
    authority: 'system',
    trust: 'trusted',
    retention: 'session',
    ordinal: 10,
    content: 'hello',
    content_hash: hash('hello'),
    provenance_refs: ['asset:asset@1'],
    ...overrides,
  };
}

const approveAll: PromptAssetApprovalLookup = { isApproved: () => true };

const baseInput = {
  compiler_protocol_version: '1',
  registry_snapshot_id: 'registry-1',
  request_snapshot_id: 'request-1',
};

describe('compilePromptSnapshot (BRC-1)', () => {
  it('sorts sections by ordinal and produces an immutable aggregate hash', () => {
    const snapshot = compilePromptSnapshot(
      {
        ...baseInput,
        sections: [
          {
            section_id: 'dynamic',
            asset_ref: { asset_id: 'dynamic', asset_version: '1' },
            placement: 'system_dynamic',
            authority: 'environment',
            trust: 'trusted',
            retention: 'turn',
            ordinal: 20,
            content: 'dynamic',
            content_hash: hash('dynamic'),
            provenance_refs: ['source:environment'],
          },
          {
            section_id: 'base',
            asset_ref: { asset_id: 'base', asset_version: '1' },
            placement: 'system_static',
            authority: 'system',
            trust: 'trusted',
            retention: 'session',
            ordinal: 10,
            content: 'base',
            content_hash: hash('base'),
            provenance_refs: ['asset:base@1'],
          },
        ],
      },
      approveAll,
    );

    expect(snapshot.section_order).toEqual(['base', 'dynamic']);
    expect(snapshot.aggregate_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(snapshot.sections)).toBe(true);
  });

  it('rejects duplicate section_id (mentions section_id or duplicate)', () => {
    expect(() =>
      compilePromptSnapshot(
        {
          ...baseInput,
          sections: [
            makeSection({ section_id: 'dup', ordinal: 1 }),
            makeSection({ section_id: 'dup', ordinal: 2 }),
          ],
        },
        approveAll,
      ),
    ).toThrow(/section_id|duplicate/i);
  });

  it('rejects duplicate ordinal (mentions ordinal or duplicate)', () => {
    expect(() =>
      compilePromptSnapshot(
        {
          ...baseInput,
          sections: [
            makeSection({ section_id: 'a', ordinal: 5 }),
            makeSection({ section_id: 'b', ordinal: 5 }),
          ],
        },
        approveAll,
      ),
    ).toThrow(/ordinal|duplicate/i);
  });

  it('rejects candidate asset when lookup returns false (mentions approved or asset)', () => {
    expect(() =>
      compilePromptSnapshot(
        {
          ...baseInput,
          sections: [makeSection()],
        },
        { isApproved: () => false },
      ),
    ).toThrow(/approved|asset/i);
  });

  it('rejects content_hash mismatch (mentions hash or content)', () => {
    expect(() =>
      compilePromptSnapshot(
        {
          ...baseInput,
          sections: [
            makeSection({ content_hash: hash('this-is-not-the-real-content') }),
          ],
        },
        approveAll,
      ),
    ).toThrow(/hash|content/i);
  });

  it("rejects placement 'meta_context' smuggled in (mentions placement)", () => {
    expect(() =>
      compilePromptSnapshot(
        {
          ...baseInput,
          sections: [
            makeSection({
              placement: 'meta_context' as PromptSectionInput['placement'],
            }),
          ],
        },
        approveAll,
      ),
    ).toThrow(/placement/i);
  });

  it("rejects placement 'conversation' smuggled in (mentions placement)", () => {
    expect(() =>
      compilePromptSnapshot(
        {
          ...baseInput,
          sections: [
            makeSection({
              placement: 'conversation' as PromptSectionInput['placement'],
            }),
          ],
        },
        approveAll,
      ),
    ).toThrow(/placement/i);
  });

  it("rejects empty section content (mentions empty or content)", () => {
    expect(() =>
      compilePromptSnapshot(
        {
          ...baseInput,
          sections: [makeSection({ content: '', content_hash: hash('') })],
        },
        approveAll,
      ),
    ).toThrow(/empty|content/i);
  });

  it('does not mutate the captured snapshot when caller mutates the original input array', () => {
    const original = [
      makeSection({ section_id: 'a', ordinal: 1 }),
      makeSection({ section_id: 'b', ordinal: 2 }),
    ];
    const snapshot = compilePromptSnapshot(
      { ...baseInput, sections: original },
      approveAll,
    );
    // After build, the caller pushes a new section into the original input array.
    original.push(makeSection({ section_id: 'c', ordinal: 3 }));
    // The already-captured snapshot must be unaffected.
    expect(snapshot.sections.length).toBe(2);
    expect(snapshot.section_order).toEqual(['a', 'b']);
  });

  it('produces identical aggregate_hash and compiled_prompt_snapshot_id for inputs in different source order', () => {
    const a = makeSection({ section_id: 'a', ordinal: 1, content: 'A', content_hash: hash('A') });
    const b = makeSection({ section_id: 'b', ordinal: 2, content: 'B', content_hash: hash('B') });
    const snap1 = compilePromptSnapshot({ ...baseInput, sections: [a, b] }, approveAll);
    const snap2 = compilePromptSnapshot({ ...baseInput, sections: [b, a] }, approveAll);
    expect(snap1.aggregate_hash).toBe(snap2.aggregate_hash);
    expect(snap1.compiled_prompt_snapshot_id).toBe(snap2.compiled_prompt_snapshot_id);
  });

  it('throws when compiler_protocol_version is empty (requireIdentity)', () => {
    expect(() =>
      compilePromptSnapshot(
        { ...baseInput, compiler_protocol_version: '', sections: [makeSection()] },
        approveAll,
      ),
    ).toThrow();
  });

  it('throws when registry_snapshot_id is empty (requireIdentity)', () => {
    expect(() =>
      compilePromptSnapshot(
        { ...baseInput, registry_snapshot_id: '', sections: [makeSection()] },
        approveAll,
      ),
    ).toThrow();
  });

  it('throws when request_snapshot_id is empty (requireIdentity)', () => {
    expect(() =>
      compilePromptSnapshot(
        { ...baseInput, request_snapshot_id: '', sections: [makeSection()] },
        approveAll,
      ),
    ).toThrow();
  });

  it('deeply freezes the output (snapshot, sections, each section, section_order)', () => {
    const snapshot = compilePromptSnapshot(
      { ...baseInput, sections: [makeSection()] },
      approveAll,
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sections)).toBe(true);
    expect(Object.isFrozen(snapshot.sections[0])).toBe(true);
    expect(Object.isFrozen(snapshot.section_order)).toBe(true);
  });

  it("derives compiled_prompt_snapshot_id from aggregate_hash (starts with 'compiled:')", () => {
    const snapshot = compilePromptSnapshot(
      { ...baseInput, sections: [makeSection()] },
      approveAll,
    );
    expect(snapshot.compiled_prompt_snapshot_id).toBe(
      `compiled:${snapshot.aggregate_hash}`,
    );
  });

  it('rejects the whole compile when lookup returns false for one section while others are approved (no partial compile)', () => {
    const alwaysApprove: PromptAssetApprovalLookup = { isApproved: () => true };
    expect(() =>
      compilePromptSnapshot(
        {
          ...baseInput,
          sections: [
            makeSection({ section_id: 'ok', ordinal: 1, asset_ref: { asset_id: 'ok', asset_version: '1' } }),
            makeSection({ section_id: 'bad', ordinal: 2, asset_ref: { asset_id: 'bad', asset_version: '1' } }),
          ],
        },
        {
          isApproved: (ref) => ref.asset_id !== 'bad',
        },
      ),
    ).toThrow(/approved|asset/i);
    // alwaysApprove used only to make the intent explicit; reference to avoid unused warning
    expect(alwaysApprove.isApproved({ asset_id: 'x', asset_version: '1' })).toBe(true);
  });

  it('derives section_order as the sorted section_ids', () => {
    const snapshot = compilePromptSnapshot(
      {
        ...baseInput,
        sections: [
          makeSection({ section_id: 'zeta', ordinal: 30 }),
          makeSection({ section_id: 'alpha', ordinal: 10 }),
          makeSection({ section_id: 'mid', ordinal: 20 }),
        ],
      },
      approveAll,
    );
    expect(snapshot.section_order).toEqual(['alpha', 'mid', 'zeta']);
    expect(snapshot.sections.map((s) => s.section_id)).toEqual(snapshot.section_order);
  });
});
