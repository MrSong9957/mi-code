# Known Issue: Ink border 右边框首次渲染缺失

日期:2026-07-24
状态:已定位,待修复(独立于 AUTO-0025 PR1)
影响:所有 Ink `borderStyle` box(AskQuestionOverlay、ExitPlanMode、输入框分隔线)

## 现象

```
启动 → 首次渲染 overlay/输入框
  ↓
右边框 ╮/╰/│ 缺失(顶部边框停在 cols-1 宽,无闭合字符)

resize(缩放窗口) → 触发 Yoga 重排
  ↓
右边框恢复正常

再次 resize(放大)→ 右边框保持正常
```

## 复现环境

- Ink 7.1.0
- `incrementalRendering: true`(Inline V2 路径,`src/tui/bootstrap.tsx:197`)
- node-pty / Windows ConPTY
- 非 alt-screen 模式(`alternateScreen: false`,inline 默认)

## 关键证据(ConPTY + screen-replay 实测)

| 实验 | 结果 |
|------|------|
| micode 主程序首次渲染 overlay | 右边框缺失,顶部边框宽 99(cols=100) |
| micode 输入框分隔线(master) | 同样 99 宽(既存,非 AUTO-0025 引入) |
| **独立 Ink render**(`render(<Overlay>)`,非 incremental) | **右边框完整** |
| pty resize 后重新捕获 | 右边框完整恢复 |
| 改 contentWidth(cols-4/5/8) | 无效,border 宽度始终 cols-1 |
| Box 加 `width`/`maxWidth` 约束 | 无效,右边框仍缺失 |
| DEBUG 日志:首次 render 的 cols | cols=100(React 层值正确) |

## 根因判断(不锁责任归属)

**Ink 渲染链路中的首次布局兼容性缺陷**,具体层:

- Ink `calculateLayout`(`node_modules/ink/build/ink.js:322-326`)每次按 `stdout.columns` 设根 width
- 首次渲染时,incrementalRendering 模式下 Yoga 布局与 stdout.columns 报告时序不一致
- 导致 border 右边框字符溢出到不可见位置
- resize 触发完整重排(`ConnectedApp.tsx:105-116` 的 v2ResizeKey 重挂载),修正布局

**不能完全证明是 Ink 底层 bug**,仍可能是:
- Ink 对 Yoga layout 时序处理
- Ink 与 ConPTY 的交互
- terminal cell 最后一列不可写适配

## 影响范围(非 AUTO-0025 引入)

master 上已复现:
- ExitPlanMode overlay(用 plan 模式触发)
- 输入框 `─────` 分隔线

AUTO-0025 PR1 只是让闭合框(圆角边框)的缺失**视觉更醒目**(输入框横线不闭合,缺 1 列不明显)。

## 不在 AUTO-0025 PR1 范围内的理由

PR1 边界:`App UI → Ink component`。
右边框修复需要进入:`Ink component → Yoga layout → terminal renderer → PTY`,超出 UI 重构范围。
强行修会:改 Ink fork/monkey patch,影响 resize/alt-screen/cursor/其他 overlay,风险高于 PR1 本身。

## 未来修复方向(评估后选一)

- **A. 升级 Ink**(若新版修复了 incrementalRendering 的首次布局)
- **B. patch renderer**(在自研渲染层修正 border 边界)
- **C. 接受 terminal edge case**(overlay open 时主动触发一次伪 resize 强制重排,作为 workaround)

## AUTO-0025 PR1 验证(独立渲染,排除 incrementalRendering 干扰)

为排除 Ink bug 干扰,PR1 用独立 Ink render 验证 overlay 内容正确性:

| cols | 右边框 | tabs | radio | 内容折行 |
|------|--------|------|-------|----------|
| 80 | ✅ 完整 | ✅ 全显示 | ✅ ◯ | ✅ |
| 40 | ✅ 完整 | ✅ 全显示 | ✅ ◯ | ✅ |
| 24 | ✅ 完整 | ✅ CJK 截断 `认证配…`/`数…`/`✓ S` | ✅ ◯ | ✅ |

PR1 的 overlay 代码(contentWidth/tabs/radio/文案)在独立渲染下全部正确。
