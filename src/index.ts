#!/usr/bin/env node
import { renderTree, type RenderNode } from './renderer/index.js';
import { execSync } from 'child_process';

const VERSION = "1.0.0";
const MODEL = "mimo-v2.5-pro";

function getGitBranch(): string {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'no-git'; }
}

function getShortDir(): string {
  return process.cwd().replace(/\\/g, '/').split('/').slice(-2).join('/');
}

const GIT_BRANCH = getGitBranch();
const SHORT_DIR = getShortDir();

// 状态
let input = '';
let messages: string[] = [];
let systemMessage = 'Ready';
let systemVisible = true;

// 构建 UI 树
function buildTree(): RenderNode {
  return {
    type: 'box',
    props: { flexDirection: 'column', paddingX: 1, paddingY: 1 },
    children: [
      // Banner
      buildBanner(),
      // 消息区
      buildMessages(),
      // 输入框
      buildInput(),
      // 状态栏
      buildStatusBar(),
    ],
  };
}

function buildBanner(): RenderNode {
  return {
    type: 'box',
    props: { flexDirection: 'column', marginY: 1 },
    children: [
      { type: 'text', text: ' ▐▛███▜▌   MiCode v' + VERSION, props: { color: 'cyan' } },
      { type: 'text', text: '▝▜█████▛▘  TypeScript CLI · Node.js Runtime', props: { color: 'cyan' } },
      { type: 'text', text: '  ▘▘ ▝▝    ' + process.cwd(), props: { color: 'cyan' } },
    ],
  };
}

function buildMessages(): RenderNode {
  if (messages.length === 0) {
    return {
      type: 'box',
      props: { flexDirection: 'column', marginY: 1 },
      children: [
        { type: 'text', text: 'Welcome to MiCode. Type something to start.', props: { dim: true } },
      ],
    };
  }
  return {
    type: 'box',
    props: { flexDirection: 'column', marginY: 1 },
    children: messages.map(msg => ({
      type: 'text' as const,
      text: msg,
      props: {},
    })),
  };
}

function buildInput(): RenderNode {
  const cursor = '❯';
  return {
    type: 'box',
    props: { borderStyle: 'single', borderColor: 'white', paddingX: 1, flexDirection: 'row' },
    children: [
      { type: 'text', text: cursor + ' ' + input, props: { bold: true, color: 'white' } },
    ],
  };
}

function buildStatusBar(): RenderNode {
  return {
    type: 'box',
    props: { flexDirection: 'row', justifyContent: 'space-between' },
    children: [
      // 左侧各项（不同颜色）
      { type: 'text', text: 'Plan', props: { bold: true, color: 'yellow' } },
      { type: 'text', text: ' | ', props: { color: 'gray' } },
      { type: 'text', text: MODEL, props: { bold: true, color: 'cyan' } },
      { type: 'text', text: ' | ', props: { color: 'gray' } },
      { type: 'text', text: SHORT_DIR, props: { bold: true, color: 'blue' } },
      { type: 'text', text: ' | ', props: { color: 'gray' } },
      { type: 'text', text: GIT_BRANCH, props: { bold: true, color: 'magenta' } },
      // 右侧系统消息
      { type: 'text', text: systemVisible ? systemMessage : '', props: { color: 'green' } },
    ],
  };
}

// 渲染循环
function scheduleRender() {
  renderTree(buildTree());
}

// 输入处理
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key: string) => {
    // Ctrl+C
    if (key === '') {
      process.stdout.write('\x1b[?25h'); // 显示光标
      process.exit(0);
    }

    // 回车
    if (key === '\r' || key === '\n') {
      if (input.trim() === 'exit') {
        process.stdout.write('\x1b[?25h');
        process.exit(0);
      }
      if (input.trim()) {
        messages.push('> ' + input);
        // 临时系统消息
        systemMessage = 'Received';
        systemVisible = true;
        setTimeout(() => { systemVisible = false; scheduleRender(); }, 3000);
      }
      input = '';
      scheduleRender();
      return;
    }

    // 退格
    if (key === '' || key === '') {
      input = input.slice(0, -1);
      scheduleRender();
      return;
    }

    // 普通字符
    if (key.length === 1 && key >= ' ') {
      input += key;
      scheduleRender();
    }
  });
}

// 窗口大小变化
process.stdout.on('resize', () => {
  scheduleRender();
});

// 隐藏光标并渲染
process.stdout.write('\x1b[?25l');
scheduleRender();
