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

// 输入处理：用 Buffer 原始字节手动处理 UTF-8，支持中文等多字节字符
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  // 不设 encoding — 用 Buffer 接收原始字节，手动解码 UTF-8
  let pending = Buffer.alloc(0);

  process.stdin.on('data', (buf: Buffer) => {
    // 拼接上次未完成的字节
    const data = Buffer.concat([pending, buf]);
    pending = Buffer.alloc(0);

    for (let i = 0; i < data.length; ) {
      const byte = data[i]!;

      // Ctrl+C (0x03)
      if (byte === 0x03) {
        process.stdout.write('\x1b[?25h');
        process.exit(0);
      }

      // 回车 (CR=0x0D, LF=0x0A)
      if (byte === 0x0d || byte === 0x0a) {
        if (input.trim() === 'exit') {
          process.stdout.write('\x1b[?25h');
          process.exit(0);
        }
        if (input.trim()) {
          messages.push('> ' + input);
          systemMessage = 'Received';
          systemVisible = true;
          setTimeout(() => { systemVisible = false; scheduleRender(); }, 3000);
        }
        input = '';
        scheduleRender();
        i++;
        continue;
      }

      // 退格 (BS=0x08, DEL=0x7F)
      if (byte === 0x08 || byte === 0x7F) {
        input = input.slice(0, -1);
        scheduleRender();
        i++;
        continue;
      }

      // 其他控制字符 (< 0x20) → 跳过
      if (byte < 0x20) {
        i++;
        continue;
      }

      // 确定 UTF-8 字符的字节数
      let charLen = 1;
      if ((byte & 0xE0) === 0xC0) charLen = 2;       // 110xxxxx → 2 字节
      else if ((byte & 0xF0) === 0xE0) charLen = 3;   // 1110xxxx → 3 字节 (中文)
      else if ((byte & 0xF8) === 0xF0) charLen = 4;   // 11110xxx → 4 字节 (emoji)

      // 字节不够，存入 pending 等下次 data
      if (i + charLen > data.length) {
        pending = data.subarray(i);
        break;
      }

      // 解码完整 UTF-8 字符
      const char = data.subarray(i, i + charLen).toString('utf8');
      input += char;
      i += charLen;
    }

    scheduleRender();
  });
}

// 窗口大小变化
process.stdout.on('resize', () => {
  scheduleRender();
});

// 隐藏光标并渲染
process.stdout.write('\x1b[?25l');
scheduleRender();
