// src/__tests__/tui/inline-v2/helpers/e2e-harness.tsx
//
// V2 inline 模式 E2E 测试装配件。
//
// 物理本质:复制 bootstrap.tsx 的装配逻辑,但用 ink-testing-library 的 render
// 替代 ink 真实 render,获得 mock stdin/stdout。
//
// 覆盖范围(L1 E2E):
// - 完整 <ConnectedApp> 组件树(含 useInputHandler/useSpinnerClock/Select/Overlay)
// - 真实 zustand stores(创建逻辑与生产一致)
// - 真实输入处理(Ink useInput 解析按键)
//
// 不覆盖(需 L2 真 PTY):
// - 进程启动/退出码
// - 终端原生 Resize 事件
// - 真实 ANSI 渲染到终端
//
// 用法:
//   const h = createE2EHarness({ onSubmit, onExit, ... });
//   h.stdin.write('hello');          // 模拟键盘输入
//   h.stdin.write('\r');             // 回车
//   const frame = h.lastFrame();     // 取最新渲染帧
//   h.unmount();

import React from 'react';
import { render } from 'ink-testing-library';
import { ConnectedApp } from '../../../../tui/ConnectedApp.js';
import { RenderModeProvider } from '../../../../tui/state/render-mode.js';
import { ThemeStoreProvider } from '../../../../tui/state/theme-context.js';
import { createThemeStore } from '../../../../tui/state/theme-store.js';
import { createMessagesStore } from '../../../../tui/state/messages-store.js';
import { createInputStore } from '../../../../tui/state/input-store.js';
import { createStatusStore } from '../../../../tui/state/status-store.js';
import { createLogoStore } from '../../../../tui/state/logo-store.js';
import { createSpinnerStore } from '../../../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../../../tui/state/completion-store.js';
import { createSelectStore } from '../../../../tui/state/select-store.js';
import { createOverlayStore } from '../../../../tui/state/overlay-store.js';
import { EMPTY_SPINNER_CONTEXT } from '../../../../tui/state/spinner-store.js';

export interface E2EHarnessOptions {
  /** 初始 status 数据 */
  status?: { mode?: string; model?: string; dir?: string; branch?: string };
  /** logo 数据 */
  logo?: { version?: string; dir?: string };
  /** 终端尺寸 */
  cols?: number;
  rows?: number;
  /** 输入提交回调(默认 noop) */
  onSubmit?: (text: string) => void;
  /** 退出回调 */
  onExit?: () => void;
  /** Tab 补全回调 */
  onTab?: (text: string) => void;
  /** Ctrl+O 切 overlay */
  onToggleOverlay?: () => void;
  /** ESC 中断流 */
  onAbortStream?: () => void;
  /** 双击 ESC 撤回 */
  onRewindLastTurn?: () => void;
}

export interface E2EHarness {
  /** mock stdin,write 模拟按键 */
  stdin: {
    write: (data: string) => void;
  };
  /** 取最新渲染帧(含 ANSI 码) */
  lastFrame: () => string | undefined;
  /** 取所有历史帧 */
  frames: string[];
  /** 卸载组件 */
  unmount: () => void;
  /** 直接访问 stores(高级断言用) */
  stores: {
    messagesStore: ReturnType<typeof createMessagesStore>;
    inputStore: ReturnType<typeof createInputStore>;
    spinnerStore: ReturnType<typeof createSpinnerStore>;
    statusStore: ReturnType<typeof createStatusStore>;
    selectStore: ReturnType<typeof createSelectStore>;
    overlayStore: ReturnType<typeof createOverlayStore>;
    completionStore: ReturnType<typeof createCompletionStore>;
  };
}

/**
 * 创建 V2 inline 模式 E2E 测试装配件。
 *
 * 复制 bootstrap.tsx 装配(同款 stores 创建顺序、同款 ConnectedApp props),
 * 但用 ink-testing-library render 获得 mock stdin/stdout。
 */
export function createE2EHarness(opts: E2EHarnessOptions = {}): E2EHarness {
  const messagesStore = createMessagesStore();
  const inputStore = createInputStore({ onSubmit: opts.onSubmit ?? (() => {}) });
  const statusStore = createStatusStore({
    mode: opts.status?.mode ?? 'build',
    model: opts.status?.model ?? 'sonnet',
    dir: opts.status?.dir ?? '/tmp',
    branch: opts.status?.branch ?? 'main',
  });
  const logoStore = createLogoStore({
    version: opts.logo?.version ?? '1.0.0',
    dir: opts.logo?.dir ?? '/tmp',
  });
  const spinnerStore = createSpinnerStore(undefined, EMPTY_SPINNER_CONTEXT);
  const completionStore = createCompletionStore();
  const selectStore = createSelectStore();
  const overlayStore = createOverlayStore();
  const themeStore = createThemeStore('dark');

  const instance = render(
    React.createElement(RenderModeProvider, { initialMode: 'inline', children:
      React.createElement(ThemeStoreProvider, { store: themeStore },
        React.createElement(ConnectedApp, {
          messagesStore,
          inputStore,
          statusStore,
          logoStore,
          spinnerStore,
          completionStore,
          selectStore,
          overlayStore,
          onExit: opts.onExit ?? (() => {}),
          onTab: opts.onTab,
          onToggleOverlay: opts.onToggleOverlay,
          onAbortStream: opts.onAbortStream,
          onRewindLastTurn: opts.onRewindLastTurn,
        }),
      ),
    }),
  );

  return {
    stdin: instance.stdin,
    lastFrame: instance.lastFrame,
    frames: instance.frames,
    unmount: instance.unmount,
    stores: {
      messagesStore,
      inputStore,
      spinnerStore,
      statusStore,
      selectStore,
      overlayStore,
      completionStore,
    },
  };
}

// ─── 按键序列工具(模拟常用按键) ──────────────────────────────────────────

/** 模拟 Ink useInput 解析后的按键字节序列 */
export const KEYS = {
  ENTER: '\r',
  ESC: '\u001b',
  BACKSPACE: '\u0008',
  DELETE: '\u007f',
  TAB: '\t',
  UP_ARROW: '\u001b[A',
  DOWN_ARROW: '\u001b[B',
  RIGHT_ARROW: '\u001b[C',
  LEFT_ARROW: '\u001b[D',
  PAGE_UP: '\u001b[5~',
  PAGE_DOWN: '\u001b[6~',
  HOME: '\u001b[H',
  END: '\u001b[F',
  // Ctrl+O = 0x0F
  CTRL_O: '\u000f',
  // Ctrl+C = 0x03
  CTRL_C: '\u0003',
  // Ctrl+U(删到行首)
  CTRL_U: '\u0015',
};

/** 工具:等待若干 ms(让 React 调度完成异步渲染) */
export function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 工具:模拟人类打字(逐字符 + 间隔) */
export async function typeText(
  stdin: { write: (s: string) => void },
  text: string,
  intervalMs = 5,
): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await waitMs(intervalMs);
  }
}
