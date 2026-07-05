// src/tui/markdown/render-markdown.tsx
// Markdown → Ink <Text> 渲染（charter §核心模块 3 静态渲染）
//
// 物理本质：markdown 抽象语法树（marked tokens）→ React 组件树的翻译器。
// marked.lexer 把文本切成 Token[]（Heading/Paragraph/Code/Strong/Em/Codespan/List/...），
// 本模块递归把这些 token 翻译成带样式的 Ink <Text>。
//
// 样式映射（charter §核心模块 3.1：标题/代码块/行内代码/粗体/斜体/引用分别着色）：
// - 标题   H1-H6 → magenta + bold
// - 粗体   **x**  → bold
// - 斜体   *x*    → italic
// - 行内代码 `x`  → cyan
// - 代码块 ```    → cli-highlight 按 lang 高亮（fallback cyan）
// - 链接   [t](u) → t + dimColor 显示 url
// - 列表   - / 1. → 带符号前缀
// - 引用   >      → dimColor + │ 前缀

import React from 'react';
import { Box, Text } from 'ink';
import { lexer, type Token, type Tokens } from 'marked';
import { highlight } from 'cli-highlight';

/** 行内 token → React 文本节点数组（递归） */
function renderInlineTokens(tokens: Token[] | undefined, keyPrefix: string): React.ReactNode[] {
  if (!tokens || tokens.length === 0) return [];
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (tok.type) {
      case 'strong':
        return React.createElement(Text, { key, bold: true }, renderInlineTokens(tok.tokens, key));
      case 'em':
        return React.createElement(Text, { key, italic: true }, renderInlineTokens(tok.tokens, key));
      case 'codespan':
        return React.createElement(Text, { key, color: 'cyan' }, tok.text);
      case 'link':
        return React.createElement(Text, { key, color: 'blue', underline: true },
          tok.text ?? (tok.tokens ? flattenText(tok.tokens) : ''),
        );
      case 'del':
        return React.createElement(Text, { key, color: 'gray' }, renderInlineTokens(tok.tokens, key));
      case 'br':
        return React.createElement(Text, { key }, '\n');
      case 'escape':
        return React.createElement(Text, { key }, tok.text);
      case 'text':
        // text token 可能还有子 tokens（嵌套），有则递归，否则直接用 text
        if (tok.tokens && tok.tokens.length > 0) {
          return React.createElement(React.Fragment, { key }, renderInlineTokens(tok.tokens, key));
        }
        return React.createElement(Text, { key }, tok.text);
      case 'html':
        return React.createElement(Text, { key }, tok.text);
      default:
        // 未知行内 token：降级显示 text
        return React.createElement(Text, { key }, ('text' in tok ? String(tok.text) : ''));
    }
  });
}

/** 把 token 树压平成纯文本（链接无 tokens 时兜底取 text） */
function flattenText(tokens: Token[]): string {
  return tokens.map(t => ('text' in t ? String(t.text) : '')).join('');
}

/** 高亮代码块：cli-highlight 按 lang；失败/无 lang 降级 cyan */
function highlightCode(code: string, lang?: string): React.ReactNode {
  try {
    if (lang && lang.trim() !== '') {
      const highlighted = highlight(code, { language: lang, ignoreIllegals: true });
      // cli-highlight 默认输出 ANSI 转义码；Ink <Text> 不解析 ANSI。
      // 本期简化：strip ANSI，统一用 cyan 显示（颜色丢失但内容保留）。
      // 二期可解析 ANSI 映射到 Ink 样式。
      const stripped = highlighted.replace(/\x1b\[[0-9;]*m/g, '');
      return stripped;
    }
  } catch {
    // 高亮失败：降级原样
  }
  return code;
}

/** block token → 一组 React 节点（每条占独立行） */
function renderBlockToken(tok: Token, idx: number): React.ReactNode {
  const key = `block-${idx}`;
  switch (tok.type) {
    case 'heading': {
      return React.createElement(Text, { key, color: 'magenta', bold: true },
        renderInlineTokens(tok.tokens, key),
      );
    }
    case 'paragraph': {
      return React.createElement(Text, { key }, renderInlineTokens(tok.tokens, key));
    }
    case 'code': {
      const code = highlightCode(tok.text, tok.lang);
      return React.createElement(Text, { key, color: 'cyan' }, code);
    }
    case 'codespan': {
      return React.createElement(Text, { key, color: 'cyan' }, tok.text);
    }
    case 'list': {
      const items = (tok as Tokens.List).items.map((item: Tokens.ListItem, i: number) => {
        const listTok = tok as Tokens.List;
        const marker = listTok.ordered ? `${(listTok.start || 1) + i}. ` : '• ';
        const itemKey = `${key}-item-${i}`;
        // ListItem 的 tokens 通常是 [text/paragraph]，取其子 tokens 渲染
        const itemContent = item.tokens
          ? renderListItemContent(item.tokens, itemKey)
          : React.createElement(Text, { key: itemKey }, item.text);
        return React.createElement(Text, { key: itemKey },
          marker,
          itemContent,
        );
      });
      return React.createElement(Box, { key, flexDirection: 'column' }, items);
    }
    case 'blockquote': {
      // 引用：每行加 │ 前缀，dimColor
      const inner = (tok.tokens ?? []).map((t, i) => renderBlockToken(t, i));
      return React.createElement(Box, { key, flexDirection: 'column' },
        React.createElement(Text, { color: 'gray' }, '│'),
        React.createElement(Box, { flexDirection: 'column' }, inner),
      );
    }
    case 'hr': {
      return React.createElement(Text, { key, color: 'gray' }, '─'.repeat(40));
    }
    case 'space': {
      return React.createElement(Text, { key }, ' ');
    }
    case 'html': {
      return React.createElement(Text, { key }, tok.text);
    }
    case 'table': {
      // 简化：表头 + 行，tab 分隔
      const tableTok = tok as Tokens.Table;
      const header = tableTok.header.map((h) => h.text ?? '').join('  ');
      const rows = tableTok.rows.map((r) => r.map((c) => c.text ?? '').join('  '));
      return React.createElement(Box, { key, flexDirection: 'column' },
        React.createElement(Text, { bold: true }, header),
        ...rows.map((r: string, i: number) => React.createElement(Text, { key: `${key}-r${i}` }, r)),
      );
    }
    default: {
      // 兜底：显示 text 字段
      const text = 'text' in tok ? String((tok as { text: unknown }).text) : '';
      return React.createElement(Text, { key }, text);
    }
  }
}

/** ListItem 内 tokens 渲染（通常含 paragraph/text 嵌套） */
function renderListItemContent(tokens: Token[] | undefined, keyPrefix: string): React.ReactNode {
  if (!tokens || tokens.length === 0) return null;
  // 取每个子 token 的行内内容
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const k = `${keyPrefix}-${i}`;
    if (t.type === 'text') {
      // text token 可能带子 tokens（行内格式）
      if (t.tokens && t.tokens.length > 0) {
        parts.push(React.createElement(React.Fragment, { key: k }, renderInlineTokens(t.tokens, k)));
      } else {
        parts.push(React.createElement(Text, { key: k }, t.text));
      }
    } else if (t.type === 'paragraph') {
      parts.push(React.createElement(React.Fragment, { key: k }, renderInlineTokens(t.tokens, k)));
    } else {
      parts.push(renderBlockToken(t, i));
    }
  }
  return React.createElement(React.Fragment, null, ...parts);
}

/** 主入口：markdown 文本 → Ink <Box> 组件树 */
export function renderMarkdown(text: string): React.ReactElement {
  if (text === '') {
    return React.createElement(Box, { flexDirection: 'column' });
  }
  const tokens = lexer(text);
  const children = tokens.map((tok, idx) => renderBlockToken(tok, idx));
  return React.createElement(Box, { flexDirection: 'column' }, ...children);
}
