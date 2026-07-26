# Claude Prompt Library Import Design

> 状态：冻结
> 设计日期：2026-07-26
> 任务类型：第三方 Prompt 资产归档
> 本文只定义复制范围和管理边界，不执行复制、不接入运行时

## 1. 目标

将现有 Claude Code system prompts 源目录中的 250 个 Markdown Prompt 文件完整复制到 mi-code，形成一个可追溯、可校验、与运行时代码隔离的第三方 Prompt 快照。

本任务解决的是“Prompt 资产统一存放和来源管理”，不解决 Prompt 选择、适配、评测或运行时编译。

## 2. 输入

源目录：

```text
D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts
```

需要复制：

```text
system-prompts/**/*.md
LICENSE
```

当前确认的 Prompt 文件数为 250。

源目录没有 `.git` 元数据，不能验证正式 git tag。目录名中的版本线索不作为快照版本依据，因此使用复制日期作为快照标识。

## 3. 目标目录

```text
prompts/
└── vendor/
    └── claude-code/
        ├── v2026-07-26/
        │   └── system-prompts/
        │       └── 250 个上游 Markdown Prompt 原文件
        ├── LICENSE
        └── manifest.json
```

### 3.1 目录语义

- `v2026-07-26/`：不可变的上游内容快照。
- `system-prompts/`：保持源目录内部结构和文件名。
- `LICENSE`：Claude Code Prompt 来源仓库的许可证副本，位于供应商根目录，供所有快照共享。
- `manifest.json`：mi-code 生成的管理清单，不属于上游快照内容。

版本目录中只放上游 Prompt 原文件。mi-code 管理文件不得混入版本目录。

## 4. 复制规则

1. 全量复制 `system-prompts/` 下 250 个 Markdown 文件。
2. 保持相对路径和文件名不变。
3. 保持文件字节不变，包括 frontmatter、HTML metadata、换行和空白。
4. 不进行 Claude→mi-code 名称替换。
5. 不展开模板变量或条件表达式。
6. 不重新分类、不合并、不拆分 Prompt 文件。
7. 不根据现有候选清单筛选文件。
8. 不复制源仓库的 README、CHANGELOG、CLAUDE.md 或工具脚本。
9. 复制上游 `LICENSE` 到 `prompts/vendor/claude-code/LICENSE`。
10. 如果目标快照目录已经存在且内容不同，执行者必须停止，不得覆盖。

## 5. manifest.json

`manifest.json` 是 mi-code 侧唯一的快照管理元数据文件，同时承担原 `SOURCE.md` 的来源记录职责。

建议结构：

```json
{
  "schema_version": 1,
  "library": "claude-code-system-prompts",
  "snapshot_id": "v2026-07-26",
  "source": {
    "local_path": "D:\\Files\\Obsidian\\sources\\claude-code\\claude-code-system-prompts",
    "git_tag": null,
    "git_commit": null,
    "captured_on": "<actual execution date: YYYY-MM-DD>",
    "license": "MIT"
  },
  "content": {
    "root": "v2026-07-26/system-prompts",
    "file_count": 250
  },
  "files": [
    {
      "path": "v2026-07-26/system-prompts/<relative-path>.md",
      "bytes": "<source bytes>",
      "sha256": "<64 lowercase hex>"
    }
  ]
}
```

### 5.1 清单规则

- `files` 按 `path` 升序排列，保证输出确定。
- `path` 使用相对 `prompts/vendor/claude-code/` 的 `/` 分隔路径。
- `bytes` 使用源文件实际字节数。
- `sha256` 对源文件原始字节计算。
- manifest 的 `sha256` 覆盖完整 Markdown 原始字节，包括 frontmatter 和提取器 metadata；Prompt Content Adaptation 文档的 `source_hash` 只覆盖去除这些包装后的 Prompt body。两者计算口径和用途不同，不得假定相等或直接用作跨文档关联键。
- `manifest.json` 使用 UTF-8 无 BOM 编码。
- `file_count` 必须与 `files.length` 一致。
- `git_tag` 和 `git_commit` 在缺少可验证证据时必须为 `null`，不得根据文件内容推测。
- `captured_on` 使用实际复制执行日期，与 `snapshot_id` 的批准标识解耦。
- `manifest.json` 不登记自己，避免递归哈希。
- `LICENSE` 不进入 Prompt 文件计数；其存在性单独验收。

## 6. 非目标

本任务不包括：

- 修改 `src/` 或任何生产代码；
- 修改现有 Prompt 拼接逻辑；
- 将任何 Prompt 激活到运行时；
- 创建 Prompt Registry、Compiler 或 Loader；
- 对 Prompt 做 Copy、Minimal-Edit、Rewrite、Exclude 分类；
- 行为评测、token 预算评估或安全评审；
- 自动同步上游仓库；
- 编写长期维护脚本；
- 删除或改写既有设计、Baseline、Mechanism Index、Gap Matrix 或适配分析文档；
- Git commit、push 或 PR。

`2026-07-26-prompt-content-adaptation.md` 保留为历史分析材料，但不是本任务的复制输入或验收依据。

## 7. 失败与停止条件

出现以下任一情况时，执行者必须停止并报告，不得自行修复源内容：

1. 源 Prompt 文件数不是 250。
2. 源文件读取失败。
3. 目标快照目录已存在且任一文件哈希不同。
4. 复制后任一目标文件哈希与源文件不同。
5. 源 `LICENSE` 缺失。
6. manifest 中存在重复路径、绝对路径或非 Markdown Prompt 条目。
7. 执行过程需要修改 `src/` 才能继续。

如果未来快照发现上游许可证发生变化，不得直接覆盖共享 `LICENSE`；应先重新决定许可证的版本化布局。

## 8. 验收标准

执行完成必须同时满足：

1. `v2026-07-26/system-prompts/` 中恰有 250 个 Markdown 文件。
2. 执行前目标快照目录不存在；如果目录已经存在，则其中全部既有文件必须与本次源文件哈希一致，并且执行过程没有覆盖任何不同内容。
3. 源与目标的相对路径集合完全一致。
4. 250 个文件逐一 SHA-256 相同。
5. `manifest.json` 可解析，字段完整，文件数、字节数和哈希与目标快照一致。
6. `LICENSE` 存在且与源许可证 SHA-256 相同。
7. 没有未在 manifest 登记的目标 Prompt 文件。
8. `src/`、现有运行时 Prompt 和冻结规格没有发生变化。
9. 没有执行 Git commit、push 或 PR。

## 9. 后续关系

该快照只是参考资产库。未来若要使用其中某个 Prompt，应在独立任务中完成选择、适配、评测和运行时接入；不得因为文件已进入 `prompts/vendor/` 就视为已批准或已激活。
