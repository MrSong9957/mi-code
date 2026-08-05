// Task 1: Canonical 规则与 MCP 匹配（A1-A8、A82）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §4（规则与 MCP 匹配语义）、
//          §10 A6/A7/A8 重定义。
//
// 这些测试锁定 src/permission/rules.ts 的行为：
//   - 规则解析（exact / legacy :* prefix / wildcard）
//   - 通配匹配（escape sentinel、dotAll、多通配、legacy `:*`）
//   - canonical tool 归一化（Task/Agent/AgentTool -> spawn_agent）
//   - MCP tool 匹配（exact / server-level / server wildcard / 单下划线 / 跨 server 隔离）
//   - 不可达规则检测（tool-level deny/ask shadowing content allow）
//   - wildcard 回归语料
import { describe, test, expect } from 'vitest';
import {
  parsePermissionRule,
  matchWildcardPattern,
  normalizePermissionToolName,
  parseMcpToolId,
  toolMatchesRule,
  detectUnreachableRules,
  WILDCARD_CORPUS,
} from '../../permission/rules.js';
import type { PermissionRule } from '../../permission/types.js';

// ─── fixture helpers（适配现有 { tool, behavior, path?, content? } 模型）──────────

/** 构造 tool-level MCP rule（无 content，匹配整个 canonical tool id） */
function mcpRule(name: string, behavior: PermissionRule['behavior'] = 'allow'): PermissionRule {
  return { tool: name, behavior };
}

function allowRule(tool: string, content?: string): PermissionRule {
  return content === undefined ? { tool, behavior: 'allow' } : { tool, behavior: 'allow', content };
}
function denyRule(tool: string, content?: string): PermissionRule {
  return content === undefined ? { tool, behavior: 'deny' } : { tool, behavior: 'deny', content };
}
function askRule(tool: string, content?: string): PermissionRule {
  return content === undefined ? { tool, behavior: 'ask' } : { tool, behavior: 'ask', content };
}

// ─── A1-A5: 规则解析与通配匹配 ──────────────────────────────────────────────────

describe('canonical permission rules', () => {
  test('[A1] distinguishes exact, legacy prefix and wildcard', () => {
    expect(parsePermissionRule('git status')).toEqual({ type: 'exact', command: 'git status' });
    expect(parsePermissionRule('npm:*')).toEqual({ type: 'prefix', prefix: 'npm' });
    expect(parsePermissionRule('git *')).toEqual({ type: 'wildcard', pattern: 'git *' });
  });

  test('[A2] a single trailing wildcard makes arguments optional', () => {
    expect(matchWildcardPattern('git *', 'git')).toBe(true);
    expect(matchWildcardPattern('git *', 'git status')).toBe(true);
  });

  test('[A3] escaped star remains literal', () => {
    expect(matchWildcardPattern('echo \\*', 'echo *')).toBe(true);
    expect(matchWildcardPattern('echo \\*', 'echo anything')).toBe(false);
  });

  test('[A4] multiple wildcards do not make the tail optional', () => {
    expect(matchWildcardPattern('* run *', 'npm run')).toBe(false);
    expect(matchWildcardPattern('* run *', 'npm run test')).toBe(true);
  });

  test('[A5] wildcard uses dotAll for heredoc content', () => {
    expect(matchWildcardPattern('cat *', 'cat <<EOF\nline\nEOF')).toBe(true);
  });

  // ─── A6: MCP tool 匹配 ───────────────────────────────────────────────────────

  test('[A6] concrete MCP tools are exact; server rules support underscores', () => {
    expect(toolMatchesRule('mcp__server_one__tool_a', mcpRule('mcp__server_one__tool_a'))).toBe(true);
    expect(toolMatchesRule('mcp__server_one__tool_b', mcpRule('mcp__server_one__tool_a'))).toBe(false);
    expect(toolMatchesRule('mcp__server_one__tool_b', mcpRule('mcp__server_one'))).toBe(true);
    expect(toolMatchesRule('mcp__server_one__tool_b', mcpRule('mcp__server_one__*'))).toBe(true);
    expect(toolMatchesRule('mcp__server_two__tool_b', mcpRule('mcp__server_one'))).toBe(false);
  });

  // ─── A7: 不可达规则检测 ──────────────────────────────────────────────────────

  test('[A7] reports tool-level deny/ask shadowing content allow', () => {
    expect(
      detectUnreachableRules([
        denyRule('run_bash'),
        allowRule('run_bash', 'git *'),
      ]),
    ).toEqual([expect.objectContaining({ shadowType: 'deny', fix: expect.any(String) })]);

    expect(
      detectUnreachableRules([
        askRule('run_bash'),
        allowRule('run_bash', 'git *'),
      ]),
    ).toEqual([expect.objectContaining({ shadowType: 'ask' })]);
  });

  // ─── A8: escaped content 语义保持 + canonical alias 归一化 ────────────────────
  //
  // 原计划 A8 写作 "escape/parse/serialize roundtrip"，但既有 config 模型是结构化
  // JSON { tool, behavior, content }，不存在字符串规则格式，因此无 serialize 消费者
  // （已 grep 确认）。serialize API 已删除；A8 改为按真实数据模型验证：
  //   (a) 含转义括号与转义星的 content 经 parsePermissionRule 识别为 exact，
  //       其转义语义在 matchWildcardPattern 中保持（字面 `(` `)` `*`）；
  //   (b) legacy 别名 Task/Agent/AgentTool 规一化为 canonical spawn_agent。

  test('[A8] escaped content semantics preserved and legacy aliases canonicalize', () => {
    // (a) 转义 content 语义保持：`\(` `\)` `\*` 是字面量，不是 regex 元字符
    const escaped = String.raw`echo \(x\) \*`;
    const parsed = parsePermissionRule(escaped);
    expect(parsed).toEqual({ type: 'exact', command: escaped });
    // exact command 经 matchWildcardPattern 验证：匹配字面 `(x) *`，不匹配其他
    expect(matchWildcardPattern(parsed.type === 'exact' ? parsed.command : '', 'echo (x) *')).toBe(true);
    expect(matchWildcardPattern(parsed.type === 'exact' ? parsed.command : '', 'echo (x) foo')).toBe(false);
    expect(matchWildcardPattern(parsed.type === 'exact' ? parsed.command : '', 'echo x')).toBe(false);

    // (b) canonical 别名归一化：Task/Agent/AgentTool -> spawn_agent
    expect(normalizePermissionToolName('Task')).toBe('spawn_agent');
    expect(normalizePermissionToolName('Agent')).toBe('spawn_agent');
    expect(normalizePermissionToolName('AgentTool')).toBe('spawn_agent');
    expect(normalizePermissionToolName('spawn_agent')).toBe('spawn_agent');
    // 非 agent 别名原样返回
    expect(normalizePermissionToolName('run_bash')).toBe('run_bash');
    expect(normalizePermissionToolName('read_file')).toBe('read_file');
  });

  // ─── A82: wildcard 回归语料 ──────────────────────────────────────────────────

  test('[A82] wildcard regression corpus has no mismatches', () => {
    for (const sample of WILDCARD_CORPUS) {
      expect(
        matchWildcardPattern(sample.pattern, sample.command, sample.caseInsensitive),
        sample.id,
      ).toBe(sample.expected);
    }
  });
});

// ─── parseMcpToolId 直接单测（A6 的实现基础）─────────────────────────────────────

describe('parseMcpToolId', () => {
  test('non-mcp name returns null', () => {
    expect(parseMcpToolId('run_bash')).toBeNull();
    expect(parseMcpToolId('read_file')).toBeNull();
  });

  test('server-level rule', () => {
    expect(parseMcpToolId('mcp__server_one')).toEqual({ kind: 'server', server: 'server_one' });
  });

  test('server wildcard rule', () => {
    expect(parseMcpToolId('mcp__server_one__*')).toEqual({ kind: 'serverWildcard', server: 'server_one' });
  });

  test('concrete tool rule', () => {
    expect(parseMcpToolId('mcp__server_one__tool_a')).toEqual({
      kind: 'tool',
      server: 'server_one',
      tool: 'tool_a',
    });
  });

  test('server name supports single underscore', () => {
    expect(parseMcpToolId('mcp__server_one__tool_a')).toEqual({
      kind: 'tool',
      server: 'server_one',
      tool: 'tool_a',
    });
  });
});

// ─── Task 1 委托一致性：patterns.ts wildcard 入口必须与 rules.ts 一致 ──────────────
//
// 计划 Task 1 Step 3：现有 patterns.ts 委托 rules.ts，不保留旧分支。
// 这三个场景正是新旧实现历史分歧点；委托前旧 globToRegex 会给出与新 matchWildcardPattern
// 相反的结果，构成权限匹配二义性。委托后两侧必须一致。
import { globToRegex, matchesRule } from '../../permission/patterns.js';

describe('patterns delegates wildcard matching to rules (no dual truth source)', () => {
  test('git * matches git (tail-optional) — globToRegex aligns with matchWildcardPattern', () => {
    expect(matchWildcardPattern('git *', 'git')).toBe(true);
    // 旧入口 globToRegex 在委托前返回 false（git\ .* 锚定，要求空格）；委托后必须一致。
    expect(globToRegex('git *').test('git')).toBe(true);
  });

  test('echo \\* treats * as literal — globToRegex aligns with matchWildcardPattern', () => {
    expect(matchWildcardPattern('echo \\*', 'echo *')).toBe(true);
    expect(matchWildcardPattern('echo \\*', 'echo anything')).toBe(false);
    // 旧入口在委托前把 \ 当字面量、* 当 .*，结果相反；委托后必须一致。
    expect(globToRegex('echo \\*').test('echo *')).toBe(true);
    expect(globToRegex('echo \\*').test('echo anything')).toBe(false);
  });

  test('cat * matches heredoc with newline (dotAll) — globToRegex aligns with matchWildcardPattern', () => {
    const heredoc = 'cat <<EOF\nline\nEOF';
    expect(matchWildcardPattern('cat *', heredoc)).toBe(true);
    // 旧入口无 dotAll，. 不匹配换行；委托后必须一致。
    expect(globToRegex('cat *').test(heredoc)).toBe(true);
  });

  test('matchesRule delegates content matching to the same wildcard semantics', () => {
    // matchesRule 用 content 字段匹配 input.command；委托后必须走同一 wildcard 实现。
    const ruleGitStar = { tool: 'run_bash', behavior: 'allow' as const, content: 'git *' };
    expect(matchesRule(ruleGitStar, 'run_bash', { command: 'git' })).toBe(true);
    expect(matchesRule(ruleGitStar, 'run_bash', { command: 'git status' })).toBe(true);

    const ruleEscapedStar = { tool: 'run_bash', behavior: 'allow' as const, content: 'echo \\*' };
    expect(matchesRule(ruleEscapedStar, 'run_bash', { command: 'echo *' })).toBe(true);
    expect(matchesRule(ruleEscapedStar, 'run_bash', { command: 'echo foo' })).toBe(false);

    const ruleHeredoc = { tool: 'run_bash', behavior: 'allow' as const, content: 'cat *' };
    expect(matchesRule(ruleHeredoc, 'run_bash', { command: 'cat <<EOF\nline\nEOF' })).toBe(true);
  });
});

