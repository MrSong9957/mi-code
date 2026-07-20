# V2 inline 模式渲染快照

> 自动生成于 scripts/render-snapshots.tsx,展示 V2 路径典型场景的最终渲染帧。
> ANSI 颜色码已剥离,只保留布局结构。
> 终端尺寸:80x24

### 场景 1:启动(空消息)

```
 ▐▛███▜▌   MiCode v1.0.0
▝▜█████▛▘  TypeScript CLI · Node.js Runtime
  ▘▘ ▝▝    Projects/mi-code

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
build │ sonnet │ Projects/mi-code │ main │ ░░░░░░░░░░ 0%
```

### 场景 2:两轮对话(已固化)

```
 ▐▛███▜▌   MiCode v1.0.0
▝▜█████▛▘  TypeScript CLI · Node.js Runtime
  ▘▘ ▝▝    Projects/mi-code

你好

● 你好!有什么可以帮你的吗?

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
build │ sonnet │ Projects/mi-code │ main │ ░░░░░░░░░░ 0%
```

### 场景 3:流式响应中(spinner + 草稿)

```
 ▐▛███▜▌   MiCode v1.0.0
▝▜█████▛▘  TypeScript CLI · Node.js Runtime
  ▘▘ ▝▝    Projects/mi-code

写首诗

● 秋风起
  落叶飞

· Refining… (1s)
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
build │ sonnet │ Projects/mi-code │ main │ ░░░░░░░░░░ 0%
```

### 场景 4:Select 选择器(/model)

```
 ▐▛███▜▌   MiCode v1.0.0
▝▜█████▛▘  TypeScript CLI · Node.js Runtime
  ▘▘ ▝▝    Projects/mi-code

  Select model
  > Sonnet     fast
  Opus       powerful
  Haiku      cheap
  ↑↓ navigate · Enter confirm · Esc cancel
```

### 场景 5:Overlay(Ctrl+O 显示 thinking)

```
Thinking output
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
让我思考一下这个问题...
  首先需要理解用户意图
  然后给出合适的回答

按 q / Ctrl+O / Esc 返回
```

### 场景 6:多行输入(代码粘贴)

```
 ▐▛███▜▌   MiCode v1.0.0
▝▜█████▛▘  TypeScript CLI · Node.js Runtime
  ▘▘ ▝▝    Projects/mi-code

────────────────────────────────────────────────────────────────────────────────
❯ def hello():      print("world")      return 42
────────────────────────────────────────────────────────────────────────────────
build │ sonnet │ Projects/mi-code │ main │ ░░░░░░░░░░ 0%
```

