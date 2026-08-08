// 命令执行器：执行斜杠命令
import type { Command } from './parser.js';
import type { ConfigStore } from '../config/store.js';
import type { PermissionChecker } from '../permission/checker.js';
import type { PermissionMode } from '../permission/types.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SkillNegotiator } from '../skills/negotiator.js';
import type { ThemeStore } from '../tui/state/theme-store.js';
import { buildHelpMessage } from './suggestion-data.js';
import { isLanguage, SUPPORTED_LANGUAGES, type LanguageStore, type Translator } from '../locale/types.js';

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
  themeStore?: ThemeStore;
  languageStore?: LanguageStore;
  translator?: Translator;
  /**
   * Task 8：统一 mode transition port。提供后，handleModeSwitch 经此回调切换模式
   * （由 index.ts 注入，内部调 transitionPermissionMode）。未提供时走 LEGACY 路径。
   */
  onModeTransition?: (mode: PermissionMode) => void;
}

// COMMAND_NAMES + COMMAND_SUGGESTIONS 已迁移到 suggestion-data.ts(单一真相源)
export { COMMAND_NAMES, COMMAND_SUGGESTIONS, type SuggestionItem, type CommandGroup } from './suggestion-data.js';

/** 执行斜杠命令 */
export function executeCommand(cmd: Command, configOrContext: ConfigStore | CommandContext, ctx?: CommandContext): CommandResult {
  // 兼容两种调用方式：
  // executeCommand(cmd, configStore, ctx?) — 旧行为（config 命令）
  // executeCommand(cmd, { skillRegistry/themeStore, ... }) — 新行为（技能/theme 命令）
  const isContext = ('skillRegistry' in configOrContext && configOrContext.skillRegistry !== undefined)
    || ('themeStore' in configOrContext)
    || ('languageStore' in configOrContext)
    || ('translator' in configOrContext);

  if (isContext) {
    return executeContextCommand(cmd, configOrContext as CommandContext);
  }

  const config = configOrContext as ConfigStore;
  switch (cmd.name) {
    case 'config':
      return handleConfig(cmd, config, ctx?.translator);
    case 'login':
      return handleLogin(cmd, config, ctx?.translator);
    case 'provider':
      return handleProvider(cmd, config, ctx?.translator);
    case 'model':
      return handleModel(cmd, config, ctx?.translator);
    case 'language':
      return handleLanguage(cmd, config, ctx);
    case 'compact':
      return {
        message:
          ctx?.translator?.t('commands.compact.triggered')
          ?? 'Compaction triggered. Use the agent to run a task and it will auto-compact when needed.',
      };
    case 'build':
      return handleModeSwitch('build', config, ctx);
    case 'plan':
      return handleModeSwitch('plan', config, ctx);
    case 'auto':
      return handleModeSwitch('auto', config, ctx);
    case 'theme':
      return ctx ? handleTheme(cmd, ctx) : { message: unknownCommandMessage(cmd.name, undefined) };
    case 'help':
      return handleHelp(ctx?.translator);
    default:
      return { message: unknownCommandMessage(cmd.name, ctx?.translator) };
  }
}

/** 未知命令反馈：优先本地化，缺省保留英文回退。 */
function unknownCommandMessage(name: string, translator?: Translator): string {
  return translator?.t('commands.unknown', { name }) ?? `Unknown command: /${name}. Type /help for available commands.`;
}

/** 执行 context 命令（技能/theme） */
function executeContextCommand(cmd: Command, ctx: CommandContext): CommandResult {
  switch (cmd.name) {
    case 'skill':
    case 'trigger':
    case 'y':
    case 'n':
    case 'edit':
      return executeSkillCommand(cmd, ctx);
    case 'theme':
      return handleTheme(cmd, ctx);
    default:
      return { message: unknownCommandMessage(cmd.name, ctx?.translator) };
  }
}

/** 执行技能相关命令 */
function executeSkillCommand(cmd: Command, ctx: CommandContext): CommandResult {
  const { skillRegistry, negotiator, userId = 'default' } = ctx;

  switch (cmd.name) {
    case 'skill':
      return handleSkill(cmd, skillRegistry, negotiator, userId, ctx?.translator);
    case 'trigger':
      return handleTrigger(cmd, skillRegistry, negotiator, userId, ctx?.translator);
    case 'y':
      return handleConfirm(negotiator, userId, ctx?.translator);
    case 'n':
      return handleSkip(negotiator, userId, ctx?.translator);
    case 'edit':
      return handleEdit(cmd, negotiator, userId, ctx?.translator);
    default:
      return {
        message:
          ctx?.translator?.t('commands.skill.unknown', { name: cmd.name })
          ?? `Unknown skill command: /${cmd.name}`,
      };
  }
}

/** /skill — 技能管理 */
function handleSkill(
  cmd: Command,
  registry?: SkillRegistry,
  negotiator?: SkillNegotiator,
  userId?: string,
  translator?: Translator,
): CommandResult {
  if (cmd.args.length === 0) {
    return { message: 'Usage: /skill list | /skill off <name> | /skill retry <name>' };
  }

  const sub = cmd.args[0]!;

  switch (sub) {
    case 'list': {
      if (!registry) return { message: translator?.t('commands.skill.noRegistry') ?? 'No skill registry available.' };
      return { message: registry.describeAvailable() };
    }
    case 'off': {
      const skillName = cmd.args[1];
      if (!skillName) return { message: 'Usage: /skill off <name>' };
      if (!negotiator) return { message: translator?.t('commands.skill.noNegotiator') ?? 'No negotiator available.' };
      negotiator.block(skillName, userId!);
      return { message: translator?.t('commands.skill.blocked', { name: skillName }) ?? `Skill "${skillName}" blocked.` };
    }
    case 'retry': {
      const skillName = cmd.args[1];
      if (!skillName) return { message: 'Usage: /skill retry <name>' };
      if (!negotiator) return { message: translator?.t('commands.skill.noNegotiator') ?? 'No negotiator available.' };
      negotiator.unskip(skillName, userId!);
      return {
        message: translator?.t('commands.skill.retryEnabled', { name: skillName })
          ?? `Skill "${skillName}" retry enabled.`,
      };
    }
    default:
      return { message: 'Usage: /skill list | /skill off <name> | /skill retry <name>' };
  }
}

/** /trigger — 触发或拦截技能 */
function handleTrigger(
  cmd: Command,
  registry?: SkillRegistry,
  negotiator?: SkillNegotiator,
  userId?: string,
  translator?: Translator,
): CommandResult {
  if (cmd.args.length === 0) {
    return { message: 'Usage: /trigger <name> | /trigger off <name>' };
  }

  // /trigger off <name>
  if (cmd.args[0] === 'off') {
    const skillName = cmd.args[1];
    if (!skillName) return { message: 'Usage: /trigger off <name>' };
    if (!negotiator) return { message: translator?.t('commands.skill.noNegotiator') ?? 'No negotiator available.' };
    negotiator.block(skillName, userId!);
    return { message: translator?.t('commands.skill.blocked', { name: skillName }) ?? `Skill "${skillName}" blocked.` };
  }

  // /trigger <name> — 通过协商器加载
  const skillName = cmd.args[0]!;
  if (!registry || !negotiator) {
    return { message: translator?.t('commands.skill.noSystem') ?? 'No skill system available.' };
  }

  const doc = registry.get(skillName);
  if (!doc) return { message: translator?.t('commands.skill.notFound', { name: skillName }) ?? `Skill "${skillName}" not found.` };

  const result = negotiator.negotiate(doc, userId!);
  return { message: result.text };
}

/** /y — 确认加载技能 */
function handleConfirm(negotiator?: SkillNegotiator, userId?: string, translator?: Translator): CommandResult {
  if (!negotiator) return { message: translator?.t('commands.confirmation.noPending') ?? 'No pending confirmation.' };
  const pending = negotiator.getPendingConfirmation(userId ?? 'default');
  if (!pending) return { message: translator?.t('commands.confirmation.noPending') ?? 'No pending confirmation.' };
  const result = negotiator.confirm(pending, '/y', userId!);
  return { message: result.text };
}

/** /n — 跳过技能 */
function handleSkip(negotiator?: SkillNegotiator, userId?: string, translator?: Translator): CommandResult {
  if (!negotiator) return { message: translator?.t('commands.confirmation.noPending') ?? 'No pending confirmation.' };
  const pending = negotiator.getPendingConfirmation(userId ?? 'default');
  if (!pending) return { message: translator?.t('commands.confirmation.noPending') ?? 'No pending confirmation.' };
  const result = negotiator.confirm(pending, '/n', userId!);
  return { message: result.text };
}

/** /edit — 编辑技能反馈 */
function handleEdit(cmd: Command, negotiator?: SkillNegotiator, userId?: string, translator?: Translator): CommandResult {
  if (!negotiator) return { message: translator?.t('commands.confirmation.noPending') ?? 'No pending confirmation.' };
  const pending = negotiator.getPendingConfirmation(userId ?? 'default');
  if (!pending) return { message: translator?.t('commands.confirmation.noPending') ?? 'No pending confirmation.' };
  const feedback = cmd.args.join(' ');
  const result = negotiator.confirm(pending, `/edit ${feedback}`, userId!);
  const suffix = result.feedback
    ? translator?.t('commands.confirmation.feedbackSuffix', { feedback }) ?? ` Feedback: ${result.feedback}`
    : '';
  return { message: result.text + suffix };
}

/** /config — 显示或设置配置 */
function handleConfig(cmd: Command, config: ConfigStore, translator?: Translator): CommandResult {
  if (cmd.args.length === 0) {
    // 显示当前配置
    const masked = config.getMasked();
    const lines = [translator?.t('commands.config.currentHeader') ?? 'Current configuration:', ''];
    for (const [name, provider] of Object.entries(masked.providers)) {
      const isDefault = name === masked.defaultProvider ? ' (default)' : '';
      lines.push(`  ${name}${isDefault}:`);
      lines.push(`    apiKey: ${provider.apiKey || '(not set)'}`);
      lines.push(`    model: ${provider.model}`);
    }
    if (Object.keys(masked.providers).length === 0) {
      lines.push(translator?.t('commands.config.noProviders') ?? '  No providers configured. Use /login <provider> to add one.');
    }
    return { message: lines.join('\n') };
  }

  if (cmd.args[0] === 'set' && cmd.args.length >= 3) {
    const key = cmd.args[1]!;
    const value = cmd.args.slice(2).join(' ');
    // 简单的 key-value 设置
    if (key === 'defaultProvider') {
      config.setDefaultProvider(value);
      return { message: translator?.t('commands.config.defaultProviderSet', { value }) ?? `Default provider set to: ${value}` };
    }
    if (key === 'plansDirectory') {
      const cleared = value === 'default' || value === '';
      const displayValue = cleared ? '(default ~/.micode/plans/)' : value;
      config.setPlansDirectory(cleared ? undefined : value);
      return {
        message: translator?.t('commands.config.plansDirectorySet', { value: displayValue })
          ?? `plansDirectory set to: ${displayValue}`,
      };
    }
    return { message: translator?.t('commands.config.unknownKey', { key }) ?? `Unknown config key: ${key}` };
  }

  return { message: 'Usage: /config or /config set <key> <value>' };
}

/** /login — 设置 API Key */
function handleLogin(cmd: Command, config: ConfigStore, translator?: Translator): CommandResult {
  if (cmd.args.length < 2) {
    return { message: 'Usage: /login <provider> <api-key>\nSupported: anthropic, openai, google' };
  }

  const provider = cmd.args[0]!;
  const apiKey = cmd.args[1]!;

  config.setApiKey(provider, apiKey);
  return {
    message: translator?.t('commands.login.saved', { provider })
      ?? `API Key saved for ${provider}. Use /provider ${provider} to activate.`,
  };
}

/** /provider — 切换当前 Provider */
function handleProvider(cmd: Command, config: ConfigStore, translator?: Translator): CommandResult {
  if (cmd.args.length === 0) {
    const current = config.getDefaultProvider();
    return { message: translator?.t('commands.provider.current', { provider: current }) ?? `Current provider: ${current}` };
  }

  const provider = cmd.args[0]!;
  config.setDefaultProvider(provider);
  return { message: translator?.t('commands.provider.switched', { provider }) ?? `Switched to provider: ${provider}` };
}

/** /model — 切换当前模型 */
function handleModel(cmd: Command, config: ConfigStore, translator?: Translator): CommandResult {
  if (cmd.args.length === 0) {
    const current = config.getModel();
    return { message: translator?.t('commands.model.current', { model: current }) ?? `Current model: ${current}` };
  }

  const model = cmd.args[0]!;
  const provider = config.getDefaultProvider();
  config.setModel(provider, model);
  return {
    message: translator?.t('commands.model.set', { model, provider })
      ?? `Model set to: ${model} (for ${provider})`,
  };
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** /language — show current language or switch UI language */
export function handleLanguage(cmd: Command, config: ConfigStore, ctx?: CommandContext): CommandResult {
  const languageStore = ctx?.languageStore;
  const translator = ctx?.translator;
  // 当 translator 缺失时无法本地化（此时也无 languageStore）——保留英文 fallback。
  // `commands.language.noRuntime` 资源 key 已存在（结构完整），但此分支无法消费它。
  if (!languageStore || !translator) {
    return { message: 'No language runtime available.' };
  }

  const supported = SUPPORTED_LANGUAGES.join(', ');
  if (cmd.args.length === 0) {
    const current = languageStore.getState().language;
    return {
      message: translator.t('commands.language.current', { language: current, supported }),
    };
  }

  const language = cmd.args[0];
  if (!isLanguage(language)) {
    return {
      message: translator.t('commands.language.unsupported', {
        language: language ?? '',
        supported,
      }),
    };
  }

  try {
    config.setLanguage(language);
  } catch (error) {
    return {
      message: translator.t('commands.language.persistError', {
        language,
        error: formatUnknownError(error),
      }),
    };
  }

  languageStore.getState().setLanguage(language);
  return {
    message: translator.t('commands.language.updated', { language }),
  };
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
  // Task 8：统一 mode transition port（slash /auto /build /plan 经此入口）
  if (ctx?.onModeTransition) {
    ctx.onModeTransition(mode);
    return { message: ctx?.translator?.t('commands.mode.set', { mode }) ?? `Permission mode set to: ${mode}` };
  }
  // LEGACY：直接 checker.setMode + config 持久化（向后兼容）
  ctx?.permissionChecker?.setMode(mode);
  config.setPermissionMode(mode);
  return { message: ctx?.translator?.t('commands.mode.set', { mode }) ?? `Permission mode set to: ${mode}` };
}

/** /help — 显示帮助 */
function handleHelp(translator?: Translator): CommandResult {
  if (translator) {
    return { message: buildHelpMessage(translator) };
  }

  // Intentional English-only last-resort fallback: 运行时 index.ts 总会注入 translator，
  // 此分支仅在无 translator 调用时生效（向后兼容，dead-at-runtime）。按 Task 4 矫正范围
  // 约束，不本地化此 fallback。
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
  /compact             Trigger context compaction
  /image <path> [text] Attach an image file (PNG/JPEG/GIF/WebP, max 3.75MB)
  /image [text]        Attach image from clipboard (Win: screenshot first, then /image)
  /theme <dark|light>  Switch theme
  /language [lang]     Show current language or switch UI language
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

/** /theme — 切换主题 */
function handleTheme(cmd: Command, ctx: CommandContext): CommandResult {
  const themeName = cmd.args[0];
  if (themeName !== 'dark' && themeName !== 'light') {
    return { message: 'Usage: /theme <dark|light>' };
  }
  ctx.themeStore?.getState().setTheme(themeName);
  return {
    message: ctx?.translator?.t('commands.theme.switched', { theme: themeName })
      ?? `Theme switched to ${themeName}`,
  };
}
