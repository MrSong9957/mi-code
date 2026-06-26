# API Key 配置系统设计

**日期**: 2026-06-26
**状态**: 设计中

## 目标

为 mi-code 提供优雅的 API Key 配置体验，参考 Claude Code、OpenCode 等主流工具。

## 设计原则

1. **零配置启动** — 环境变量 fallback，无需配置文件即可运行
2. **持久化配置** — 配置文件存储，重启后保留
3. **多 Provider** — 支持 Anthropic、OpenAI、Google 等
4. **斜杠命令** — 终端内交互式配置

## 配置层级

优先级从高到低：

```
1. 环境变量 ANTHROPIC_API_KEY / OPENAI_API_KEY
2. 项目级 .micode.json（gitignore）
3. 用户级 ~/.micode/config.json
```

## 配置文件格式

### 用户级 `~/.micode/config.json`

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-xxx",
      "model": "claude-sonnet-4-20250514"
    },
    "openai": {
      "apiKey": "sk-xxx",
      "model": "gpt-4o"
    }
  },
  "defaultProvider": "anthropic"
}
```

### 项目级 `.micode.json`

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514"
}
```

## 斜杠命令

| 命令 | 功能 |
|------|------|
| `/config` | 显示当前配置 |
| `/config set <key> <value>` | 设置配置项 |
| `/config get <key>` | 读取配置项 |
| `/login <provider>` | 交互式输入 API Key |
| `/provider <name>` | 切换当前 provider |
| `/model <name>` | 切换当前模型 |

## 模块设计

### 1. ConfigStore (`src/config/store.ts`)

```typescript
interface ConfigStore {
  // 读取配置
  get(key: string): unknown;
  // 写入配置
  set(key: string, value: unknown): void;
  // 获取 API Key（按优先级）
  getApiKey(provider: string): string | undefined;
  // 获取当前模型
  getModel(): string;
  // 保存到文件
  save(): void;
}
```

### 2. Config Schema (`src/config/schema.ts`)

```typescript
interface MiCodeConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
}

interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}
```

### 3. 命令处理 (`src/commands/`)

斜杠命令在输入框中以 `/` 开头时触发。

## 数据流

```
用户输入 /login anthropic
    ↓
解析命令 → 调用 loginCommand()
    ↓
提示输入 API Key（密码输入模式）
    ↓
写入 ~/.micode/config.json
    ↓
重新加载配置
```

## 安全考虑

1. **API Key 脱敏** — 显示时只显示前 8 位 + `***`
2. **文件权限** — 配置文件权限 600（仅 owner 可读写）
3. **不进 git** — `.micode.json` 加入 `.gitignore`

## 验证方式

```bash
# 测试配置读写
npm test -- src/__tests__/config.test.ts

# 测试斜杠命令
npm test -- src/__tests__/commands.test.ts
```
