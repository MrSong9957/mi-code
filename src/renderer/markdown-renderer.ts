// Markdown 流式渲染器：将 Markdown 文本转换为带 ANSI 颜色的文本
//
// 物理本质：实时翻译员。
// AI 输出的 Markdown 是"原文"，这个模块翻译成带颜色的"译文"。
// 状态机就像翻译员的"记忆"，记住当前在翻译什么类型的文本。

import { ANSI } from './colors.js';
import { CodeHighlighter } from './code-highlighter.js';

/** 渲染状态 */
export type RenderState =
  | 'normal'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bold'
  | 'italic'
  | 'code_inline'
  | 'quote'
  | 'list';

/**
 * MarkdownStreamRenderer
 *
 * 状态机驱动的 Markdown 流式渲染器。
 */
export class MarkdownStreamRenderer {
  private state: RenderState = 'normal';
  private lineBuffer = '';
  private isInCodeBlock = false;
  private pendingBuffer = '';
  private codeBlockBuffer = '';
  private codeBlockLanguage = '';
  private codeHighlighter = new CodeHighlighter();

  renderToken(token: string): string {
    // 合并上一次未完成的标记
    token = this.pendingBuffer + token;
    this.pendingBuffer = '';
    let output = '';

    for (let i = 0; i < token.length; i++) {
      const char = token[i]!;
      const next = token[i + 1];
      const next2 = token[i + 2];

      if (this.isInCodeBlock) {
        if (char === '`' && next === '`' && next2 === '`') {
          // 代码块结束：应用语法高亮
          const highlighted = this.codeHighlighter.highlight(this.codeBlockBuffer, this.codeBlockLanguage);
          output += highlighted + '\n';
          output += `${ANSI.cyan}\`\`\`${ANSI.reset}\n`;
          this.isInCodeBlock = false;
          this.codeBlockBuffer = '';
          this.codeBlockLanguage = '';
          this.state = 'normal';
          i += 2;
          continue;
        }
        this.codeBlockBuffer += char;
        continue;
      }

      if (this.lineBuffer === '' || this.lineBuffer.endsWith('\n')) {
        if (char === '#') {
          const level = this.countChar(token, i, '#');
          if (level <= 3 && token[i + level] === ' ') {
            this.state = `heading${level}` as RenderState;
            output += ANSI[`heading${level}` as keyof typeof ANSI];
            i += level;
            continue;
          }
        }

        if (char === '>' && (next === ' ' || next === '\n')) {
          this.state = 'quote';
          output += `${ANSI.quote}│ ${ANSI.reset}`;
          i++;
          continue;
        }

        if ((char === '-' || char === '*') && next === ' ') {
          this.state = 'list';
          output += `${ANSI.list}• ${ANSI.reset}`;
          i++;
          continue;
        }

        if (char >= '0' && char <= '9') {
          let num = char;
          let j = i + 1;
          while (j < token.length && token[j]! >= '0' && token[j]! <= '9') {
            num += token[j]!;
            j++;
          }
          if (token[j] === '.' && token[j + 1] === ' ') {
            this.state = 'list';
            output += `${ANSI.list}${num}. ${ANSI.reset}`;
            i = j + 1;
            continue;
          }
        }

        if (char === '`' && next === '`' && next2 === '`') {
          this.isInCodeBlock = true;
          this.codeBlockBuffer = '';
          let langEnd = i + 3;
          while (langEnd < token.length && token[langEnd] !== '\n') {
            langEnd++;
          }
          this.codeBlockLanguage = token.substring(i + 3, langEnd).trim();
          output += `${ANSI.cyan}\`\`\`${this.codeBlockLanguage}${ANSI.reset}\n`;
          i = langEnd - 1;
          continue;
        }
      }

      if (char === '*' && next === '*') {
        if (this.state === 'bold') {
          this.state = 'normal';
          output += ANSI.reset;
          i++;
          continue;
        } else {
          this.state = 'bold';
          output += ANSI.bold;
          i++;
          continue;
        }
      }

      if (char === '*' && next !== '*') {
        if (this.state === 'italic') {
          this.state = 'normal';
          output += ANSI.reset;
          continue;
        } else {
          this.state = 'italic';
          output += ANSI.italic;
          continue;
        }
      }

      if (char === '`') {
        if (this.state === 'code_inline') {
          this.state = 'normal';
          output += ANSI.reset;
          continue;
        } else {
          this.state = 'code_inline';
          output += ANSI.code_inline;
          continue;
        }
      }

      if (char === '[') {
        const closeBracket = token.indexOf(']', i);
        if (closeBracket !== -1 && token[closeBracket + 1] === '(') {
          const closeParen = token.indexOf(')', closeBracket + 2);
          if (closeParen !== -1) {
            const text = token.substring(i + 1, closeBracket);
            output += `${ANSI.link}${text}${ANSI.reset}`;
            i = closeParen;
            continue;
          }
        }
      }

      if (char === '\n') {
        if (!this.isInCodeBlock) {
          this.state = 'normal';
        }
        output += '\n';
        this.lineBuffer = '';
        continue;
      }

      output += char;
      this.lineBuffer += char;
    }

    // 缓冲可能跨 token 的标记字符
    if (!this.isInCodeBlock) {
      const last = token[token.length - 1];
      if (last === '*' || last === '`' || last === '[') {
        // 从 token 末尾提取连续的标记字符
        let markerEnd = token.length;
        while (markerEnd > 0 && token[markerEnd - 1] === last) {
          markerEnd--;
        }
        this.pendingBuffer = token.substring(markerEnd);
        // 从 output 中移除已输出的标记字符
        const markerLen = token.length - markerEnd;
        if (markerLen > 0 && output.endsWith(this.pendingBuffer)) {
          output = output.substring(0, output.length - markerLen);
        }
      }
    }

    return output;
  }

  private countChar(str: string, start: number, char: string): number {
    let count = 0;
    while (start + count < str.length && str[start + count] === char) {
      count++;
    }
    return count;
  }

  reset(): void {
    this.state = 'normal';
    this.lineBuffer = '';
    this.isInCodeBlock = false;
    this.pendingBuffer = '';
    this.codeBlockBuffer = '';
    this.codeBlockLanguage = '';
  }

  getState(): RenderState {
    return this.state;
  }
}
