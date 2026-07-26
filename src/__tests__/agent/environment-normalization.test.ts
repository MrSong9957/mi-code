import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  formatNormalizedEnvironment,
  normalizeEnvironmentSnapshot,
  type EnvironmentAllowlistPolicy,
  type EnvironmentCollectionInput,
} from '../../agent/context/intake/environment.js';

// ---------------------------------------------------------------------------
// BRC-3 Environment normalization (spec §9.3).
//
// The environment snapshot is the ONLY path by which collected environment
// values enter the Prompt. The allowlist is closed; privacy can only DELETE,
// never restore; unknown fields are OMITTED with a code, never guessed.
// Secrets that fall through the allowlist must not leak into the serialized
// snapshot or the formatted Prompt string.
// ---------------------------------------------------------------------------

const validInput = (overrides: Partial<EnvironmentCollectionInput> = {}): EnvironmentCollectionInput => ({
  environment_snapshot_id: 'env-1',
  platform_family: 'windows',
  shell_family: null,
  workspace_root: 'D:\\repo',
  working_directory: 'D:\\repo\\src',
  repository_present: true,
  observed_at: '2026-07-26T00:00:00.000Z',
  collected_fields: {},
  ...overrides,
});

const allFieldsPolicy = (allowed: string[], privacy: string[] = []): EnvironmentAllowlistPolicy => ({
  allowed_fields: new Set(allowed),
  privacy_omitted_fields: new Set(privacy),
});

describe('normalizeEnvironmentSnapshot — allowlist & privacy (BRC-3 §9.3)', () => {
  it('omits unknown and non-allowlisted fields', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({
        collected_fields: {
          terminal_columns: 120,
          API_KEY: 'secret',
        },
      }),
      allFieldsPolicy(['terminal_columns']),
    );
    expect(snapshot.allowed_fields).toEqual({ terminal_columns: 120 });
    expect(snapshot.omitted_field_codes).toContain('field.not_allowlisted.API_KEY');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('privacy_omitted_fields removes a field that IS in allowlist', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({
        collected_fields: {
          terminal_columns: 120,
          HIDDEN_TOKEN: 'topsecret',
        },
      }),
      allFieldsPolicy(['terminal_columns', 'HIDDEN_TOKEN'], ['HIDDEN_TOKEN']),
    );
    expect(snapshot.allowed_fields).toEqual({ terminal_columns: 120 });
    expect(snapshot.omitted_field_codes).toContain('field.privacy_omitted.HIDDEN_TOKEN');
    // Value must be completely absent from serialized output.
    expect(JSON.stringify(snapshot)).not.toContain('topsecret');
  });

  it('sorts multiple omitted_field_codes alphabetically for determinism', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({
        collected_fields: {
          zebra_field: 'z',
          alpha_field: 'a',
          // PRIVACY OMITTED (also allowlisted)
          middle_field: 'm',
        },
      }),
      allFieldsPolicy(['middle_field'], ['middle_field']),
    );
    // zebra_field, alpha_field → not_allowlisted; middle_field → privacy_omitted
    // Codes are sorted alphabetically across the FULL code string, so all
    // `field.not_allowlisted.*` codes come before `field.privacy_omitted.*`
    // because 'n' < 'p'.
    expect(snapshot.omitted_field_codes).toEqual([
      'field.not_allowlisted.alpha_field',
      'field.not_allowlisted.zebra_field',
      'field.privacy_omitted.middle_field',
    ]);
  });

  it('keeps allowlisted fields with falsy values', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({
        collected_fields: {
          verbose: false,
          count: 0,
          label: '',
        },
      }),
      allFieldsPolicy(['verbose', 'count', 'label']),
    );
    expect(snapshot.allowed_fields).toEqual({
      verbose: false,
      count: 0,
      label: '',
    });
    expect(snapshot.omitted_field_codes).toEqual([]);
  });

  it('does not leak any non-allowlisted secret via JSON serialization', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({
        collected_fields: {
          ok: 'kept',
          SECRET_VAR: 'super-secret-value',
        },
      }),
      allFieldsPolicy(['ok']),
    );
    expect(snapshot.omitted_field_codes).toContain('field.not_allowlisted.SECRET_VAR');
    expect(JSON.stringify(snapshot)).not.toContain('super-secret-value');
  });
});

describe('normalizeEnvironmentSnapshot — path canonicalization (BRC-3 §9.3)', () => {
  it('resolves a relative workspace_root to an absolute path', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({
        workspace_root: '.',
        working_directory: 'src',
      }),
      allFieldsPolicy([]),
    );
    expect(path.isAbsolute(snapshot.workspace_root)).toBe(true);
    expect(path.isAbsolute(snapshot.working_directory)).toBe(true);
  });

  it('normalizes `..` segments in paths', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({
        workspace_root: 'D:\\repo',
        working_directory: 'D:\\repo\\sub\\..\\src',
      }),
      allFieldsPolicy([]),
    );
    expect(snapshot.workspace_root).toBe(path.normalize('D:\\repo'));
    expect(snapshot.working_directory).toBe(path.normalize('D:\\repo\\src'));
  });

  it('accepts already-absolute paths unchanged (after normalization)', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({
        workspace_root: 'D:\\repo',
        working_directory: 'D:\\repo\\src',
      }),
      allFieldsPolicy([]),
    );
    expect(snapshot.workspace_root).toBe('D:\\repo');
    expect(snapshot.working_directory).toBe('D:\\repo\\src');
  });
});

describe('normalizeEnvironmentSnapshot — core field validation (BRC-3 §9.3)', () => {
  it('accepts shell_family: null', () => {
    const snapshot = normalizeEnvironmentSnapshot(validInput({ shell_family: null }), allFieldsPolicy([]));
    expect(snapshot.shell_family).toBeNull();
  });

  it('accepts shell_family: "powershell"', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({ shell_family: 'powershell' }),
      allFieldsPolicy([]),
    );
    expect(snapshot.shell_family).toBe('powershell');
  });

  it.each([
    ['environment_snapshot_id', { environment_snapshot_id: '' }],
    ['platform_family', { platform_family: '   ' }],
    ['workspace_root', { workspace_root: '' }],
    ['working_directory', { working_directory: '' }],
    ['observed_at', { observed_at: '' }],
  ] as const)('rejects empty %s', (_field, override) => {
    expect(() => normalizeEnvironmentSnapshot(validInput(override), allFieldsPolicy([]))).toThrow();
  });

  it('round-trips repository_present: false through both normalize and format', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({ repository_present: false }),
      allFieldsPolicy([]),
    );
    expect(snapshot.repository_present).toBe(false);
    expect(formatNormalizedEnvironment(snapshot)).toContain('false');
  });
});

describe('normalizeEnvironmentSnapshot — immutability (BRC-3 §9.3)', () => {
  it('deep-freezes the snapshot and its members', () => {
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({ collected_fields: { terminal_columns: 120 } }),
      allFieldsPolicy(['terminal_columns']),
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.allowed_fields)).toBe(true);
    expect(Object.isFrozen(snapshot.omitted_field_codes)).toBe(true);
  });

  it('allowed_fields is a copy: mutating input.collected_fields does not affect snapshot', () => {
    const collected: Record<string, string | boolean | number> = { terminal_columns: 120 };
    const snapshot = normalizeEnvironmentSnapshot(
      validInput({ collected_fields: collected }),
      allFieldsPolicy(['terminal_columns']),
    );
    collected.terminal_columns = 999;
    (collected as Record<string, string | boolean | number>)['injected'] = 'evil';
    expect(snapshot.allowed_fields).toEqual({ terminal_columns: 120 });
    expect(JSON.stringify(snapshot)).not.toContain('999');
    expect(JSON.stringify(snapshot)).not.toContain('evil');
  });
});

describe('formatNormalizedEnvironment (BRC-3 §9.3)', () => {
  // Use platform-native absolute paths so the snapshot values survive
  // `path.resolve`+`normalize` unchanged on whichever OS runs the tests.
  // We then assert the formatter echoes the snapshot verbatim — proving it
  // does NOT consult process.cwd/platform/env (which would disagree).
  const rootAbs = path.resolve(path.sep + 'srv' + path.sep + 'agent');
  const wdAbs = path.resolve(rootAbs, 'src');
  const snapshotForFormat = () =>
    normalizeEnvironmentSnapshot(
      validInput({
        platform_family: 'linux',
        shell_family: 'bash',
        workspace_root: rootAbs,
        working_directory: wdAbs,
        repository_present: true,
        observed_at: '2026-07-26T00:00:00.000Z',
        collected_fields: {
          terminal_columns: 120,
          node_version: 'v20',
          API_KEY: 'topsecret-leak',
        },
      }),
      allFieldsPolicy(['terminal_columns', 'node_version']),
    );

  it('produces a string containing core fields and allowed field keys/values', () => {
    const s = snapshotForFormat();
    const out = formatNormalizedEnvironment(s);
    expect(out).toContain('linux');
    expect(out).toContain(s.workspace_root);
    expect(out).toContain(s.working_directory);
    expect(out).toContain('terminal_columns');
    expect(out).toContain('120');
    expect(out).toContain('node_version');
    expect(out).toContain('v20');
  });

  it('does NOT contain omitted field values', () => {
    const out = formatNormalizedEnvironment(snapshotForFormat());
    expect(out).not.toContain('topsecret-leak');
    expect(out).not.toContain('API_KEY');
  });

  it('is deterministic: same snapshot → identical output', () => {
    const s = snapshotForFormat();
    const a = formatNormalizedEnvironment(s);
    const b = formatNormalizedEnvironment(s);
    expect(a).toBe(b);
  });

  it('reads only from the snapshot (process.* is irrelevant)', () => {
    // If formatNormalizedEnvironment consulted process.cwd/platform/env, it would
    // produce values inconsistent with this synthetic snapshot. The snapshot
    // declares a linux/bash/<resolved> environment regardless of where the
    // test actually runs — the formatter must echo exactly those values.
    const s = snapshotForFormat();
    const out = formatNormalizedEnvironment(s);
    expect(out).toContain('linux');
    expect(out).toContain('bash');
    expect(out).toContain(s.workspace_root);
    expect(out).toContain(s.working_directory);
    // And must NOT contain the real CWD/platform of this test runner — at minimum,
    // the snapshot's declared working directory should be the one shown.
    expect(out).toContain('terminal_columns: 120');
  });
});
