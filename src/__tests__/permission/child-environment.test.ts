// BRC-6 / M-063 子进程环境清洗——单元测试
//
// 物理本质：安检员的"通行名单"。
//   父进程的环境是一袋行李（含大量 secret：API_KEY、TOKEN、AWS_*）。
//   不能整袋甩给子进程——安检员按"显式名单"放行：
//     - required 名单里的，必须有（缺了就 deny，启动不能继续）；
//     - optional 名单里的，有就放行，没有不报错；
//     - denied_patterns（secret 模式）匹配的，永远剥离；
//     - 不在 allowed 集合里的，全部剥离（不继承）。
//   决策单只记录变量 NAME + reason code，绝不携带 secret VALUE。
//
// 重点不变量（spec §12.2）：
//   1. 父环境不得整包传入子进程；
//   2. allow/deny 按 launcher kind 审计，不照搬 Claude 变量列表；
//   3. 日志只记录变量名和 reason code，不记 secret value；
//   4. inline VAR=value 是 M-065，本测试只测继承环境；
//   5. scrubber 异常、policy 缺失、required 缺失或 unknown launcher → deny；
//   6. wrapper 所需变量必须以显式 required list 进入策略审计。

import { describe, expect, it } from 'vitest';
import {
  decideChildProcessEnvironment,
  getDefaultEnvironmentPolicy,
  type ChildProcessEnvironmentInput,
  type EnvironmentPolicy,
} from '../../permission/child-environment.js';

const windowsPolicy = getDefaultEnvironmentPolicy('win32');
const unixPolicy = getDefaultEnvironmentPolicy('linux');

/** 构造一份最小合法的 shell_tool/windows input（caller 可覆盖字段）。 */
const baseInput = (
  overrides: Partial<ChildProcessEnvironmentInput> = {},
): ChildProcessEnvironmentInput => ({
  launch_snapshot_id: 'launch-1',
  launcher_kind: 'shell_tool',
  executable_ref: 'cmd',
  parent_environment: {
    PATH: 'safe-path',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'cmd.exe',
  },
  required_variable_names: [],
  environment_policy_id: windowsPolicy.environment_policy_id,
  environment_policy_version: windowsPolicy.environment_policy_version,
  ...overrides,
});

// ─────────────────────────────────────────────
// allowed / removed 基线
// ─────────────────────────────────────────────

describe('decideChildProcessEnvironment - allow set & inheritance', () => {
  it('passes only explicitly allowed environment variables to spawn', () => {
    const result = decideChildProcessEnvironment(
      baseInput({
        launch_snapshot_id: 'launch-1',
        parent_environment: {
          PATH: 'safe-path',
          API_KEY: 'secret',
          TEMP: 'temp',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'cmd.exe',
        },
      }),
      windowsPolicy,
    );
    expect(result.sanitized_environment).toEqual(
      expect.objectContaining({ PATH: 'safe-path', TEMP: 'temp' }),
    );
    expect(result.sanitized_environment).not.toHaveProperty('API_KEY');
    expect(result.removed_variable_names).toContain('API_KEY');
  });

  it('shell_tool/windows includes required (PATH, SystemRoot, ComSpec) + optional when present', () => {
    const result = decideChildProcessEnvironment(
      baseInput({
        parent_environment: {
          PATH: 'p',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'cmd.exe',
          PATHEXT: '.exe',
          TEMP: 'T',
          TMP: 'T2',
        },
      }),
      windowsPolicy,
    );
    expect(result.sanitized_environment).toEqual(
      expect.objectContaining({
        PATH: 'p',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'cmd.exe',
        PATHEXT: '.exe',
        TEMP: 'T',
        TMP: 'T2',
      }),
    );
    // allowed_variable_names is frozen — copy before sort.
    expect([...result.allowed_variable_names].sort()).toEqual(
      ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'].sort(),
    );
  });

  it('optional missing is fine (just not included)', () => {
    const result = decideChildProcessEnvironment(
      baseInput({
        parent_environment: {
          PATH: 'p',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'cmd.exe',
        },
      }),
      windowsPolicy,
    );
    expect(result.sanitized_environment).not.toHaveProperty('TEMP');
    expect(result.sanitized_environment).not.toHaveProperty('TMP');
    expect(result.sanitized_environment).not.toHaveProperty('PATHEXT');
    expect(result.missing_required_variable_names).toEqual([]);
  });

  it('removed_variable_names includes parent vars not in allowed set', () => {
    const result = decideChildProcessEnvironment(
      baseInput({
        parent_environment: {
          PATH: 'p',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'cmd.exe',
          MY_CUSTOM_VAR: 'whatever',
          ANOTHER_HARMLESS_VAR: 'x',
        },
      }),
      windowsPolicy,
    );
    // Parent vars not in the allowed set are simply not inherited — names recorded.
    expect(result.removed_variable_names).toContain('MY_CUSTOM_VAR');
    expect(result.removed_variable_names).toContain('ANOTHER_HARMLESS_VAR');
    expect(result.sanitized_environment).not.toHaveProperty('MY_CUSTOM_VAR');
  });
});

// ─────────────────────────────────────────────
// denied_patterns (secret scrubbing)
// ─────────────────────────────────────────────

describe('decideChildProcessEnvironment - denied_patterns scrub secrets', () => {
  const cases: Array<{ name: string; varName: string; pattern: string }> = [
    { name: 'API_KEY matches _API_KEY$', varName: 'MY_API_KEY', pattern: '/^.*_API_KEY$/i' },
    { name: 'TOKEN matches _TOKEN$', varName: 'GITHUB_TOKEN', pattern: '/^.*_TOKEN$/i' },
    { name: 'SECRET matches _SECRET$', varName: 'DB_SECRET', pattern: '/^.*_SECRET$/i' },
    { name: 'PASSWORD exactly', varName: 'PASSWORD', pattern: '/^PASSWORD$/i' },
    { name: 'AWS_* prefix', varName: 'AWS_SECRET_ACCESS_KEY', pattern: '/^AWS_.*$/i' },
    { name: 'AZURE_* prefix', varName: 'AZURE_CLIENT_SECRET', pattern: '/^AZURE_.*$/i' },
    {
      name: 'GOOGLE_APPLICATION_CREDENTIALS exactly',
      varName: 'GOOGLE_APPLICATION_CREDENTIALS',
      pattern: '/^GOOGLE_APPLICATION_CREDENTIALS$/i',
    },
  ];

  for (const c of cases) {
    it(`${c.name} (${c.varName}) is removed even if added to optional set`, () => {
      // Build a policy that explicitly allows the secret name as optional —
      // denied_patterns must STILL strip it (patterns override allowed).
      const policyWithSecretAllowed: EnvironmentPolicy = {
        environment_policy_id: 'test-policy',
        environment_policy_version: '1',
        required: { shell_tool: ['PATH', 'SystemRoot', 'ComSpec'] },
        optional: {
          shell_tool: ['PATHEXT', 'TEMP', 'TMP', c.varName],
        },
        denied_patterns: windowsPolicy.denied_patterns,
      };
      const result = decideChildProcessEnvironment(
        baseInput({
          parent_environment: {
            PATH: 'p',
            SystemRoot: 'C:\\Windows',
            ComSpec: 'cmd.exe',
            [c.varName]: 'super-secret-value',
          },
          environment_policy_id: policyWithSecretAllowed.environment_policy_id,
          environment_policy_version: policyWithSecretAllowed.environment_policy_version,
        }),
        policyWithSecretAllowed,
      );
      expect(result.sanitized_environment).not.toHaveProperty(c.varName);
      expect(result.removed_variable_names).toContain(c.varName);
    });
  }

  it('does NOT scrub benign allowed vars that do not match patterns', () => {
    const result = decideChildProcessEnvironment(
      baseInput({
        parent_environment: {
          PATH: 'p',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'cmd.exe',
          TEMP: 't',
        },
      }),
      windowsPolicy,
    );
    expect(result.sanitized_environment).toHaveProperty('TEMP', 't');
    expect(result.removed_variable_names).not.toContain('TEMP');
  });
});

// ─────────────────────────────────────────────
// required var missing → deny
// ─────────────────────────────────────────────

describe('decideChildProcessEnvironment - required var missing denies launch', () => {
  it('missing required PATH → sanitized_environment null + missing_required contains PATH', () => {
    const result = decideChildProcessEnvironment(
      baseInput({
        launch_snapshot_id: 'launch-missing',
        // windows required: PATH, SystemRoot, ComSpec — drop PATH
        parent_environment: {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'cmd.exe',
        },
      }),
      windowsPolicy,
    );
    expect(result.sanitized_environment).toBeNull();
    expect(result.missing_required_variable_names).toContain('PATH');
  });

  it('missing required SystemRoot on windows → deny', () => {
    const result = decideChildProcessEnvironment(
      baseInput({
        parent_environment: {
          PATH: 'p',
          ComSpec: 'cmd.exe',
        },
      }),
      windowsPolicy,
    );
    expect(result.sanitized_environment).toBeNull();
    expect(result.missing_required_variable_names).toContain('SystemRoot');
  });

  it('unix: missing required PATH → deny', () => {
    const unixInput: ChildProcessEnvironmentInput = {
      launch_snapshot_id: 'launch-unix',
      launcher_kind: 'shell_tool',
      executable_ref: '/bin/sh',
      parent_environment: { HOME: '/h', SHELL: '/bin/sh' },
      required_variable_names: [],
      environment_policy_id: unixPolicy.environment_policy_id,
      environment_policy_version: unixPolicy.environment_policy_version,
    };
    const result = decideChildProcessEnvironment(unixInput, unixPolicy);
    expect(result.sanitized_environment).toBeNull();
    expect(result.missing_required_variable_names).toContain('PATH');
  });

  it('caller-asserted extra required var (merged with policy.required) missing → deny', () => {
    // Caller can require extra vars beyond the policy default.
    const result = decideChildProcessEnvironment(
      baseInput({
        required_variable_names: ['MY_TOOL_REQUIRED'],
        parent_environment: {
          PATH: 'p',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'cmd.exe',
          // MY_TOOL_REQUIRED intentionally absent
        },
      }),
      windowsPolicy,
    );
    expect(result.sanitized_environment).toBeNull();
    expect(result.missing_required_variable_names).toContain('MY_TOOL_REQUIRED');
  });
});

// ─────────────────────────────────────────────
// unix policy shape
// ─────────────────────────────────────────────

describe('decideChildProcessEnvironment - unix policy variant', () => {
  it('unix PATH required, HOME/TMPDIR/SHELL/LANG/LC_ALL optional', () => {
    const result = decideChildProcessEnvironment(
      {
        launch_snapshot_id: 'launch-unix-1',
        launcher_kind: 'shell_tool',
        executable_ref: '/bin/sh',
        parent_environment: {
          PATH: '/usr/bin',
          HOME: '/home/u',
          TMPDIR: '/tmp',
          SHELL: '/bin/bash',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
        },
        required_variable_names: [],
        environment_policy_id: unixPolicy.environment_policy_id,
        environment_policy_version: unixPolicy.environment_policy_version,
      },
      unixPolicy,
    );
    expect(result.sanitized_environment).toEqual(
      expect.objectContaining({
        PATH: '/usr/bin',
        HOME: '/home/u',
        TMPDIR: '/tmp',
        SHELL: '/bin/bash',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      }),
    );
    expect(result.missing_required_variable_names).toEqual([]);
  });

  it('unix optional missing is fine', () => {
    const result = decideChildProcessEnvironment(
      {
        launch_snapshot_id: 'launch-unix-2',
        launcher_kind: 'shell_tool',
        executable_ref: '/bin/sh',
        parent_environment: { PATH: '/usr/bin' },
        required_variable_names: [],
        environment_policy_id: unixPolicy.environment_policy_id,
        environment_policy_version: unixPolicy.environment_policy_version,
      },
      unixPolicy,
    );
    expect(result.sanitized_environment).toEqual({ PATH: '/usr/bin' });
    expect(result.missing_required_variable_names).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// launcher_kind
// ─────────────────────────────────────────────

describe('decideChildProcessEnvironment - launcher_kind', () => {
  it('background launcher_kind works on windows (same required set)', () => {
    const result = decideChildProcessEnvironment(
      baseInput({
        launcher_kind: 'background',
        executable_ref: 'cmd',
      }),
      windowsPolicy,
    );
    expect(result.sanitized_environment).toEqual(
      expect.objectContaining({
        PATH: 'safe-path',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'cmd.exe',
      }),
    );
  });

  it('unknown launcher_kind → deny (sanitized_environment null)', () => {
    const result = decideChildProcessEnvironment(
      baseInput({
        // simulate a smuggled malicious launcher kind
        launcher_kind: 'malicious' as 'shell_tool',
      }),
      windowsPolicy,
    );
    expect(result.sanitized_environment).toBeNull();
  });

  it('launcher_kind unknown to policy (but valid union member) → deny', () => {
    // Construct a policy that only defines shell_tool, then call with background.
    const shellOnlyPolicy: EnvironmentPolicy = {
      environment_policy_id: 'shell-only',
      environment_policy_version: '1',
      required: { shell_tool: ['PATH'] },
      optional: { shell_tool: [] },
      denied_patterns: unixPolicy.denied_patterns,
    };
    const result = decideChildProcessEnvironment(
      {
        launch_snapshot_id: 'launch-bg',
        launcher_kind: 'background',
        executable_ref: 'cmd',
        parent_environment: { PATH: 'p' },
        required_variable_names: [],
        environment_policy_id: shellOnlyPolicy.environment_policy_id,
        environment_policy_version: shellOnlyPolicy.environment_policy_version,
      },
      shellOnlyPolicy,
    );
    expect(result.sanitized_environment).toBeNull();
  });
});

// ─────────────────────────────────────────────
// identity validation
// ─────────────────────────────────────────────

describe('decideChildProcessEnvironment - identity validation', () => {
  it('empty launch_snapshot_id → throws', () => {
    expect(() =>
      decideChildProcessEnvironment(baseInput({ launch_snapshot_id: '' }), windowsPolicy),
    ).toThrow();
  });

  it('empty environment_policy_id → throws', () => {
    expect(() =>
      decideChildProcessEnvironment(baseInput({ environment_policy_id: '' }), windowsPolicy),
    ).toThrow();
  });

  it('empty environment_policy_version → throws', () => {
    expect(() =>
      decideChildProcessEnvironment(baseInput({ environment_policy_version: '' }), windowsPolicy),
    ).toThrow();
  });

  it('empty executable_ref → throws', () => {
    expect(() =>
      decideChildProcessEnvironment(baseInput({ executable_ref: '' }), windowsPolicy),
    ).toThrow();
  });

  it('policy id mismatch (input vs policy) → throws', () => {
    expect(() =>
      decideChildProcessEnvironment(
        baseInput({ environment_policy_id: 'different-policy' }),
        windowsPolicy,
      ),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────
// determinism, freeze, no-leak
// ─────────────────────────────────────────────

describe('decideChildProcessEnvironment - determinism / freeze / no-leak', () => {
  it('security_decision_ref is deterministic (env:<launch_snapshot_id>)', () => {
    const result = decideChildProcessEnvironment(
      baseInput({ launch_snapshot_id: 'launch-1' }),
      windowsPolicy,
    );
    expect(result.security_decision_ref).toBe('env:launch-1');
  });

  it('decision is deeply frozen', () => {
    const result = decideChildProcessEnvironment(
      baseInput({ launch_snapshot_id: 'launch-1' }),
      windowsPolicy,
    ) as unknown as { sanitized_environment: Record<string, string> };
    expect(Object.isFrozen(result)).toBe(true);
    // sanitized_environment is a Record — should also be frozen
    expect(Object.isFrozen(result.sanitized_environment)).toBe(true);
  });

  it('decision does NOT carry any env VALUES (only names) — no field contains secret', () => {
    const SECRET_VALUE = 'super-leaky-secret-value-xyz';
    const result = decideChildProcessEnvironment(
      baseInput({
        parent_environment: {
          PATH: 'p',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'cmd.exe',
          MY_API_KEY: SECRET_VALUE,
        },
      }),
      windowsPolicy,
    );
    // Serialize whole decision: secret value must not appear anywhere.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_VALUE);
    // Variable NAME may appear (it is a name, not a value) — that is allowed.
    expect(serialized).toContain('MY_API_KEY');
  });
});

// ─────────────────────────────────────────────
// getDefaultEnvironmentPolicy
// ─────────────────────────────────────────────

describe('getDefaultEnvironmentPolicy', () => {
  it('win32 returns windows variant with stable id/version', () => {
    expect(windowsPolicy.environment_policy_id).toBe('child-env-default');
    expect(windowsPolicy.environment_policy_version).toBeTruthy();
    expect(windowsPolicy.required.shell_tool).toEqual(['PATH', 'SystemRoot', 'ComSpec']);
    expect(windowsPolicy.optional.shell_tool).toEqual(['PATHEXT', 'TEMP', 'TMP']);
    expect(windowsPolicy.required.background).toEqual(['PATH', 'SystemRoot', 'ComSpec']);
    expect(windowsPolicy.optional.background).toEqual(['PATHEXT', 'TEMP', 'TMP']);
  });

  it('linux returns unix variant', () => {
    expect(unixPolicy.required.shell_tool).toEqual(['PATH']);
    expect(unixPolicy.optional.shell_tool).toEqual(['HOME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL']);
    expect(unixPolicy.required.background).toEqual(['PATH']);
    expect(unixPolicy.optional.background).toEqual(['HOME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL']);
  });

  it('darwin returns unix variant', () => {
    const darwinPolicy = getDefaultEnvironmentPolicy('darwin');
    expect(darwinPolicy.required.shell_tool).toEqual(['PATH']);
  });

  it('denied_patterns include the 7 spec patterns', () => {
    // Smoke-test the patterns against known names.
    const patterns = windowsPolicy.denied_patterns;
    const matches = (name: string) => patterns.some(p => p.test(name));
    expect(matches('MY_API_KEY')).toBe(true);
    expect(matches('GITHUB_TOKEN')).toBe(true);
    expect(matches('DB_SECRET')).toBe(true);
    expect(matches('PASSWORD')).toBe(true);
    expect(matches('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(matches('AZURE_CLIENT_SECRET')).toBe(true);
    expect(matches('GOOGLE_APPLICATION_CREDENTIALS')).toBe(true);
    // benign names NOT matched
    expect(matches('PATH')).toBe(false);
    expect(matches('HOME')).toBe(false);
    expect(matches('TEMP')).toBe(false);
  });
});
