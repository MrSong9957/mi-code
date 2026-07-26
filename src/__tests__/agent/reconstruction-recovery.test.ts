// Wave G Task 2 (GRC-1 §7.21~§7.23): reconstruction transaction persistence & idempotency 单测
//
// 物理本质:SessionStore 旁边的"重建账本"。每个 session 一个独立的
// <id>.reconstruction.jsonl 文件,append-only,按 record_kind discriminator 区分:
//   - precompact       : savePreCompactSnapshot 写入(durable recovery point)
//   - attempt_begin    : beginReconstructionAttempt 写入(idempotent key 锚定)
//   - state_transition : appendReconstructionState 写入(append-only,不改旧 record)
//   - restored_snapshot: T9 publish 路径写入(本测试用 helper 模拟)
//   - active_pointer   : compareAndSwapActiveWorkingSet 写入(单进程 CAS)
//
// 关键不变量(Wave G 规格):
//   - INV-G14 Publish 原子:CAS 失败不半工作集(active pointer 不动)
//   - INV-G15 旧 snapshot 可恢复:publish ack durable 前旧 snapshot 保持 active
//   - INV-G16 Retry 幂等:相同 idempotency key 不重复 publish
//   - §7.13 rule 6:publish ack 只能由 atomic publish path 产生
//   - §7.23 Recovery:进程在 publish 前退出 → 旧 snapshot active;
//                     进程在 pointer swap 后退出 → 依据 durable ack 恢复新 snapshot

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../session/store.js';
import type {
  PreCompactSnapshot,
  PostCompactReconstructionTransaction,
  ReconstructionStateRecord,
  RestoredWorkingSetSnapshotRecord,
} from '../../session/store.js';

// ─── fixture helpers ──────────────────────────────────────────────────────

function makePreCompactSnapshot(
  sessionId: string,
  precompactSnapshotId = 'precompact-snap-1',
): PreCompactSnapshot {
  return {
    precompact_protocol_version: 'mi.precompact/1',
    precompact_snapshot_id: precompactSnapshotId,
    session_id: sessionId,
    session_snapshot_id: 'ctx-snap-1',
    pinned_working_set_refs: ['ws-1', 'ws-2'],
    eviction_frontier_ref: 'ef-1',
    captured_at: '2026-07-26T00:00:00.000Z',
  };
}

function makeTransaction(
  sessionId: string,
  opts: {
    transactionId?: string;
    precompactSnapshotId?: string;
    idempotencyKey?: string;
  } = {},
): PostCompactReconstructionTransaction {
  return {
    reconstruction_transaction_protocol_version: 'mi.reconstruction.tx/1',
    reconstruction_transaction_id:
      opts.transactionId ?? 'recon-tx-1',
    session_id: sessionId,
    precompact_snapshot_id:
      opts.precompactSnapshotId ?? 'precompact-snap-1',
    idempotency_key: opts.idempotencyKey ?? 'idem-key-1',
    target_context_snapshot_id: 'ctx-snap-target-1',
    restoration_directive_ref: 'rd-1',
  };
}

function makeRestoredSnapshot(
  sessionId: string,
  snapshotId = 'restored-ws-1',
  transactionId = 'recon-tx-1',
): RestoredWorkingSetSnapshotRecord {
  return {
    record_protocol_version: 'mi.restored_ws_record/1',
    restored_working_set_snapshot_id: snapshotId,
    session_id: sessionId,
    reconstruction_transaction_id: transactionId,
    target_context_snapshot_id: 'ctx-snap-target-1',
    bounded_memory_entrypoint_snapshot_ref: 'bm-ep-1',
    meta_context_message_refs: ['meta-1'],
    compact_summary_ref: 'summary-1',
    current_user_message_ref: 'cur-user-1',
    execution_state_refs: ['exec-1'],
    omission_manifest_ref: 'om-1',
    request_budget_snapshot_id: 'budget-1',
    postflight_validation_ref: 'pf-1',
    publish_ack_ref: 'ack-1',
    restored_hash: 'sha256:abc',
    created_at: '2026-07-26T00:00:00.000Z',
  };
}

/**
 * 测试 helper:模拟 T9 publish 路径写入 restored_snapshot record。
 * T2 只暴露 loadRestoredWorkingSetSnapshot(save 由 T9 atomic publish path 完成,
 * 此处直接写文件以模拟 T9 行为)。
 */
function writeRestoredSnapshotRecord(
  sessionsDir: string,
  sessionId: string,
  record: RestoredWorkingSetSnapshotRecord,
): void {
  mkdirSync(sessionsDir, { recursive: true });
  const line =
    JSON.stringify({
      record_kind: 'restored_snapshot',
      ...record,
    }) + '\n';
  appendFileSync(
    join(sessionsDir, `${sessionId}.reconstruction.jsonl`),
    line,
    'utf8',
  );
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('Wave G T2: reconstruction transaction persistence', () => {
  let tempDir: string;
  let sessionsDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'micode-recon-test-'));
    sessionsDir = join(tempDir, 'sessions');
    store = new SessionStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1. savePreCompactSnapshot → loadPreCompactSnapshot round-trip
  // ───────────────────────────────────────────────────────────────────────
  describe('pre-compact snapshot round-trip', () => {
    it('save 后能 load 回相同 snapshot', async () => {
      const sid = 'recon-rt-1';
      const snap = makePreCompactSnapshot(sid);
      const ack = await store.savePreCompactSnapshot(snap, sid);

      expect(ack.ack_protocol_version).toBe('mi.durable/1');
      expect(ack.ack_id).toMatch(/^durable:[0-9a-f]{16}$/);
      expect(ack.record_id).toBe('precompact-snap-1');
      expect(ack.session_id).toBe(sid);
      expect(ack.sidecar_ref).toBe('reconstruction.jsonl');
      expect(typeof ack.committed_at).toBe('string');

      const loaded = await store.loadPreCompactSnapshot(sid, 'precompact-snap-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.precompact_snapshot_id).toBe('precompact-snap-1');
      expect(loaded!.session_id).toBe(sid);
      expect(loaded!.session_snapshot_id).toBe('ctx-snap-1');
    });

    // 7. 缺失 precompact:loadPreCompactSnapshot 返回 null
    it('loadPreCompactSnapshot 不存在 → null', async () => {
      const loaded = await store.loadPreCompactSnapshot('no-such-session', 'no-such-snap');
      expect(loaded).toBeNull();
    });

    it('loadPreCompactSnapshot id 不匹配 → null(有其他 snapshot 但 id 不对)', async () => {
      const sid = 'recon-rt-2';
      await store.savePreCompactSnapshot(
        makePreCompactSnapshot(sid, 'snap-A'),
        sid,
      );
      const loaded = await store.loadPreCompactSnapshot(sid, 'snap-B');
      expect(loaded).toBeNull();
    });

    it('写入落在独立 sidecar 文件 <id>.reconstruction.jsonl', async () => {
      const sid = 'recon-rt-3';
      await store.savePreCompactSnapshot(makePreCompactSnapshot(sid), sid);
      const sidecarPath = join(sessionsDir, `${sid}.reconstruction.jsonl`);
      expect(existsSync(sidecarPath)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. crash before publish: save precompact + begin attempt(state='assembled'),
  //    recoverSession, getActiveWorkingSetId === null
  // ───────────────────────────────────────────────────────────────────────
  describe('crash before publish recovery (INV-G15)', () => {
    it('publish 前 getActiveWorkingSetId 返回 null(旧 snapshot 仍 active)', async () => {
      const sid = 'recon-crash-1';
      const snap = makePreCompactSnapshot(sid);
      await store.savePreCompactSnapshot(snap, sid);

      const tx = makeTransaction(sid);
      const attempt = await store.beginReconstructionAttempt(tx);

      expect(attempt.latest_state).toBe('assembled');
      expect(attempt.idempotency_key).toBe('idem-key-1');
      expect(attempt.reconstruction_transaction_id).toBe('recon-tx-1');
      expect(attempt.precompact_snapshot_id).toBe('precompact-snap-1');

      // 还没 publish → 没有 active working set pointer
      const active = await store.getActiveWorkingSetId(sid);
      expect(active).toBeNull();
    });

    it('重启 SessionStore 后状态可恢复(precompact + attempt 仍在)', async () => {
      const sid = 'recon-crash-2';
      await store.savePreCompactSnapshot(makePreCompactSnapshot(sid), sid);
      const tx = makeTransaction(sid);
      await store.beginReconstructionAttempt(tx);

      // 模拟进程重启:新建 SessionStore 实例(同一目录)
      const recovered = new SessionStore(tempDir);
      const loaded = await recovered.loadPreCompactSnapshot(sid, 'precompact-snap-1');
      expect(loaded).not.toBeNull();

      const attempt = await recovered.loadReconstructionAttempt(sid, 'idem-key-1');
      expect(attempt).not.toBeNull();
      expect(attempt!.latest_state).toBe('assembled');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3 & 4. beginReconstructionAttempt idempotency
  // ───────────────────────────────────────────────────────────────────────
  describe('beginReconstructionAttempt idempotency (INV-G16)', () => {
    it('相同 idempotency_key 第二次调用返回同一 attempt', async () => {
      const sid = 'recon-idem-1';
      const tx = makeTransaction(sid, { idempotencyKey: 'key-X' });
      const first = await store.beginReconstructionAttempt(tx);
      const second = await store.beginReconstructionAttempt(tx);

      expect(second.attempt_id).toBe(first.attempt_id);
      expect(second.attempt_id).toMatch(/^attempt:[0-9a-f]{16}$/);
      expect(second.created_at).toBe(first.created_at);
    });

    it('不同 idempotency_key 创建新 attempt', async () => {
      const sid = 'recon-idem-2';
      const txA = makeTransaction(sid, {
        idempotencyKey: 'key-A',
        transactionId: 'tx-A',
      });
      const txB = makeTransaction(sid, {
        idempotencyKey: 'key-B',
        transactionId: 'tx-B',
      });
      const a = await store.beginReconstructionAttempt(txA);
      const b = await store.beginReconstructionAttempt(txB);

      expect(b.attempt_id).not.toBe(a.attempt_id);
      expect(b.reconstruction_transaction_id).toBe('tx-B');
    });

    it('loadReconstructionAttempt 用 idempotency_key 查找已有 attempt', async () => {
      const sid = 'recon-idem-3';
      const tx = makeTransaction(sid, { idempotencyKey: 'key-load' });
      const begun = await store.beginReconstructionAttempt(tx);

      const loaded = await store.loadReconstructionAttempt(sid, 'key-load');
      expect(loaded).not.toBeNull();
      expect(loaded!.attempt_id).toBe(begun.attempt_id);
    });

    it('loadReconstructionAttempt 不存在 key → null', async () => {
      const sid = 'recon-idem-4';
      const loaded = await store.loadReconstructionAttempt(sid, 'no-such-key');
      expect(loaded).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. appendReconstructionState append-only 不修改旧 record
  // ───────────────────────────────────────────────────────────────────────
  describe('appendReconstructionState append-only', () => {
    it('多次 append 不修改已有 record', async () => {
      const sid = 'recon-state-1';
      const tx = makeTransaction(sid, { transactionId: 'tx-state' });
      await store.beginReconstructionAttempt(tx);

      const rec1: ReconstructionStateRecord = {
        state_record_protocol_version: 'mi.state_record/1',
        state_record_id: 'strec:0001',
        reconstruction_transaction_id: 'tx-state',
        session_id: sid,
        from_state: 'assembled',
        to_state: 'validated',
        reason_codes: ['validation.passed'],
        transitioned_at: '2026-07-26T00:00:01.000Z',
        payload_ref: null,
      };
      const rec2: ReconstructionStateRecord = {
        state_record_protocol_version: 'mi.state_record/1',
        state_record_id: 'strec:0002',
        reconstruction_transaction_id: 'tx-state',
        session_id: sid,
        from_state: 'validated',
        to_state: 'publishing',
        reason_codes: ['publish.begin'],
        transitioned_at: '2026-07-26T00:00:02.000Z',
        payload_ref: 'restored-ws-1',
      };
      await store.appendReconstructionState(rec1, sid);
      await store.appendReconstructionState(rec2, sid);

      // 加载 attempt,latest_state 应为最后一个 to_state
      const loaded = await store.loadReconstructionAttempt(sid, 'idem-key-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.latest_state).toBe('publishing');
      expect(loaded!.latest_state_record_id).toBe('strec:0002');

      // 旧 record 不变:扫描文件,确认两个 state_transition 都还在
      const sidecar = join(sessionsDir, `${sid}.reconstruction.jsonl`);
      const text = await import('fs/promises').then(m => m.readFile(sidecar, 'utf8'));
      const stateLines = text
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l))
        .filter(r => r.record_kind === 'state_transition');
      expect(stateLines).toHaveLength(2);
      expect(stateLines[0].state_record_id).toBe('strec:0001');
      expect(stateLines[1].state_record_id).toBe('strec:0002');
    });

    it('append 后 attempt updated_at 推进(latest_state 来自最后 transition)', async () => {
      const sid = 'recon-state-2';
      const tx = makeTransaction(sid, { transactionId: 'tx-state-2' });
      const begun = await store.beginReconstructionAttempt(tx);

      await store.appendReconstructionState(
        {
          state_record_protocol_version: 'mi.state_record/1',
          state_record_id: 'strec:A',
          reconstruction_transaction_id: 'tx-state-2',
          session_id: sid,
          from_state: 'assembled',
          to_state: 'validated',
          reason_codes: ['ok'],
          transitioned_at: '2026-07-26T00:00:05.000Z',
          payload_ref: null,
        },
        sid,
      );

      const loaded = await store.loadReconstructionAttempt(sid, tx.idempotency_key);
      expect(loaded!.latest_state).toBe('validated');
      expect(loaded!.updated_at).not.toBe(begun.updated_at);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6. 损坏 line 容错(fail-closed 与 loadMetaLifecycle 一致)
  // ───────────────────────────────────────────────────────────────────────
  describe('corrupted line fail-closed', () => {
    it('reconstruction.jsonl 出现损坏行 → loadReconstructionAttempt 抛错(fail closed)', async () => {
      const sid = 'recon-corrupt-1';
      const tx = makeTransaction(sid);
      await store.beginReconstructionAttempt(tx);

      // 注入一行损坏 JSON
      const sidecar = join(sessionsDir, `${sid}.reconstruction.jsonl`);
      appendFileSync(sidecar, '{NOT VALID JSON\n', 'utf8');

      await expect(
        store.loadReconstructionAttempt(sid, tx.idempotency_key),
      ).rejects.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 8-13. compareAndSwapActiveWorkingSet CAS 行为
  // ───────────────────────────────────────────────────────────────────────
  describe('compareAndSwapActiveWorkingSet CAS (INV-G14)', () => {
    it('expectedPreviousId=null 匹配(无现有 pointer) → swapped', async () => {
      const sid = 'recon-cas-1';
      const result = await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'restored-ws-A',
        transactionId: 'tx-cas-1',
        idempotencyKey: 'cas-key-1',
      });

      expect(result.swap_status).toBe('swapped');
      expect(result.previous_active_id).toBeNull();
      expect(result.new_active_id).toBe('restored-ws-A');
      expect(result.transaction_id).toBe('tx-cas-1');
      expect(result.idempotency_key).toBe('cas-key-1');
      expect(result.swap_id).toMatch(/^swap:[0-9a-f]{16}$/);

      // pointer 已更新
      const active = await store.getActiveWorkingSetId(sid);
      expect(active).toBe('restored-ws-A');
    });

    it('expectedPreviousId 匹配现有 → swapped', async () => {
      const sid = 'recon-cas-2';
      // 第一次 swap:从 null → ws-A
      await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'ws-A',
        transactionId: 'tx-1',
        idempotencyKey: 'key-1',
      });
      // 第二次 swap:从 ws-A → ws-B
      const result = await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: 'ws-A',
        newSnapshotId: 'ws-B',
        transactionId: 'tx-2',
        idempotencyKey: 'key-2',
      });

      expect(result.swap_status).toBe('swapped');
      expect(result.previous_active_id).toBe('ws-A');
      expect(result.new_active_id).toBe('ws-B');
    });

    // 9. CAS swap:expectedPreviousId 不匹配 → cas_failed
    it('expectedPreviousId 不匹配 → cas_failed (INV-G14)', async () => {
      const sid = 'recon-cas-3';
      // 先建立 pointer = ws-A
      await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'ws-A',
        transactionId: 'tx-1',
        idempotencyKey: 'key-1',
      });

      // 期望 ws-X 但实际是 ws-A → cas_failed
      const result = await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: 'ws-X',
        newSnapshotId: 'ws-B',
        transactionId: 'tx-2',
        idempotencyKey: 'key-2',
      });

      expect(result.swap_status).toBe('cas_failed');
      expect(result.previous_active_id).toBe('ws-A');
      expect(result.new_active_id).toBe('ws-B');
    });

    // 11. CAS swap 失败时 active pointer 不变
    it('cas_failed 时 active pointer 不变(INV-G14)', async () => {
      const sid = 'recon-cas-4';
      await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'ws-A',
        transactionId: 'tx-1',
        idempotencyKey: 'key-1',
      });

      await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: 'ws-WRONG',
        newSnapshotId: 'ws-B',
        transactionId: 'tx-2',
        idempotencyKey: 'key-2',
      });

      // active pointer 仍是 ws-A
      const active = await store.getActiveWorkingSetId(sid);
      expect(active).toBe('ws-A');
    });

    // 10. CAS swap:相同 newSnapshotId === current → idempotent_replay
    it('newSnapshotId === 当前 active → idempotent_replay', async () => {
      const sid = 'recon-cas-5';
      await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'ws-A',
        transactionId: 'tx-1',
        idempotencyKey: 'key-1',
      });

      const result = await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null, // 故意不匹配当前
        newSnapshotId: 'ws-A', // 但 snapshot id 相同
        transactionId: 'tx-1',
        idempotencyKey: 'key-1', // 相同 key
      });

      expect(result.swap_status).toBe('idempotent_replay');
      expect(result.new_active_id).toBe('ws-A');
    });

    // 12. idempotent publish retry:相同 idempotency_key 第二次 CAS 返回 idempotent_replay
    it('相同 idempotency_key retry → idempotent_replay,不重复写入(INV-G16)', async () => {
      const sid = 'recon-cas-6';
      const input = {
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'ws-A',
        transactionId: 'tx-1',
        idempotencyKey: 'key-retry',
      };
      const first = await store.compareAndSwapActiveWorkingSet(input);
      expect(first.swap_status).toBe('swapped');

      // retry
      const second = await store.compareAndSwapActiveWorkingSet(input);
      expect(second.swap_status).toBe('idempotent_replay');
      expect(second.swap_id).toBe(first.swap_id);

      // 文件中只有 1 个 active_pointer record(没重复写)
      const sidecar = join(sessionsDir, `${sid}.reconstruction.jsonl`);
      const text = await import('fs/promises').then(m => m.readFile(sidecar, 'utf8'));
      const pointers = text
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l))
        .filter(r => r.record_kind === 'active_pointer');
      expect(pointers).toHaveLength(1);
    });

    // 13. 不同 candidate 用相同 key 但不同 snapshot id → rejected (cas_failed)
    it('相同 idempotency_key 但不同 newSnapshotId → cas_failed', async () => {
      const sid = 'recon-cas-7';
      await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'ws-A',
        transactionId: 'tx-1',
        idempotencyKey: 'key-shared',
      });

      // 同 key 但 newSnapshotId 不同 → 不能 replay,也不应 swap
      const result = await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: 'ws-A',
        newSnapshotId: 'ws-DIFFERENT',
        transactionId: 'tx-2',
        idempotencyKey: 'key-shared',
      });

      expect(result.swap_status).toBe('cas_failed');
    });

    // 14. active working set 持久化:重启后 getActiveWorkingSetId 返回相同值
    it('重启 SessionStore 后 active pointer 持久', async () => {
      const sid = 'recon-cas-8';
      await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'ws-PERSIST',
        transactionId: 'tx-1',
        idempotencyKey: 'key-1',
      });

      const recovered = new SessionStore(tempDir);
      const active = await recovered.getActiveWorkingSetId(sid);
      expect(active).toBe('ws-PERSIST');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // loadRestoredWorkingSetSnapshot
  // ───────────────────────────────────────────────────────────────────────
  describe('loadRestoredWorkingSetSnapshot', () => {
    it('能加载 T9 publish 写入的 restored snapshot', async () => {
      const sid = 'recon-restored-1';
      const record = makeRestoredSnapshot(sid);
      writeRestoredSnapshotRecord(sessionsDir, sid, record);

      const loaded = await store.loadRestoredWorkingSetSnapshot(
        sid,
        'restored-ws-1',
      );
      expect(loaded).not.toBeNull();
      expect(loaded!.restored_working_set_snapshot_id).toBe('restored-ws-1');
      expect(loaded!.reconstruction_transaction_id).toBe('recon-tx-1');
      expect(loaded!.compact_summary_ref).toBe('summary-1');
    });

    it('loadRestoredWorkingSetSnapshot 不存在 → null', async () => {
      const loaded = await store.loadRestoredWorkingSetSnapshot(
        'no-such-session',
        'no-such-snapshot',
      );
      expect(loaded).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 端到端:full reconstruction lifecycle
  // ───────────────────────────────────────────────────────────────────────
  describe('end-to-end reconstruction lifecycle (§7.23)', () => {
    it('full lifecycle: precompact → attempt → state transitions → publish', async () => {
      const sid = 'recon-e2e-1';

      // 1. save precompact
      const snap = makePreCompactSnapshot(sid);
      const precompactAck = await store.savePreCompactSnapshot(snap, sid);
      expect(precompactAck.record_id).toBe('precompact-snap-1');

      // 2. begin attempt
      const tx = makeTransaction(sid, {
        transactionId: 'tx-e2e',
        idempotencyKey: 'key-e2e',
      });
      const attempt = await store.beginReconstructionAttempt(tx);
      expect(attempt.latest_state).toBe('assembled');

      // 3. transition: assembled → validated
      await store.appendReconstructionState(
        {
          state_record_protocol_version: 'mi.state_record/1',
          state_record_id: 'strec:e2e-1',
          reconstruction_transaction_id: 'tx-e2e',
          session_id: sid,
          from_state: 'assembled',
          to_state: 'validated',
          reason_codes: ['validation.passed'],
          transitioned_at: '2026-07-26T00:00:10.000Z',
          payload_ref: null,
        },
        sid,
      );

      // 4. transition: validated → publishing
      await store.appendReconstructionState(
        {
          state_record_protocol_version: 'mi.state_record/1',
          state_record_id: 'strec:e2e-2',
          reconstruction_transaction_id: 'tx-e2e',
          session_id: sid,
          from_state: 'validated',
          to_state: 'publishing',
          reason_codes: ['publish.begin'],
          transitioned_at: '2026-07-26T00:00:11.000Z',
          payload_ref: 'restored-ws-e2e',
        },
        sid,
      );

      // 5. T9 publish: write restored_snapshot record
      writeRestoredSnapshotRecord(
        sessionsDir,
        sid,
        makeRestoredSnapshot(sid, 'restored-ws-e2e', 'tx-e2e'),
      );

      // 6. atomic CAS swap
      const swapResult = await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'restored-ws-e2e',
        transactionId: 'tx-e2e',
        idempotencyKey: 'key-e2e',
      });
      expect(swapResult.swap_status).toBe('swapped');

      // 7. retry CAS (模拟进程重启后 retry publish ack)
      const retryResult = await store.compareAndSwapActiveWorkingSet({
        sessionId: sid,
        expectedPreviousId: null,
        newSnapshotId: 'restored-ws-e2e',
        transactionId: 'tx-e2e',
        idempotencyKey: 'key-e2e',
      });
      expect(retryResult.swap_status).toBe('idempotent_replay');

      // 8. 验证恢复:getActiveWorkingSetId 指向新 snapshot
      const active = await store.getActiveWorkingSetId(sid);
      expect(active).toBe('restored-ws-e2e');

      // 9. 验证 attempt 的 latest_state 仍是 publishing(state_transition append-only,
      //    CAS 不写 state_transition,CAS 后 latest_state 不会自动变成 'published' —
      //    那是 T9 publish path 的责任,通过额外 appendReconstructionState 完成)
      const loaded = await store.loadReconstructionAttempt(sid, 'key-e2e');
      expect(loaded!.latest_state).toBe('publishing');
    });
  });
});
