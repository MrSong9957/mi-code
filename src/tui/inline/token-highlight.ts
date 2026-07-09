// src/tui/inline/token-highlight.ts
// Inline token 检测：把一行文本切成 segments（白色默认/蓝色/加粗）
//
// 物理本质：文档校对员的「荧光笔」。
// 一行文本像一份手稿，本模块用荧光笔标出重点：
//   - 反引号代码 `npm install` → 蓝色（去掉反引号）
//   - Markdown 加粗 **text** → 加粗（去掉 **）
//   - 裸文件路径/目录名/包名 → 蓝色
// 其余文字保持默认（白色，不加 SGR）。
//
// 设计原则（对齐 Claude Code）：
// 1. 正文白色为主，只在重点处着色——而非全文染色
// 2. 用轻量正则扫描，不引入完整 markdown 解析器（性能 + 简洁）
// 3. 纯函数，无副作用，易测试

import { sgr } from './ansi-utils.js';

/** RESET 序列（所有属性归零） */
const RESET = sgr('0');
/** 蓝色 SGR（34） */
const BLUE = sgr('34');
/** 加粗 SGR（1） */
const BOLD = sgr('1');

/** 一个文本片段：内容 + 样式（空 SGR = 白色默认） */
export interface TextSegment {
  /** 片段文本（已去掉 markdown 标记如反引号/星号） */
  text: string;
  /** SGR 样式串（空串 = 白色默认，不加任何 SGR） */
  sgr: string;
}

/**
 * 把一行文本切成 segments。
 *
 * 检测规则（按优先级，先匹配的先消费）：
 * 1. 反引号代码 `` `...` `` → 蓝色（内容去掉反引号）
 * 2. Markdown 加粗 `**...**` → 加粗（去掉 **）
 * 3. 裸路径/目录/包名 → 蓝色
 * 4. 其余 → 白色默认
 *
 * @param line 一行文本（不含 ANSI 序列）
 * @returns segments 数组（空行返回空数组）
 */
export function detectTokens(line: string): TextSegment[] {
  if (line === '') return [];

  const segments: TextSegment[] = [];
  // 合并所有 token 模式为一个全局正则，按出现位置排序处理
  // 用捕获组区分类型：1=反引号代码，2=加粗内容，3=裸路径
  const tokenRe = /`([^`]+)`|\*\*([^*]+)\*\*|([\w./-]*\.(?:ts|tsx|js|jsx|json|md|py|sh|yml|yaml|toml)|\.?[\w-]+\/[\w./-]+|node_modules|\.transcripts|dist|package\.json|tsconfig\.json|AGENTS\.md|CLAUDE\.md)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(line)) !== null) {
    // match 前的普通文本 → 白色默认 segment
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index), sgr: '' });
    }

    if (match[1] !== undefined) {
      // 反引号代码 → 蓝色
      segments.push({ text: match[1], sgr: BLUE });
    } else if (match[2] !== undefined) {
      // 加粗 → bold
      segments.push({ text: match[2], sgr: BOLD });
    } else if (match[3] !== undefined) {
      // 裸路径/目录/包名 → 蓝色
      segments.push({ text: match[3], sgr: BLUE });
    }

    lastIndex = tokenRe.lastIndex;
  }

  // 尾部普通文本
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), sgr: '' });
  }

  return segments;
}

/**
 * 把一行文本高亮成 ANSI 串。
 *
 * 纯文本部分原样输出（白色默认），有样式的片段包裹 SGR...RESET。
 * 无任何 token 时返回原文本（零 SGR 开销）。
 *
 * @param line 一行文本
 * @returns 带 ANSI 高亮的字符串
 */
export function highlightLine(line: string): string {
  const segments = detectTokens(line);
  if (segments.length === 0) return line;
  // 全部无 SGR 时直接返回原文（避免无意义的拼接）
  if (segments.every(s => s.sgr === '')) {
    return segments.map(s => s.text).join('');
  }
  return segments
    .map(seg => (seg.sgr ? `${seg.sgr}${seg.text}${RESET}` : seg.text))
    .join('');
}
