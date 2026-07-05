// src/tui/input/mouse-events.ts
// SGR 鼠标事件解析器（?1003h 全追踪，charter §核心模块 2 + §4 全局鼠标）
//
// 物理本质：终端鼠标字节流 → 结构化事件的「翻译器 + 缓冲池」。
// ?1003h（any-event tracking）高频发 SGR 序列，可能多序列粘在一个 chunk、
// 或一个序列被切到两个 chunk。本解析器用持久缓冲累加，逐序列切出解析。
//
// SGR 编码：\x1b[<button;col;row(M|m)
//   - M = 按下/动作，m = 释放
//   - button 位：低 2 位 0/1/2 = 左/中/右键；bit 2(4)=Shift；bit 3(8)=Alt/Meta；
//     bit 4(16)=Ctrl；bit 5(32)=motion（移动事件）；bit 6(64)=wheel（64=上，65=下）
//   - col/row 为 1-origin（调用方转 0-based）
//
// 事件分类：
//   - mousedown：M 后缀，button 无 motion bit 且非滚轮
//   - mousedrag：M 后缀，button 含 motion bit（&32）且非滚轮
//   - mouseup：m 后缀
//   - wheelup/wheeldown：button 64/65

/** 解析出的鼠标事件（col/row 为 1-origin 原样保留） */
export interface MouseEvent {
  type: 'mousedown' | 'mousedrag' | 'mouseup' | 'wheelup' | 'wheeldown';
  /** 原始 button 码（含修饰位） */
  button: number;
  /** 列（1-origin） */
  col: number;
  /** 行（1-origin） */
  row: number;
}

/** 单个 SGR 鼠标序列正则（无锚定，用于在缓冲中全局匹配） */
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** 滚轮 bit */
const WHEEL_BIT = 64;
/** motion（移动事件）bit */
const MOTION_BIT = 32;

/** 把 button + 后缀分类成事件类型 */
function classify(button: number, suffix: 'M' | 'm'): MouseEvent['type'] {
  // 滚轮：bit 6 置位（64=上，65=下）
  if ((button & WHEEL_BIT) === WHEEL_BIT) {
    return (button & 1) === 1 ? 'wheeldown' : 'wheelup';
  }
  if (suffix === 'm') return 'mouseup';
  // M 后缀：含 motion bit = 拖拽，否则 = 按下
  return (button & MOTION_BIT) === MOTION_BIT ? 'mousedrag' : 'mousedown';
}

export interface MouseParser {
  /** 喂入一段字节流，返回本次解析出的完整事件（不完整的留在内部缓冲等下次） */
  feed: (data: string) => MouseEvent[];
}

/** 创建带持久缓冲的鼠标解析器 */
export function createMouseParser(): MouseParser {
  let buffer = '';

  return {
    feed(data: string): MouseEvent[] {
      buffer += data;
      const events: MouseEvent[] = [];
      SGR_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      let lastEnd = 0;
      while ((match = SGR_RE.exec(buffer)) !== null) {
        const button = parseInt(match[1]!, 10);
        const col = parseInt(match[2]!, 10);
        const row = parseInt(match[3]!, 10);
        const suffix = match[4] as 'M' | 'm';
        events.push({ type: classify(button, suffix), button, col, row });
        lastEnd = SGR_RE.lastIndex;
      }
      // 丢弃已消费部分；保留 lastEnd 之后未匹配的尾巴（可能是下一个不完整序列）
      if (lastEnd > 0) {
        buffer = buffer.slice(lastEnd);
      }
      // 防御：缓冲过长且无匹配（垃圾数据），截断避免无限增长
      if (buffer.length > 256 && !buffer.includes('\x1b[')) {
        buffer = '';
      }
      return events;
    },
  };
}
