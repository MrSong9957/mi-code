// ERC-4 / M-065 Pre-Spawn Revalidation — 单元测试
//
// 物理本质:spawn 前的"最后一道 TOCTOU 防线"。在 plan ready 与 permission allow
// 之后、实际 spawn 之前,重新 realpath/stat/hash 已解析的 executable,确认文件
// identity 未被篡改。只有 `match` 可继续;changed/missing/unsupported 使旧
// approval 失效。executeSanitizedCommand 把 plan + revalidation + permission
// 三者用硬 AND 组合,决定 spawn / deny / ask_required。
//
// 关键不变量(spec ERC-4 Step 3/5/6 + 计划 Task 14):
//   1. spawn 前重新 realpath/stat/hash(TOCTOU 防御);
//   2. 只有 match 可继续;changed/missing/unsupported 使旧 approval 失效;
//   3. 自动重新解析必须创建新 action snapshot 和新 SecurityDecision(本函数返回
//      denied/missing/changed/unsupported,由调用方重新走流程);
//   4. shell:false 执行——绝不把原始 command 重新传给 shell:true;
//   5. ask 必须等待;ask unavailable / stale decision / plan/action mismatch 均 deny;
//   6. spawn 同时验证 current plan / current permission / current identity。

import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTABLE_RESOLUTION_PROTOCOL_VERSION,
  SANITIZED_PLAN_PROTOCOL_VERSION,
  revalidateExecutableIdentity,
  executeSanitizedCommand,
  type ExecutableResolutionResult,
  type InlineEnvironmentDecision,
  type PlatformFamily,
  type PlatformResolutionAdapter,
  type RevalidationResult,
  type RevalidationStatus,
  type SanitizedExecutionPlan,
  type ExecuteSanitizedCommandInput,
} from '../../permission/executable-environment.js';
import type { CommandStructuralDecision } from '../../permission/command-policy.js';

// ─────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────

const PLATFORM: PlatformFamily = 'linux';

const FIXED_STAT = {
  dev: 2051,
  ino: 1234567,
  size: 42_000_000,
  mtime: new Date('2025-01-01T00:00:00.000Z'),
  mode: 0o755,
  isSymbolicLink: false,
};

/** 计算 canonical identity 的 hash —— 与 implementation 同算法,用于构造 previous_hash。 */
function computeIdentityHash(stat: typeof FIXED_STAT, platform: PlatformFamily): string {
  const identity = {
    canonical_path: '/usr/bin/node',
    platform,
    dev: platform === 'win32' ? null : String(stat.dev ?? ''),
    ino: platform === 'win32' ? null : String(stat.ino ?? ''),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    mode: stat.mode,
    is_symlink: stat.isSymbolicLink,
    symlink_target: stat.isSymbolicLink ? '/usr/bin/node' : null,
  };
  // sha256
  // 用 node:crypto 在测试侧自行计算,避免 import 私有 helper
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
}

const PREVIOUS_HASH = computeIdentityHash(FIXED_STAT, PLATFORM);

/** mock PlatformResolutionAdapter —— 默认 realpath/stat/access 成功,hash 与 previous 一致。 */
function makeFakeAdapter(
  overrides: Partial<{
    realpath: (p: string) => Promise<string>;
    stat: (p: string) => Promise<typeof FIXED_STAT>;
    access: (p: string) => Promise<boolean>;
    getUnsupportedReason: (platform: PlatformFamily) => string | null;
  }> = {},
): PlatformResolutionAdapter & {
  realpath: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  access: ReturnType<typeof vi.fn>;
  getUnsupportedReason: ReturnType<typeof vi.fn>;
} {
  const adapter = {
    getUnsupportedReason: vi.fn(overrides.getUnsupportedReason ?? (() => null)),
    realpath: vi.fn(overrides.realpath ?? (async (p: string) => p)),
    stat: vi.fn(overrides.stat ?? (async () => ({ ...FIXED_STAT }))),
    access: vi.fn(overrides.access ?? (async () => true)),
    searchPath: vi.fn(async () => [] as string[]),
  };
  return adapter as unknown as PlatformResolutionAdapter & {
    realpath: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    access: ReturnType<typeof vi.fn>;
    getUnsupportedReason: ReturnType<typeof vi.fn>;
  };
}

function greenInlineDecision(): InlineEnvironmentDecision {
  return {
    inline_decision_protocol_version: '1',
    decision_id: 'inline-env:green',
    action_snapshot_id: 'snap-1',
    platform: PLATFORM,
    control_mode: 'build',
    classifications: [],
    actions: [],
    aggregated_action: 'preserve',
    reason_codes: [],
  };
}

function greenResolutionResult(hash: string = PREVIOUS_HASH): ExecutableResolutionResult {
  return {
    resolution_protocol_version: EXECUTABLE_RESOLUTION_PROTOCOL_VERSION,
    resolution_id: 'exec-res:green',
    action_snapshot_id: 'snap-1',
    status: 'resolved',
    resolved_canonical_path: '/usr/bin/node',
    file_identity_ref: `exec-identity:${hash.slice(0, 16)}`,
    content_or_metadata_hash: hash,
    candidate_provenance: { raw_name: 'node', resolution_method: 'path_search' },
    reason_codes: ['executable.resolved'],
  };
}

function greenStructuralDecision(): CommandStructuralDecision {
  return {
    structural_decision_protocol_version: '1',
    structural_decision_id: 'structural:green',
    action_snapshot_id: 'snap-1',
    parse_result_id: 'parse:green',
    policy_state_ref: 'policy-state:1',
    mode: 'enforced',
    candidate_behavior: 'allow',
    effective_security_decision_ref: 'cmd:snap-1:allow',
    gate_decision_refs: [],
    reason_codes: ['gate.all_allow'],
    status: 'valid',
  };
}

/** 构造一个 ready_for_permission 的 plan(canonical_path + literal_argv 都绑定)。 */
function readyPlan(
  overrides: Partial<SanitizedExecutionPlan> = {},
): SanitizedExecutionPlan {
  return {
    plan_protocol_version: SANITIZED_PLAN_PROTOCOL_VERSION,
    plan_id: 'plan:ready',
    action_snapshot_id: 'snap-1',
    status: 'ready_for_permission',
    inherited_environment_ref: 'inherited-env:scrubbed-1',
    structural_decision_id: 'structural:green',
    inline_decision_id: 'inline-env:green',
    executable_resolution_id: 'exec-res:green',
    required_security_decision_ref: 'rc5:snap-1:allow',
    preserved_assignment_ids: [],
    stripped_assignment_ids: [],
    resolved_canonical_path: '/usr/bin/node',
    effective_environment_ref: 'inherited-env:scrubbed-1',
    literal_argv: ['-v'],
    reason_codes: ['plan.ready_for_permission'],
    ...overrides,
  };
}

/** 直接构造一个 RevalidationResult(跳过 revalidateExecutableIdentity)。 */
function revalidationResult(
  overrides: Partial<RevalidationResult> = {},
): RevalidationResult {
  return {
    revalidation_protocol_version: 'erc-4-revalidate-v1',
    revalidation_id: 'revalidate:match',
    action_snapshot_id: 'snap-1',
    status: 'match',
    current_content_or_metadata_hash: PREVIOUS_HASH,
    previous_content_or_metadata_hash: PREVIOUS_HASH,
    reason_codes: ['revalidation.match'],
    ...overrides,
  };
}

/** 一个 mock spawn —— 记录被调用参数,返回成功结果。 */
function makeSpawnSpy() {
  return vi.fn(
    async (
      _canonicalPath: string,
      _argv: string[],
      _options: { shell: false; env: Record<string, string>; cwd: string; windowsHide: true },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => ({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: revalidateExecutableIdentity — 四态矩阵
// ═══════════════════════════════════════════════════════════════════════════

describe('revalidateExecutableIdentity — 四态矩阵 (Step 3)', () => {
  it('match when current hash equals previous hash', async () => {
    const adapter = makeFakeAdapter(); // stat 返回 FIXED_STAT → hash === PREVIOUS_HASH
    const result = await revalidateExecutableIdentity({
      revalidation_protocol_version: 'erc-4-revalidate-v1',
      action_snapshot_id: 'snap-1',
      plan: readyPlan(),
      previous_resolution: greenResolutionResult(PREVIOUS_HASH),
      platform_adapter: adapter,
    });
    expect(result.status).toBe('match');
    expect(result.current_content_or_metadata_hash).toBe(PREVIOUS_HASH);
    expect(result.previous_content_or_metadata_hash).toBe(PREVIOUS_HASH);
  });

  it('changed when current hash differs from previous hash', async () => {
    // stat 返回不同 size → 不同 hash
    const adapter = makeFakeAdapter({
      stat: async () => ({ ...FIXED_STAT, size: 99_999_999 }),
    });
    const result = await revalidateExecutableIdentity({
      revalidation_protocol_version: 'erc-4-revalidate-v1',
      action_snapshot_id: 'snap-1',
      plan: readyPlan(),
      previous_resolution: greenResolutionResult(PREVIOUS_HASH),
      platform_adapter: adapter,
    });
    expect(result.status).toBe('changed');
    expect(result.current_content_or_metadata_hash).not.toBe(PREVIOUS_HASH);
    expect(result.previous_content_or_metadata_hash).toBe(PREVIOUS_HASH);
  });

  it('missing when realpath throws ENOENT', async () => {
    const adapter = makeFakeAdapter({
      realpath: async () => {
        const e = new Error('no such file');
        (e as { code?: string }).code = 'ENOENT';
        throw e;
      },
    });
    const result = await revalidateExecutableIdentity({
      revalidation_protocol_version: 'erc-4-revalidate-v1',
      action_snapshot_id: 'snap-1',
      plan: readyPlan(),
      previous_resolution: greenResolutionResult(PREVIOUS_HASH),
      platform_adapter: adapter,
    });
    expect(result.status).toBe('missing');
    expect(result.current_content_or_metadata_hash).toBeNull();
  });

  it('missing when stat throws ENOENT', async () => {
    const adapter = makeFakeAdapter({
      stat: async () => {
        const e = new Error('no such file');
        (e as { code?: string }).code = 'ENOENT';
        throw e;
      },
    });
    const result = await revalidateExecutableIdentity({
      revalidation_protocol_version: 'erc-4-revalidate-v1',
      action_snapshot_id: 'snap-1',
      plan: readyPlan(),
      previous_resolution: greenResolutionResult(PREVIOUS_HASH),
      platform_adapter: adapter,
    });
    expect(result.status).toBe('missing');
  });

  it('unsupported when platform adapter capability missing', async () => {
    const adapter = makeFakeAdapter({
      getUnsupportedReason: () => 'windows:ads_8.3_long_path_capability_missing',
    });
    const result = await revalidateExecutableIdentity({
      revalidation_protocol_version: 'erc-4-revalidate-v1',
      action_snapshot_id: 'snap-1',
      plan: readyPlan(),
      previous_resolution: greenResolutionResult(PREVIOUS_HASH),
      platform_adapter: adapter,
    });
    expect(result.status).toBe('unsupported');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: revalidateExecutableIdentity — plan 前置条件
// ═══════════════════════════════════════════════════════════════════════════

describe('revalidateExecutableIdentity — plan 前置条件', () => {
  it('unsupported when plan.status is not ready_for_permission', async () => {
    const adapter = makeFakeAdapter();
    const result = await revalidateExecutableIdentity({
      revalidation_protocol_version: 'erc-4-revalidate-v1',
      action_snapshot_id: 'snap-1',
      plan: readyPlan({ status: 'denied' }),
      previous_resolution: greenResolutionResult(PREVIOUS_HASH),
      platform_adapter: adapter,
    });
    expect(result.status).toBe('unsupported');
    expect(result.reason_codes).toContain('revalidation.plan_not_ready');
    // plan not ready → 不应触碰 fs
    expect(adapter.realpath).not.toHaveBeenCalled();
    expect(adapter.stat).not.toHaveBeenCalled();
  });

  it('missing when plan.resolved_canonical_path is null', async () => {
    const adapter = makeFakeAdapter();
    const result = await revalidateExecutableIdentity({
      revalidation_protocol_version: 'erc-4-revalidate-v1',
      action_snapshot_id: 'snap-1',
      plan: readyPlan({ resolved_canonical_path: null }),
      previous_resolution: greenResolutionResult(PREVIOUS_HASH),
      platform_adapter: adapter,
    });
    expect(result.status).toBe('missing');
    expect(result.reason_codes).toContain('revalidation.no_resolved_path');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: revalidateExecutableIdentity — 确定性与冻结
// ═══════════════════════════════════════════════════════════════════════════

describe('revalidateExecutableIdentity — 确定性与冻结', () => {
  it('produces deterministic revalidation_id for identical inputs', async () => {
    const makeInput = () => ({
      revalidation_protocol_version: 'erc-4-revalidate-v1',
      action_snapshot_id: 'snap-1',
      plan: readyPlan(),
      previous_resolution: greenResolutionResult(PREVIOUS_HASH),
      platform_adapter: makeFakeAdapter(),
    });
    const r1 = await revalidateExecutableIdentity(makeInput());
    const r2 = await revalidateExecutableIdentity(makeInput());
    expect(r2.revalidation_id).toBe(r1.revalidation_id);
    expect(r1.revalidation_id).toMatch(/^revalidate:[0-9a-f]{16}$/);
  });

  it('result is frozen', async () => {
    const result = await revalidateExecutableIdentity({
      revalidation_protocol_version: 'erc-4-revalidate-v1',
      action_snapshot_id: 'snap-1',
      plan: readyPlan(),
      previous_resolution: greenResolutionResult(PREVIOUS_HASH),
      platform_adapter: makeFakeAdapter(),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('throws when action_snapshot_id is empty', async () => {
    await expect(
      revalidateExecutableIdentity({
        revalidation_protocol_version: 'erc-4-revalidate-v1',
        action_snapshot_id: '',
        plan: readyPlan(),
        previous_resolution: greenResolutionResult(PREVIOUS_HASH),
        platform_adapter: makeFakeAdapter(),
      }),
    ).rejects.toThrow(/action_snapshot_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: executeSanitizedCommand — TOCTOU 防线(identity 非 match 不 spawn)
// ═══════════════════════════════════════════════════════════════════════════

describe('executeSanitizedCommand — TOCTOU 防线 (Step 5/6)', () => {
  it.each(['changed', 'missing', 'unsupported'] as const)(
    'does not spawn when executable identity is %s',
    async (status) => {
      const spawnSpy = makeSpawnSpy();
      const result = await executeSanitizedCommand({
        plan: readyPlan(),
        revalidation: revalidationResult({ status }),
        spawn: spawnSpy,
        current_permission_allows: true,
        effective_environment: { PATH: '/usr/bin' },
        working_directory: '/work',
      });
      expect(result.status).toBe('denied');
      expect(result.reason_codes).toContain(`execution.revalidation_${status}`);
      expect(spawnSpy).not.toHaveBeenCalled();
    },
  );

  it('spawns with shell:false when all gates pass (revalidation match)', async () => {
    const spawnSpy = makeSpawnSpy();
    const result = await executeSanitizedCommand({
      plan: readyPlan(),
      revalidation: revalidationResult({ status: 'match' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    expect(result.status).toBe('executed');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    // 关键不变量:shell === false(不是 true)
    const callArgs = spawnSpy.mock.calls[0];
    expect(callArgs?.[2]?.shell).toBe(false);
    expect(result.spawn_result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  });

  it('passes resolved_canonical_path + literal_argv (not raw command)', async () => {
    const spawnSpy = makeSpawnSpy();
    await executeSanitizedCommand({
      plan: readyPlan({ resolved_canonical_path: '/usr/bin/node', literal_argv: ['-e', 'console.log(1)'] }),
      revalidation: revalidationResult({ status: 'match' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    const [path, argv] = spawnSpy.mock.calls[0];
    // canonical path,不是 'node' 或 raw command
    expect(path).toBe('/usr/bin/node');
    // literal argv,不含可执行名本身
    expect(argv).toEqual(['-e', 'console.log(1)']);
  });

  it('passes env / cwd / windowsHide to spawn', async () => {
    const spawnSpy = makeSpawnSpy();
    await executeSanitizedCommand({
      plan: readyPlan(),
      revalidation: revalidationResult({ status: 'match' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin', NODE_ENV: 'test' },
      working_directory: '/custom/work',
    });
    const opts = spawnSpy.mock.calls[0]?.[2];
    expect(opts?.cwd).toBe('/custom/work');
    expect(opts?.env).toEqual({ PATH: '/usr/bin', NODE_ENV: 'test' });
    expect(opts?.windowsHide).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: executeSanitizedCommand — deny / ask 矩阵
// ═══════════════════════════════════════════════════════════════════════════

describe('executeSanitizedCommand — deny / ask 矩阵', () => {
  it('denies when plan.status is not ready_for_permission', async () => {
    const spawnSpy = makeSpawnSpy();
    const result = await executeSanitizedCommand({
      plan: readyPlan({ status: 'ask_required' }),
      revalidation: revalidationResult({ status: 'match' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('execution.plan_not_ready');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('ask_required when permission not allowing and ask channel available', async () => {
    const spawnSpy = makeSpawnSpy();
    const result = await executeSanitizedCommand({
      plan: readyPlan(),
      revalidation: revalidationResult({ status: 'match' }),
      spawn: spawnSpy,
      current_permission_allows: false,
      ask_channel_available: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    expect(result.status).toBe('ask_required');
    expect(result.reason_codes).toContain('execution.permission_ask');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('denies when ask unavailable and permission requires ask', async () => {
    const spawnSpy = makeSpawnSpy();
    const result = await executeSanitizedCommand({
      plan: readyPlan(),
      revalidation: revalidationResult({ status: 'match' }),
      spawn: spawnSpy,
      current_permission_allows: false,
      ask_channel_available: false,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('execution.permission_ask_unavailable');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('denies when plan and revalidation action_snapshot_id mismatch (plan/revalidation mismatch)', async () => {
    const spawnSpy = makeSpawnSpy();
    const result = await executeSanitizedCommand({
      plan: readyPlan({ action_snapshot_id: 'snap-1' }),
      revalidation: revalidationResult({ action_snapshot_id: 'snap-other' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('execution.snapshot_mismatch');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('denies when current_action_snapshot_id differs from plan (plan/action mismatch)', async () => {
    const spawnSpy = makeSpawnSpy();
    const result = await executeSanitizedCommand({
      plan: readyPlan({ action_snapshot_id: 'snap-1' }),
      revalidation: revalidationResult({ action_snapshot_id: 'snap-1' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      current_action_snapshot_id: 'snap-new',
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('execution.plan_action_mismatch');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('denies when permission decision snapshot differs from plan (stale decision)', async () => {
    const spawnSpy = makeSpawnSpy();
    const result = await executeSanitizedCommand({
      plan: readyPlan({ action_snapshot_id: 'snap-1' }),
      revalidation: revalidationResult({ action_snapshot_id: 'snap-1' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      permission_decision_snapshot_id: 'snap-stale',
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('execution.stale_decision');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('denies when plan.literal_argv is null (defensive TOCTOU)', async () => {
    const spawnSpy = makeSpawnSpy();
    const result = await executeSanitizedCommand({
      plan: readyPlan({ literal_argv: null }),
      revalidation: revalidationResult({ status: 'match' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('execution.no_literal_argv');
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 6: executeSanitizedCommand — 确定性
// ═══════════════════════════════════════════════════════════════════════════

describe('executeSanitizedCommand — 确定性与冻结', () => {
  it('produces deterministic execution_id for identical inputs', async () => {
    const spawnSpy = makeSpawnSpy();
    const input: ExecuteSanitizedCommandInput = {
      plan: readyPlan(),
      revalidation: revalidationResult({ status: 'match' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    };
    const r1 = await executeSanitizedCommand(input);
    const r2 = await executeSanitizedCommand(input);
    expect(r2.execution_id).toBe(r1.execution_id);
    expect(r1.execution_id).toMatch(/^exec:[0-9a-f]{16}$/);
  });

  it('result is frozen', async () => {
    const spawnSpy = makeSpawnSpy();
    const result = await executeSanitizedCommand({
      plan: readyPlan(),
      revalidation: revalidationResult({ status: 'match' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
