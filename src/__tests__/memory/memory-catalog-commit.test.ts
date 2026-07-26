// M-045 Catalog Commit / Recovery 测试 (ERC-2 / Wave E Task 5)
//
// 覆盖规格 docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-e-implementation.md
//   Task 5,以及 specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md
//   - §8.5 / §8.6 Catalog entry/snapshot
//   - §8.4-4 / INV-E7  detail 在 catalog commit 前不可发现
//   - 两阶段事务:detail_committed → completed(index commit)
//   - budget rejection(不截断既有)
//   - recovery 只完成或回滚同一 transaction
//
// 不变量:
//   - INV-E7  detail 在 index commit 前不可由 governed catalog 发现
//   - INV-E18 failure 不升级状态;catalog commit 失败 → recovery_required
//   - §8.5    catalog entry 不含正文 / credential / conversation / project instruction
//   - 简单可靠优先:catalog 写入用 temp + rename 原子替换

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  prepareMemoryPersistence,
  commitMemoryDetails,
  recoverMemoryPersistence,
  type MemoryPersistenceTransaction,
  type GovernedMemoryStorage,
} from '../../memory/persistence.js';
import {
  commitMemoryCatalog,
  type CatalogCommitInput,
  type CatalogCommitResult,
  type GovernedCatalogStore,
} from '../../memory/catalog.js';
import { MemoryManager } from '../../memory/memory-manager.js';
import type { MemoryAdmissionDecision } from '../../memory/admission.js';
import type { TypedMemoryCandidate } from '../../memory/candidates.js';
import type {
  MemoryCatalogEntry,
  MemoryCatalogSnapshot,
} from '../../memory/catalog.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeAdmitDecision(
  overrides: Partial<MemoryAdmissionDecision> = {},
): MemoryAdmissionDecision {
  return {
    admission_protocol_version: '1',
    admission_decision_id: 'admit:abc123',
    memory_candidate_id: 'mem:candidate123',
    policy_ref: { contract_id: 'memory-policy', contract_version: '1' },
    current_context_snapshot_id: 'snap-1',
    status: 'admit',
    accepted_scope_ref: 'workspace-1',
    accepted_type: 'user_preference',
    verification_requirements: ['memory.use_verification_required'],
    reason_codes: [],
    evidence_refs: ['ev-1'],
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<TypedMemoryCandidate> = {},
): TypedMemoryCandidate {
  return {
    memory_candidate_protocol_version: '1',
    memory_candidate_id: 'mem:candidate123',
    source_context_id: 'ctx-1',
    type: 'user_preference',
    claim: 'prefers tabs over spaces',
    scope_ref: 'workspace-1',
    evidence_refs: ['ev-1', 'ev-2'],
    confidence: 0.8,
    observed_at: '2026-07-26T00:00:00Z',
    expires_at: null,
    context_refs: ['ctx-a'],
    invalidation_conditions: ['cond-x'],
    sensitivity_labels: [],
    ...overrides,
  };
}

/** 构造一个 detail_committed transaction(用于 catalog commit 输入)。 */
async function makeDetailCommittedTransaction(
  storage: GovernedMemoryStorage,
  overrides: { claim?: string; admissionId?: string; candidateId?: string } = {},
): Promise<MemoryPersistenceTransaction> {
  const decision = makeAdmitDecision({
    admission_decision_id: overrides.admissionId ?? 'admit:abc123',
    memory_candidate_id: overrides.candidateId ?? 'mem:candidate123',
  });
  const candidate = makeCandidate({ claim: overrides.claim ?? 'prefers tabs over spaces' });
  const prepared = await prepareMemoryPersistence(decision, candidate, storage);
  return commitMemoryDetails(prepared, storage);
}

/**
 * In-memory governed storage(只用于 detail 写入路径,不写真实 fs)。
 */
class InMemoryGovernedStorage implements GovernedMemoryStorage {
  async writeGovernedDetail(record: {
    memory_record_id: string;
    record_version: number;
    content_hash: string;
  }) {
    return {
      detail_commit_ref: `detail:${record.memory_record_id}`,
      memory_record_id: record.memory_record_id,
      record_version: record.record_version,
      committed_at: '2026-07-26T00:00:00Z',
    };
  }
  async readGovernedDetail() {
    return null;
  }
}

/**
 * In-memory governed catalog store,模拟 selector 看到的 catalog 状态。
 * 可注入 failure(测试 recovery 路径)。
 */
class InMemoryCatalogStore implements GovernedCatalogStore {
  private entries = new Map<string, MemoryCatalogEntry>();
  private snapshot: MemoryCatalogSnapshot | null = null;
  public failCommit = false;
  public commitCount = 0;

  async find(memory_record_id: string): Promise<MemoryCatalogEntry | null> {
    return this.entries.get(memory_record_id) ?? null;
  }

  async commitSnapshot(snapshot: MemoryCatalogSnapshot): Promise<void> {
    if (this.failCommit) {
      throw new Error('catalog_store.commit_failed');
    }
    // 覆盖既有 entries,与 selector 行为一致(snapshot 是完整覆盖)
    this.entries.clear();
    for (const e of snapshot.entries) {
      this.entries.set(e.memory_record_id, e);
    }
    this.snapshot = snapshot;
    this.commitCount++;
  }

  async loadSnapshot(): Promise<MemoryCatalogSnapshot | null> {
    return this.snapshot;
  }
}

/** 标准 budget policy。 */
const defaultBudget = {
  max_entries: 100,
  max_index_metadata_bytes: 100_000,
};

// ===========================================================================
// commitMemoryCatalog — INV-E7 / failure path
// ===========================================================================
describe('commitMemoryCatalog — INV-E7 detail remains undiscoverable on failure', () => {
  it('keeps a detail undiscoverable when catalog commit fails (state=recovery_required)', async () => {
    const storage = new InMemoryGovernedStorage();
    const catalogStore = new InMemoryCatalogStore();
    catalogStore.failCommit = true;

    const tx = await makeDetailCommittedTransaction(storage);
    const input: CatalogCommitInput = {
      transaction: tx,
      catalog_budget_policy: defaultBudget,
    };

    const result = await commitMemoryCatalog(input, catalogStore);

    expect(result.state).toBe('recovery_required');
    expect(result.reason_codes).toContain('catalog.commit_failed');
    expect(result.memory_record_id).toBe(tx.memory_record_id);
    // detail 没出现在 governed catalog 里(find 返回 null)
    expect(await catalogStore.find(tx.memory_record_id)).toBeNull();
  });

  it('rejects when transaction.state is not detail_committed (no detail leak)', async () => {
    const storage = new InMemoryGovernedStorage();
    const decision = makeAdmitDecision();
    const candidate = makeCandidate();
    const prepared = await prepareMemoryPersistence(decision, candidate, storage);
    // prepared.state === 'prepared',不应当进入 catalog

    const catalogStore = new InMemoryCatalogStore();
    const input: CatalogCommitInput = {
      transaction: prepared,
      catalog_budget_policy: defaultBudget,
    };

    const result = await commitMemoryCatalog(input, catalogStore);

    expect(result.state).toBe('recovery_required');
    expect(result.reason_codes).toContain('catalog.transaction_not_detail_committed');
    expect(await catalogStore.find(prepared.memory_record_id)).toBeNull();
  });
});

// ===========================================================================
// commitMemoryCatalog — happy path (identity match → completed)
// ===========================================================================
describe('commitMemoryCatalog — happy path completes transaction', () => {
  it('completes when detail/index identity/version/hash all match', async () => {
    const storage = new InMemoryGovernedStorage();
    const catalogStore = new InMemoryCatalogStore();

    const tx = await makeDetailCommittedTransaction(storage);
    const input: CatalogCommitInput = {
      transaction: tx,
      catalog_budget_policy: defaultBudget,
    };

    const result = await commitMemoryCatalog(input, catalogStore);

    expect(result.state).toBe('completed');
    expect(result.reason_codes).toEqual([]);
    expect(result.catalog_snapshot).not.toBeNull();
    const entry = await catalogStore.find(tx.memory_record_id);
    expect(entry).not.toBeNull();
    expect(entry!.detail_commit_ref).toBe(tx.detail_commit_ref);
    expect(entry!.content_hash).toBe(tx.record.content_hash);
    expect(entry!.record_version).toBe(tx.record.record_version);
  });

  it('produces a deterministic catalog_snapshot_id for identical inputs', async () => {
    // 同一 transaction 在两个空 store 上 commit,snapshot_id 必须一致
    const storageA = new InMemoryGovernedStorage();
    const storageB = new InMemoryGovernedStorage();
    const txA = await makeDetailCommittedTransaction(storageA);
    const txB = await makeDetailCommittedTransaction(storageB);
    // 内容寻址:相同 admission/candidate → 相同 tx
    expect(txB.memory_record_id).toBe(txA.memory_record_id);

    const storeA = new InMemoryCatalogStore();
    const storeB = new InMemoryCatalogStore();
    const rA = await commitMemoryCatalog(
      { transaction: txA, catalog_budget_policy: defaultBudget },
      storeA,
    );
    const rB = await commitMemoryCatalog(
      { transaction: txB, catalog_budget_policy: defaultBudget },
      storeB,
    );

    expect(rB.catalog_snapshot!.catalog_snapshot_id).toBe(
      rA.catalog_snapshot!.catalog_snapshot_id,
    );
    expect(rB.catalog_snapshot!.catalog_hash).toBe(
      rA.catalog_snapshot!.catalog_hash,
    );
  });

  it('snapshot is frozen and entries are read-only', async () => {
    const storage = new InMemoryGovernedStorage();
    const catalogStore = new InMemoryCatalogStore();
    const tx = await makeDetailCommittedTransaction(storage);

    const result = await commitMemoryCatalog(
      { transaction: tx, catalog_budget_policy: defaultBudget },
      catalogStore,
    );

    expect(Object.isFrozen(result.catalog_snapshot)).toBe(true);
    expect(Object.isFrozen(result.catalog_snapshot!.entries)).toBe(true);
    expect(Object.isFrozen(result.catalog_snapshot!.entries[0])).toBe(true);
  });
});

// ===========================================================================
// commitMemoryCatalog — entry content invariants (§8.5)
// ===========================================================================
describe('commitMemoryCatalog — entry has no body/credential/conversation', () => {
  it('entry only carries navigation metadata, not claim body or evidence body', async () => {
    const storage = new InMemoryGovernedStorage();
    const catalogStore = new InMemoryCatalogStore();
    const tx = await makeDetailCommittedTransaction(storage);

    await commitMemoryCatalog(
      { transaction: tx, catalog_budget_policy: defaultBudget },
      catalogStore,
    );

    const entry = await catalogStore.find(tx.memory_record_id);
    expect(entry).not.toBeNull();
    const e = entry! as unknown as Record<string, unknown>;
    // 不含正文 claim / context_refs / invalidation / sensitivity
    expect(e).not.toHaveProperty('claim');
    expect(e).not.toHaveProperty('evidence_refs');
    expect(e).not.toHaveProperty('context_refs');
    expect(e).not.toHaveProperty('invalidation_conditions');
    expect(e).not.toHaveProperty('sensitivity_labels');
    // navigation metadata 必须存在
    expect(e).toHaveProperty('memory_record_id');
    expect(e).toHaveProperty('type');
    expect(e).toHaveProperty('scope_ref');
    expect(e).toHaveProperty('topic_terms');
    expect(e).toHaveProperty('keyword_terms');
  });
});

// ===========================================================================
// commitMemoryCatalog — budget rejection (no truncation)
// ===========================================================================
describe('commitMemoryCatalog — budget rejection without truncating existing', () => {
  it('rejects max_entries overflow without writing and without losing existing entries', async () => {
    const storage = new InMemoryGovernedStorage();
    const catalogStore = new InMemoryCatalogStore();

    // 第一次 commit 成功(已有 1 个 entry)
    const tx1 = await makeDetailCommittedTransaction(storage, {
      admissionId: 'admit:1',
      candidateId: 'mem:c1',
      claim: 'first preference',
    });
    await commitMemoryCatalog(
      { transaction: tx1, catalog_budget_policy: defaultBudget },
      catalogStore,
    );
    expect(catalogStore.commitCount).toBe(1);

    // 第二次 commit:budget = max_entries:1(只能容纳 1 个),应当拒绝
    const tx2 = await makeDetailCommittedTransaction(storage, {
      admissionId: 'admit:2',
      candidateId: 'mem:c2',
      claim: 'second preference',
    });
    const result = await commitMemoryCatalog(
      {
        transaction: tx2,
        catalog_budget_policy: { max_entries: 1, max_index_metadata_bytes: 100_000 },
      },
      catalogStore,
    );

    expect(result.state).toBe('update_rejected');
    expect(result.reason_codes).toContain('catalog.budget_exceeded.entries');
    // 既有 entry 仍在,没被截断
    expect(await catalogStore.find(tx1.memory_record_id)).not.toBeNull();
    // 新 entry 没进 catalog(detail 仍不可发现)
    expect(await catalogStore.find(tx2.memory_record_id)).toBeNull();
    // 没有触发新的 snapshot commit
    expect(catalogStore.commitCount).toBe(1);
  });

  it('rejects max_index_metadata_bytes overflow without truncating existing', async () => {
    const storage = new InMemoryGovernedStorage();
    const catalogStore = new InMemoryCatalogStore();

    // 第一次 commit 占用预算的大部分
    const tx1 = await makeDetailCommittedTransaction(storage, {
      admissionId: 'admit:1',
      candidateId: 'mem:c1',
      claim: 'first preference',
    });
    const r1 = await commitMemoryCatalog(
      { transaction: tx1, catalog_budget_policy: defaultBudget },
      catalogStore,
    );
    const existingBytes = r1.catalog_snapshot!.entries.reduce(
      (sum, e) => sum + e.metadata_bytes,
      0,
    );

    // 第二次 commit:把 byte budget 设成"刚够 tx1,但放不下 tx2"
    const tx2 = await makeDetailCommittedTransaction(storage, {
      admissionId: 'admit:2',
      candidateId: 'mem:c2',
      claim: 'second preference',
    });
    const result = await commitMemoryCatalog(
      {
        transaction: tx2,
        catalog_budget_policy: {
          max_entries: 100,
          // 已存 entry 的字节数 —— 再加任何 entry 必然超
          max_index_metadata_bytes: existingBytes,
        },
      },
      catalogStore,
    );

    expect(result.state).toBe('update_rejected');
    expect(result.reason_codes).toContain('catalog.budget_exceeded.bytes');
    // tx1 没被截断
    expect(await catalogStore.find(tx1.memory_record_id)).not.toBeNull();
    // tx2 detail 不可发现
    expect(await catalogStore.find(tx2.memory_record_id)).toBeNull();
  });
});

// ===========================================================================
// commitMemoryCatalog — atomic write via temp + rename (real fs)
// ===========================================================================
describe('commitMemoryCatalog — MemoryManager.writeGovernedCatalog atomic write', () => {
  let workDir: string;
  let manager: MemoryManager;
  let storage: InMemoryGovernedStorage;

  beforeEach(() => {
    workDir = join(tmpdir(), `mem-cat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new MemoryManager(workDir);
    storage = new InMemoryGovernedStorage();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes governed catalog via temp + rename (no leftover .tmp)', async () => {
    const tx = await makeDetailCommittedTransaction(storage);
    const input: CatalogCommitInput = {
      transaction: tx,
      catalog_budget_policy: defaultBudget,
    };
    // 用真实 fs store:MemoryManager 实现 GovernedCatalogStore 接口
    const store: GovernedCatalogStore = {
      find: (id) => manager.findGovernedCatalogEntry(id),
      commitSnapshot: (snap) => manager.writeGovernedCatalog(snap),
      loadSnapshot: () => manager.readGovernedCatalog(),
    };

    const result = await commitMemoryCatalog(input, store);
    expect(result.state).toBe('completed');

    const catalogDir = join(workDir, '.memory', '.catalog');
    expect(existsSync(catalogDir)).toBe(true);
    const files = readdirSync(catalogDir);
    expect(files.some((f) => f === 'snapshot.json')).toBe(true);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);

    const snap = await manager.readGovernedCatalog();
    expect(snap).not.toBeNull();
    expect(snap!.entries.length).toBe(1);
    expect(snap!.entries[0].memory_record_id).toBe(tx.memory_record_id);
  });

  it('readGovernedCatalog returns null when no snapshot exists yet', async () => {
    const snap = await manager.readGovernedCatalog();
    expect(snap).toBeNull();
  });

  it('writeGovernedCatalog preserves snapshot immutability on disk (frozen on read)', async () => {
    const tx = await makeDetailCommittedTransaction(storage);
    const store: GovernedCatalogStore = {
      find: (id) => manager.findGovernedCatalogEntry(id),
      commitSnapshot: (snap) => manager.writeGovernedCatalog(snap),
      loadSnapshot: () => manager.readGovernedCatalog(),
    };
    await commitMemoryCatalog(
      { transaction: tx, catalog_budget_policy: defaultBudget },
      store,
    );

    const snap = await manager.readGovernedCatalog();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap!.entries)).toBe(true);
  });
});

// ===========================================================================
// recoverMemoryPersistence — only completes or rolls back same transaction
// ===========================================================================
describe('recoverMemoryPersistence — same-transaction only', () => {
  it('completes a detail_committed transaction by attempting catalog commit', async () => {
    const storage = new InMemoryGovernedStorage();
    const catalogStore = new InMemoryCatalogStore();
    const tx = await makeDetailCommittedTransaction(storage);

    const result = await recoverMemoryPersistence(tx, storage, catalogStore);

    expect(result.state).toBe('completed');
    expect(await catalogStore.find(tx.memory_record_id)).not.toBeNull();
  });

  it('does not silently complete a transaction whose catalog commit fails', async () => {
    const storage = new InMemoryGovernedStorage();
    const catalogStore = new InMemoryCatalogStore();
    catalogStore.failCommit = true;
    const tx = await makeDetailCommittedTransaction(storage);

    const result = await recoverMemoryPersistence(tx, storage, catalogStore);

    // recovery 不能把 commit failure 升级成 completed
    expect(result.state).toBe('recovery_required');
    expect(result.reason_codes).toContain('catalog.commit_failed');
  });

  it('rejects recovery of a transaction in prepared state (no detail written)', async () => {
    const storage = new InMemoryGovernedStorage();
    const catalogStore = new InMemoryCatalogStore();
    const decision = makeAdmitDecision();
    const candidate = makeCandidate();
    const prepared = await prepareMemoryPersistence(decision, candidate, storage);

    const result = await recoverMemoryPersistence(prepared, storage, catalogStore);

    // prepared → 没有任何 durable side effect,recovery 应判定 nothing-to-complete
    expect(result.state).toBe('recovery_required');
    expect(result.reason_codes).toContain('catalog.transaction_not_detail_committed');
  });
});
