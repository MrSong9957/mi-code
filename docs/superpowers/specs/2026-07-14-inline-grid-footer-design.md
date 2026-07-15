# Inline Grid Footer 渲染设计

> **状态**：设计已确认，待写实施计划
> **日期**：2026-07-14
> **前置**：Render Pipeline Phase 0-3（6388a1d），架构审计（c211754）

## 1. 问题

inline 模式 resize 时 footer 堆叠，7 次应用层补丁全部失败。

**根因**：inline 模式用"stdout 只追加流 + 应用侧行数账本（footerHeight）"管理 footer。
这个账本的不变量（`footerHeight = 终端物理行数`）被终端的 reflow-on-resize 单方面破坏。
所有基于 footerHeight 的 cursor 算术（cursorUp + overwriteLine）在 reflow 后失效。

## 2. 解决思路

**用绝对坐标定位替换相对光标算术。**

当前 footer 渲染用"相对定位"：
```
cursorUp(cursorToTop) → 逐行 overwriteLine
```
这依赖"光标当前在 footer 输入框行"的假设。reflow 改变行布局后，假设失效。

改为"绝对定位"：
```
\x1b[row;colH（每个 cell 都带屏幕绝对坐标）→ 写字符
```
不依赖光标当前在哪。reflow 后重画一遍就对了。

已有的 `src/render/` 双缓冲（Screen/DoubleBuffer/diff/emit）天然用绝对坐标定位，
直接复用，只写一个新的 walk 喂布局数据。

## 3. 决策汇总（brainstorming 共识）

| 决策点 | 选择 | 理由 |
|---|---|---|
| grid 管理范围 | 整个可见区域 | resize 时整个可见区域被 reflow 弄乱 |
| 静态行策略 | 写后移除 | logo/消息进 scrollback 不归应用管；写进 grid emit 后从 grid 移除 |
| resize 擦除 | CUP 绝对定位 + ED | 清到屏幕底，不依赖旧行数 |
| resize 重画 | grid diff emit（绝对坐标） | 不依赖光标位置，reflow 后重画即正确 |
| 渲染核心 | 复用 src/render/ | Screen/DoubleBuffer/diff/optimize/emit 已成熟，与 Ink 解耦 |
| 改造范围 | 只改 footer 渲染路径 | 静态行（logo/消息）继续走 appendLine，已稳定不动 |

## 4. 架构

### 4.1 组件图

```
InlineApp
  │
  ├─ logo/消息 → InlineRenderer.appendLine（不变，直写 stdout 进 scrollback）
  │
  └─ footer layout → InlineGridRenderer.commitFooter(layout)
                          │
                          ├─ blit footer lines → DoubleBuffer.back（局部坐标 0-based）
                          ├─ diff(front, back) → Patch[]（局部坐标）
                          ├─ optimize(patches) → Patch[]（排序+ERASE 标记）
                          └─ emit(optimized, { yBias: footerTopRow-1 })
                                  │
                                  └─ \x1b[(patch.y + yBias + 1);(patch.x + 1)H + 字符
                                     （绝对坐标定位，不依赖光标位置）
```

### 4.2 新建组件

#### `InlineGridRenderer`（`src/tui/inline/grid-renderer.ts`）

持有 footer 区域的 DoubleBuffer，提供 commitFooter 接口。

**footerTopRow 不作为实例字段**——每次 commitFooter 实时用公式算，避免状态过期。
只缓存上一次的 height/cols/footerTopRow，供 clearRegion 清旧区域用。

```ts
class InlineGridRenderer {
  private db: DoubleBuffer | null = null;
  // 缓存上一次的尺寸（供 clearRegion 清旧区域，不是"当前 footer 位置"）
  private lastHeight = 0;
  private lastCols = 0;
  private lastFooterTopRow = 0;  // 上一次 footer 顶的绝对行号（1-based）

  constructor(private stdout: NodeJS.WriteStream) {}

  /** 清除屏幕上指定区域：CUP(topRow,1) + ED（从 topRow 清到屏幕底） */
  private clearRegion(topRow: number): void {
    this.stdout.write(`\x1b[${topRow};1H\x1b[0J`);
  }

  /** 写入 footer（核心接口） */
  commitFooter(layout: FooterLayout, rows: number, cols: number): void {
    const newHeight = layout.lines.length;
    const footerTopRow = rows - newHeight + 1;  // 实时算，不依赖实例字段

    // 高度或宽度变化 → 先清旧区域（用缓存的 last 值）
    if (this.db && (this.lastHeight !== newHeight || this.lastCols !== cols)) {
      this.clearRegion(this.lastFooterTopRow);
    }
    // 重建 DoubleBuffer（尺寸变化或首次）
    if (!this.db || this.lastHeight !== newHeight || this.lastCols !== cols) {
      this.db = new DoubleBuffer(newHeight, cols);
    }

    // back.clear() → blitAnsi 写入每行 footer 内容
    this.db.back.clear();
    for (let y = 0; y < layout.lines.length; y++) {
      blitAnsi(this.db.back, 0, y, layout.lines[y]);
    }

    // diff → optimize → emit（yBias = footerTopRow - 1）
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool, stylePool: this.db.stylePool,
      stdout: this.stdout, yBias: footerTopRow - 1,
      cursor: { x: layout.cursorCol, y: layout.cursorToTop },
    });

    this.db.swap();
    this.lastHeight = newHeight;
    this.lastCols = cols;
    this.lastFooterTopRow = footerTopRow;
  }

  /** resize 时彻底擦除旧 footer + 丢弃 buffer */
  clearForResize(): void {
    if (this.lastFooterTopRow > 0) {
      this.clearRegion(this.lastFooterTopRow);
    }
    this.db = null;
    this.lastHeight = 0;
    this.lastFooterTopRow = 0;
  }

  /** unmount 时清除 footer（替代原 InlineRenderer.commitFooter 的生命周期清理） */
  dispose(): void {
    this.clearForResize();
  }
}
```

**DoubleBuffer 宽度 = cols 契约**：DoubleBuffer 尺寸为 `height × cols`。
blitAnsi 写入的行短于 cols 时（如输入框只有 20 字符），back buffer 右侧保持初始状态
（char=0 空白，style=默认）。diff 自动产出清除 Patch（ERASE_CHAR_ID → `\x1b[K`）。
layout 保证 border 行正好 cols 宽；输入行/suggestion 行可能短于 cols，由 diff 处理。

### 4.3 修改组件

#### `emit.ts` — 增加 yBias 支持

```ts
export interface EmitContext {
  charPool: CharPool;
  stylePool: StylePool;
  stdout: { write: (s: string) => boolean };
  cursor?: CursorPos;
  yBias?: number;  // ← 新增：y 轴偏移（alt-screen=0，inline=footerTopRow-1）
}
```

emit 内**所有** `\x1b[row;colH` 定位都需要加 yBias，包括：
1. Patch 定位（每个 cell 写入前）：`\x1b[(patch.y + yBias + 1);(patch.x + 1)H`
2. 末尾光标定位：`\x1b[(cursor.y + yBias + 1);(cursor.x + 1)H`

alt-screen 模式不传 yBias（默认 0），行为不变。inline 模式传 `footerTopRow - 1`。

### 4.4 不变的部分

- `Screen` / `DoubleBuffer` / `diff` / `optimize` — 零改动（纯局部坐标计算）
- `blitAnsi` / `blit` / `output-ops.ts` — 零改动（接收局部坐标）
- `layout.ts` 的 `layoutFooter` — 零改动（纯函数，输出 FooterLayout）
- `InlineRenderer.appendLine` — 零改动（静态行直写 stdout）
- logo / 消息 / 键盘 / 鼠标 / 粘贴 — 不走渲染路径，不受影响

## 5. resize 处理

### 5.1 标准公式

```
footerTopRow = rows - footerHeight + 1
```

inline 模式启动后 logo + hook 迅速填满第一屏，footer 总在屏幕底部 footerHeight 行。
此公式为标准行为。

### 5.2 resize 时序

```
1. 检测 cols 变化（InlineApp effect 的 prevColsRef）
2. gridRenderer.clearForResize():
   a. CUP(footerTopRow, 1)        ← 绝对定位到 footer 顶
   b. ED (\x1b[0J)                 ← 清到屏幕底（旧 footer + reflow 碎片全清）
   c. 丢弃 DoubleBuffer            ← front/back 全失效
   d. footerHeight = 0
3. commit 下一帧（cols 变化触发 effect 重跑）:
   a. layoutFooter(新 cols) → 新 FooterLayout
   b. gridRenderer.commitFooter(layout):
      - 新建 DoubleBuffer（footerHeight × 新 cols）
      - back.clear() → blitAnsi 写入 footer lines
      - diff(全0 front, back) → 全量 Patch
      - emit: 绝对坐标重画整个 footer（yBias = footerTopRow - 1）
```

### 5.3 为什么这次和 Phase 5 不同

Phase 5 的 CUP+ED 之后，重画用 cursorUp + overwriteLine（相对定位）。
光标在 CUP 定位处，但 overwriteLine 的覆写范围基于 footerHeight，
reflow 后物理行数 ≠ footerHeight → 覆写不够 → 堆叠。

grid 的重画用 emit 的绝对坐标（\x1b[row;colH），不依赖光标当前在哪。
CUP+ED 擦干净后，emit 从 footer 顶开始逐 cell 绝对定位写入，保证正确。

## 6. 数据流

### 6.1 正常输入（非 resize）

```
用户敲一个字
  → inputStore 变化 → InlineApp effect 重跑
  → layoutFooter(cols) → FooterLayout（新内容）
  → gridRenderer.commitFooter(layout):
     back.clear() → blitAnsi(新 footer lines)
     diff(front, back) → 只有变化的 cell 进 Patch[]
     optimize → emit（yBias）→ stdout
     swap
```

和现在的 writeFooter 行为等价（增量 diff），但用绝对坐标 + cell 级 diff 替代 cursorUp + 行级覆写。

### 6.2 resize（cols 变化）

```
resize 事件 → useTerminalSize → cols prop 变化
  → InlineApp effect 重跑，检测 cols !== prevColsRef.current
  → gridRenderer.clearForResize()（CUP + ED + 丢弃 buffer）
  → layoutFooter(新 cols) → FooterLayout（新宽度 border）
  → gridRenderer.commitFooter(layout)（全量重画，因为 front 全 0）
```

### 6.3 新消息到达（footer 上移重画）

新消息到达时，commit() 内部先 commitFooter（擦旧 footer）再 appendLine（写消息）再重画 footer。
这个顺序保证 footer 总在消息正下方、屏幕底部。

```
新固化消息
  → commit():
     1. commitFooter()（gridRenderer 版：擦旧 footer 区域，footerHeight=0）
     2. appendLine(新消息)（写在旧 footer 位置，终端把旧内容推进 scrollback）
     3. commitFooter(新 footer layout)（在消息下方重画 footer）
```

因为 footer 总在屏幕底部 footerHeight 行，`footerTopRow = rows - footerHeight + 1` 恒成立。
gridRenderer 不需要跟踪"footer 当前在哪"——每次 commitFooter 都用公式重新算 footerTopRow。

**消息行数约束**：DECAWM OFF（`\x1b[?7l`）已防止终端自动折行，消息物理行数 = 应用层算的行数。
如果消息行数 + footerHeight > rows，消息会被推进 scrollback，footer 仍在底部——正确的终端行为。

## 7. 边界条件

### 7.1 footer 高度变化（输入折行 / suggestion 展开）

footerHeight 变化时（如 suggestion 从 0 条变 3 条，footer 从 4 行变 7 行）：
- footerTopRow 用**新 layout 的 height** 计算：`rows - newHeight + 1`
- DoubleBuffer 用新高度重建（rows 变了）
- 重建后 front 全 0 → 全量重画
- **高度减少时的残留**：旧 footer 占 7 行，新 footer 占 4 行，底部 3 行旧内容残留。
  commitFooter 在重建 buffer 前，先 CUP + ED 清掉旧 footer 整个区域（用旧的 footerTopRow + 旧 footerHeight），
  然后用新 footerTopRow 重画。这和 clearForResize 的逻辑相同——高度变化本质上是一次"局部 resize"。

### 7.2 流式草稿（streaming）

流式草稿在 footer **上方**，目前走 InlineRenderer.rewriteStreamingLines（cursorUp 相对定位）。
本设计只改 footer 路径，流式草稿暂时保持现状。

**resize 时的影响**：
- `clearForResize` 的 CUP 定位到 footer 顶 + ED 清到屏幕底——**只清 footer 区域**，
  清不到上方的流式草稿（流式草稿在 footer 顶之上的行）。
- 但 reflow 同样会弄乱流式草稿（超宽草稿行被折成多行），而流式仍用 cursorUp 相对定位，
  reflow 后定位失效 → **流式草稿在 resize 后可能堆叠**。

**决策**：第一阶段只处理 footer 的 resize。流式草稿的 resize 处理作为第二阶段。
- 如果 resize 时正好在流式，接受草稿短暂堆叠（下次 streamingText 更新触发 effect 重跑时会重画）。
- **P5 风险标记**：P5 实现时需验证 resize + 正在流式时的实际表现。如果流式堆叠严重影响使用，
  P5 可能需要增加一步：resize 时检测 isStreamingNow，如果是则同时清除流式草稿区域。

### 7.3 overlay（Ctrl+O 备用屏）

overlay 用 alt-screen（\x1b[?1049h），独立于主屏 footer。
overlay 打开时主渲染 effect 跳过，不受影响。

## 8. 测试策略

### 8.1 单元测试

**InlineGridRenderer**：
- commitFooter：footer 内容正确写入 back buffer
- commitFooter 连续两次：diff 只输出变化的 cell（不是全量）
- clearForResize：执行 CUP + ED，footerHeight 归零
- clearForResize 后 commitFooter：走全量重画（front 全 0）

**emit yBias**：
- yBias=0：输出 `\x1b[y+1;x+1H`（alt-screen，不变）
- yBias=26（footerTopRow=27）：输出 `\x1b[y+27;x+1H`（偏移正确）

### 8.2 集成测试

**resize 场景**（mock stdout）：
- cols=80 画 footer → cols=40 → clearForResize + 重画
- 断言：输出含 CUP + ED + 绝对坐标重画序列
- 断言：不含 cursorUp（相对定位）

### 8.3 现有测试不破坏

- border-width-regression：renderFooter 传不同 cols → border 正确（可能需适配新接口）
- input-wrap-border-regression：连续输入折行 border 不堆叠
- inline-resize-follow：cols 变化触发重绘

## 9. 实施阶段（概要，详细计划由 writing-plans 产出）

| 阶段 | 内容 | 风险 |
|---|---|---|
| P1 | emit.ts 加 yBias 支持 + 测试。实施时 **grep emit.ts 所有 `\x1b[` 序列**，逐一判断是否需要 yBias（不只是 patch 定位和光标定位，确认无遗漏） | 低（加可选参数，默认 0 不影响 alt-screen） |
| P2 | InlineGridRenderer 骨架 + commitFooter（含 clearRegion 统一清旧区域）+ 单元测试 | 中（新类，但复用成熟渲染核心） |
| P3 | clearForResize + dispose + 测试 | 低（简单序列，复用 clearRegion） |
| P4 | InlineApp 接入：footer 路径从 writeFooter 切到 gridRenderer。commit() 内部 commitFooter 调用改为 gridRenderer 版 | 高（改动主渲染路径） |
| P5 | resize 检测接入（cols 变化 → clearForResize + 重画）。**风险**：需验证 resize + 正在流式时的表现——流式草稿仍用 cursorUp 相对定位，resize 后可能堆叠。如果影响严重，P5 需增加流式草稿清除逻辑 | 中→高 |
| P6 | 真实终端验证（用户环境：独立 cmd 窗口） | — |

每阶段 TDD：先写测试，再实现，再验证不破坏现有测试。

## 10. 不做的事

- 不改静态行（logo/消息）的 appendLine 路径
- 不改流式草稿的 rewriteStreamingLines（第二阶段）
- 不改 alt-screen 模式的渲染路径
- 不引入 Yoga 布局（footer 是固定结构，不需要 flexbox）
- 不改 Ink fork 接缝（inline 模式 Ink 仍然空转）
