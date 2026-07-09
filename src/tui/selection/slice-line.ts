// src/tui/selection/slice-line.ts
// 单行按选区切片：把一行 content 按 [startCol,endCol) 切成最多 3 段。
//
// 物理本质：一条水平胶带上标记一段区间，切成「前/中/后」三段，
// 中段加 inverse 高亮。CJK 全角字符占 1 个码点但显示 2 列，
// 直接按字符串下标切会切坏字符——按显示列定位、钳到字符边界。
//
// 复用范式：cursor-position.ts 已验证的 stringWidth + 码点迭代。
//
// 钳位规则（落全角字符中间时）：
//  - startCol 向左钳到该字符起点（保留该字符）
//  - endCol   向右钳到该字符终点（保留该字符）
// 选区可能比拖拽位置多半/少半个字符，但永不出现半字。

import stringWidth from 'string-width';

/** 行的选区列范围（endCol 不含端点，半开区间 [start,end)） */
export interface LineSelectionRange {
  startCol: number;
  endCol: number;
}

export interface LineSegment {
  text: string;
  selected: boolean;
}

/**
 * 把一行 content 按 range 切成最多 3 段。
 * @param content 行完整文本（含缩进/前缀）
 * @param range   选区列范围（显示列，0-based）；null 表示整行不选中
 * @returns 段数组（空字符串段已丢弃）；空 content 返回 []
 */
export function sliceLineBySelection(
  content: string,
  range: LineSelectionRange | null,
): LineSegment[] {
  if (content === '') return [];

  // 无选区：单段不选中
  if (range === null) {
    return [{ text: content, selected: false }];
  }

  const codepoints = [...content]; // 按码点切（CJK/emoji 安全）
  // 建累积宽度表：charStart[i] = 第 i 个码点的起始显示列
  const charStart: number[] = [];
  let acc = 0;
  for (const cp of codepoints) {
    charStart.push(acc);
    acc += stringWidth(cp);
  }
  const totalWidth = acc;

  // 钳 range 到 [0, totalWidth]，且 start < end 才有效
  const start = Math.max(0, range.startCol);
  const end = Math.min(totalWidth, range.endCol);
  if (start >= end || start >= totalWidth || end <= 0) {
    return [{ text: content, selected: false }];
  }

  // 找 startCol 落在第几个码点上；落全角字符中间则向左钳到该码点起点
  let startIdx = codepoints.length; // 默认全选前面（start 钳到 0 时）
  for (let i = 0; i < codepoints.length; i++) {
    const cs = charStart[i]!;
    const cw = stringWidth(codepoints[i]!);
    if (start >= cs && start < cs + cw) {
      // start 落在此码点的显示区间内 → 钳到此码点起点
      startIdx = i;
      break;
    }
    if (start >= cs + cw) {
      startIdx = i + 1;
    }
  }
  startIdx = Math.max(0, Math.min(startIdx, codepoints.length));

  // 找 endCol 落点；落全角字符中间则向右钳到该码点终点（下一码点起点）
  let endIdx = 0;
  for (let i = 0; i < codepoints.length; i++) {
    const cs = charStart[i]!;
    const cw = stringWidth(codepoints[i]!);
    if (end > cs && end <= cs + cw) {
      // end 落在此码点区间内（不含 cs，含 cs+cw）→ 钳到下一码点起点（含此字符）
      endIdx = i + 1;
      break;
    }
    if (end > cs + cw) {
      endIdx = i + 1;
    }
  }
  endIdx = Math.max(0, Math.min(endIdx, codepoints.length));

  // start 钳位后可能 >= endIdx（极端），退化为不选中
  if (startIdx >= endIdx) {
    return [{ text: content, selected: false }];
  }

  // 拼 3 段（空段丢弃）
  const segs: LineSegment[] = [];
  if (startIdx > 0) {
    segs.push({ text: codepoints.slice(0, startIdx).join(''), selected: false });
  }
  segs.push({ text: codepoints.slice(startIdx, endIdx).join(''), selected: true });
  if (endIdx < codepoints.length) {
    segs.push({ text: codepoints.slice(endIdx).join(''), selected: false });
  }
  return segs;
}
