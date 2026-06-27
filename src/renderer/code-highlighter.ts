// 代码语法高亮器：为代码块添加 ANSI 颜色
//
// 物理本质：荧光笔。
// 看书时用不同颜色的荧光笔标记不同类型的内容：
// - 关键字 → 青色
// - 字符串 → 绿色
// - 注释 → 灰色
// - 数字 → 黄色

import { ANSI } from './colors.js';

const TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'class', 'import', 'export', 'async', 'await', 'type', 'interface', 'enum',
  'extends', 'implements', 'new', 'this', 'super', 'try', 'catch', 'finally',
  'throw', 'switch', 'case', 'default', 'break', 'continue', 'void', 'null',
  'undefined', 'true', 'false', 'typeof', 'instanceof', 'in', 'of', 'from',
  'as', 'static', 'private', 'protected', 'public', 'abstract', 'readonly',
]);

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'else', 'elif', 'for', 'while', 'import',
  'from', 'async', 'await', 'try', 'except', 'finally', 'raise', 'pass',
  'yield', 'lambda', 'with', 'as', 'in', 'not', 'and', 'or', 'is', 'None',
  'True', 'False', 'self', 'print', 'range', 'len', 'str', 'int', 'float',
  'list', 'dict', 'set', 'tuple', 'bool',
]);

export class CodeHighlighter {
  highlight(code: string, language: string): string {
    const keywords = this.getKeywords(language);
    const lines = code.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      const highlighted = this.highlightLine(line, keywords);
      result.push(`${ANSI.border}│ ${ANSI.reset}${highlighted}`);
    }

    return result.join('\n');
  }

  private getKeywords(language: string): Set<string> {
    const lang = language.toLowerCase();
    if (lang === 'typescript' || lang === 'ts' || lang === 'javascript' || lang === 'js') {
      return TS_KEYWORDS;
    }
    if (lang === 'python' || lang === 'py') {
      return PY_KEYWORDS;
    }
    return new Set();
  }

  private highlightLine(line: string, keywords: Set<string>): string {
    let result = '';
    let i = 0;

    while (i < line.length) {
      const char = line[i]!;

      // C/C++ 单行注释
      if (char === '/' && line[i + 1] === '/') {
        result += `${ANSI.comment}${line.substring(i)}${ANSI.reset}`;
        return result;
      }

      // Python 注释：仅当 # 在行首或空格后时才判定为注释
      // 排除 #include、#define 等预处理指令（# 后紧跟字母）
      if (char === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
        const next = line[i + 1];
        // # 后面是字母 → 可能是预处理指令，不着色
        if (next && ((next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z'))) {
          // 跳过，当作普通文本处理
        } else {
          result += `${ANSI.comment}${line.substring(i)}${ANSI.reset}`;
          return result;
        }
      }

      // C 块注释
      if (char === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2);
        if (end !== -1) {
          result += `${ANSI.comment}${line.substring(i, end + 2)}${ANSI.reset}`;
          i = end + 2;
          continue;
        } else {
          result += `${ANSI.comment}${line.substring(i)}${ANSI.reset}`;
          return result;
        }
      }

      // 字符串
      if (char === '"' || char === "'" || char === '`') {
        const quote = char;
        let j = i + 1;
        while (j < line.length && line[j] !== quote) {
          if (line[j] === '\\') j++;
          j++;
        }
        result += `${ANSI.string}${line.substring(i, j + 1)}${ANSI.reset}`;
        i = j + 1;
        continue;
      }

      // 数字
      if (char >= '0' && char <= '9') {
        let j = i;
        while (j < line.length && (line[j]! >= '0' && line[j]! <= '9' || line[j] === '.')) {
          j++;
        }
        result += `${ANSI.number}${line.substring(i, j)}${ANSI.reset}`;
        i = j;
        continue;
      }

      // 关键字或标识符
      if ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_') {
        let j = i;
        while (j < line.length && (
          (line[j]! >= 'a' && line[j]! <= 'z') ||
          (line[j]! >= 'A' && line[j]! <= 'Z') ||
          (line[j]! >= '0' && line[j]! <= '9') ||
          line[j] === '_'
        )) {
          j++;
        }
        const word = line.substring(i, j);
        if (keywords.has(word)) {
          result += `${ANSI.keyword}${word}${ANSI.reset}`;
        } else {
          result += word;
        }
        i = j;
        continue;
      }

      result += char;
      i++;
    }

    return result;
  }
}
