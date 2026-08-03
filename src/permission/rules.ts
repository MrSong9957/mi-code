// 规则解析、canonical 归一化与 MCP 匹配（Task 1 / A1-A8、A82）
//
// 物理本质：权限规则的“查字典 + 比对”工具箱。
//   - parsePermissionRule：把人类写的规则串（exact / legacy `:*` prefix / wildcard）
//     解析成结构化形式，供 checker 与序列化/反序列化共用。
//   - matchWildcardPattern：通配匹配器。按 escape sentinel -> regex escape
//     -> wildcard expansion -> sentinel restore -> 可选单尾部 -> dotAll/可选 i
//     的固定顺序实现。
//   - normalizePermissionToolName：canonical 别名归一化（Task/Agent/AgentTool -> spawn_agent）。
//   - parseMcpToolId / toolMatchesRule：MCP tool 规则匹配。
//     决策表（与设计 §4 一致）：
//       mcp__server_one__tool_a  vs mcp__server_one__tool_a -> exact
//       mcp__server_one__tool_b  vs mcp__server_one__tool_a -> 不匹配（具体 tool 只 exact）
//       mcp__server_one__tool_b  vs mcp__server_one        -> server-level match
//       mcp__server_one__tool_b  vs mcp__server_one__*     -> server wildcard match
//       mcp__server_two__tool_b  vs mcp__server_one        -> 不匹配（跨 server 隔离）
//     只有 server-level（rule 在 `mcp__<server>` 处结束）或 tool segment 精确为 `*`
//     才获得整 server 匹配能力；具体 tool rule 永远不能退化为 server prefix match。
//
// 本模块是 canonical 规则匹配的唯一真相源；patterns.ts 的旧 matchesRule 仅为
// 既有 { path, content } 模型保留，新增规则解析一律走本模块。

import type { PermissionRule } from './types.js';

// ─── canonical 别名归一化（A8）──────────────────────────────────────────────────

/**
 * legacy agent tool 别名 -> canonical `spawn_agent`。
 * 设计 §2/§3.1：canonical agent tool 固定为运行时注册名 `spawn_agent`；旧名只作输入别名。
 */
const TOOL_ALIAS: Record<string, string> = {
  Task: 'spawn_agent',
  Agent: 'spawn_agent',
  AgentTool: 'spawn_agent',
};

/** canonical 化 tool id：先查别名表，无别名则原样返回。 */
export function normalizePermissionToolName(name: string): string {
  return TOOL_ALIAS[name] ?? name;
}

// ─── 规则解析（A1-A5、A8）──────────────────────────────────────────────────────

export type ParsedRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string };

/**
 * 解析规则字符串为结构化形式（A1）。
 *
 * - 末尾 `:*`（legacy prefix 通配，如 `npm:*`）-> prefix
 * - 含未转义 `*` -> wildcard（保留原 pattern，含转义字面量）
 * - 否则 -> exact
 *
 * 注意：legacy `:*` 只在末尾识别；`git:*` 是 prefix，`git *` 是 wildcard。
 */
export function parsePermissionRule(raw: string): ParsedRule {
  // legacy prefix：末尾 `:*`（且不是转义的 `\:*`）
  if (raw.endsWith(':*') && !raw.endsWith('\\:*')) {
    return { type: 'prefix', prefix: raw.slice(0, -2) };
  }
  // wildcard：含未转义的 `*`
  if (hasUnescapedStar(raw)) {
    return { type: 'wildcard', pattern: raw };
  }
  return { type: 'exact', command: raw };
}

// ─── 通配匹配（A1-A5、A82）─────────────────────────────────────────────────────

/**
 * 判断规则串中是否存在未转义的 `*`。
 * 反斜杠转义的 `\*` 视为字面量，不算通配。
 */
function hasUnescapedStar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      i++; // 跳过被转义的下一个字符
      continue;
    }
    if (s[i] === '*') return true;
  }
  return false;
}

/**
 * 通配匹配（A2-A5、A82）。
 *
 * 实现顺序：escape sentinel -> regex escape -> wildcard expansion
 *           -> sentinel restore -> optional single tail -> dotAll / 可选 i。
 *
 * 语义：
 * - `*` 匹配任意字符（含分隔符），dotAll（heredoc/多行内容也能匹配，A5）。
 * - `\*` 是字面量星（A3）。
 * - 多个 `*` 时尾部不被视为可选（A4：`* run *` 不匹配 `npm run`，需 `npm run x`）。
 *   即只有“恰好一个尾部 `*`”才把 tail 视为可选（A2：`git *` 匹配 `git`）。
 * - 单尾部 `*` 时，“参数可选”语义：剥去 `*` 与紧邻其前的分隔空白后的前缀
 *   必须完整出现（`git *` 的前缀 `git`，故 `git` 命中、`gitify` 不命中）；
 *   或者完整通配命中（`git status` 命中 `git .*`）。
 * - 可选 caseInsensitive（A82 corpus 中部分样本）。
 */
export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  // 1. 把 `\x`（反斜杠转义）统一转为 sentinel，记录“该字符是字面量”。
  //    通配语义：反斜杠转义下一个字符使其成为字面量（`\*` 字面星、`\(` 字面括号）。
  //    未被转义的 `*` 才是通配。
  //    tokens：每个 token 是 { literal: boolean, ch: string }。
  const tokens: Array<{ literal: boolean; ch: string }> = [];
  let unescapedStarCount = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\' && i + 1 < pattern.length) {
      tokens.push({ literal: true, ch: pattern[i + 1] });
      i++; // 跳过被转义的下一个字符
    } else if (pattern[i] === '*') {
      tokens.push({ literal: false, ch: '*' });
      unescapedStarCount++;
    } else {
      tokens.push({ literal: true, ch: pattern[i] });
    }
  }

  // 2. trailingStar：恰好一个未转义 `*` 且在末尾 -> “参数可选”（A2）。
  const trailingStar = unescapedStarCount === 1 && tokens.length > 0 && !tokens[tokens.length - 1].literal;

  // 3. 构造 regex：literal 字符 escape，`*` 还原为 `.*`。
  const buildRegex = (toks: typeof tokens): string => {
    let r = '';
    for (const t of toks) {
      if (!t.literal && t.ch === '*') r += '.*';
      else r += t.ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return r;
  };

  const flags = 's' + (caseInsensitive ? 'i' : '');

  // 4. 非 trailingStar：标准锚定匹配。
  if (!trailingStar) {
    return new RegExp(`^${buildRegex(tokens)}$`, flags).test(command);
  }

  // 5. trailingStar：两种命中条件
  //    (a) 完整通配命中（`git status` 命中 `git .*`）
  //    (b) 参数可选命中：剥去末尾 `*` 及紧邻分隔空白后，前缀完整出现（`git` 命中 `git *`）
  //    任一即 true。(b) 的前缀不得把命令变成不相关词（`git` 不命中 `gitify`）。
  if (new RegExp(`^${buildRegex(tokens)}$`, flags).test(command)) return true;

  // 剥去末尾 `*` token，再剥去紧邻的分隔空白 token
  let prefixTokens = tokens.slice(0, -1);
  while (prefixTokens.length > 0 && /\s/.test(prefixTokens[prefixTokens.length - 1].ch)) {
    prefixTokens = prefixTokens.slice(0, -1);
  }
  return new RegExp(`^${buildRegex(prefixTokens)}$`, flags).test(command);
}

// ─── MCP tool 匹配（A6）────────────────────────────────────────────────────────

export type McpToolId =
  | { kind: 'server'; server: string }
  | { kind: 'serverWildcard'; server: string }
  | { kind: 'tool'; server: string; tool: string };

/**
 * 解析 MCP tool id（A6 实现基础）。
 *
 * `mcp__<server>`           -> server（整 server 匹配能力）
 * `mcp__<server>__*`        -> serverWildcard（整 server 匹配能力）
 * `mcp__<server>__<tool>`   -> tool（只 exact）
 *
 * server 名支持单下划线 `_`；`__` 是 server/tool 分隔符，不当普通名称字符。
 * 具体说明见设计 §4 决策表。
 */
export function parseMcpToolId(name: string): McpToolId | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator < 0) {
    // server-level：`mcp__<server>`
    return rest ? { kind: 'server', server: rest } : null;
  }
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  if (!server || !tool) return null;
  return tool === '*'
    ? { kind: 'serverWildcard', server }
    : { kind: 'tool', server, tool };
}

/**
 * 判断 candidate tool 是否命中 rule（A6）。
 *
 * 匹配规则：
 * 1. 先 canonicalize 双方 tool 名（别名归一化）。
 * 2. 完全相等 -> 命中。
 * 3. rule 是 MCP server / serverWildcard，candidate 是该 server 下的 tool -> 命中。
 * 4. 具体 tool rule（含 candidate）永不退化为 server prefix match。
 *
 * rule 通过 PermissionRule.tool 字段传入（tool-level MCP rule 无 content）。
 */
export function toolMatchesRule(candidateToolName: string, rule: PermissionRule): boolean {
  const candidate = normalizePermissionToolName(candidateToolName);
  const ruleName = normalizePermissionToolName(rule.tool);
  if (candidate === ruleName) return true;

  const parsedRule = parseMcpToolId(ruleName);
  const parsedCandidate = parseMcpToolId(candidate);
  if (!parsedRule || !parsedCandidate || parsedCandidate.kind !== 'tool') return false;
  // rule 必须是 server-level 或 serverWildcard；具体 tool rule 不退化
  return (
    (parsedRule.kind === 'server' || parsedRule.kind === 'serverWildcard') &&
    parsedRule.server === parsedCandidate.server
  );
}

// ─── 不可达规则检测（A7）────────────────────────────────────────────────────────

export interface UnreachableRule {
  /** 被遮蔽的 allow 规则 */
  readonly shadowed: PermissionRule;
  /** 遮蔽来源：tool-level deny 或 ask */
  readonly shadowType: 'deny' | 'ask';
  /** 人类可读的修复建议 */
  readonly fix: string;
}

/**
 * 检测被同 tool 的 tool-level deny/ask 遮蔽的 content allow（A7）。
 *
 * 物理本质：同 tool 的“裸 deny/ask”（无 content）会拦截该 tool 的所有调用，
 * 因此其后任何同 tool 的 content allow 都不可达。本函数报告这类配置错误。
 *
 * 注：只在同 canonical tool 之间检测；不报告 cross-tool 遮蔽。
 */
export function detectUnreachableRules(rules: readonly PermissionRule[]): UnreachableRule[] {
  // 收集所有 tool-level deny/ask（无 content/path）
  const blockers = new Map<string, 'deny' | 'ask'>();
  for (const r of rules) {
    if (r.content === undefined && r.path === undefined && (r.behavior === 'deny' || r.behavior === 'ask')) {
      const canon = normalizePermissionToolName(r.tool);
      // deny 优先于 ask 记录（deny 更强）
      if (!blockers.has(canon) || r.behavior === 'deny') {
        blockers.set(canon, r.behavior);
      }
    }
  }

  const result: UnreachableRule[] = [];
  for (const r of rules) {
    if (r.behavior !== 'allow') continue;
    if (r.content === undefined && r.path === undefined) continue; // tool-level allow 不算
    const canon = normalizePermissionToolName(r.tool);
    const blockType = blockers.get(canon);
    if (blockType) {
      result.push({
        shadowed: r,
        shadowType: blockType,
        fix: `tool-level ${blockType} on '${canon}' shadows content allow; remove the ${blockType} or narrow it with content/path`,
      });
    }
  }
  return result;
}

// ─── wildcard 回归语料（A82）────────────────────────────────────────────────────

export interface WildcardCorpusSample {
  readonly id: string;
  readonly pattern: string;
  readonly command: string;
  readonly expected: boolean;
  readonly caseInsensitive?: boolean;
}

/**
 * wildcard 回归语料（A82）。
 * 锁定 escape / 多通配 / dotAll / 尾部可选 / legacy prefix 等历史行为，防回归。
 */
export const WILDCARD_CORPUS: readonly WildcardCorpusSample[] = [
  // A2 尾部可选
  { id: 'wc-01', pattern: 'git *', command: 'git', expected: true },
  { id: 'wc-02', pattern: 'git *', command: 'git status', expected: true },
  { id: 'wc-03', pattern: 'git *', command: 'gitify', expected: false },
  // A3 转义星字面量
  { id: 'wc-04', pattern: 'echo \\*', command: 'echo *', expected: true },
  { id: 'wc-05', pattern: 'echo \\*', command: 'echo foo', expected: false },
  // A4 多通配不 tail-optional
  { id: 'wc-06', pattern: '* run *', command: 'npm run', expected: false },
  { id: 'wc-07', pattern: '* run *', command: 'npm run test', expected: true },
  // A5 dotAll（多行/heredoc）
  { id: 'wc-08', pattern: 'cat *', command: 'cat <<EOF\nline\nEOF', expected: true },
  // exact 不含通配
  { id: 'wc-09', pattern: 'git status', command: 'git status', expected: true },
  { id: 'wc-10', pattern: 'git status', command: 'git statusx', expected: false },
  // 转义括号 + 转义星（A8 roundtrip 基础）
  { id: 'wc-11', pattern: String.raw`echo \(x\) \*`, command: 'echo (x) *', expected: true },
  { id: 'wc-12', pattern: String.raw`echo \(x\) \*`, command: 'echo (x) foo', expected: false },
  // caseInsensitive 样本
  { id: 'wc-13', pattern: 'GIT *', command: 'git status', expected: true, caseInsensitive: true },
  { id: 'wc-14', pattern: 'GIT *', command: 'git status', expected: false /* 默认大小写敏感 */ },
];
