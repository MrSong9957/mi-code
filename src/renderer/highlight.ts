// 轻量正则代码高亮
//
// 物理本质：给代码里的"关键字/字符串/注释/数字"分别贴不同颜色的标签。
// 用**单遍 token 扫描**（在位置上向前看，判定当前 token 类型），
// 不是多个全局正则替换——后者会让颜色互相覆盖。
//
// 不追求 AST 级精确（那是 Shiki 的活），只做常见语言的关键字/字符串/注释/数字着色，
// 足够终端可读。未知语言降级为单色。

import { stringToCells, type Cell, type Style } from './cell.js';

/** token 类别 → 样式（用 theme 的 code* 语义 token） */
const STYLE: Record<string, Style> = {
  keyword: { fg: 'codeKeyword', bold: true },
  string: { fg: 'codeString' },
  comment: { fg: 'codeComment', dim: true },
  number: { fg: 'codeNumber' },
  punct: { fg: 'codeOperator' },
  plain: {},
  fallback: { fg: 'brand', dim: true }, // 未知语言降级单色
};

/** 语言规则 */
interface LangRule {
  keywords: Set<string>;
  lineComment: string | null;   // 行注释起始符（如 // 或 #）
  blockComment: [string, string] | null; // 块注释 /* */
  stringChars: string[];        // 字符串引号（如 ["'", '"']）
}

const KEYWORDS: Record<string, string[]> = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'import', 'export', 'from', 'default', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'extends', 'static', 'get', 'set', 'yield', 'delete', 'void', 'switch', 'case', 'break', 'continue', 'do'],
  ts: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'import', 'export', 'from', 'default', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'extends', 'static', 'get', 'set', 'yield', 'delete', 'void', 'switch', 'case', 'break', 'continue', 'do', 'interface', 'type', 'enum', 'namespace', 'public', 'private', 'protected', 'readonly', 'implements', 'as', 'is', 'keyof', 'infer', 'declare', 'abstract', 'satisfies'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'echo', 'export', 'local', 'read', 'set', 'unset', 'source', 'cd', 'pwd', 'exit', 'true', 'false'],
  py: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'pass', 'break', 'continue', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'self', 'yield', 'global', 'nonlocal', 'assert', 'del'],
  json: ['true', 'false', 'null'],
};

const RULES: Record<string, LangRule> = {
  js: { keywords: new Set(KEYWORDS.js), lineComment: '//', blockComment: ['/*', '*/'], stringChars: ["'", '"', '`'] },
  javascript: { keywords: new Set(KEYWORDS.js), lineComment: '//', blockComment: ['/*', '*/'], stringChars: ["'", '"', '`'] },
  ts: { keywords: new Set(KEYWORDS.ts), lineComment: '//', blockComment: ['/*', '*/'], stringChars: ["'", '"', '`'] },
  typescript: { keywords: new Set(KEYWORDS.ts), lineComment: '//', blockComment: ['/*', '*/'], stringChars: ["'", '"', '`'] },
  bash: { keywords: new Set(KEYWORDS.bash), lineComment: '#', blockComment: null, stringChars: ["'", '"'] },
  sh: { keywords: new Set(KEYWORDS.bash), lineComment: '#', blockComment: null, stringChars: ["'", '"'] },
  shell: { keywords: new Set(KEYWORDS.bash), lineComment: '#', blockComment: null, stringChars: ["'", '"'] },
  py: { keywords: new Set(KEYWORDS.py), lineComment: '#', blockComment: null, stringChars: ["'", '"'] },
  python: { keywords: new Set(KEYWORDS.py), lineComment: '#', blockComment: null, stringChars: ["'", '"'] },
  json: { keywords: new Set(KEYWORDS.json), lineComment: null, blockComment: null, stringChars: ['"'] },
};

/** 语言别名归一化 */
function normalizeLang(lang: string): string {
  const l = lang.toLowerCase().trim();
  if (l in RULES) return l;
  if (['js', 'javascript'].includes(l)) return 'js';
  if (['ts', 'typescript'].includes(l)) return 'ts';
  if (['bash', 'sh', 'shell', 'zsh'].includes(l)) return 'bash';
  if (['py', 'python'].includes(l)) return 'py';
  return '';
}

/**
 * 高亮一段代码，返回带样式的 cells（含换行符）。
 * 未知语言 → 整体降级为 fallback 单色，不报错。
 */
export function highlightCode(code: string, lang: string): Cell[] {
  const norm = normalizeLang(lang);
  if (!norm) {
    // 未知语言：原文 + fallback 单色
    return stringToCells(code, STYLE.fallback!);
  }
  const rule = RULES[norm]!;
  return scan(code, rule);
}

/** 单遍扫描：在位置 i 判定当前 token 类型，产出对应样式的一段 cells。 */
function scan(code: string, rule: LangRule): Cell[] {
  const out: Cell[] = [];
  let i = 0;
  const n = code.length;
  const isWordChar = (c: string) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = code[i]!;

    // 块注释（最高优先级，跨行）
    if (rule.blockComment && code.startsWith(rule.blockComment[0], i)) {
      const end = code.indexOf(rule.blockComment[1], i + rule.blockComment[0].length);
      const stop = end === -1 ? n : end + rule.blockComment[1].length;
      pushStyled(out, code.slice(i, stop), STYLE.comment!);
      i = stop;
      continue;
    }
    // 行注释
    if (rule.lineComment && code.startsWith(rule.lineComment, i)) {
      let nl = code.indexOf('\n', i);
      if (nl === -1) nl = n;
      pushStyled(out, code.slice(i, nl), STYLE.comment!);
      i = nl;
      continue;
    }
    // 字符串
    if (rule.stringChars.includes(c)) {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\' && j + 1 < n) { j += 2; continue; } // 转义
        if (code[j] === quote) { j++; break; }
        if (code[j] === '\n') break; // 字符串不跨行
        j++;
      }
      pushStyled(out, code.slice(i, j), STYLE.string!);
      i = j;
      continue;
    }
    // 数字
    if (/[0-9]/.test(c) && (i === 0 || !isWordChar(code[i - 1]!))) {
      let j = i;
      while (j < n && /[0-9._eExXa-fA-F]/.test(code[j]!)) j++;
      pushStyled(out, code.slice(i, j), STYLE.number!);
      i = j;
      continue;
    }
    // 标识符 / 关键字
    if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(code[j]!)) j++;
      const word = code.slice(i, j);
      const sty = rule.keywords.has(word) ? STYLE.keyword! : STYLE.plain!;
      pushStyled(out, word, sty);
      i = j;
      continue;
    }
    // 标点（零散符号）
    if (/[{}()[\];,.:]/.test(c)) {
      pushStyled(out, c, STYLE.punct!);
      i++;
      continue;
    }
    // 其它（含换行、空格、运算符）—— plain
    out.push({ char: c, style: {} });
    i++;
  }
  return out;
}

/** 把一段文本按字符铺成带相同样式的 cells（emoji/CJK 不拆字节）。 */
function pushStyled(out: Cell[], text: string, style: Style): void {
  for (const ch of text) out.push({ char: ch, style });
}
