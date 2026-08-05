// Task 9: Config Sources 与安全持久化（A65-A73）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md
//   §9.1（permission rule source precedence）、§9.2（startup/default mode，本任务不直接测，留给 Task 8）、
//   §9.3（policy restriction/gate，Task 8）、§9.4（classifier config trusted sources）、
//   §10（config 持久化未知字段保留、JSON 错误保留 last-known-good、session 不写盘、settings 原子写）。
//
// 本测试锁定四套独立 precedence，禁止混用：
//   1. permission rule behavior + source precedence（mergePermissionRules）
//   2. startup mode（resolveRequestedStartupMode，Task 8 已测；本任务不重复）
//   3. policy gate（applyModeRestrictions，Task 8 已测；本任务不重复）
//   4. classifier config（projectClassifierConfigSources —— 只信任 user/local/flag/policy）
//
// 不提前做 Task 10（streaming 并发）。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  PERMISSION_RULE_SOURCE_PRECEDENCE,
  isPermissionRuleSource,
  mergePermissionRules,
  type MergedPermissionRule,
  projectClassifierConfigSources,
  type ClassifierConfigSourcesInput,
  mergeAutoModeRules,
  type AutoModeRuleSource,
  loadStaticClassifierProviderMetadata,
  mergeRawConfig,
  loadLegacyConfig,
} from '../../config/permission-sources.js';
import { unsupportedClassifierCapabilities } from '../../permission/classifier-provider.js';
import type { PermissionRule } from '../../permission/types.js';

// ─── fixture helpers ──────────────────────────────────────────────────────────

/** 构造 PermissionRule（与现有 { tool, behavior, path?, content? } 模型一致） */
function rule(tool: string, behavior: PermissionRule['behavior'], content?: string): PermissionRule {
  return content === undefined ? { tool, behavior } : { tool, behavior, content };
}
function allow(content: string): PermissionRule {
  return rule('run_bash', 'allow', content);
}
function deny(content: string): PermissionRule {
  return rule('run_bash', 'deny', content);
}
function ask(content: string): PermissionRule {
  return rule('run_bash', 'ask', content);
}

/** 用规则串构造 sourced rule（A65 测试用 sourcedRule('policySettings', allow(...))） */
function sourcedRule(source: string, r: PermissionRule): MergedPermissionRule {
  return { ...r, source: source as MergedPermissionRule['source'] };
}

// ─── A65: permission rule behavior + source precedence ────────────────────────

describe('[A65] permission rule behavior and source precedence', () => {
  test('behavior precedence: deny > ask > allow regardless of source', () => {
    const merged = mergePermissionRules([
      sourcedRule('policySettings', allow('git push *')),
      sourcedRule('flagSettings', ask('git push *')),
      sourcedRule('userSettings', deny('git push *')),
    ]);
    // deny 行为最高优先级，无论来自哪个 source
    const denyRules = merged.filter((r) => r.behavior === 'deny');
    expect(denyRules.length).toBeGreaterThan(0);
    // 对 run_bash git push origin main：deny 应该决定行为
    const decision = decideRule(merged, 'run_bash', { command: 'git push origin main' });
    expect(decision).toBe('deny');
  });

  test('PERMISSION_RULE_SOURCE_PRECEDENCE matches design §9.1', () => {
    expect(PERMISSION_RULE_SOURCE_PRECEDENCE).toEqual([
      'policySettings', 'flagSettings', 'command', 'session',
      'localSettings', 'projectSettings', 'userSettings',
    ]);
  });

  test('cliArg and sdkSettings are not permission rule sources', () => {
    expect(isPermissionRuleSource('cliArg')).toBe(false);
    expect(isPermissionRuleSource('sdkSettings')).toBe(false);
  });

  test('all declared sources are valid', () => {
    for (const src of PERMISSION_RULE_SOURCE_PRECEDENCE) {
      expect(isPermissionRuleSource(src)).toBe(true);
    }
  });
});

// ─── A67: invalid JSON preserves last-known-good ──────────────────────────────

describe('[A67] invalid JSON preserves last-known-good', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'micode-cfg-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('corrupt JSON on reload preserves last-known-good mode', async () => {
    const { ConfigStore } = await import('../../config/store.js');
    const store = new ConfigStore(tmpDir);
    store.setPermissionMode('plan');
    // 写入损坏 JSON
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, '{ broken', 'utf8');
    // reload 应保留 last-known-good
    const reloaded = store.reload();
    expect(reloaded.permissions.mode).toBe('plan');
  });
});

// ─── A68/A69: raw config merge (unknown fields + undefined delete) ────────────

describe('raw config merge (A68/A69)', () => {
  test('[A68] schema-invalid fields retain raw values during merge', () => {
    expect(mergeRawConfig({ custom: { value: 1 } }, { custom: 'future-format' }))
      .toEqual({ custom: 'future-format' });
  });

  test('[A68] unknown fields survive merge byte-for-value', () => {
    const merged = mergeRawConfig({ futureFeature: { enabled: true } }, { permissions: { mode: 'auto' } });
    expect(merged.futureFeature).toEqual({ enabled: true });
    expect(merged.permissions).toEqual({ mode: 'auto' });
  });

  test('[A69] explicit undefined deletes a key', () => {
    expect(mergeRawConfig({ keep: 1, remove: 2 }, { remove: undefined }))
      .toEqual({ keep: 1 });
  });
});

// ─── A70: classifier config trusted sources ──────────────────────────────────

describe('[A70/A79] classifier config trusted sources', () => {
  test('classifier config adopts flag settings and rejects untrusted sources', () => {
    const input: ClassifierConfigSourcesInput = {
      userSettings: { rules: ['USER'] },
      localSettings: { rules: ['LOCAL'] },
      flagSettings: { rules: ['FLAG'] },
      projectSettings: { rules: ['PROJECT'] },
      command: { rules: ['COMMAND'] },
      session: { rules: ['SESSION'] },
      cliArg: { rules: ['CLI_ARG'] },
      sdkSettings: { rules: ['SDK'] },
      policySettings: { rules: ['POLICY'] },
    };
    const projected = projectClassifierConfigSources(input);
    // 设计 §9.4：只采用 user/local/flag/policy，稳定顺序 user -> local -> flag -> policy
    expect(projected.rules).toEqual(['USER', 'LOCAL', 'FLAG', 'POLICY']);
    // 排除 project/command/session/cliArg/sdk
    expect(projected.rules).not.toContain('PROJECT');
    expect(projected.rules).not.toContain('COMMAND');
    expect(projected.rules).not.toContain('SESSION');
    expect(projected.rules).not.toContain('CLI_ARG');
    expect(projected.rules).not.toContain('SDK');
    // rejected 记录被排除的来源
    expect(projected.rejected.map((r) => r.source)).toEqual(
      expect.arrayContaining(['projectSettings', 'command', 'session', 'cliArg', 'sdkSettings']),
    );
  });

  test('classifierModel resolved only from classifier-trusted config sources', () => {
    const projected = projectClassifierConfigSources({
      userSettings: { classifierModel: 'user-model' },
      projectSettings: { classifierModel: 'project-model' },
      flagSettings: { classifierModel: 'flag-model' },
    });
    // 投影顺序 user -> local -> flag -> policy，后者覆盖前者：
    // 最终优先级 policy > flag > local > user。
    // 设计 §9.4“组织 policy section 不可被替换”+ §9.1 权威方向 policy 最强。
    // 此处无 policy/local，故 flag 胜出（覆盖 user）。
    expect(projected.classifierModel).toBe('flag-model');
    expect(projected.rejected.some((r) => r.source === 'projectSettings')).toBe(true);
  });

  test('[A70 RED] policy classifierModel overrides user/local/flag', () => {
    // 设计 §9.4 稳定 section 顺序 user -> local -> flag -> policy，逐层覆盖，
    // 最终优先级 policy > flag > local > user。policy 不可被 flag 覆盖。
    const projected = projectClassifierConfigSources({
      userSettings: { classifierModel: 'user-model' },
      localSettings: { classifierModel: 'local-model' },
      flagSettings: { classifierModel: 'flag-model' },
      policySettings: { classifierModel: 'policy-model' },
    });
    expect(projected.classifierModel).toBe('policy-model');
  });

  test('[A70] flag overrides local and user when no policy', () => {
    const projected = projectClassifierConfigSources({
      userSettings: { classifierModel: 'user-model' },
      localSettings: { classifierModel: 'local-model' },
      flagSettings: { classifierModel: 'flag-model' },
    });
    expect(projected.classifierModel).toBe('flag-model');
  });

  test('[A70] user wins when alone', () => {
    const projected = projectClassifierConfigSources({
      userSettings: { classifierModel: 'user-model' },
    });
    expect(projected.classifierModel).toBe('user-model');
  });

  test('organization policy section cannot be overridden by excluded sources', () => {
    // policySettings 的 classifier rules 固定位置（最后），不可被 project/command 替换
    const projected = projectClassifierConfigSources({
      userSettings: { rules: ['USER'] },
      policySettings: { rules: ['POLICY'] },
      projectSettings: { rules: ['FAKE-POLICY'] },
    });
    expect(projected.rules).toEqual(['USER', 'POLICY']);
    expect(projected.rules).not.toContain('FAKE-POLICY');
  });
});

// ─── A71: trusted sources append in stable order ─────────────────────────────

describe('[A71/A80] trusted sources append in stable order', () => {
  test('classifier rule sections in user -> local -> flag -> policy order', () => {
    const result = mergeAutoModeRules([
      { source: 'policySettings', rules: ['P'] },
      { source: 'flagSettings', rules: ['F'] },
      { source: 'localSettings', rules: ['L'] },
      { source: 'userSettings', rules: ['U'] },
    ] as AutoModeRuleSource[]);
    expect(result).toEqual(['U', 'L', 'F', 'P']);
  });

  test('empty user section falls back to defaults (design §10 A80)', () => {
    // 非空 user rules replace defaults；空 user section 保持 defaults + org
    const result = mergeAutoModeRules([
      { source: 'userSettings', rules: [] },
      { source: 'policySettings', rules: ['POLICY'] },
    ] as AutoModeRuleSource[]);
    // 空 user -> 不替换默认；只保留 policy
    expect(result).toEqual(['POLICY']);
  });
});

// ─── A72: unknown fields survive permission update byte-for-value ─────────────

describe('[A72] unknown fields survive a permission update byte-for-value', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'micode-cfg-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('persistPermissionUpdate preserves unknown top-level fields', async () => {
    const { ConfigStore } = await import('../../config/store.js');
    const store = new ConfigStore(tmpDir);
    // 写入一个含未知字段的原始配置
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ futureFeature: { enabled: 'maybe' } }), 'utf8');
    store.reload();
    store.persistPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.futureFeature).toEqual({ enabled: 'maybe' });
    expect(raw.permissions.mode).toBe('auto');
  });
});

// ─── A73: legacy config without auto fields ───────────────────────────────────

describe('[A73] legacy config without auto fields keeps build/plan behavior', () => {
  test('legacy build config loads as build', () => {
    expect(loadLegacyConfig({ permissions: { mode: 'build', rules: [] } }).permissions.mode).toBe('build');
  });

  test('legacy plan config loads as plan', () => {
    expect(loadLegacyConfig({ permissions: { mode: 'plan', rules: [] } }).permissions.mode).toBe('plan');
  });

  test('empty config defaults to build', () => {
    expect(loadLegacyConfig({}).permissions.mode).toBe('build');
  });

  test('legacy "default" migrates to build', () => {
    expect(loadLegacyConfig({ permissions: { mode: 'default' as 'build', rules: [] } }).permissions.mode).toBe('build');
  });
});

// ─── A66: project switch reloads project/local and repartitions ───────────────

describe('[A66] project switch reloads and repartitions', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'micode-cfg-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('reloadForProject updates currentProject and repartitions via session', async () => {
    const { ConfigStore } = await import('../../config/store.js');
    const { SessionState } = await import('../../permission/session-state.js');
    const { SessionAllowlist } = await import('../../permission/session-allowlist.js');
    const session = new SessionState(new SessionAllowlist(), 's1');
    // 进入 auto 模式：dangerous allow 才会被分区到 stash
    session.applyPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    const store = new ConfigStore(tmpDir);
    const safeRead = { tool: 'read_file', behavior: 'allow' as const, path: 'src/**' };
    store.reloadForProject('/proj/a', [safeRead], session);
    expect(store.currentProject).toBe('/proj/a');
    const dangerous = { tool: 'run_bash', behavior: 'allow' as const, content: 'rm -rf *' };
    store.reloadForProject('/proj/b', [dangerous], session);
    expect(store.currentProject).toBe('/proj/b');
    // auto 模式下危险 allow 进入 stash
    // （reloadForProject 通过 applyPermissionUpdate(replaceRules) 更新 session）
    expect(session.permissionSnapshot.strippedDangerousRules.length).toBeGreaterThan(0);
  });
});

// ─── classifier provider metadata: static, no discovery RPC ───────────────────

describe('classifier provider metadata (static, no discovery RPC)', () => {
  test('metadata loaded statically without discovery RPC', () => {
    const discovery = vi.fn();
    const metadata = loadStaticClassifierProviderMetadata(
      { fastClassifierModel: 'fast-safe', classifierCapabilities: { reasoningControl: true, minimumOutputTokens: 2 } },
      {},
      { discovery },
    );
    expect(metadata.fastClassifierModel).toBe('fast-safe');
    expect(metadata.capabilities.reasoningControl).toBe(true);
    expect(metadata.capabilities.minimumOutputTokens).toBe(2);
    expect(discovery).not.toHaveBeenCalled();
  });

  test('missing capabilities normalize to unsupported', () => {
    const discovery = vi.fn();
    const metadata = loadStaticClassifierProviderMetadata({}, {}, { discovery });
    expect(metadata.capabilities).toEqual(unsupportedClassifierCapabilities());
    expect(discovery).not.toHaveBeenCalled();
  });
});

// ─── helper: decideRule（简化决策，用于验证 merge 结果） ─────────────────────────

/**
 * 简化决策器：在 merged rules 中按 behavior precedence 决定单个 tool+input 的行为。
 * deny > ask > allow；无匹配 -> 'ask'（保守默认）。
 * 这是测试辅助，不是生产代码。
 */
function decideRule(
  merged: readonly MergedPermissionRule[],
  tool: string,
  input: Record<string, unknown>,
): 'allow' | 'deny' | 'ask' {
  const toolRules = merged.filter((r) => r.tool === tool);
  if (toolRules.some((r) => r.behavior === 'deny' && ruleContentMatches(r, input))) return 'deny';
  if (toolRules.some((r) => r.behavior === 'ask' && ruleContentMatches(r, input))) return 'ask';
  if (toolRules.some((r) => r.behavior === 'allow' && ruleContentMatches(r, input))) return 'allow';
  return 'ask';
}

/** 简化 content 匹配：无 content 匹配全部；有 content 做前缀/通配粗匹配（测试足够） */
function ruleContentMatches(r: PermissionRule, input: Record<string, unknown>): boolean {
  if (r.content === undefined) return true;
  const command = String(input.command ?? '');
  // 简化：把 `*` 当任意后缀，前缀匹配（测试辅助，非生产匹配器）
  if (r.content.endsWith(' *')) {
    const prefix = r.content.slice(0, -2);
    return command === prefix || command.startsWith(prefix + ' ');
  }
  return command === r.content;
}
