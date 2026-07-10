// run_bash 路径沙箱：从 bash 命令字符串提取文件系统路径候选
//
// 物理本质（保姆级）：
// run_bash 是个"会翻墙的快递员"——它能用 cat/tee/>/cp 等命令
// 把东西送到小区（workdir）外。本模块是"快递单扫描仪"：
// 看看快递员手里的单子（命令字符串），有没有指向小区外的地址（路径）。
//
// 设计原则（复用至上 + 事实优先）：
// 1. 用 shell-quote 做词法解析（不手写 tokenizer，复用成熟库）
// 2. 重定向目标（> >> <）必为路径，无条件提取（最高信号、零误判）
// 3. verb-aware：只对已知读写 verb 提取路径参数，未知 verb 跳过（保守下检）
// 4. 误判防护：URL/flag/@scope/glob 一律排除
// 5. $VAR 值未知 → unresolvableVars（升级人审，不猜）
// 6. 解析失败 → parseFailed（升级人审，不放行）

import { parse } from 'shell-quote';
import { homedir } from 'os';

/**
 * 展开 ~ 为家目录绝对路径
 *
 * shell-quote 不展开 ~，会把 ~/.ssh/id_rsa 当字面量字符串。
 * 若不展开，resolve(workdir, '~/.ssh/...') 会得到 <workdir>/~/.ssh/...，
 * 误判为工作区内路径——家目录敏感文件（SSH key、.aws 凭证）漏检。
 * 故提取后立即展开 ~ 为 homedir()，让后续 isPathOutsideWorkspace 正确判定。
 */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

/** 提取结果 */
export interface BashPathExtraction {
  /** 命令中出现的路径候选（可能越界也可能在区内，由调用方判定） */
  paths: string[];
  /** 是否含 $VAR/${VAR} 引用（值未知，需人审） */
  unresolvableVars: boolean;
  /** shell-quote 解析是否失败（看不懂，需人审） */
  parseFailed: boolean;
}

/** 重定向 operator（目标必为路径） */
const REDIRECT_OPS = new Set(['>', '>>', '<']);

/**
 * 值未知的变量引用模式：$VAR 或 ${VAR}
 *
 * 注意：故意不匹配 $(...) 命令替换——那已被 isDangerousBash 的 $() 模式拦截。
 * 只匹配纯变量引用，捕获"值未知"的语义。
 */
const UNRESOLVABLE_VAR = /\$[{]?[A-Za-z_][A-Za-z0-9_]*[}]?/;

/** URL scheme（http://, https://, ftp:// 等，非文件系统路径） */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** @scope/pkg（npm 包名，非文件系统路径） */
const NPM_SCOPE = /^@[^/]+\//;

/** glob 通配符（含未转义 * 或 ?，不是单一路径） */
const HAS_GLOB = /[*?]/;

/** 已知的"路径型"verb：它们的位置参数通常是文件路径 */
const PATH_VERBS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'tac', 'nl',     // 读
  'cp', 'mv', 'tee', 'install', 'dd',                       // 写/复制
  'ln', 'readlink', 'stat', 'file',                         // 元信息
  'vim', 'vi', 'nano', 'emacs',                             // 编辑器（读写）
  'sh', 'bash', 'source', '.',                              // 脚本执行（读文件）
]);

/**
 * 判定一个 token 是否应当作为路径候选提取
 *
 * 排除规则（误判防护）：
 * - URL：含 scheme（http://）——是网络地址不是文件
 * - flag：前导 - ——是选项不是路径
 * - @scope/pkg：npm 包名
 * - glob：含 * 或 ? ——是模式不是单一路径
 */
function isPathCandidate(token: string): boolean {
  if (token === '') return false;
  if (URL_SCHEME.test(token)) return false;
  if (token.startsWith('-')) return false;
  if (NPM_SCOPE.test(token)) return false;
  if (HAS_GLOB.test(token)) return false;
  return true;
}

/**
 * 从 bash 命令字符串提取路径候选
 *
 * 算法：
 *   1. 预扫描 $VAR → unresolvableVars
 *   2. shell-quote.parse 包 try/catch → parseFailed
 *   3. 按 operator 分割命令单元
 *   4. 重定向目标（> >> < 后紧邻 token）无条件提取
 *   5. verb-aware：已知 PATH_VERBS 的非 flag 位置参数提取
 *   6. 全程用 isPathCandidate 排除 URL/flag/glob
 *
 * 纯函数，无副作用，不访问文件系统。
 */
export function extractBashPaths(command: string): BashPathExtraction {
  const paths: string[] = [];

  // 步骤 1：预扫描变量引用（$VAR 值未知）
  if (UNRESOLVABLE_VAR.test(command)) {
    return { paths, unresolvableVars: true, parseFailed: false };
  }

  // 步骤 2：解析
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    return { paths, unresolvableVars: false, parseFailed: true };
  }

  // 步骤 3-5：遍历 token，按 operator 边界处理
  let expectingRedirectTarget = false;
  let currentVerb = '';

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // operator 对象：{op:'>'} 等
    if (typeof tok === 'object' && tok !== null && 'op' in tok) {
      const op = (tok as { op: string }).op;
      if (REDIRECT_OPS.has(op)) {
        // 下一个非空 token 是重定向目标（必为路径）
        expectingRedirectTarget = true;
      } else {
        // | && ; — 新命令单元开始，重置 verb
        currentVerb = '';
      }
      continue;
    }

    // 字符串 token
    if (typeof tok !== 'string') continue;

    if (tok === '') continue;

    if (expectingRedirectTarget) {
      // 重定向目标：必为路径，但仍排除空串；展开 ~ 为家目录
      if (tok !== '') paths.push(expandTilde(tok));
      expectingRedirectTarget = false;
      continue;
    }

    // 非 flag token 且当前无 verb → 这是新命令单元的 verb
    if (currentVerb === '' && !tok.startsWith('-')) {
      currentVerb = tok;
      continue;
    }

    // verb 已知且是路径型 verb → 提取非 flag 参数
    if (currentVerb !== '' && PATH_VERBS.has(currentVerb) && isPathCandidate(tok)) {
      paths.push(expandTilde(tok));
    }
  }

  return { paths, unresolvableVars: false, parseFailed: false };
}
