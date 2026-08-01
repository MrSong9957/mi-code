# Ctrl+J 多行输入修复 —— 调查与设计

> 分支:`fix/ctrl-j-multiline-input`(基于 master `984f7f3`)
> 状态:**设计阶段(只读探索)**
> 日期:2026-08-01
> 注意:本文档为未提交工作区文件,仅供调查归档,不进入提交。

## 问题

Ctrl+J 应在输入框插入换行(`\n`)并增高输入框,但实测无换行、高度不变。

## 已查清的事实(静态分析)

### Ink 7.1.0 主输入数据流

```
终端字节
  │  stdin raw mode + setEncoding('utf8')   [App.js:217]
  ▼
stdin 'readable' 事件                          [App.js:206]  ← 唯一主订阅(拉模式)
  ▼
handleReadable() → stdin.read() → chunk        [App.js:175-199]
  ▼
inputParser.push(chunk)                        [App.js:180]
  │  input-parser.js:跨 chunk 缓冲 + escape 序列切分
  │  ★ 注释明示:\r \t \n 不拆分(可在粘贴文本中合法出现)[input-parser.js:107]
  ▼
emitInput(event) → internal_eventEmitter.emit('input', input)  [App.js:162,183]
  ▼
useInput handleData(data)                      [use-input.js:39]
  ├─ parseKeypress(data)
  │    \n → {name:'enter', sequence:'\n', ctrl:false}   [parse-keypress.js:420]
  ├─ key.return = (name==='return') → false    [use-input.js:50]  ★ \n 是 'enter' 非 'return'
  ├─ input = keypress.sequence = '\n'          [use-input.js:89]
  └─ nonAlphanumericKeys.includes('enter')? false → 不清空  [use-input.js:92]
     ⇒ 静态推导:最终 input = '\n'
```

### 三层静态证据一致指向 `input = '\n'`

| 证据 | 来源 | 结论 |
|---|---|---|
| 运行时验证 | `node -e parseKeypress('\n')` | `input` 最终 = `'\n'` |
| 全链路追踪 | App.js → input-parser → use-input | `input` 应 = `'\n'` |
| 注释明示 | input-parser.js:107 | `\n` 不拆分,原样保留 |

### 与真实观测的矛盾(核心阻塞)

之前调试观测到 `input=""`,但:
- 三层静态分析都说应是 `'\n'`;
- 之前那次观测有缺陷(中文 IME 拦截 Ctrl+J;打印字段不含 `name`/`sequence`;输出无法明确对应按键)。

**真实送达值待终端字节探针确认。**

## 终端字节探针(待执行)

脚本:`$env:TEMP\ctrl-j-probe.cjs`(仓库外,不提交)

执行(PowerShell):
```
node "$env:TEMP\ctrl-j-probe.cjs"
```
依次按:Ctrl+J、Enter、Ctrl+C

### 观测结果

```
{"n":1,"note":"(应是 Ctrl+J)","hex":"0a","json":"\"\\n\"","bytes":[10],"length":1}
{"n":2,"note":"(应是 Enter)","hex":"0d","json":"\"\\r\"","bytes":[13],"length":1}
{"n":3,"note":"(应是 Ctrl+C,退出)","hex":"03","json":"\"\\u0003\"","bytes":[3],"length":1}
```

| 按键 | hex | 字节 | 字符 |
|---|---|---|---|
| Ctrl+J | `0a` | `[10]` | `\n` |
| Enter | `0d` | `[13]` | `\r` |
| Ctrl+C | `03` | `[3]` | `\u0003` |

### Ink 完整链路实证(node 模拟 `\n` 经 input-parser + parseKeypress)

```
input-parser.push('\n') → events: ["\n"]           (原样传出,不拆分)
→ handleData data: "\n"
→ parseKeypress: {name:'enter', ctrl:false, sequence:'\n'}
→ 最终送达 handler: input="\n", key.return=false
```

### 判定

- [x] **Ctrl+J=`0a`、Enter=`0d`**

**推翻之前的 `input=""` 判定**:之前那次项目内 handler 日志观测到 `input=""` 是有缺陷的——中文 IME 拦截了 Ctrl+J,加上打印字段不含 `name`/`sequence`,把别的键误判为 Ctrl+J。真实字节是 `0a`,经 Ink 完整处理后 handler 收到 `input='\n'`。三层证据一致(终端探针 + node 实证链路 + 静态分析)。

## 实际根因与第一阶段修复

> 本节为探针后的最终结论。早期推测过的"raw 字节拦截"与"改 handler 加 if"两条路径均已排除:前者因字节已是 `0a` 不成立,后者因根因不在 handler 而不成立。

### 真实根因(第一阶段定位)

Ctrl+J 的 `\n` **已经能进入 input store**(经 `use-input-handler.ts:252` 的可打印字符分支 `s.insert('\n')`,与 `insertNewline()` 文本效果等价)。输入层、store、光标定位**都正常**。

真正的问题在 **Footer 渲染层**:`Footer.tsx:73` 与 `FooterV2.tsx:78` 的内层 `<Box>`(包裹多行 SelectionText 的容器)**没有指定 `flexDirection`**。Ink 的 `<Box>` 默认 `flexDirection: 'row'`(`node_modules/ink/build/components/Box.js:21`),导致多个 SelectionText(每行一个)被**水平排列**到同一行,`AAA` + `  888` 拼成 `❯ AAA  888`。

表征测试证据(渲染 `AAA\n888`):
```
4: "❯ AAA  888"        ← AAA 和 888 在同一行(水平拼接)
inputAreaHeight = 1    ← 输入区只有 1 行高
```

`footer-v2-memo.test.tsx:54-56` 的注释**早就记录了这个现象**("直接 render FooterV2 时 Ink 把多个 SelectionText 输出到同一行"),但把它归因为"没有外层 column 撑开上下文"——这个归因是错的,真正原因是**内层 Box 自己缺 flexDirection=column**(经 App 有外层 column 仍同行证实)。

### 第一阶段修复(commit `a76bc25`)

给两个内层 Box 加 `flexDirection="column"`:
- `Footer.tsx:73` → `<Box flexDirection="column" {...{ internal_cursorTarget: true }}>`
- `FooterV2.tsx:78` → 同上

未改:Ctrl+J 输入处理、input store、paste、Enter 提交、固定 5 行视口策略。

**真实终端验收通过**:多行纵向分行正确,光标位于内容区。

## 第二阶段(动态 1–5 行高度)

第一阶段修复后,分行正确,但输入区仍**固定撑到 5 行**(补空行)。第二阶段改为动态 1–5 行,设计见 `docs/ctrl-j-stage2-design.md`(物理行模型,采用应用层 `wrapLine`,待审查)。
