import { ATTR_BOLD, ATTR_DIM } from './cell.js';
import { CharPool, StylePool } from './pool.js';
import { createScreenBuffer, clearBuffer, setCell, diffBuffers, type ScreenBuffer } from './screen-buffer.js';
import { optimize } from './optimizer.js';
import { writePatches } from './writer.js';
import { fgAnsi } from './colors.js';

// 简化的节点类型
export interface RenderNode {
  type: 'box' | 'text';
  children?: RenderNode[];
  text?: string;
  props: {
    color?: string;
    backgroundColor?: string;
    bold?: boolean;
    dim?: boolean;
    flexDirection?: 'row' | 'column';
    justifyContent?: 'flex-start' | 'flex-end' | 'space-between';
    paddingX?: number;
    paddingY?: number;
    marginY?: number;
    borderStyle?: 'single';
    borderColor?: string;
  };
}

// 测量节点文本宽度
function measureTextWidth(node: RenderNode): number {
  if (node.type === 'text' && node.text !== undefined) {
    return [...node.text].length;
  }
  if (node.children) {
    let total = 0;
    for (const child of node.children) {
      total += measureTextWidth(child);
    }
    return total;
  }
  return 0;
}

// 渲染器状态
let prevBuffer: ScreenBuffer | null = null;
const charPool = new CharPool();
const stylePool = new StylePool();

// ANSI 重置序列
const RESET = '\x1b[0m';

export function renderTree(node: RenderNode): void {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;

  // 创建当前帧的屏幕缓冲区
  const buffer = createScreenBuffer(width, height, charPool, stylePool);
  clearBuffer(buffer);

  // 递归渲染节点树到缓冲区
  renderNode(buffer, node, 0, 0, width, height);

  // 全屏重绘（后续可优化为 diff）
  writeFullFrame(buffer);

  // 保存当前帧
  prevBuffer = buffer;
}

function renderNode(
  buffer: ScreenBuffer,
  node: RenderNode,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
): number {
  if (y >= maxHeight) return y;

  const { paddingX = 0, paddingY = 0, marginY = 0 } = node.props;
  let curY = y + marginY;

  // 边框
  if (node.props.borderStyle === 'single') {
    const borderColor = node.props.borderColor ?? 'white';
    const borderFg = fgAnsi(borderColor);
    const attrs = 0;
    const innerWidth = maxWidth - 2;
    const innerX = x + 1;

    // 上边框
    setCell(buffer, x, curY, '┌', borderFg, '', attrs);
    for (let i = 1; i < maxWidth - 1; i++) {
      setCell(buffer, x + i, curY, '─', borderFg, '', attrs);
    }
    setCell(buffer, x + maxWidth - 1, curY, '┐', borderFg, '', attrs);
    curY++;

    // 内容区域
    const contentStartY = curY;
    if (node.children) {
      for (const child of node.children) {
        curY = renderNode(buffer, child, innerX + paddingX, curY, innerWidth - paddingX * 2, maxHeight);
      }
    }

    // 绘制左右边框（内容行）
    for (let row = contentStartY; row < curY; row++) {
      setCell(buffer, x, row, '│', borderFg, '', attrs);
      setCell(buffer, x + maxWidth - 1, row, '│', borderFg, '', attrs);
    }

    // 下边框
    if (curY < maxHeight) {
      setCell(buffer, x, curY, '└', borderFg, '', attrs);
      for (let i = 1; i < maxWidth - 1; i++) {
        setCell(buffer, x + i, curY, '─', borderFg, '', attrs);
      }
      setCell(buffer, x + maxWidth - 1, curY, '┘', borderFg, '', attrs);
      curY++;
    }

    return curY;
  }

  // 常规 box
  curY += paddingY;

  if (node.type === 'text' && node.text !== undefined) {
    const fg = fgAnsi(node.props.color);
    let attrs = 0;
    if (node.props.bold) attrs |= ATTR_BOLD;
    if (node.props.dim) attrs |= ATTR_DIM;

    const chars = [...node.text];
    for (let i = 0; i < chars.length && i < maxWidth; i++) {
      setCell(buffer, x + i, curY, chars[i]!, fg, '', attrs);
    }
    curY++;
  } else if (node.children) {
    const isRow = node.props.flexDirection === 'row';
    if (isRow) {
      const justify = node.props.justifyContent ?? 'flex-start';
      const totalWidth = node.children.reduce((sum, c) => sum + measureTextWidth(c), 0);
      const availableWidth = maxWidth - paddingX * 2;

      let curX: number;
      if (justify === 'space-between' && node.children.length > 1) {
        // 第一个元素左对齐，最后一个元素右对齐
        curX = x + paddingX;
        const lastChild = node.children[node.children.length - 1]!;
        const lastWidth = measureTextWidth(lastChild);
        const lastX = x + availableWidth - lastWidth + paddingX;

        // 渲染除最后一个外的所有元素（左对齐）
        for (let i = 0; i < node.children.length - 1; i++) {
          const child = node.children[i]!;
          const childWidth = measureTextWidth(child);
          renderNode(buffer, child, curX, curY, Math.min(childWidth, availableWidth - (curX - x)), maxHeight);
          curX += childWidth;
        }
        // 最后一个元素右对齐
        renderNode(buffer, lastChild, lastX, curY, lastWidth, maxHeight);
      } else {
        // 默认左对齐
        curX = x + paddingX;
        for (const child of node.children) {
          const childWidth = measureTextWidth(child);
          renderNode(buffer, child, curX, curY, Math.min(childWidth, availableWidth - (curX - x)), maxHeight);
          curX += childWidth;
        }
      }
      curY++; // 行布局占一行
    } else {
      // 垂直排列（默认）
      for (const child of node.children) {
        curY = renderNode(buffer, child, x + paddingX, curY, maxWidth - paddingX * 2, maxHeight);
      }
    }
  }

  return curY;
}

function writeFullFrame(buffer: ScreenBuffer): void {
  // 清屏并移到左上角
  process.stdout.write('\x1b[2J\x1b[H');

  let output = '';
  let lastFg = -1, lastBg = -1, lastAttrs = -1;

  for (let y = 0; y < buffer.height; y++) {
    for (let x = 0; x < buffer.width; x++) {
      const cell = buffer.cells[y * buffer.width + x]!;
      const charStr = cell.char === 0 ? ' ' : buffer.charPool.get(cell.char);

      // 只在样式变化时输出 ANSI 代码
      if (cell.fg !== lastFg || cell.bg !== lastBg || cell.attrs !== lastAttrs) {
        const fg = buffer.stylePool.get(cell.fg);
        const bg = buffer.stylePool.get(cell.bg);
        output += '\x1b[0';
        if (cell.attrs & ATTR_BOLD) output += ';1';
        if (cell.attrs & ATTR_DIM) output += ';2';
        if (fg) output += ';' + fg;
        if (bg) output += ';' + bg;
        output += 'm';
        lastFg = cell.fg;
        lastBg = cell.bg;
        lastAttrs = cell.attrs;
      }

      output += charStr;
    }
    if (y < buffer.height - 1) {
      output += '\n';
      lastFg = lastBg = lastAttrs = -1; // 换行后重置样式缓存
    }
  }
  output += RESET;
  process.stdout.write(output);
}
