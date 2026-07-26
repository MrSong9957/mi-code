// ERC-1 §7.5 — Session serializer round-trip (M-038 Task 2).
//
// `serializeMetaLifecycleRecord` / `deserializeMetaLifecycleRecord` are the
// canonical round-trip gate between a frozen `MetaMessageLifecycleRecord` and
// its on-disk form. The session store persists them to a sidecar
// `<id>.meta-lifecycle.jsonl` that is structurally separate from the
// Provider-visible conversation log — so meta lifecycle NEVER mixes into the
// conversation JSONL and NEVER counts as a user turn.
//
// Invariants exercised below (spec ERC-1 §7.5 / §7.8):
//   - Round-trip preserves every field of the lifecycle record.
//   - meta message does NOT increase the user turn count.
//   - load()/loadSync() conversation JSONL never contains lifecycle control
//     records.
//   - Unknown serializer protocol version, missing `is_meta`/ordinal/hash
//     mismatch → fail closed (throw); never silently degrade to a plain user
//     message.
//   - An invalidated source cannot restore resident state purely because a
//     serializer record exists.
//   - Serialize is deterministic (same record → same bytes).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMetaLifecycleRecord,
  decideMetaRetention,
  deserializeMetaLifecycleRecord,
  META_LIFECYCLE_PROTOCOL_VERSION,
  META_RETENTION_PROTOCOL_VERSION,
  serializeMetaLifecycleRecord,
  type MetaMessageLifecycleRecord,
  type MetaRetentionInput,
  type MetaRetentionPolicy,
} from '../../agent/context/retention.js';
import type { MetaContextActivation } from '../../agent/context/activation.js';
import { SessionStore } from '../../session/store.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function frozenActivation(
  overrides: Partial<MetaContextActivation> = {},
): MetaContextActivation {
  return Object.freeze({
    activation_protocol_version: 'mi.activation/1',
    activation_id: 'activation-1',
    request_snapshot_id: 'snapshot-1',
    message_id: 'meta:abc123',
    semantic_role: 'user',
    placement: 'meta_context',
    is_meta: true,
    source_context_id: 'src-1',
    route_decision_id: 'route-1',
    content_ref: 'bounded-ref-1',
    content_hash: 'hash-captured',
    authority: 'user',
    trust: 'trusted',
    provenance_refs: ['user:input'],
    freshness_ref: 'fresh-1',
    overflow_metadata_ref: null,
    retention_state: 'unassigned',
    ordinal: 0,
    ...overrides,
  }) as MetaContextActivation;
}

const POLICY: MetaRetentionPolicy = {
  policy_id: 'pi-retention/1',
  policy_version: '1.0.0',
  fresh_threshold_ms: 60_000,
};

function inputFor(
  sourceState: MetaRetentionInput['source_freshness_state'],
  overrides: Partial<MetaRetentionInput> = {},
): MetaRetentionInput {
  return {
    retention_protocol_version: META_RETENTION_PROTOCOL_VERSION,
    meta_activation: frozenActivation(),
    session_snapshot_id: 'session-snap-1',
    source_freshness_state: sourceState,
    source_content_hash: 'hash-captured',
    activation_content_hash: 'hash-captured',
    current_time: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function makeResidentRecord(
  overrides: Partial<MetaMessageLifecycleRecord> = {},
): MetaMessageLifecycleRecord {
  const decision = decideMetaRetention(inputFor('fresh'), POLICY);
  return createMetaLifecycleRecord(decision, {
    transitioned_at: '2026-07-26T00:00:00.000Z',
    ...overrides,
  });
}

function makeInvalidatedRecord(): MetaMessageLifecycleRecord {
  const decision = decideMetaRetention(
    inputFor('invalidated_source'),
    POLICY,
  );
  return createMetaLifecycleRecord(decision, {
    transitioned_at: '2026-07-26T00:00:00.000Z',
  });
}

describe('SessionStore sidecar fixture', () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'micode-meta-life-'));
    store = new SessionStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Round-trip preservation (spec ERC-1 §7.5 rule 3).
  // -------------------------------------------------------------------------

  describe('serialize/deserialize round-trip', () => {
    it('preserves every field of the lifecycle record', () => {
      const record = makeResidentRecord();
      const restored = deserializeMetaLifecycleRecord(
        serializeMetaLifecycleRecord(record),
      );
      expect(restored).toEqual(record);
    });

    it('serialize is deterministic (identical record → identical bytes)', () => {
      const record = makeResidentRecord();
      const a = serializeMetaLifecycleRecord(record);
      const b = serializeMetaLifecycleRecord(record);
      expect(a).toBe(b);
    });

    it('serialize is order-independent for the same record content', () => {
      const record = makeResidentRecord();
      const a = serializeMetaLifecycleRecord(record);
      // Re-derive a record with the same identity; id is deterministic so the
      // serialized form must match.
      const rederived = makeResidentRecord();
      const b = serializeMetaLifecycleRecord(rederived);
      expect(a).toBe(b);
    });

    it('round-trip survives invalidated and reload_required states', () => {
      const decision = decideMetaRetention(
        inputFor('stale_refreshable'),
        POLICY,
      );
      const reload = createMetaLifecycleRecord(decision, {
        transitioned_at: '2026-07-26T00:00:01.000Z',
      });
      const invalidated = makeInvalidatedRecord();
      expect(
        deserializeMetaLifecycleRecord(serializeMetaLifecycleRecord(reload)),
      ).toEqual(reload);
      expect(
        deserializeMetaLifecycleRecord(
          serializeMetaLifecycleRecord(invalidated),
        ),
      ).toEqual(invalidated);
    });
  });

  // -------------------------------------------------------------------------
  // Fail-closed on tampering / unknown version (spec ERC-1 §7.5 rule 4 / §7.8).
  // -------------------------------------------------------------------------

  describe('fail closed on integrity violations', () => {
    it('rejects an unknown serializer protocol version', () => {
      const record = makeResidentRecord();
      const envelope = JSON.parse(
        serializeMetaLifecycleRecord(record),
      ) as Record<string, unknown>;
      envelope.serializer_protocol_version = 'mi.meta.serializer/999';
      expect(() =>
        deserializeMetaLifecycleRecord(JSON.stringify(envelope)),
      ).toThrow(/serializer\./);
    });

    it('rejects a corrupted content hash (record tampered post-signing)', () => {
      const record = makeResidentRecord();
      const envelope = JSON.parse(
        serializeMetaLifecycleRecord(record),
      ) as { record: Record<string, unknown>; content_hash: string };
      // Mutate the record without re-signing the hash.
      envelope.record.state = 'invalidated';
      expect(() =>
        deserializeMetaLifecycleRecord(JSON.stringify(envelope)),
      ).toThrow(/serializer\./);
    });

    it('rejects a malformed envelope (missing record body)', () => {
      const record = makeResidentRecord();
      const envelope = JSON.parse(
        serializeMetaLifecycleRecord(record),
      ) as Partial<{ record: unknown; content_hash: string; serializer_protocol_version: string }>;
      delete envelope.record;
      expect(() =>
        deserializeMetaLifecycleRecord(JSON.stringify(envelope)),
      ).toThrow(/serializer\./);
    });

    it('rejects a record whose lifecycle_protocol_version is unknown', () => {
      const record = makeResidentRecord();
      const envelope = JSON.parse(
        serializeMetaLifecycleRecord(record),
      ) as { record: Record<string, unknown> };
      envelope.record.lifecycle_protocol_version = 'mi.meta.lifecycle/999';
      // Re-sign hash so we isolate the version check from the hash check.
      envelope['content_hash' as keyof typeof envelope] = '<recomputed-below>';
      // Recompute by re-serializing a forged record through the real signer.
      const forgedSerialized = serializeMetaLifecycleRecord(
        envelope.record as unknown as MetaMessageLifecycleRecord,
      );
      const forgedEnvelope = JSON.parse(forgedSerialized) as typeof envelope;
      expect(() =>
        deserializeMetaLifecycleRecord(JSON.stringify(forgedEnvelope)),
      ).toThrow(/serializer\./);
    });

    it('rejects a record whose ordinal-bearing message identity changed', () => {
      // Lifecycle record binds message_id; mutating it after signing must fail.
      const record = makeResidentRecord();
      const envelope = JSON.parse(
        serializeMetaLifecycleRecord(record),
      ) as { record: Record<string, unknown>; content_hash: string };
      envelope.record.message_id = 'meta:DIFFERENT';
      expect(() =>
        deserializeMetaLifecycleRecord(JSON.stringify(envelope)),
      ).toThrow(/serializer\./);
    });

    it('does not throw on the happy path (sanity: failure modes are isolated)', () => {
      const record = makeResidentRecord();
      expect(() =>
        deserializeMetaLifecycleRecord(serializeMetaLifecycleRecord(record)),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Store sidecar persistence (spec ERC-1 §7.5 rules 1, 2, 5).
  // -------------------------------------------------------------------------

  describe('store.saveMetaLifecycle / loadMetaLifecycle', () => {
    it('round-trips a record through the sidecar and back', async () => {
      const record = makeResidentRecord();
      await store.saveMetaLifecycle(record, 'sess-1');
      const restored = await store.loadMetaLifecycle('sess-1');
      expect(restored).toHaveLength(1);
      expect(restored[0]).toEqual(record);
    });

    it('preserves meta identity without increasing the user turn count', async () => {
      const sid = 'sess-turn';
      // Seed one genuine user turn so the baseline is non-zero.
      await store.append(sid, { role: 'user', content: 'hello' });
      const initialTurnCount = await store.countUserTurns(sid);
      expect(initialTurnCount).toBe(1);

      const record = makeResidentRecord();
      await store.saveMetaLifecycle(record, sid);

      const restored = await store.loadMetaLifecycle(sid);
      expect(restored[0]).toEqual(record);

      // Meta lifecycle must NOT count as a user turn.
      expect(await store.countUserTurns(sid)).toBe(initialTurnCount);
    });

    it('load() conversation does not contain lifecycle control records', async () => {
      const sid = 'sess-isolation';
      await store.append(sid, { role: 'user', content: 'visible' });
      const record = makeResidentRecord();
      await store.saveMetaLifecycle(record, sid);

      const messages = await store.load(sid);
      // Only the one genuine user message; no lifecycle control record leaked
      // into the Provider-visible conversation.
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe('visible');
    });

    it('does not mix meta lifecycle into the conversation jsonl on disk', async () => {
      const sid = 'sess-disk-isolation';
      await store.append(sid, { role: 'user', content: 'visible' });
      const record = makeResidentRecord();
      await store.saveMetaLifecycle(record, sid);

      const conversationPath = join(tempDir, 'sessions', `${sid}.jsonl`);
      const sidecarPath = join(
        tempDir,
        'sessions',
        `${sid}.meta-lifecycle.jsonl`,
      );
      expect(existsSync(conversationPath)).toBe(true);
      expect(existsSync(sidecarPath)).toBe(true);

      const conversationText = readFileSync(conversationPath, 'utf8');
      // The lifecycle record id must never appear inside the conversation log.
      expect(conversationText).not.toContain(record.lifecycle_record_id);
      expect(conversationText).not.toContain(record.message_id);
    });

    it('loadMetaLifecycle returns [] when the sidecar does not exist', async () => {
      const restored = await store.loadMetaLifecycle('never-written');
      expect(restored).toEqual([]);
    });

    it('appends multiple records preserving order', async () => {
      const sid = 'sess-multi';
      const first = makeResidentRecord();
      const second = makeResidentRecord({
        transitioned_at: '2026-07-26T00:00:05.000Z',
        previous_state: 'resident',
        state: 'serialized',
      });
      await store.saveMetaLifecycle(first, sid);
      await store.saveMetaLifecycle(second, sid);

      const restored = await store.loadMetaLifecycle(sid);
      expect(restored).toHaveLength(2);
      expect(restored[0]).toEqual(first);
      expect(restored[1]).toEqual(second);
    });
  });

  // -------------------------------------------------------------------------
  // Invalidated source cannot restore resident (spec ERC-1 §7.5 rule 6 / §7.8).
  // -------------------------------------------------------------------------

  describe('invalidated source cannot restore resident state', () => {
    it('loadMetaLifecycle returns the invalidated record as-is', async () => {
      // The store persists whatever record it receives; the lifecycle gate is
      // what prevents resident restoration. We assert the store faithfully
      // round-trips an invalidated record and the caller can read state to
      // refuse resident reconstruction.
      const record = makeInvalidatedRecord();
      expect(record.state).toBe('invalidated');
      await store.saveMetaLifecycle(record, 'sess-inv');
      const restored = await store.loadMetaLifecycle('sess-inv');
      expect(restored).toHaveLength(1);
      expect(restored[0]!.state).toBe('invalidated');
      // A resident state must NOT have been silently synthesized.
      expect(restored[0]!.state).not.toBe('resident');
    });
  });
});

// ---------------------------------------------------------------------------
// Type-level sanity: exports are wired.
// ---------------------------------------------------------------------------
function _typeCheck(): void {
  const _r: MetaMessageLifecycleRecord = {} as unknown as MetaMessageLifecycleRecord;
  void _r;
  void META_LIFECYCLE_PROTOCOL_VERSION;
}
void _typeCheck;
