// @vitest-environment jsdom
// 流式 delta 原地覆写回归测试（RED → GREEN）
//
// 历史缺陷：流式输出不"原地重写"，而是每个 token 增量都向下堆叠重复内容：
//   ● 我是一个
//   ● 我是一个 AI
//   ● 我是一个 AI 助手
// 违反了 InlineRenderer.rewriteStreamingLines 的覆写契约——本应 cursorUp 回到草稿顶部
// 逐行擦写，结果每次都走"首次追加"分支。
//
// 根因定位：InlineApp 的流式 effect 在每次 delta 都无条件调用
// `renderer.clearStreamingHeight()`，把 lastStreamingHeight 永久归零，导致
// rewriteStreamingLines 100% 走追加分支（lastStreamingHeight === 0），永不覆写。
//
// 物理模型：录音机的「覆写」vs「追加」。草稿行是磁带上的同一段，新 delta 应
// 倒带（cursorUp）到段首重新录，而非每次都从磁带末尾接着录（追加 = 堆叠重复）。
//
// 本测试分两层：
// 1. renderer 因果律：clearStreamingHeight → 追加；不清零 → 覆写（缺陷的物理证据）
// 2. InlineApp 组件契约：连续流式 delta 不应在 renderer 上产生"每次清零"的调用，
//    第二次 delta 必须产生覆写序列（\x1b[NA）。这层在 bug 代码下失败（RED），
//    修复后通过（GREEN）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { InlineRenderer } from './InlineRenderer.js';
import { wrapStreamingText, InlineApp } from './InlineApp.js';
import { createMessagesStore } from '../state/messages-store.js';
import { createInputStore } from '../state/input-store.js';
import { createStatusStore } from '../state/status-store.js';
import { createSpinnerStore } from '../state/spinner-store.js';
import { createCompletionStore } from '../state/completion-store.js';
import { createSelectionStore } from '../state/selection-store.js';
import { createOverlayStore } from '../state/overlay-store.js';
import { createLogoStore } from '../state/logo-store.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    /** 清空缓冲（mock.written = [] 无效，闭包已捕获原数组引用） */
    clear() { written.length = 0; },
    write: (s: string) => { written.push(s); return true; },
    columns: 80,
  };
}

// ─────────────── 第 1 层：renderer 因果律（物理证据） ───────────────

describe('renderer 因果律：clearStreamingHeight 决定追加 vs 覆写', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('连续 delta 不清零 → 第二次走覆写（含 cursorUp \\x1b[NA）', () => {
    renderer.rewriteStreamingLines(wrapStreamingText('我是一个', 80));
    renderer.rewriteStreamingLines(wrapStreamingText('我是一个 AI', 80));
    const out = mock.output;
    // 第二次必须含光标上移（覆写标志）
    expect(out).toMatch(/\x1b\[\d+A/);
  });

  it('连续 delta 每次清零 → 永远追加，堆叠重复（缺陷的物理证据）', () => {
    renderer.rewriteStreamingLines(wrapStreamingText('我是一个', 80));
    renderer.clearStreamingHeight(); // ← InlineApp 当前 bug：每次都清零
    renderer.rewriteStreamingLines(wrapStreamingText('我是一个 AI', 80));
    const out = mock.output;
    expect(out).toContain('我是一个 AI');
    // 缺陷标志：整段无任何光标上移序列（全是追加）
    expect(out).not.toMatch(/\x1b\[\d+A/);
  });

  it('固化转换路径仍需清零（thinking→assistant，新草稿从追加开始）', () => {
    renderer.rewriteStreamingLines(['  思考内容']);
    renderer.eraseStreamingLines(); // 固化转换清零
    mock.clear();
    renderer.rewriteStreamingLines(wrapStreamingText('你好', 80));
    const out = mock.output;
    expect(out).toContain('● 你好');
    expect(out).not.toMatch(/\x1b\[\d+A/);
  });
});

// ─────────────── 第 2 层：InlineApp 组件契约（RED → GREEN） ───────────────

const dummyStatus: StatusBarData = {
  mode: 'chat', model: 'test', dir: '/tmp', branch: 'main', contextPct: 0,
};
const dummyLogo: LogoData = { version: '0.0.0', dir: '/tmp' };

/**
 * 挂载真实 InlineApp，通过 messages store 推流式 delta，
 * 捕获 renderer 收到的调用，断言连续 delta 走覆写而非追加。
 *
 * 这是真正的集成测试——用真实 zustand store + 真实 React effect 驱动，
 * 而非手搓调用序列。spy 拦截 renderer 方法，断言调用契约。
 */
function mountInlineApp(mock: ReturnType<typeof createMockStdout>) {
  const messagesStore = createMessagesStore();
  const inputStore = createInputStore();
  const statusStore = createStatusStore(dummyStatus);
  const spinnerStore = createSpinnerStore();
  const completionStore = createCompletionStore();
  const selectionStore = createSelectionStore();
  const overlayStore = createOverlayStore();
  // logoStore 仅创建（InlineApp 用 logo prop，不直接订阅 store，但保持真实依赖）
  void createLogoStore(dummyLogo);

  const renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  // spy clearStreamingHeight：统计它在流式渲染中被调用的次数
  const clearSpy = vi.spyOn(renderer, 'clearStreamingHeight');

  const status: StatusBarData = dummyStatus;
  const logo: LogoData = dummyLogo;

  // InlineApp 通过 messages prop 感知流式变化（不直接订阅 messagesStore），
  // 所以每次 store 变化后必须 rerender 传入最新 messages 快照，
  // 模拟真实上层组件从 store 取数据再下发的数据流。
  const renderWithMessages = (messages: TuiMessage[]) =>
    render(
      React.createElement(InlineApp, {
        messages,
        status,
        logo,
        renderer,
        messagesStore,
        inputStore,
        statusStore,
        spinnerStore,
        completionStore,
        selectionStore,
        overlayStore,
      }),
    );

  let utils = renderWithMessages([]);

  /** 推一个流式 delta 并触发 InlineApp 重新渲染（传入最新 messages 快照） */
  const pushDelta = (text: string, isFirst: boolean) => {
    act(() => {
      if (isFirst) {
        messagesStore.getState().startStreaming(text);
      } else {
        messagesStore.getState().updateStreaming(text);
      }
    });
    // 用最新 store 快照重新渲染，模拟上层组件的 selector 下发
    const latest = messagesStore.getState().messages;
    utils.rerender(
      React.createElement(InlineApp, {
        messages: latest,
        status,
        logo,
        renderer,
        messagesStore,
        inputStore,
        statusStore,
        spinnerStore,
        completionStore,
        selectionStore,
        overlayStore,
      }),
    );
  };

  return { utils, messagesStore, renderer, mock, clearSpy, pushDelta };
}

describe('InlineApp 流式 delta 契约：连续 delta 必须覆写，不得堆叠', () => {
  beforeEach(() => {
    // InlineApp 用模块级全局 logoRendered 防重复画 logo。
    // 测试间重置以免污染（通过 vi.resetModules 在各 test 重新 import 更干净，
    // 但这里只需保证 logo 不在断言窗口内写入——我们用 mock.clear 隔离）。
  });

  it('RED→GREEN: 连续两个流式 delta 之间不得调用 clearStreamingHeight', () => {
    const mock = createMockStdout();
    const { clearSpy, pushDelta } = mountInlineApp(mock);

    // 推第一个 assistant 流式 delta
    pushDelta('● 我是一个', true);
    expect(clearSpy).not.toHaveBeenCalled();

    // 推第二个 delta（追加更多内容）
    pushDelta('● 我是一个 AI', false);

    // 关键契约：连续流式 delta 之间没有固化转换，不应触发 clearStreamingHeight。
    // bug 代码下：每次 effect 都无条件 clearStreamingHeight() → spy 被调用 → 测试 FAIL (RED)
    // 修复后：仅固化转换路径清零 → 连续 delta 不清零 → spy 未调用 → 测试 PASS (GREEN)
    //
    // 为什么用 spy 而非 stdout 正则断言：footer 重绘也会写 cursorUp 序列（renderFooter
    // 定位光标），会污染「覆写 vs 追加」的输出判定。clearStreamingHeight 的调用次数
    // 是 bug 的直接指纹——它精确反映了 InlineApp 是否短路了 rewriteStreamingLines
    // 的覆写状态机。
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('RED→GREEN: 三个连续 delta，clearStreamingHeight 全程不被调用', () => {
    const mock = createMockStdout();
    const { clearSpy, pushDelta } = mountInlineApp(mock);

    pushDelta('● a', true);
    pushDelta('● ab', false);
    pushDelta('● abc', false);

    // 三个 delta 间无固化转换，clearStreamingHeight 应始终为 0 次
    expect(clearSpy).not.toHaveBeenCalled();
  });
});
