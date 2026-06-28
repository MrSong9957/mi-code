# Claude Code 终端渲染架构——流式输出与输入框共存之道

> 本文聚焦**终端渲染层 / 光标管理层**：解答"为什么 Claude Code 能在一边流式输出、一边保留底部输入框而不乱"。
> 配套文档 `docs/Claude-Code-流式输出架构详解.md` 讲的是**数据流水线**（API → QueryEngine → Markdown），两者互补，本文不重复数据流内容。
> 所有源码引用（`文件:行号`）均来自 Claude Code 官方公开源码（`D:\Files\GitHub\claude-code-source-code`），本文撰写时逐条核实。

---

## 目录

- [〇、一句话结论](#〇一句话结论)
- [一、问题本质：为什么"流式 + 输入框"天然冲突？](#一问题本质为什么流式--输入框天然冲突)
- [二、Claude Code 的解法：全量重绘 + 增量 diff](#二claude-code-的解法全量重绘--增量-diff)
- [三、为什么不崩？三个叠加的光标机制](#三为什么不崩三个叠加的光标机制)
- [四、终端原语工具箱：把 ANSI 序列讲透](#四终端原语工具箱把-ansi-序列讲透)
- [五、布局层：滚动区与输入框怎么"分家"？](#五布局层滚动区与输入框怎么分家)
- [六、原子性：为什么流式时不会看到"画一半"的撕裂？](#六原子性为什么流式时不会看到画一半的撕裂)
- [七、流式 token 的完整生命周期（端到端时序）](#七流式-token-的完整生命周期端到端时序)
- [八、三种技术路线的取舍对比](#八三种技术路线的取舍对比)
- [九、关键源码索引](#九关键源码索引)
- [十、补充：用户正在打字时，为什么"一键一帧"不会引发重绘混乱？](#十补充用户正在打字时为什么一键一帧不会引发重绘混乱)
- [附录：术语表](#附录术语表)

---

## 〇、一句话结论

> Claude Code **没有**"一条流式管道"和"一条输入框管道"在抢屏幕。
> 它把整块终端屏幕当成**一张虚拟画布**（一帧 Frame = 整屏的字符格子二维数组），流式文字和输入框都只是画布上的格子。
> 每次有任何变化（来了一个 token、按了一个键），它都**把整张画布重画一遍**，但只把"和上一张相比变了样的格子"刷到终端——
> **输入框那一带格子如果没变，就一个字节都不往那里写**，所以输入框永远不会被流式输出冲乱。

这就是本文要展开的全部内容。核心文件是 `src/ink/log-update.ts`（diff 引擎），核心思想是 **"整屏重画 + 逐格比对 + 只刷变化"**。

---

## 一、问题本质：为什么"流式 + 输入框"天然冲突？

### 1.1 物理类比：两个打字员共用一台打字机

把终端想象成一台老式打字机：纸带在往上卷，**只有一个打印头**（就是终端的**光标**）。

- **流式输出**像一个打字员 A：他要不停往下打字（AI 的话一个 token 一个 token 往下蹦），打印头要不断**往下走**。
- **输入框**像另一个打字员 B：他要在屏幕底部那行停下，等用户敲键，打印头要**钉在某一行某一列不动**。

问题来了：**两个打字员只能共用一个打印头。**

谁先动手，另一个就被挤开。更糟的是，两边都"自以为"打印头还在自己上次放的位置——一旦 A 趁 B 不注意打了一行字，B 再按原先假设去擦写输入框，就会**擦错行、写串位**。这就是你遇到的"要输入框，流式输出就出乱子"的根因。

### 1.2 根因拆解（第一性原理）

冲突不在"输出"和"输入"本身，而在这两个事实：

1. **终端只有一个光标**。所有写字、擦字，都隐含"在当前光标位置动手"。两个写入者都要摆弄光标。
2. **每次写入都假设了光标的起点**。手动 ANSI 擦画（`eraseLine`、`cursorMove`）的逻辑，都建立在"此刻光标在我以为的地方"之上。一旦中间有别人动过光标，假设就崩了。

只要"流式"和"输入框"是**两条各自直接写 stdout 的独立代码路径**，这个冲突就**不可调和**。

### 1.3 三种"天真解法"以及它们为什么不够好

| 解法 | 物理类比 | 缺点 |
|------|---------|------|
| **① 时序分离**：AI 输出时藏起输入框，输出完再显示 | 两个打字员**轮班**用打字机，绝不同时上手 | 这正是 **mi-code 的现状**（见 `src/index.ts:8-15`、`renderPrompt()` 在 `isProcessing` 时直接 return，`src/index.ts:181-189`）。能用，但**用户在 AI 说话时看不到、也打不了输入框**，体验割裂。 |
| **② 备用屏（alt-screen）+ 应用自己滚动** | 换一张全新的画布，两个打字员都在新画布上，**但纸带不再自动卷**，得自己翻页 | 放弃了**终端原生滚动条和 scrollback**（历史消息存不进终端的历史卷宗）。Claude Code 全屏模式正是这条路（见第五节）。 |
| **③ 终端滚动区域（DECSTBM scroll region）** | 在画布上**用胶带划出一道线**，规定"这带往上自动卷，这带往下钉死" | 能实现，但**跨终端兼容性差**、状态脆弱（resize、tmux 都容易把它搞乱），且只解决了"分区滚动"，没解决"分区后两区各自的光标协调"。 |

> 本文主角 Claude Code 用的是**第四种**解法——既不是①，也不仅仅是②，而是 **"整屏虚拟画布 + 逐格 diff + 相对光标"**。这套机制**同时支持主屏模式（保留原生滚动条）和备用屏模式**。下面三节展开。

---

## 二、Claude Code 的解法：全量重绘 + 增量 diff

### 2.1 物理类比：整张画布重画，但只擦涂改过的格子

想象你要改一幅**像素画**。最笨的办法是每次都**整张擦掉重画**——闪得厉害。聪明的做法是：

1. 在脑子里（**内存里**）准备一张**和屏幕一样大的格子纸**，把整屏的内容都画上去。
2. 每次状态变了，**在脑子里重画一张新的格子纸**。
3. 把"新格子纸"和"上一张格子纸"**逐格比对**，**只挑出不一样的格子**。
4. 真正动手在屏幕上**只擦涂、只重画那些不一样的格子**，没变的格子**一概不碰**。

这就是 Claude Code 的核心机制。流式输出和输入框都在同一张格子纸上，输入框只要内容没变，它在格子比对时就是"一样"，于是**被完全跳过，连一个字节都不会写到屏幕上**。

### 2.2 核心三件套（配源码）

Claude Code 的整套渲染在 `src/ink/` 目录（一份内嵌的 Ink fork），三件套如下：

#### 三件套 ①：Frame = 一张完整画布

一帧 `Frame` = `{ screen, viewport, cursor }`（`src/ink/frame.ts`）。其中 `screen` 是一个**二维字符格子数组**（`src/ink/screen.ts`，用打包过的 `Int32Array` 存每个格子的字符+样式）。每一帧都**包含整屏所有格子**——流式文本、工具输出、输入框、spinner，统统在里面。

> 物理动作：**"切块 + 贴标签"**——把屏幕切成 N×M 个小方格，每格贴一个字符标签和一个样式标签。

#### 三件套 ②：全量重绘（React + Yoga 触发）

整个 UI 是一棵 React 树（`src/ink/reconciler.ts` 把 React 元素映射成终端 DOM 节点；`src/native-ts/yoga-layout/` 做 flexbox 布局）。每当状态变（来了 token、按了键），React 重新渲染整棵树，Yoga 重新算每个节点的 x/y/宽高，然后 `renderer.ts` 把整棵树**整屏重画**成一张新的 `Frame`。

> 关键认知：**"全量重绘"指的是在内存里重画一帧，不是把整屏刷到终端。** 重画很便宜（在内存里），真正"刷到终端"才是第三步。

#### 三件套 ③：增量 diff（`LogUpdate.render`）

这是把"新画布"转成"最少终端指令"的引擎。核心是 `src/ink/log-update.ts` 的 `LogUpdate.render(prevFrame, nextFrame, …)`。

逐格比对在 `log-update.ts:308` 的 `diffEach(prev.screen, next.screen, (x, y, removed, added) => { … })` 里完成。对每一个**变化了的格子**，做两件事（`log-update.ts:351-363`）：

```ts
moveCursorTo(screen, x, y)                       // 把光标（相对地）挪到这个格子
const styleStr = stylePool.transition(...)       // 算样式变化串
writeCellWithStyleStr(screen, added, styleStr)   // 写下这个字符
```

**没变的格子不进入这个回调**——这就是"只刷变化"的实现。源码里明确排除了空格子、宽字占位格等不需要写的格子（`log-update.ts:318-341`）。

### 2.3 这条铁律直接来自源码注释

`log-update.ts:187-188`（diff 逻辑开头）原文：

> // We have to use purely relative operations to manipulate the cursor since
> // we don't know its starting point.
>
> （译：只能用**纯相对移动**来摆弄光标，因为我们根本不知道光标的真实起点。）

这条铁律是整个机制的命门，下一节展开。

---

## 三、为什么不崩？三个叠加的光标机制

光标问题是整件事最微妙、也最容易被忽略的部分。Claude Code 用**三层叠加**的机制来驯服它。

### 3.1 第一层：VirtualScreen——不信任终端，自己记账

#### 物理类比：手绘地图标注打印头位置

打字机的打印头在哪儿，你**不去看它**，而是在自己手里**备一张小地图**，记下"我认为打印头现在在 (x, y)"。每次发指令让打印头动了，就**在小地图上同步更新坐标**。下次要让打印头去别处，就在**小地图上算**"从当前位置相对走几步"，然后**只发相对指令**（往上 N 步、往右 M 步），绝不发"走到绝对坐标 (a,b)"这种指令。

为什么不信任终端？因为终端实际光标可能被外部因素动过（resize、tmux 状态栏刷新、别的进程写了一行）。发绝对坐标指令依赖"终端认识这套坐标系"，而**相对指令只依赖"打印头现在在某处"，对起点不敏感**。

#### 技术实现

`log-update.ts:752-773` 定义了 `VirtualScreen` 类，内部维护 `cursor: Point`：

```ts
class VirtualScreen {
  cursor: Point       // ← 自己记账的"虚拟打印头"位置
  diff: Diff = []     // ← 累积要发的指令
  txn(fn) {           // ← 每次操作都更新 cursor，并把指令塞进 diff
    const [patches, next] = fn(this.cursor)
    this.cursor.x += next.dx
    this.cursor.y += next.dy
  }
}
```

把虚拟光标搬到目标点的函数 `moveCursorTo`（`log-update.ts:693-721`），**只发相对指令**：

```ts
function moveCursorTo(screen, targetX, targetY) {
  screen.txn(prev => {
    const dx = targetX - prev.x   // ← 相对偏移
    const dy = targetY - prev.y
    if (dy !== 0) {
      // 跨行：先回车(\r)回行首，再相对移动
      return [[CARRIAGE_RETURN, { type: 'cursorMove', x: targetX, y: dy }], { dx, dy }]
    }
    return [[{ type: 'cursorMove', x: dx, y: dy }], { dx, dy }]  // 同行：纯相对
  })
}
```

注意它**永远不发"绝对坐标"指令**（`CUP` `\x1b[r;cH`），永远是从虚拟光标当前位置算 `dx/dy` 再发相对移动。这呼应了 2.3 的铁律。

> 💡 对照 mi-code：`src/renderer/virtual-screen.ts` 已经实现了这套机制（`moveTo` 在 `virtual-screen.ts:87-103`，同样只发相对 `cursorMove`），只是**没接到 `index.ts` 上**。这是 Claude Code 解法在 mi-code 里的"半成品"。

### 3.2 第二层：备用屏锚定——每帧先回家，重新对零点

#### 物理类比：每画一帧前，先把笔强制送回左上角

相对指令有个前提："虚拟地图和真实打印头必须同步"。如果真实打印头被外部搞乱了（漂移），虚拟地图就失准，相对指令也会算错。

最稳的兜底：**每画一帧前，先把真实打印头强制送回左上角原点**，这样"虚拟地图认为的起点 = 真实起点"，相对指令从零开始算，绝不会累积漂移误差。

#### 技术实现（仅备用屏模式）

`src/ink/ink.tsx`（核心 `Ink` 类的 `onRender` 帧循环）在**备用屏模式**下，每帧 diff 输出**最前面**都插一个 `\x1b[H`（光标回家）patch（`CURSOR_HOME` 定义在 `src/ink/termio/csi.ts:162`）。源码注释称这是"self-healing against out-of-band cursor drift"（自愈式抵御越权光标漂移）。

> ⚠️ 注意：**主屏模式（默认、保留 scrollback）不用这招**——因为主屏里内容会自然滚进 scrollback，强行每帧回家会破坏滚动历史。主屏模式靠的是第一层（VirtualScreen 相对记账）+ 后面的第三层。这呼应了你"保住滚动条"的倾向（见第八节）。

### 3.3 第三层：useDeclaredCursor——每帧末把笔送到输入框光标处

#### 物理类比：给画师贴个便签"最后把笔放在这儿"

diff 刷完，真实打印头会停在"最后一个被刷的格子"——这位置每帧都不一样（哪行有变化就停哪行）。但用户要看到**光标稳稳地停在自己的输入框里**（这样打字才对位、IME 输入法候选框才会跟手、屏幕阅读器才能跟上）。

办法：输入框**主动声明**"光标应该停在我这里第几行第几列"。每帧 diff 刷完后，渲染器读这条声明，**发一条绝对坐标指令**把真实光标精准搬到输入框的光标位置。

#### 技术实现

`src/ink/hooks/use-declared-cursor.ts:25-73`：输入框组件调用 `useDeclaredCursor({ line, column, active })`，通过 context 把 `{ relativeX, relativeY, node }` 上报（`use-declared-cursor.ts:54-61`）。`ink.tsx` 的 `onRender` 在算完 diff 后，读这条声明，从 `nodeCache` 查出该节点的绝对屏幕坐标，**末尾追加一条**绝对光标定位（备用屏用 CUP `\x1b[r;cH`，主屏用相对 `cursorMove`）。

源码注释（`use-declared-cursor.ts:6-11`）说明这么做的两个目的：让 **IME 预编辑文本**（中文输入法的候选框）内联渲染、让**屏幕阅读器/放大镜**能跟踪输入。

> 三层叠加的净效果：**无论这帧刷了哪些格子、刷到哪儿，光标最后都精准落在输入框光标处**。这就是输入框"看起来纹丝不动"的最后一道保险。

---

## 四、终端原语工具箱：把 ANSI 序列讲透

Claude Code 用的 ANSI/DEC 转义序列集中在 `src/ink/termio/`（`csi.ts` = CSI 序列、`dec.ts` = DEC 私有模式）。下表按"物理动作"逐个解释。

### 4.1 光标类（搬运打印头）

| 序列 | 物理动作 | 用途 | 源码出处 |
|------|---------|------|---------|
| `\x1b[H` (CSI H) | **回家**——打印头送回左上角原点 | 备用屏每帧开头重新对零点（3.2） | `csi.ts:162` `CURSOR_HOME` |
| `\x1b[<n>A` (CUU) | **往上走 n 行** | 相对垂直移动（向上） | `csi.ts` `cursorUp` |
| `\x1b[<n>B` (CUD) | **往下走 n 行** | 相对垂直移动（向下） | `csi.ts` `cursorDown` |
| `\x1b[<n>C` (CUF) | **往右走 n 格** | 相对水平移动（向右） | `csi.ts` `cursorForward` |
| `\x1b[<n>D` (CUB) | **往左走 n 格** | 相对水平移动（向左） | `csi.ts` `cursorBack` |
| `\x1b[<r>;<c>H` (CUP) | **走到绝对坐标 (行 r, 列 c)** | 第三层把光标精准搬到输入框光标处 | `csi.ts:157` `cursorPosition` |
| `\x1b[<col>G` (CHA) | **走到本行第 col 列** | 宽字符宽度补偿修正 | `csi.ts:150` `cursorTo` |
| `\x1b[s` / `\x1b[u` | **存/取打印头位置** | （Claude Code 基本不用，改用 VirtualScreen 自己记账） | `csi.ts:189-192` |

> `cursorMove(x, y)`（`csi.ts:169-184`）是组合函数：把相对 dx/dy 拆成 CUU/CUD + CUF/CUB 四个原语。这是第一层 VirtualScreen 实际发出去的指令形态。

### 4.2 擦除类（擦格子）

| 序列 | 物理动作 | 用途 |
|------|---------|------|
| `\r` (CR) | **回到本行最左**（不下移） | 跨行移动前先回行首（`moveCursorTo` 里用） |
| `\x1b[2K` (EL) | **擦掉当前整行** | 清掉要重画的行 |
| `\x1b[2J` (ED) | **擦掉整屏** | fullReset 时整体重画前清屏 |

### 4.3 DEC 私有模式（开关功能）

| 序列 | 物理动作 | 用途 | 源码出处 |
|------|---------|------|---------|
| **DEC 1049** `\x1b[?1049h/l` | **切到另一块画布 / 切回原画布**（备用屏） | 全屏模式整块换画布，互不污染 | `dec.ts:16` `ALT_SCREEN_CLEAR`、`:45-46` `ENTER/EXIT_ALT_SCREEN` |
| **DEC 25** `\x1b[?25h/l` | **显示 / 隐藏打印头**（光标可见性） | 备用屏里隐藏真光标，自己管位置 | `dec.ts:14`、`:43-44` `SHOW/HIDE_CURSOR` |
| **DEC 2026** `\x1b[?2026h … \x1b[?2026l` | **同步更新 BSU/ESU**——"开始画 / 画完了" | **原子性**（第六节详解） | `dec.ts:23` `SYNCHRONIZED_UPDATE`、`:37-38` `BSU/ESU` |
| **DEC 2004** | **括号粘贴** | 识别粘贴 vs 键入 | `dec.ts:21`、`:39-40` |
| 鼠标 1000/1002/1003/1006 | **SGR 鼠标跟踪** | 滚轮滚动、拖拽选区 | `dec.ts:17-20`、`:51-60` |

### 4.4 DECSTBM 滚动区域（重要：它不是用来分"输出区/输入区"的）

`\x1b[<top>;<bottom>r` (DECSTBM) 在画布上**划一道横线**，规定"top~bottom 这一带才会自动卷动"（`csi.ts:264-267` `setScrollRegion`）。配合 `\x1b[<n>S/T`（`csi.ts:255-262` `scrollUp/scrollDown`）能让某一带**硬件级整带上卷**。

**⚠️ 关键澄清**：很多人以为 Claude Code 用 DECSTBM 把屏幕切成"上面输出区 + 下面输入区"。**不是的。** Claude Code 里 DECSTBM **只用作性能优化**（`log-update.ts:148-185`）：当 `ScrollBox` 的 `scrollTop` 变了，与其重画整个滚动带，不如发一条"硬件整带上卷 n 行"指令，再 `shiftRows` 同步自己的帧缓冲（`screen.ts` 的 `shiftRows`），让后续 diff 只需画滚进来的那几行。**它和"输出区/输入区怎么分家"无关**——分家靠的是布局（第五节）。

而且这个优化**只在支持 DEC 2026 同步更新的终端上启用**（tmux 不支持 2026，会退回成整带重画）。

---

## 五、布局层：滚动区与输入框怎么"分家"？

### 5.1 物理类比：书桌分两格

把屏幕想成一张**竖着分两格的书桌**：

- **上面那大格**：放一叠**可以翻页的稿纸**（对话历史），稿纸满了最上面的就翻走（滚动）。
- **下面那小格**：钉死，放一张**便签**（输入框），永远在最下面。

### 5.2 反直觉点：分家靠 flexbox，不靠终端滚动区域

这是另一个容易被误解的点。Claude Code 的"上下分家"**不是用 DECSTBM 终端滚动区域实现的**，而是用 **flexbox 弹性布局**（和写网页一样）实现的：

- 上面的大格：一个 `ScrollBox`，设 `flexGrow=1`（占满剩余空间）。
- 下面的小格：一个普通 `Box`，设 `flexShrink=0`（绝不被压缩，钉死）。

源码在 `src/components/FullscreenLayout.tsx`：

```tsx
// :361 — 上面的大格（可滚动稿纸）
<ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column"
           paddingTop={t9} stickyScroll={true}>
  {scrollable}{overlay}
</ScrollBox>

// :35（注释）+ 底部 Box — 下面的小格（便签/输入框）
// "Content pinned to the bottom (spinner, prompt, permissions)"
<Box flexDirection="column" flexShrink={0} width="100%">
  {bottom}
</Box>
```

Yoga 布局引擎算出：大格占满除便签外的所有高度，便签钉底。**当稿纸内容变多，稿纸在大格里自己滚动（视口裁剪），便签位置纹丝不动。** 这一切都发生在"内存里的 Frame 画布"上，再由第二节那套 diff 刷到终端。

### 5.3 两种模式的本质取舍（核心决策点）

Claude Code 有两种模式，`AlternateScreen` 组件（`src/ink/components/AlternateScreen.tsx:33-79`）决定用哪种。**这个选择直接关系到"能不能用终端原生滚动条"**——正是你在意的事。

| 模式 | 怎么进 | 原生 scrollback / 滚动条 | 应用层管什么 |
|------|--------|--------------------------|-------------|
| **主屏模式（main screen，默认）** | 不挂 `AlternateScreen` | ✅ **保留**。能用终端滚动条翻历史，老内容自然滚进 scrollback | 应用层只管"可视窗口的最后 N 行"（`log-update.ts:294-300` 的 `viewportY` 计算"已有多少行进了 scrollback"） |
| **备用屏模式（alt screen，全屏）** | 挂 `<AlternateScreen>`，发 `ENTER_ALT_SCREEN + \x1b[2J\x1b[H`（`AlternateScreen.tsx:50`） | ❌ **没有**。整块换到备用画布，高度锁死到终端行数（`AlternateScreen.tsx:68-71` `height={rows}`） | **必须自己实现滚动**——`ScrollBox` 做**视口裁剪**：子节点按真实高度布局，但渲染时只画 `scrollTop ~ scrollTop+height` 这段（`ScrollBox.tsx` docstring） |

**这就是你纠结的根源**：
- 想要**终端原生滚动条** → 必须主屏模式 → 但主屏里应用层"够不到"已滚进 scrollback 的行（终端清行操作碰不到 scrollback），所以一旦那些行需要变（比如流式回填），就得 `fullReset`（`log-update.ts:382-384`，会闪一下）。
- 想要**最稳的"流式 + 输入框"共存** → 备用屏全屏模式 → 但**失去原生滚动条**，得自己做滚动（工程量大，这正是 Claude Code 全套 `ScrollBox` + 虚拟滚动的由来）。

> 这两条路的取舍，第八节会拉成一张表。**但请注意**：第二节那套"全量重绘 + diff"机制**两种模式都共用**，是同一套 diff 引擎。差别只在"画布是主屏（带 scrollback）还是备用屏（锁死高度）"。

---

## 六、原子性：为什么流式时不会看到"画一半"的撕裂？

### 6.1 物理类比：一次性揭幕

如果一帧画面**分好几次**写到终端（先写上半屏，再写下半屏），用户在两次写之间会看到"画了一半"的撕裂瞬间（尤其 token 来得密、每帧都有变化时）。

办法：**把整帧的所有指令拼成一个字符串，一次性 `write` 出去**；终端要么完全没收到新画面，要么收到完整的新画面。更进一步，如果终端支持 **DEC 2026 同步更新**，就在整帧指令**最前面贴"开始画"（BSU）**、**最后面贴"画完了"（ESU）**，终端会**攒着不显示**，直到看到 ESU 才**整帧一起呈现**——就像揭幕一样，绝无半截状态。

### 6.2 技术实现

`src/ink/terminal.ts:190-248` 的 `writeDiffToTerminal`：

```ts
let buffer = useSync ? BSU : ''              // 开头：贴"开始画"
for (const patch of diff) {
  switch (patch.type) {                       // 把整帧所有指令拼进 buffer
    case 'stdout':      buffer += patch.content; break
    case 'cursorMove':  buffer += cursorMove(patch.x, patch.y); break
    case 'carriageReturn': buffer += '\r'; break
    // …其余 patch 类型
  }
}
if (useSync) buffer += ESU                     // 结尾：贴"画完了"
terminal.stdout.write(buffer)                  // ← 一次性写出（terminal.ts:247）
```

两道保险：
1. **单次 `stdout.write`**（`:247`）：整帧拼成一个字符串一次写出，不让中间状态被看到。
2. **BSU/ESU 包裹**（DEC 2026）：终端级"等我说画完才显示"。

### 6.3 兼容性坑（tmux）

`writeDiffToTerminal` 有个参数 `skipSyncMarkers`（`terminal.ts:193, 203`）。源码注释（`terminal.ts:200-202`）说明：**tmux 不支持 DEC 2026**（它会逐字节代理并打散，破坏原子性），所以在 tmux 下传 `skipSyncMarkers=true`，退回成"单次 write 但不包 BSU/ESU"。这是为什么在 tmux 里 Claude Code 偶尔能看到轻微闪烁的原因。

### 6.4 节流：token 再密也不刷屏

即便 token 接连到达，渲染也不是每个 token 都触发一次写屏。`src/ink/ink.tsx`（约 `:212-216`）用 lodash `throttle` 把 `onRender` 限流到 `FRAME_INTERVAL_MS` 一次，且通过 `queueMicrotask` 延后。所以"一秒来 100 个 token"也只触发有限的几次写屏，每次写的是"截至此刻累积的最新一帧"。

---

## 七、流式 token 的完整生命周期（端到端时序）

把前面几节串成一条完整的时序。**这一节就是"为什么输入框不被冲乱"的完整答案**。

### 7.1 时序图

```
   ① token 到达
        │
        ▼
   ② setStreamingText(累积文本)        ← React state 更新 (REPL.tsx:1461)
        │
        ▼
   ③ React 重新渲染整棵树              ← reconciler.ts
        │
        ▼
   ④ Yoga 重新算布局 (x/y/w/h)         ← src/native-ts/yoga-layout/
        │
        ▼
   ⑤ renderer 把整棵树画成新 Frame     ← 整屏格子二维数组 (renderer.ts)
        │   —— 这一帧里：流式区多了新格子，
        │                  输入框那几行格子【和上一帧逐格相同】
        ▼
   ⑥ LogUpdate.render(旧帧, 新帧)      ← log-update.ts:308 diffEach
        │   逐格比对，只对【变化了的格子】生成：
        │     moveCursorTo(相对移动) + 写字符
        │   输入框那几行格子【没变 → 不生成任何 patch】
        ▼
   ⑦ optimizer 合并/去重 patches       ← src/ink/optimizer.ts
        │
        ▼
   ⑧ writeDiffToTerminal               ← terminal.ts:190-248
        │   单次 write，包 BSU…ESU（第六节）
        ▼
   ⑨ 末尾把光标搬到输入框光标处        ← useDeclaredCursor（第三节第三层）
        │
        ▼
   终端：只看到流式区变了，输入框纹丝不动，
        光标稳稳落在输入框里
```

### 7.2 为什么输入框不会被冲乱（最终答案）

回到你最关心的问题。答案在 ⑥：

> **输入框那几行格子，在新旧两帧里"逐格相同"。`diffEach` 比对时它们不进入回调，于是生成的 patch 集合里根本不包含输入框那些坐标的任何指令。一个字节都不会写到输入框那里。**

这和"时序分离"（mi-code 现状）有本质区别：mi-code 是"AI 说话时把输入框**藏起来**"（`index.ts:182` `if (isProcessing) return`），Claude Code 是"AI 说话时输入框**一直在那儿，只是没动所以不刷**"。前者是**轮班**，后者是**同屏共存**——输入框始终可见、可编辑（理论上）。

> 💡 顺带点出 mi-code 的隐藏 bug：`index.ts:406-421` 的"可打印字符"分支**没有 `if (!isProcessing)` 守卫**，所以 AI 流式输出时用户敲的可见字符会**悄悄累积进 `input`**（而箭头键/回车被 `isProcessing` 拦了）。这正是"两条独立写入路径"冲突的典型症状——即便用了时序分离，守卫也没盖全。

---

## 八、三种技术路线的取舍对比

把前面提到的三种方案拉成一张决策表，呼应你"想保住原生滚动条"的倾向。**本节只做技术选型对比，不写实现代码。**

| 维度 | ① 时序分离（mi-code 现状） | ② 主屏 + 全量重绘 diff | ③ 备用屏全屏（同 Claude Code 全屏模式） |
|------|---------------------------|------------------------|----------------------------------------|
| **原生滚动条 / scrollback** | ✅ 保留 | ✅ **保留** | ❌ 没有（必须自己做滚动） |
| **流式时输入框可见** | ❌ 隐藏（`isProcessing` return） | ✅ **常驻、可编辑** | ✅ 常驻、可编辑 |
| **流式时能否边输出边打字** | ❌ 不能 | ✅ 能（理论上） | ✅ 能 |
| **光标协调机制** | 不协调（轮班） | VirtualScreen 相对记账 + useDeclaredCursor | + 备用屏每帧 `\x1b[H` 锚定 |
| **实现复杂度** | 低（已实现） | **中**（需把 `VirtualScreen`/`frame-renderer` 接上，mi-code 已有半成品） | 高（要自己实现 `ScrollBox` 视口滚动、虚拟列表、滚到顶加载历史等） |
| **跨终端兼容性** | 极好 | 好（只用基本 CSI 相对移动，不依赖 2026） | 中（依赖 1049；2026 在 tmux 下退化） |
| **fullReset 闪烁** | 无（不重画） | 有（scrollback 行需变时，`log-update.ts:382`） | 基本无（自己管整屏，够得到所有格子） |
| **IME/无障碍** | 弱 | 可加（useDeclaredCursor 同思路） | 强（Claude Code 就是这么做的） |
| **代表实现** | mi-code `index.ts` | Claude Code **主屏模式**；mi-code `renderer.ts`（未接线） | Claude Code `AlternateScreen` + `ScrollBox` |

### 结论与倾向

- 你的诉求是"**既要原生滚动条，又要输入框在流式时常驻**"。这张表里**唯一同时满足两项的是②"主屏 + 全量重绘 diff"**。
- 方案②正是 **Claude Code 主屏模式**用的同一套 diff 机制（第二节那套，两种模式共用）。差别只在于"不用 `AlternateScreen`、画布是主屏带 scrollback"。
- 巧合的是，**mi-code 已经写好了②的基础设施**（`src/renderer/virtual-screen.ts` 的 VirtualScreen、`frame-renderer.ts` 的 `renderFrame`、`renderer.ts` 的 `renderTree`），只是**没有接到 `index.ts`**——`index.ts:23` 只从 renderer 模块导入了 `ANSI`，`renderTree`/`resetRenderer` 从未被调用。所以路线②对 mi-code 而言是"接通已有半成品"，不是从零造轮子。
- 但请注意 ② 的固有代价：主屏模式下，**已滚进 scrollback 的行，应用层够不到**，一旦需要改就得 `fullReset`（整屏重画，会闪）。实际工程中，可通过"流式内容只追加不回改"的设计把 fullReset 压到极少发生。

> 说明：以上为**技术选型依据**，本文档（按你的要求）不写 mi-code 的具体改造实现。

---

## 九、关键源码索引

按"读这 8 个文件就能懂全貌"的顺序，附本次核实过的关键行号。源码根目录：`D:\Files\GitHub\claude-code-source-code`。

| # | 文件 | 为什么读 | 关键行 |
|---|------|---------|--------|
| 1 | `src/ink/ARCHITECTURE.md` | 30 分钟看懂整条渲染管线全景 | 全文（仅 119 行） |
| 2 | `src/ink/log-update.ts` | **diff 引擎，全篇核心** | `render` diffEach `:308-381`；铁律注释 `:187-188`；`moveCursorTo` `:693-721`；`VirtualScreen` `:752-773` |
| 3 | `src/ink/screen.ts` | 格子画布 + `shiftRows`（DECSTBM 模拟） | `shiftRows`（搜函数名） |
| 4 | `src/ink/ink.tsx` | 帧循环 `onRender`、节流、备用屏光标锚定 | `onRender`（约 `:420` 起）；节流（约 `:212-216`）；光标锚定（约 `:622-651`）；声明式光标落地（约 `:660-734`） |
| 5 | `src/ink/components/AlternateScreen.tsx` | 备用屏进/出，高度锁死 | `:33-79`，进入序列 `:50`，高度约束 `:68-71` |
| 6 | `src/ink/components/ScrollBox.tsx` | 备用屏下的视口滚动 | docstring + `:82-235` |
| 7 | `src/components/FullscreenLayout.tsx` | **上下分家靠 flexbox**（不是 scroll region） | props `:33-35`；`ScrollBox flexGrow=1` `:361`；底部 `flexShrink=0` |
| 8 | `src/ink/termio/dec.ts` + `csi.ts` | ANSI/DEC 字典 | `dec.ts:13-60`（DEC 模式常量）；`csi.ts:150-270`（光标/擦除/滚动函数） |
| 附 | `src/ink/terminal.ts` | 单次 write + BSU/ESU 原子性 | `writeDiffToTerminal` `:190-248`，单次 write `:247` |
| 附 | `src/ink/hooks/use-declared-cursor.ts` | 第三层光标落地（IME/无障碍） | `:25-73`，动机注释 `:6-11` |

---

## 十、补充：用户正在打字时，为什么"一键一帧"不会引发重绘混乱？

> 读者反馈：第二节说的"输入框格子没变就跳过"，只解释了**流式输出时输入框静止**的情况。但实际用 Claude Code 时，**即便 AI 正在流式输出，用户也能在输入框里打字**，而输入框内容在变、却不会"敲一个字就整框重画一次"导致终端混乱。本节专门补上这个场景的机制。

### 10.1 问题更尖锐了：现在是"用户在动 + AI 也在动"

第二节、第七节讲的场景是：**输入框静止**（用户没敲键），只有 AI 在流式输出。那种情况下，输入框那几行格子"逐格相同"，diff 直接跳过，不写任何字节。

但你现在问的是**更难的场景**：

- AI 在流式输出 → 上面那块格子一直在变；
- 用户同时在输入框打字 → 下面那块格子**也在变**（每敲一个字，输入框那一行就变一次）。

这时候输入框的格子**不再是"逐格相同"**了——它每个字都在变。如果天真地"每次状态变就整屏重画一次"，用户敲一个字就触发一次整屏 diff + 写屏，在快速打字下就是**"一键一帧"的疯狂重绘**，终端肉眼可见地混乱、闪烁、卡顿。这正是你"让 AI 执行方案"时遇到的现象。

Claude Code 用 **三道专门针对"打字时不抖"的保险**解决了它。注意：这三道**不是**第二节的 diff 机制（diff 只管"刷哪些格子"），而是**在 diff 之前**控制"什么时候才允许刷一帧"。

### 10.2 物理类比：邮局分拣台的"攒一批再处理"

把每次状态变化（敲一个字 / 来一个 token）想成**一封信**送进邮局分拣台。如果分拣员**来一封就停下手从头分拣一次**，信一多他就手忙脚乱、桌上的东西被反复搬来搬去（终端混乱）。

聪明的做法：

1. **分拣员只看"信的类别"决定多急**——用户的按键信是"急件"（高优先级），AI 的批量消息信是"平信"（低优先级，可延后）。
2. **定一个节奏**——不管信来得多密，**每 16 毫秒最多分拣一次**，且**只分拣到此刻为止攒下的最新状态**（中间过程全丢）。
3. **同一批信合并**——同一次送达的多封信，**当成一个包裹**处理一次，不拆成多次。

这样：用户打字再快，AI 来 token 再密，**每秒最多 ~60 次写屏，且每次都是"此刻的最新一帧"**——终端看起来始终是连贯的一张图，绝不会"画一半又被改"。

### 10.3 第一道保险：`useDeferredValue`——把贵的渲染降级为"平信"

这是最关键、也最反直觉的一招。源码在 `src/screens/REPL.tsx:1315-1318`：

```tsx
// Deferred messages for the Messages component — renders at transition
// priority so the reconciler yields every 5ms, keeping input responsive
// while the expensive message processing pipeline runs.
const deferredMessages = useDeferredValue(messages);
```

物理动作：**贴"平邮"标签**。

`messages`（消息列表）是渲染**最贵**的部分——一条消息要 Markdown 解析、代码高亮、布局成几十上百格。如果用户每次敲键都触发整条消息列表重算，打字就会卡。

React 18 的 `useDeferredValue(messages)` 做的事：

- 用户敲键（`inputValue` 变）是**高优先级**更新 → React **立刻**重渲染输入框，光标跟手，丝滑。
- `messages` 的最新值被"延迟"——React 在 **transition（过渡）优先级**上渲染它，而且**每 5ms 让出一次**给高优先级任务（注释里的 "yields every 5ms"）。
- 结果：**打字的更新永远插队到消息列表更新前面**。用户感觉不到消息列表的昂贵重算拖慢了打字。

为什么能让"打字时输入框不混乱"？因为**输入框的渲染（高优先级）和消息列表的渲染（低优先级）被解耦了**——输入框拿到最新状态立刻刷，消息列表慢慢刷；两者不再"一个 keystroke 拖着整棵树一起重算"。

> ⚠️ 关键前提：这招依赖 React 的**并发模式**。源码 `src/ink/ink.tsx:262` 用的是 `ConcurrentRoot`（`createContainer(rootNode, ConcurrentRoot, …)`）——这正是让 `useDeferredValue` / transition 优先级生效的根。**如果你没有用 React + 并发根，这招用不了。**

### 10.4 第二道保险：16ms 节流——攒一批，只画最新一帧

光解耦优先级还不够——万一 5ms 内来了 20 个 token + 用户敲了 3 个字，难道刷 23 次？源码 `src/ink/ink.tsx:212-216`：

```tsx
const deferredRender = (): void => queueMicrotask(this.onRender);
this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
  leading: true,
  trailing: true
});
```

其中 `FRAME_INTERVAL_MS = 16`（`src/ink/constants.ts:2`）。物理动作：**定节拍器，16ms 响一次**。

`throttle(..., 16, { leading: true, trailing: true })` 的语义：

- 一段时间内**不管触发多少次** `scheduleRender`，**最多每 16ms 真正执行一次** `onRender`；
- `leading: true` → 周期开始那一下立刻执行（保证响应快）；
- `trailing: true` → 周期结束若有被压下的调用，最后补一次（保证不丢最终状态）。

所以：**敲一个字触发 setState → 排队 → 16ms 内的所有排队被合并 → 只画"到这一刻为止的最新一帧"**。用户狂敲 10 个字，这一秒内也就刷约 60 次，每次都是最新状态。终端看到的永远是连贯画面。

**决定性证据**——`src/screens/REPL.tsx:1458-1459` 的源码注释**直接坐实**了这层职责：

> // Streaming text display: set state directly per delta (**Ink's 16ms render
> // throttle batches rapid updates**).

即：流式时**每个 token 都直接 `setState`**（REPL.tsx:1466 的 `setStreamingText(f)`），并不自己做防抖——它**依赖 Ink 的 16ms 节流去批量合并**这些快速更新。

### 10.5 第三道保险：React 自动批处理——一次事件回调里的多次 setState 合并成一次

源码 `src/screens/REPL.tsx:1340-1363` 的 `setInputValue` 包装，注释明确点出这一点：

```tsx
// Wrap setInputValue to co-locate suppression state updates.
// Both setState calls happen in the same synchronous context so React
// batches them into a single render, eliminating the extra render that
// the previous useEffect → setState pattern caused.
const setInputValue = useCallback((value: string) => {
  …
  setInputValueRaw(value);              // setState #1
  setIsPromptInputActive(value.trim().length > 0);  // setState #2
  …
}, […]);
```

物理动作：**一次送达的多封信，装一个包裹**。一次按键触发了两个 `setState`（输入值 + "输入框是否激活"），React 在 React 18 的**自动批处理**下，把它们合并成**一次渲染**，而不是两次。这避免了"敲一个字 → 输入值变了刷一次 → 激活态变了又刷一次"的双重重绘。

### 10.6 流式进行时，为什么还额外绕过 useDeferredValue？

`src/screens/REPL.tsx:4500-4509` 有一处精微设计：

```tsx
// Bypass useDeferredValue when streaming text is showing so Messages renders
// the final message in the same frame streaming text clears. …
const usesSyncMessages = showStreamingText || !isLoading;
const displayedMessages = viewedAgentTask ? viewedAgentTask.messages ?? []
  : usesSyncMessages ? messages : deferredMessages;
```

物理动作：**急件改走加急通道**。当流式文本正在显示（或对话已结束），消息列表**绕过延迟，直接同步渲染**（`messages` 而非 `deferredMessages`）。原因（注释 `:4501-4505`）：让"最后一帧正式消息出现"和"流式文本清空"**在同一帧完成**，避免出现"spinner 已消失但答案还没显示"的缝隙。延迟只在**纯加载中、用户可能在打字**时启用。

综合看：`useDeferredValue` 是**"让位给打字"**的保险，但一旦需要"流式收尾同步"，又**精确地在那一帧取消让位**——两个目标按场景切换，不冲突。

### 10.7 三道保险 vs 你"让 AI 执行方案就混乱"的根因

把你遇到的现象和上面三道对照：

| 保险 | Claude Code 怎么做 | 缺了它会怎样（=你的现象） | 源码 |
|------|-------------------|------------------------|------|
| **① 优先级解耦** | `useDeferredValue(messages)` 把昂贵的消息渲染降到 transition 优先级，打字永远插队 | 昂贵渲染和打字同优先级 → 敲一个字拖着整棵树重算 → 打字卡、整屏抖 | `REPL.tsx:1318` |
| **② 16ms 节流** | `throttle(onRender, 16, {leading,trailing})` 每 16ms 至多刷一帧，只刷最新状态 | 每次状态变就立刻整屏重绘 → "一键一帧"疯狂重绘 → 终端肉眼混乱 | `ink.tsx:213`、`constants.ts:2` |
| **③ 自动批处理** | React 18 自动合并同回调内多个 setState | 多个 setState 各刷一次 → 一个字刷两三次 → 雪上加霜 | `REPL.tsx:1340-1363` |

**你"让 AI 执行方案就一键一帧重绘混乱"的最可能根因是缺了②（节流）**——AI 写的方案多半是"每次按键 `on('data')` 里 `process.stdout.write` 直接重画整个输入框"，**完全没有 16ms 节流**这一层。敲一个字就立刻擦框、重画框，在肉眼（刷新率高、终端滚动）看来就是"输入框在反复闪烁、位置乱跳"。

mi-code 现状（`src/index.ts`）也正是如此：`on('data', …)` 里每个可打印字符分支（`index.ts:406-421`）都直接调 `renderPrompt()` → `eraseInputBox()` + `drawInputBox()` → `process.stdout.write`，**没有任何节流、没有优先级解耦**。所以即便不接 Claude Code 的整套 React/CInk，光是给重绘**加一个 16ms（或更宽，如 32~50ms）的 throttle，只画最新状态**，就能消掉你看到的"一键一帧混乱"。

> 💡 这是 Claude Code 整套机制里**和 React/Ink 解耦度最低、最容易移植**的一招：**"把所有重绘请求丢进一个节流器，定时只刷最新一帧。"** 不需要 React、不需要 Yoga、不需要 diff——一个 lodash `throttle` 或手写定时器就能拿到大部分收益。另两道（优先级解耦、批处理）在不用 React 的情况下，可由"输入框增量更新只改局部格子、不重算整树"来近似替代。

---

## 附录：术语表

### A. ANSI/DEC 序列速查（按物理动作）

| 缩写 | 序列 | 物理动作 | 本文出处 |
|------|------|---------|---------|
| CR | `\r` | 回本行最左 | 第四节 4.2 |
| CUU/CUD/CUF/CUB | `\x1b[<n>A/B/C/D` | 相对走 n 步（上/下/右/左） | 第四节 4.1 |
| CHA | `\x1b[<col>G` | 走到本行第 col 列 | 第四节 4.1 |
| CUP | `\x1b[<r>;<c>H` | 走到绝对坐标 (r,c) | 第四节 4.1 |
| EL | `\x1b[2K` | 擦当前整行 | 第四节 4.2 |
| ED | `\x1b[2J` | 擦整屏 | 第四节 4.2 |
| DECSTBM | `\x1b[<t>;<b>r` | 划滚动区域（仅性能优化） | 第四节 4.4 |
| DEC 1049 | `\x1b[?1049h/l` | 切备用屏 / 切回主屏 | 第四节 4.3 |
| DEC 2026 (BSU/ESU) | `\x1b[?2026h … l` | 同步更新（原子揭幕） | 第四节 4.3、第六节 |
| DEC 25 | `\x1b[?25h/l` | 显示/隐藏光标 | 第四节 4.3 |

### B. 核心概念

| 术语 | 第一性原理 | 源码 |
|------|-----------|------|
| **Frame（帧）** | 一张和屏幕一样大的**格子纸**，每格一个字符+样式 | `src/ink/frame.ts` |
| **diff（增量）** | 新旧两张格子纸**逐格比对**，只挑不同的格子 | `log-update.ts:308` `diffEach` |
| **VirtualScreen（虚拟光标）** | 自己手里**备的小地图**，记账打印头位置，只发相对指令 | `log-update.ts:752` |
| **useDeclaredCursor（声明式光标）** | 输入框**贴的便签**："最后把笔放我这儿" | `use-declared-cursor.ts` |
| **主屏模式** | 画布是主屏，**带 scrollback**，能用滚动条 | 不挂 `AlternateScreen` |
| **备用屏模式** | 换一块**锁死高度的画布**，没 scrollback，自己滚 | `AlternateScreen.tsx` |
| **fullReset** | 已进 scrollback 的行要变时，**整屏重画**（会闪） | `log-update.ts:382` |
| **节流** | token 再密，**每帧最多绘一次** | `ink.tsx`（约 `:212-216`） |

---

> **文档边界声明**：本文为**纯原理调研**，不包含 mi-code 的改造实现代码。第八节仅作技术路线选型对比。如需 mi-code 落地方案，应另起设计文档（可基于本文第八节路线②，复用 mi-code 已有但未接线的 `VirtualScreen`/`frame-renderer`/`renderer`）。
