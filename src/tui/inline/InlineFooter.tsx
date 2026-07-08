// src/tui/inline/InlineFooter.tsx
// Inline 模式下的 Footer：通过 InlineRenderer 将输入框+状态栏写入终端主缓冲区。
// 物理本质：React 组件的 render 副作用——每次 store 变化时调用 renderer 重绘 footer。
//
// 注意：这不是传统的 Ink 组件。它的渲染输出不经过 Yoga 布局，
// 而是通过 useEffect 直接操作 stdout。

import React, { useEffect, useRef } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { InlineRenderer } from './InlineRenderer.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';

export interface InlineFooterProps {
  renderer: InlineRenderer;
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
}

export function InlineFooter({
  renderer,
  messagesStore: _messagesStore,
  inputStore,
  statusStore,
  spinnerStore,
  completionStore,
}: InlineFooterProps): React.ReactElement | null {
  const inputText = useStore(inputStore, (s) => s.text);
  const cursor = useStore(inputStore, (s) => s.cursor);
  const status = useStore(statusStore, useShallow((s) => ({
    mode: s.mode, model: s.model, dir: s.dir, branch: s.branch, contextPct: s.contextPct,
  })));
  const spinnerActive = useStore(spinnerStore, (s) => s.active);
  const completionVisible = useStore(completionStore, (s) => s.visible);

  // 用 ref 追踪上一次的 footer 状态，避免不必要的重绘
  const prevFooterRef = useRef('');

  useEffect(() => {
    const statusText = `${status.mode} │ ${status.model} │ ${status.dir} │ ${status.branch}`;
    const spinnerLine = spinnerActive ? '⏳ Processing...' : '';
    const completionLine = completionVisible ? '...' : '';
    const footerKey = `${inputText}|${cursor}|${statusText}|${spinnerLine}|${completionLine}`;

    // 避免相同内容重复渲染
    if (footerKey === prevFooterRef.current) return;
    prevFooterRef.current = footerKey;

    const fullStatus = [statusText, spinnerLine, completionLine].filter(Boolean).join(' │ ');
    renderer.renderFooter(inputText, cursor, fullStatus);
  }, [inputText, cursor, status, spinnerActive, completionVisible, renderer]);

  // 组件卸载时 commit footer（变成历史）
  useEffect(() => {
    return () => {
      renderer.commitFooter();
    };
  }, [renderer]);

  // 返回空——实际渲染通过 stdout 副作用完成
  return null;
}
