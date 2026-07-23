# Auto Mode 权限系统升级方案

## 一、目标定义

Auto Mode 的最终语义应当是：

> 自动放行所有已经通过硬安全检查、路径边界检查和用户策略检查的操作。

它不应该表示：

> 无条件执行所有工具调用。

建议将内部模式名称从 `auto` 改为：

```typescript
type PermissionMode =
  | 'default'
  | 'guardedAuto';
```

配置层继续兼容旧值：

```typescript
auto -> guardedAuto
```

这样可以避免把本地 `auto` 与 Claude Code 的内部 `auto`、外部 `bypassPermissions` 混为一谈。

---

## 二、威胁模型

权限系统需要防御四类风险：

| 风险     | 示例                    | 主要防线        |
| ------ | --------------------- | ----------- |
| 主机破坏   | `sudo`、`mkfs`、删除根目录   | 硬安全检查       |
| 工作区越界  | 写入 `/etc`、用户主目录       | 路径围栏        |
| 用户策略违反 | 修改 `.env`、禁止运行部署命令    | deny/ask 规则 |
| 静态分析失效 | 动态变量、复杂 Shell、运行时路径变化 | 默认询问、沙箱     |

核心原则：

1. **明确危险：deny**
2. **无法确定：ask**
3. **确认安全：allow**
4. Auto Mode 只能把第三类自动放行，不能把前两类转换为 allow。

---

## 三、目标权限管道

建议把当前四步管道逐步演进为六个 Gate。

```text
工具调用
   ↓
Gate 0：输入规范化
   ↓
Gate 1：不可绕过的硬安全检查
   ↓
Gate 2：Shell 解析与路径边界
   ↓
Gate 3：用户和项目规则
   ↓
Gate 4：模式判定
   ↓
Gate 5：运行时沙箱与审计
   ↓
执行
```

### Gate 0：输入规范化

解决的问题：同一个操作可能通过不同字符串形式绕过规则。

处理内容：

* 规范化工具名称。
* 将相对路径转换为绝对路径。
* 解析 `~`、`.`、`..`。
* 统一 Windows 和 Unix 路径。
* 保存原始输入和规范化输入。
* 不执行 Shell 展开。

输出：

```typescript
interface NormalizedPermissionRequest {
  toolName: string;
  originalInput: unknown;
  normalizedInput: unknown;
  workdir: string;
}
```

---

### Gate 1：不可绕过的硬安全检查

这一层在所有模式下生效，包括 `guardedAuto`。

首个版本保留现有八条危险模式，并将其从单一正则数组改造成独立验证器：

```typescript
interface BashSafetyValidator {
  name: string;
  validate(command: string): SafetyFinding | null;
}
```

建议首批验证器：

```text
validatePrivilegeEscalation
validateDangerousRemoval
validateDiskOperations
validateCommandSubstitution
validateShellRedirection
validateForkBomb
validateSensitiveFiles
```

判定规则：

* 明确具有主机破坏风险：`deny`
* 只是复杂、无法判断：交给 Gate 2 返回 `ask`

不要在第一阶段直接复制二十多个验证器。先覆盖当前系统实际暴露的风险，再根据失败案例增加能力。

---

### Gate 2：Shell 解析与路径边界

这一层回答两个问题：

```text
这条命令实际要做什么？
它会操作哪些路径？
```

#### 2.1 Shell 解析器选型与能力边界

**核心约束：POSIX Shell 不是上下文无关文法。** `eval`、`source`、alias 展开、进程替换等构造无法静态解析。设计原则是**不追求完备，而是明确能力边界**。

**第一版选型：基于 `shell-quote` 的 tokenizer + 逐命令路径提取器。**

理由：
- `shell-quote` 已是项目依赖，零新增成本。
- 能处理高频场景：简单命令、管道、重定向、引号拼接（`'r''m'` → `rm`）。
- 对复合命令（`cd /tmp && rm -rf`）和动态构造（`bash -c "$VAR"`）无法可靠解析，统一返回 `ask`。

**不在第一版引入的方案：**

| 方案 | 不引入的原因 |
|---|---|
| tree-sitter/bash AST | Windows 无预编译 native，web-tree-sitter 引入 WASM 依赖，工程量远超收益 |
| 外部 `bash --ast` | 依赖外部进程，解析失败语义不清，跨平台兼容问题 |

**能力边界基准测试（里程碑二必须交付）：**

用 20-30 条真实历史命令验证漏报率和误报率。分类统计：

```text
resolved（精确提取路径）：预期 ≥ 60%（高频简单命令）
unresolved（升级 ask）：预期 ≤ 35%（变量、复合命令）
failed（解析失败，ask）：预期 ≤ 5%
```

若 resolved 比例低于 50%，说明 tokenizer 方案不够，需重新评估是否引入 AST。

**禁止采用"解析失败后 Auto Mode 自动放行"的策略。**

#### 2.2 解析可信度

统一使用三态结果：

```typescript
type ParseConfidence =
  | 'resolved'
  | 'unresolved'
  | 'failed';
```

对应行为：

| 状态           | 行为    |
| ------------ | ----- |
| `resolved`   | 继续检查  |
| `unresolved` | `ask` |
| `failed`     | `ask` |

例如：

```bash
cat "$KNOWN_FILE"       # 变量可以解析，继续检查
cat "$UNKNOWN_FILE"     # ask
bash -c "$COMMAND"      # ask
```

禁止采用“解析失败后 Auto Mode 自动放行”的策略。

#### 2.3 路径提取

第一版只实现高频命令：

```text
cd
ls
cat
cp
mv
rm
find
grep
sed
git
```

每个命令使用独立提取器：

```typescript
interface CommandPathExtractor {
  supports(command: ParsedCommand): boolean;
  extract(command: ParsedCommand): ExtractedPath[];
}
```

路径需要携带操作类型和副作用信息：

```typescript
interface ExtractedPath {
  path: string;
  access: 'read' | 'write' | 'delete' | 'execute';
  /** 预留：bash 命令的网络/远程副作用（第一版不实现，仅声明） */
  sideEffects?: ('network' | 'remote' | 'subprocess')[];
}
```

> 注：`sideEffects` 在第一版不实现判定逻辑。`git push`、`curl -X POST`、`npm publish` 等命令的网络风险由 Gate 1 的硬安全规则覆盖（如 `npm publish` 可加入 deny 规则），不依赖路径提取器分类。

#### 2.4 路径规则

检查顺序：

```text
显式 deny
   ↓
敏感文件检查
   ↓
是否位于 workdir
   ↓
是否位于 additionalDirectories
   ↓
显式 allow
   ↓
默认拒绝或询问
```

建议规则：

* 工作区内读取：允许继续。
* 工作区内写入：允许继续，但仍受用户规则控制。
* 工作区外读取：默认 `ask`。
* 工作区外写入或删除：默认 `deny`。
* 敏感路径：无论是否位于工作区都单独处理。

**Symlink 防护：** 路径边界检查必须使用 `realpath` 解析符号链接，防止通过工作区内 symlink 指向工作区外文件绕过围栏。检查逻辑：

```typescript
function isPathOutsideWorkspace(filePath: string, workdir: string): boolean {
  // 先 realpath 解析 symlink，再判断是否在 workdir 内
  const resolved = realpathSync(resolve(workdir, filePath));
  const normalizedWorkdir = resolve(workdir);
  const prefix = normalizedWorkdir.endsWith(sep) ? normalizedWorkdir : normalizedWorkdir + sep;
  return resolved !== normalizedWorkdir && !resolved.startsWith(prefix);
}
```

> 注：`realpath` 会访问文件系统。若路径不存在（写入新文件），`realpath` 会失败——此时回退到 `resolve` 做纯字符串判定。

#### 2.4.1 敏感路径规则表

敏感路径需按 access type 联合判定，不能只靠路径模式：

```typescript
interface SensitivePathRule {
  pattern: string;           // glob
  read: 'allow' | 'ask' | 'deny';
  write: 'allow' | 'ask' | 'deny';
  delete: 'deny';            // 对敏感路径始终 deny
}
```

首批规则：

| 路径模式 | read | write | delete | 说明 |
|---|---|---|---|---|
| `.git/` | allow | ask | deny | git status/diff 高频读取，写入（push/hook）需确认 |
| `.git/config` | ask | deny | deny | 含远程 URL 和凭据 |
| `.git/hooks/*` | ask | deny | deny | 可执行脚本 |
| `.env` | allow | deny | deny | 环境变量，永远不写 |
| `.env.*` | allow | deny | deny | 同上 |
| `.claude/*` | allow | ask | deny | 项目配置 |
| `.vscode/*` | allow | ask | deny | 编辑器配置 |
| `~/.ssh/*` | deny | deny | deny | SSH 密钥 |
| `~/.aws/*` | deny | deny | deny | AWS 凭据 |
| `~/.gnupg/*` | deny | deny | deny | GPG 密钥 |
| `~/.bashrc`, `~/.zshrc` | ask | deny | deny | Shell 启动配置 |
| `/etc/hosts` | ask | deny | deny | 系统网络配置 |
| `/etc/resolv.conf` | ask | deny | deny | DNS 配置 |
| `package.json` | allow | ask | deny | 依赖声明，npm install 会修改 |
| `package-lock.json` | allow | ask | deny | 锁文件 |

规则引擎按**最长匹配优先**（非 first-match）：`.env.local` 匹配 `.env.*`，不匹配 `.env`，按 `.env.*` 的规则执行。

#### 2.5 复合命令

必须特别处理：

```bash
cd /tmp && rm -rf project
cd ..; echo x > config
command1 | command2
```

遇到以下情况时返回 `ask`，而不是尝试猜测：

* 工作目录在命令中发生变化。
* 多个子命令存在路径依赖。
* 无法确定重定向目标。
* AST 中出现未支持节点。

---

### Gate 3：用户和项目规则

规则优先级：

```text
托管策略
  > 用户配置
  > 项目配置
  > 本地项目配置
```

第一阶段没有企业需求时，可以只实现：

```text
用户配置
  > 项目配置
  > 本地项目配置
```

同一请求中的行为优先级固定为：

```text
deny > ask > allow
```

**同级冲突解决（第一版简化，预留扩展）：**

第一版采用 `deny > ask > allow` 作为兜底策略。当多条同级规则命中时，deny 优先。

但需预留"最具体规则优先"的扩展点——当用户同时配置：

```json
{ "tool": "write_file", "path": "*.env", "behavior": "deny" }
{ "tool": "write_file", "path": ".env.local", "behavior": "allow" }
```

`.env.local` 同时命中两条规则。精确匹配 `.env.local` 应优先于通配符 `*.env`。

**扩展方案（里程碑二或三实现）：** 在规则匹配时引入 specificity 计分：

```typescript
function ruleSpecificity(rule: PermissionRule, input: Record<string, unknown>): number {
  let score = 0;
  if (rule.path !== undefined) score += rule.path.includes('*') ? 1 : 10;
  if (rule.content !== undefined) score += rule.content.includes('*') ? 1 : 10;
  return score;
}
```

分数高的规则优先。第一版不做，但 `PermissionRuleConfig` 数据结构不变，扩展时无迁移负担。

示例：

```json
{
  "permissions": {
    "rules": [
      {
        "tool": "write_file",
        "path": "*.env",
        "behavior": "deny"
      },
      {
        "tool": "run_bash",
        "command": "npm publish*",
        "behavior": "ask"
      },
      {
        "tool": "run_bash",
        "command": "npm test*",
        "behavior": "allow"
      }
    ]
  }
}
```

规则引擎应独立于模式。任何模式都不能覆盖 deny。

---

### Gate 4：模式判定

只有前三个 Gate 都没有返回最终决策时，才进入模式判断。

```typescript
function applyPermissionMode(
  mode: PermissionMode,
): PermissionDecision {
  if (mode === 'guardedAuto') {
    return {
      behavior: 'allow',
      gate: 'mode',
      reasonCode: 'AUTO_REMAINDER_ALLOWED',
      reason: 'Operation passed all mandatory safety checks',
    };
  }

  return {
    behavior: 'ask',
    gate: 'mode',
    reasonCode: 'DEFAULT_REQUIRES_APPROVAL',
    reason: 'User approval required',
  };
}
```

因此，Auto Mode 只绕过普通审批，不绕过：

* 硬 deny。
* 路径边界。
* 用户 deny。
* 解析失败。
* 不可确定操作。
* 敏感文件保护。

---

### Gate 5：运行时沙箱与审计

静态检查只能判断命令“看起来会做什么”，无法保证命令运行时不会改变行为。

例如：

```bash
node script.js
python task.py
npm run build
```

它们可能在运行时访问任意路径或网络。

因此高级版本需要增加运行时防线：

```text
文件系统访问限制
网络访问限制
子进程限制
资源限制
审计日志
紧急关闭开关
```

建议生成执行策略：

```typescript
interface ExecutionPolicy {
  readablePaths: string[];
  writablePaths: string[];
  network: 'deny' | 'allow' | 'restricted';
  allowSubprocesses: boolean;
}
```

权限检查返回 `allow` 后，不直接裸执行，而是：

```text
PermissionDecision
   ↓
生成 ExecutionPolicy
   ↓
在沙箱中运行
   ↓
记录实际访问行为
```

---

## 四、统一决策数据结构

当前仅返回 `behavior` 和 `reason` 不利于调试和审计。

建议改为：

```typescript
interface PermissionDecision {
  behavior: 'allow' | 'ask' | 'deny';

  gate:
    | 'hard-safety'
    | 'path-boundary'
    | 'policy'
    | 'mode'
    | 'sandbox';

  reasonCode: string;
  reason: string;

  evidence?: {
    command?: string;
    matchedPattern?: string;
    path?: string;
    ruleId?: string;
    validator?: string;
  };
}

/**
 * bypassImmune 从 gate 类型推导，不手动设置。
 * hard-safety 和 path-boundary 的 deny 天然不可被任何模式覆盖。
 */
const BYPASS_IMMUNE_GATES = new Set(['hard-safety', 'path-boundary', 'policy']);

function isBypassImmune(decision: PermissionDecision): boolean {
  return decision.behavior === 'deny' && BYPASS_IMMUNE_GATES.has(decision.gate);
}
```

示例：

```json
{
  "behavior": "deny",
  "gate": "path-boundary",
  "reasonCode": "WRITE_OUTSIDE_WORKSPACE",
  "reason": "Command writes outside the allowed workspace",
  "evidence": {
    "path": "/etc/hosts"
  }
}
```

调用方通过 `isBypassImmune(decision)` 判断是否免疫，不需要依赖每个 Gate 正确设置标志位。

---

## 五、代码组织建议

让 `checker.ts` 只负责编排，不再容纳所有判断。

```text
src/permission/
├── checker.ts
├── types.ts
├── decision.ts
├── gates/
│   ├── hard-safety.ts
│   ├── path-boundary.ts
│   ├── policy-rules.ts
│   └── mode.ts
├── bash/
│   ├── parser.ts
│   ├── validators.ts
│   ├── path-extractors.ts
│   └── command-classifier.ts
├── paths/
│   ├── normalize.ts
│   ├── sensitive-paths.ts
│   └── workspace-boundary.ts
├── sandbox/
│   └── execution-policy.ts
└── audit/
    └── permission-log.ts
```

编排代码：

```typescript
class PermissionChecker {
  check(toolName: string, input: unknown): PermissionDecision {
    const context = normalizeRequest({
      toolName,
      input,
      workdir: this.workdir,
    });

    const gates = [
      checkHardSafety,
      checkPathBoundary,
      checkPolicyRules,
    ];

    for (const gate of gates) {
      const decision = gate(context, this.config);

      if (decision) {
        return decision;
      }
    }

    return applyPermissionMode(this.mode);
  }
}
```

Gate 返回 `null` 表示继续，返回决策表示立即结束。

---

## 六、实施顺序

里程碑之间的依赖关系：

```text
里程碑一（重构）→ 里程碑二（Shell 解析）→ 里程碑三（硬安全扩展）
                                          ↘ 里程碑四（运行时沙箱，可并行于三）
```

里程碑二依赖里程碑一（Gate 管道必须先就位）。里程碑三和四可部分并行——硬安全验证器扩展不依赖沙箱，沙箱不依赖更多验证器。

### 里程碑一：重构但不改变行为

目的：先获得清晰的权限管道。

工作内容：

* 将现有 Gate 1、Gate 2、Gate 3 拆成独立函数。
* 引入 `gate`、`reasonCode`，`bypassImmune` 从 gate 推导。
* 保留现有八条正则。
* 保留现有路径提取逻辑。
* **新增 symlink 回归测试**：在工作区内创建 symlink 指向工作区外文件，验证 realpath 解析后 deny 生效。
* 保留 deny 覆盖 auto 的行为。
* 为现有行为补齐回归测试。

这一阶段不增加新的安全规则，避免重构和行为变化同时发生。

### 里程碑二：处理“看不懂的 Bash”

目的：解决正则无法可靠分析复合命令的问题。

工作内容：

* 基于 `shell-quote` 实现 tokenizer 版 Shell 解析器（不引入 tree-sitter）。
* 解析失败统一返回 `ask`。
* 实现首批十个路径提取器。
* 增加读、写、删除分类。
* 增加复合 `cd + write` 检查。
* 增加重定向目标检查。
* 交付能力边界基准测试：用 20-30 条真实命令验证 resolved/unresolved/failed 比例，resolved ≥ 60% 方可通过。

### 里程碑三：扩展硬安全边界

目的：从八条正则成长为验证器体系。

工作内容：

* 命令替换检查。
* 重定向检查。
* Shell 元字符检查。
* 危险删除路径检查。
* 敏感文件检查。
* 磁盘和系统操作检查。
* 对每个新增规则加入独立测试。

新增验证器必须来自真实失败案例或明确威胁，不应一次性堆砌规则。

### 里程碑四：运行时隔离

目的：处理静态分析无法覆盖的程序行为。

工作内容：

* 文件系统沙箱。
* 网络默认关闭或受限。
* 子进程限制。
* 执行审计日志。
* Auto Mode 本地紧急关闭开关。
* 可选的托管策略禁用 Auto Mode。

---

## 七、配置方案

```typescript
interface PermissionConfig {
  mode: 'default' | 'guardedAuto';

  rules: PermissionRuleConfig[];

  additionalDirectories?: string[];

  disableGuardedAuto?: boolean;

  sandbox?: {
    enabled: boolean;
    network: 'deny' | 'allow' | 'restricted';
  };
}
```

示例：

```json
{
  "permissions": {
    "mode": "guardedAuto",
    "additionalDirectories": [
      "../shared-types"
    ],
    "disableGuardedAuto": false,
    "rules": [
      {
        "tool": "write_file",
        "path": "*.env",
        "behavior": "deny"
      },
      {
        "tool": "run_bash",
        "command": "npm publish*",
        "behavior": "ask"
      }
    ],
    "sandbox": {
      "enabled": true,
      "network": "deny"
    }
  }
}
```

---

## 八、验收测试矩阵

| 场景                    |  Default | Guarded Auto |
| --------------------- | -------: | -----------: |
| `npm test`            |      ask |        allow |
| `sudo command`        |     deny |         deny |
| `rm -rf /`            |     deny |         deny |
| 写入工作区普通文件             |      ask |        allow |
| 写入工作区外路径              |     deny |         deny |
| 用户规则禁止写入 `.env`       |     deny |         deny |
| 未知 `$VAR` 路径          |      ask |          ask |
| Shell 解析失败            |      ask |          ask |
| 复合 `cd /tmp && write` | ask/deny |     ask/deny |
| 访问敏感配置文件              | deny/ask |     deny/ask |
| 动态脚本运行时越界             |     沙箱阻止 |         沙箱阻止 |
| Auto Mode 被管理员禁用      |     不可切换 |         不可切换 |
| 用户 allow 规则无法覆盖 hard deny | allow | deny |
| 工作区内 symlink 指向工作区外     | deny | deny |

必须长期保持的四个核心测试：

```typescript
it('hard safety overrides guarded auto');
it('user deny rules override guarded auto');
it('user allow rules cannot override hard safety deny');
it('unknown operations are never auto-allowed');
```

---

## 九、首个改动范围

第一个改动只完成：

```text
checker.ts 拆分
+ Gate 编排
+ 结构化 reasonCode
+ bypassImmune 标记
+ 现有测试迁移
+ 新增 Gate 顺序测试
```

暂时不加入：

```text
AST
沙箱
网络限制
大量新黑名单
企业配置
```

完成后，系统应当在行为完全不变的情况下，从“一个包含多段 if 的检查器”变成“可独立扩展和验证的安全管道”。

这一步建立基础后，再根据具体绕过案例逐步加入 AST、路径提取器和沙箱能力。
