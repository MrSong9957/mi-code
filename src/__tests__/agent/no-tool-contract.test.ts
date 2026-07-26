/**
 * Wave C Task 9 (M-031 / CRC-4): No-Tool Request Contract — 测试.
 *
 * 覆盖规格 §10.4 的四重 enforcement + 错误语义 + INV-C9.
 */

import { describe, it, expect } from 'vitest';
import {
  createNoToolRequestContract,
  validateNoToolRequest,
  bindValidationToContract,
  NO_TOOL_PROTOCOL_VERSION,
  type NoToolRequestState,
} from '../../agent/tools/no-tool-contract.js';

describe('NoToolRequestContract — createNoToolRequestContract', () => {
  it('constructs an immutable contract with deterministic id', () => {
    const c1 = createNoToolRequestContract({
      task_profile_snapshot_id: 'profile-1',
      tool_view_snapshot_id: 'tv-empty-1',
    });
    const c2 = createNoToolRequestContract({
      task_profile_snapshot_id: 'profile-1',
      tool_view_snapshot_id: 'tv-empty-1',
    });
    expect(c1.no_tool_request_id).toBe(c2.no_tool_request_id);
    expect(c1.no_tool_request_id).toMatch(/^notool:[a-f0-9]{16}$/);
    expect(c1.no_tool_protocol_version).toBe(NO_TOOL_PROTOCOL_VERSION);
    expect(Object.isFrozen(c1)).toBe(true);
    expect(Object.isFrozen(c1.enforcement_policy_ref)).toBe(true);
  });

  it('produces different ids for different profile/view snapshots', () => {
    const a = createNoToolRequestContract({
      task_profile_snapshot_id: 'profile-1',
      tool_view_snapshot_id: 'tv-1',
    });
    const b = createNoToolRequestContract({
      task_profile_snapshot_id: 'profile-2',
      tool_view_snapshot_id: 'tv-1',
    });
    expect(a.no_tool_request_id).not.toBe(b.no_tool_request_id);
  });

  it('rejects empty identity fields', () => {
    expect(() =>
      createNoToolRequestContract({
        task_profile_snapshot_id: '',
        tool_view_snapshot_id: 'tv-1',
      }),
    ).toThrow(/task_profile_snapshot_id/);
    expect(() =>
      createNoToolRequestContract({
        task_profile_snapshot_id: 'profile-1',
        tool_view_snapshot_id: '  ',
      }),
    ).toThrow(/tool_view_snapshot_id/);
  });
});

describe('NoToolRequestContract — validateNoToolRequest 四重 enforcement', () => {
  const validState: NoToolRequestState = {
    profile_requires_no_tools: true,
    included_tool_count: 0,
    provider_tools_omitted: true,
    runtime_tool_use_behavior: 'reject',
  };

  it('returns valid when all four gates pass', () => {
    const result = validateNoToolRequest(validState);
    expect(result.status).toBe('valid');
    expect(result.diagnostics).toEqual([]);
    expect(result.tool_view_entry_count).toBe(0);
    expect(result.provider_tools_omitted).toBe(true);
    expect(result.runtime_tool_use_behavior).toBe('reject');
  });

  it.each([
    ['profile', { profile_requires_no_tools: false }],
    ['view', { included_tool_count: 1 }],
    ['provider', { provider_tools_omitted: false }],
    ['runtime', { runtime_tool_use_behavior: 'execute' as const }],
  ] as const)('invalidates no-tool request when %s gate fails', (_name, failure) => {
    const result = validateNoToolRequest({ ...validState, ...failure });
    expect(result.status).toBe('invalid');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('rejects view with multiple included tools (not just 1)', () => {
    const result = validateNoToolRequest({ ...validState, included_tool_count: 5 });
    expect(result.status).toBe('invalid');
    expect(result.diagnostics.some((d) => d.includes('view_gate_failed'))).toBe(true);
  });

  it('collects multiple diagnostics when several gates fail', () => {
    const result = validateNoToolRequest({
      profile_requires_no_tools: false,
      included_tool_count: 3,
      provider_tools_omitted: false,
      runtime_tool_use_behavior: 'execute',
    });
    expect(result.status).toBe('invalid');
    expect(result.diagnostics.length).toBe(4);
  });

  it('tool_view_entry_count is literal 0 in result regardless of input', () => {
    // 即使输入 included_tool_count=2, result.tool_view_entry_count 仍是 0
    // (这是"声明性事实": no-tool contract 要求 view 恰好零)
    const result = validateNoToolRequest({ ...validState, included_tool_count: 2 });
    expect(result.tool_view_entry_count).toBe(0);
  });
});

describe('NoToolRequestContract — INV-C9 不变量', () => {
  it('result is deeply frozen', () => {
    const result = validateNoToolRequest({
      profile_requires_no_tools: true,
      included_tool_count: 0,
      provider_tools_omitted: true,
      runtime_tool_use_behavior: 'reject',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  it('bindValidationToContract associates result with contract id', () => {
    const contract = createNoToolRequestContract({
      task_profile_snapshot_id: 'profile-1',
      tool_view_snapshot_id: 'tv-empty-1',
    });
    const result = bindValidationToContract(contract, {
      profile_requires_no_tools: true,
      included_tool_count: 0,
      provider_tools_omitted: true,
      runtime_tool_use_behavior: 'reject',
    });
    expect(result.no_tool_request_id).toBe(contract.no_tool_request_id);
    expect(result.status).toBe('valid');
  });

  it('validate result is deterministic for same state', () => {
    const state: NoToolRequestState = {
      profile_requires_no_tools: true,
      included_tool_count: 0,
      provider_tools_omitted: true,
      runtime_tool_use_behavior: 'reject',
    };
    const r1 = validateNoToolRequest(state);
    const r2 = validateNoToolRequest(state);
    expect(r1).toEqual(r2);
  });
});
