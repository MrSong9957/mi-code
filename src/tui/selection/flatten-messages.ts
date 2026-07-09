// src/tui/selection/flatten-messages.ts
// 把 TuiMessage[] 展开成「行列表」（每行 = {messageUuid, lineIndex, line}）。
//
// 物理本质：滚动坐标统一的基石。终端按「行」滚动与选区，但消息是多行块。
// 本模块把消息块拉平成行数组，让 scroll-state/row-text-map/ScrollBox 都按行索引工作，
// 杜绝「消息索引 vs 行索引」撞车（多行消息选区错位的根因）。
//
// 流式块（!finalized）不展开（不可定位、不可选）——调用方单独处理。

import type { TuiMessage } from '../types.js';
import type { FormattedLine } from '../../ui/types.js';

/** 展开后的单行（带溯源信息：来自哪条消息的第几行） */
export interface FlatLine {
  /** 源消息 uuid（React key 用） */
  messageUuid: string;
  /** 在源消息 lines 数组中的索引 */
  lineIndex: number;
  /** 行数据（content/style/indent） */
  line: FormattedLine;
}

/**
 * 把已固化消息的 lines 拉平成行数组。
 * 流式块（!finalized）跳过——它们由 ScrollBox 单独渲染（StreamingMarkdown）。
 */
export function flattenMessages(messages: TuiMessage[]): FlatLine[] {
  const result: FlatLine[] = [];
  for (const msg of messages) {
    if (!msg.finalized) continue;
    for (let i = 0; i < msg.lines.length; i++) {
      result.push({ messageUuid: msg.uuid, lineIndex: i, line: msg.lines[i]! });
    }
  }
  return result;
}
