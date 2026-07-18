# Spinner Tip 显示设计

## 目标

在 Spinner 运行期间，根据粗粒度耗时快照、用户是否使用过 `/btw` 以及外部传入的 `spinnerTip`，在 Spinner 下方显示一行暗灰色提示。Ink 与 inline 两种渲染模式必须使用相同的决策规则。

## 范围

本任务只实现 Tip 的状态、优先级、渲染和测试。`hasUsedBtw` 由外部传入；不实现 `/btw` 命令、使用记录采集或跨会话持久化。

## 状态与接口

Spinner Store 新增：

- `elapsedSnapshot: number`：按整秒截断的 Spinner 有效耗时快照。
- `spinnerTip: string | null`：外部提供的默认提示；空字符串按 `null` 处理。
- `hasUsedBtw: boolean`：外部提供的 `/btw` 使用状态。
- `setSpinnerTip(tip: string | null)`：更新默认提示。
- `setHasUsedBtw(hasUsed: boolean)`：更新使用状态。

Bootstrap 新增对应初始化选项和运行时 setter，使调用方无需直接操作 Store。

`elapsedSnapshot` 从现有毫秒级统一时钟派生：`Math.floor(time / 1000) * 1000`。它随 `tick()` 更新，但 Tip 规则只读取该粗粒度值，不直接读取 50ms 动画时间。

## Tip 决策规则

共享纯函数接收 `elapsedSnapshot`、`hasUsedBtw` 和 `spinnerTip`，按以下优先级返回字符串或 `null`：

1. `elapsedSnapshot >= 1_800_000`：`Use /clear to start fresh when switching topics...`
2. `elapsedSnapshot >= 30_000 && !hasUsedBtw`：`Tip: Use /btw to ask a quick side question...`
3. 其他情况：返回规范化后的 `spinnerTip`
4. `spinnerTip` 为空或仅含空白时返回 `null`

30 分钟规则优先于 30 秒规则，因此即使用户从未使用 `/btw`，超过 30 分钟后也显示 `/clear` 提示。

## 渲染与布局

- Tip 只在 Spinner active 且决策函数返回非空字符串时显示。
- Tip 使用主题 `textMuted` 暗灰色，不参与 shimmer、stalled 或 thinking 动画。
- Ink：新增独立 Tip 行，紧跟在 Spinner 行下方。
- Inline：Footer 布局新增可选 `spinnerTipLine`；有 Tip 时行序为“空行、Spinner、Tip、输入框上边框”，无 Tip 时保持现有布局。
- Tip 消失后不保留空白占位行；Footer 高度由现有重绘机制重新计算。

## 数据流

`bootstrap options/setter` → `spinner-store` → `resolveSpinnerTip()` → Ink Tip 组件或 inline Footer 行。

两种渲染路径不得各自实现阈值判断，以共享纯函数作为唯一规则来源。

## 测试

- 纯函数边界：29,999ms、30,000ms、1,799,999ms、1,800,000ms。
- 优先级：30 分钟 `/clear` 覆盖 `/btw` 和自定义 Tip。
- `/btw` 状态：使用过时跳过内置 `/btw` 提示并回退到 `spinnerTip`。
- 空值：无可用 Tip 时不渲染、不增加 Footer 高度。
- Ink：Tip 在 Spinner 下方且使用 muted 样式。
- Inline：有/无 Tip 时 Footer 行序和高度正确。
- 生命周期：`start()` 重置 `elapsedSnapshot`；暂停时快照冻结；`stop()` 清除显示。

## 非目标

- 不实现 `/btw` 命令。
- 不保存 `/btw` 使用历史。
- 不轮换多条 Tip。
- 不增加新的定时器。
