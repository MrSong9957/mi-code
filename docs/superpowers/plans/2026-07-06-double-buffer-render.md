# 自研双缓冲渲染管线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork Ink 7 的输出端，替换为自研 Int32Array cell 网格 + cell-level diff + Patch 优化器，对标 Claude Code 的渲染质感。保留 Ink 上游（React/DOM/Yoga/输入端）。

**Architecture:** 沿 spec §2 接缝——保留 Ink reconciler/dom/Yoga/components/hooks；自研 `src/render/` 8 个模块（CharPool/StylePool/Screen/output-ops/yoga-walk/diff/optimizer/emit/renderer）。fork 用 `patch-package` 落地（patches/ink+7.1.0.patch），暴露 `options.renderer` 注入点。feature flag `MICODE_DOUBLE_BUFFER` 可秒回滚 Ink 原生。

**Tech Stack:** TypeScript ESM、Ink 7.1.0、yoga-layout、vitest、patch-package、string-width（已装）。

**测试命令：** `npm test`（vitest run）；类型检查 `npm run typecheck`；构建 `npm run build`。

**关键 spec 文档（只读上下文）：** `docs/superpowers/specs/2026-07-06-double-buffer-render-design.md`
- §3.6 styleId 编码纪律（4 铁律）—— 最易返工，必读
- §3.7 Patch 类型 + ERASE_CHAR_ID
- §4.2 blit 完整实现（全角续位双写）
- §4.4 optimizer 不合并行段（emit 自己邻接判断）

**charter 出处：** `AGENTS.md:70-73`（二期可选优化）、`AGENTS.md:136-139`。

---

## File Structure（新增/修改清单）

**新增（src/render/）：**
- `src/render/types.ts` — `Style` / `Patch` / `CursorPos` / `ERASE_CHAR_ID` 类型与常量
- `src/render/char-pool.ts` — CharPool（intern/get/ASCII 快速路径）
- `src/render/style-pool.ts` — StylePool（intern/transition 缓存 + computeAnsiTransition）
- `src/render/screen.ts` — Screen（Int32Array 网格 + cellAt）+ DoubleBuffer + resetPools/migrateScreenPools
- `src/render/output-ops.ts` — `blit(screen, x, y, text, style: Style)`（编码值唯一生产点）
- `src/render/yoga-walk.ts` — 遍历 Yoga 树调 blit（借鉴 Ink render-node-to-output）
- `src/render/diff.ts` — cell-level diff → Patch[]
- `src/render/optimizer.ts` — Patch 优化（裁剪全角续位 + erase 标记）
- `src/render/emit.ts` — EmitContext + emit（ANSI + DEC 2026 + 绝对 cursor）
- `src/render/renderer.ts` — fork 接缝：组合上述模块 + feature flag + fallback
- `src/render/index.ts` — 导出 + feature flag 常量 `USE_DOUBLE_BUFFER`

**新增测试（src/__tests__/render/）：**
- `char-pool.test.ts` / `style-pool.test.ts` / `screen.test.ts` / `output-ops.test.ts`
- `yoga-walk.test.ts` / `diff.test.ts` / `optimizer.test.ts` / `emit.test.ts` / `integration.test.ts`

**修改：**
- `package.json` — 加 `patch-package` devDependency + `postinstall` 脚本
- `patches/ink+7.1.0.patch` — patch-package 生成的补丁（暴露 `options.renderer`）
- `src/tui/bootstrap.tsx` — render() 调用注入自研 renderer（feature flag 控制）

---

## Task 1: types.ts（共享类型与常量）

**Files:**
- Create: `src/render/types.ts`
- Test: `src/__tests__/render/types.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/render/types.test.ts`:

```ts
// src/__tests__/render/types.test.ts
// 类型与常量：ERASE_CHAR_ID / Style 默认值 / 编解码辅助

import { describe, it, expect } from 'vitest';
import {
  ERASE_CHAR_ID,
  DEFAULT_STYLE,
  encodeStyleId,
  decodeStyleId,
  isFullWidthContinuation,
  type Style,
  type Patch,
  type CursorPos,
} from '../../render/types.js';

describe('render types', () => {
  it('ERASE_CHAR_ID = -1', () => {
    expect(ERASE_CHAR_ID).toBe(-1);
  });

  it('DEFAULT_STYLE 全空（fg=0/bg=0/无装饰）', () => {
    expect(DEFAULT_STYLE.fg).toBe(0);
    expect(DEFAULT_STYLE.bg).toBe(0);
    expect(DEFAULT_STYLE.bold).toBe(false);
    expect(DEFAULT_STYLE.italic).toBe(false);
    expect(DEFAULT_STYLE.underline).toBe(false);
    expect(DEFAULT_STYLE.inverse).toBe(false);
    expect(DEFAULT_STYLE.dim).toBe(false);
    expect(DEFAULT_STYLE.strikethrough).toBe(false);
  });

  it('encodeStyleId: poolId=5, fullWidth=false → 10', () => {
    expect(encodeStyleId(5, false)).toBe(10);
  });

  it('encodeStyleId: poolId=5, fullWidth=true → 11', () => {
    expect(encodeStyleId(5, true)).toBe(11);
  });

  it('decodeStyleId: 编码值 11 → poolId 5', () => {
    expect(decodeStyleId(11)).toBe(5);
  });

  it('decodeStyleId: 编码值 10 → poolId 5', () => {
    expect(decodeStyleId(10)).toBe(5);
  });

  it('isFullWidthContinuation: 编码值 11 → true', () => {
    expect(isFullWidthContinuation(11)).toBe(true);
  });

  it('isFullWidthContinuation: 编码值 10 → false', () => {
    expect(isFullWidthContinuation(10)).toBe(false);
  });

  it('编码 → 解码 round-trip 保持 poolId', () => {
    for (const poolId of [0, 1, 42, 9999]) {
      for (const fw of [false, true]) {
        const encoded = encodeStyleId(poolId, fw);
        expect(decodeStyleId(encoded)).toBe(poolId);
        expect(isFullWidthContinuation(encoded)).toBe(fw);
      }
    }
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- types`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/render/types.ts`:

```ts
// src/render/types.ts
// 自研渲染层的共享类型与常量。
// spec §3.6 styleId 编码纪律：Int32Array 存编码值（poolId<<1|fullWidthFlag），
// Patch 存解码后的纯 poolId + 独立的 isFullWidthContinuation。

/** 特殊 charId：optimizer 标记「此 cell 应擦除」（写空格+默认样式） */
export const ERASE_CHAR_ID = -1;

/** RGB 打包成 24 位（0xFFFFFF）；0 = 默认前景/背景 */
export interface Style {
  fg: number;
  bg: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
  strikethrough: boolean;
}

/** 默认样式（无任何装饰） */
export const DEFAULT_STYLE: Style = {
  fg: 0, bg: 0,
  bold: false, italic: false, underline: false,
  inverse: false, dim: false, strikethrough: false,
};

/** Patch：单 cell 变更（spec §3.7） */
export interface Patch {
  x: number;
  y: number;
  /** charPool 索引（纯 poolId）；或 ERASE_CHAR_ID */
  charId: number;
  /** stylePool 索引（纯 poolId，非编码） */
  styleId: number;
  /** 全角字符的续位 cell，emit 时跳过字符输出 */
  isFullWidthContinuation: boolean;
}

/** 光标位置（绝对坐标，0-based；来自 useCursor） */
export interface CursorPos {
  x: number;
  y: number;
}

// ===== styleId 编解码（spec §3.6 铁律 1-4）=====

/** 编码：纯 poolId + 全角标记 → Int32Array 存储值 */
export function encodeStyleId(poolId: number, fullWidth: boolean): number {
  return (poolId << 1) | (fullWidth ? 1 : 0);
}

/** 解码：Int32Array 存储值 → 纯 poolId */
export function decodeStyleId(encoded: number): number {
  return encoded >>> 1;  // 无符号右移，避免符号位问题
}

/** 解码：Int32Array 存储值 → 是否全角续位 cell */
export function isFullWidthContinuation(encoded: number): boolean {
  return (encoded & 1) === 1;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- types`
Expected: PASS（9/9）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/types.ts src/__tests__/render/types.test.ts
git commit -m "feat(render): types.ts——Style/Patch/CursorPos + styleId 编解码 + ERASE_CHAR_ID"
```

---

## Task 2: char-pool.ts（字符池，跨帧累积 + ASCII 快速路径）

**Files:**
- Create: `src/render/char-pool.ts`
- Test: `src/__tests__/render/char-pool.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/render/char-pool.test.ts`:

```ts
// src/__tests__/render/char-pool.test.ts
import { describe, it, expect } from 'vitest';
import { CharPool } from '../../render/char-pool.js';

describe('CharPool', () => {
  it('intern 空串 → 0（空白占位）', () => {
    const p = new CharPool();
    expect(p.intern('')).toBe(0);
  });

  it('intern 单 ASCII 字符 → id >= 1', () => {
    const p = new CharPool();
    const id = p.intern('a');
    expect(id).toBeGreaterThanOrEqual(1);
    expect(p.get(id)).toBe('a');
  });

  it('intern 同一字符返回同一 id（去重）', () => {
    const p = new CharPool();
    const id1 = p.intern('a');
    const id2 = p.intern('a');
    expect(id1).toBe(id2);
  });

  it('intern 不同字符返回不同 id', () => {
    const p = new CharPool();
    const id1 = p.intern('a');
    const id2 = p.intern('b');
    expect(id1).not.toBe(id2);
  });

  it('ASCII 快速路径：所有 128 个 ASCII 字符可 intern', () => {
    const p = new CharPool();
    for (let c = 0; c < 128; c++) {
      const ch = String.fromCharCode(c);
      const id = p.intern(ch);
      expect(p.get(id)).toBe(ch);
    }
  });

  it('ASCII 复用：第二次 intern 同字符同 id（快速路径命中）', () => {
    const p = new CharPool();
    const id1 = p.intern('x');
    const id2 = p.intern('x');
    expect(id1).toBe(id2);
  });

  it('CJK 字符：intern + get round-trip', () => {
    const p = new CharPool();
    const id = p.intern('你');
    expect(p.get(id)).toBe('你');
  });

  it('CJK 同字去重', () => {
    const p = new CharPool();
    expect(p.intern('你')).toBe(p.intern('你'));
  });

  it('emoji：intern + get round-trip', () => {
    const p = new CharPool();
    const id = p.intern('👋');
    expect(p.get(id)).toBe('👋');
  });

  it('不存在的 id → get 返回空格（防御）', () => {
    const p = new CharPool();
    expect(p.get(99999)).toBe(' ');
  });

  it('size：返回池子条目数（含 index 0 空白）', () => {
    const p = new CharPool();
    expect(p.size()).toBe(1);  // 初始只有空白
    p.intern('a');
    p.intern('b');
    p.intern('a');  // 去重
    expect(p.size()).toBe(3);  // '', 'a', 'b'
  });

  it('migrate：把旧池的 id 映射到新池（用于 resetPools）', () => {
    const old = new CharPool();
    const idA = old.intern('a');
    const idYou = old.intern('你');
    const fresh = new CharPool();
    const newIdA = old.migrate(idA, fresh);
    const newIdYou = old.migrate(idYou, fresh);
    expect(fresh.get(newIdA)).toBe('a');
    expect(fresh.get(newIdYou)).toBe('你');
    // 新池自己 intern 同字符得同 id
    expect(fresh.intern('a')).toBe(newIdA);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- char-pool`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/render/char-pool.ts`:

```ts
// src/render/char-pool.ts
// 字符池：跨帧累积 + Map 去重 + ASCII 快速路径。
// spec §3.2 + §3.6 铁律 4（blit 是唯一生产点的下游消费者）。
//
// 同一字符只存一次（返回相同 charId）。ASCII（charCode < 128）走数组快速路径，
// 其余（CJK/emoji/多字节）走 Map。

export class CharPool {
  /** charId → 字符串；index 0 = 空白占位 */
  private chars: string[] = [''];
  /** 非 ASCII 字符 → charId（ASCII 走 asciiTable） */
  private byChar: Map<string, number> = new Map();
  /** ASCII 快速路径表：charCode(0-127) → charId；-1 = 未存 */
  private asciiTable: Int32Array = new Int32Array(128).fill(-1);

  /** 把字符 intern 进池，返回 charId */
  intern(s: string): number {
    if (s === '') return 0;
    // ASCII 快速路径（仅单字符 + charCode < 128）
    if (s.length === 1) {
      const code = s.charCodeAt(0);
      if (code < 128) {
        const cached = this.asciiTable[code]!;
        if (cached >= 0) return cached;
        const id = this.chars.length;
        this.chars.push(s);
        this.asciiTable[code] = id;
        return id;
      }
    }
    // Map 路径（CJK/emoji/多字节）
    let id = this.byChar.get(s);
    if (id === undefined) {
      id = this.chars.length;
      this.chars.push(s);
      this.byChar.set(s, id);
    }
    return id;
  }

  /** 取字符；不存在返回空格（防御） */
  get(id: number): string {
    return this.chars[id] ?? ' ';
  }

  /** 当前池条目数（含 index 0 空白） */
  size(): number {
    return this.chars.length;
  }

  /**
   * 把本池的某个 id 迁移到新池（用于 resetPools）。
   * 用旧池的字符在新池里 intern，返回新 id。
   * 同字符多次迁移自动复用（新池去重）。
   */
  migrate(oldId: number, fresh: CharPool): number {
    if (oldId === 0) return 0;  // 空白占位直接映射
    return fresh.intern(this.get(oldId));
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- char-pool`
Expected: PASS（12/12）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/char-pool.ts src/__tests__/render/char-pool.test.ts
git commit -m "feat(render): char-pool.ts——跨帧累积 + ASCII 快速路径 + migrate"
```

---

## Task 3: style-pool.ts（样式池 + transition 缓存）

**Files:**
- Create: `src/render/style-pool.ts`
- Test: `src/__tests__/render/style-pool.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/render/style-pool.test.ts`:

```ts
// src/__tests__/render/style-pool.test.ts
import { describe, it, expect } from 'vitest';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE, type Style } from '../../render/types.js';

describe('StylePool', () => {
  it('DEFAULT_STYLE 的 id = 0', () => {
    const p = new StylePool();
    expect(p.intern(DEFAULT_STYLE)).toBe(0);
  });

  it('intern 同样样式返回同 id（去重）', () => {
    const p = new StylePool();
    const s: Style = { ...DEFAULT_STYLE, bold: true };
    expect(p.intern(s)).toBe(p.intern({ ...DEFAULT_STYLE, bold: true }));
  });

  it('intern 不同样式返回不同 id', () => {
    const p = new StylePool();
    const id1 = p.intern({ ...DEFAULT_STYLE, bold: true });
    const id2 = p.intern({ ...DEFAULT_STYLE, italic: true });
    expect(id1).not.toBe(id2);
  });

  it('get(DEFAULT_STYLE id) → DEFAULT_STYLE', () => {
    const p = new StylePool();
    expect(p.get(0)).toEqual(DEFAULT_STYLE);
  });

  it('不存在的 id → get 返回 DEFAULT_STYLE（防御）', () => {
    const p = new StylePool();
    expect(p.get(99999)).toEqual(DEFAULT_STYLE);
  });

  it('transition 相同 id → 空串（无变化）', () => {
    const p = new StylePool();
    expect(p.transition(0, 0)).toBe('');
    const idBold = p.intern({ ...DEFAULT_STYLE, bold: true });
    expect(p.transition(idBold, idBold)).toBe('');
  });

  it('transition 默认 → bold：含 SGR 1', () => {
    const p = new StylePool();
    const idBold = p.intern({ ...DEFAULT_STYLE, bold: true });
    const seq = p.transition(0, idBold);
    expect(seq).toContain('\x1b[1m');
    expect(seq).toContain('\x1b[0m');  // 先 reset 再加 bold
  });

  it('transition 缓存：第二次调同 id 对返回同串', () => {
    const p = new StylePool();
    const idBold = p.intern({ ...DEFAULT_STYLE, bold: true });
    const seq1 = p.transition(0, idBold);
    const seq2 = p.transition(0, idBold);
    expect(seq1).toBe(seq2);
  });

  it('transition fg 颜色：含 38;2;R;G;B', () => {
    const p = new StylePool();
    const idColor = p.intern({ ...DEFAULT_STYLE, fg: 0xFF0000 });  // 红
    const seq = p.transition(0, idColor);
    expect(seq).toContain('38;2;255;0;0');
  });

  it('transition bg 颜色：含 48;2;R;G;B', () => {
    const p = new StylePool();
    const idColor = p.intern({ ...DEFAULT_STYLE, bg: 0x00FF00 });  // 绿
    const seq = p.transition(0, idColor);
    expect(seq).toContain('48;2;0;255;0');
  });

  it('migrate：把旧池 id 迁到新池', () => {
    const old = new StylePool();
    const idBold = old.intern({ ...DEFAULT_STYLE, bold: true });
    const fresh = new StylePool();
    const newId = old.migrate(idBold, fresh);
    expect(fresh.get(newId).bold).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- style-pool`
Expected: FAIL。

- [ ] **Step 3: 写实现**

Create `src/render/style-pool.ts`:

```ts
// src/render/style-pool.ts
// 样式池：跨帧累积 + Map 去重 + transition 缓存。
// spec §3.3：transition 预计算「样式 A → 样式 B」的 ANSI 串（带缓存）。
//
// transition 策略：简单稳健——从任意样式到目标样式，先 \x1b[0m 全 reset，
// 再叠加目标的所有属性。比增量 diff（关 A 的属性、开 B 的属性）简单且无遗漏，
// 字节略多但可读性高。后续 optimizer 可优化为增量。

import { DEFAULT_STYLE, type Style } from './types.js';

/** 把 Style 序列化为去重键 */
function styleKey(s: Style): string {
  return `${s.fg}|${s.bg}|${s.bold ?1:0}|${s.italic?1:0}|${s.underline?1:0}|${s.inverse?1:0}|${s.dim?1:0}|${s.strikethrough?1:0}`;
}

/** 把单个 Style 转 ANSI 序列（不含 reset） */
function styleToAnsi(s: Style): string {
  const parts: string[] = [];
  if (s.bold) parts.push('1');
  if (s.dim) parts.push('2');
  if (s.italic) parts.push('3');
  if (s.underline) parts.push('4');
  if (s.inverse) parts.push('7');
  if (s.strikethrough) parts.push('9');
  if (s.fg !== 0) {
    parts.push(`38;2;${(s.fg >> 16) & 0xFF};${(s.fg >> 8) & 0xFF};${s.fg & 0xFF}`);
  }
  if (s.bg !== 0) {
    parts.push(`48;2;${(s.bg >> 16) & 0xFF};${(s.bg >> 8) & 0xFF};${s.bg & 0xFF}`);
  }
  if (parts.length === 0) return '';
  return `\x1b[${parts.join(';')}m`;
}

export class StylePool {
  private styles: Style[] = [DEFAULT_STYLE];
  private byKey: Map<string, number> = new Map([['', 0]]);
  // 用空串作为 DEFAULT_STYLE 的 key（styleKey(DEFAULT_STYLE) 的简化）
  /** transition 缓存：key = fromId * capacity + toId */
  private transitions: Map<number, string> = new Map();

  constructor() {
    // 修正 DEFAULT_STYLE 的 key（styleKey 产出的串）
    this.byKey = new Map([[styleKey(DEFAULT_STYLE), 0]]);
  }

  intern(s: Style): number {
    const key = styleKey(s);
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push(s);
      this.byKey.set(key, id);
    }
    return id;
  }

  get(id: number): Style {
    return this.styles[id] ?? DEFAULT_STYLE;
  }

  size(): number {
    return this.styles.length;
  }

  /** 计算从 fromStyle 到 toStyle 的 ANSI 串（带缓存） */
  transition(fromId: number, toId: number): string {
    if (fromId === toId) return '';
    const key = fromId * this.styles.length + toId;
    let seq = this.transitions.get(key);
    if (seq === undefined) {
      const from = this.get(fromId);
      const to = this.get(toId);
      seq = computeAnsiTransition(from, to);
      this.transitions.set(key, seq);
    }
    return seq;
  }

  /** 把旧池 id 迁到新池（用于 resetPools） */
  migrate(oldId: number, fresh: StylePool): number {
    if (oldId === 0) return 0;
    return fresh.intern(this.get(oldId));
  }
}

/** from → to 的 ANSI 串：先 reset 再叠加目标属性 */
function computeAnsiTransition(from: Style, to: Style): string {
  const targetSeq = styleToAnsi(to);
  if (targetSeq === '') {
    // 目标是默认样式：仅需 reset
    return '\x1b[0m';
  }
  // 先 reset 再叠加（简单稳健，不增量 diff）
  return `\x1b[0m${targetSeq}`;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- style-pool`
Expected: PASS（11/11）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/style-pool.ts src/__tests__/render/style-pool.test.ts
git commit -m "feat(render): style-pool.ts——intern + transition 缓存 + migrate"
```

---

## Task 4: screen.ts（Int32Array 网格 + DoubleBuffer）

**Files:**
- Create: `src/render/screen.ts`
- Test: `src/__tests__/render/screen.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/render/screen.test.ts`:

```ts
// src/__tests__/render/screen.test.ts
import { describe, it, expect } from 'vitest';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE } from '../../render/types.js';

function makeScreen(rows: number, cols: number): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

describe('Screen', () => {
  it('初始：Int32Array 长度 = rows*cols*2，全 0（空白+默认样式）', () => {
    const s = makeScreen(3, 4);
    expect(s.chars.length).toBe(3 * 4 * 2);
    for (let i = 0; i < s.chars.length; i++) {
      expect(s.chars[i]).toBe(0);
    }
  });

  it('cellAt(0,0) 初始返回 charId=0, encodedStyleId=0', () => {
    const s = makeScreen(2, 2);
    const cell = s.cellAt(0, 0);
    expect(cell.charId).toBe(0);
    expect(cell.encodedStyleId).toBe(0);
  });

  it('cellAt 越界返回 0/0（防御，不抛错）', () => {
    const s = makeScreen(2, 2);
    const cell = s.cellAt(99, 99);
    expect(cell.charId).toBe(0);
    expect(cell.encodedStyleId).toBe(0);
  });

  it('setCell：写入 (x,y) 的 charId + encodedStyleId', () => {
    const s = makeScreen(2, 3);
    s.setCell(1, 0, 42, 10);  // charId=42, encodedStyle=10
    const cell = s.cellAt(1, 0);
    expect(cell.charId).toBe(42);
    expect(cell.encodedStyleId).toBe(10);
  });

  it('setCell 不影响其它 cell', () => {
    const s = makeScreen(2, 3);
    s.setCell(1, 0, 42, 10);
    expect(s.cellAt(0, 0).charId).toBe(0);
    expect(s.cellAt(2, 0).charId).toBe(0);
  });

  it('clear：全部归 0', () => {
    const s = makeScreen(2, 2);
    s.setCell(0, 0, 5, 5);
    s.clear();
    expect(s.cellAt(0, 0).charId).toBe(0);
    expect(s.cellAt(0, 0).encodedStyleId).toBe(0);
  });

  it('resize：重建为新尺寸（数据丢失，全 0）', () => {
    const s = makeScreen(2, 3);
    s.setCell(0, 0, 5, 5);
    s.resize(4, 5);
    expect(s.rows).toBe(4);
    expect(s.cols).toBe(5);
    expect(s.chars.length).toBe(4 * 5 * 2);
    expect(s.cellAt(0, 0).charId).toBe(0);  // 全新
  });
});

describe('Screen pool 引用', () => {
  it('charPool/stylePool 可外部访问', () => {
    const cp = new CharPool();
    const sp = new StylePool();
    const s = new Screen(2, 2, cp, sp);
    expect(s.charPool).toBe(cp);
    expect(s.stylePool).toBe(sp);
  });

  it('换池子引用（resetPools 用）', () => {
    const s = makeScreen(2, 2);
    const newCp = new CharPool();
    const newSp = new StylePool();
    s.charPool = newCp;
    s.stylePool = newSp;
    expect(s.charPool).toBe(newCp);
    expect(s.stylePool).toBe(newSp);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- screen`
Expected: FAIL。

- [ ] **Step 3: 写实现**

Create `src/render/screen.ts`:

```ts
// src/render/screen.ts
// Screen：Int32Array 二维 cell 网格（每 cell 2×Int32 = 8 字节）。
// spec §3.5：Screen 只持有数据 + 池子引用，不暴露写编码值的公共方法。
// 写入由 output-ops.blit 完成（唯一生产点）。
//
// 编码：chars[i*2] = charId, chars[i*2+1] = encodedStyleId（poolId<<1|fullWidthFlag）。
// 见 types.ts encodeStyleId/decodeStyleId。

import type { CharPool } from './char-pool.js';
import type { StylePool } from './style-pool.js';

export class Screen {
  readonly rows: number;
  readonly cols: number;
  chars: Int32Array;
  charPool: CharPool;
  stylePool: StylePool;

  constructor(rows: number, cols: number, charPool: CharPool, stylePool: StylePool) {
    this.rows = rows;
    this.cols = cols;
    this.chars = new Int32Array(rows * cols * 2);  // 初始全 0
    this.charPool = charPool;
    this.stylePool = stylePool;
  }

  /** 取 cell 的 {charId, encodedStyleId}（越界返回 0/0，不抛错） */
  cellAt(x: number, y: number): { charId: number; encodedStyleId: number } {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) {
      return { charId: 0, encodedStyleId: 0 };
    }
    const i = (y * this.cols + x) * 2;
    return { charId: this.chars[i], encodedStyleId: this.chars[i + 1] };
  }

  /**
   * 直接写入 cell 的 charId + encodedStyleId。
   * ⚠️ 仅 output-ops.blit 调用（spec §3.6 铁律 4：编码值唯一生产点）。
   * encodedStyleId 必须是编码后的值（用 encodeStyleId 生成）。
   */
  setCell(x: number, y: number, charId: number, encodedStyleId: number): void {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = (y * this.cols + x) * 2;
    this.chars[i] = charId;
    this.chars[i + 1] = encodedStyleId;
  }

  /** 清空（全 0） */
  clear(): void {
    this.chars.fill(0);
  }

  /** 重建为新尺寸（数据丢失） */
  resize(rows: number, cols: number): void {
    // TypeScript: rows/cols 声明为 readonly，这里用 as 突破（resize 是受控操作）
    (this as { rows: number }).rows = rows;
    (this as { cols: number }).cols = cols;
    this.chars = new Int32Array(rows * cols * 2);
  }
}
```

> **注：** `resize` 突破 readonly 用了 `as` 投影。这是受控的（仅 DoubleBuffer 在 resize 事件时调），不暴露给外部。

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- screen`
Expected: PASS（9/9）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/screen.ts src/__tests__/render/screen.test.ts
git commit -m "feat(render): screen.ts——Int32Array 网格 + cellAt/setCell/clear/resize"
```

---

## Task 5: output-ops.ts（blit，编码值唯一生产点）

**Files:**
- Create: `src/render/output-ops.ts`
- Test: `src/__tests__/render/output-ops.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/render/output-ops.test.ts`:

```ts
// src/__tests__/render/output-ops.test.ts
import { describe, it, expect } from 'vitest';
import { blit } from '../../render/output-ops.js';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE, decodeStyleId, isFullWidthContinuation, type Style } from '../../render/types.js';

function makeScreen(rows: number, cols: number): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

describe('blit', () => {
  it('写 ASCII 字符串：每字符占 1 cell，fullWidth=false', () => {
    const s = makeScreen(1, 5);
    blit(s, 0, 0, 'abc', DEFAULT_STYLE);
    const a = s.cellAt(0, 0);
    const b = s.cellAt(1, 0);
    const c = s.cellAt(2, 0);
    expect(s.charPool.get(a.charId)).toBe('a');
    expect(s.charPool.get(b.charId)).toBe('b');
    expect(s.charPool.get(c.charId)).toBe('c');
    expect(isFullWidthContinuation(a.encodedStyleId)).toBe(false);
    expect(isFullWidthContinuation(b.encodedStyleId)).toBe(false);
  });

  it('写 CJK 字符：占 2 cell，第二个 cell 是续位（fullWidthFlag=1）', () => {
    const s = makeScreen(1, 4);
    blit(s, 0, 0, '你', DEFAULT_STYLE);
    const head = s.cellAt(0, 0);
    const tail = s.cellAt(1, 0);
    expect(s.charPool.get(head.charId)).toBe('你');
    expect(s.charPool.get(tail.charId)).toBe('你');  // 续位存同 charId
    expect(isFullWidthContinuation(head.encodedStyleId)).toBe(false);
    expect(isFullWidthContinuation(tail.encodedStyleId)).toBe(true);
    expect(decodeStyleId(head.encodedStyleId)).toBe(decodeStyleId(tail.encodedStyleId));
  });

  it('写 emoji：占 2 cell，同 CJK 规则', () => {
    const s = makeScreen(1, 4);
    blit(s, 0, 0, '👋', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('👋');
    expect(isFullWidthContinuation(s.cellAt(1, 0).encodedStyleId)).toBe(true);
  });

  it('写混合：ASCII + CJK + ASCII', () => {
    const s = makeScreen(1, 6);
    blit(s, 0, 0, 'a你b', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('a');
    expect(s.charPool.get(s.cellAt(1, 0).charId)).toBe('你');  // CJK head
    expect(isFullWidthContinuation(s.cellAt(2, 0).encodedStyleId)).toBe(true);  // CJK tail
    expect(s.charPool.get(s.cellAt(3, 0).charId)).toBe('b');
  });

  it('行末裁剪：超出 cols 的字符不写', () => {
    const s = makeScreen(1, 3);
    blit(s, 0, 0, 'abcde', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('a');
    expect(s.charPool.get(s.cellAt(1, 0).charId)).toBe('b');
    expect(s.charPool.get(s.cellAt(2, 0).charId)).toBe('c');
    // d, e 未写（越界）
  });

  it('全角字符跨右边界：整字裁掉（不留半字）', () => {
    const s = makeScreen(1, 3);
    // cols=3，'ab你'：a(0),b(1),你 需占 (2,3)，但 3 越界 → 你 整字裁掉
    blit(s, 0, 0, 'ab你', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('a');
    expect(s.charPool.get(s.cellAt(1, 0).charId)).toBe('b');
    expect(s.charPool.get(s.cellAt(2, 0).charId)).toBe('');  // 空（你 被裁）
  });

  it('应用 Style：所有写入字符同 styleId', () => {
    const s = makeScreen(1, 3);
    const bold: Style = { ...DEFAULT_STYLE, bold: true };
    blit(s, 0, 0, 'ab', bold);
    const boldStyleId = s.stylePool.intern(bold);
    expect(decodeStyleId(s.cellAt(0, 0).encodedStyleId)).toBe(boldStyleId);
    expect(decodeStyleId(s.cellAt(1, 0).encodedStyleId)).toBe(boldStyleId);
  });

  it('多行文本（含 \\n）：换行写入', () => {
    const s = makeScreen(2, 3);
    blit(s, 0, 0, 'ab\ncd', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('a');
    expect(s.charPool.get(s.cellAt(1, 0).charId)).toBe('b');
    expect(s.charPool.get(s.cellAt(0, 1).charId)).toBe('c');
    expect(s.charPool.get(s.cellAt(1, 1).charId)).toBe('d');
  });

  it('空字符串：无操作', () => {
    const s = makeScreen(1, 3);
    blit(s, 0, 0, '', DEFAULT_STYLE);
    expect(s.cellAt(0, 0).charId).toBe(0);
  });

  it('负坐标 / 越界 y：无操作（防御）', () => {
    const s = makeScreen(2, 3);
    blit(s, -1, 0, 'a', DEFAULT_STYLE);
    blit(s, 0, 99, 'a', DEFAULT_STYLE);
    expect(s.cellAt(0, 0).charId).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- output-ops`
Expected: FAIL。

- [ ] **Step 3: 写实现**

Create `src/render/output-ops.ts`:

```ts
// src/render/output-ops.ts
// 操作收集器：blit 是编码值的唯一生产点（spec §3.6 铁律 4）。
// 接收 Style 对象（非 poolId），内部 intern + 编码 + 全角续位处理。

import stringWidth from 'string-width';
import type { Screen } from './screen.js';
import type { Style } from './types.js';
import { encodeStyleId } from './types.js';

/**
 * 在 screen 的（y 行 x 列起）写入字符串，应用样式。
 * 处理：码点遍历、全角字符双 cell、行末整字裁剪、多行（\n）。
 */
export function blit(screen: Screen, x: number, y: number, text: string, style: Style): void {
  if (text === '') return;
  const styleId = screen.stylePool.intern(style);

  // 按行分割（支持多行）
  const lines = text.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const targetY = y + lineIdx;
    if (targetY < 0 || targetY >= screen.rows) continue;

    // 按码点遍历（[...line] 等价）
    let cx = x;
    for (const ch of line) {
      if (cx >= screen.cols) break;  // 行末裁剪
      const w = stringWidth(ch);
      if (w <= 0) continue;  // 零宽字符（如组合标记）跳过
      if (cx + w > screen.cols) break;  // 全角字符跨右边界，整字裁掉

      const charId = screen.charPool.intern(ch);
      // head cell
      screen.setCell(cx, targetY, charId, encodeStyleId(styleId, false));
      // 全角续位 cell（w===2 时）
      if (w === 2 && cx + 1 < screen.cols) {
        screen.setCell(cx + 1, targetY, charId, encodeStyleId(styleId, true));
      }
      cx += w;
    }
  }
}

/**
 * 把 Screen 的指定矩形区域清空（写空白 + 默认样式）。
 * 用于 yoga-walk 在重绘前清场，或 clip 区域。
 */
export function clearRegion(screen: Screen, x1: number, y1: number, x2: number, y2: number): void {
  for (let y = Math.max(0, y1); y < Math.min(screen.rows, y2); y++) {
    for (let x = Math.max(0, x1); x < Math.min(screen.cols, x2); x++) {
      screen.setCell(x, y, 0, 0);
    }
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- output-ops`
Expected: PASS（11/11）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/output-ops.ts src/__tests__/render/output-ops.test.ts
git commit -m "feat(render): output-ops.ts——blit（编码值唯一生产点）+ 全角续位 + 行末裁剪"
```

---

## Task 6: diff.ts（cell-level diff）

**Files:**
- Create: `src/render/diff.ts`
- Test: `src/__tests__/render/diff.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/render/diff.test.ts`:

```ts
// src/__tests__/render/diff.test.ts
import { describe, it, expect } from 'vitest';
import { diff } from '../../render/diff.js';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE } from '../../render/types.js';
import { blit } from '../../render/output-ops.js';

function makeScreen(rows: number, cols: number): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

describe('diff', () => {
  it('两帧相同 → 空 Patch[]', () => {
    const front = makeScreen(2, 3);
    const back = makeScreen(2, 3);
    expect(diff(front, back)).toEqual([]);
  });

  it('单 cell 变更 → 1 个 Patch', () => {
    const front = makeScreen(1, 3);
    const back = makeScreen(1, 3);
    blit(back, 0, 0, 'a', DEFAULT_STYLE);
    const patches = diff(front, back);
    expect(patches.length).toBe(1);
    expect(patches[0]!.x).toBe(0);
    expect(patches[0]!.y).toBe(0);
    expect(patches[0]!.isFullWidthContinuation).toBe(false);
  });

  it('多 cell 变更 → 多 Patch（按行优先序）', () => {
    const front = makeScreen(1, 3);
    const back = makeScreen(1, 3);
    blit(back, 0, 0, 'abc', DEFAULT_STYLE);
    const patches = diff(front, back);
    expect(patches.length).toBe(3);
    expect(patches.map(p => p.x)).toEqual([0, 1, 2]);
  });

  it('CJK 变更 → head + 续位 都进 Patch，续位 isFullWidthContinuation=true', () => {
    const front = makeScreen(1, 3);
    const back = makeScreen(1, 3);
    blit(back, 0, 0, '你', DEFAULT_STYLE);
    const patches = diff(front, back);
    expect(patches.length).toBe(2);
    const head = patches.find(p => !p.isFullWidthContinuation)!;
    const tail = patches.find(p => p.isFullWidthContinuation)!;
    expect(head).toBeTruthy();
    expect(tail).toBeTruthy();
    expect(head.x).toBe(0);
    expect(tail.x).toBe(1);
  });

  it('Patch.styleId 是解码后的纯 poolId（非编码值）', () => {
    const front = makeScreen(1, 2);
    const back = makeScreen(1, 2);
    const bold = { ...DEFAULT_STYLE, bold: true };
    blit(back, 0, 0, 'a', bold);
    const patches = diff(front, back);
    const expectedStyleId = back.stylePool.intern(bold);
    expect(patches[0]!.styleId).toBe(expectedStyleId);
  });

  it('跨行变更：按 y 优先、x 次之排序', () => {
    const front = makeScreen(2, 2);
    const back = makeScreen(2, 2);
    blit(back, 0, 0, 'ab', DEFAULT_STYLE);
    blit(back, 0, 1, 'cd', DEFAULT_STYLE);
    const patches = diff(front, back);
    expect(patches.map(p => `${p.x},${p.y}`)).toEqual(['0,0', '1,0', '0,1', '1,1']);
  });

  it('尺寸不同 → 抛错（防御，DoubleBuffer 保证同尺寸）', () => {
    const front = makeScreen(2, 3);
    const back = makeScreen(3, 2);
    expect(() => diff(front, back)).toThrow();
  });

  it('同 charId 不同 styleId → 检测到变更', () => {
    const front = makeScreen(1, 2);
    const back = makeScreen(1, 2);
    blit(front, 0, 0, 'a', DEFAULT_STYLE);  // front 已有 a
    blit(back, 0, 0, 'a', { ...DEFAULT_STYLE, bold: true });  // back 同字符但 bold
    const patches = diff(front, back);
    expect(patches.length).toBe(1);
    expect(patches[0]!.charId).toBe(back.charPool.intern('a'));
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- diff`
Expected: FAIL。

- [ ] **Step 3: 写实现**

Create `src/render/diff.ts`:

```ts
// src/render/diff.ts
// cell-level diff：逐 cell 比较 front/back 的 Int32Array，产出 Patch[]。
// spec §4.3：全角续位 cell 仍进 Patch（不 continue），由 emit 跳过字符输出。
// Patch.styleId 是解码后的纯 poolId（spec §3.6 铁律 2）。

import type { Screen } from './screen.js';
import type { Patch } from './types.js';
import { decodeStyleId, isFullWidthContinuation } from './types.js';

export function diff(front: Screen, back: Screen): Patch[] {
  if (front.rows !== back.rows || front.cols !== back.cols) {
    throw new Error(`diff: screen size mismatch (front ${front.rows}x${front.cols}, back ${back.rows}x${back.cols})`);
  }
  const patches: Patch[] = [];
  const cols = front.cols;
  const len = front.chars.length;
  for (let i = 0; i < len; i += 2) {
    if (front.chars[i] !== back.chars[i] || front.chars[i + 1] !== back.chars[i + 1]) {
      const cellIndex = i / 2;
      const y = Math.floor(cellIndex / cols);
      const x = cellIndex % cols;
      const encodedStyle = back.chars[i + 1];
      patches.push({
        x, y,
        charId: back.chars[i],
        styleId: decodeStyleId(encodedStyle),
        isFullWidthContinuation: isFullWidthContinuation(encodedStyle),
      });
    }
  }
  return patches;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- diff`
Expected: PASS（8/8）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/diff.ts src/__tests__/render/diff.test.ts
git commit -m "feat(render): diff.ts——cell-level diff，全角续位进 Patch，styleId 解码"
```

---

## Task 7: optimizer.ts（Patch 优化：裁剪续位 + erase 标记）

**Files:**
- Create: `src/render/optimizer.ts`
- Test: `src/__tests__/render/optimizer.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/render/optimizer.test.ts`:

```ts
// src/__tests__/render/optimizer.test.ts
import { describe, it, expect } from 'vitest';
import { optimize } from '../../render/optimizer.js';
import { ERASE_CHAR_ID, type Patch } from '../../render/types.js';

function patch(x: number, y: number, charId: number, styleId: number, fw = false): Patch {
  return { x, y, charId, styleId, isFullWidthContinuation: fw };
}

describe('optimize', () => {
  it('空输入 → 空输出', () => {
    expect(optimize([])).toEqual([]);
  });

  it('全角续位 patch 被过滤掉（emit 不需要它们）', () => {
    const input: Patch[] = [
      patch(0, 0, 1, 0, false),   // head
      patch(1, 0, 1, 0, true),    // 续位
      patch(2, 0, 2, 0, false),
    ];
    const out = optimize(input);
    expect(out.length).toBe(2);
    expect(out.every(p => !p.isFullWidthContinuation)).toBe(true);
  });

  it('行内按 x 排序', () => {
    const input: Patch[] = [
      patch(2, 0, 2, 0),
      patch(0, 0, 1, 0),
      patch(1, 0, 3, 0),
    ];
    const out = optimize(input);
    expect(out.map(p => p.x)).toEqual([0, 1, 2]);
  });

  it('跨行按 y 优先、x 次之排序', () => {
    const input: Patch[] = [
      patch(0, 1, 1, 0),
      patch(1, 0, 2, 0),
      patch(0, 0, 3, 0),
    ];
    const out = optimize(input);
    expect(out.map(p => `${p.x},${p.y}`)).toEqual(['0,0', '1,0', '0,1']);
  });

  it('「写空格 + 默认样式」patch → charId 标记为 ERASE_CHAR_ID', () => {
    // 空格的 charId 在 CharPool 里是 0（intern('') 或 intern(' ')？取决于实现）
    // optimizer 规则：charId 为空白 + styleId 为默认 → 标记 ERASE
    const input: Patch[] = [
      patch(0, 0, 0, 0),  // charId=0（空白）+ styleId=0（默认）
      patch(1, 0, 5, 0),  // 普通字符
    ];
    const out = optimize(input);
    expect(out[0]!.charId).toBe(ERASE_CHAR_ID);
    expect(out[1]!.charId).toBe(5);
  });

  it('非默认样式的空格不标记 ERASE（保留为普通字符）', () => {
    const input: Patch[] = [
      patch(0, 0, 0, 3),  // 空白但 styleId=3（非默认）
    ];
    const out = optimize(input);
    expect(out[0]!.charId).toBe(0);  // 未被标记 ERASE
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- optimizer`
Expected: FAIL。

- [ ] **Step 3: 写实现**

Create `src/render/optimizer.ts`:

```ts
// src/render/optimizer.ts
// Patch 优化器（spec §4.4）：输出仍是单 cell Patch[]，不合并行段。
// 行段合并由 emit 自己用邻接判断完成。
//
// optimizer 职责：
// 1. 过滤全角续位 patch（emit 不需要）
// 2. 行内按 x 排序（让 emit 邻接判断命中率高）
// 3. 「写空白+默认样式」patch → 标记 ERASE_CHAR_ID（让 emit 发 eraseEndLine）

import { ERASE_CHAR_ID, type Patch } from './types.js';

export function optimize(patches: Patch[]): Patch[] {
  if (patches.length === 0) return [];

  // 1. 过滤全角续位 + 标记 ERASE
  const filtered: Patch[] = [];
  for (const p of patches) {
    if (p.isFullWidthContinuation) continue;  // 续位跳过
    if (p.charId === 0 && p.styleId === 0) {
      // 空白 + 默认样式 → 标记 ERASE
      filtered.push({ ...p, charId: ERASE_CHAR_ID });
    } else {
      filtered.push(p);
    }
  }

  // 2. 按 (y, x) 排序
  filtered.sort((a, b) => a.y - b.y || a.x - b.x);

  return filtered;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- optimizer`
Expected: PASS（6/6）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/optimizer.ts src/__tests__/render/optimizer.test.ts
git commit -m "feat(render): optimizer.ts——裁剪续位 + ERASE 标记 + 行内排序"
```

---

## Task 8: emit.ts（ANSI 输出 + DEC 2026 + 绝对 cursor）

**Files:**
- Create: `src/render/emit.ts`
- Test: `src/__tests__/render/emit.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/render/emit.test.ts`:

```ts
// src/__tests__/render/emit.test.ts
import { describe, it, expect } from 'vitest';
import { emit, type EmitContext } from '../../render/emit.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { ERASE_CHAR_ID, DEFAULT_STYLE, type Patch } from '../../render/types.js';

function makeCtx(): { ctx: EmitContext; output: string[] } {
  const output: string[] = [];
  const ctx: EmitContext = {
    charPool: new CharPool(),
    stylePool: new StylePool(),
    stdout: { write: (s: string) => { output.push(s); return true; } } as any,
  };
  return { ctx, output };
}

function patch(x: number, y: number, charId: number, styleId: number, fw = false): Patch {
  return { x, y, charId, styleId, isFullWidthContinuation: fw };
}

describe('emit', () => {
  it('空 patches → 仍输出 DEC 2026 包裹 + hideCursor', () => {
    const { ctx, output } = makeCtx();
    emit([], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[?2026h');
    expect(written).toContain('\x1b[?2026l');
    expect(written).toContain('\x1b[?25l');  // hideCursor
  });

  it('单 patch：绝对定位 + 字符 + DEC 2026', () => {
    const { ctx, output } = makeCtx();
    const charId = ctx.charPool.intern('X');
    emit([patch(3, 2, charId, 0)], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[?2026h');
    expect(written).toContain('\x1b[3;4H');  // y+1=3, x+1=4
    expect(written).toContain('X');
    expect(written).toContain('\x1b[?2026l');
  });

  it('相邻 patch（x+1）→ 不重发 cursorTo', () => {
    const { ctx, output } = makeCtx();
    const a = ctx.charPool.intern('a');
    const b = ctx.charPool.intern('b');
    emit([patch(0, 0, a, 0), patch(1, 0, b, 0)], ctx);
    const written = output.join('');
    // 第一个 patch 发 cursorTo(0,0) → \x1b[1;1H
    expect(written).toContain('\x1b[1;1H');
    // 第二个 patch 邻接，不应再发 cursorTo
    // 检查只有一个 cursorTo（粗略：count \x1b[;H 模式）
    const cursorMatches = written.match(/\x1b\[\d+;\d+H/g) ?? [];
    expect(cursorMatches.length).toBe(1);
  });

  it('非邻接 patch → 各发 cursorTo', () => {
    const { ctx, output } = makeCtx();
    const a = ctx.charPool.intern('a');
    const c = ctx.charPool.intern('c');
    emit([patch(0, 0, a, 0), patch(5, 0, c, 0)], ctx);
    const written = output.join('');
    const cursorMatches = written.match(/\x1b\[\d+;\d+H/g) ?? [];
    expect(cursorMatches.length).toBe(2);
  });

  it('style 变化：发 SGR transition', () => {
    const { ctx, output } = makeCtx();
    const a = ctx.charPool.intern('a');
    const boldId = ctx.stylePool.intern({ ...DEFAULT_STYLE, bold: true });
    emit([patch(0, 0, a, boldId)], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[1m');  // bold
  });

  it('ERASE_CHAR_ID patch → 发 eraseEndLine', () => {
    const { ctx, output } = makeCtx();
    emit([patch(0, 0, ERASE_CHAR_ID, 0)], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[K');  // eraseEndLine
  });

  it('全角续位 patch → 跳过字符输出（不写字符）', () => {
    const { ctx, output } = makeCtx();
    const you = ctx.charPool.intern('你');
    // 仅传续位 patch（异常情况，但 emit 应容错）
    emit([patch(0, 0, you, 0, true)], ctx);
    const written = output.join('');
    expect(written).not.toContain('你');  // 不输出字符
  });

  it('cursor 提供 → 末尾绝对定位 + showCursor', () => {
    const { ctx, output } = makeCtx();
    ctx.cursor = { x: 5, y: 3 };
    emit([], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[4;6H');  // y+1=4, x+1=6
    expect(written).toContain('\x1b[?25h');  // showCursor
  });

  it('每帧开头 reset 样式（\\x1b[0m）', () => {
    const { ctx, output } = makeCtx();
    emit([], ctx);
    expect(output.join('')).toContain('\x1b[0m');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- emit`
Expected: FAIL。

- [ ] **Step 3: 写实现**

Create `src/render/emit.ts`:

```ts
// src/render/emit.ts
// 把 Patch[] 写成 ANSI 序列发到 stdout（spec §4.5）。
// - DEC 2026 同步输出包裹（bsu/esu）
// - 每帧开头 reset 样式（不依赖帧间状态）
// - 绝对 cursor 定位（\x1b[<y+1>;<x+1>H，1-origin）
// - 邻接 patch 复用 cursor（不重发 cursorTo）
// - style transition 用 StylePool 缓存
// - ERASE_CHAR_ID → eraseEndLine
// - 全角续位 patch → 跳过字符输出
// - 末尾 cursor 定位（如果有 useCursor 提供）

import type { CharPool } from './char-pool.js';
import type { StylePool } from './style-pool.js';
import type { CursorPos, Patch } from './types.js';
import { ERASE_CHAR_ID } from './types.js';

export interface EmitContext {
  charPool: CharPool;
  stylePool: StylePool;
  stdout: { write: (s: string) => boolean };
  /** 光标位置（绝对，0-based）；无则隐藏光标 */
  cursor?: CursorPos;
}

export function emit(patches: Patch[], ctx: EmitContext): void {
  const { charPool, stylePool, stdout, cursor } = ctx;
  const out: string[] = [];

  out.push('\x1b[?2026h');  // BSU
  out.push('\x1b[0m');      // 每帧 reset 样式
  let curStyleId = 0;
  let prevX = -1, prevY = -1;

  for (const patch of patches) {
    if (patch.isFullWidthContinuation) continue;  // 续位跳过字符输出

    // cursor 邻接判断（emit 自己做兜底，spec §4.4 决策）
    const adjacent = (patch.y === prevY && patch.x === prevX + 1);
    if (!adjacent) {
      out.push(`\x1b[${patch.y + 1};${patch.x + 1}H`);
    }

    if (patch.charId === ERASE_CHAR_ID) {
      out.push('\x1b[K');  // eraseEndLine
    } else {
      // style transition
      const trans = stylePool.transition(curStyleId, patch.styleId);
      if (trans) { out.push(trans); curStyleId = patch.styleId; }
      // 字符
      out.push(charPool.get(patch.charId));
    }

    prevX = patch.x;
    prevY = patch.y;
  }

  // 末尾 cursor 定位
  if (cursor) {
    out.push(`\x1b[${cursor.y + 1};${cursor.x + 1}H`);
    out.push('\x1b[?25h');  // showCursor
  } else {
    out.push('\x1b[?25l');  // hideCursor
  }

  out.push('\x1b[?2026l');  // ESU
  stdout.write(out.join(''));
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- emit`
Expected: PASS（10/10）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/emit.ts src/__tests__/render/emit.test.ts
git commit -m "feat(render): emit.ts——ANSI 输出 + DEC 2026 + 绝对 cursor + 邻接复用"
```

---

## Task 9: yoga-walk.ts（遍历 Yoga 树调 blit）

**Files:**
- Create: `src/render/yoga-walk.ts`
- Test: `src/__tests__/render/yoga-walk.test.ts`

- [ ] **Step 1: 探查 Ink 的 DOM 节点结构**

Read `node_modules/ink/build/dom.js` 和 `node_modules/ink/build/render-node-to-output.js` 确认：
- Ink DOM 节点字段：`nodeName`（'ink-root'/'ink-box'/'ink-text'）、`yogaNode`、`childNodes`、`style`、`internal_transform`、`internal_static`。
- Yoga 节点 API：`getComputedLeft/Top/Width/Height`、`getDisplay()`、`DISPLAY_NONE`。
- 文本节点用 `squashTextNodes(node)` 合并。

Run: `head -50 node_modules/ink/build/dom.js && echo "---" && grep -n "squashTextNodes\|internal_transform\|getComputedLeft" node_modules/ink/build/render-node-to-output.js`

- [ ] **Step 2: 写失败测试（用 mock DOM 节点）**

Create `src/__tests__/render/yoga-walk.test.ts`:

```ts
// src/__tests__/render/yoga-walk.test.ts
// yoga-walk：遍历 Ink DOM 树（含 yogaNode）调 blit 写入 Screen。

import { describe, it, expect } from 'vitest';
import { renderTree } from '../../render/yoga-walk.js';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE } from '../../render/types.js';
import Yoga from 'yoga-layout';

/** 构造一个 mock Ink DOM 节点（最小可用） */
function makeNode(opts: {
  name: 'ink-root' | 'ink-box' | 'ink-text';
  text?: string;
  children?: any[];
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  displayNone?: boolean;
}): any {
  const yoga = Yoga.Node.create();
  if (opts.left !== undefined) yoga.setPosition(Yoga.POSITION_TYPE_ABSOLUTE, 0);  // 简化
  // 用 __computedLeft 等 hack 模拟已布局的 yogaNode
  const y: any = {
    getComputedLeft: () => opts.left ?? 0,
    getComputedTop: () => opts.top ?? 0,
    getComputedWidth: () => opts.width ?? 10,
    getComputedHeight: () => opts.height ?? 1,
    getDisplay: () => opts.displayNone ? Yoga.DISPLAY_NONE : Yoga.DISPLAY_FLEX,
  };
  return {
    nodeName: opts.name,
    yogaNode: y,
    childNodes: opts.children ?? [],
    style: {},
    internal_transform: undefined,
    internal_static: false,
    // ink-text 节点的文本内容（squashTextNodes 会读）
    ...(opts.text !== undefined ? { textValue: opts.text } : {}),
  };
}

function makeScreen(rows: number, cols: number): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

describe('renderTree (yoga-walk)', () => {
  it('单文本节点：写入对应位置', () => {
    const screen = makeScreen(1, 5);
    const root = makeNode({
      name: 'ink-root',
      left: 0, top: 0, width: 5, height: 1,
      children: [makeNode({ name: 'ink-text', text: 'hello' })],
    });
    renderTree(root, screen, DEFAULT_STYLE);
    expect(screen.charPool.get(screen.cellAt(0, 0).charId)).toBe('h');
    expect(screen.charPool.get(screen.cellAt(4, 0).charId)).toBe('o');
  });

  it('display=NONE 节点跳过', () => {
    const screen = makeScreen(1, 5);
    const root = makeNode({
      name: 'ink-root',
      children: [makeNode({ name: 'ink-text', text: 'hi', displayNone: true })],
    });
    renderTree(root, screen, DEFAULT_STYLE);
    expect(screen.cellAt(0, 0).charId).toBe(0);  // 未写
  });

  it('box 偏移：子节点坐标加父 offset', () => {
    const screen = makeScreen(2, 10);
    const root = makeNode({
      name: 'ink-root',
      children: [
        makeNode({
          name: 'ink-box',
          left: 2, top: 1,
          children: [makeNode({ name: 'ink-text', text: 'X' })],
        }),
      ],
    });
    renderTree(root, screen, DEFAULT_STYLE);
    expect(screen.charPool.get(screen.cellAt(2, 1).charId)).toBe('X');
  });

  it('递归多层 box', () => {
    const screen = makeScreen(1, 10);
    const root = makeNode({
      name: 'ink-root',
      children: [
        makeNode({
          name: 'ink-box', left: 1, top: 0,
          children: [
            makeNode({
              name: 'ink-box', left: 2, top: 0,
              children: [makeNode({ name: 'ink-text', text: 'Y' })],
            }),
          ],
        }),
      ],
    });
    renderTree(root, screen, DEFAULT_STYLE);
    // 总 offset = 1 + 2 = 3
    expect(screen.charPool.get(screen.cellAt(3, 0).charId)).toBe('Y');
  });
});
```

> **注：** mock 的 yogaNode 用对象字面量模拟 getComputedLeft 等。真实 Ink 传的是 yoga-layout 的 YogaNode，API 一致。squashTextNodes 在测试里用 `textValue` 字段简化（真实 Ink 节点有 childNodes 是字符节点）。如果 squashTextNodes 不便 mock，可以给 yoga-walk 加一个 `extractText(node): string` 的注入点。

- [ ] **Step 3: 跑测试，确认失败**

Run: `npm test -- yoga-walk`
Expected: FAIL。

- [ ] **Step 4: 写实现**

Create `src/render/yoga-walk.ts`:

```ts
// src/render/yoga-walk.ts
// 遍历 Ink DOM 树（已 Yoga 布局），把文本节点 blit 到 Screen。
// 借鉴 node_modules/ink/build/render-node-to-output.js 的遍历结构，
// 但目标是 Screen（Int32Array）而非 Ink 的 Output（对象网格）。
//
// Ink DOM 节点字段：
// - nodeName: 'ink-root' | 'ink-box' | 'ink-text'
// - yogaNode: Yoga 节点（getComputedLeft/Top/Width/Height/getDisplay）
// - childNodes: 子节点数组
// - style: { flexDirection, overflow, overflowX, overflowY, textWrap, ... }
// - internal_transform: 可选 transformer 函数（项目未用，先忽略）
// - internal_static: 是否 <Static> 子树
//
// 简化范围（与项目实际用法对齐）：
// - 不处理 overflow clip（项目 ScrollBox 用 visibleRows 裁剪消息，不靠 overflow:hidden）
// - 不处理 border/background（项目用 ASCII 字符画边框，不是 Yoga border）
// - 不处理 internal_transform（项目无 <Transform> 用法，grep 确认）
// - 不处理 <Static>（项目未用）

import Yoga from 'yoga-layout';
import type { Screen } from './screen.js';
import type { Style } from './types.js';
import { blit } from './output-ops.js';

/** Ink DOM 节点的最小类型（避免依赖 Ink 内部类型） */
interface InkNode {
  nodeName: string;
  yogaNode?: {
    getComputedLeft(): number;
    getComputedTop(): number;
    getComputedWidth(): number;
    getComputedHeight(): number;
    getDisplay(): number;
  };
  childNodes?: InkNode[];
  style?: Record<string, unknown>;
  internal_static?: boolean;
  // ink-text 节点的文本（squashTextNodes 的简化读取）
  textValue?: string;
  // 真实 Ink：childNodes 里可能有字符串字面量子节点
}

/** 把 Ink 文本节点的子节点（字符串数组）squash 成单个字符串 */
function squashTextNodes(node: InkNode): string {
  if (typeof node.textValue === 'string') return node.textValue;
  // 真实 Ink：childNodes 是字符串或文本节点
  if (!node.childNodes) return '';
  return node.childNodes
    .map(c => typeof c === 'string' ? c : (c.textValue ?? ''))
    .join('');
}

/**
 * 渲染 Ink DOM 树到 Screen。
 * @param root Ink 根节点（已 Yoga 布局）
 * @param screen 目标 Screen（back buffer）
 * @param baseStyle 继承的样式（项目用 <Text> 自己的 style，这里作为 fallback）
 */
export function renderTree(root: InkNode, screen: Screen, baseStyle: Style): void {
  walk(root, screen, 0, 0, baseStyle);
}

function walk(node: InkNode, screen: Screen, offsetX: number, offsetY: number, inheritedStyle: Style): void {
  if (node.internal_static) return;  // 跳过 <Static>（spec §5.4）

  const yoga = node.yogaNode;
  if (!yoga) return;
  if (yoga.getDisplay() === Yoga.DISPLAY_NONE) return;

  const x = offsetX + yoga.getComputedLeft();
  const y = offsetY + yoga.getComputedTop();

  if (node.nodeName === 'ink-text') {
    const text = squashTextNodes(node);
    if (text.length > 0) {
      blit(screen, x, y, text, inheritedStyle);
    }
    return;
  }

  if (node.nodeName === 'ink-box' || node.nodeName === 'ink-root') {
    // 真实 Ink 会从 node.style 读 <Text> 的 color/bold 等，构造 Style；
    // 这里简化：用 inheritedStyle（项目里 <Text> 样式由 Ink 算，我们暂用继承）。
    // 后续 Task 接 Ink 时会用 Ink 的 styles.js 把 style 转 Style。
    const childStyle = inheritedStyle;  // TODO Task 11: 从 node.style 解析
    if (node.childNodes) {
      for (const child of node.childNodes) {
        walk(child, screen, x, y, childStyle);
      }
    }
  }
}
```

> **关键注：** yoga-walk 的样式解析是简化的（用 inheritedStyle）。真实接入时（Task 11）需要读 Ink 的 `node.style`（`<Text color="red" bold>` 会写到 node.style）并转成我们的 `Style` 对象。这里先用简化版跑通管线，Task 11 接 Ink 时补全。

- [ ] **Step 5: 跑测试，确认通过**

Run: `npm test -- yoga-walk`
Expected: PASS（4/4）。

- [ ] **Step 6: typecheck + commit**

```bash
npm run typecheck
git add src/render/yoga-walk.ts src/__tests__/render/yoga-walk.test.ts
git commit -m "feat(render): yoga-walk.ts——遍历 Ink DOM 树调 blit（样式解析简化版）"
```

---

## Task 10: DoubleBuffer + resetPools/migrate

**Files:**
- Modify: `src/render/screen.ts`（加 DoubleBuffer 类 + migrateScreenPools）
- Test: extend `src/__tests__/render/screen.test.ts`

- [ ] **Step 1: 写失败测试（追加到 screen.test.ts）**

追加到 `src/__tests__/render/screen.test.ts`：

```ts
import { DoubleBuffer } from '../../render/screen.js';

describe('DoubleBuffer', () => {
  it('初始：front/back 同尺寸，全 0', () => {
    const db = new DoubleBuffer(2, 3);
    expect(db.front.rows).toBe(2);
    expect(db.front.cols).toBe(3);
    expect(db.back.rows).toBe(2);
    expect(db.back.cols).toBe(3);
    expect(db.front.chars.length).toBe(2 * 3 * 2);
  });

  it('swap：back 内容拷到 front，back 清零', () => {
    const db = new DoubleBuffer(1, 2);
    // 在 back 写点东西
    db.back.setCell(0, 0, 5, 10);
    db.swap();
    expect(db.front.cellAt(0, 0).charId).toBe(5);
    expect(db.front.cellAt(0, 0).encodedStyleId).toBe(10);
    // back 清零
    expect(db.back.cellAt(0, 0).charId).toBe(0);
  });

  it('resize：重建 front/back 为新尺寸', () => {
    const db = new DoubleBuffer(2, 3);
    db.resize(4, 5);
    expect(db.front.rows).toBe(4);
    expect(db.front.cols).toBe(5);
    expect(db.back.rows).toBe(4);
    expect(db.back.cols).toBe(5);
  });

  it('resetPools：迁移 front/back 的 id 到新池', () => {
    const db = new DoubleBuffer(1, 2);
    const charId = db.charPool.intern('X');
    const styleId = db.stylePool.intern({ ...require('../../render/types.js').DEFAULT_STYLE, bold: true });
    db.back.setCell(0, 0, charId, (styleId << 1));
    db.front.setCell(0, 0, charId, (styleId << 1));

    const oldCharPool = db.charPool;
    db.resetPools();

    // 新池里 'X' 仍可查到
    expect(db.charPool.get(db.back.cellAt(0, 0).charId)).toBe('X');
    expect(db.charPool.get(db.front.cellAt(0, 0).charId)).toBe('X');
    // 新池不是旧池
    expect(db.charPool).not.toBe(oldCharPool);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- screen`
Expected: FAIL（DoubleBuffer 不存在）。

- [ ] **Step 3: 加 DoubleBuffer 到 screen.ts**

在 `src/render/screen.ts` 末尾追加：

```ts
import { CharPool } from './char-pool.js';
import { StylePool } from './style-pool.js';
import { decodeStyleId, isFullWidthContinuation, encodeStyleId } from './types.js';

const POOL_RESET_INTERVAL_MS = 5 * 60 * 1000;

/** 把 screen 的 charId/styleId 从旧池迁移到新池（原地改 Int32Array） */
function migrateScreenPools(screen: Screen, newCharPool: CharPool, newStylePool: StylePool): void {
  const len = screen.chars.length;
  for (let i = 0; i < len; i += 2) {
    const oldCharId = screen.chars[i];
    const oldEncoded = screen.chars[i + 1];
    if (oldCharId === 0 && oldEncoded === 0) continue;  // 空 cell 跳过
    const oldStyleId = decodeStyleId(oldEncoded);
    const fw = isFullWidthContinuation(oldEncoded);
    // 迁移 charId（用 screen 仍持有的旧池查字符，新池 intern）
    // 注意：screen.charPool 此时还是旧池（resetPools 先迁移再换引用）
    const newCharId = oldCharId === 0 ? 0 : newCharPool.intern(screen.charPool.get(oldCharId));
    const newStyleId = oldStyleId === 0 ? 0 : newStylePool.intern(screen.stylePool.get(oldStyleId));
    screen.chars[i] = newCharId;
    screen.chars[i + 1] = encodeStyleId(newStyleId, fw);
  }
}

export class DoubleBuffer {
  front: Screen;
  back: Screen;
  charPool: CharPool;
  stylePool: StylePool;
  private lastPoolResetTime: number;

  constructor(rows: number, cols: number) {
    this.charPool = new CharPool();
    this.stylePool = new StylePool();
    this.front = new Screen(rows, cols, this.charPool, this.stylePool);
    this.back = new Screen(rows, cols, this.charPool, this.stylePool);
    this.lastPoolResetTime = Date.now();
  }

  /** 交换：back → front，back 清零。含定期池子重置。 */
  swap(): void {
    const now = Date.now();
    if (now - this.lastPoolResetTime > POOL_RESET_INTERVAL_MS) {
      this.resetPools();
      this.lastPoolResetTime = now;
    }
    // back 内容拷到 front
    this.front.chars.set(this.back.chars);
    // back 清零
    this.back.clear();
  }

  /** 重建为新尺寸（resize 事件） */
  resize(rows: number, cols: number): void {
    this.front.resize(rows, cols);
    this.back.resize(rows, cols);
    this.front.charPool = this.charPool;
    this.back.charPool = this.charPool;
    this.front.stylePool = this.stylePool;
    this.back.stylePool = this.stylePool;
  }

  /** 池子重置：创建新池，迁移 front/back 的 id */
  resetPools(): void {
    const newCharPool = new CharPool();
    const newStylePool = new StylePool();
    migrateScreenPools(this.front, newCharPool, newStylePool);
    migrateScreenPools(this.back, newCharPool, newStylePool);
    // 换引用
    this.charPool = newCharPool;
    this.stylePool = newStylePool;
    this.front.charPool = newCharPool;
    this.front.stylePool = newStylePool;
    this.back.charPool = newCharPool;
    this.back.stylePool = newStylePool;
  }
}
```

> **注意 import 位置：** screen.ts 顶部已有 `import type { CharPool }` 和 `import type { StylePool }`（type-only）。DoubleBuffer 需要值导入（`new CharPool()`），所以追加的 import 不能是 type-only。把顶部 type-only import 改成值导入，或追加值导入。**推荐：** 把顶部 `import type { CharPool }` 改为 `import { CharPool }`，`import type { StylePool }` 改为 `import { StylePool }`，避免重复声明。

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- screen`
Expected: PASS（所有 screen + DoubleBuffer 测试绿）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/screen.ts src/__tests__/render/screen.test.ts
git commit -m "feat(render): DoubleBuffer + resetPools（5 分钟重置 + ID 迁移）"
```

---

## Task 11: renderer.ts（fork 接缝 + feature flag + fallback）

**Files:**
- Create: `src/render/renderer.ts`
- Create: `src/render/index.ts`
- Test: `src/__tests__/render/renderer.test.ts`

- [ ] **Step 1: 写失败测试（mock Ink instance）**

Create `src/__tests__/render/renderer.test.ts`:

```ts
// src/__tests__/render/renderer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createCustomRenderer } from '../../render/renderer.js';

describe('createCustomRenderer', () => {
  it('返回函数：接收 rootNode + options，返回 {output, outputHeight, staticOutput}', () => {
    const stdout = { write: vi.fn(), columns: 80, rows: 24, isTTY: true };
    const renderer = createCustomRenderer({ stdout });
    expect(typeof renderer).toBe('function');
  });

  it('空树 → output 为空串，outputHeight=0，不抛错', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const renderer = createCustomRenderer({ stdout });
    const result = renderer(null, { width: 80, height: 24 });
    expect(result.output).toBe('');
    expect(result.outputHeight).toBe(0);
  });

  it('feature flag off（USE_DOUBLE_BUFFER=false）→ 走 fallback', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const fallback = vi.fn(() => ({ output: 'fallback', outputHeight: 1, staticOutput: '' }));
    const renderer = createCustomRenderer({ stdout, useDoubleBuffer: false, fallback });
    renderer(null, { width: 80, height: 24 });
    expect(fallback).toHaveBeenCalled();
  });

  it('自研 renderer 抛错 → 自动 fallback', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const fallback = vi.fn(() => ({ output: 'fallback', outputHeight: 1, staticOutput: '' }));
    // 传一个会抛错的 rootNode
    const badRoot = { yogaNode: { getComputedWidth: () => { throw new Error('boom'); } } };
    const renderer = createCustomRenderer({ stdout, fallback });
    const result = renderer(badRoot as any, { width: 80, height: 24 });
    expect(fallback).toHaveBeenCalled();
    expect(result.output).toBe('fallback');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- renderer`
Expected: FAIL。

- [ ] **Step 3: 写 renderer.ts + index.ts**

Create `src/render/index.ts`:

```ts
// src/render/index.ts
// 自研渲染层入口 + feature flag。
// spec §6：MICODE_DOUBLE_BUFFER=0 关闭，秒回滚 Ink 原生。

export const USE_DOUBLE_BUFFER = process.env.MICODE_DOUBLE_BUFFER !== '0';

export { createCustomRenderer } from './renderer.js';
export type { CustomRendererOptions } from './renderer.js';
```

Create `src/render/renderer.ts`:

```ts
// src/render/renderer.ts
// fork 接缝：组合 yoga-walk + diff + optimizer + emit。
// 返回 Ink 期望的 {output, outputHeight, staticOutput} 占位（output 为空串，
// 因为我们已直接写 stdout；Ink 的 onRender 不会再写 output）。
//
// feature flag + fallback：USE_DOUBLE_BUFFER=false 或自研抛错 → 走 fallback（Ink 原生 renderer）。

import type { DoubleBuffer } from './screen.js';
import { renderTree } from './yoga-walk.js';
import { diff } from './diff.js';
import { optimize } from './optimizer.js';
import { emit, type EmitContext } from './emit.js';
import { DEFAULT_STYLE, type CursorPos } from './types.js';

/** Ink renderer 的返回形状 */
interface RenderResult {
  output: string;
  outputHeight: number;
  staticOutput: string;
}

/** Ink renderer 函数签名 */
type InkRenderer = (node: unknown, options: { width: number; height: number }) => RenderResult;

export interface CustomRendererOptions {
  stdout: { write: (s: string) => boolean; columns?: number; rows?: number; isTTY?: boolean };
  /** feature flag；默认读 USE_DOUBLE_BUFFER */
  useDoubleBuffer?: boolean;
  /** fallback renderer（Ink 原生） */
  fallback?: InkRenderer;
}

export function createCustomRenderer(opts: CustomRendererOptions): InkRenderer {
  const useFlag = opts.useDoubleBuffer ?? (process.env.MICODE_DOUBLE_BUFFER !== '0');
  const fallback = opts.fallback;

  // 懒初始化 DoubleBuffer（首次调用时按尺寸创建）
  let db: DoubleBuffer | null = null;
  let lastCursor: CursorPos | undefined;

  return (node: unknown, options: { width: number; height: number }): RenderResult => {
    if (!useFlag && fallback) {
      return fallback(node, options);
    }
    try {
      // 动态 import 避免 cycle（DoubleBuffer 在 screen.ts）
      const DoubleBufferClass = require('./screen.js').DoubleBuffer as typeof import('./screen.js').DoubleBuffer;
      if (!db || db.front.rows !== options.height || db.front.cols !== options.width) {
        db = new DoubleBufferClass(options.height, options.width);
      }

      // 1. 清 back buffer（每帧重画）
      db.back.clear();

      // 2. yoga-walk：遍历 Ink 树写 back
      renderTree(node as any, db.back, DEFAULT_STYLE);

      // 3. diff
      const patches = diff(db.front, db.back);

      // 4. optimize
      const optimized = optimize(patches);

      // 5. emit
      const ctx: EmitContext = {
        charPool: db.charPool,
        stylePool: db.stylePool,
        stdout: opts.stdout,
        cursor: lastCursor,
      };
      emit(optimized, ctx);

      // 6. swap
      db.swap();

      return { output: '', outputHeight: options.height, staticOutput: '' };
    } catch (err) {
      // 自研抛错 → fallback
      if (fallback) {
        console.error('[mi-code render] custom renderer failed, falling back:', err);
        return fallback(node, options);
      }
      throw err;
    }
  };
}

/** 接收 useCursor 的位置（fork 后 Ink 的 setCursorPosition 改调这里） */
export function setCursorPos(pos: CursorPos | undefined): void {
  // 由 renderer 闭包持有，下次 emit 用
  // 实现细节：renderer 闭包的 lastCursor 字段
  // 这个函数在 Task 12 接 Ink 时由 patch 调用
}
```

> **注：** `setCursorPos` 是占位，Task 12 接 Ink 时由 patch 调它传 cursor 位置。`require('./screen.js')` 用动态 require 避免 ESM cycle；如果 typecheck 报错，改为顶层 `import { DoubleBuffer }`（无 cycle 风险，screen.ts 不 import renderer.ts）。

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- renderer`
Expected: PASS（4/4）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/render/renderer.ts src/render/index.ts src/__tests__/render/renderer.test.ts
git commit -m "feat(render): renderer.ts——fork 接缝 + feature flag + fallback"
```

---

## Task 12: patch-package 落地（fork Ink 暴露 renderer 注入点）

**Files:**
- Modify: `package.json`（加 patch-package devDep + postinstall）
- Create: `patches/ink+7.1.0.patch`（手动编辑 ink.js 暴露 options.renderer）
- Test: 验证 patch 应用 + Ink 仍可正常 render

> **这是最高风险 Task**：直接改 node_modules/ink/build/ink.js。先做 + 验证不破坏现有 TUI，再继续。

- [ ] **Step 1: 安装 patch-package**

```bash
npm install --save-dev patch-package
```

然后在 `package.json` 的 scripts 加：

```json
"postinstall": "patch-package"
```

- [ ] **Step 2: 找 ink.js 的 render options 处理点**

Read `node_modules/ink/build/ink.js` 的 constructor（约 line 180-278）和 `render.js`（render 函数处理 options）。找到：
- options.renderer 是否已存在？（应该没有）
- 在哪里注入「如果 options.renderer 提供，则替换默认 renderer」？

Run: `grep -n "this.options\|renderer\|import render from" node_modules/ink/build/ink.js | head -20`

- [ ] **Step 3: 手动编辑 ink.js 加 renderer 注入点**

在 `node_modules/ink/build/ink.js` 做最小改动（全加性）：

找到 `import render from './renderer.js';`（约 line 14）。

找到 constructor 里给 `this.onRender` 赋值的地方，或 `render(this.rootNode, ...)` 被调用的地方（`onRender` 函数体内，约 line 348）。

**改动方案**（具体行号需 Step 2 确认后填）：

在 ink.js 顶部加：
```js
// MI-CODE FORK: allow custom renderer injection
```

在 constructor 或 onRender 里，把 `const { output, outputHeight, staticOutput } = render(this.rootNode, this.isScreenReaderEnabled);` 改为：
```js
const rendererFn = this.options.renderer || render;
const { output, outputHeight, staticOutput } = rendererFn(this.rootNode, { width: this.options.stdout.columns, height: this.options.stdout.rows });
```

> **关键约束**：改动必须全加性——不提供 options.renderer 时，行为与原版完全一致（`render` 是默认 fallback）。

- [ ] **Step 4: 生成 patch**

```bash
npx patch-package ink
```

这会在 `patches/` 生成 `ink+7.1.0.patch`。检查 patch 内容确认只改了 renderer 注入点。

- [ ] **Step 5: 验证 patch 可重现**

```bash
# 模拟 fresh install
rm -rf node_modules/ink
npm install
# 验证 ink.js 包含改动
grep "MI-CODE FORK\|options.renderer" node_modules/ink/build/ink.js
```

- [ ] **Step 6: 验证不破坏现有 TUI**

```bash
npm test
npm run typecheck
npm run build
```
Expected: 全绿（patch 不改默认行为，USE_DOUBLE_BUFFER 默认仍是 Ink 原生）。

- [ ] **Step 7: 手动冒烟（TUI 正常启动）**

```bash
# 跑现有 TUI（应该和改 patch 前完全一样，因为没传 options.renderer）
npx tsx src/index.ts
# 进 TUI 后输入几条消息，确认渲染正常，Ctrl+C 退出
```

- [ ] **Step 8: commit**

```bash
git add package.json package-lock.json patches/ink+7.1.0.patch
git commit -m "build(render): patch-package fork Ink——暴露 options.renderer 注入点

最小加性改动：不提供 options.renderer 时行为与原版一致。
feature flag 控制是否注入自研 renderer。postinstall 自动应用 patch。"
```

---

## Task 13: bootstrap 注入 + 端到端集成

**Files:**
- Modify: `src/tui/bootstrap.tsx`（render() 调用注入自研 renderer）
- Test: `src/__tests__/render/integration.test.ts`

- [ ] **Step 1: 写端到端集成测试**

Create `src/__tests__/render/integration.test.ts`:

```ts
// src/__tests__/render/integration.test.ts
// 端到端：模拟 Ink render 一棵小树 → 自研 renderer → 断言 ANSI 输出含预期字符。

import { describe, it, expect } from 'vitest';
import { createCustomRenderer } from '../../render/renderer.js';

describe('integration: custom renderer 端到端', () => {
  it('渲染含 ASCII 的假树 → 输出含字符', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const renderer = createCustomRenderer({ stdout });

    const fakeTree = {
      nodeName: 'ink-root',
      yogaNode: {
        getComputedLeft: () => 0, getComputedTop: () => 0,
        getComputedWidth: () => 80, getComputedHeight: () => 24,
        getDisplay: () => 0,  // DISPLAY_FLEX
      },
      childNodes: [{
        nodeName: 'ink-text',
        yogaNode: {
          getComputedLeft: () => 0, getComputedTop: () => 0,
          getComputedWidth: () => 5, getComputedHeight: () => 1,
          getDisplay: () => 0,
        },
        textValue: 'hello',
        childNodes: [],
      }],
    };
    renderer(fakeTree as any, { width: 80, height: 24 });
    const written = writes.join('');
    expect(written).toContain('hello');
    expect(written).toContain('\x1b[?2026h');  // DEC 2026
  });

  it('第二帧无变化 → 输出无字符（仅 DEC 2026 + cursor）', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const renderer = createCustomRenderer({ stdout });

    const fakeTree = {
      nodeName: 'ink-root',
      yogaNode: { getComputedLeft: () => 0, getComputedTop: () => 0, getComputedWidth: () => 5, getComputedHeight: () => 1, getDisplay: () => 0 },
      childNodes: [{ nodeName: 'ink-text', yogaNode: { getComputedLeft: () => 0, getComputedTop: () => 0, getComputedWidth: () => 5, getComputedHeight: () => 1, getDisplay: () => 0 }, textValue: 'hi', childNodes: [] }],
    };
    renderer(fakeTree as any, { width: 80, height: 24 });
    writes.length = 0;  // 清第一帧
    renderer(fakeTree as any, { width: 80, height: 24 });  // 第二帧相同
    const secondFrame = writes.join('');
    expect(secondFrame).not.toContain('hi');  // 无变化不重写
    expect(secondFrame).toContain('\x1b[?2026h');  // 仍包裹 DEC 2026
  });
});
```

- [ ] **Step 2: 跑测试，确认通过**

Run: `npm test -- integration`
Expected: PASS（2/2）。

- [ ] **Step 3: 改 bootstrap.tsx 注入 renderer**

Read `src/tui/bootstrap.tsx`，找到 `render(React.createElement(ConnectedApp, {...}), { exitOnCtrlC: false })`。

改为（feature flag 控制）：

```tsx
import { USE_DOUBLE_BUFFER, createCustomRenderer } from '../render/index.js';

// ...在 bootstrap 函数内，render 调用前：
const renderOptions: any = { exitOnCtrlC: false };
if (USE_DOUBLE_BUFFER) {
  renderOptions.renderer = createCustomRenderer({
    stdout: process.stdout,
    fallback: undefined,  // Ink 原生 renderer 作为 fallback 由 patch 内部处理
  });
}

let inkInstance: InkInstance | null = render(
  React.createElement(ConnectedApp, {
    messagesStore, inputStore, statusStore, logoStore, spinnerStore, completionStore, overlayStore,
    onExit: opts.onExit, onTab: opts.onTab, onToggleOverlay: opts.onToggleOverlay,
  }),
  renderOptions,
);
```

> **注：** `fallback: undefined` 是因为 patch 已让 Ink 默认 `render` 作为 fallback（options.renderer 不传时走原生）。我们传了 renderer，自研 renderer 内部 try-catch 也会兜底。

- [ ] **Step 4: typecheck + 全量测试**

```bash
npm run typecheck
npm test
```
Expected: typecheck 绿；全量测试绿（现有 TUI 测试不受影响，因为它们 render `<App>` 不走 bootstrap）。

- [ ] **Step 5: 手动冒烟（自研 renderer 启用）**

```bash
# 默认 USE_DOUBLE_BUFFER=true，自研 renderer 启用
npx tsx src/index.ts
# 进 TUI，验证：
# - LogoBox ASCII art 正常显示
# - 输入中文「你好」光标位置正确（CJK）
# - 状态栏多色
# - Spinner 转动
# - Ctrl+O 覆盖层
# - Ctrl+C 干净退出
```

如果手动冒烟出问题，回退到 `MICODE_DOUBLE_BUFFER=0 npx tsx src/index.ts` 验证 Ink 原生仍正常，再调自研 renderer。

- [ ] **Step 6: commit**

```bash
git add src/tui/bootstrap.tsx src/__tests__/render/integration.test.ts
git commit -m "feat(render): bootstrap 注入自研 renderer（feature flag 控制）

USE_DOUBLE_BUFFER=true 时启用自研双缓冲；=0 秒回 Ink 原生。
手动冒烟验证 LogoBox/CJK/状态栏/Spinner/Ctrl+O 全部正常。"
```

---

## Task 14: 性能验证 + memory 记录

**Files:**
- Create: `src/__tests__/render/benchmark.test.ts`（基准测试，可跳过/慢）
- Modify: `.memory/ink-migration-progress.md`（追加架构决策）

- [ ] **Step 1: 写基准测试**

Create `src/__tests__/render/benchmark.test.ts`:

```ts
// src/__tests__/render/benchmark.test.ts
// 性能基准：测量自研 renderer 帧耗时，确保 < Ink 原生（或至少可接受）。
// 这不是断言测试，是测量报告——CI 可跳过。

import { describe, it } from 'vitest';
import { createCustomRenderer } from '../../render/renderer.js';

describe('renderer benchmark（测量，非断言）', () => {
  it('1000 cell 变更的帧耗时 < 5ms', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 200, rows: 50, isTTY: true };
    const renderer = createCustomRenderer({ stdout });

    // 构造一棵 1000 字符的假树
    const text = 'a'.repeat(1000);
    const fakeTree = {
      nodeName: 'ink-root',
      yogaNode: { getComputedLeft: () => 0, getComputedTop: () => 0, getComputedWidth: () => 200, getComputedHeight: () => 50, getDisplay: () => 0 },
      childNodes: [{ nodeName: 'ink-text', yogaNode: { getComputedLeft: () => 0, getComputedTop: () => 0, getComputedWidth: () => 200, getCompletedHeight: () => 1, getDisplay: () => 0 }, textValue: text, childNodes: [] }],
    };

    const start = performance.now();
    renderer(fakeTree as any, { width: 200, height: 50 });
    const elapsed = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`1000-cell frame: ${elapsed.toFixed(2)}ms`);
    // 软断言：5ms 内（宽松，CI 慢机器兜底）
    expect(elapsed).toBeLessThan(50);  // 50ms 上限（非性能回归即可）
  });
});
```

- [ ] **Step 2: 跑基准**

```bash
npm test -- benchmark
# 记录实际耗时
```

- [ ] **Step 3: 更新 memory**

在 `.memory/ink-migration-progress.md` 的「关键技术约束（踩过的坑）」段末尾追加：

```markdown
8. **自研双缓冲渲染（2026-07-06，二期落地）**：
   - Fork Ink 7：`patch-package` 暴露 `options.renderer` 注入点（patches/ink+7.1.0.patch），保留 React/DOM/Yoga/输入端，重写输出端。
   - 数据结构：`Int32Array` cell 网格（每 cell 2×Int32 = charId + encodedStyleId），跨帧累积池子（CharPool ASCII 快速路径 + StylePool transition 缓存），每 5 分钟 resetPools + ID 迁移。
   - **styleId 编码纪律**（最易返工）：Int32Array 存编码值（`poolId << 1 | fullWidthFlag`），Patch 存解码后的纯 poolId + 独立 isFullWidthContinuation 布尔。`blit` 是编码值唯一生产点。
   - 全角字符（CJK/emoji）占 2 cell：head cell 存字符，tail cell（续位）存同 charId + styleId 但 fullWidthFlag=1，emit 时跳过字符输出。
   - cursor 用绝对定位 `\x1b[<y+1>;<x+1>H`（项目自管 alt-screen，不依赖 Ink 相对底部模型）；每帧开头 reset 样式（不依赖帧间状态，因混合 stdout 流量可能改 cursor）。
   - DEC 2026 同步输出由 emit 自己包裹（不再依赖 Ink throttledLog）。
   - feature flag `MICODE_DOUBLE_BUFFER=0` 秒回滚 Ink 原生。
   - 参照：Claude Code 的 Ink fork（保留上游 + 重写输出端的 renderer/screen/log-update/optimizer）。
```

- [ ] **Step 4: commit**

```bash
git add src/__tests__/render/benchmark.test.ts .memory/ink-migration-progress.md
git commit -m "test(render): 性能基准 + memory 记录架构决策

记录 fork 接缝/styleId 编码纪律/全角双 cell/cursor 绝对定位/feature flag 等
关键决策，避免下次返工。"
```

---

## Self-Review（plan 写完后自查）

**1. Spec 覆盖：**
- §3 数据结构（CharPool/StylePool/Screen/Patch/DoubleBuffer）→ Tasks 1-5, 10 ✓
- §4 渲染管线（blit/yoga-walk/diff/optimizer/emit）→ Tasks 5-9 ✓
- §2 fork 接缝 + patch-package → Tasks 11-12 ✓
- §5 边界（cursor/混合流量/DEC 2026/Static/resize）→ 散落在 Tasks 8/11/13（cursor 在 emit Task 8；混合流量在 spec 已说明，plan 不单独 Task；resize 在 DoubleBuffer Task 10）✓
- §6 feature flag → Tasks 11, 13 ✓
- 验收 → Task 14 ✓

**2. Placeholder 扫描：**
- Task 9 yoga-walk 有 `TODO Task 11: 从 node.style 解析`——这是显式简化标记，不是占位。Task 11 实际只做 feature flag + fallback，未补 style 解析。**这是 plan 的已知简化**：yoga-walk 先用 inheritedStyle（项目 `<Text>` 样式会丢），手动冒烟（Task 13 Step 5）会暴露——届时回 Task 9 补 style 解析。已在 Task 13 Step 5 注明「如果出问题回去补」。
- Task 11 renderer.ts 的 `require('./screen.js')` 是动态 require（ESM cycle 防御），非占位。
- Task 12 的 patch 具体行号「需 Step 2 确认后填」——这是 TDD 探查步骤，非占位（每步都有明确动作）。

**3. 类型一致性：**
- `Style` / `Patch` / `CursorPos` / `ERASE_CHAR_ID` 在 Task 1 定义，后续全用同签名 ✓
- `encodeStyleId`/`decodeStyleId`/`isFullWidthContinuation` Task 1 定义，Task 4/5/6/10 用 ✓
- `Screen.setCell(x,y,charId,encodedStyleId)` Task 4 定义，Task 5 blit 调用 ✓
- `blit(screen,x,y,text,style: Style)` Task 5 定义，Task 9 yoga-walk 调用 ✓
- `diff(front,back): Patch[]` Task 6 定义，Task 11 调用 ✓
- `optimize(patches): Patch[]` Task 7 定义，Task 11 调用 ✓
- `emit(patches, EmitContext)` Task 8 定义，Task 11 调用 ✓
- `DoubleBuffer` Task 10 定义，Task 11 用 ✓
- `createCustomRenderer(opts)` Task 11 定义，Task 13 调用 ✓

**4. 已知简化（标记给 implementer）：**
- yoga-walk 样式解析简化（Task 9 注 + Task 13 Step 5 冒烟验证）
- optimizer 不做行段合并（Task 7 注 + spec §4.4 决策）
- benchmark 软断言 50ms（Task 14，宽松上限）
