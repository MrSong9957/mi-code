// 命令执行器：执行斜杠命令
import type { Command } from './parser.js';
import type { ConfigStore } from '../config/store.js';
import type { PermissionChecker } from '../permission/checker.js';
import type { PermissionMode } from '../permission/types.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SkillNegotiator } from '../skills/negotiator.js';

/** 命令执行结果 */
export interface CommandResult {
  message: string;
  clearInput?: boolean;
}

/** 命令执行上下文：可选的运行时组件 */
export interface CommandContext {
  permissionChecker?: PermissionChecker;
  skillRegistry?: SkillRegistry;
  negotiator?: SkillNegotiator;
  userId?: string;
}

/**
 * 所有可识别的斜杠命令名（单一真相源）。
 * - executor.switch 用它做校验
 * - use-input-handler 的 TAB 补全用它生成候选
 * - approve/reject 虽在 index.ts 特殊路径，但 help 列出且应可补全，故纳入
 */
export const COMMAND_NAMES: readonly string[] = Object.freeze([
  'config', 'login', 'provider', 'model', 'compact',
  'build', 'plan', 'auto',
  'approve', 'reject',
  'help',
  'skill', 'trigger', 'y', 'n', 'edit',
]);

/** 执行斜杠命令 */
export function executeCommand(cmd: Command, configOrContext: ConfigStore | CommandContext, ctx?: CommandContext): CommandResult {
  // 兼容两种调用方式：
  // executeCommand(cmd, configStore, ctx?) — 旧行为
  // executeCommand(cmd, { skillRegistry, negotiator, userId }) — 新行为（技能命令）
  const isSkillContext = 'skillRegistry' in configOrContext && configOrContext.skillRegistry !== undefined;

  if (isSkillContext) {
    return executeSkillCommand(cmd, configOrContext as CommandContext);
  }

  const config = configOrContext as ConfigStore;
  switch (cmd.name) {
    case 'config':
      return handleConfig(cmd, config);
    case 'login':
      return handleLogin(cmd, config);
    case 'provider':
      return handleProvider(cmd, config);
    case 'model':
      return handleModel(cmd, config);
    case 'compact':
      return { message: 'Compaction triggered. Use the agent to run a task and it will auto-compact when needed.' };
    case 'build':
      return handleModeSwitch('build', config, ctx);
    case 'plan':
      return handleModeSwitch('plan', config, ctx);
    case 'auto':
      return handleModeSwitch('auto', config, ctx);
    case 'help':
      return handleHelp();
    // 技能相关命令也通过此路径处理
    case 'skill':
    case 'trigger':
    case 'y':
    case 'n':
    case 'edit':
      return executeSkillCommand(cmd, ctx ?? {});
    default:
      return { message: `Unknown command: /${cmd.name}. Type /help for available commands.` };
  }
}

/** 执行技能相关命令 */
function executeSkillCommand(cmd: Command, ctx: CommandContext): CommandResult {
  const { skillRegistry, negotiator, userId = 'default' } = ctx;

  switch (cmd.name) {
    case 'skill':
      return handleSkill(cmd, skillRegistry, negotiator, userId);
    case 'trigger':
      return handleTrigger(cmd, skillRegistry, negotiator, userId);
    case 'y':
      return handleConfirm(negotiator, userId);
    case 'n':
      return handleSkip(negotiator, userId);
    case 'edit':
      return handleEdit(cmd, negotiator, userId);
    default:
      return { message: `Unknown skill command: /${cmd.name}` };
  }
}

/** /skill — 技能管理 */
function handleSkill(cmd: Command, registry?: SkillRegistry, negotiator?: SkillNegotiator, userId?: string): CommandResult {
  if (cmd.args.length === 0) {
    return { message: 'Usage: /skill list | /skill off <name> | /skill retry <name>' };
  }

  const sub = cmd.args[0]!;

  switch (sub) {
    case 'list': {
      if (!registry) return { message: 'No skill registry available.' };
      return { message: registry.describeAvailable() };
    }
    case 'off': {
      const skillName = cmd.args[1];
      if (!skillName) return { message: 'Usage: /skill off <name>' };
      if (!negotiator) return { message: 'No negotiator available.' };
      negotiator.block(skillName, userId!);
      return { message: `Skill "${skillName}" blocked.` };
    }
    case 'retry': {
      const skillName = cmd.args[1];
      if (!skillName) return { message: 'Usage: /skill retry <name>' };
      if (!negotiator) return { message: 'No negotiator available.' };
      negotiator.unskip(skillName, userId!);
      return { message: `Skill "${skillName}" retry enabled.` };
    }
    default:
      return { message: 'Usage: /skill list | /skill off <name> | /skill retry <name>' };
  }
}

/** /trigger — 触发或拦截技能 */
function handleTrigger(cmd: Command, registry?: SkillRegistry, negotiator?: SkillNegotiator, userId?: string): CommandResult {
  if (cmd.args.length === 0) {
    return { message: 'Usage: /trigger <name> | /trigger off <name>' };
  }

  // /trigger off <name>
  if (cmd.args[0] === 'off') {
    const skillName = cmd.args[1];
    if (!skillName) return { message: 'Usage: /trigger off <name>' };
    if (!negotiator) return { message: 'No negotiator available.' };
    negotiator.block(skillName, userId!);
    return { message: `Skill "${skillName}" blocked.` };
  }

  // /trigger <name> — 通过协商器加载
  const skillName = cmd.args[0]!;
  if (!registry || !negotiator) {
    return { message: 'No skill system available.' };
  }

  const doc = registry.get(skillName);
  if (!doc) return { message: `Skill "${skillName}" not found.` };

  const result = negotiator.negotiate(doc, userId!);
  return { message: result.text };
}

/** /y — 确认加载技能 */
function handleConfirm(negotiator?: SkillNegotiator, userId?: string): CommandResult {
  if (!negotiator) return { message: 'No pending confirmation.' };
  const pending = negotiator.getPendingConfirmation(userId ?? 'default');
  if (!pending) return { message: 'No pending confirmation.' };
  const result = negotiator.confirm(pending, '/y', userId!);
  return { message: result.text };
}

/** /n — 跳过技能 */
function handleSkip(negotiator?: SkillNegotiator, userId?: string): CommandResult {
  if (!negotiator) return { message: 'No pending confirmation.' };
  const pending = negotiator.getPendingConfirmation(userId ?? 'default');
  if (!pending) return { message: 'No pending confirmation.' };
  const result = negotiator.confirm(pending, '/n', userId!);
  return { message: result.text };
}

/** /edit — 编辑技能反馈 */
function handleEdit(cmd: Command, negotiator?: SkillNegotiator, userId?: string): CommandResult {
  if (!negotiator) return { message: 'No pending confirmation.' };
  const pending = negotiator.getPendingConfirmation(userId ?? 'default');
  if (!pending) return { message: 'No pending confirmation.' };
  const feedback = cmd.args.join(' ');
  const result = negotiator.confirm(pending, `/edit ${feedback}`, userId!);
  return { message: result.text + (result.feedback ? ` Feedback: ${result.feedback}` : '') };
}

/** /config — 显示或设置配置 */
function handleConfig(cmd: Command, config: ConfigStore): CommandResult {
  if (cmd.args.length === 0) {
    // 显示当前配置
    const masked = config.getMasked();
    const lines = ['Current configuration:', ''];
    for (const [name, provider] of Object.entries(masked.providers)) {
      const isDefault = name === masked.defaultProvider ? ' (default)' : '';
      lines.push(`  ${name}${isDefault}:`);
      lines.push(`    apiKey: ${provider.apiKey || '(not set)'}`);
      lines.push(`    model: ${provider.model}`);
    }
    if (Object.keys(masked.providers).length === 0) {
      lines.push('  No providers configured. Use /login <provider> to add one.');
    }
    return { message: lines.join('\n') };
  }

  if (cmd.args[0] === 'set' && cmd.args.length >= 3) {
    const key = cmd.args[1]!;
    const value = cmd.args.slice(2).join(' ');
    // 简单的 key-value 设置
    if (key === 'defaultProvider') {
      config.setDefaultProvider(value);
      return { message: `Default provider set to: ${value}` };
    }
    return { message: `Unknown config key: ${key}` };
  }

  return { message: 'Usage: /config or /config set <key> <value>' };
}

/** /login — 设置 API Key */
function handleLogin(cmd: Command, config: ConfigStore): CommandResult {
  if (cmd.args.length < 2) {
    return { message: 'Usage: /login <provider> <api-key>\nSupported: anthropic, openai, google' };
  }

  const provider = cmd.args[0]!;
  const apiKey = cmd.args[1]!;

  config.setApiKey(provider, apiKey);
  return { message: `API Key saved for ${provider}. Use /provider ${provider} to activate.` };
}

/** /provider — 切换当前 Provider */
function handleProvider(cmd: Command, config: ConfigStore): CommandResult {
  if (cmd.args.length === 0) {
    const current = config.getDefaultProvider();
    return { message: `Current provider: ${current}` };
  }

  const provider = cmd.args[0]!;
  config.setDefaultProvider(provider);
  return { message: `Switched to provider: ${provider}` };
}

/** /model — 切换当前模型 */
function handleModel(cmd: Command, config: ConfigStore): CommandResult {
  if (cmd.args.length === 0) {
    const current = config.getModel();
    return { message: `Current model: ${current}` };
  }

  const model = cmd.args[0]!;
  const provider = config.getDefaultProvider();
  config.setModel(provider, model);
  return { message: `Model set to: ${model} (for ${provider})` };
}

/**
 * /build /plan /auto — 切换权限模式（即时生效 + 持久化）
 *
 * 物理类比：柜台上方挂的「今日营业模式」牌子。
 *   /build = 标准营业（写操作走 ask 确认）
 *   /plan  = 只读参观日（写窗口暂停服务）
 *   /auto  = VIP 自助（除危险动作外全放行）
 */
function handleModeSwitch(mode: PermissionMode, config: ConfigStore, ctx?: CommandContext): CommandResult {
  // 即时生效：更新运行中的 PermissionChecker
  ctx?.permissionChecker?.setMode(mode);
  // 持久化：写入配置文件，重启后恢复
  config.setPermissionMode(mode);
  return { message: `Permission mode set to: ${mode}` };
}

/** /help — 显示帮助 */
function handleHelp(): CommandResult {
  return {
    message: `Available commands:
  /config              Show current configuration
  /config set <k> <v>  Set config value
  /login <provider> <key>  Set API Key
  /provider <name>     Switch provider (anthropic, openai, google)
  /model <name>        Switch model
  /build               Standard mode: writes ask for confirmation
  /plan                Plan mode: all writes blocked (read-only)
  /auto                Auto mode: everything allowed (dangerous cmds still blocked)
  /approve             (After exit_plan_mode) Approve plan & switch to build
  /reject [reason]     (After exit_plan_mode) Reject plan, stay in plan mode
  /compact             Trigger context compaction
  /skill list           List available skills
  /skill off <name>     Block a skill
  /skill retry <name>  Un-skip a skill
  /trigger <name>      Trigger a skill
  /trigger off <name>  Block a skill
  /y                   Confirm pending skill
  /n                   Skip pending skill
  /edit <feedback>     Edit/feedback on pending skill
  /help                Show this help`,
  };
}
