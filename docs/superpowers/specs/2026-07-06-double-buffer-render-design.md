# 自研双缓冲渲染管线 Design Spec

> **对标**：Claude Code 的 Ink fork（保留 React/DOM/Yoga + 输入端，重写输出端为 Int32Array cell 网格 + cell-level diff + Patch 优化器）。
> **charter 出处**：`AGENTS.md:70-73`（二期可选优化）、`AGENTS.md:136-139`。
> **承接**：feat/ink-rewrite 已并入 master（commit `3b33110`），Ink 7 内部架构已完整探查。

---

## 1. 目标与非目标

### 目标
1. **Int32Array cell 网格**：替代 Ink 7 的 `{value, styles}[][]` 对象网格，每 cell 8 字节（2×Int32），diff 时纯整数比较。
2. **cell-level diff**：替代 Ink 的行级 `log-update`，逐格对比前后帧，仅输出变更 cell。
3. **Patch 优化器**：合并相邻变更、消除冗余 cursor 跳转、预计算 style transition 的 ANSI 串。
4. **保留 Ink 上游**：React reconciler、DOM、Yoga、Box/Text/Static、`useInput`/`useCursor`/`useFocus`/raw mode/kitty/bracketed paste 全部不动。
5. **可回滚**：feature flag 切换，出问题秒回 Ink 原生渲染。

### 非目标
- ❌ 不改 React 组件树、不改业务组件（`Footer`/`ScrollBox`/`App` 等）。
- ❌ 不重写输入端（`useInput`/`useCursor`/`useFocus` 等保持 Ink 原生）。
- ❌ 不改 charter 铁律（Alt Screen + React+Ink+Yoga 布局）。
- ❌ 不优化业务层（finalize 丢 Markdown、全列表重渲染等已知 bug 另行处理）。
- ❌ 不做 `<Static>` 高优先级支持（项目未用，保留 Ink 路径占位）。

---

## 2. Fork 接缝（基于探查锁死）

### 保留（Ink 上游，零改动）
| Ink 文件 | 职责 |
|---|---|
| `reconciler.js` | React reconciler host config（`resetAfterCommit` 触发 Yoga 布局）|
| `dom.js` | DOM 节点创建/挂载/样式 |
| `styles.js` | CSS-like 样式 → Yoga 调用 |
| `measure-text.js` / `wrap-text.js` | 文本测量/折行 |
| `components/*` | Box/Text/Static/App/contexts |
| `hooks/*` | useInput/useCursor/useFocus/useStdout/useApp |
| `ink.js` 输入/alt-screen/raw mode 部分 | kitty/bracketed paste/signal-exit |

### 替换（自研下游）
| Ink 原文件 | 行数 | 自研替代 | 职责 |
|---|---|---|---|
| `renderer.js` | 53 | `src/render/renderer.ts` | Yoga 树 → cell 网格（不再 flatten 成字符串）|
| `output.js` | 206 | `src/render/screen.ts` | `Int32Array` 二维 cell 网格 + char/style 池 |
| —（无）| — | `src/render/output-ops.ts` | 操作收集器：write/blit/clip/clear |
| `log-update.js` | 245 | `src/render/log-update.ts` | cell-level diff + Patch 生成 |
| `cursor-helpers.js` | 55 | （并入 log-update）| 绝对坐标 cursor 定位 |
| —（无）| — | `src/render/optimizer.ts` | Patch 优化器 |

### 接缝契约（关键决策）
自研 `renderer.ts` **内部完成 Yoga→网格→diff→写 stdout 的全流程**，但仍返回 `{ output: string, outputHeight: number, staticOutput: string }` 占位（`output` 为空串或最后一帧的字符串快照）。

**理由**：这样 `ink.js` 的 `onRender`（`ink.js:348`）/`renderInteractiveFrame`（`ink.js:748-798`）几乎不动——它们仍消费 `{output, outputHeight, staticOutput}`，只是 `output` 不再被写入 stdout（自研 renderer 已经直接写了）。改动面最小，回滚最容易（feature flag 切回 Ink 原生 renderer，`output` 立刻变回真字符串）。

### Fork 落地：`patch-package`
- fork 改动集中在 `renderer.js`（被自研 import 替换）+ `ink.js`（让 `renderer` 可注入）。
- 用 `patches/ink+7.1.0.patch` 落地，`patch-package` postinstall 自动应用。
- patch 内容全加性（新增 `options.renderer` 注入点），不改 Ink 默认行为。

---

## 3. 数据结构（spec 的承重部分）

### 3.1 Cell 编码：每 cell 2×Int32 = 8 字节

```ts
// Int32Array 长度 = rows * cols * 2
// 索引 i 的 cell：
//   chars[i*2]     = charId  （charPool 索引，>= 0；0 = 空格占位）
//   chars[i*2 + 1] = styleId （stylePool 索引，>= 0；0 = 默认样式）
```

**为什么不直接编码进 32 位**：CJK 全角占 2 cell、emoji 代理对、样式组合爆炸（fg×bg×bold×italic×...）。用池子索引让 `Int32Array` 紧凑，diff 时只比 `int32` 相等性（`a[i] === b[i]`），极快。

### 3.2 CharPool（字符池）

```ts
class CharPool {
  // 存储：charId → 字符串（可能是单字符 "a"、CJK "你"、emoji "👋"、空格 " "）
  private chars: string[] = [''];  // index 0 = 空白占位
  // 去重：字符串 → charId
  private byChar: Map<string, number> = new Map();
  // ASCII 快速路径：charCode < 128 直接数组查
  private asciiTable: number[] = new Array(128).fill(-1);

  intern(s: string): number {
    // ASCII 快速路径
    if (s.length === 1) {
      const code = s.charCodeAt(0);
      if (code < 128) {
        if (this.asciiTable[code] >= 0) return this.asciiTable[code]!;
        const id = this.chars.length;
        this.chars.push(s);
        this.asciiTable[code] = id;
        return id;
      }
    }
    // Map 去重
    let id = this.byChar.get(s);
    if (id === undefined) {
      id = this.chars.length;
      this.chars.push(s);
      this.byChar.set(s, id);
    }
    return id;
  }

  get(id: number): string { return this.chars[id] ?? ' '; }
}
```

**存储约定**：
- 全角字符（CJK/emoji）以**完整字符串**存进池子，但在 `Int32Array` 中占**连续 2 个 cell**（charId 相同，styleId 相同），第二个 cell 标记为「全角续位」（用 styleId 的 bit 0 标记，见 3.4）。
- 这样 diff 时仍只比 int32，全角字符的 2 cell 自然一起变更或一起不变。

### 3.3 StylePool（样式池）

```ts
interface Style {
  fg: number;       // RGB 打包成 24 位（0xFFFFFF），0 = 默认
  bg: number;       // 同上
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
  strikethrough: boolean;
}

class StylePool {
  private styles: Style[] = [DEFAULT_STYLE];  // index 0 = 默认
  private byKey: Map<string, number> = new Map();
  // transition 缓存：预计算「样式 A → 样式 B」的 ANSI 串
  private transitions: Map<number, string> = new Map();  // key = fromId * N + toId

  intern(s: Style): number {
    const key = styleKey(s);  // 序列化为字符串键
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push(s);
      this.byKey.set(key, id);
    }
    return id;
  }

  get(id: number): Style { return this.styles[id] ?? DEFAULT_STYLE; }

  /** 计算从 fromStyle 到 toStyle 的 ANSI 串（带缓存） */
  transition(fromId: number, toId: number): string {
    if (fromId === toId) return '';  // 无变化
    const key = fromId * this.styles.length + toId;
    let seq = this.transitions.get(key);
    if (seq === undefined) {
      seq = computeAnsiTransition(this.get(fromId), this.get(toId));
      this.transitions.set(key, seq);
    }
    return seq;
  }
}
```

### 3.4 styleId 的 bit 0 约定

```
styleId 的实际值 = stylePool.intern(style) << 1 | fullWidthFlag
```
- `fullWidthFlag = 1`：此 cell 是全角字符的**续位**（第二个 cell），渲染时跳过（不输出字符，但占用一格）。
- `fullWidthFlag = 0`：正常 cell。
- 解码：`styleId >> 1` 取真实 stylePool id，`styleId & 1` 取全角标记。
- 这样 `Int32Array` 的 `styleId` 字段同时承载「样式」+「全角续位」两个信息，diff 时单 int32 比较即可。

### 3.5 Screen（双缓冲）

```ts
class Screen {
  readonly rows: number;
  readonly cols: number;
  readonly chars: Int32Array;  // 长度 rows*cols*2
  readonly charPool: CharPool;
  readonly stylePool: StylePool;

  constructor(rows: number, cols: number, charPool: CharPool, stylePool: StylePool) {
    this.rows = rows;
    this.cols = cols;
    this.chars = new Int32Array(rows * cols * 2);  // 初始全 0 = 全空白 + 默认样式
    this.charPool = charPool;
    this.stylePool = stylePool;
  }

  /** 取 cell 的 {charId, encodedStyleId}（encodedStyleId 含 bit 0 全角标记） */
  cellAt(x: number, y: number): { charId: number; encodedStyleId: number } {
    const i = (y * this.cols + x) * 2;
    return { charId: this.chars[i], encodedStyleId: this.chars[i + 1] };
  }
}
```

**写入逻辑不在 `Screen` 上**——`Screen` 只持有数据 + 池子。写入由 `output-ops.blit` 完成（§4.2），它接收 **`Style` 对象**（非 poolId、非编码值），内部完成 `intern` + 编码 + 全角续位处理。这是编码值的**唯一生产点**，见 §3.6 末尾「铁律 4」。

### 3.6 styleId 编码纪律（贯穿全管线，必读）

**这是 spec 最易出错的点**，单独立节。`styleId` 在不同阶段语义不同：

| 阶段 | 字段 | 语义 | 取值 |
|---|---|---|---|
| `Int32Array` 存储 | `chars[i*2+1]` | **编码 styleId** | `poolId << 1 \| fullWidthFlag` |
| diff 读取 | `back.chars[i+1]` | 编码 styleId | 同上 |
| diff 输出 Patch | `patch.styleId` | **解码后的纯 poolId** | `chars[i+1] >> 1`（丢 bit 0）|
| Patch 全角标记 | `patch.isFullWidthContinuation` | **解码后的标记** | `(chars[i+1] & 1) === 1` |
| optimizer / emit | `patch.styleId` | 纯 poolId | 直接喂 `stylePool.transition` |

**铁律**：
1. `Int32Array` 里**永远存编码 styleId**（poolId << 1 | fullWidthFlag）。
2. `Patch` 里**永远存解码后的纯 poolId**（diff 时 `>> 1`）+ 独立的 `isFullWidthContinuation` 布尔。
3. `emit` / `optimizer` 只接触 `Patch`，永远不直接读 `Int32Array` 的 styleId 字段——若要读，先解码。
4. **编码值的唯一生产点是 `output-ops.blit`**（§4.2）。`blit` 接收 `Style` 对象（非 poolId），内部 `intern(style)` 得纯 poolId，再根据字符宽度计算 fullWidthFlag，最终 `<< 1 | flag` 写入 `Int32Array`。`Screen` 不暴露任何「写编码值」的公共方法——所有写入必须经 `blit`，保证编码一致。

这样 diff 后的全角续位 cell 直接 `patch.isFullWidthContinuation === true → skip`，不需要再 `& 1` 判断，代码更清晰。

### 3.7 Patch 类型（统一定义）

```ts
/** 特殊 charId：表示「此 cell 应擦除（写空格+默认样式）」，optimizer 用 */
export const ERASE_CHAR_ID = -1;

interface Patch {
  x: number;          // cell 列（0-based）
  y: number;          // cell 行（0-based）
  charId: number;     // charPool 索引（纯 poolId，非编码）；或 ERASE_CHAR_ID
  styleId: number;    // stylePool 索引（纯 poolId，非编码）
  isFullWidthContinuation: boolean;  // 全角字符的续位 cell，emit 时跳过字符输出
}
```

`emit` 见 `charId === ERASE_CHAR_ID` 时发 `\x1b[K`（eraseEndLine）或跳过（依赖前patch的 erase 兜底）。

### 3.8 DoubleBuffer（前后帧）

```ts
class DoubleBuffer {
  front: Screen;   // 上一帧（已写入终端）
  back: Screen;    // 当前帧（Yoga 正在写入）
  charPool: CharPool;
  stylePool: StylePool;
  private lastPoolResetTime: number = Date.now();
  private static readonly POOL_RESET_INTERVAL = 5 * 60 * 1000;  // 5 分钟

  swap(): void {
    // 1. 检查池子是否需要重置
    const now = Date.now();
    if (now - this.lastPoolResetTime > DoubleBuffer.POOL_RESET_INTERVAL) {
      this.resetPools();
      this.lastPoolResetTime = now;
    }
    // 2. 交换前后帧（back 内容拷到 front，back 清零待下一帧）
    this.front.chars.set(this.back.chars);
    this.back.chars.fill(0);
  }

  /** 池子重置：创建新池，把 front/back 的 id 迁移过去 */
  private resetPools(): void {
    const newCharPool = new CharPool();
    const newStylePool = new StylePool();
    migrateScreenPools(this.front, newCharPool, newStylePool);
    migrateScreenPools(this.back, newCharPool, newStylePool);
    this.charPool = newCharPool;
    this.stylePool = newStylePool;
    this.front.charPool = newCharPool;
    this.front.stylePool = newStylePool;
    this.back.charPool = newCharPool;
    this.back.stylePool = newStylePool;
  }
}
```

**池子生命周期（对标 Claude Code）**：
- 跨帧累积 + Map 去重，同字符/同样式只存一次。
- ASCII 快速路径（charCode < 128 直接数组查）。
- **每 5 分钟重置一次**：创建新池，迁移 front/back 的 id（防止内存无限增长）。
- `migrateScreenPools`：遍历 `Int32Array`，用 `newCharPool.intern(oldCharPool.get(charId))` 重建映射，写回 `Int32Array`。

---

## 4. 渲染管线（端到端）

### 4.1 流程

```
React state change
  → React reconciler commit
  → resetAfterCommit(rootNode)
  → rootNode.onComputeLayout()  [Ink: Yoga 算布局]
  → rootNode.onRender()         [Ink: 节流到 30 FPS]
  → 自研 renderer(rootNode)     [fork 接缝]
      ├─ renderNodeToOutput(rootNode, backBuffer.back)  [遍历 Yoga 树写 cell]
      ├─ diff(front, back) → Patch[]                    [cell-level diff]
      ├─ optimize(Patch[]) → Patch[]                    [合并/去冗余]
      ├─ emit(Patch[], stdout)                          [ANSI 写终端，DEC 2026 包裹]
      ├─ doubleBuffer.swap()                            [back → front，清 back]
      └─ cursor 定位（绝对 \x1b[<y+1>;<x+1>H）
  → return { output: '', outputHeight, staticOutput }   [占位返回，ink.js 几乎不动]
```

### 4.2 renderNodeToOutput（复用 Ink 的 Yoga 遍历逻辑）

Ink 的 `render-node-to-output.js:71-145` 已经实现了「遍历 Yoga 树 + 按 `getComputedLeft/Top` 放置文本 + 处理裁剪/transformer」。fork 后我们**借鉴其遍历结构**，但写入目标是 `back: Screen`（Int32Array）而非 Ink 的 `Output`（对象网格）。

具体：自研 `output-ops.ts` 提供 `blit(screen, x, y, text, style: Style)`（`style` 是 **`Style` 对象**，非 poolId——见 §3.6 铁律 4，`blit` 是编码值的唯一生产点）。`renderNodeToOutput` 遍历 Yoga 树，对每个文本节点调 `blit` 写入 `back: Screen`。全角字符宽度由 `string-width` 确认（Yoga 的 `getComputedWidth` 给容器宽度，字符级宽度以 `string-width` 为准）。

`blit` 内部流程：
```ts
function blit(screen: Screen, x: number, y: number, text: string, style: Style): void {
  const styleId = screen.stylePool.intern(style);  // 纯 poolId
  let cx = x;
  for (const ch of text) {  // 按 code point 遍历（[...text] 等价）
    if (cx >= screen.cols) break;  // 行末裁剪
    const w = stringWidth(ch);
    if (cx + w > screen.cols) break;  // 全角字符跨右边界，整字裁掉
    const charId = screen.charPool.intern(ch);
    const i = (y * screen.cols + cx) * 2;
    screen.chars[i] = charId;
    screen.chars[i + 1] = (styleId << 1) | (w === 2 ? 1 : 0);  // 编码：poolId<<1 | fullWidthFlag
    if (w === 2 && cx + 1 < screen.cols) {
      // 全角续位 cell：同 charId + styleId，但 fullWidthFlag=1
      const i2 = (y * screen.cols + cx + 1) * 2;
      screen.chars[i2] = charId;
      screen.chars[i2 + 1] = (styleId << 1) | 1;
    }
    cx += w;
  }
}
```

### 4.3 Diff 算法

```ts
function diff(front: Screen, back: Screen): Patch[] {
  const patches: Patch[] = [];
  const len = front.chars.length;  // = back.chars.length（同尺寸）
  for (let i = 0; i < len; i += 2) {
    if (front.chars[i] !== back.chars[i] || front.chars[i + 1] !== back.chars[i + 1]) {
      const cellIndex = i / 2;
      const y = Math.floor(cellIndex / front.cols);
      const x = cellIndex % front.cols;
      // 解码 styleId（见 §3.6 纪律）
      const encodedStyle = back.chars[i + 1];
      const isFullWidthContinuation = (encodedStyle & 1) === 1;
      // 全角续位 cell 仍要进 Patch（diff 检测到了变化），但 emit 时跳过字符输出。
      // 不在这里 continue——否则全角字符变更的续位 cell 会丢失，导致 diff 漏报。
      patches.push({
        x, y,
        charId: back.chars[i],
        styleId: encodedStyle >> 1,  // 解码为纯 poolId
        isFullWidthContinuation,
      });
    }
  }
  return patches;
}
```

**复杂度**：O(rows×cols)，纯 int32 比较，200×120 屏幕约 24000 次比较，<1ms。

**注**：全角续位 cell 进 Patch 但 emit 时跳过字符输出（仍可能需要 cursor 跳过该位置）。optimizer 决定如何处理（通常与前一 cell 合并）。

### 4.4 Optimizer（Patch 优化）

**输出形状决策**：optimizer 输出仍是 `Patch[]`（每 patch = 单 cell），**不合并成行段**。行段合并（连续字符一次写出）由 `emit` 自己在遍历时通过 `prevX/prevY` 邻接判断完成（§4.5 已实现）。这样 `Patch` 类型保持简单（§3.7），optimizer 与 emit 职责清晰：optimizer 做「该不该输出」的裁剪，emit 做「怎么输出」的合并。

输入：raw `Patch[]`（diff 产出，每 patch = 单 cell 变更）。
输出：优化后的 `Patch[]`（仍是单 cell），目标减少不必要的 patch。

优化策略：
1. **去重全角续位**：全角字符的头 cell 已会写出完整字符（终端自动覆盖续位），续位 cell 即使因 diff 进入 Patch，也标记 `isFullWidthContinuation` 让 emit 跳过——optimizer 可在此前置过滤掉它们（减少 emit 循环次数）。
2. **空格 + 默认样式 → 改用 erase**：若 patch 是「写空格 + styleId === 0（默认）」，optimizer 把它转成特殊标记（如 `patch.charId = ERASE_CHAR_ID`），emit 见此标记发 `eraseEndLine` 或直接跳过（依赖前一 patch 的 `eraseEndLine` 兜底）。比写字符省字节。
3. **行内重排**（可选，低优先级）：同一行 patches 按 x 排序，让 emit 的邻接判断命中率最高。
4. **不做的**：不做跨 patch 字符合并（不引入 RowSegment 类型），不预算 style transition（那是 StylePool 的缓存职责）。

**注**：optimizer 是可选 pass——即使跳过 optimizer，emit 仍能正确输出（只是字节略多）。这是健壮性设计。

### 4.5 Emit（写终端）

```ts
interface EmitContext {
  charPool: CharPool;
  stylePool: StylePool;
  stdout: WriteStream;
  cursor?: CursorPos;  // 来自 useCursor 的 {x, y}（绝对坐标），无则隐藏
}

function emit(patches: Patch[], ctx: EmitContext): void {
  const { charPool, stylePool, stdout, cursor } = ctx;
  const out: string[] = [];
  out.push('\x1b[?2026h');  // BSU：开始同步输出
  out.push('\x1b[0m');      // 重置样式（每帧从默认开始，不依赖帧间状态）
  let curStyleId = 0;       // 终端当前 styleId（纯 poolId，见 §3.6）
  let prevX = -1, prevY = -1;  // 上一 patch 位置，用于 cursor 复用判断

  for (const patch of patches) {
    if (patch.isFullWidthContinuation) continue;  // 续位 cell 跳过字符输出
    // cursor 跳转：仅当非「紧接上一 patch 右侧」时发绝对定位（optimizer 已尽量合并，
    // 这里是兜底防御，因为 emit 不假设 optimizer 已跑）
    const adjacent = (patch.y === prevY && patch.x === prevX + 1);
    if (!adjacent) {
      out.push(`\x1b[${patch.y + 1};${patch.x + 1}H`);
    }
    // style transition
    const trans = stylePool.transition(curStyleId, patch.styleId);
    if (trans) { out.push(trans); curStyleId = patch.styleId; }
    // 字符
    out.push(charPool.get(patch.charId));
    prevX = patch.x; prevY = patch.y;
  }

  // cursor 定位（如果有，如输入框光标）
  if (cursor) {
    out.push(`\x1b[${cursor.y + 1};${cursor.x + 1}H`);
    out.push('\x1b[?25h');  // showCursor
  } else {
    out.push('\x1b[?25l');  // hideCursor（帧渲染期间隐藏）
  }
  out.push('\x1b[?2026l');  // ESU：结束同步输出
  stdout.write(out.join(''));
}
```

**注**：`cursor` 坐标来自 `Ink.setCursorPosition`（fork 后改写到 `EmitContext`），与 cell 网格同一坐标系（绝对，0-based）。

---

## 5. 边界问题处理

### 5.1 Cursor 契约（useCursor 不变）
- `Footer.tsx:36-40` 调 `useCursor().setCursorPosition({x, y})`，y 是**全局坐标**（项目自管 alt-screen，`useAltScreen.ts:33` 直接写 `\x1b[?1049h`）。
- fork 用**绝对坐标** `\x1b[<y+1>;<x+1>H`（1-origin），不依赖 Ink 的「相对底部」模型。
- 保留 `cursorDirty` 语义：`setCursorPosition` 后强制下一帧重发 cursor，即使 cell 无变化。

### 5.2 混合 stdout 流量（4 类绕过 renderer 的直写）
| 来源 | 内容 | 处理 |
|---|---|---|
| `useAltScreen.ts` | `\x1b[?1049h/l` + `\x1b[2J\x1b[H` | 继续直写，fork 不拦截 |
| `ScrollBox.tsx:91,93` | `\x1b[?1003h/l\x1b[?1006h/l`（鼠标追踪）| 继续直写 |
| Ink kitty 键盘 | `\x1b[?u` / `\x1b[<u` 等 | 继续直写（Ink 上游管）|
| Ink bracketed paste | `\x1b[?2004h/l` | 继续直写（Ink 上游管）|

**关键约束**：fork 的 cell-diff writer **不假设帧间 cursor 位置稳定**（因为上面这些直写可能改了 cursor）。所以每帧 emit 的第一个 patch 都发绝对定位 `cursorTo`，不依赖「上一帧留下的位置」。

### 5.3 DEC 2026 同步输出
- fork 的 `emit` 自己包裹 `\x1b[?2026h` ... `\x1b[?2026l`。
- 不再依赖 Ink 的 `throttledLog`（`ink.js:222-236`）做包裹——因为 fork 绕过了它。
- 4 类混合流量不包裹 2026（它们是一次性控制序列，不需要）。

### 5.4 `<Static>` 组件
- 项目当前未用 `<Static>`（grep `src/` 零命中）。
- fork 仍保留 Ink 的 static 子树渲染路径：自研 renderer 调 Ink 原生 static 渲染逻辑拿 `staticOutput` 字符串，原样返回占位。
- static 输出由 `ink.js:784-786` 直写 stdout（不进 cell 网格），最低优先级。

### 5.5 终端 resize
- `useTerminalSize.ts:33` 监听 `stdout.on('resize')` → setState → App 重渲染。
- fork 的 `DoubleBuffer` 监听同一事件 → 重建 `front`/`back` Screen（新 `rows`/`cols`）→ 全量重绘（首帧 emit 所有 cell，不 diff）。
- Ink 内部的 resize 监听（`ink.js:265,279-291`）继续工作，与 fork 不冲突（不同层）。

---

## 6. Feature Flag + 回滚

```ts
// src/render/index.ts
export const USE_DOUBLE_BUFFER = process.env.MICODE_DOUBLE_BUFFER !== '0';
// 默认开启；出问题设 MI_CODE_DOUBLE_BUFFER=0 回滚到 Ink 原生
```

- bootstrap 调 `render()` 时，若 flag 开则注入自研 renderer，否则用 Ink 原生。
- 自研 renderer 出异常时自动 fallback 到 Ink 原生（try-catch + 日志）。

---

## 7. 文件结构

```
src/render/                       # 自研渲染层（与 src/tui/ 平级）
├── index.ts                      # 入口：feature flag + renderer 注入
├── screen.ts                     # Screen + CharPool + StylePool + DoubleBuffer
├── output-ops.ts                 # blit/write/clip/clear 操作收集器
├── yoga-walk.ts                  # 遍历 Yoga 树 → 调 output-ops 写 back buffer
├── diff.ts                       # cell-level diff → Patch[]
├── optimizer.ts                  # Patch 优化器
├── emit.ts                       # Patch → ANSI 写终端（含 DEC 2026）
├── renderer.ts                   # fork 接缝：组合上述模块，返回占位 {output,...}
└── types.ts                      # Patch / CursorPos / Style 等类型

patches/
└── ink+7.1.0.patch               # patch-package：暴露 renderer 注入点

src/__tests__/render/             # 测试
├── char-pool.test.ts
├── style-pool.test.ts
├── screen.test.ts
├── diff.test.ts
├── optimizer.test.ts
├── emit.test.ts
└── integration.test.ts           # 端到端：假 Yoga 树 → 渲染 → 断言 ANSI 输出
```

---

## 8. Task 拆解预估（writing-plans 阶段细化）

| # | Task | 依赖 | 验证 |
|---|---|---|---|
| 1 | CharPool + 单测（intern/get/ASCII 快速路径/去重）| — | 单测全绿 |
| 2 | StylePool + 单测（intern/transition 缓存/bit 0 编码）| — | 单测全绿 |
| 3 | Screen（Int32Array 网格 + cellAt）| 1,2 | 单测：写入/读取/越界 |
| 4 | output-ops（blit/write/clip/clear，含全角续位）| 3 | 单测：CJK/emoji/裁剪 |
| 5 | yoga-walk（借鉴 Ink render-node-to-output 遍历）| 4 | 单测：假 Yoga 树 → 网格 |
| 6 | diff（cell-level Patch 生成）| 3 | 单测：变更检测/全角跳过 |
| 7 | optimizer（行分组/style 复用/cursor 最小化）| 6 | 单测：patch 合并 |
| 8 | emit（ANSI + DEC 2026 + 绝对 cursor）| 7 | 单测：ANSI 字符串断言 |
| 9 | DoubleBuffer + 池子重置（5 分钟 + ID 迁移）| 3,1,2 | 单测：swap/resetPools |
| 10 | renderer（组合 + feature flag + fallback）| 5-9 | 集成测试 |
| 11 | patch-package 落地（ink+7.1.0.patch）| 10 | postinstall 应用 + typecheck |
| 12 | bootstrap 注入 + 端到端集成 | 11 | 手动冒烟：CJK/spinner/Ctrl+O/resize |
| 13 | 性能验证（帧耗时/内存/与 Ink 原生对比）| 12 | 基准测试 |
| 14 | memory 记录（架构决策 + 踩坑）| 13 | 文档更新 |

---

## 9. 风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| fork patch 与 ink 升级冲突 | 中 | patch-package 锁版本；CI 检测 patch 失败 |
| cell-diff 在混合流量后状态错乱 | 中 | 每帧首 patch 绝对定位；集成测试覆盖 alt-screen/mouse 场景 |
| 全角字符 width 计算与 Yoga 不一致 | 中 | 用 `string-width` 双重确认；CJK 回归测试 |
| 池子重置 ID 迁移 bug（cell 闪现错字）| 低 | 单测覆盖迁移；5 分钟阈值保守 |
| 性能不升反降（diff 开销 > Ink 行级）| 低 | Task 13 基准验证；feature flag 可回滚 |
| cursor 定位错误（输入框光标乱跳）| 中 | 保留 `cursorDirty` 语义；集成测试覆盖 Footer |

---

## 10. 验收标准

1. `MICODE_DOUBLE_BUFFER=1`（默认）：CJK 输入光标正确、状态栏多色、Spinner 流畅、Ctrl+O 覆盖层、多行输入、resize 重绘——全部正常。
2. `MICODE_DOUBLE_BUFFER=0`：秒回滚到 Ink 原生渲染，行为与当前 master 一致。
3. 全部单测 + 集成测试绿；typecheck/build 通过。
4. 性能：流式输出 1000 token 时，帧渲染耗时 < Ink 原生模式（Task 13 基准）。
5. memory 记录架构决策（fork 接缝/池子生命周期/cursor 契约/混合流量）。

---

## 11. 参考资料

- Ink 7 内部架构（探查报告）：`renderer.js`、`output.js`、`log-update.js`、`cursor-helpers.js`、`write-synchronized.js`、`render-node-to-output.js`
- charter：`AGENTS.md:50-73`（Mi-Code TUI 渲染架构）、`AGENTS.md:136-139`（二期双缓冲）
- Claude Code 实现（用户提供的源码参照）：跨帧累积池子 + 5 分钟重置 + ID 迁移 + transition 缓存
- 历史回归：CJK 光标修复（`cursorScreenPos`，commit `0d206fb`）——本 spec 的 cell 编码沿用同样 string-width 哲学
