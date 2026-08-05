// Task 13: 脱敏权限审计（A86-A87）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §9（audit allowlist）、§10 A86-A87。
//
// 锁定行为：
//   - 每个最终 permission decision 恰好产生一个 result audit event（A86）
//   - audit 字段严格 allowlist：decisionId、toolName、behavior、reasonCode、source、latencyBucket、phase（A87）
//   - command、content、raw path、classifier prompt 不得进入事件（A87）
//   - audit/observer 异常不得改变授权结果，只留下脱敏本地诊断
//   - result fan-out 放在 RuntimeSecurityGate 的最终决定出口
import { describe, test, expect } from 'vitest';
import {
  buildAuditEvent,
  logPermissionDecision,
  toLatencyBucket,
  type PermissionAuditEvent,
  type PermissionAuditSink,
  type PermissionDecisionInput,
} from '../../permission/audit.js';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { createSecurityDecision, type SecurityDecision } from '../../permission/decisions.js';
import type { PendingDecisionStore, PendingSecurityDecision } from '../../permission/runtime-gate.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

class InMemoryPendingStore implements PendingDecisionStore {
  private decisions: PendingSecurityDecision[] = [];
  async save(p: PendingSecurityDecision): Promise<void> { this.decisions.push({ ...p }); }
  async load(): Promise<readonly PendingSecurityDecision[]> { return this.decisions; }
  async update(id: string, u: Partial<PendingSecurityDecision>): Promise<void> {
    const d = this.decisions.find((x) => x.decision_id === id);
    if (d) Object.assign(d, u);
  }
}

class MemoryAuditSink {
  events: PermissionAuditEvent[] = [];
  readonly sink: PermissionAuditSink = (event) => { this.events.push(event); };
}

function allowDecision(toolName = 'write_file'): SecurityDecision {
  return createSecurityDecision({
    protocol_version: '1',
    decision_id: `dec-${Math.random().toString(36).slice(2, 8)}`,
    action: { kind: 'tool_call', subject_id: toolName, snapshot_id: 'snap-1' },
    behavior: 'allow',
    deciding_layer: 'test',
    risk_kind: 'none',
    policy_id: 'test-policy',
    policy_version: '1',
    reason_code: 'test.allow',
    human_reason: 'test',
    provenance_refs: ['prov:1'],
  });
}

function denyDecision(toolName = 'run_bash', reasonCode = 'test.deny'): SecurityDecision {
  return createSecurityDecision({
    protocol_version: '1',
    decision_id: `dec-${Math.random().toString(36).slice(2, 8)}`,
    action: { kind: 'tool_call', subject_id: toolName, snapshot_id: 'snap-1' },
    behavior: 'deny',
    deciding_layer: 'test',
    risk_kind: 'high',
    policy_id: 'test-policy',
    policy_version: '1',
    reason_code: reasonCode,
    human_reason: 'test deny',
    provenance_refs: ['prov:1'],
  });
}

// ─── A86: every final decision emits exactly one sourced result event ─────────

describe('[A86] every final decision emits exactly one sourced result event', () => {
  test('allow decision produces exactly one result event', async () => {
    const sink = new MemoryAuditSink();
    const gate = new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingStore(),
      channel: null,
      auditSink: sink.sink,
    });
    const result = await gate.authorize(allowDecision('write_file'));
    expect(result.kind).toBe('authorized');
    const resultEvents = sink.events.filter((e) => e.phase === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({
      behavior: 'allow',
      toolName: 'write_file',
      phase: 'result',
    });
  });

  test('deny decision produces exactly one result event', async () => {
    const sink = new MemoryAuditSink();
    const gate = new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingStore(),
      channel: null,
      auditSink: sink.sink,
    });
    const result = await gate.authorize(denyDecision('run_bash', 'command.dangerous'));
    expect(result.kind).toBe('denied');
    const resultEvents = sink.events.filter((e) => e.phase === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({
      behavior: 'deny',
      toolName: 'run_bash',
      reasonCode: 'command.dangerous',
    });
  });

  test('ask with no channel produces one result event (deny)', async () => {
    const sink = new MemoryAuditSink();
    const gate = new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingStore(),
      channel: null,
      auditSink: sink.sink,
    });
    const askDecision = createSecurityDecision({
      protocol_version: '1',
      decision_id: 'dec-ask-1',
      action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 'snap-1' },
      behavior: 'ask',
      deciding_layer: 'test',
      risk_kind: 'medium',
      policy_id: 'test-policy',
      policy_version: '1',
      reason_code: 'test.ask',
      human_reason: 'test ask',
      provenance_refs: ['prov:1'],
    });
    await gate.authorize(askDecision);
    const resultEvents = sink.events.filter((e) => e.phase === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0].behavior).toBe('deny');
  });

  test('no auditSink = no crash (LEGACY behavior)', async () => {
    const gate = new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingStore(),
      channel: null,
    });
    const result = await gate.authorize(allowDecision());
    expect(result.kind).toBe('authorized');
  });
});

// ─── A87: audit excludes commands, content, raw paths, classifier prompt ──────

describe('[A87] audit excludes sensitive data', () => {
  test('buildAuditEvent excludes command, path, content, classifier prompt', () => {
    const input: PermissionDecisionInput = {
      decisionId: 'dec-1',
      toolName: 'run_bash',
      behavior: 'deny',
      reasonCode: 'command.dangerous',
      source: 'checker',
      latencyMs: 42,
      // 这些敏感字段不应出现在事件中
      command: 'cat secret.txt',
      path: 'C:/secret.txt',
      content: 'token=abc123',
      classifierPrompt: 'private rules here',
    };
    const event = buildAuditEvent(input);
    const json = JSON.stringify(event);
    expect(json).not.toContain('cat secret.txt');
    expect(json).not.toContain('C:/secret.txt');
    expect(json).not.toContain('token=abc123');
    expect(json).not.toContain('private rules here');
    // allowlist 字段存在
    expect(event).toEqual(expect.objectContaining({
      decisionId: 'dec-1',
      toolName: 'run_bash',
      behavior: 'deny',
      reasonCode: 'command.dangerous',
      phase: 'result',
    }));
  });

  test('event has exactly the allowlist fields (no extra keys)', () => {
    const input: PermissionDecisionInput = {
      decisionId: 'dec-2',
      toolName: 'write_file',
      behavior: 'allow',
      reasonCode: 'auto.allowlist',
      source: 'resolver',
      latencyMs: 5,
    };
    const event = buildAuditEvent(input);
    const keys = Object.keys(event).sort();
    // 严格 allowlist：decisionId, toolName, behavior, reasonCode, source, latencyBucket, phase
    expect(keys).toEqual(['behavior', 'decisionId', 'latencyBucket', 'phase', 'reasonCode', 'source', 'toolName']);
  });
});

// ─── latency bucket ───────────────────────────────────────────────────────────

describe('latency bucket', () => {
  test('toLatencyBucket buckets correctly', () => {
    expect(toLatencyBucket(0)).toBe('<10ms');
    expect(toLatencyBucket(9)).toBe('<10ms');
    expect(toLatencyBucket(10)).toBe('10-100ms');
    expect(toLatencyBucket(100)).toBe('100-1000ms');
    expect(toLatencyBucket(999)).toBe('100-1000ms');
    expect(toLatencyBucket(1000)).toBe('1s-10s');
    expect(toLatencyBucket(9999)).toBe('1s-10s');
    expect(toLatencyBucket(10000)).toBe('>10s');
  });
});

// ─── audit observer exception does not change authorization ───────────────────

describe('audit observer exception does not change authorization', () => {
  test('throwing auditSink does not prevent authorization', async () => {
    const throwingSink: PermissionAuditSink = () => { throw new Error('audit crash'); };
    const gate = new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingStore(),
      channel: null,
      auditSink: throwingSink,
    });
    // 不应抛错——audit 异常被静默吞掉
    const result = await gate.authorize(allowDecision());
    expect(result.kind).toBe('authorized');
  });
});

// ─── logPermissionDecision convenience ────────────────────────────────────────

describe('logPermissionDecision', () => {
  test('writes exactly one result event to sink', () => {
    const sink = new MemoryAuditSink();
    logPermissionDecision(
      {
        decisionId: 'dec-log-1',
        toolName: 'read_file',
        behavior: 'allow',
        reasonCode: 'session.allowlist',
        source: 'resolver',
        latencyMs: 3,
      },
      sink.sink,
    );
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].phase).toBe('result');
    expect(sink.events[0].latencyBucket).toBe('<10ms');
  });
});
