// Task 1: Canonical 规则与 MCP 匹配（A1-A8、A82）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §4（规则与 MCP 匹配语义）、
//          §10 A6/A7/A8 重定义。
//
// 这些测试锁定 src/permission/rules.ts 的行为：
//   - 规则解析/序列化（exact / legacy prefix / wildcard）
//   - 通配匹配（escape sentinel、dotAll、多通配、legacy `:*`）
//   - canonical tool 归一化（Task/Agent/AgentTool -> spawn_agent）
//   - MCP tool 匹配（exact / server-level / server wildcard / 单下划线 / 跨 server 隔离）
//   - 不可达规则检测（tool-level deny/ask shadowing content allow）
//   - wildcard 回归语料
import { describe, test, expect } from 'vitest';
import {
  parsePermissionRule,
  serializePermissionRule,
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

  // ─── A8: escape/parse/serialize + canonical alias roundtrip ──────────────────

  test('[A8] escape/parse/serialize and legacy aliases roundtrip', () => {
    // content 含转义括号与转义星：序列化后再解析应保持转义语义，
    // 且 legacy 别名 Task/Agent/AgentTool 规一化为 spawn_agent。
    const original = { toolName: 'Task', ruleContent: String.raw`echo \(x\) \*` };
    const serialized = serializePermissionRule(original);
    const parsed = parsePermissionRule(serialized);
    // 解析结果保留转义语义（exact command），不丢失星/括号字面量
    expect(matchWildcardPattern(parsed.type === 'exact' ? parsed.command : '', 'echo (x) *')).toBe(true);
    // canonical 归一化：Task -> spawn_agent
    expect(normalizePermissionToolName('Task')).toBe('spawn_agent');
    expect(normalizePermissionToolName('Agent')).toBe('spawn_agent');
    expect(normalizePermissionToolName('AgentTool')).toBe('spawn_agent');
    expect(normalizePermissionToolName('spawn_agent')).toBe('spawn_agent');
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
