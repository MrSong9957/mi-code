# OutputGate 渲染系统重写计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写渲染系统，解决乱码、布局混乱、输出绕过渲染器等问题

**Architecture:** 在 Renderer 上游加一道"闸门"（OutputGate），所有消息必须经过闸门排队、编码清洗、布局调度，才允许进入 Renderer。Renderer 降级为纯渲染层，只负责 ANSI 序列生成。

**Tech Stack:** TypeScript, Vitest, Node.js

**关键设计原则（对齐 Claude Code）：**
- 单一出口：OutputGate 是唯一写终端的模块
- 帧缓冲：prevFrame/nextFrame 逐格 diff，只写变化
- 内容增长模型：新行靠 LF 滚入 scrollback，页脚钉底
- 样式对象池：复用 Style 对象，=== 快速比较
- 热路径优化：提前返回、缓存

---

## 阶段 1：基础设施

### Task 1: 创建类型定义

**Files:**
- Create: `src/output/types.ts`

- [ ] **Step 1: 创建类型定义文件**

```typescript
// src/output/types.ts
// 输出系统类型定义

/** 消息类型 */
export type MessageType =
  | 'thinking'      // 思考内容（实时渲染，折叠后变 dim）
  | 'assistant'     // AI 回复（Markdown 渲染）
  | 'tool_call'     // 工具调用（● name）
  | 'tool_result'   // 工具结果（↳ name 完成 — N 行）
  | 'tool_output'   // 工具输出（编码清洗后的实际内容）
  | 'system'        // 系统消息（hook 日志等）
  | 'error'         // 错误（红色）
  | 'input';        // 用户输入（❯ prompt）

/** 消息优先级（数字越大优先级越高） */
export enum MessagePriority {
  SYSTEM = 0,
  TOOL_OUTPUT = 1,
  ASSISTANT = 2,
  TOOL_CALL = 3,
  TOOL_RESULT = 3,
  INPUT = 4,
  THINKING = 5,
  ERROR = 10,
}

/** 输出消息 */
export interface OutputMessage {
  id: string;
  type: MessageType;
  content: string;
  style?: OutputStyle;
  priority: MessagePriority;
  timestamp: number;
}

/** 输出样式（简化版，对齐 Claude Code Style 对象） */
export interface OutputStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** Writer 接口（测试注入 fake） */
export type Writer = (s: string) => void;

/** 终端尺寸 */
export interface TermSize {
  rows: number;
  cols: number;
}
```

- [ ] **Step 2: 运行测试验证类型定义正确**

Run: `npm test -- --run src/__tests__/output/types.test.ts`
Expected: 测试文件不存在，跳过

- [ ] **Step 3: 提交**

```bash
git add src/output/types.ts
git commit -m "feat(output): add type definitions for output system"
```

---

### Task 2: 创建编码器

**Files:**
- Create: `src/output/encoder.ts`
- Create: `src/__tests__/output/encoder.test.ts`

- [ ] **Step 1: 编写编码器测试**

```typescript
// src/__tests__/output/encoder.test.ts
import { describe, it, expect } from 'vitest';
import { Encoder } from '../../output/encoder.js';

describe('Encoder', () => {
  describe('normalize', () => {
    it('should pass through valid UTF-8', () => {
      const input = 'Hello 你好 🌍';
      expect(Encoder.normalize(input)).toBe(input);
    });

    it('should handle empty string', () => {
      expect(Encoder.normalize('')).toBe('');
    });

    it('should remove null bytes', () => {
      expect(Encoder.normalize('Hello\x00World')).toBe('HelloWorld');
    });

    it('should preserve ANSI escape sequences', () => {
      const input = '\x1b[31mRed\x1b[0m';
      expect(Encoder.normalize(input)).toBe(input);
    });
  });

  describe('isGarbled', () => {
    it('should detect garbled text', () => {
      expect(Encoder.isGarbled('�����ڲ����ⲿ���')).toBe(true);
    });

    it('should not flag valid text', () => {
      expect(Encoder.isGarbled('Hello World')).toBe(false);
    });

    it('should not flag valid Chinese', () => {
      expect(Encoder.isGarbled('你好世界')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -- --run src/__tests__/output/encoder.test.ts`
Expected: FAIL - 模块不存在

- [ ] **Step 3: 实现编码器**

```typescript
// src/output/encoder.ts
// GBK/UTF-8 自动检测 + 转换
//
// 物理本质：翻译官。
// 收到一封可能是中文写的信（GBK），先试着用英文读（UTF-8），
// 发现读不通（出现乱码符号），再换中文读（GBK）。

/** 编码器：处理 GBK/UTF-8 编码问题 */
export class Encoder {
  /** 乱码检测正则：连续的替换字符或高位字节 */
  private static readonly GARBLED_PATTERN = /[��]{2,}|[\x80-\xff]{4,}/;

  /**
   * 标准化文本：确保输出是合法 UTF-8
   *
   * 物理本质：把收到的信翻译成标准格式。
   * 1. 移除 null 字节（终端不认）
   * 2. 检测乱码特征
   * 3. 返回合法 UTF-8
   */
  static normalize(text: string): string {
    if (!text) return '';

    // 移除 null 字节（终端会显示为 ^@）
    let result = text.replace(/\x00/g, '');

    // 检测是否含乱码特征
    if (this.isGarbled(result)) {
      // 尝试从 GBK 恢复（如果原始数据是 Buffer）
      // 注意：这里只能处理已经是字符串的情况
      // Buffer 的 GBK 解码应该在调用方处理
      console.warn('[Encoder] Detected garbled text, attempting cleanup');
      result = this.cleanupGarbled(result);
    }

    return result;
  }

  /**
   * 检测是否是乱码
   *
   * 物理本质：检查信里有没有明显的乱码符号。
   * 连续的替换字符（�）或高位字节序列是乱码的特征。
   */
  static isGarbled(text: string): boolean {
    return this.GARBLED_PATTERN.test(text);
  }

  /**
   * 清理乱码文本
   *
   * 物理本质：把信里看不懂的符号替换成占位符。
   * 无法恢复原始内容，只能让它显示得更友好。
   */
  private static cleanupGarbled(text: string): string {
    // 替换连续的乱码字符为省略号
    return text.replace(/[��]{2,}/g, '...');
  }

  /**
   * 从 Buffer 解码（优先 UTF-8，回退 GBK）
   *
   * 物理本质：先试着用英文读，读不通再用中文读。
   * 这是处理 Windows CMD 错误信息的关键函数。
   */
  static decodeBuffer(buf: Buffer): string {
    // 优先尝试 UTF-8
    const utf8 = buf.toString('utf8');

    // 检测是否含替换字符（U+FFFD）
    if (!utf8.includes('�')) {
      return utf8;
    }

    // 回退到 GBK
    try {
      const { TextDecoder } = require('util');
      return new TextDecoder('gbk').decode(buf);
    } catch {
      // GBK 解码失败，返回 UTF-8（含乱码）
      return utf8;
    }
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -- --run src/__tests__/output/encoder.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/output/encoder.ts src/__tests__/output/encoder.test.ts
git commit -m "feat(output): add Encoder for GBK/UTF-8 handling"
```

---

### Task 3: 创建样式对象池

**Files:**
- Create: `src/output/style-pool.ts`
- Create: `src/__tests__/output/style-pool.test.ts`

- [ ] **Step 1: 编写样式对象池测试**

```typescript
// src/__tests__/output/style-pool.test.ts
import { describe, it, expect } from 'vitest';
import { StylePool } from '../../output/style-pool.js';

describe('StylePool', () => {
  it('should return same reference for equal styles', () => {
    const pool = new StylePool();
    const style1 = pool.get({ fg: 'red', bold: true });
    const style2 = pool.get({ fg: 'red', bold: true });
    expect(style1).toBe(style2); // === 比较
  });

  it('should return different reference for different styles', () => {
    const pool = new StylePool();
    const style1 = pool.get({ fg: 'red' });
    const style2 = pool.get({ fg: 'blue' });
    expect(style1).not.toBe(style2);
  });

  it('should handle empty style', () => {
    const pool = new StylePool();
    const style1 = pool.get({});
    const style2 = pool.get({});
    expect(style1).toBe(style2);
  });

  it('should handle undefined style', () => {
    const pool = new StylePool();
    const style1 = pool.get(undefined);
    const style2 = pool.get(undefined);
    expect(style1).toBe(style2);
  });

  it('should freeze style objects', () => {
    const pool = new StylePool();
    const style = pool.get({ fg: 'red' });
    expect(Object.isFrozen(style)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -- --run src/__tests__/output/style-pool.test.ts`
Expected: FAIL - 模块不存在

- [ ] **Step 3: 实现样式对象池**

```typescript
// src/output/style-pool.ts
// 样式对象池（复用 + 快速比较）
//
// 物理本质：调色盘里的颜色卡。
// 相同样式只存一份，用 === 比较（O(1)），不用逐字段比较（O(n)）。
// 这是 Claude Code RenderOptimizer 的核心优化。

import type { OutputStyle } from './types.js';

/** 样式 key：相同样式必同串 */
function styleKey(style: OutputStyle | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.fg) parts.push('f' + style.fg);
  if (style.bg) parts.push('b' + style.bg);
  if (style.bold) parts.push('B');
  if (style.dim) parts.push('D');
  if (style.italic) parts.push('I');
  if (style.underline) parts.push('U');
  return parts.join('|');
}

export class StylePool {
  /** 样式缓存：key → 冻结的 Style 对象 */
  private pool = new Map<string, OutputStyle>();

  /** 空样式（单例） */
  private emptyStyle: OutputStyle;

  constructor() {
    this.emptyStyle = Object.freeze({});
    this.pool.set('', this.emptyStyle);
  }

  /**
   * 获取样式对象（复用已有，快速比较）
   *
   * 物理本质：从调色盘里找颜色卡。
   * 找到了直接用（=== 比较），找不到就新建一张存起来。
   */
  get(style: OutputStyle | undefined): OutputStyle {
    const key = styleKey(style);

    // 快速路径：空样式
    if (!key) return this.emptyStyle;

    // 查找缓存
    let cached = this.pool.get(key);
    if (!cached) {
      // 新建并冻结（不可变，安全复用）
      cached = Object.freeze({ ...style });
      this.pool.set(key, cached);
    }

    return cached;
  }

  /**
   * 生成 ANSI 转义序列（SGR）
   *
   * 物理本质：把颜色卡翻译成终端能懂的指令。
   */
  toAnsi(style: OutputStyle): string {
    if (!style || (!style.fg && !style.bg && !style.bold && !style.dim && !style.italic && !style.underline)) {
      return '';
    }

    const codes: string[] = [];

    // 样式属性
    if (style.bold) codes.push('1');
    if (style.dim) codes.push('2');
    if (style.italic) codes.push('3');
    if (style.underline) codes.push('4');

    // 前景色
    if (style.fg) {
      const fgCode = FG_MAP[style.fg];
      if (fgCode) codes.push(fgCode);
    }

    // 背景色
    if (style.bg) {
      const bgCode = BG_MAP[style.bg];
      if (bgCode) codes.push(bgCode);
    }

    if (codes.length === 0) return '';

    return `\x1b[${codes.join(';')}m`;
  }
}

/** 前景色映射 */
const FG_MAP: Record<string, string> = {
  black: '30', red: '31', green: '32', yellow: '33',
  blue: '34', magenta: '35', cyan: '36', white: '37',
  gray: '90', grey: '90',
  redBright: '91', greenBright: '92', yellowBright: '93', blueBright: '94',
  magentaBright: '95', cyanBright: '96', whiteBright: '97',
};

/** 背景色映射 */
const BG_MAP: Record<string, string> = {
  black: '40', red: '41', green: '42', yellow: '43',
  blue: '44', magenta: '45', cyan: '46', white: '47',
  gray: '100', grey: '100',
};
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -- --run src/__tests__/output/style-pool.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/output/style-pool.ts src/__tests__/output/style-pool.test.ts
git commit -m "feat(output): add StylePool for style object reuse"
```

---

## 阶段 2：消息队列

### Task 4: 创建消息队列

**Files:**
- Create: `src/output/message-queue.ts`
- Create: `src/__tests__/output/message-queue.test.ts`

- [ ] **Step 1: 编写消息队列测试**

```typescript
// src/__tests__/output/message-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from '../../output/message-queue.js';
import { MessagePriority } from '../../output/types.js';

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  describe('enqueue', () => {
    it('should add message to queue', () => {
      queue.enqueue({
        type: 'system',
        content: 'test',
        priority: MessagePriority.SYSTEM,
      });
      expect(queue.size).toBe(1);
    });

    it('should generate unique id', () => {
      const msg1 = queue.enqueue({ type: 'system', content: 'a', priority: MessagePriority.SYSTEM });
      const msg2 = queue.enqueue({ type: 'system', content: 'b', priority: MessagePriority.SYSTEM });
      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  describe('dequeue', () => {
    it('should return messages in priority order', () => {
      queue.enqueue({ type: 'system', content: 'low', priority: MessagePriority.SYSTEM });
      queue.enqueue({ type: 'error', content: 'high', priority: MessagePriority.ERROR });
      queue.enqueue({ type: 'assistant', content: 'mid', priority: MessagePriority.ASSISTANT });

      expect(queue.dequeue()?.content).toBe('high');
      expect(queue.dequeue()?.content).toBe('mid');
      expect(queue.dequeue()?.content).toBe('low');
    });

    it('should return undefined when empty', () => {
      expect(queue.dequeue()).toBeUndefined();
    });
  });

  describe('peek', () => {
    it('should return next message without removing', () => {
      queue.enqueue({ type: 'system', content: 'test', priority: MessagePriority.SYSTEM });
      expect(queue.peek()?.content).toBe('test');
      expect(queue.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all messages', () => {
      queue.enqueue({ type: 'system', content: 'a', priority: MessagePriority.SYSTEM });
      queue.enqueue({ type: 'system', content: 'b', priority: MessagePriority.SYSTEM });
      queue.clear();
      expect(queue.size).toBe(0);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -- --run src/__tests__/output/message-queue.test.ts`
Expected: FAIL - 模块不存在

- [ ] **Step 3: 实现消息队列**

```typescript
// src/output/message-queue.ts
// 优先级消息队列
//
// 物理本质：急诊室分诊台。
// 病人（消息）按病情严重程度（优先级）排队，
// 病情最重的（error）最先被处理。

import type { OutputMessage, MessageType } from './types.js';
import { MessagePriority } from './types.js';

let nextId = 0;

export class MessageQueue {
  /** 消息数组（按优先级排序） */
  private messages: OutputMessage[] = [];

  /**
   * 入队
   *
   * 物理本质：病人挂号，护士根据病情安排排队位置。
   */
  enqueue(params: {
    type: MessageType;
    content: string;
    priority: MessagePriority;
    style?: OutputMessage['style'];
  }): OutputMessage {
    const message: OutputMessage = {
      id: `msg_${nextId++}`,
      type: params.type,
      content: params.content,
      style: params.style,
      priority: params.priority,
      timestamp: Date.now(),
    };

    // 插入排序：找到正确位置插入
    let inserted = false;
    for (let i = 0; i < this.messages.length; i++) {
      if (message.priority > this.messages[i]!.priority) {
        this.messages.splice(i, 0, message);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      this.messages.push(message);
    }

    return message;
  }

  /**
   * 出队（取优先级最高的）
   *
   * 物理本质：护士叫号，病情最重的先进诊室。
   */
  dequeue(): OutputMessage | undefined {
    return this.messages.shift();
  }

  /**
   * 查看下一个（不移除）
   *
   * 物理本质：护士看看下一个是谁，但还没叫号。
   */
  peek(): OutputMessage | undefined {
    return this.messages[0];
  }

  /**
   * 清空队列
   *
   * 物理本质：下班了，所有病人转去其他诊室。
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * 队列大小
   */
  get size(): number {
    return this.messages.length;
  }

  /**
   * 是否为空
   */
  get isEmpty(): boolean {
    return this.messages.length === 0;
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -- --run src/__tests__/output/message-queue.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/output/message-queue.ts src/__tests__/output/message-queue.test.ts
git commit -m "feat(output): add MessageQueue with priority ordering"
```

---

## 阶段 3：布局调度器

### Task 5: 创建布局调度器

**Files:**
- Create: `src/output/layout-scheduler.ts`
- Create: `src/__tests__/output/layout-scheduler.test.ts`

- [ ] **Step 1: 编写布局调度器测试**

```typescript
// src/__tests__/output/layout-scheduler.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutScheduler } from '../../output/layout-scheduler.js';

describe('LayoutScheduler', () => {
  let scheduler: LayoutScheduler;

  beforeEach(() => {
    scheduler = new LayoutScheduler({ rows: 24, cols: 80 });
  });

  describe('calculateLayout', () => {
    it('should calculate basic layout', () => {
      const layout = scheduler.calculateLayout({
        messageLines: 10,
        inputLines: 1,
      });

      expect(layout.messageArea.startY).toBe(0);
      expect(layout.messageArea.height).toBe(10);
      expect(layout.inputArea.startY).toBe(21); // 24 - 2 (border) - 1 (input)
      expect(layout.statusBar.y).toBe(23);
    });

    it('should handle content overflow', () => {
      const layout = scheduler.calculateLayout({
        messageLines: 100,
        inputLines: 1,
      });

      // 内容超出终端高度时，viewport 取最后 N 行
      expect(layout.viewportY).toBe(76); // 100 - 24 + 2 (border) + 1 (input) + 1 (status)
    });

    it('should handle multi-line input', () => {
      const layout = scheduler.calculateLayout({
        messageLines: 5,
        inputLines: 3,
      });

      expect(layout.inputArea.startY).toBe(18); // 24 - 2 (border) - 3 (input) - 1 (status)
      expect(layout.inputArea.height).toBe(3);
    });
  });

  describe('getViewportY', () => {
    it('should return 0 when content fits', () => {
      expect(scheduler.getViewportY(10)).toBe(0);
    });

    it('should return correct offset when content overflows', () => {
      expect(scheduler.getViewportY(100)).toBe(76);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -- --run src/__tests__/output/layout-scheduler.test.ts`
Expected: FAIL - 模块不存在

- [ ] **Step 3: 实现布局调度器**

```typescript
// src/output/layout-scheduler.ts
// 布局调度器（内容增长模型）
//
// 物理本质：排版师。
// 把内容（文字）和框架（边框、输入框、状态栏）安排到正确的位置。
// 内容超出页面时，自动把旧内容滚到上面（scrollback）。

import type { TermSize } from './types.js';

/** 布局区域 */
export interface LayoutArea {
  startY: number;
  height: number;
}

/** 完整布局 */
export interface Layout {
  messageArea: LayoutArea;
  border: { topY: number; bottomY: number };
  inputArea: LayoutArea;
  statusBar: { y: number };
  viewportY: number;
  contentHeight: number;
}

/** 布局参数 */
export interface LayoutParams {
  messageLines: number;
  inputLines: number;
}

/** 边框高度 */
const BORDER_HEIGHT = 2; // 上边框 + 下边框

/** 状态栏高度 */
const STATUS_BAR_HEIGHT = 1;

export class LayoutScheduler {
  private termSize: TermSize;

  constructor(termSize: TermSize) {
    this.termSize = termSize;
  }

  /**
   * 更新终端尺寸
   */
  updateTermSize(size: TermSize): void {
    this.termSize = size;
  }

  /**
   * 计算布局
   *
   * 物理本质：排版师规划页面布局。
   * 1. 消息区在上方（高度随内容变化）
   * 2. 边框分隔消息区和输入区
   * 3. 输入区在下方（高度固定）
   * 4. 状态栏在最底部
   * 5. 内容超出时，viewport 取最后 N 行
   */
  calculateLayout(params: LayoutParams): Layout {
    const { messageLines, inputLines } = params;
    const { rows, cols } = this.termSize;

    // 计算页脚高度（边框 + 输入区 + 状态栏）
    const footerHeight = BORDER_HEIGHT + inputLines + STATUS_BAR_HEIGHT;

    // 内容总高度（消息 + 页脚）
    const contentHeight = messageLines + footerHeight;

    // 计算 viewportY（已进 scrollback 的行数）
    const viewportY = this.getViewportY(contentHeight);

    // 消息区布局
    const messageArea: LayoutArea = {
      startY: 0,
      height: messageLines,
    };

    // 边框布局
    const border = {
      topY: messageLines,
      bottomY: messageLines + 1 + inputLines,
    };

    // 输入区布局
    const inputArea: LayoutArea = {
      startY: messageLines + 1, // 上边框之后
      height: inputLines,
    };

    // 状态栏布局
    const statusBar = {
      y: messageLines + BORDER_HEIGHT + inputLines,
    };

    return {
      messageArea,
      border,
      inputArea,
      statusBar,
      viewportY,
      contentHeight,
    };
  }

  /**
   * 计算 viewportY（已进 scrollback 的行数）
   *
   * 物理本质：计算有多少行已经被滚到看不见的地方。
   * viewportY = max(0, contentHeight - termRows)
   *
   * 这是 Claude Code log-update.ts 的核心算法：
   * - 内容少于一屏时，viewportY = 0（从第一行开始显示）
   * - 内容多于一屏时，viewportY > 0（旧内容滚进 scrollback）
   */
  getViewportY(contentHeight: number): number {
    return Math.max(0, contentHeight - this.termSize.rows);
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -- --run src/__tests__/output/layout-scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/output/layout-scheduler.ts src/__tests__/output/layout-scheduler.test.ts
git commit -m "feat(output): add LayoutScheduler for content growth model"
```

---

## 阶段 4：输出闸门

### Task 6: 创建输出闸门

**Files:**
- Create: `src/output/output-gate.ts`
- Create: `src/__tests__/output/output-gate.test.ts`

- [ ] **Step 1: 编写输出闸门测试**

```typescript
// src/__tests__/output/output-gate.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OutputGate } from '../../output/output-gate.js';

describe('OutputGate', () => {
  let gate: OutputGate;
  let writer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writer = vi.fn();
    gate = new OutputGate({
      rows: 24,
      cols: 80,
      writer,
    });
  });

  describe('send', () => {
    it('should queue message', () => {
      gate.send('system', 'test message');
      expect(gate.queueSize).toBe(1);
    });

    it('should process queue on flush', () => {
      gate.send('system', 'test message');
      gate.flush();
      expect(writer).toHaveBeenCalled();
    });

    it('should handle error messages with high priority', () => {
      gate.send('system', 'low');
      gate.send('error', 'high');
      gate.send('assistant', 'mid');

      // error 应该最先被处理
      gate.flush();
      const firstCall = writer.mock.calls[0]?.[0] ?? '';
      expect(firstCall).toContain('high');
    });
  });

  describe('intercept', () => {
    it('should intercept stdout.write', () => {
      const originalWrite = process.stdout.write;
      gate.intercept();

      // 现在 stdout.write 应该被替换
      expect(process.stdout.write).not.toBe(originalWrite);

      // 恢复
      gate.restore();
      expect(process.stdout.write).toBe(originalWrite);
    });
  });

  describe('normalize', () => {
    it('should normalize input text', () => {
      expect(gate.normalize('Hello\x00World')).toBe('HelloWorld');
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -- --run src/__tests__/output/output-gate.test.ts`
Expected: FAIL - 模块不存在

- [ ] **Step 3: 实现输出闸门**

```typescript
// src/output/output-gate.ts
// 输出闸门（唯一出口）
//
// 物理本质：交通管制。
// 所有车辆（输出）必须经过收费站（OutputGate），
// 不允许任何车走应急车道（直接写终端）。
//
// 这是 Claude Code log-update.ts 的同款机制：
// - 唯一出口：所有输出都经过 gate.send()
// - 优先级队列：error > thinking > tool > assistant > system
// - 编码清洗：GBK→UTF-8 自动检测
// - 帧缓冲：只写变化的格子

import { MessageQueue } from './message-queue.js';
import { Encoder } from './encoder.js';
import { LayoutScheduler } from './layout-scheduler.js';
import { StylePool } from './style-pool.js';
import type { MessageType, OutputMessage, Writer, TermSize } from './types.js';
import { MessagePriority } from './types.js';

export interface OutputGateOptions {
  rows: number;
  cols: number;
  writer: Writer;
}

export class OutputGate {
  private queue: MessageQueue;
  private encoder: Encoder;
  private layout: LayoutScheduler;
  private stylePool: StylePool;
  private writer: Writer;
  private originalWrite: typeof process.stdout.write | null = null;

  constructor(options: OutputGateOptions) {
    this.queue = new MessageQueue();
    this.encoder = new Encoder();
    this.layout = new LayoutScheduler({ rows: options.rows, cols: options.cols });
    this.stylePool = new StylePool();
    this.writer = options.writer;
  }

  /**
   * 发送消息到队列
   *
   * 物理本质：车辆进入收费站。
   * 所有输出都必须经过这个函数。
   */
  send(type: MessageType, content: string, style?: OutputMessage['style']): OutputMessage {
    // 编码清洗
    const normalized = this.normalize(content);

    // 确定优先级
    const priority = this.getPriority(type);

    // 入队
    return this.queue.enqueue({
      type,
      content: normalized,
      style,
      priority,
    });
  }

  /**
   * 刷新队列（处理所有待处理消息）
   *
   * 物理本质：收费站放行所有车辆。
   * 按优先级顺序处理消息，生成 ANSI 序列，写入终端。
   */
  flush(): void {
    while (!this.queue.isEmpty) {
      const message = this.queue.dequeue();
      if (message) {
        this.processMessage(message);
      }
    }
  }

  /**
   * 处理单个消息
   *
   * 物理本质：检查车辆通行证，放行。
   */
  private processMessage(message: OutputMessage): void {
    // 获取样式
    const style = this.stylePool.get(message.style);
    const ansiStyle = this.stylePool.toAnsi(style);

    // 生成 ANSI 序列
    const output = ansiStyle
      ? `${ansiStyle}${message.content}\x1b[0m`
      : message.content;

    // 写入终端
    this.writer(output + '\n');
  }

  /**
   * 拦截 stdout.write
   *
   * 物理本质：在收费站前面设卡。
   * 所有直接写 stdout 的输出都会被拦截，重定向到 gate.send()。
   */
  intercept(): void {
    this.originalWrite = process.stdout.write;
    const gate = this;

    process.stdout.write = function(chunk: any, ...args: any[]): boolean {
      // 如果是 Renderer 的输出，允许通过
      // TODO: 需要标记 Renderer 的输出
      // 其他输出重定向到 gate.send()
      if (typeof chunk === 'string') {
        gate.send('system', chunk);
      }
      return true;
    } as typeof process.stdout.write;
  }

  /**
   * 恢复 stdout.write
   *
   * 物理本质：拆除收费站前的关卡。
   */
  restore(): void {
    if (this.originalWrite) {
      process.stdout.write = this.originalWrite;
      this.originalWrite = null;
    }
  }

  /**
   * 标准化文本（编码清洗）
   *
   * 物理本质：检查车辆是否超载，清理货物。
   */
  normalize(text: string): string {
    return Encoder.normalize(text);
  }

  /**
   * 获取消息优先级
   *
   * 物理本质：根据车辆类型确定通行顺序。
   * 救护车（error）最优先，普通车（system）最后。
   */
  private getPriority(type: MessageType): MessagePriority {
    const map: Record<MessageType, MessagePriority> = {
      thinking: MessagePriority.THINKING,
      assistant: MessagePriority.ASSISTANT,
      tool_call: MessagePriority.TOOL_CALL,
      tool_result: MessagePriority.TOOL_RESULT,
      tool_output: MessagePriority.TOOL_OUTPUT,
      system: MessagePriority.SYSTEM,
      error: MessagePriority.ERROR,
      input: MessagePriority.INPUT,
    };
    return map[type] ?? MessagePriority.SYSTEM;
  }

  /**
   * 更新终端尺寸
   */
  updateTermSize(size: TermSize): void {
    this.layout.updateTermSize(size);
  }

  /**
   * 队列大小（测试用）
   */
  get queueSize(): number {
    return this.queue.size;
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -- --run src/__tests__/output/output-gate.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/output/output-gate.ts src/__tests__/output/output-gate.test.ts
git commit -m "feat(output): add OutputGate as single exit point"
```

---

## 阶段 5：公共导出

### Task 7: 创建公共导出

**Files:**
- Create: `src/output/index.ts`

- [ ] **Step 1: 创建公共导出文件**

```typescript
// src/output/index.ts
// 输出系统公共导出

export { OutputGate } from './output-gate.js';
export { MessageQueue } from './message-queue.js';
export { Encoder } from './encoder.js';
export { LayoutScheduler } from './layout-scheduler.js';
export { StylePool } from './style-pool.js';

export type {
  MessageType,
  OutputMessage,
  OutputStyle,
  Writer,
  TermSize,
} from './types.js';

export { MessagePriority } from './types.js';
```

- [ ] **Step 2: 运行所有输出系统测试**

Run: `npm test -- --run src/__tests__/output/`
Expected: PASS (所有输出系统测试通过)

- [ ] **Step 3: 提交**

```bash
git add src/output/index.ts
git commit -m "feat(output): add public exports for output system"
```

---

## 阶段 6：集成

### Task 8: 修改 bash 工具使用编码器

**Files:**
- Modify: `src/agent/tool-registry.ts`

- [ ] **Step 1: 修改 bash 工具使用编码器**

```typescript
// 在文件顶部添加导入
import { Encoder } from '../output/encoder.js';

// 修改 createBashTool 函数
// 在 executor 中使用 Encoder.decodeBuffer 处理 stderr/stdout
```

- [ ] **Step 2: 运行测试验证**

Run: `npm test -- --run src/__tests__/tools.test.ts`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/agent/tool-registry.ts
git commit -m "refactor: use Encoder for bash tool output decoding"
```

---

### Task 9: 修改 index.ts 使用 OutputGate

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 修改 index.ts 使用 OutputGate**

```typescript
// 在文件顶部添加导入
import { OutputGate } from './output/index.js';

// 替换 printLine 和 printStyled 函数
// 使用 gate.send() 替代 renderer.printMessage()
```

- [ ] **Step 2: 运行测试验证**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/index.ts
git commit -m "refactor: use OutputGate for all output"
```

---

## 验证清单

- [ ] 所有输出都经过 OutputGate.send()
- [ ] GBK 编码正确转换为 UTF-8
- [ ] thinking 内容实时渲染，不与 assistant 重叠
- [ ] 测试通过，无回归
- [ ] 性能测试：帧率 >= 30fps

---

## 文件清单

```
src/output/
├── index.ts                # 公共导出
├── types.ts                # 类型定义
├── encoder.ts              # GBK/UTF-8 自动检测
├── style-pool.ts           # 样式对象池
├── message-queue.ts        # 优先级消息队列
├── layout-scheduler.ts     # 布局调度器
├── output-gate.ts          # 输出闸门

src/__tests__/output/
├── encoder.test.ts
├── style-pool.test.ts
├── message-queue.test.ts
├── layout-scheduler.test.ts
├── output-gate.test.ts
```
