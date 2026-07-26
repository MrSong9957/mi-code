// Memory Legacy Adapter 测试 (ERC-2 / Wave E Task 5)
//
// 覆盖规格 docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-e-implementation.md
//   Task 5 Step 5/6,以及 specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md
//
// 不变量:
//   - existing_store_durability ≠ two_step_transaction_ack(legacy 不能冒充新协议)
//   - source_kind='existing_memory_manager' 不改变 Trust / selection 权限
//   - 只有同时具备 schema compatibility + admission evidence + durability evidence
//     的条目进入 governed snapshot;其余留 unclassified
//   - snapshot 不含正文/credential/conversation/project instruction

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryManager } from '../../memory/memory-manager.js';
import {
  buildLegacyCatalogSnapshot,
  LEGACY_SCHEMA_VERSION,
  type LegacyAdapterInput,
  type LegacyCatalogSnapshot,
} from '../../memory/legacy-adapter.js';
import type { MemoryCatalogEntry } from '../../memory/catalog.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function evidenceTriplet(
  overrides: Partial<LegacyAdapterInput> = {},
): LegacyAdapterInput {
  return {
    schemaCompatibilityEvidence: { schema_version: LEGACY_SCHEMA_VERSION, compatible: true },
    admissionEvidence: { has_admission_decision: true },
    durabilityEvidence: { store_kind: 'existing_memory_manager', durable: true },
    ...overrides,
  };
}

// ===========================================================================
// buildLegacyCatalogSnapshot — admission rules
// ===========================================================================
describe('buildLegacyCatalogSnapshot — only admits evidence-backed entries', () => {
  let workDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `mem-leg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new MemoryManager(workDir);
    // 写两条 legacy 记忆(独立 slug)
    manager.write('tabs-pref', 'user', 'Tab preference', 'Body here.');
    manager.write('pnpm-tooling', 'project', 'Project uses pnpm', 'Body.');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('admits entries when schema+admission+durability evidence all present', () => {
    const input = evidenceTriplet({ manager });
    const out = buildLegacyCatalogSnapshot(input);

    expect(out.admitted_entry_ids.length).toBe(2);
    // snapshot 是 frozen 的
    expect(Object.isFrozen(out.snapshot)).toBe(true);
    expect(Object.isFrozen(out.snapshot.entries)).toBe(true);
    // detail_commit_ref / content_hash 用 legacy 标记
    for (const e of out.snapshot.entries) {
      expect(e.detail_commit_ref).toBe('legacy:existing_memory_manager');
      expect(e.source_kind).toBe('existing_memory_manager');
    }
  });

  it('rejects when schema compatibility evidence is missing', () => {
    const input = evidenceTriplet({
      manager,
      schemaCompatibilityEvidence: { schema_version: '0', compatible: false },
    });
    const out = buildLegacyCatalogSnapshot(input);

    expect(out.admitted_entry_ids).toHaveLength(0);
    // 未分类的旧数据仍可枚举(留在 snapshot 外,但 unclassified 列表暴露给调用方审计)
    expect(out.unclassified_entry_ids.length).toBe(2);
    expect(out.snapshot.entries).toHaveLength(0);
  });

  it('rejects when admission evidence is missing', () => {
    const input = evidenceTriplet({
      manager,
      admissionEvidence: { has_admission_decision: false },
    });
    const out = buildLegacyCatalogSnapshot(input);

    expect(out.admitted_entry_ids).toHaveLength(0);
    expect(out.unclassified_entry_ids.length).toBe(2);
  });

  it('rejects when durability evidence is non-durable', () => {
    const input = evidenceTriplet({
      manager,
      durabilityEvidence: {
        store_kind: 'existing_memory_manager',
        durable: false,
      },
    });
    const out = buildLegacyCatalogSnapshot(input);

    expect(out.admitted_entry_ids).toHaveLength(0);
    expect(out.unclassified_entry_ids.length).toBe(2);
  });
});

// ===========================================================================
// buildLegacyCatalogSnapshot — snapshot content & invariants
// ===========================================================================
describe('buildLegacyCatalogSnapshot — content & invariants', () => {
  let workDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `mem-leg2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new MemoryManager(workDir);
    manager.write('tabs-pref', 'user', 'Tab preference', 'Always use tabs.');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('admitted entry does not contain body / conversation / project instruction', () => {
    const out = buildLegacyCatalogSnapshot(evidenceTriplet({ manager }));
    expect(out.snapshot.entries).toHaveLength(1);
    const e = out.snapshot.entries[0] as unknown as Record<string, unknown>;
    // 不含正文/credential/conversation
    expect(e).not.toHaveProperty('body');
    expect(e).not.toHaveProperty('claim');
    expect(e).not.toHaveProperty('conversation');
    expect(e).not.toHaveProperty('project_instruction');
    // 导航 metadata 在
    expect(e).toHaveProperty('memory_record_id');
    expect(e).toHaveProperty('scope_ref');
  });

  it('produces deterministic snapshot id for identical inputs', () => {
    const a = buildLegacyCatalogSnapshot(evidenceTriplet({ manager }));
    const b = buildLegacyCatalogSnapshot(evidenceTriplet({ manager }));
    expect(b.snapshot.catalog_snapshot_id).toBe(a.snapshot.catalog_snapshot_id);
    expect(b.snapshot.catalog_hash).toBe(a.snapshot.catalog_hash);
  });
});

// ===========================================================================
// INV — existing_store_durability ≠ two_step_transaction_ack
// ===========================================================================
describe('INV — existing_store_durability does not masquerade as two_step_transaction_ack', () => {
  let workDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `mem-leg3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new MemoryManager(workDir);
    manager.write('legacy-only', 'user', 'Legacy', 'Legacy body.');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('admitted entry carries durability evidence kind, NOT two_step_transaction_ack', () => {
    const out = buildLegacyCatalogSnapshot(evidenceTriplet({ manager }));
    expect(out.snapshot.entries).toHaveLength(1);
    const e = out.snapshot.entries[0] as unknown as Record<string, unknown>;
    // durability evidence 字段必须是 existing_store,不能伪装成 two_step_transaction_ack
    expect(e.durability_evidence_kind).toBe('existing_store');
    expect(e.durability_evidence_kind).not.toBe('two_step_transaction_ack');
  });

  it('source_kind existing_memory_manager does not grant Trust / selection privilege', () => {
    const out = buildLegacyCatalogSnapshot(evidenceTriplet({ manager }));
    const e = out.snapshot.entries[0] as unknown as Record<string, unknown>;
    // 没有任何 trust / authority / verified / selection 字段
    expect(e).not.toHaveProperty('trust');
    expect(e).not.toHaveProperty('authority');
    expect(e).not.toHaveProperty('verified');
    expect(e).not.toHaveProperty('selection_privilege');
    // source_kind 只是一个标签,不携带选择特权
    expect(e.source_kind).toBe('existing_memory_manager');
  });

  it('admitted legacy entries must still pass through selection (no Trust shortcut)', () => {
    // 验证 legacy entry 与新协议 entry 在 catalog schema 上完全相同 ——
    // selector 看到它们时不会因为 source_kind 而改变行为。
    const out = buildLegacyCatalogSnapshot(evidenceTriplet({ manager }));
    const entry: MemoryCatalogEntry = out.snapshot.entries[0];
    // selector 关心的字段都在(memory_record_id / type / scope_ref / terms / bytes)
    expect(typeof entry.memory_record_id).toBe('string');
    expect(typeof entry.metadata_bytes).toBe('number');
    // source_kind 是扩展字段,selector(M-046)不读取它
    expect(entry).toHaveProperty('source_kind');
  });
});

// ===========================================================================
// unclassified data stays outside snapshot
// ===========================================================================
describe('buildLegacyCatalogSnapshot — unclassified data outside snapshot', () => {
  let workDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `mem-leg4-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new MemoryManager(workDir);
    manager.write('a', 'user', 'A', 'A body');
    manager.write('b', 'project', 'B', 'B body');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('when schema incompatible, all entries go to unclassified (snapshot empty)', () => {
    const out = buildLegacyCatalogSnapshot(
      evidenceTriplet({
        manager,
        schemaCompatibilityEvidence: { schema_version: 'unknown', compatible: false },
      }),
    );

    expect(out.snapshot.entries).toHaveLength(0);
    expect(out.admitted_entry_ids).toHaveLength(0);
    // 未分类条目可在 unclassified_entry_ids 中枚举(用于审计)
    expect(out.unclassified_entry_ids.length).toBe(2);
    expect(out.unclassified_entry_ids).toContain('a');
    expect(out.unclassified_entry_ids).toContain('b');
  });

  it('admitted entry ids match slugs; unclassified excluded from snapshot', () => {
    const out = buildLegacyCatalogSnapshot(evidenceTriplet({ manager }));
    // admitted_entry_ids 是 frozen 的(不可变),用 spread 后再排序断言。
    expect([...out.admitted_entry_ids].sort()).toEqual(['a', 'b']);
    expect(out.unclassified_entry_ids).toHaveLength(0);
  });
});
