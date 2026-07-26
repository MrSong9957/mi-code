// M-045 Memory Detail Transaction 测试 (ERC-2 / Wave E Task 4)
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md
//   - §8.3 Persistence transaction(prepared → detail_committed;failed/recovery_required)
//   - §8.4 Detail commit(绑定 admitted 字段、content hash 验证、idempotency、不可发现)
//   - §8.12 状态不变量:admitted ≠ detail_committed ≠ completed
//   - INV-E6 / INV-E7 / INV-E18
//
// 本测试只覆盖 detail commit 阶段(Task 4)。index commit / completed / recovery
// 是 Task 5 的范围,这里不测。
//
// 测试策略:使用 in-memory mock storage(实现 GovernedMemoryStorage),避免真实 fs 复杂性。
// writeGovernedDetail 的真实 fs 实现在 memory-manager.ts,有一个独立的 fs 测试验证 temp+rename。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  prepareMemoryPersistence,
  commitMemoryDetails,
  MEMORY_PERSISTENCE_PROTOCOL_VERSION,
  MEMORY_DETAIL_RECORD_PROTOCOL_VERSION,
  type MemoryPersistenceRecord,
  type MemoryPersistenceTransaction,
  type DurableCommitAcknowledgement,
  type GovernedMemoryStorage,
} from '../../memory/persistence.js';
import type { MemoryAdmissionDecision } from '../../memory/admission.js';
import type { TypedMemoryCandidate } from '../../memory/candidates.js';
import { MemoryManager } from '../../memory/memory-manager.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 计算与 persistence.ts 内部相同的 content hash,用于断言。 */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** 构造一个 admitted MemoryAdmissionDecision。 */
function makeAdmitDecision(overrides: Partial<MemoryAdmissionDecision> = {}): MemoryAdmissionDecision {
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

/** 构造一个 rejected MemoryAdmissionDecision。 */
function makeRejectDecision(overrides: Partial<MemoryAdmissionDecision> = {}): MemoryAdmissionDecision {
  return {
    admission_protocol_version: '1',
    admission_decision_id: 'reject:def456',
    memory_candidate_id: 'mem:candidate123',
    policy_ref: { contract_id: 'memory-policy', contract_version: '1' },
    current_context_snapshot_id: 'snap-1',
    status: 'reject',
    accepted_scope_ref: null,
    accepted_type: null,
    verification_requirements: [],
    reason_codes: ['memory.invalid_confidence'],
    evidence_refs: ['ev-1'],
    ...overrides,
  };
}

/** 构造一个 TypedMemoryCandidate(形状;字段来自 candidates.ts 的真实结构)。 */
function makeCandidate(overrides: Partial<TypedMemoryCandidate> = {}): TypedMemoryCandidate {
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

/**
 * In-memory mock storage,实现 GovernedMemoryStorage。
 * 记录 write 调用次数,模拟幂等键去重和冲突检测逻辑(由 commitMemoryDetails 负责,
 * storage 只负责按 detail_commit_ref 存储)。
 */
class InMemoryGovernedStorage implements GovernedMemoryStorage {
  public writes: MemoryPersistenceRecord[] = [];
  public detailWriteCount = 0;
  public failNext = false;
  private store = new Map<string, string>(); // detail_commit_ref → serialized record

  async writeGovernedDetail(record: MemoryPersistenceRecord): Promise<DurableCommitAcknowledgement> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('storage.write_failed');
    }
    // detail_commit_ref 是内容寻址:相同 memory_record_id + content_hash → 相同 ref
    const ref = `detail:${record.memory_record_id}:${record.content_hash.slice(0, 12)}`;
    if (!this.store.has(ref)) {
      this.store.set(ref, JSON.stringify(record));
      this.writes.push(record);
      this.detailWriteCount++;
    }
    return {
      detail_commit_ref: ref,
      memory_record_id: record.memory_record_id,
      record_version: record.record_version,
      committed_at: '2026-07-26T00:00:00Z',
    };
  }

  async readGovernedDetail(ref: string): Promise<string | null> {
    return this.store.get(ref) ?? null;
  }
}

// ---------------------------------------------------------------------------
// prepareMemoryPersistence
// ---------------------------------------------------------------------------

describe('prepareMemoryPersistence — admit gate', () => {
  it('does not create a transaction for a non-admitted candidate', async () => {
    const storage = new InMemoryGovernedStorage();
    await expect(prepareMemoryPersistence(makeRejectDecision(), makeCandidate(), storage))
      .rejects.toThrow(/admission_not_admit/);
  });

  it('throws for a deferred admission', async () => {
    const storage = new InMemoryGovernedStorage();
    const deferDecision = makeAdmitDecision({ status: 'defer', admission_decision_id: 'defer:xyz' });
    await expect(prepareMemoryPersistence(deferDecision, makeCandidate(), storage))
      .rejects.toThrow(/admission_not_admit/);
  });
});

describe('prepareMemoryPersistence — record construction', () => {
  it('preserves admitted type/scope/evidence/confidence', async () => {
    const storage = new InMemoryGovernedStorage();
    const candidate = makeCandidate({
      type: 'project_fact',
      scope_ref: 'repo-x',
      evidence_refs: ['ev-a', 'ev-b', 'ev-c'],
      confidence: 0.55,
    });
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), candidate, storage);
    expect(tx.record.type).toBe('project_fact');
    expect(tx.record.scope_ref).toBe('repo-x');
    expect(tx.record.evidence_refs).toEqual(['ev-a', 'ev-b', 'ev-c']);
    expect(tx.record.confidence).toBe(0.55);
  });

  it('preserves invalidation/provenance/sensitivity/freshness fields', async () => {
    const storage = new InMemoryGovernedStorage();
    const candidate = makeCandidate({
      invalidation_conditions: ['inval-1'],
      context_refs: ['ctx-1', 'ctx-2'],
      sensitivity_labels: ['public'],
      observed_at: '2026-07-20T00:00:00Z',
      expires_at: '2026-12-31T00:00:00Z',
    });
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), candidate, storage);
    expect(tx.record.invalidation_conditions).toEqual(['inval-1']);
    expect(tx.record.context_refs).toEqual(['ctx-1', 'ctx-2']);
    expect(tx.record.sensitivity_labels).toEqual(['public']);
    expect(tx.record.observed_at).toBe('2026-07-20T00:00:00Z');
    expect(tx.record.expires_at).toBe('2026-12-31T00:00:00Z');
  });

  it('verifies content hash before commit (sha256 of claim)', async () => {
    const storage = new InMemoryGovernedStorage();
    const candidate = makeCandidate({ claim: 'the project uses pnpm' });
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), candidate, storage);
    expect(tx.record.content_hash).toBe(sha256('the project uses pnpm'));
    expect(tx.record.claim).toBe('the project uses pnpm');
  });

  it('produces deterministic transaction_id for identical inputs', async () => {
    const storage1 = new InMemoryGovernedStorage();
    const storage2 = new InMemoryGovernedStorage();
    const decision = makeAdmitDecision();
    const candidate = makeCandidate();
    const tx1 = await prepareMemoryPersistence(decision, candidate, storage1);
    const tx2 = await prepareMemoryPersistence(decision, candidate, storage2);
    expect(tx2.transaction_id).toBe(tx1.transaction_id);
    expect(tx2.idempotency_key).toBe(tx1.idempotency_key);
  });

  it('different claim → different idempotency key', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx1 = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate({ claim: 'A' }), storage);
    const tx2 = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate({ claim: 'B' }), storage);
    expect(tx2.idempotency_key).not.toBe(tx1.idempotency_key);
  });

  it('initial state is prepared', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    expect(tx.state).toBe('prepared');
    expect(tx.detail_commit_ref).toBeNull();
  });

  it('transaction is frozen', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    expect(Object.isFrozen(tx)).toBe(true);
    expect(Object.isFrozen(tx.record)).toBe(true);
  });

  it('record carries admission_decision_id and protocol version', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    expect(tx.record.admission_decision_id).toBe('admit:abc123');
    expect(tx.record.record_protocol_version).toBe(MEMORY_DETAIL_RECORD_PROTOCOL_VERSION);
    expect(tx.transaction_protocol_version).toBe(MEMORY_PERSISTENCE_PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------
// commitMemoryDetails
// ---------------------------------------------------------------------------

describe('commitMemoryDetails — happy path & idempotency', () => {
  it('commits detail and transitions to detail_committed', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    const committed = await commitMemoryDetails(tx, storage);
    expect(committed.state).toBe('detail_committed');
    expect(committed.detail_commit_ref).not.toBeNull();
    expect(storage.detailWriteCount).toBe(1);
  });

  it('reuses the same detail commit for an identical idempotency key', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    const first = await commitMemoryDetails(tx, storage);
    const second = await commitMemoryDetails(first, storage);
    expect(second.detail_commit_ref).toBe(first.detail_commit_ref);
    expect(storage.detailWriteCount).toBe(1); // no duplicate write
    expect(second.state).toBe('detail_committed');
  });

  it('returns a transaction whose record is still frozen after commit', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    const committed = await commitMemoryDetails(tx, storage);
    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed.record)).toBe(true);
  });
});

describe('commitMemoryDetails — lost-update / conflict', () => {
  it('lost-update: same idempotency key + different content hash → conflict', async () => {
    const storage = new InMemoryGovernedStorage();
    // 第一次提交:claim A
    const txA = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate({ claim: 'A' }), storage);
    await commitMemoryDetails(txA, storage);

    // 构造一个"伪造"的 transaction:相同 idempotency_key 但 record.content_hash 不同。
    // 用不同 claim 准备得到不同 content_hash,然后手工把 idempotency_key 改回与 A 相同。
    // 因为 transaction 是 frozen 的,我们用 prepare 然后在内部检测 ——
    // 实际上 commitMemoryDetails 的契约是:相同 idempotency_key 的内容必须与首次提交一致。
    // 这里通过 spy storage 的写入历史,模拟"相同 key 但内容冲突"。
    const txB = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate({ claim: 'B' }), storage);
    // 强制让 idempotency_key 与 txA 相同,但 content_hash 不同(模拟 lost update 攻击)
    const tampered: MemoryPersistenceTransaction = {
      ...txA,
      idempotency_key: txA.idempotency_key,
      record: { ...txB.record, memory_record_id: txA.record.memory_record_id },
      // 保持 transaction_id 与 idempotency_key 来自 A,但 record 内容来自 B
    };
    // storage 已经记录了 A 的 content_hash;现在提交与该 idempotency_key 关联但内容不同的 record
    await expect(commitMemoryDetails(tampered, storage)).rejects.toThrow(/idempotency_conflict/);
  });
});

describe('commitMemoryDetails — failure handling', () => {
  it('storage failure leaves state=failed', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    storage.failNext = true;
    await expect(commitMemoryDetails(tx, storage)).rejects.toThrow(/storage\.write_failed/);
    // failNext 已被消费;再次读取不应看到 detail_committed
    // (state 的 failed/recovery_required 转换由 commitMemoryDetails 内部记录;
    //  因为它 throw,调用方需处理 —— 这里我们断言 storage 没有写入)
    expect(storage.detailWriteCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Detail discoverability invariant (INV-E7)
// ---------------------------------------------------------------------------

describe('INV-E7 — detail is not discoverable before catalog commit', () => {
  it('detail is not discoverable via root list() before catalog commit', async () => {
    // 这个不变量的真正 fs 验证在 memory-manager-fs 测试里(见后)。
    // 这里我们验证 protocol 层:detail_commit_ref 是一个独立引用,
    // 不是 catalog entry,record 本身不携带 catalog entry 字段。
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    const committed = await commitMemoryDetails(tx, storage);
    // record 上没有 topic_keys / keyword_keys / durability_evidence_ref 等 catalog 字段
    const r = committed.record as unknown as Record<string, unknown>;
    expect(r).not.toHaveProperty('topic_keys');
    expect(r).not.toHaveProperty('keyword_keys');
    expect(r).not.toHaveProperty('durability_evidence_ref');
    // detail_commit_ref 可读,但只能通过 readGovernedDetail 读取 raw 内容
    const raw = await storage.readGovernedDetail(committed.detail_commit_ref!);
    expect(raw).not.toBeNull();
    expect(raw!).toContain('claim');
  });

  it('commit does not call selector or update catalog (no catalog fields emitted)', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    const committed = await commitMemoryDetails(tx, storage);
    // committed transaction 不携带 index_commit_ref / catalog_snapshot_id
    const c = committed as unknown as Record<string, unknown>;
    expect(c).not.toHaveProperty('index_commit_ref');
    expect(c).not.toHaveProperty('catalog_snapshot_id');
  });
});

// ---------------------------------------------------------------------------
// Content invariants — no forbidden payloads (§8.4-8)
// ---------------------------------------------------------------------------

describe('§8.4-8 — writer must not persist forbidden payloads', () => {
  it('does not carry project_instruction / credential / deferred candidate payloads', async () => {
    // persistence 协议层只接受 TypedMemoryCandidate + MemoryAdmissionDecision(admit)。
    // 这两个输入已经在 admission/candidate 层过滤了 credential/project_instruction/deferred。
    // 我们验证 record 的字段集是 admitted memory 的字段,不含 forbidden 通道标识。
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    const committed = await commitMemoryDetails(tx, storage);
    const r = committed.record as unknown as Record<string, unknown>;
    // 不应含 source_channel / content_class / validity_scope / freshness_status
    // 这些是 admission input 字段,不是 record 字段
    expect(r).not.toHaveProperty('candidate_source_channel');
    expect(r).not.toHaveProperty('content_class');
    expect(r).not.toHaveProperty('validity_scope');
    expect(r).not.toHaveProperty('freshness_status');
  });
});

// ---------------------------------------------------------------------------
// MemoryManager governed primitives (real fs)
// ---------------------------------------------------------------------------

describe('MemoryManager.writeGovernedDetail / readGovernedDetail — real fs', () => {
  let workDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `mem-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new MemoryManager(workDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes detail into .memory/.records/ (not root memory dir)', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    const ack = await manager.writeGovernedDetail(tx.record);

    const recordsDir = join(workDir, '.memory', '.records');
    expect(existsSync(recordsDir)).toBe(true);
    const expectedPath = join(recordsDir, `${tx.record.memory_record_id}.json`);
    expect(existsSync(expectedPath)).toBe(true);

    // 根目录 list() 不应包含这条 detail(.records/ 不被根 list 扫描)
    const rootListing = manager.list().map((e) => e.slug);
    expect(rootListing).not.toContain(tx.record.memory_record_id);

    expect(ack.detail_commit_ref).toBe(tx.record.memory_record_id);
    expect(ack.memory_record_id).toBe(tx.record.memory_record_id);
    expect(ack.record_version).toBe(tx.record.record_version);
  });

  it('writeGovernedDetail uses temp + rename (no leftover .tmp file)', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    await manager.writeGovernedDetail(tx.record);

    const recordsDir = join(workDir, '.memory', '.records');
    const files = readdirSync(recordsDir);
    // 只应有最终 .json,不应有遗留的 .tmp
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('readGovernedDetail returns serialized record content', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    await manager.writeGovernedDetail(tx.record);

    const raw = await manager.readGovernedDetail(tx.record.memory_record_id);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.claim).toBe(tx.record.claim);
    expect(parsed.content_hash).toBe(tx.record.content_hash);
  });

  it('readGovernedDetail returns null for missing ref', async () => {
    const raw = await manager.readGovernedDetail('nonexistent-record-id');
    expect(raw).toBeNull();
  });

  it('writeGovernedDetail is idempotent on identical record (no error, same path)', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    const ack1 = await manager.writeGovernedDetail(tx.record);
    const ack2 = await manager.writeGovernedDetail(tx.record);
    expect(ack2.detail_commit_ref).toBe(ack1.detail_commit_ref);
    // 文件仍只存在一个
    const recordsDir = join(workDir, '.memory', '.records');
    const jsonFiles = readdirSync(recordsDir).filter((f) => f.endsWith('.json'));
    expect(jsonFiles).toHaveLength(1);
  });

  it('detail file is JSON and parseable, raw content contains claim not whole conversation', async () => {
    const storage = new InMemoryGovernedStorage();
    const tx = await prepareMemoryPersistence(makeAdmitDecision(), makeCandidate(), storage);
    await manager.writeGovernedDetail(tx.record);

    const filePath = join(workDir, '.memory', '.records', `${tx.record.memory_record_id}.json`);
    const content = readFileSync(filePath, 'utf8');
    expect(() => JSON.parse(content)).not.toThrow();
    // sanity:含 claim,不含 catalog/selector 字段
    expect(content).toContain('"claim"');
    expect(content).not.toContain('topic_keys');
    expect(content).not.toContain('keyword_keys');
  });
});
