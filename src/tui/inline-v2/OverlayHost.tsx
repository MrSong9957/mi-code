// src/tui/inline-v2/OverlayHost.tsx
//
// V2 inline 模式的 Overlay 宿主组件(进终端备用屏显示折叠块全文)。
//
// 物理本质:overlayStore.visible 翻 true 时:
//   1. 发 \x1b[?1049h 进备用屏(终端自动保存主屏)
//   2. 发 \x1b[2J\x1b[H 清屏 + 光标归位
//   3. 直接写 stdout:标题 + 分隔线 + 内容 + 返回提示
// visible 翻 false 时:
//   1. 发 \x1b[?1049l 退备用屏(终端自动恢复主屏,零重绘)
//
// 与 alt-screen 路径的 <Overlay> 区别:alt-screen 路径整棵树在备用屏里,
// <Overlay> 走 Ink 渲染。inline V2 模式 Ink 在主屏活动区,Overlay 必须独立
// 进备用屏(不能让 Ink 渲染,否则会覆盖 footer 且盖不住 scrollback)。
//
// 设计:本组件不渲染任何可见 React 元素(返回 null)。
// 它只是一个副作用载体——useEffect 监听 overlayStore.visible 翻转,
// 翻转时直接写 stdout。
//
// 调用方:<InlineAppV2> 在 overlayVisible 时不渲染活动区(spinner/footer 隐藏),
// 同时挂载本组件处理 alt-screen。
//
// 输入处理(q/Ctrl+O/Esc 关闭)在 useInputHandler 里,与 alt-screen 无关:
// Ink 的 useInput 在主屏订阅 stdin,备用屏里 stdin 仍是同一个,按键正常解析。

import { useEffect, useRef } from 'react';
import { useStore } from 'zustand/react';
import { useStdout } from 'ink';
import stringWidth from 'string-width';
import type { OverlayStore } from '../state/overlay-store.js';

const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

export interface OverlayHostProps {
  store: OverlayStore;
  cols: number;
}

/**
 * 把 FormattedLine 数组转成可显示的纯文本(去掉样式 token,保留内容 + 缩进)。
 * 备用屏里走原生 stdout 写入,不经过 Ink,样式码简化处理。
 */
function formatOverlayLine(line: { content: string; indent?: number }): string {
  const indentNum = line.indent ?? 0;
  const indent = ' '.repeat(indentNum);
  return indent + line.content;
}

/**
 * 按显示宽度折行(CJK 全角=2 列,贪婪字符级,不拆 CJK)。
 * 与 truncateByWidth 不同:wrap 完整保留内容,超宽部分换到下一行。
 *
 * 注:之前的 truncateByWidth 直接丢弃超宽内容,导致 thinking 长文本被截断丢失。
 * 这里改成 wrap,完整显示思考内容(支持上下滚动看全部)。
 *
 * @param text 单行文本(不含 \n)
 * @param cols 终端列宽
 * @param indentNum 首行已有缩进(后续折行用同缩进对齐)
 * @returns 折行后的多行字符串(用 \n 连接,不含末尾 \n)
 */
function wrapByWidth(text: string, cols: number, indentNum: number): string {
  const budget = Math.max(1, cols - indentNum);
  const indent = ' '.repeat(indentNum);
  const lines: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (used + w > budget && current !== '') {
      // 当前行放不下:推出当前行,开始新行(带缩进)
      lines.push(current);
      current = indent + ch;
      used = stringWidth(indent) + w;
    } else {
      current += ch;
      used += w;
    }
  }
  if (current !== '' || lines.length === 0) {
    lines.push(current);
  }
  return lines.join('\n');
}

export function OverlayHost({ store, cols }: OverlayHostProps): null {
  const { stdout } = useStdout();
  const visible = useStore(store, (s) => s.visible);
  const title = useStore(store, (s) => s.title);
  const lines = useStore(store, (s) => s.lines);
  const wasVisibleRef = useRef(false);

  useEffect(() => {
    const stream = stdout ?? process.stdout;
    if (visible) {
      // 打开:进备用屏 + 清屏 + 写 overlay 内容
      stream.write(ENTER_ALT + CLEAR_SCREEN);
      // 标题(粗体)
      stream.write(BOLD + title + RESET + '\n');
      // 分隔线(限制 60 列,与 alt-screen Overlay 一致)
      stream.write('━'.repeat(Math.min(cols, 60)) + '\n');
      // 内容行(支持超宽 wrap 成多行,完整保留内容)
      for (const line of lines) {
        const indentNum = line.indent ?? 0;
        const text = formatOverlayLine(line);
        const wrapped = wrapByWidth(text, cols, indentNum);
        stream.write(wrapped + '\n');
      }
      // 返回提示
      stream.write('\n');
      stream.write(DIM + '按 q / Ctrl+O / Esc 返回' + RESET + '\n');
      wasVisibleRef.current = true;
    } else if (wasVisibleRef.current) {
      // 关闭:退备用屏(终端自动恢复主屏)
      stream.write(EXIT_ALT);
      wasVisibleRef.current = false;
    }
  }, [visible, title, lines, cols, stdout]);

  // unmount 时如果还在备用屏里,强制退出(防御:进程异常时不会卡在备用屏)
  useEffect(() => {
    return () => {
      if (wasVisibleRef.current) {
        const stream = stdout ?? process.stdout;
        stream.write(EXIT_ALT);
        wasVisibleRef.current = false;
      }
    };
  }, [stdout]);

  return null;
}
