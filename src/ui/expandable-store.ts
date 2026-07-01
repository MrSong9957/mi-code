// src/ui/expandable-store.ts
// 可折叠块存储 + 展开状态
//
// 物理本质：一个「抽屉柜」。
// 每个 thinking/tool_result 块是一个抽屉——关着时只露摘要（Thought for Ns / 4行预览），
// 拉开（expanded）时露出完整内容。ctrl+o 拉开/关上最后一个抽屉。
//
// pipeline emit 块时注册到这里；redraw 时按 expanded 状态选 summary/full 行重发。

import type { FormattedLine } from './types.js';

/** 一个可折叠块 */
export interface ExpandableBlock {
  /** 唯一标识（thinking 用 turn 序号，tool 用 name+序号） */
  id: string;
  /** 块类型 */
  kind: 'thinking' | 'tool_result';
  /** 折叠态显示的行（摘要：Thought for Ns / 4行预览 + 折叠提示） */
  summaryLines: FormattedLine[];
  /** 展开态显示的行（完整内容） */
  fullLines: FormattedLine[];
  /** 是否展开 */
  expanded: boolean;
}

/**
 * 可折叠块存储。
 * 注册块（add）、切换最后一个块的展开态（toggleLast）、按 id 查询/取行。
 */
export class ExpandableBlockStore {
  private blocks: ExpandableBlock[] = [];

  /** 注册一个块（初始 expanded=false） */
  add(block: Omit<ExpandableBlock, 'expanded'>): void {
    this.blocks.push({ ...block, expanded: false });
  }

  /** 块数量 */
  count(): number {
    return this.blocks.length;
  }

  /** 最后一个块的 id（无则 undefined） */
  lastId(): string | undefined {
    return this.blocks[this.blocks.length - 1]?.id;
  }

  /** 最后一个块是否展开（无块或折叠则 false） */
  lastExpanded(): boolean {
    return this.blocks[this.blocks.length - 1]?.expanded ?? false;
  }

  /** 切换最后一个块的 expanded，返回是否有变化（空 store 返回 false） */
  toggleLast(): boolean {
    const last = this.blocks[this.blocks.length - 1];
    if (!last) return false;
    last.expanded = !last.expanded;
    return true;
  }

  /** 按 id 查询是否展开（不存在返回 false） */
  isExpanded(id: string): boolean {
    return this.blocks.find(b => b.id === id)?.expanded ?? false;
  }

  /** 按 id 取应显示的行（expanded→full，折叠→summary；不存在返回空） */
  getLines(id: string): FormattedLine[] {
    const block = this.blocks.find(b => b.id === id);
    if (!block) return [];
    return block.expanded ? block.fullLines : block.summaryLines;
  }

  /** 清空所有块（新 turn 开始时） */
  clear(): void {
    this.blocks = [];
  }
}
