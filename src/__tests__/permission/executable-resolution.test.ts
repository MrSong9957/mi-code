// ERC-4 / M-065 Executable Resolution — 单元测试
//
// 物理本质:把 ExecutableCandidate 解析为可验证的 file identity(或 fail-closed
// 状态)。Resolver 不 spawn、不近似前缀匹配;只通过注入的 PlatformResolutionAdapter
// 做 realpath / stat / access / PATH search。
//
// 关键不变量(spec §10.6 / 计划 Task 12 + ERC-4):
//   1. resolved 只产生 identity,不产生 trusted / allow;
//   2. 不 spawn binary——即使 adapter 暴露 spawn 方法,Resolver 也不调用;
//   3. inline_decision deny → 立即 denied(spec §10.9 AND 防线);
//   4. PATH search 用 effective_environment.env(已 scrubbed + inline decided);
//   5. multiple candidate → ambiguous;zero → not_found;不近似前缀匹配;
//   6. Windows ADS / 8.3 / long-path 能力不足 → unsupported,不宣称覆盖 M-068;
//   7. content_or_metadata_hash 是 identity 的 SHA-256;
//   8. resolution_id 由 canonical 字段确定性派生。

import { describe, expect, it, vi } from 'vitest';
import {
  INLINE_ENVIRONMENT_PROTOCOL_VERSION,
  resolveExecutableIdentity,
  type ExecutableResolutionInput,
  type ExecutableResolutionResult,
  type InlineEnvironmentDecision,
  type PlatformFamily,
  type PlatformResolutionAdapter,
} from '../../permission/executable-environment.js';

// ─────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────

/** 固定的 file stat 返回值(便于 deterministic hash)。 */
const FIXED_STAT = {
  dev: 2051,
  ino: 1234567,
  size: 42_000_000,
  mtime: new Date('2025-01-01T00:00:00.000Z'),
  mode: 0o755,
  isSymbolicLink: false,
};

/**
 * 构造一个 mock PlatformResolutionAdapter。
 *
 * 默认所有方法都成功;调用方可通过 overrides 改变任何方法的行为,
 * 或让 realpath/stat 抛 ENOENT 模拟文件不存在。
 *
 * 关键:adapter 上挂一个 `spawn` vi.fn()——Resolver 永远不应调用它
 * (INV:不 spawn binary)。测试断言 `spawn` 未被调用来验证该不变量。
 */
function makeFakeAdapter(
  overrides: Partial<{
    realpath: (p: string) => Promise<string>;
    stat: (p: string) => Promise<typeof FIXED_STAT>;
    access: (p: string) => Promise<boolean>;
    searchPath: (
      name: string,
      env: Record<string, string>,
      platform: PlatformFamily,
    ) => Promise<string[]>;
    getUnsupportedReason: (platform: PlatformFamily) => string | null;
  }> = {},
): PlatformResolutionAdapter & {
  spawn: ReturnType<typeof vi.fn>;
  // 把所有方法暴露为 spy,便于 toHaveBeenCalled 断言
  realpath: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  access: ReturnType<typeof vi.fn>;
  searchPath: ReturnType<typeof vi.fn>;
  getUnsupportedReason: ReturnType<typeof vi.fn>;
} {
  const spawn = vi.fn();
  const adapter = {
    spawn, // 不在 PlatformResolutionAdapter 类型上,仅供测试断言不被调用
    // 用 vi.fn 包默认实现 —— 这样既能调用,又能 toHaveBeenCalled / toHaveBeenCalledWith
    getUnsupportedReason: vi.fn(
      overrides.getUnsupportedReason ?? (() => null),
    ),
    realpath: vi.fn(
      overrides.realpath ??
        (async (p: string) =>
          p.replace(/\.lnk$/i, '').replace(/\/+$/, '') || p),
    ),
    stat: vi.fn(overrides.stat ?? (async () => ({ ...FIXED_STAT }))),
    access: vi.fn(overrides.access ?? (async () => true)),
    searchPath: vi.fn(overrides.searchPath ?? (async () => [] as string[])),
  };
  return adapter as unknown as PlatformResolutionAdapter & {
    spawn: ReturnType<typeof vi.fn>;
    realpath: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    access: ReturnType<typeof vi.fn>;
    searchPath: ReturnType<typeof vi.fn>;
    getUnsupportedReason: ReturnType<typeof vi.fn>;
  };
}

/** 构造一个 allow-through(无 inline assignment → aggregated_action=preserve)的 decision。 */
function allowThroughDecision(): InlineEnvironmentDecision {
  return {
    inline_decision_protocol_version: INLINE_ENVIRONMENT_PROTOCOL_VERSION,
    decision_id: 'inline-env:allow',
    action_snapshot_id: 'snap-1',
    platform: 'linux',
    control_mode: 'build',
    classifications: [],
    actions: [],
    aggregated_action: 'preserve',
    reason_codes: [],
  };
}

/** 构造一个 deny 的 inline decision(模拟 inline PATH=... 被拒)。 */
function deniedDecision(): InlineEnvironmentDecision {
  return {
    inline_decision_protocol_version: INLINE_ENVIRONMENT_PROTOCOL_VERSION,
    decision_id: 'inline-env:deny',
    action_snapshot_id: 'snap-1',
    platform: 'linux',
    control_mode: 'build',
    classifications: [],
    actions: [],
    aggregated_action: 'deny',
    reason_codes: ['action:deny_path_resolution'],
  };
}

const EXEC_PROTOCOL_VERSION = 'erc-4-exec-res-v1';

/** 构造 resolveExecutableIdentity 输入。 */
function makeInput(
  overrides: Partial<ExecutableResolutionInput> & {
    raw_name: string;
  },
): ExecutableResolutionInput {
  const platform: PlatformFamily = overrides.effective_environment?.platform ?? 'linux';
  return {
    resolution_protocol_version: EXEC_PROTOCOL_VERSION,
    action_snapshot_id: 'snap-1',
    candidate: {
      candidate_id: 'c-1',
      raw_name: overrides.raw_name,
      argv_after_name: ['-v'],
    },
    effective_environment:
      overrides.effective_environment ?? {
        env: { PATH: '/usr/bin:/bin' },
        platform,
        working_directory: '/work',
      },
    inline_decision: overrides.inline_decision ?? allowThroughDecision(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: 三种核心解析路径(direct / PATH search / ambiguous)
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveExecutableIdentity — 三种核心解析路径 (ERC-4)', () => {
  it.each([
    {
      label: 'direct path',
      input: makeInput({ raw_name: '/usr/bin/node' }),
      adapter: () =>
        makeFakeAdapter({
          realpath: async (p) => p,
        }),
      status: 'resolved' as const,
      reason: 'executable.direct_path',
    },
    {
      label: 'PATH search',
      input: makeInput({ raw_name: 'node' }),
      adapter: () =>
        makeFakeAdapter({
          searchPath: async () => ['/usr/bin/node'],
        }),
      status: 'resolved' as const,
      reason: 'executable.path_search',
    },
    {
      label: 'multiple matches (ambiguous)',
      input: makeInput({ raw_name: 'node' }),
      adapter: () =>
        makeFakeAdapter({
          searchPath: async () => ['/usr/bin/node', '/usr/local/bin/node'],
        }),
      status: 'ambiguous' as const,
      reason: 'executable.ambiguous',
    },
  ])(
    '$label → status=$status, reason=$reason, no spawn',
    async ({ input, adapter, status, reason }) => {
      const fake = adapter();
      const result = await resolveExecutableIdentity(input, fake);

      expect(result.status).toBe(status);
      expect(result.reason_codes).toContain(reason);
      // INV:Resolver 不 spawn binary
      expect(fake.spawn).not.toHaveBeenCalled();
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: fail-closed 状态矩阵
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveExecutableIdentity — fail-closed 状态矩阵', () => {
  it('PATH search 返回空 → not_found + executable.not_found', async () => {
    const fake = makeFakeAdapter({ searchPath: async () => [] });
    const result = await resolveExecutableIdentity(
      makeInput({ raw_name: 'nope-not-a-tool' }),
      fake,
    );
    expect(result.status).toBe('not_found');
    expect(result.reason_codes).toContain('executable.not_found');
    expect(result.resolved_canonical_path).toBeNull();
  });

  it('inline_decision deny → 立即 denied + executable.inline_denied (AND 防线)', async () => {
    const fake = makeFakeAdapter({
      // 即使 PATH 能搜到,resolver 也必须在 inline deny 前断流
      searchPath: async () => ['/usr/bin/node'],
    });
    const result = await resolveExecutableIdentity(
      makeInput({ raw_name: 'node', inline_decision: deniedDecision() }),
      fake,
    );
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('executable.inline_denied');
    // denied 短路:不应该走到 searchPath
    expect(fake.searchPath).not.toHaveBeenCalled();
  });

  it('direct path access(X_OK)=false → denied + executable.not_executable', async () => {
    const fake = makeFakeAdapter({
      realpath: async (p) => p,
      access: async () => false,
    });
    const result = await resolveExecutableIdentity(
      makeInput({ raw_name: '/usr/bin/node' }),
      fake,
    );
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('executable.not_executable');
  });

  it('direct path realpath ENOENT → not_found + executable.not_found', async () => {
    const fake = makeFakeAdapter({
      realpath: async () => {
        const e = new Error('no such file');
        (e as { code?: string }).code = 'ENOENT';
        throw e;
      },
    });
    const result = await resolveExecutableIdentity(
      makeInput({ raw_name: '/usr/bin/missing' }),
      fake,
    );
    expect(result.status).toBe('not_found');
    expect(result.reason_codes).toContain('executable.not_found');
  });

  it('platform capability 不足 → unsupported + executable.platform_unsupported (不宣称覆盖 M-068)', async () => {
    const fake = makeFakeAdapter({
      getUnsupportedReason: (platform) =>
        platform === 'win32'
          ? 'windows:ads_8.3_long_path_capability_missing'
          : null,
    });
    const result = await resolveExecutableIdentity(
      makeInput({
        raw_name: 'C:\\Windows\\System32\\cmd.exe',
        effective_environment: {
          env: { Path: 'C:\\Windows\\System32', PATHEXT: '.EXE' },
          platform: 'win32',
          working_directory: 'C:\\work',
        },
      }),
      fake,
    );
    expect(result.status).toBe('unsupported');
    expect(result.reason_codes).toContain('executable.platform_unsupported');
    // capability gate 短路:不应走到任何解析方法
    expect(fake.realpath).not.toHaveBeenCalled();
    expect(fake.searchPath).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: file identity 与 provenance
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveExecutableIdentity — file identity 与 provenance', () => {
  it('保留 symlink provenance:file_identity_ref 非空 + symlink_target 标识', async () => {
    const fake = makeFakeAdapter({
      realpath: async (p) => '/real/target/bin/node',
      stat: async () => ({
        dev: 2051,
        ino: 999,
        size: 100,
        mtime: new Date('2025-03-01T00:00:00.000Z'),
        mode: 0o777 | 0o120000, // symlink mode 位
        isSymbolicLink: true,
      }),
    });
    const result = await resolveExecutableIdentity(
      makeInput({ raw_name: '/usr/local/bin/node' }),
      fake,
    );
    expect(result.status).toBe('resolved');
    expect(result.file_identity_ref).not.toBeNull();
    expect(result.content_or_metadata_hash).not.toBeNull();
    // provenance 保留原 candidate 名
    expect(result.candidate_provenance.raw_name).toBe('/usr/local/bin/node');
    expect(result.candidate_provenance.resolution_method).toBe('direct_path');
  });

  it('content_or_metadata_hash 是 64 位 hex SHA-256', async () => {
    const fake = makeFakeAdapter();
    const result = await resolveExecutableIdentity(
      makeInput({ raw_name: '/usr/bin/node' }),
      fake,
    );
    expect(result.status).toBe('resolved');
    expect(result.content_or_metadata_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolution_id 由 canonical 字段确定性派生(同输入 → 同 id)', async () => {
    const fake1 = makeFakeAdapter();
    const fake2 = makeFakeAdapter();
    const input = makeInput({ raw_name: '/usr/bin/node' });
    const r1 = await resolveExecutableIdentity(input, fake1);
    const r2 = await resolveExecutableIdentity(input, fake2);
    expect(r2.resolution_id).toBe(r1.resolution_id);
    expect(r1.resolution_id).toMatch(/^exec-res:[0-9a-f]{16}$/);
  });

  it('不同 raw_name → 不同 resolution_id(避免身份碰撞)', async () => {
    const fake = makeFakeAdapter({
      realpath: async (p) => p,
    });
    const r1 = await resolveExecutableIdentity(
      makeInput({ raw_name: '/usr/bin/node' }),
      fake,
    );
    const r2 = await resolveExecutableIdentity(
      makeInput({ raw_name: '/usr/bin/python3' }),
      fake,
    );
    expect(r2.resolution_id).not.toBe(r1.resolution_id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: 不变量 — 不 spawn / 路径绑定 / 不参与 argv
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveExecutableIdentity — 不变量', () => {
  it('任何解析路径都不调用 spawn(不 spawn binary)', async () => {
    const fake = makeFakeAdapter({
      searchPath: async () => ['/usr/bin/node'],
    });
    await resolveExecutableIdentity(makeInput({ raw_name: 'node' }), fake);
    // PATH search resolved 也不 spawn
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('relative path(raw_name 含分隔符)绑定 working_directory snapshot', async () => {
    let seenByRealpath: string | null = null;
    const fake = makeFakeAdapter({
      realpath: async (p) => {
        seenByRealpath = p;
        return p;
      },
    });
    await resolveExecutableIdentity(
      makeInput({
        raw_name: './bin/foo',
        effective_environment: {
          env: { PATH: '/usr/bin' },
          platform: 'linux',
          working_directory: '/work',
        },
      }),
      fake,
    );
    expect(seenByRealpath).toContain('/work');
    expect(seenByRealpath).toContain('foo');
  });

  it('argv_after_name 不影响 resolution(只作 candidate provenance 字段)', async () => {
    const pathSearchAdapter = () =>
      makeFakeAdapter({ searchPath: async () => ['/usr/bin/node'] });
    const base = makeInput({ raw_name: 'node' });
    const withArgs: ExecutableResolutionInput = {
      ...base,
      candidate: {
        ...base.candidate,
        argv_after_name: ['--inspect', '--max-old-space-size=4096'],
      },
    };
    const r1 = await resolveExecutableIdentity(base, pathSearchAdapter());
    const r2 = await resolveExecutableIdentity(withArgs, pathSearchAdapter());
    // 不同 argv 不应改变 resolution_id(canonical 不含 argv)
    expect(r2.resolution_id).toBe(r1.resolution_id);
  });

  it('Windows: PATHEXT 必须从 effective_environment.env 取(传入 searchPath)', async () => {
    let receivedEnv: Record<string, string> | null = null;
    const fake = makeFakeAdapter({
      searchPath: async (_name, env) => {
        receivedEnv = env;
        return ['C:\\Windows\\System32\\node.exe'];
      },
    });
    const result = await resolveExecutableIdentity(
      makeInput({
        raw_name: 'node',
        effective_environment: {
          env: { Path: 'C:\\Windows\\System32', PATHEXT: '.EXE;.CMD' },
          platform: 'win32',
          working_directory: 'C:\\work',
        },
      }),
      fake,
    );
    expect(result.status).toBe('resolved');
    expect(receivedEnv).not.toBeNull();
    expect(receivedEnv!.PATHEXT).toBe('.EXE;.CMD');
  });

  it('PATH search resolved 的 candidate_provenance.resolution_method = path_search', async () => {
    const fake = makeFakeAdapter({
      searchPath: async () => ['/usr/bin/node'],
    });
    const result = await resolveExecutableIdentity(
      makeInput({ raw_name: 'node' }),
      fake,
    );
    expect(result.status).toBe('resolved');
    expect(result.candidate_provenance.resolution_method).toBe('path_search');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: 协议字段一致性
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveExecutableIdentity — 协议字段一致性', () => {
  it('result 透传 resolution_protocol_version 与 action_snapshot_id', async () => {
    const fake = makeFakeAdapter({ realpath: async (p) => p });
    const result = await resolveExecutableIdentity(
      makeInput({ raw_name: '/usr/bin/node' }),
      fake,
    );
    expect(result.resolution_protocol_version).toBe(EXEC_PROTOCOL_VERSION);
    expect(result.action_snapshot_id).toBe('snap-1');
  });

  it('result 是冻结的(freezeSnapshot 不可变)', async () => {
    const fake = makeFakeAdapter({ realpath: async (p) => p });
    const result = await resolveExecutableIdentity(
      makeInput({ raw_name: '/usr/bin/node' }),
      fake,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as ExecutableResolutionResult & { status: string }).status = 'denied';
    }).toThrow();
  });

  it('requireIdentity 守门:action_snapshot_id 为空字符串抛错', async () => {
    const fake = makeFakeAdapter();
    await expect(
      resolveExecutableIdentity(
        makeInput({ raw_name: '/usr/bin/node', action_snapshot_id: '' }),
        fake,
      ),
    ).rejects.toThrow(/action_snapshot_id/);
  });
});
