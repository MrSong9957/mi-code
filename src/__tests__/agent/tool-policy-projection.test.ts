// src/__tests__/agent/tool-policy-projection.test.ts
// Wave C Task 8 (M-026 / CRC-4): Tool Policy Projection.
//
// 物理本质:ToolPolicyProjection 只投影 runtime policy 已决定的事实,
// 不产生任何 allow/ask/deny 行为(INV-C8)。它把"当前 policy 快照 + 当前 tool view 快照 +
// 受信 description asset + 受信约束"压成一个稳定、确定、可追溯的 projection。
//
// 失败语义(spec §10.5 + §10.3):
//   - policy version 漂移     → throw 'security_policy_snapshot_id'
//   - tool view snapshot 漂移  → throw 'tool_view_snapshot_id'
//   - tool 不在 view 中         → throw 'tool.not_included'
//   - description asset 未批准  → throw 'description_asset.not_approved'
//   - rendered 含 secret 关键词 → throw 'projection.contains_sensitive'
//
// 关键不变量(§17.4 CRC-4):
//   - projection 能追溯 runtime policy(投影源 snapshot 完整保留);
//   - projection NEVER 产生 SecurityDecision(无 behavior/allow/deny 字段);
//   - 同一 input 派生的 projection_id 确定一致。

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  projectToolPolicy,
  type ToolPolicyProjectionInput,
  type ToolPolicyProjectionDeps,
} from '../../agent/tools/policy-projection.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const validInput: ToolPolicyProjectionInput = {
  tool_id: 'read_file',
  tool_view_snapshot_id: 'tv-1',
  security_policy_snapshot_id: 'sec-1',
  policy_decision_refs: ['dec-1'],
  description_asset_ref: { asset_id: 'asset-1', asset_version: '1' },
  dynamic_constraint_refs: ['con-1'],
};

const validDeps: ToolPolicyProjectionDeps = {
  current_security_policy_snapshot_id: 'sec-1',
  current_tool_view_snapshot_id: 'tv-1',
  approvedAsset: () => true,
  renderConstraints: () => 'read-only within workspace',
  isToolIncluded: () => true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Happy path & shape
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolPolicyProjection / happy path', () => {
  it('builds a projection from current policy', () => {
    const p = projectToolPolicy(validInput, validDeps);
    expect(p.tool_id).toBe('read_file');
    expect(p.source_policy_snapshot_id).toBe('sec-1');
    expect(p.source_tool_view_snapshot_id).toBe('tv-1');
    expect(p.description_asset_ref).toEqual({
      asset_id: 'asset-1',
      asset_version: '1',
    });
    // sha256 hex == 64 lowercase hex chars
    expect(p.rendered_constraint_hash).toMatch(/^[a-f0-9]{64}$/);
    // ref prefixes 'constraint:' + first 16 hex chars of the hash
    expect(p.rendered_constraint_ref).toBe(
      `constraint:${p.rendered_constraint_hash.slice(0, 16)}`,
    );
    expect(p.projection_id).toMatch(/^proj:[a-f0-9]{16}$/);
    expect(p.projection_protocol_version).toBe('1');
    // normal projection has empty reason_codes
    expect(p.reason_codes).toEqual([]);
  });

  it('does not produce any behavior field (INV-C8)', () => {
    const p = projectToolPolicy(validInput, validDeps);
    expect(p).not.toHaveProperty('behavior');
    expect(p).not.toHaveProperty('allow');
    expect(p).not.toHaveProperty('deny');
    expect(p).not.toHaveProperty('ask');
  });

  it('produces deterministic projection_id for the same input', () => {
    const p1 = projectToolPolicy(validInput, validDeps);
    const p2 = projectToolPolicy(validInput, validDeps);
    expect(p1.projection_id).toBe(p2.projection_id);
    expect(p1.rendered_constraint_hash).toBe(p2.rendered_constraint_hash);
  });

  it('projection_id changes when policy snapshot changes', () => {
    const p1 = projectToolPolicy(validInput, validDeps);
    const p2 = projectToolPolicy(
      { ...validInput, security_policy_snapshot_id: 'sec-2' },
      { ...validDeps, current_security_policy_snapshot_id: 'sec-2' },
    );
    expect(p1.projection_id).not.toBe(p2.projection_id);
    expect(p2.source_policy_snapshot_id).toBe('sec-2');
  });

  it('projection_id changes when tool_id changes', () => {
    const p1 = projectToolPolicy(validInput, validDeps);
    const p2 = projectToolPolicy(
      { ...validInput, tool_id: 'write_file' },
      { ...validDeps, isToolIncluded: () => true },
    );
    expect(p1.projection_id).not.toBe(p2.projection_id);
  });

  it('renders constraints via the provided renderer', () => {
    const rendered = 'workspace-scoped read access';
    const p = projectToolPolicy(validInput, {
      ...validDeps,
      renderConstraints: () => rendered,
    });
    const expectedHash = createHash('sha256').update(rendered).digest('hex');
    expect(p.rendered_constraint_hash).toBe(expectedHash);
  });

  it('returns a frozen projection object', () => {
    const p = projectToolPolicy(validInput, validDeps);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.description_asset_ref)).toBe(true);
    expect(Object.isFrozen(p.reason_codes)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale policy / view
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolPolicyProjection / drift failures', () => {
  it('rejects a projection built from a stale security policy', () => {
    expect(() =>
      projectToolPolicy(validInput, {
        ...validDeps,
        current_security_policy_snapshot_id: 'sec-2',
      }),
    ).toThrow('security_policy_snapshot_id');
  });

  it('rejects a projection built from a stale tool view snapshot', () => {
    expect(() =>
      projectToolPolicy(validInput, {
        ...validDeps,
        current_tool_view_snapshot_id: 'tv-2',
      }),
    ).toThrow('tool_view_snapshot_id');
  });

  it('checks policy drift before tool-view drift', () => {
    // both stale → policy error wins(顺序靠前)
    expect(() =>
      projectToolPolicy(validInput, {
        ...validDeps,
        current_security_policy_snapshot_id: 'sec-2',
        current_tool_view_snapshot_id: 'tv-2',
      }),
    ).toThrow('security_policy_snapshot_id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool inclusion / asset approval
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolPolicyProjection / inclusion & asset', () => {
  it('rejects an excluded tool', () => {
    expect(() =>
      projectToolPolicy(validInput, {
        ...validDeps,
        isToolIncluded: () => false,
      }),
    ).toThrow(/not_included/);
  });

  it('rejects a non-approved description asset', () => {
    expect(() =>
      projectToolPolicy(validInput, {
        ...validDeps,
        approvedAsset: () => false,
      }),
    ).toThrow(/not_approved/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sensitive content filter
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolPolicyProjection / sensitive content filter', () => {
  it('filters when rendered text contains API_KEY', () => {
    expect(() =>
      projectToolPolicy(validInput, {
        ...validDeps,
        renderConstraints: () => 'the API_KEY is xxx',
      }),
    ).toThrow(/sensitive/i);
  });

  it('filters when rendered text contains secret', () => {
    expect(() =>
      projectToolPolicy(validInput, {
        ...validDeps,
        renderConstraints: () => 'must include the secret token',
      }),
    ).toThrow(/sensitive/i);
  });

  it('filters when rendered text contains credential', () => {
    expect(() =>
      projectToolPolicy(validInput, {
        ...validDeps,
        renderConstraints: () => 'use the credential vault',
      }),
    ).toThrow(/sensitive/i);
  });

  it('does not flag safe constraint text', () => {
    const p = projectToolPolicy(validInput, {
      ...validDeps,
      renderConstraints: () => 'read-only within workspace root',
    });
    expect(p.rendered_constraint_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is case-insensitive when detecting secrets', () => {
    expect(() =>
      projectToolPolicy(validInput, {
        ...validDeps,
        renderConstraints: () => 'api_key=value',
      }),
    ).toThrow(/sensitive/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity / non-empty field validation
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolPolicyProjection / identity validation', () => {
  it('rejects empty tool_id', () => {
    expect(() =>
      projectToolPolicy(
        { ...validInput, tool_id: '' },
        validDeps,
      ),
    ).toThrow(/tool_id/);
  });

  it('rejects empty description asset_id', () => {
    expect(() =>
      projectToolPolicy(
        {
          ...validInput,
          description_asset_ref: { asset_id: '', asset_version: '1' },
        },
        validDeps,
      ),
    ).toThrow(/asset_id/);
  });
});
