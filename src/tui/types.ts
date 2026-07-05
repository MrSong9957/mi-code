// src/tui/types.ts
// Ink 渲染层数据模型
//
// 物理本质：React 组件树消费的「消息视图模型」。
// 上游 BlockPipeline 产出 FormattedLine[]（含 ●/⎿ 前缀、缩进、语义样式 token），
// 本文件定义如何把若干 FormattedLine 聚合为一条 TuiMessage，供 <MessageList> 渲染。
//
// 设计原则：
// - TuiMessage 是纯数据（无渲染逻辑），可被 zustand store 持有、可被 ink-testing-library 断言
// - 样式用语义 token（UIMessageStyle：fg=brand/success/error、dim、bold…），
//   渲染侧（<Text>）映射到具体颜色，与 theme 解耦
// - 流式 assistant：streamingText 累积全文，finalized=false 时 MessageRow 用 StreamingMarkdown 渲染

import type { FormattedLine, UIMessageStyle } from '../ui/types.js';

/** 一条 TUI 消息（一组逻辑相关的渲染行） */
export interface TuiMessage {
  /** 唯一标识（React key + store 更新定位） */
  uuid: string;
  /** 语义角色（决定 MessageRow 整体样式倾向，如 user 带 ❯ 前缀已烤进行内容） */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 已固化的渲染行（来自 BlockPipeline 的 FormattedLine）。
   *  finalized=true 时这是最终内容；finalized=false 且为 assistant 流式中，
   *  末行可能由 streamingText 动态覆盖。 */
  lines: FormattedLine[];
  /** 是否已固化（流式结束）。流式中 finalized=false。 */
  finalized: boolean;
  /** 仅 assistant 流式：当前累积全文（StreamingMarkdown 据此增量渲染）。
   *  非 assistant 或已固化时为 undefined。 */
  streamingText?: string;
}

/** Ink <Text> 的样式 props（从语义 token 映射） */
export interface InkTextStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 反转视频（SGR 7）——选区高亮用，Ink <Text inverse> 直接支持 */
  inverse?: boolean;
}

/**
 * 语义样式 token → Ink <Text> props 的映射（集中处）。
 *
 * 物理本质：配色字典。UIMessageStyle 用抽象名（brand/success/error/dim/bold），
 * Ink 用具体颜色字符串。这里把抽象翻译成具体，便于整体换肤。
 *
 * fg token（对齐旧 src/renderer/theme.ts 的语义）：
 * - brand   → magenta（● 标题、assistant 前缀）
 * - success → green（❯ 用户输入）
 * - error   → red（错误）
 * - border  → gray（边框，footer 用）
 * - 其它/未指定 → 不着色（默认前景）
 */
export function styleToInkProps(style: UIMessageStyle | undefined): InkTextStyle {
  if (!style) return {};
  const props: InkTextStyle = {};
  if (style.fg) {
    switch (style.fg) {
      case 'brand': props.color = 'magenta'; break;
      case 'success': props.color = 'green'; break;
      case 'error': props.color = 'red'; break;
      case 'border': props.color = 'gray'; break;
      default: props.color = style.fg; // 未知 token 透传（可能是 hex/具名色）
    }
  }
  if (style.bg) {
    switch (style.bg) {
      case 'gray': props.backgroundColor = 'gray'; break;
      default: props.backgroundColor = style.bg;
    }
  }
  if (style.bold) props.bold = true;
  if (style.dim) props.dimColor = true;
  if (style.italic) props.italic = true;
  if (style.underline) props.underline = true;
  if (style.inverse) props.inverse = true;
  return props;
}

/**
 * Footer 状态栏数据（StatusBar 组件消费）。
 * 用户规格：{mode} | {model} | {dir末两级} | {branch} | [进度条] pct%
 */
export interface StatusBarData {
  /** 权限模式：plan / build / auto */
  mode: string;
  /** 模型名 */
  model: string;
  /** 工作目录（末两级，如 "Projects/mi-code"） */
  dir: string;
  /** git 分支 */
  branch: string;
  /** 上下文占用比例 [0,1]（inputTokens / 200000），驱动进度条 */
  contextPct: number;
}

/** 固定 LOGO 区数据（LogoBox 组件消费，不随消息滚动） */
export interface LogoData {
  /** 版本号，如 "1.0.0" */
  version: string;
  /** 当前工作目录（完整或末两级，LOGO 区显示） */
  dir: string;
}
