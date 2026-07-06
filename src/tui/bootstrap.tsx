// src/tui/bootstrap.tsx
// Ink 应用启动器：装配 stores + pipeline + render(<ConnectedApp/>) + cleanup
//
// 物理本质：把「数据层 stores + agent pipeline」与「Ink 组件树」焊接起来的装配车间。
// index.ts 调用 bootstrap() 一次，拿回 pipeline 和 stores 用于驱动 agent loop；
// bootstrap 内部用 Ink render() 挂载 <ConnectedApp/>，后者订阅 stores 自动重渲染。
//
// 装配内容：
// - messagesStore / inputStore / statusStore / logoStore（zustand vanilla stores）
// - pipeline = new BlockPipeline(new PipelineToStoreAdapter(messagesStore))
// - onSubmit 回调：inputStore 提交时通知 index.ts 的 agent 驱动逻辑
// - render(<ConnectedApp onExit={cleanup}/>) 进 alt screen
// - cleanup：unmount Ink + exitAltScreen（进程级 SIGINT/exit 兜底由 index.ts 注册）
//
// 返回 BootstrapHandle：{ pipeline, messagesStore, inputStore, statusStore, logoStore,
//   printLine, printStyled, cleanup }。

import React from 'react';
import { render, type Instance as InkInstance } from 'ink';
import { BlockPipeline } from '../ui/block-pipeline.js';
import { createMessagesStore } from './state/messages-store.js';
import { createInputStore } from './state/input-store.js';
import { createStatusStore } from './state/status-store.js';
import { createLogoStore } from './state/logo-store.js';
import { createSpinnerStore, type SpinnerStore } from './state/spinner-store.js';
import { createCompletionStore, type CompletionStore } from './state/completion-store.js';
import { createOverlayStore, type OverlayStore } from './state/overlay-store.js';
import { PipelineToStoreAdapter } from './state/pipeline-adapter.js';
import { ConnectedApp } from './ConnectedApp.js';
import { exitAltScreen } from './hooks/useAltScreen.js';
import { USE_DOUBLE_BUFFER, createCustomRenderer, setCursorPos } from '../render/index.js';
import type { FormattedLine, UIMessageStyle } from '../ui/types.js';
import type { LogoData as TuiLogoData } from './types.js';

export interface BootstrapOptions {
  /** LOGO 区数据（version/dir） */
  logo: TuiLogoData;
  /** 状态栏初始数据（mode/model/dir/branch） */
  status: { mode: string; model: string; dir: string; branch: string };
  /** 用户提交输入时回调（index.ts 在此驱动 agent loop） */
  onSubmit: (text: string) => void;
  /** 退出时回调（index.ts 在此做 session 落盘等，再 process.exit） */
  onExit: () => void;
  /** TAB 键回调（模式切换 or 补全） */
  onTab?: (text: string) => void;
  /** Ctrl+O 切换覆盖层回调 */
  onToggleOverlay?: () => void;
}

export interface BootstrapHandle {
  pipeline: BlockPipeline;
  messagesStore: ReturnType<typeof createMessagesStore>;
  inputStore: ReturnType<typeof createInputStore>;
  statusStore: ReturnType<typeof createStatusStore>;
  logoStore: ReturnType<typeof createLogoStore>;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  overlayStore: OverlayStore;
  /** spinner 控制（对齐旧 layout.startSpinner 等） */
  startSpinner: (label: string) => void;
  stopSpinner: () => void;
  setSpinnerLabel: (label: string) => void;
  spinnerOnToken: () => void;
  /** 把一行系统消息固化进 store（替代旧 printLine） */
  printLine: (text: string) => void;
  /** 带样式/角色的消息（替代旧 printStyled） */
  printStyled: (text: string, role: 'system' | 'error' | 'input', style?: UIMessageStyle) => void;
  /** 卸载 Ink + 退 alt screen（进程退出前调用） */
  cleanup: () => void;
}

export function bootstrap(opts: BootstrapOptions): BootstrapHandle {
  const messagesStore = createMessagesStore();
  const inputStore = createInputStore({ onSubmit: opts.onSubmit });
  const statusStore = createStatusStore(opts.status);
  const logoStore = createLogoStore(opts.logo);
  const spinnerStore = createSpinnerStore();
  const completionStore = createCompletionStore();
  const overlayStore = createOverlayStore();
  const adapter = new PipelineToStoreAdapter(messagesStore);
  const pipeline = new BlockPipeline(adapter);

  // printLine：系统消息进 store（替代旧 layout.send('system')）
  const printLine = (text: string): void => {
    messagesStore.getState().appendLine('system', { content: text, style: {}, indent: 0 });
  };

  // printStyled：按角色路由（替代旧 layout.send(role)）
  // - input：用户输入回显，去掉原始 ❯（Footer 自带 ❯ 前缀）
  // - error：错误，红色
  // - system：普通系统消息
  const printStyled = (
    text: string,
    role: 'system' | 'error' | 'input',
    style?: UIMessageStyle,
  ): void => {
    if (role === 'input') {
      const clean = text.replace(/^❯\s?/, '');
      messagesStore.getState().appendLine('user', {
        content: `❯ ${clean}`, style: { fg: 'success', bold: true, bg: 'gray' }, indent: 0,
      });
    } else {
      const line: FormattedLine = {
        content: text,
        style: role === 'error' ? { fg: 'error', ...(style ?? {}) } : (style ?? {}),
        indent: 0,
      };
      messagesStore.getState().appendLine('system', line);
    }
  };

  // 渲染 Ink 应用
  // alt screen：用 Ink 官方 alternateScreen option，在 constructor 阶段进入
  // （在任何 onRender 之前），避免自研 renderer 的第一帧画到主屏再被 alt 清掉。
  // 真实 TTY 下 interactive=true 才生效。
  // ⚠️ Ink 的 enterAlternativeScreen 只发 \x1b[?1049h（切到备用屏+保存光标），
  // 不发 \x1b[H（光标归位）。导致 alt screen 的光标停在用户输入命令的位置
  // （终端中间），renderer 从那开始画 → 整个画面偏移。
  // 这里在 render() 后立即补 \x1b[H 把光标归位到左上角 (0,0)。
  // patchConsole: false——关键：Ink 默认拦截 console.* 路由到 writeToStderr，
  // PowerShell 检测到 stderr 有内容就抛 NativeCommandError 杀进程（"一闪而过"真因）。
  // 项目 TUI 代码零处依赖 patchConsole（grep 确认），关闭后 console.* 走原生 Node 路径。
  // feature flag：USE_DOUBLE_BUFFER=true 时注入自研 renderer（patch 暴露的 options.renderer）
  // + onSetCursorPosition 钩子把 useCursor 的 {x,y} 转发给 renderer 的 pub/sub。
  const renderOptions: {
    exitOnCtrlC: false;
    alternateScreen: true;
    patchConsole: false;
    renderer?: unknown;
    onSetCursorPosition?: (pos: unknown) => void;
  } = { exitOnCtrlC: false, alternateScreen: true, patchConsole: false };
  if (USE_DOUBLE_BUFFER) {
    renderOptions.renderer = createCustomRenderer({ stdout: process.stdout });
    renderOptions.onSetCursorPosition = (pos) => { setCursorPos(pos as { x: number; y: number } | undefined); };
  }
  // alt screen 由 Ink 的 alternateScreen: true 在 constructor 里进。
  // 不再提前发——之前提前发 ?1049h + 标记，Ink constructor 又发一次 ?1049h，
  // 第二次会把提前写的内容清掉（某些终端行为）。光标归位在 patch 里处理。

  let inkInstance: InkInstance | null = render(
    React.createElement(ConnectedApp, {
      messagesStore, inputStore, statusStore, logoStore, spinnerStore, completionStore, overlayStore, onExit: opts.onExit, onTab: opts.onTab, onToggleOverlay: opts.onToggleOverlay,
    }),
    renderOptions,
  );

  const cleanup = (): void => {
    try {
      inkInstance?.unmount();
    } catch {
      // unmount 可能已调用，忽略
    }
    inkInstance = null;
    exitAltScreen(process.stdout);
  };

  return {
    pipeline, messagesStore, inputStore, statusStore, logoStore,
    spinnerStore,
    completionStore,
    overlayStore,
    startSpinner: (label: string) => { spinnerStore.getState().start(label); },
    stopSpinner: () => { spinnerStore.getState().stop(); },
    setSpinnerLabel: (label: string) => { spinnerStore.getState().setLabel(label); },
    spinnerOnToken: () => { spinnerStore.getState().onToken(); },
    printLine, printStyled, cleanup,
  };
}
