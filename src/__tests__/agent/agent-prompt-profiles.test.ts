// src/__tests__/agent/agent-prompt-profiles.test.ts
// Wave B Task 9 (M-014/M-035): Agent Prompt Profile composition (BRC-4).
//
// 物理本质:验证 "角色 profile + task 模板 + 能力快照 + final tool view"
// 被压成一张不可变的 AgentPromptProfileSnapshot。Profile 只负责"汇报"
// role/task 请求了什么 vs final view 实际给了什么 —— 它不授予权限、不复活
// 已被 final view 排除的工具(spec §10.5 rule 4:BRC-2 + RC-5 才决定最终权限)。
//
// 关键不变量:
//  - role/task 的 prompt_asset_ref 必须通过 approvedAsset 校验,否则抛错。
//  - role/task 的 required_capabilities 必须全部在 capability_supported 中。
//  - requested_tool_ids 中,被 final view 排除的工具必须出现在 diagnostic_codes
//    里(reason code 'profile.tool_excluded.<tool_id>')—— 这是 RED test 的核心断言。
//  - 输出必须深冻结。
//  - Profile 绝不能改写 finalToolView 的 visibility —— actual_tool_ids 完全由
//    finalToolView.entries 决定。

import { describe, expect, it } from 'vitest';
import { composeAgentPromptProfile } from '../../agent/prompt/profiles.js';
import { roleToAgentRoleProfile, type Role } from '../../agent/roles.js';
import { enhanceSubagentSystemPrompt } from '../../agent/subagent.js';
import type { AgentRoleProfile, TaskPromptTemplate } from '../../agent/prompt/profiles.js';
import type { NormalizedEnvironmentSnapshot } from '../../agent/context/intake/environment.js';
import { normalizeEnvironmentSnapshot } from '../../agent/context/intake/environment.js';
import { freezeSnapshot } from '../../agent/contracts/identities.js';
import type { RequestToolViewSnapshot, RequestToolViewEntry } from '../../agent/tools/overlay.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a frozen RequestToolViewSnapshot where `excluded` tools are excluded
 * and every other tool_id is included. Only the listed tool_ids appear; tests
 * only care about presence/absence in entries.
 */
function viewWith(
  tool_ids: string[],
  excluded: string[] = [],
): RequestToolViewSnapshot {
  const exSet = new Set(excluded);
  const entries: RequestToolViewEntry[] = tool_ids.map((tool_id, i) => {
    const isIncluded = !exSet.has(tool_id);
    const entry: RequestToolViewEntry = {
      tool_id,
      canonical_order: i,
      visibility: isIncluded ? 'included' : 'excluded',
      exclusion_reason_code: isIncluded ? null : 'test.synthetic_exclusion',
      description_asset_ref: null,
      provider_annotations: {},
    };
    return freezeSnapshot(entry) as RequestToolViewEntry;
  });
  return freezeSnapshot({
    tool_view_protocol_version: '1',
    tool_view_snapshot_id: 'view-test-1',
    base_tool_snapshot_id: 'base-1',
    capability_snapshot_id: 'cap-1',
    security_policy_snapshot_id: 'security-1',
    entries: freezeSnapshot(entries),
  }) as RequestToolViewSnapshot;
}

/** Convenience: a snapshot that excludes exactly one tool. */
function viewExcluding(tool_id: string): RequestToolViewSnapshot {
  return viewWith([tool_id, 'read_file'], [tool_id]);
}

/** A standalone AgentRoleProfile that doesn't depend on ROLE_REGISTRY. */
function roleProfile(overrides: Partial<AgentRoleProfile> = {}): AgentRoleProfile {
  return {
    role_id: 'explore',
    role_version: '1',
    prompt_asset_ref: { asset_id: 'mi-code.role.explore', asset_version: '1' },
    purpose: 'read-only exploration',
    requested_tool_ids: ['read_file', 'run_bash'],
    required_capabilities: [],
    completion_protocol_version: '1',
    verification_requirement: 'V2',
    ...overrides,
  };
}

/** A standalone TaskPromptTemplate. */
function taskTemplate(overrides: Partial<TaskPromptTemplate> = {}): TaskPromptTemplate {
  return {
    task_type: 'investigate',
    template_version: '1',
    prompt_asset_ref: { asset_id: 'mi-code.task.investigate', asset_version: '1' },
    input_schema_id: 'input-1',
    output_schema_id: 'output-1',
    required_capabilities: [],
    no_tool_requirement: false,
    ...overrides,
  };
}

/** approvedAsset callback: approves a fixed set of asset_ids. */
function approveOnly(...approved_ids: string[]) {
  const set = new Set(approved_ids);
  return (ref: { asset_id: string; asset_version: string }) => set.has(ref.asset_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// composeAgentPromptProfile: core composition rules
// ─────────────────────────────────────────────────────────────────────────────

describe('composeAgentPromptProfile: requested-vs-actual tool diagnostics', () => {
  it('reports a requested tool excluded by the final tool view', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-1',
      role: roleProfile(),
      task: null,
      capability_supported: new Set(),
      finalToolView: viewExcluding('run_bash'),
      approvedAsset: () => true,
    });
    expect(result.snapshot.requested_tool_ids).toContain('run_bash');
    expect(result.actual_tool_ids).not.toContain('run_bash');
    expect(result.diagnostic_codes).toContain('profile.tool_excluded.run_bash');
  });

  it('emits no diagnostic when all requested tools are included', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-1',
      role: roleProfile({ requested_tool_ids: ['read_file', 'run_bash'] }),
      task: null,
      capability_supported: new Set(),
      finalToolView: viewWith(['read_file', 'run_bash']),
      approvedAsset: () => true,
    });
    expect(result.diagnostic_codes).toEqual([]);
  });

  it('emits multiple diagnostics when multiple requested tools are excluded', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-1',
      role: roleProfile({ requested_tool_ids: ['read_file', 'run_bash', 'memory_read'] }),
      task: null,
      capability_supported: new Set(),
      // exclude two of three
      finalToolView: viewWith(
        ['read_file', 'run_bash', 'memory_read'],
        ['run_bash', 'memory_read'],
      ),
      approvedAsset: () => true,
    });
    expect(result.diagnostic_codes).toContain('profile.tool_excluded.run_bash');
    expect(result.diagnostic_codes).toContain('profile.tool_excluded.memory_read');
    expect(result.diagnostic_codes).not.toContain('profile.tool_excluded.read_file');
    expect(result.diagnostic_codes.length).toBe(2);
  });

  it('actual_tool_ids reflects ONLY included entries from finalToolView', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-1',
      role: roleProfile({ requested_tool_ids: [] }),
      task: null,
      capability_supported: new Set(),
      finalToolView: viewWith(
        ['read_file', 'run_bash', 'memory_read', 'write_file'],
        ['run_bash', 'write_file'],
      ),
      approvedAsset: () => true,
    });
    expect(result.actual_tool_ids).toEqual(['read_file', 'memory_read']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// composeAgentPromptProfile: asset approval enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('composeAgentPromptProfile: asset approval', () => {
  it('throws mentioning approved/asset when role asset is not approved', () => {
    expect(() =>
      composeAgentPromptProfile({
        profile_protocol_version: '1',
        profile_snapshot_id: 'profile-1',
        role: roleProfile(),
        task: null,
        capability_supported: new Set(),
        finalToolView: viewWith(['read_file']),
        approvedAsset: () => false, // role asset rejected
      }),
    ).toThrowError(/approved|asset/i);
  });

  it('throws mentioning approved/asset when task asset is not approved', () => {
    expect(() =>
      composeAgentPromptProfile({
        profile_protocol_version: '1',
        profile_snapshot_id: 'profile-1',
        role: roleProfile(),
        task: taskTemplate(),
        capability_supported: new Set(),
        finalToolView: viewWith(['read_file']),
        // approve role but reject task
        approvedAsset: approveOnly('mi-code.role.explore'),
      }),
    ).toThrowError(/approved|asset/i);
  });

  it('succeeds when both role and task assets are approved', () => {
    expect(() =>
      composeAgentPromptProfile({
        profile_protocol_version: '1',
        profile_snapshot_id: 'profile-1',
        role: roleProfile(),
        task: taskTemplate(),
        capability_supported: new Set(),
        finalToolView: viewWith(['read_file']),
        approvedAsset: approveOnly('mi-code.role.explore', 'mi-code.task.investigate'),
      }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// composeAgentPromptProfile: capability requirement
// ─────────────────────────────────────────────────────────────────────────────

describe('composeAgentPromptProfile: capability requirements', () => {
  it('throws mentioning capability when role.required_capabilities has an unsupported cap', () => {
    expect(() =>
      composeAgentPromptProfile({
        profile_protocol_version: '1',
        profile_snapshot_id: 'profile-1',
        role: roleProfile({ required_capabilities: ['code.read'] }),
        task: null,
        capability_supported: new Set(), // code.read not supported
        finalToolView: viewWith(['read_file']),
        approvedAsset: () => true,
      }),
    ).toThrowError(/capability/i);
  });

  it('throws mentioning capability when task.required_capabilities has an unsupported cap', () => {
    expect(() =>
      composeAgentPromptProfile({
        profile_protocol_version: '1',
        profile_snapshot_id: 'profile-1',
        role: roleProfile(),
        task: taskTemplate({ required_capabilities: ['plan.write'] }),
        capability_supported: new Set(),
        finalToolView: viewWith(['read_file']),
        approvedAsset: () => true,
      }),
    ).toThrowError(/capability/i);
  });

  it('succeeds when all required caps are supported', () => {
    expect(() =>
      composeAgentPromptProfile({
        profile_protocol_version: '1',
        profile_snapshot_id: 'profile-1',
        role: roleProfile({ required_capabilities: ['code.read'] }),
        task: taskTemplate({ required_capabilities: ['plan.write'] }),
        capability_supported: new Set(['code.read', 'plan.write']),
        finalToolView: viewWith(['read_file']),
        approvedAsset: () => true,
      }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// composeAgentPromptProfile: snapshot content
// ─────────────────────────────────────────────────────────────────────────────

describe('composeAgentPromptProfile: snapshot fields', () => {
  it('prompt_asset_refs contains role ref + task ref when task present', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-1',
      role: roleProfile(),
      task: taskTemplate(),
      capability_supported: new Set(),
      finalToolView: viewWith(['read_file']),
      approvedAsset: () => true,
    });
    expect(result.snapshot.prompt_asset_refs.map(r => r.asset_id)).toEqual([
      'mi-code.role.explore',
      'mi-code.task.investigate',
    ]);
  });

  it('prompt_asset_refs contains only role ref when task is null', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-1',
      role: roleProfile(),
      task: null,
      capability_supported: new Set(),
      finalToolView: viewWith(['read_file']),
      approvedAsset: () => true,
    });
    expect(result.snapshot.prompt_asset_refs.map(r => r.asset_id)).toEqual([
      'mi-code.role.explore',
    ]);
  });

  it('snapshot carries role/task refs + protocol versions', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-42',
      role: roleProfile({ role_id: 'explore', role_version: '1', completion_protocol_version: '7' }),
      task: taskTemplate({ task_type: 'investigate', template_version: '2' }),
      capability_supported: new Set(),
      finalToolView: viewWith(['read_file']),
      approvedAsset: () => true,
    });
    expect(result.snapshot.profile_protocol_version).toBe('1');
    expect(result.snapshot.profile_snapshot_id).toBe('profile-42');
    expect(result.snapshot.role_ref).toEqual({ role_id: 'explore', role_version: '1' });
    expect(result.snapshot.task_ref).toEqual({ task_type: 'investigate', template_version: '2' });
    expect(result.snapshot.completion_protocol_version).toBe('7');
  });

  it('task_ref is null when task is null', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-1',
      role: roleProfile(),
      task: null,
      capability_supported: new Set(),
      finalToolView: viewWith(['read_file']),
      approvedAsset: () => true,
    });
    expect(result.snapshot.task_ref).toBeNull();
  });

  it('requested_tool_ids and required_capabilities in snapshot are the union from role+task', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-1',
      role: roleProfile({
        requested_tool_ids: ['read_file'],
        required_capabilities: ['code.read'],
      }),
      task: taskTemplate({ required_capabilities: ['plan.write'] }),
      capability_supported: new Set(['code.read', 'plan.write']),
      finalToolView: viewWith(['read_file']),
      approvedAsset: () => true,
    });
    expect(result.snapshot.requested_tool_ids).toEqual(['read_file']);
    expect(result.snapshot.required_capabilities).toEqual(['code.read', 'plan.write']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// composeAgentPromptProfile: deep-freeze
// ─────────────────────────────────────────────────────────────────────────────

describe('composeAgentPromptProfile: immutability', () => {
  it('snapshot, actual_tool_ids, and diagnostic_codes are frozen', () => {
    const result = composeAgentPromptProfile({
      profile_protocol_version: '1',
      profile_snapshot_id: 'profile-1',
      role: roleProfile(),
      task: null,
      capability_supported: new Set(),
      finalToolView: viewWith(['read_file']),
      approvedAsset: () => true,
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.prompt_asset_refs)).toBe(true);
    expect(Object.isFrozen(result.actual_tool_ids)).toBe(true);
    expect(Object.isFrozen(result.diagnostic_codes)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roleToAgentRoleProfile mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('roleToAgentRoleProfile', () => {
  it.each(['explore', 'plan', 'general'] as const)(
    'maps %s role to expected AgentRoleProfile',
    (role: Role) => {
      const p = roleToAgentRoleProfile(role);
      expect(p.role_id).toBe(role);
      expect(p.role_version).toBe('1');
      expect(p.prompt_asset_ref).toEqual({
        asset_id: `mi-code.role.${role}`,
        asset_version: '1',
      });
      expect(p.completion_protocol_version).toBe('1');
      expect(p.verification_requirement).toBe('V2');
      expect(p.required_capabilities).toEqual([]);
      // purpose must be a non-empty string (sourced from ROLE_REGISTRY.whenToUse)
      expect(typeof p.purpose).toBe('string');
      expect(p.purpose.length).toBeGreaterThan(0);
    },
  );

  it('explore profile lists the explore whitelist as requested_tool_ids', () => {
    const p = roleToAgentRoleProfile('explore');
    expect(p.requested_tool_ids).toContain('read_file');
    expect(p.requested_tool_ids).toContain('run_bash');
    expect(p.requested_tool_ids).toContain('read_plan_file');
    // explore whitelist never contains write tools
    expect(p.requested_tool_ids).not.toContain('write_file');
    expect(p.requested_tool_ids).not.toContain('write_plan_file');
  });

  it('general profile requests empty tool list (tools === "*")', () => {
    // '*' means "all" — represented as [] (defer to final tool view)
    const p = roleToAgentRoleProfile('general');
    expect(p.requested_tool_ids).toEqual([]);
  });

  it('plan profile includes write_plan_file in requested_tool_ids', () => {
    const p = roleToAgentRoleProfile('plan');
    expect(p.requested_tool_ids).toContain('write_plan_file');
    expect(p.requested_tool_ids).toContain('read_file');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enhanceSubagentSystemPrompt: environment param
// ─────────────────────────────────────────────────────────────────────────────

describe('enhanceSubagentSystemPrompt: environment parameter', () => {
  /** Build a deterministic snapshot independent of process.env. */
  function syntheticSnapshot(platform: string, workspace: string): NormalizedEnvironmentSnapshot {
    return normalizeEnvironmentSnapshot(
      {
        environment_snapshot_id: 'subagent-env-test-1',
        platform_family: platform,
        shell_family: '/bin/zsh',
        workspace_root: workspace,
        working_directory: workspace,
        repository_present: true,
        observed_at: '2026-07-26T00:00:00.000Z',
        collected_fields: {},
      },
      { allowed_fields: new Set(), privacy_omitted_fields: new Set() },
    );
  }

  it('reflects the provided NormalizedEnvironmentSnapshot (linux + /tmp/repo)', () => {
    const env = syntheticSnapshot('linux', '/tmp/repo');
    const out = enhanceSubagentSystemPrompt('base', { environment: env });
    // Must echo the snapshot's values, not the real process.* values.
    // Use env.platform_family / env.workspace_root (canonicalized by normalize)
    // rather than the raw input — normalizeEnvironmentSnapshot resolves paths.
    expect(out).toContain('platform_family: linux');
    expect(out).toContain('workspace_root: ' + env.workspace_root);
    expect(out).toContain('working_directory: ' + env.workspace_root);
    expect(out).toContain('repository_present: true');
    expect(out).toContain('shell_family: /bin/zsh');
    // Must NOT contain the legacy "Working directory:" / "Platform:" lines
    // (those come from the process.env reading path).
    expect(out).not.toMatch(/^- Working directory:/m);
    expect(out).not.toMatch(/^- Platform:/m);
  });

  it('on darwin snapshot, platform_family reflects darwin not the real runner', () => {
    // Even if the test runner IS win32, this asserts the output is driven
    // by the snapshot, not by process.platform directly.
    const env = syntheticSnapshot('darwin', '/Users/x/repo');
    const out = enhanceSubagentSystemPrompt('base', { environment: env });
    expect(out).toContain('platform_family: darwin');
    // workspace_root is canonicalized by normalize; assert against the snapshot value.
    expect(out).toContain('workspace_root: ' + env.workspace_root);
  });

  it('legacy path (no environment param) still works without throwing', () => {
    // Don't assert on exact process.cwd values; just ensure the function
    // still produces output. The legacy path reads process.* — that's
    // documented as legacy and Wave C+ callers should pass environment.
    const out = enhanceSubagentSystemPrompt('base');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('Platform:');
    expect(out).toContain('Shell:');
    expect(out).toContain('git repository');
  });

  it('legacy path still appends skillsDescription', () => {
    const out = enhanceSubagentSystemPrompt('base', { skillsDescription: 'my-skill: x' });
    expect(out).toContain('my-skill');
  });

  it('environment path still appends skillsDescription', () => {
    const env = syntheticSnapshot('linux', '/tmp/repo');
    const out = enhanceSubagentSystemPrompt('base', {
      environment: env,
      skillsDescription: 'env-skill: y',
    });
    expect(out).toContain('env-skill');
  });
});
