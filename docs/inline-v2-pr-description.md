# feat(inline): migrate to Ink reconciler + `<Static>` (V2)

## 改动

inline 模式从手动 `InlineRenderer.commit()` 迁移到 stock Ink reconciler + `<Static>` + `createIncremental`,消除流式输出累积重复帧 bug。

### 新增 V2 路径
- `<InlineAppV2>`:根组件,`<Static>` 包已固化消息(进 scrollback 一次),活动区 spinner/streaming/footer 走 Ink reconciler 行级 diff
- `<MessageLine>` / `<StreamingText>` / `<SpinnerMemo>` / `<FooterV2>` / `<SelectOverlayV2>` / `<OverlayHost>`:各 memo + 局部订阅,spinner tick 爆炸范围严格限制在 `<SpinnerMemo>` 内部
- OverlayHost:Ctrl+O 进终端备用屏显示 thinking/tool_result 全文(word wrap,完整保留)

### 删除 V0 路径(Stage 5b)
- ~1500 行 V0 手动渲染代码:`InlineRenderer` / `InlineApp` / `InlineFooter` / `SpinnerLine` / `layout` / `diff` / `render-state` / `grid-renderer` / `inline-dynamic-grid` / `streaming-grid-renderer` / `spinner-visibility` / `use-throttled-streaming-text` 等 16 个文件
- ~3000 行 V0 专属测试(36 个文件)
- `MICODE_INLINE_V2` flag(env var 保留为 no-op 向后兼容)

## 修复的 bug

| Bug | 根因 | 修复 |
|---|---|---|
| **流式输出累积重复帧**(原始目标) | V0 InlineRenderer.commit() 每帧全量重写活动区 | Ink `<Static>` 一次性写入 scrollback + createIncremental 行级 diff |
| LOGO 缺失 | InlineAppV2 漏接入 LogoBox | logo 作为 `<Static>` 首项 |
| LOGO 间歇消失 | Overlay 根元素切换导致 `<Static>` identity 变化,Ink 清空 fullStaticOutput | Overlay 改为同根条件子树 |
| Resize 残留旧 border | Ink incrementalRendering 不擦 scrollback | ConnectedApp 检测 cols 变化 + 清屏序列 + key 重挂载 |
| Overlay 盖住 footer | Overlay 在活动区渲染 | Overlay 改走终端备用屏(OverlayHost) |
| Overlay 退出后 footer 不恢复 | overlayVisible 时隐藏活动区让 Ink lastOutput 变空 | 活动区始终渲染(被备用屏遮住) |
| Overlay 内容截断 | truncateByWidth 丢弃超宽字符 | 改为 wrapByWidth 按宽度折行 |

## 验证

### 自动化测试
- **inline-v2 模块**:101 个测试通过(17 文件),含:
  - POC 回归(3 个):`<Static>` 只写一次、spinner tick 未变行不重写、tick 帧字节 << 完整活动区
  - 原始 bug 端到端回归(5 个):流式+spinner 并发不累积重复帧
  - L1 E2E(14 个):启动/输入/Select/Overlay/ESC/多轮对话
  - memo 隔离(4 个):spinner tick 不触发 FooterV2 重渲染
  - finalizeStreaming 原子性(4 个):subscribe 只触发 1 次
  - logo 不变量(12 个):各场景 logo 始终在最顶
  - OverlayHost 契约(8 个):备用屏序列 + wrap + 防御性退出
  - footer 恢复(5 个):Overlay 切换后 footer 仍在
  - resize(2 个):cols 变化时清屏序列
- **全量测试**:1654 通过(删除 V0 后总数降),仅 2 个 pre-existing alt-screen StatusBar 失败(与本 PR 无关,Stage 3 之前就存在)
- **TypeScript** + **lint**(inline-v2 范围零 error)通过

### 量化基线(原始 bug 修复验收)
- spinner tick 帧:从 V0 ~412B 降到 V2 ~8B(减少 **98%**)
- 600ms 流式+spinner 并发总字节:V2 1557B(V0 路径预期 4800B+,节省 **>90%**)
- `<Static>` 写入次数:1 次(V0 路径会达几十次)

### 手工验证
- LOGO 显示 + 多次 resize + 多次 Ctrl+O 切换:全部正常
- 真实 LLM 对话(思考/工具调用):spinner 流畅、footer 不闪、固化消息进 scrollback
- Ctrl+O 备用屏显示完整 thinking 内容(word wrap)

## 关联

- Spec: `docs/superpowers/specs/2026-07-20-inline-v2-architecture-design.md`
- Plan: `docs/superpowers/plans/2026-07-20-inline-v2-architecture.md`
- 原始问题: `docs/流式输出无限循环问题.md`
- 调研记录: `docs/流式输出无限循环问题-CC讨论记录.md`
- 渲染快照: `docs/inline-v2-render-snapshots.md`

## 统计

- 62 commits(从 worktree 准备到 V0 删除)
- Stage 0~5b 全部完成
- 净代码:-8689 行(删 V0) + ~3000 行(V2 + 测试)
