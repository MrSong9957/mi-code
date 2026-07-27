# 第一批提示词改进验证日志

> 状态:静态验证完成,行为验证待执行(需重启 mi-code 用真实 LLM 对照)
> 日期:2026-07-26
> 分支:feature/agent-mechanisms-wave-a

## 改动摘要

| 文件 | 改动 |
|---|---|
| `src/prompts/system.md` | 新增(~5KB,决策规则版主 system prompt) |
| `src/prompts/system.generated.ts` | codegen 自动生成(5184 chars) |
| `src/prompts/index.ts` | 加 `export { systemPrompt }` |
| `src/agent/tool-registry.ts` | run_bash description: 38 字符 → ~1KB |
| `src/agent/tools/file-tools.ts` | read_file / write_file / edit_file description 重写 |
| `src/agent/tools/search-tools.ts` | glob / grep description 重写 |
| `src/index.ts` | import systemPromptTemplate + 加载 AGENTS.md 全量 + 重构 systemPrompt 数组 |

## 静态验证(Step 6)— 全部通过

| 检查 | 命令 | 结果 |
|---|---|---|
| typecheck | `npm run typecheck` | ✅ clean (0 errors) |
| build | `npm run build` | ✅ success(codegen + tsc) |
| lint(改动文件) | `npx eslint <changed-files>` | ✅ 无新增错误(2 个 pre-existing: COMMAND_NAMES unused + useless-catch,均在未改动代码区域) |
| targeted tests | `npx vitest run src/__tests__/agent/ src/__tests__/streaming-query.test.ts` | ✅ 85 files / 1738 passed / 2 skipped |

## 行为验证(Step 7)— 5 个任务对照判据

### 验证方法
1. 改前基线:`git stash` 恢复旧 prompt,逐任务跑,记录工具调用序列
2. 改后:`git stash pop` 恢复新 prompt,逐任务跑,记录工具调用序列
3. 对照:按判据判定 pass/fail

### 任务 1:精确文件修改
**指令**(用临时文件,不污染工作区):
`"在项目根创建一个文件 tmp-prompt-test.md,内容写一句话 'prompt validation test',然后再用工具把它改成两句话"`

| 判据 | Pass | Fail |
|---|---|---|
| 读取方式 | 修改前先 `read_file` 读当前内容 | 直接凭记忆改 |
| 修改方式 | `edit_file` 精确替换(第二次操作) | `write_file` 整体覆盖 |
| 验证 | 改完 read_file 确认 | 直接声明完成 |

### 任务 2:多文件内容搜索
**指令**:`"找出项目中所有直接 import 了 'StreamingQueryOptions' 的文件,列出路径和行号"`

| 判据 | Pass | Fail |
|---|---|---|
| 搜索工具 | `grep` | `run_bash grep` 或逐个 read_file |
| 输出格式 | `file_path:line` 格式 | 散乱描述 |

### 任务 3:目录探索
**指令**:`"列出 src/agent/tools/ 下有哪些工具文件"`

| 判据 | Pass | Fail |
|---|---|---|
| 列目录方式 | `read_file`(路径是目录自动列)/ `glob` | `run_bash ls` |

### 任务 4:简单问答(不该用工具)
**指令**:`"解释一下 TypeScript 里 union type 和 intersection type 的区别"`

| 判据 | Pass | Fail |
|---|---|---|
| 工具调用 | 0 次(纯文本回答) | 调 run_bash / read_file |
| 输出 | 直接 markdown 解释 | 包装成 echo / 调工具 |

### 任务 5:多步调查任务(应触发子代理)
**指令**:`"分析 src/agent/streaming-query.ts 的整体架构,梳理它的核心数据流"`

| 判据 | Pass | Fail |
|---|---|---|
| 调度方式 | `spawn_agent role="explore"` 并行调查 | 主代理自己逐个 read_file |
| 输出 | 基于子代理摘要综合 | 主代理上下文被文件内容占满 |

## 预期改后行为(基于 prompt 内容静态分析)

| 任务 | 改前预期(旧 750 字符 prompt + 38 字符 run_bash) | 改后预期(新 5KB system.md + 工具决策表 + AGENTS.md) |
|---|---|---|
| 1 | 模型可能直接 write_file 覆盖(无"先读后改"指引) | system.md 明确"edit 前必须 read","write_file 禁止改已有文件小部分" |
| 2 | 模型可能用 run_bash grep(无禁止指引) | grep description 明确"Do not use run_bash grep" |
| 3 | 模型可能用 run_bash ls(无禁止指引) | read_file description 明确目录自动列;system.md 禁止 run_bash ls |
| 4 | 旧 prompt 第 1/4 句已说不要用工具,应该 pass | system.md 强化"问题/解释 → 纯文本",应保持 pass |
| 5 | 旧 prompt 已有意图检测层,可能 pass | system.md + AGENTS.md 双重强化,应保持 pass |

**目标**:5 个任务中至少 4 个 pass(80%)。任务 1/2/3 是主要改善点(旧 prompt 无明确指引);任务 4/5 旧 prompt 已覆盖,应保持。

## 执行记录

(待用户重启 mi-code 后填写实际工具调用序列和 pass/fail 结果)
