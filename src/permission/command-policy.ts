// Wave D Task 12 (M-064): 命令结构化解析(DRC-5)。
//
// 物理本质（保姆级）：
//   parser 是只看 X 光片的安检员——能识别行李里的"管道"、"重定向"、
//   "变量展开"等结构,但绝不打开行李(不执行 expansion、不查 PATH、
//   不跑命令、不读 fs)。识别结果是一份 risk facts 清单,供上层(Wave E M-065)
//   再做安全结论。
//
// 不变量（spec §11.7）：
//   1. shell_dialect / grammar_version 必须显式,不支持就用 unsupported_syntax,
//      绝不靠 OS 名猜语法(rule 1, 2);
//   2. parser 不执行 expansion / 不解析真实 secret 值(rule 3);
//   3. too_complex 由确定性阈值产生,不靠 Agent 主观感觉(rule 4);
//   4. source ranges 可回指原命令(rule 5);
//   5. normalization 不改变引号/转义/操作符语义(rule 6);
//   6. 不负责 executable resolution / PATH trust / loader variable(rule 7);
//   7. environment_assignment / executable_candidate 只是语法事实,
//      不蕴含安全结论(对应 spec §11.4 末段);
//   8. 输出 frozen + deterministic。
//
// 关于 shell-quote 调用的关键决策:
//   shell-quote 1.9 的 parse(s) 在不传 env resolver 时会悄悄把 $HOME 解析成 ''
//   (执行了 expansion,销毁了变量名)——违反 rule 3。
//   解决方案:传一个 sentinel resolver,把变量名包成 {__var:key} 对象回填,
//   parser 据此识别"这是一个 expansion"而不解析真实值。这与 bash-normalize.ts
//   的用法不同(那边只需要文本归一化,可接受默认 expansion),但同库同版本。

import { createHash } from 'node:crypto';
import { parse, type ControlOperator } from 'shell-quote';
import { freezeSnapshot, requireIdentity } from '../agent/contracts/identities.js';

// ─────────────────────────────────────────────
// 协议常量
// ─────────────────────────────────────────────

/** Wave D 首个解析协议版本（硬编码 '1'）。 */
export const PARSE_PROTOCOL_VERSION = '1';

/**
 * Wave D 唯一支持的 shell dialect。
 *
 * 'posix-shell' 对应 POSIX sh 语法子集——shell-quote 能识别的部分。
 * 不包含 bash 特有扩展（[[ ]]、<(...)、${!x} 间接展开等）。
 */
export const SUPPORTED_SHELL_DIALECT = 'posix-shell';

/**
 * Wave D 唯一支持的 grammar 版本。
 *
 * 'posix-shell-quote-v1' = 用 shell-quote 1.x tokenizer 做结构识别,
 * 不做完整 POSIX AST（spec §11.7 显式不要求 tree-sitter 级 AST）。
 */
export const SUPPORTED_GRAMMAR_VERSION = 'posix-shell-quote-v1';

// ─────────────────────────────────────────────
// 类型（spec §11.4 + 算法需求）
// ─────────────────────────────────────────────

export type CommandParseStatus =
  | 'parsed'
  | 'invalid_syntax'
  | 'unsupported_syntax'
  | 'too_complex';

/** risk fact kind（spec §11.4 + §11.7 全部 8 类）。 */
export type CommandRiskFactKind =
  | 'command'
  | 'pipeline'
  | 'redirect'
  | 'substitution'
  | 'expansion'
  | 'control_flow'
  | 'environment_assignment'
  | 'executable_candidate';

/** risk_code 命名约定: kind:子类。仅作 reason code,不是安全结论。 */
export interface CommandRiskFact {
  fact_id: string;
  kind: CommandRiskFactKind;
  /** 形如 range:N:M,N、M 为字符 offset,可回指原 command_content。 */
  source_range_ref: string;
  risk_code: string;
}

export interface CommandParseResult {
  parse_protocol_version: string;
  parse_result_id: string;
  action_snapshot_id: string;
  command_hash: string;
  shell_dialect: string;
  grammar_version: string;
  status: CommandParseStatus;
  ast_ref: string | null;
  risk_facts: CommandRiskFact[];
  complexity_metrics: Readonly<Record<string, number>>;
  diagnostics: string[];
}

/** parser 输入（spec §11.3 子集——只取 parser 需要的字段）。 */
export interface CommandParseInput {
  parse_protocol_version: string;
  action_snapshot_id: string;
  /** 原始命令文本(parser 只读,不执行)。 */
  command_content: string;
  /** 调用方提供的 hash(仅供参考,parser 内部会重算 sha256 以防篡改)。 */
  command_hash: string;
  /** 必须显式,如 'posix-shell'。 */
  shell_dialect: string;
  /** 必须显式,如 'posix-shell-quote-v1'。 */
  grammar_version: string;
}

/** 复杂度策略（spec §11.7 rule 4）。 */
export interface CommandComplexityPolicy {
  policy_id: string;
  policy_version: string;
  max_tokens: number;
  max_operators: number;
  max_nesting: number;
  max_source_length: number;
}

// ─────────────────────────────────────────────
// shell-quote token 内部表示
// ─────────────────────────────────────────────

/**
 * sentinel 变量标记对象——shell-quote env resolver 回填用。
 *
 * 当 env resolver 返回 object 时,shell-quote 会原样插入该对象作为 token,
 * 不做字符串化(parse.js L77-79)。我们利用这点保留变量名而不解析其值。
 */
interface VarSentinel {
  /** 变量名;空字符串表示命令替换 $(...) 的 $ 后跟 ( 情况。 */
  __var: string;
}

interface GlobToken {
  op: 'glob';
  pattern: string;
}

interface CommentToken {
  comment: string;
}

/** 内部统一 token 类型,从 shell-quote 出来后规整成这个再扫描。 */
type InternalToken =
  | { kind: 'word'; text: string; index: number }
  | { kind: 'op'; op: string; index: number }
  | { kind: 'var'; name: string; index: number }
  | { kind: 'glob'; pattern: string; index: number }
  | { kind: 'comment'; text: string; index: number };

// ─────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────

/**
 * 把 shell 命令文本解析为不执行的结构化结果。
 *
 * 流程（spec §11.7）：
 *   1. dialect / grammar 显式性 + 版本匹配 → 否则 unsupported_syntax;
 *   2. source length 阈值 → 超出 too_complex(早退,不必 parse);
 *   3. shell-quote parse(sentinel env,不解析真实 env);
 *   4. parse 抛错 → invalid_syntax;
 *   5. token / operator / nesting 阈值 → 超出 too_complex;
 *   6. 扫描 tokens 提取 risk facts（语法事实,非安全结论）;
 *   7. 计算 complexity_metrics、canonical hash、parse_result_id;
 *   8. freeze 后返回。
 *
 * 不变量:本函数不调用 child_process / fs write / env lookup。
 *         sentinel resolver 只回填变量名对象,不查真实 process.env。
 */
export function parseCommandStructure(
  input: CommandParseInput,
  policy: CommandComplexityPolicy,
): CommandParseResult {
  const actionSnapshotId = input.action_snapshot_id;
  const shellDialect = input.shell_dialect;
  const grammarVersion = input.grammar_version;
  const commandContent = input.command_content;
  const sourceLength = commandContent.length;

  // 重算 sha256(command_content)——不信任 input.command_hash(spec §11.3 强调
  // hash 必须基于真实 content)。
  const commandHash = sha256Hex(commandContent);

  // ── Step 1: dialect / grammar 验证 ──
  if (!shellDialect || !grammarVersion) {
    return unsupportedResult({
      reason: 'missing dialect or grammar',
      input,
      policy,
      commandHash,
      sourceLength,
    });
  }
  if (shellDialect !== SUPPORTED_SHELL_DIALECT) {
    return unsupportedResult({
      reason: `unsupported shell_dialect: ${shellDialect}`,
      input,
      policy,
      commandHash,
      sourceLength,
    });
  }
  if (grammarVersion !== SUPPORTED_GRAMMAR_VERSION) {
    return unsupportedResult({
      reason: `unsupported grammar_version: ${grammarVersion}`,
      input,
      policy,
      commandHash,
      sourceLength,
    });
  }

  // ── Step 2: source length 阈值（早退,避免畸形超长输入炸 tokenizer）──
  if (sourceLength > policy.max_source_length) {
    return tooComplexResult({
      reason: `source_length ${sourceLength} > max ${policy.max_source_length}`,
      input,
      policy,
      commandHash,
      sourceLength,
      complexityMetrics: {
        token_count: 0,
        operator_count: 0,
        nesting_depth: 0,
        source_length: sourceLength,
      },
    });
  }

  // ── Step 3: shell-quote parse（sentinel env,不解析真实值）──
  let rawTokens: ReturnType<typeof parse>;
  try {
    rawTokens = parse(commandContent, sentinelEnvResolver);
  } catch (e) {
    return invalidResult({
      reason: e instanceof Error ? e.message : 'parse error',
      input,
      policy,
      commandHash,
      sourceLength,
    });
  }

  // ── Step 4: 规整 tokens + 计算 source ranges ──
  const tokens = normalizeTokens(rawTokens, commandContent);

  // ── Step 5: 复杂度阈值 ──
  const operatorCount = countOperators(tokens);
  const tokenCount = countTokens(tokens);
  const nestingDepth = computeNestingDepth(tokens);

  const complexityMetrics: Record<string, number> = {
    token_count: tokenCount,
    operator_count: operatorCount,
    nesting_depth: nestingDepth,
    source_length: sourceLength,
  };

  if (tokenCount > policy.max_tokens) {
    return tooComplexResult({
      reason: `token_count ${tokenCount} > max ${policy.max_tokens}`,
      input,
      policy,
      commandHash,
      sourceLength,
      complexityMetrics,
    });
  }
  if (operatorCount > policy.max_operators) {
    return tooComplexResult({
      reason: `operator_count ${operatorCount} > max ${policy.max_operators}`,
      input,
      policy,
      commandHash,
      sourceLength,
      complexityMetrics,
    });
  }
  if (nestingDepth > policy.max_nesting) {
    return tooComplexResult({
      reason: `nesting_depth ${nestingDepth} > max ${policy.max_nesting}`,
      input,
      policy,
      commandHash,
      sourceLength,
      complexityMetrics,
    });
  }

  // ── Step 6: 提取 risk facts（语法事实,非安全结论）──
  const riskFacts = extractRiskFacts(tokens, commandContent);

  // ── Step 7: parse_result_id / ast_ref ──
  const canonical = buildCanonical({
    actionSnapshotId,
    commandHash,
    shellDialect,
    grammarVersion,
    sourceLength,
    tokenCount,
    operatorCount,
    nestingDepth,
    facts: riskFacts,
  });
  const parseResultId = `parse:${sha256Hex(canonical).slice(0, 16)}`;
  // ast_ref 简单实现:用 canonical 的 hash 作为结构指纹,后续可升级为真 AST ref。
  const astRef = `ast:${sha256Hex(canonical).slice(0, 16)}`;

  // ── Step 8: freeze 返回 ──
  const result: CommandParseResult = {
    parse_protocol_version: PARSE_PROTOCOL_VERSION,
    parse_result_id: parseResultId,
    action_snapshot_id: actionSnapshotId,
    command_hash: commandHash,
    shell_dialect: shellDialect,
    grammar_version: grammarVersion,
    status: 'parsed',
    ast_ref: astRef,
    risk_facts: riskFacts,
    complexity_metrics: complexityMetrics,
    diagnostics: [],
  };

  return freezeSnapshot(result);
}

// ─────────────────────────────────────────────
// sentinel env resolver
// ─────────────────────────────────────────────

/**
 * 哨兵 env resolver:把变量名包成 {__var:key} 对象回填给 shell-quote。
 *
 * 关键:不查真实 process.env、不解析任何值。返回 object 时 shell-quote 会
 * 原样插入该 token(parse.js L77-79),保留"这是一个变量引用"的结构信号。
 *
 * 空变量名('')出现在命令替换 `$(...)` 场景——$ 后紧跟 (,shell-quote 把它
 * 当作 varname='' 的变量,我们回填 {__var:''} 标记,后续扫描时配合紧跟的
 * {op:'('} 识别为 substitution。
 */
function sentinelEnvResolver(key: string): VarSentinel {
  return { __var: key };
}

// ─────────────────────────────────────────────
// token 规整
// ─────────────────────────────────────────────

/**
 * 把 shell-quote 出来的混合 token 数组规整成统一 InternalToken,
 * 并为每个 token 计算它在原命令里的 source range。
 *
 * source range 算法:shell-quote 不暴露 token index,我们用"在剩余文本里
 * 顺序查找下一个出现位置"近似——这是确定性且单调推进的,因为 shell-quote
 * 不重排 token 也不删除可见字符(除了引号本身,但引号字符不影响后续 token
 * 文本的查找)。
 *
 * 对 var/glob/comment 这种结构化 token,我们用占位文本(anchor)在原文里
 * 定位:var 用其变量名、glob 用其 pattern、comment 用 '#'。
 */
function normalizeTokens(
  raw: ReturnType<typeof parse>,
  source: string,
): InternalToken[] {
  const out: InternalToken[] = [];
  let cursor = 0; // 在 source 里单调推进的查找游标

  for (const tok of raw) {
    if (typeof tok === 'string') {
      const range = findRange(source, cursor, tok);
      out.push({ kind: 'word', text: tok, index: range.start });
      cursor = range.end;
    } else if (isVarSentinel(tok)) {
      // 命令替换 $(...) 时 shell-quote 给 varname='',此时无法在原文里
      // 直接定位空字符串,我们退回到查找 '$' 字符。
      const anchor = tok.__var === '' ? '$' : '$' + tok.__var;
      const range = findRange(source, cursor, anchor);
      out.push({ kind: 'var', name: tok.__var, index: range.start });
      cursor = range.end;
    } else if (isOpToken(tok)) {
      const range = findRange(source, cursor, tok.op);
      out.push({ kind: 'op', op: tok.op, index: range.start });
      cursor = range.end;
    } else if (isGlobToken(tok)) {
      const range = findRange(source, cursor, tok.pattern);
      out.push({ kind: 'glob', pattern: tok.pattern, index: range.start });
      cursor = range.end;
    } else if (isCommentToken(tok)) {
      const range = findRange(source, cursor, '#');
      out.push({ kind: 'comment', text: tok.comment, index: range.start });
      cursor = range.end;
    }
    // 其他未知 token 类型:忽略(保守,不抛错)。
  }

  return out;
}

function isVarSentinel(t: object): t is VarSentinel {
  return (
    '__var' in t && typeof (t as { __var: unknown }).__var === 'string'
  );
}

function isOpToken(t: object): t is ControlOperator {
  return 'op' in t && typeof (t as { op: unknown }).op === 'string';
}

function isGlobToken(t: object): t is GlobToken {
  return (t as { op?: unknown }).op === 'glob';
}

function isCommentToken(t: object): t is CommentToken {
  return 'comment' in t && typeof (t as { comment: unknown }).comment === 'string';
}

/**
 * 在 source 里从 cursor 开始查找 anchor 的下一个出现位置,
 * 返回 [start, end) range。找不到时返回 [cursor, cursor](退化,
 * 调用方仍能用 start 做 range 引用)。
 */
function findRange(
  source: string,
  cursor: number,
  anchor: string,
): { start: number; end: number } {
  if (anchor.length === 0) {
    return { start: cursor, end: cursor };
  }
  const idx = source.indexOf(anchor, cursor);
  if (idx < 0) {
    return { start: cursor, end: cursor };
  }
  return { start: idx, end: idx + anchor.length };
}

// ─────────────────────────────────────────────
// 复杂度计数
// ─────────────────────────────────────────────

/** token 数 = word + var + glob + comment(可识别的内容 token),op 不计入。 */
function countTokens(tokens: InternalToken[]): number {
  let n = 0;
  for (const t of tokens) {
    if (t.kind === 'word' || t.kind === 'var' || t.kind === 'glob' || t.kind === 'comment') {
      n++;
    }
  }
  return n;
}

/** 操作符数 = 所有 op token(含 | && ; ( ) < > 等)。 */
function countOperators(tokens: InternalToken[]): number {
  let n = 0;
  for (const t of tokens) {
    if (t.kind === 'op') n++;
  }
  return n;
}

/**
 * 嵌套深度 = () 配对栈的历史最大深度。
 *
 * 只算 ( ) ——subshell/grouping 的真嵌套。<(...) 进程替换也用 ( ),
 * shell-quote 把 <( 作为单独 op,所以 ( 仍计入嵌套。注:其他 op(如 |)
 * 不改变嵌套深度。
 */
function computeNestingDepth(tokens: InternalToken[]): number {
  let depth = 0;
  let max = 0;
  for (const t of tokens) {
    if (t.kind === 'op' && t.op === '(') {
      depth++;
      if (depth > max) max = depth;
    } else if (t.kind === 'op' && t.op === ')') {
      if (depth > 0) depth--;
    }
  }
  return max;
}

// ─────────────────────────────────────────────
// risk fact 提取
// ─────────────────────────────────────────────

/** 控制/管道/重定向操作符集合(基于 shell-quote 1.9 ControlOperator 类型)。 */
const PIPELINE_OPS = new Set(['|', '|&']);
const REDIRECT_OPS = new Set(['>', '>>', '<', '<&', '>&']);
const CONTROL_OPS = new Set(['&&', '||', ';', '&', ';;']);

/** leading env assignment 正则:VAR=value(裸 word token 形如 'NAME=value')。 */
const LEADING_ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 反引号命令替换正则——shell-quote 不解析反引号,文本里查。g 标志用于 matchAll。 */
const BACKTICK_RE = /`[^`]*`/g;

/**
 * 扫描规整后的 tokens 提取 risk facts(语法事实,非安全结论)。
 *
 * 每条 fact 包含:
 *   - kind: 8 类之一(spec §11.7);
 *   - source_range_ref: 形如 'range:start:end';
 *   - risk_code: 形如 'kind:子类',仅作 reason code;
 *   - fact_id: 稳定序号 fact-NN,在 result 内唯一。
 *
 * 扫描规则:
 *   - op token:按操作符集合归类为 pipeline / redirect / control_flow;
 *   - var token(非空名):expansion;
 *   - var token(空名,即命令替换 $():substitution;
 *   - 命令前缀的 leading VAR=value word:environment_assignment;
 *   - 反引号(文本查):substitution;
 *   - 第一个非赋值 word + 其他普通 word:command / executable_candidate。
 *
 * 注意:environment_assignment / executable_candidate 只输出语法事实,
 * 不解析 PATH、不判断 binary trust(那是 Wave E M-065)。
 */
function extractRiskFacts(
  tokens: InternalToken[],
  source: string,
): CommandRiskFact[] {
  const facts: CommandRiskFact[] = [];
  let factIdx = 0;

  const addFact = (
    kind: CommandRiskFactKind,
    range: { start: number; end: number },
    riskCode: string,
  ): void => {
    facts.push({
      fact_id: `fact-${String(factIdx).padStart(2, '0')}`,
      kind,
      source_range_ref: `range:${range.start}:${range.end}`,
      risk_code: riskCode,
    });
    factIdx++;
  };

  // 第一阶段:识别 leading environment assignments 与第一个真正命令 token。
  // 跳过开头的 VAR=value word,记录为 environment_assignment;
  // 第一个非赋值 word 视为 executable_candidate;之后所有非赋值 word 记为 command。
  let i = 0;
  let sawCommand = false;

  // leading 阶段:连续 VAR=value tokens
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind !== 'word') break;
    if (!LEADING_ENV_ASSIGN_RE.test(t.text)) break;
    const end = t.index + t.text.length;
    addFact(
      'environment_assignment',
      { start: t.index, end },
      'env:leading-assignment',
    );
    i++;
  }

  // 第二阶段:扫描剩余 tokens,识别命令/操作符/变量/替换
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'op') {
      if (PIPELINE_OPS.has(t.op)) {
        const end = t.index + t.op.length;
        addFact('pipeline', { start: t.index, end }, 'pipeline:pipe');
      } else if (REDIRECT_OPS.has(t.op)) {
        const end = t.index + t.op.length;
        addFact('redirect', { start: t.index, end }, `redirect:${t.op}`);
      } else if (CONTROL_OPS.has(t.op)) {
        const end = t.index + t.op.length;
        addFact('control_flow', { start: t.index, end }, `control:${t.op}`);
      }
      // ( ) <( 等改变嵌套但不单独产出 fact——已由 nesting_depth 度量覆盖。
      continue;
    }

    if (t.kind === 'var') {
      if (t.name === '') {
        // 命令替换 $(...) 的 $ 标记——紧跟的 op='(' 是真正的替换体开始。
        // 我们在 $ 位置记一条 substitution fact;range 端点尽量含到 '('。
        const nextOp = tokens[i + 1];
        const end =
          nextOp && nextOp.kind === 'op' && nextOp.op === '('
            ? nextOp.index + 1
            : t.index + 1;
        addFact('substitution', { start: t.index, end }, 'substitution:cmd');
      } else {
        // 变量展开 $VAR / ${VAR}
        const end = t.index + t.name.length + 1; // +1 for $
        addFact('expansion', { start: t.index, end }, 'expansion:var');
      }
      continue;
    }

    if (t.kind === 'word') {
      // 已在 leading 阶段处理过 VAR=value,这里不会重复。
      if (!sawCommand) {
        sawCommand = true;
        const end = t.index + t.text.length;
        addFact(
          'executable_candidate',
          { start: t.index, end },
          'executable:candidate',
        );
      } else {
        const end = t.index + t.text.length;
        addFact('command', { start: t.index, end }, 'command:arg');
      }
      continue;
    }

    // glob / comment:不产生独立 risk fact(它们不是 spec §11.7 列出的 8 类)。
  }

  // 第三阶段:文本级反引号替换——shell-quote 不解析反引号,逐个匹配。
  // 这是对 substitution 的补充扫描。
  for (const m of source.matchAll(BACKTICK_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    addFact('substitution', { start, end }, 'substitution:backtick');
  }

  return facts;
}

// ─────────────────────────────────────────────
// 退化结果构造（unsupported / too_complex / invalid）
// ─────────────────────────────────────────────

interface DegradedResultArgs {
  input: CommandParseInput;
  policy: CommandComplexityPolicy;
  commandHash: string;
  sourceLength: number;
  reason: string;
}

function unsupportedResult(
  args: DegradedResultArgs,
): CommandParseResult {
  return freezeSnapshot({
    parse_protocol_version: PARSE_PROTOCOL_VERSION,
    parse_result_id: `parse:${sha256Hex(canonicalForDegraded(args, 'unsupported')).slice(0, 16)}`,
    action_snapshot_id: args.input.action_snapshot_id,
    command_hash: args.commandHash,
    shell_dialect: args.input.shell_dialect,
    grammar_version: args.input.grammar_version,
    status: 'unsupported_syntax' as CommandParseStatus,
    ast_ref: null,
    risk_facts: [] as CommandRiskFact[],
    complexity_metrics: {
      token_count: 0,
      operator_count: 0,
      nesting_depth: 0,
      source_length: args.sourceLength,
    },
    diagnostics: [`unsupported_syntax: ${args.reason}`],
  });
}

interface TooComplexArgs extends DegradedResultArgs {
  complexityMetrics: Record<string, number>;
}

function tooComplexResult(args: TooComplexArgs): CommandParseResult {
  return freezeSnapshot({
    parse_protocol_version: PARSE_PROTOCOL_VERSION,
    parse_result_id: `parse:${sha256Hex(canonicalForDegraded(args, 'too_complex')).slice(0, 16)}`,
    action_snapshot_id: args.input.action_snapshot_id,
    command_hash: args.commandHash,
    shell_dialect: args.input.shell_dialect,
    grammar_version: args.input.grammar_version,
    status: 'too_complex' as CommandParseStatus,
    ast_ref: null,
    risk_facts: [] as CommandRiskFact[],
    complexity_metrics: args.complexityMetrics,
    diagnostics: [`too_complex: ${args.reason}`],
  });
}

function invalidResult(args: DegradedResultArgs): CommandParseResult {
  return freezeSnapshot({
    parse_protocol_version: PARSE_PROTOCOL_VERSION,
    parse_result_id: `parse:${sha256Hex(canonicalForDegraded(args, 'invalid_syntax')).slice(0, 16)}`,
    action_snapshot_id: args.input.action_snapshot_id,
    command_hash: args.commandHash,
    shell_dialect: args.input.shell_dialect,
    grammar_version: args.input.grammar_version,
    status: 'invalid_syntax' as CommandParseStatus,
    ast_ref: null,
    risk_facts: [] as CommandRiskFact[],
    complexity_metrics: {
      token_count: 0,
      operator_count: 0,
      nesting_depth: 0,
      source_length: args.sourceLength,
    },
    diagnostics: [`invalid_syntax: ${args.reason}`],
  });
}

/** 退化结果的 canonical:基于状态 + 输入身份,保证确定但区分。 */
function canonicalForDegraded(args: DegradedResultArgs, status: string): string {
  return [
    status,
    args.input.action_snapshot_id,
    args.commandHash,
    args.input.shell_dialect,
    args.input.grammar_version,
    args.sourceLength,
    args.reason,
  ].join('|');
}

// ─────────────────────────────────────────────
// canonical / hash 工具
// ─────────────────────────────────────────────

/**
 * parsed 状态的 canonical 串——包含全部影响结果身份的字段,
 * 保证相同输入 → 相同 parse_result_id。
 */
function buildCanonical(args: {
  actionSnapshotId: string;
  commandHash: string;
  shellDialect: string;
  grammarVersion: string;
  sourceLength: number;
  tokenCount: number;
  operatorCount: number;
  nestingDepth: number;
  facts: CommandRiskFact[];
}): string {
  // facts 用稳定表示:kind+risk_code+range,顺序即数组顺序(已确定)。
  const factsStr = args.facts
    .map((f) => `${f.kind}:${f.risk_code}:${f.source_range_ref}`)
    .join(',');
  return [
    PARSE_PROTOCOL_VERSION,
    args.actionSnapshotId,
    args.commandHash,
    args.shellDialect,
    args.grammarVersion,
    args.sourceLength,
    args.tokenCount,
    args.operatorCount,
    args.nestingDepth,
    factsStr,
  ].join('|');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════
// Wave D Task 13 (DRC-5): Shadow Comparison
// ═══════════════════════════════════════════════════════════════════════════
//
// 物理本质:shadow comparator 是"对照员"——它把"现行 policy 的 decision"
// 和"AST 推断的候选 behavior"放在一起比对,输出一份 divergence 报告。
// 它绝不修改现行 decision、绝不下执行结论。它的输出只允许进入 CRC-6 允许的
// decision trace / telemetry,不能驱动 execution / Outcome / permission。
//
// 不变量(INV-D14 / spec §11.5 + §11.6):
//   1. shadow 无执行权——不改变 allow/ask/deny/execution/pending/Outcome;
//   2. 类型上不存在 effective_security_decision_ref 字段——本类型与它无关;
//   3. AST candidate 只是被"回显",不能 allow/ask/deny/取消/修改动作;
//   4. shadow 不是"部分 enforcement",永远不影响现行 actual decision;
//   5. mode 只来自受信 policy_state,Prompt/用户/模型/telemetry 不能切换;
//   6. 历史 comparison immutable(freezeSnapshot);
//   7. mode='enforced' 由 T14 处理——本函数对 enforced 直接 throw,
//      不偷偷降级(spec §11.6 rule 8: enforcement failure 不能回退 legacy allow);
//   8. decision trace 写入失败不改变 SecurityDecision(spec §11.9)——
//      builder 抛错时降级为 null event_id,不传播异常。

/** Wave D 首个 shadow comparison 协议版本(硬编码 '1')。 */
export const SHADOW_PROTOCOL_VERSION = '1';

/** 受信 policy mode。只能从受信 runtime configuration 来。 */
export type CommandPolicyMode = 'shadow' | 'enforced';

/**
 * 受信 policy state(spec §11.2)。
 *
 * policy_ref 在 spec 中是 IntegratedContractRef;这里采用任务 T13 约定的
 * 字面量结构 { contract_id; contract_version },不引入新依赖。
 */
export interface CommandPolicyState {
  command_policy_protocol_version: string;
  policy_ref: { contract_id: string; contract_version: string };
  mode: CommandPolicyMode;
  shell_dialect: string;
  grammar_version: string;
  complexity_policy_ref: string;
  plan_allowlist_policy_ref: string;
}

/**
 * 5 类 divergence(spec §11.5):
 *   - none: legacy 与 AST 完全一致;
 *   - legacy_more_permissive: legacy 比 AST 更宽松(legacy 在严格度排序上更低);
 *   - ast_more_permissive: AST 比 legacy 更宽松;
 *   - classification_mismatch: 跨"询问/放行"类别的不可比差异;
 *   - not_comparable: 任一 behavior 为 null(spec §11.6:无法解析候选判定时使用)。
 */
export type CommandShadowDivergence =
  | 'none'
  | 'legacy_more_permissive'
  | 'ast_more_permissive'
  | 'classification_mismatch'
  | 'not_comparable';

/** shadow comparison 输入。 */
export interface CommandShadowComparisonInput {
  shadow_protocol_version: string;
  action_snapshot_id: string;
  /** 现行 policy 的 decision 引用——本函数不修改它对应的 decision。 */
  legacy_decision_ref: string;
  /** 现行 policy 的 decision behavior(对照基线)。null 表示无法对照。 */
  legacy_decision_behavior: 'allow' | 'ask' | 'deny' | null;
  /** T12 的 parser 产物。 */
  ast_parse_result: CommandParseResult;
  /** AST 推断的候选 behavior——shadow 中只是候选,无执行权。 */
  ast_candidate_behavior: 'allow' | 'ask' | 'deny' | null;
  /** 必须是 mode='shadow' 的受信 state;enforced 由 T14 处理。 */
  policy_state: CommandPolicyState;
  /**
   * 可选 decision trace builder(CRC-6 集成点)。
   * 不提供时 event_id 为 null——telemetry 不可用不影响现行 decision。
   */
  decision_trace_builder?: (input: {
    action_snapshot_id: string;
    subsystem: 'command_policy';
    legacy_decision_ref: string;
    ast_parse_result_id: string;
    divergence: CommandShadowDivergence;
  }) => string;
}

/** shadow comparison 输出(spec §11.5)。注意:不存在 effective_security_decision_ref 字段。 */
export interface CommandShadowComparison {
  shadow_protocol_version: string;
  comparison_id: string;
  action_snapshot_id: string;
  legacy_decision_ref: string;
  ast_candidate_behavior: 'allow' | 'ask' | 'deny' | null;
  divergence: CommandShadowDivergence;
  reason_codes: string[];
  /** builder 不提供或抛错时为 null(telemetry 不阻塞 spec §11.9)。 */
  decision_trace_event_id: string | null;
}

/**
 * divergence 算法(spec §11.5 + 任务 T13 契约):
 *   - 任一为 null → not_comparable;
 *   - 相等 → none;
 *   - 任一为 'ask'(且不相等)→ classification_mismatch:
 *       ask 是独立的"阻塞询问"类别,跨 ask 的差异不是简单"谁更宽松",
 *       而是两个 policy 在"该不该问用户"上根本分歧;
 *   - 否则(allow↔deny)→ 更宽(allow)的那一侧 more_permissive。
 *
 * 举例(任务 T13 契约):
 *   legacy=allow, ast=deny       → legacy_more_permissive;
 *   ast=allow,    legacy=deny    → ast_more_permissive;
 *   legacy=ask,   ast=allow      → classification_mismatch;
 *   legacy=allow, ast=ask        → classification_mismatch。
 */
function classifyDivergence(
  legacy: 'allow' | 'ask' | 'deny' | null,
  ast: 'allow' | 'ask' | 'deny' | null,
): CommandShadowDivergence {
  if (legacy === null || ast === null) {
    return 'not_comparable';
  }
  if (legacy === ast) {
    return 'none';
  }
  // 任一是 ask 且不相等 → 跨"询问"类别,不可直接比较宽松度。
  if (legacy === 'ask' || ast === 'ask') {
    return 'classification_mismatch';
  }
  // 剩下只有 allow↔deny:更宽(allow)的一侧 more_permissive。
  return legacy === 'allow' ? 'legacy_more_permissive' : 'ast_more_permissive';
}

/**
 * 计算 shadow comparison。
 *
 * 流程(spec §11.5):
 *   1. policy_state.mode 必须 'shadow'——'enforced' 直接 throw(T14 处理);
 *   2. identity 守门:action_snapshot_id / legacy_decision_ref /
 *      ast_parse_result.parse_result_id 非空;
 *   3. divergence 计算(见 classifyDivergence);
 *   4. decision_trace:builder 提供则调用,抛错降级为 null;
 *   5. comparison_id = `shadow:${sha256(canonical).slice(0,16)}`;
 *   6. freeze 返回。
 *
 * 不变量:本函数不调用 runtimeGate / executor / fs / child_process。
 *         builder 是纯函数式注入,失败被捕获后不影响 divergence。
 */
export function compareCommandPolicyShadow(
  input: CommandShadowComparisonInput,
): CommandShadowComparison {
  // ── Step 1: mode 守门(受信 policy_state 唯一来源)──
  if (input.policy_state.mode !== 'shadow') {
    throw new Error(
      `compareCommandPolicyShadow requires policy_state.mode='shadow' (got '${input.policy_state.mode}'); enforced mode is handled by the enforced composition path`,
    );
  }

  // ── Step 2: identity 守门 ──
  const actionSnapshotId = requireIdentity(
    input.action_snapshot_id,
    'action_snapshot_id',
  );
  const legacyDecisionRef = requireIdentity(
    input.legacy_decision_ref,
    'legacy_decision_ref',
  );
  const astParseResultId = requireIdentity(
    input.ast_parse_result.parse_result_id,
    'ast_parse_result.parse_result_id',
  );

  // ── Step 3: divergence ──
  const divergence = classifyDivergence(
    input.legacy_decision_behavior,
    input.ast_candidate_behavior,
  );

  // ── Step 4: reason_codes(只装 reason/risk codes,不记录 hidden reasoning)──
  const reasonCodes = buildReasonCodes(divergence, {
    legacy: input.legacy_decision_behavior,
    ast: input.ast_candidate_behavior,
  });

  // ── Step 5: decision trace(telemetry 不阻塞 spec §11.9)──
  let decisionTraceEventId: string | null = null;
  if (input.decision_trace_builder) {
    try {
      decisionTraceEventId = input.decision_trace_builder({
        action_snapshot_id: actionSnapshotId,
        subsystem: 'command_policy',
        legacy_decision_ref: legacyDecisionRef,
        ast_parse_result_id: astParseResultId,
        divergence,
      });
    } catch {
      // builder 抛错——降级为 null。telemetry 不可用不改变 SecurityDecision。
      decisionTraceEventId = null;
    }
  }

  // ── Step 6: comparison_id(canonical hash)──
  const canonical = buildShadowCanonical({
    shadowProtocolVersion: input.shadow_protocol_version,
    actionSnapshotId,
    legacyDecisionRef,
    legacyBehavior: input.legacy_decision_behavior,
    astParseResultId,
    astCandidateBehavior: input.ast_candidate_behavior,
    divergence,
    policyState: input.policy_state,
  });
  const comparisonId = `shadow:${sha256Hex(canonical).slice(0, 16)}`;

  // ── Step 7: freeze 返回 ──
  const result: CommandShadowComparison = {
    shadow_protocol_version: input.shadow_protocol_version,
    comparison_id: comparisonId,
    action_snapshot_id: actionSnapshotId,
    legacy_decision_ref: legacyDecisionRef,
    ast_candidate_behavior: input.ast_candidate_behavior,
    divergence,
    reason_codes: reasonCodes,
    decision_trace_event_id: decisionTraceEventId,
  };
  return freezeSnapshot(result);
}

/**
 * 根据 divergence 与原始 behavior 生成 reason_codes(spec §11.7 rule 9:
 * 决策解释只使用 reason/risk codes,不记录隐藏思维)。
 */
function buildReasonCodes(
  divergence: CommandShadowDivergence,
  behaviors: {
    legacy: 'allow' | 'ask' | 'deny' | null;
    ast: 'allow' | 'ask' | 'deny' | null;
  },
): string[] {
  const codes: string[] = [];
  const legacyStr = behaviors.legacy ?? 'unknown';
  const astStr = behaviors.ast ?? 'unknown';
  codes.push(`divergence:${divergence}`);
  codes.push(`legacy_behavior:${legacyStr}`);
  codes.push(`ast_candidate_behavior:${astStr}`);
  if (divergence === 'not_comparable') {
    codes.push('not_comparable:missing-candidate-behavior');
  } else if (divergence === 'classification_mismatch') {
    codes.push('classification:cross-category');
  }
  return codes;
}

/**
 * canonical 串——包含全部影响 comparison 身份的字段,保证相同输入 → 相同 ID。
 *
 * 故意不包含 decision_trace_event_id——它是副作用产物,不应让 trace 的成功/失败
 * 改变 comparison 的身份(否则 trace 暂时性故障会污染历史 comparison 的可寻址性)。
 */
function buildShadowCanonical(args: {
  shadowProtocolVersion: string;
  actionSnapshotId: string;
  legacyDecisionRef: string;
  legacyBehavior: 'allow' | 'ask' | 'deny' | null;
  astParseResultId: string;
  astCandidateBehavior: 'allow' | 'ask' | 'deny' | null;
  divergence: CommandShadowDivergence;
  policyState: CommandPolicyState;
}): string {
  const ps = args.policyState;
  return [
    args.shadowProtocolVersion,
    args.actionSnapshotId,
    args.legacyDecisionRef,
    args.legacyBehavior ?? 'null',
    args.astParseResultId,
    args.astCandidateBehavior ?? 'null',
    args.divergence,
    ps.command_policy_protocol_version,
    ps.policy_ref.contract_id,
    ps.policy_ref.contract_version,
    ps.mode,
    ps.shell_dialect,
    ps.grammar_version,
  ].join('|');
}

// ═══════════════════════════════════════════════════════════════════════════
// Wave D Task 14 (DRC-5): Enforced AND Composition + Activation Gate
// ═══════════════════════════════════════════════════════════════════════════
//
// 物理本质:enforced composer 是"五位安检员的合议庭书记员"——它把
// Plan allowlist、argument policy、path policy、AST structural、RC-5 permission
// 这五位安检员的判定用硬 AND 组合,产出唯一的有效 behavior,并绑出一份
// SecurityDecision 引用。任一位说 deny → 合议庭 deny;任一位说 ask → 合议庭 ask;
// 五位全 allow 才允许执行。
//
// 关键不变量(spec §11.6):
//   - INV-D14: shadow 无执行权——shadow 下 candidate_behavior=null,
//     effective_security_decision_ref=null;它不产出有效结论。
//   - INV-D15: AST 与 Plan policy AND 组合,五重 gate 互相独立、不互相覆盖。
//   - INV-D16: failures never upgrade state——parse failure / missing gate /
//     identity mismatch 均产出 deny,绝不"乐观放行"或"回退 shadow allow"。
//   - rule 4: Plan Mode 未知命令保持 deny(用户只能退出/切换模式);
//   - rule 5: Normal Mode unsupported/too-complex 不默认 allow;
//   - rule 6: ask channel unavailable → deny(本函数假设 channel 可用,
//     ask 不可用由调用方接入时处理);
//   - rule 7: enforced 有效结果必须引用绑定同一 action snapshot 的 SecurityDecision;
//   - rule 8: enforcement failure 不回退 shadow(spec §11.6 + §11.9)。
//
// 本函数不调用 runtimeGate / executor / fs / child_process。
// shadow 模式只是回声候选,绝不下执行结论;enforced 模式才合成 SecurityDecision 引用。

/** Wave D 首个 enforced composition 协议版本(硬编码 '1')。 */
export const STRUCTURAL_DECISION_PROTOCOL_VERSION = '1';

/** 单个 gate 的可能 behavior:allow / ask / deny,或 null=缺失。 */
export type CommandGateBehavior = 'allow' | 'ask' | 'deny' | null;

/** 五重 gate 决策集合(spec §11.6)。 */
export interface CommandStructuralGates {
  plan_allowlist: CommandGateBehavior;
  argument_policy: CommandGateBehavior;
  path_policy: CommandGateBehavior;
  /** 基于 parse_result 推断的 AST 结构判定。 */
  ast_structural: CommandGateBehavior;
  rc5_permission: CommandGateBehavior;
}

/** enforced composition 输入。 */
export interface CommandStructuralDecisionInput {
  structural_decision_protocol_version: string;
  action_snapshot_id: string;
  parse_result_id: string;
  /** T12 的 parser 产物——identity 检查会比对它的 action_snapshot_id。 */
  parse_result: CommandParseResult;
  policy_state_ref: string;
  policy_state_mode: CommandPolicyMode;
  /** 五重 gate 决策;null 表示该 gate 缺失。 */
  gates: CommandStructuralGates;
  /** 各 gate 的 decision 引用(透传到结果,便于 trace 回指)。 */
  gate_decision_refs: string[];
  /** parse failure 时按 control_mode 分流;未提供时默认 'normal_mode_ask_or_deny'。 */
  parse_failure_policy?: 'plan_mode_deny' | 'normal_mode_ask_or_deny';
  /** 'mode:plan@1' / 'mode:build@1' 等——Plan Mode 未知命令保持 deny。 */
  control_mode_snapshot_id: string;
}

/** enforced composition 输出(spec §11.6)。 */
export interface CommandStructuralDecision {
  structural_decision_protocol_version: string;
  structural_decision_id: string;
  action_snapshot_id: string;
  parse_result_id: string;
  policy_state_ref: string;
  mode: CommandPolicyMode;
  /** shadow 下恒为 null;enforced 下为 allow/ask/deny。 */
  candidate_behavior: 'allow' | 'ask' | 'deny' | null;
  /**
   * shadow 下恒为 null;enforced 且 candidate_behavior 非 null 时引用一个合成的
   * SecurityDecision(格式 `cmd:${action_snapshot_id}:${candidate_behavior}`)。
   */
  effective_security_decision_ref: string | null;
  gate_decision_refs: string[];
  reason_codes: string[];
  status: 'valid' | 'invalid';
}

/** 五重 gate 的固定顺序(canonical / reason_code 顺序使用)。 */
const GATE_ORDER = [
  'plan_allowlist',
  'argument_policy',
  'path_policy',
  'ast_structural',
  'rc5_permission',
] as const;

/**
 * 计算 enforced 模式的 AND 组合(spec §11.6 rule 1-3)。
 *
 * 输入约定:5 个 gate behavior,任一为 null 表示缺失。
 * 输出:
 *   - 任一 deny → 'deny';
 *   - 无 deny 且至少一个 ask → 'ask';
 *   - 全 allow → 'allow'。
 *
 * 注:本函数不处理 missing/parse-failure/identity-mismatch——这些在主入口里
 * 提前短路。它只处理"5 个 gate 都非 null"的纯组合。
 */
function composeAndGates(gates: CommandStructuralGates): {
  behavior: 'allow' | 'ask' | 'deny';
  reasonCodes: string[];
} {
  const values = GATE_ORDER.map((k) => ({
    name: k,
    value: gates[k] as 'allow' | 'ask' | 'deny',
  }));
  const reasonCodes: string[] = [];
  let hasAsk = false;
  for (const g of values) {
    if (g.value === 'deny') {
      reasonCodes.push(`gate.deny:${g.name}`);
      return { behavior: 'deny', reasonCodes };
    }
    if (g.value === 'ask') {
      hasAsk = true;
    }
  }
  if (hasAsk) {
    return { behavior: 'ask', reasonCodes: ['gate.blocked_by_ask'] };
  }
  return { behavior: 'allow', reasonCodes: ['gate.all_allow'] };
}

/**
 * 主入口:把五重 gate 与 parse_result 合成 enforced structural decision。
 *
 * 流程(spec §11.6 + §11.9):
 *   1. identity 守门:action_snapshot_id / parse_result_id / policy_state_ref 非空;
 *   2. mode='shadow' → 退化为候选(candidate_behavior=null,
 *      effective_security_decision_ref=null),status='valid',直接返回;
 *   3. identity mismatch:action_snapshot_id 与 parse_result.action_snapshot_id
 *      不一致 → deny(spec §11.9);
 *   4. missing gate:任一 gate === null → deny(reason 'gate.missing');
 *   5. parse failure:parse_result.status !== 'parsed' → 按 control_mode 分流:
 *      - Plan Mode → deny(reason 'parse_failure:plan_mode_deny');
 *      - Normal Mode → 按 parse_failure_policy,默认 deny(reason 'parse_failure:normal_mode_deny');
 *   6. AND 组合(composeAndGates);
 *   7. effective_security_decision_ref:enforced 且 candidate_behavior 非 null
 *      → `cmd:${action_snapshot_id}:${candidate_behavior}`;否则 null;
 *   8. structural_decision_id = `structural:${sha256(canonical).slice(0,16)}`;
 *   9. freeze 返回。
 *
 * 不变量:本函数不调用 runtimeGate / executor / fs / child_process。
 *         所有路径都不"回退 shadow allow"——shadow 显式 mode 切换才退化为候选。
 */
export function composeCommandStructuralDecision(
  input: CommandStructuralDecisionInput,
): CommandStructuralDecision {
  // ── Step 1: identity 守门 ──
  const actionSnapshotId = requireIdentity(
    input.action_snapshot_id,
    'action_snapshot_id',
  );
  const parseResultId = requireIdentity(input.parse_result_id, 'parse_result_id');
  requireIdentity(input.policy_state_ref, 'policy_state_ref');
  requireIdentity(input.control_mode_snapshot_id, 'control_mode_snapshot_id');

  // ── Step 2: shadow 退化为候选(无执行权,INV-D14)──
  if (input.policy_state_mode === 'shadow') {
    const canonical = buildStructuralCanonical({
      protocolVersion: input.structural_decision_protocol_version,
      actionSnapshotId,
      parseResultId,
      policyStateRef: input.policy_state_ref,
      mode: 'shadow',
      candidateBehavior: null,
      gateDecisionRefs: input.gate_decision_refs,
      controlModeSnapshotId: input.control_mode_snapshot_id,
    });
    const result: CommandStructuralDecision = {
      structural_decision_protocol_version: input.structural_decision_protocol_version,
      structural_decision_id: `structural:${sha256Hex(canonical).slice(0, 16)}`,
      action_snapshot_id: actionSnapshotId,
      parse_result_id: parseResultId,
      policy_state_ref: input.policy_state_ref,
      mode: 'shadow',
      candidate_behavior: null,
      effective_security_decision_ref: null,
      gate_decision_refs: [...input.gate_decision_refs],
      reason_codes: ['mode.shadow_no_authority'],
      status: 'valid',
    };
    return freezeSnapshot(result) as CommandStructuralDecision;
  }

  // enforced 路径——所有失败均产出 deny(绝不回退 shadow allow,INV-D16)。
  const reasonCodes: string[] = [];
  let candidateBehavior: 'allow' | 'ask' | 'deny' = 'deny';

  // ── Step 3: identity mismatch(spec §11.9)──
  if (input.parse_result.action_snapshot_id !== actionSnapshotId) {
    reasonCodes.push('identity.mismatch');
    candidateBehavior = 'deny';
  } else {
    // ── Step 4: missing gate(spec §11.6 rule + §11.9)──
    const missingGates = GATE_ORDER.filter((k) => input.gates[k] === null);
    if (missingGates.length > 0) {
      reasonCodes.push('gate.missing');
      for (const name of missingGates) {
        reasonCodes.push(`gate.missing:${name}`);
      }
      candidateBehavior = 'deny';
    } else {
      // ── Step 5: parse failure(spec §11.9)──
      if (input.parse_result.status !== 'parsed') {
        const isPlanMode = input.control_mode_snapshot_id.startsWith('mode:plan');
        if (isPlanMode) {
          // rule 4: Plan Mode 未知命令保持 deny。
          reasonCodes.push('parse_failure:plan_mode_deny');
          candidateBehavior = 'deny';
        } else {
          // rule 5: Normal Mode unsupported/too-complex 不默认 allow;
          // parse_failure_policy 默认 'normal_mode_ask_or_deny',保守选 deny。
          const policy = input.parse_failure_policy ?? 'normal_mode_ask_or_deny';
          reasonCodes.push(`parse_failure:normal_mode_${policy === 'plan_mode_deny' ? 'deny' : 'deny'}`);
          candidateBehavior = 'deny';
        }
      } else {
        // ── Step 6: AND 组合(spec §11.6 rule 1-3)──
        const composed = composeAndGates(input.gates);
        candidateBehavior = composed.behavior;
        reasonCodes.push(...composed.reasonCodes);
      }
    }
  }

  // ── Step 7: effective_security_decision_ref(spec §11.6 rule 7)──
  const effectiveRef = `cmd:${actionSnapshotId}:${candidateBehavior}`;

  // ── Step 8: structural_decision_id(canonical hash)──
  const canonical = buildStructuralCanonical({
    protocolVersion: input.structural_decision_protocol_version,
    actionSnapshotId,
    parseResultId,
    policyStateRef: input.policy_state_ref,
    mode: 'enforced',
    candidateBehavior,
    gateDecisionRefs: input.gate_decision_refs,
    controlModeSnapshotId: input.control_mode_snapshot_id,
  });

  // ── Step 9: freeze 返回 ──
  const result: CommandStructuralDecision = {
    structural_decision_protocol_version: input.structural_decision_protocol_version,
    structural_decision_id: `structural:${sha256Hex(canonical).slice(0, 16)}`,
    action_snapshot_id: actionSnapshotId,
    parse_result_id: parseResultId,
    policy_state_ref: input.policy_state_ref,
    mode: 'enforced',
    candidate_behavior: candidateBehavior,
    effective_security_decision_ref: effectiveRef,
    gate_decision_refs: [...input.gate_decision_refs],
    reason_codes: reasonCodes,
    status: 'valid',
  };
  return freezeSnapshot(result) as CommandStructuralDecision;
}

/**
 * canonical 串——包含全部影响 structural decision 身份的字段,
 * 保证相同输入 → 相同 ID。
 *
 * 故意不包含 reason_codes——reason 是派生产物,不应让 reason 表述的细微差异
 * 改变 decision 的身份(canonical 必须只随"实质输入"变化)。
 */
function buildStructuralCanonical(args: {
  protocolVersion: string;
  actionSnapshotId: string;
  parseResultId: string;
  policyStateRef: string;
  mode: CommandPolicyMode;
  candidateBehavior: 'allow' | 'ask' | 'deny' | null;
  gateDecisionRefs: string[];
  controlModeSnapshotId: string;
}): string {
  return [
    args.protocolVersion,
    args.actionSnapshotId,
    args.parseResultId,
    args.policyStateRef,
    args.mode,
    args.candidateBehavior ?? 'null',
    args.gateDecisionRefs.slice().sort().join(','),
    args.controlModeSnapshotId,
  ].join('|');
}

// ─────────────────────────────────────────────
// Activation Gate(spec §11.8)
// ─────────────────────────────────────────────

/**
 * Activation Gate 输入:9 项 evidence(spec §11.8)。
 *
 * 每一项都是"上线前必须验证"的客观证据——任一为 false 表示该 evidence 缺失,
 * shadow → enforced 的切换不能进行。
 */
export interface ActivationGateInput {
  /** 目标 shell dialect 的 grammar/version 已冻结。 */
  grammar_version_frozen: boolean;
  /** 基准 corpus 覆盖 substitution/redirect/pipeline/control flow/quoting。 */
  corpus_covers_substitution_redirect_pipeline_control_flow_quoting: boolean;
  /** 基准 corpus 覆盖 environment assignment / executable candidate。 */
  corpus_covers_environment_assignment_executable_candidate: boolean;
  /** legacy/AST divergence 有明确分类。 */
  divergence_baseline_recorded: boolean;
  /** false allow / false deny 基线已记录。 */
  false_allow_false_deny_baseline_recorded: boolean;
  /** too_complex policy 已冻结。 */
  too_complex_policy_frozen: boolean;
  /** Plan allowlist / argument / path / RC-5 composition 已验证。 */
  plan_argument_path_rc5_composition_verified: boolean;
  /** action snapshot 与 blocking ask 可持久化。 */
  pending_ask_persistence_verified: boolean;
  /** rollback 只切换 policy state,不修改历史 decision。 */
  rollback_policy_state_only_verified: boolean;
}

/** Activation Gate 输出。 */
export interface ActivationGateResult {
  activated: boolean;
  /** 缺失的 evidence 字段名列表(activated=false 时非空)。 */
  missing: string[];
}

/** 9 项 evidence 的字段名(顺序固定,用于 missing 列表)。 */
const ACTIVATION_EVIDENCE_KEYS = [
  'grammar_version_frozen',
  'corpus_covers_substitution_redirect_pipeline_control_flow_quoting',
  'corpus_covers_environment_assignment_executable_candidate',
  'divergence_baseline_recorded',
  'false_allow_false_deny_baseline_recorded',
  'too_complex_policy_frozen',
  'plan_argument_path_rc5_composition_verified',
  'pending_ask_persistence_verified',
  'rollback_policy_state_only_verified',
] as const;

/**
 * 检查 shadow → enforced 切换是否满足 9 项 evidence(spec §11.8)。
 *
 * 流程:
 *   1. 遍历 9 项 evidence;
 *   2. 任一为 false → missing 列表加入该字段名;
 *   3. missing 非空 → activated=false;否则 activated=true。
 *
 * 不变量:本函数不读取外部状态、不修改输入、不抛错(只看布尔字段)。
 *         "这些是 Activation 门,不新增 M-055 或 M-065 为 DRC-5 设计前置"(spec §11.8)。
 */
export function assertActivationGate(input: ActivationGateInput): ActivationGateResult {
  const missing: string[] = [];
  for (const key of ACTIVATION_EVIDENCE_KEYS) {
    if (input[key] !== true) {
      missing.push(key);
    }
  }
  return {
    activated: missing.length === 0,
    missing,
  };
}
