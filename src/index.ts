#!/usr/bin/env node
// MiCode 主入口 —— React + Ink 渲染层（alt screen + flexbox 布局 + Yoga）
//
// 物理本质：组件树 + Zustand stores + Yoga 自动算坐标。
// bootstrap() 装配 messagesStore/inputStore/statusStore + PipelineToStoreAdapter +
// BlockPipeline，render(<ConnectedApp/>) 进 alt screen。
// agent loop 的所有 pipeline.emit 透明路由到 store，Ink 自动重渲染。
// 坐标全由 Yoga flexbox 算（charter 铁律：禁止手动 CUP 定位）。

import 'dotenv/config';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { createDefaultRegistry } from './agent/tool-registry.js';
import { AnthropicStreamClient } from './agent/anthropic-stream-client.js';
import { formatErrorForDisplay } from './cli/format-error.js';
import { streamingQuery } from './agent/streaming-query.js';
import { StreamEventBus } from './agent/stream-event-bus.js';
import { BlockPipeline } from './ui/block-pipeline.js';
import { bootstrap, type BootstrapHandle } from './tui/bootstrap.js';
import { ConfigStore } from './config/index.js';
import { parseCommand, executeCommand } from './commands/index.js';
import { TodoManager } from './agent/todo.js';
import { createTaskTool } from './agent/tools/task-tool.js';
import { createSpawnAgentTool } from './agent/tools/spawn-agent-tool.js';
import { createSpawnSelfOrganizingTool } from './agent/tools/spawn-self-organizing-tool.js';
import { InboxManager } from './agent/inbox.js';
import { SkillRegistry, SkillNegotiator, createLoadSkillTool } from './skills/index.js';
import { parseBlockPrefix } from './commands/parser.js';
import { PermissionChecker } from './permission/index.js';
import { WRITE_TOOLS, type PermissionMode } from './permission/types.js';
import { COMMAND_NAMES } from './commands/executor.js';
import { HookRunner, preToolSafetyCheck, postToolLogger, sessionStartLogger } from './hooks/index.js';
import { TeammateManager, createSendMessageTool, createReadInboxTool, NegotiationManager, createShutdownRequestTool, createRespondRequestTool, createSubmitPlanTool, createApprovePlanTool } from './agent/team/index.js';
import { ScheduleManager } from './agent/scheduler/index.js';
import { WorktreeManager } from './worktree/index.js';
import { TaskBoard } from './task-board/index.js';
import { BackgroundManager } from './background/index.js';
import { MemoryManager } from './memory/index.js';
import { createMemoryWriteTool, createMemoryReadTool, createMemoryListTool } from './agent/tools/memory-tool.js';
import { AskUserManager } from './agent/ask-user-manager.js';
import { createAskUserTool } from './agent/tools/ask-user-tool.js';
import { PlanStore } from './plan/plan-store.js';
import { createWritePlanTool, createExitPlanModeTool } from './agent/tools/plan-tools.js';
import { setWorkdir, getWorkdir } from './agent/tools/path-sandbox.js';
import { HistoryManager } from './history.js';
import { expandPastedTextRefs } from './tui/input/paste-handler.js';

const VERSION = "1.0.0";

// ─────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────
const configStore = new ConfigStore();
// MODEL/SMALL_MODEL 显式取自 anthropic provider 槽位（不读 defaultProvider）。
// 原因：客户端恒为 AnthropicStreamClient（new Anthropic()），只支持 Anthropic 兼容端点。
// 若用 getModel()（读 defaultProvider），当 defaultProvider=openai 时会拿到 gpt-4o，
// 但 key 也会取错槽位（见下方 getApiKey 修复），导致 401。
const ANTHROPIC_PROVIDER = configStore.getProvider('anthropic');
const MODEL = ANTHROPIC_PROVIDER?.model || configStore.getModel();
const SMALL_MODEL = configStore.getSmallModel('anthropic');

const todoManager = new TodoManager();
const skillRegistry = new SkillRegistry();
skillRegistry.loadFromDir('skills');
const skillNegotiator = new SkillNegotiator();
// 统一 workdir 真相源：path-sandbox 模块全局与 PermissionChecker 实例同源，
// 消除"双源靠都是 process.cwd() 巧合一致"的漂移风险。
// 必须在任何工具注册（createDefaultRegistry）之前锚定，且不受后续 process.chdir 影响。
setWorkdir(process.cwd());
const permissionChecker = new PermissionChecker({
  mode: configStore.getPermissionMode(),
  rules: configStore.getPermissionRules(),
  workdir: getWorkdir(),
});
const teammateManager = new TeammateManager('.team');
const negotiationManager = new NegotiationManager();
const scheduler = new ScheduleManager('.schedules.json');
scheduler.load();
const hookRunner = new HookRunner();
hookRunner.register('PreToolUse', preToolSafetyCheck);
hookRunner.register('PostToolUse', postToolLogger);
hookRunner.register('SessionStart', sessionStartLogger);
const worktreeManager = new WorktreeManager(process.cwd());
worktreeManager.recover();
const taskBoard = new TaskBoard();
taskBoard.load(process.cwd());
const backgroundManager = new BackgroundManager(process.cwd());
const memoryManager = new MemoryManager(process.cwd());
const inboxManager = new InboxManager();
const historyManager = new HistoryManager();
const currentProject = process.cwd();

// CLI argv 解析（--resume/--continue/--list）
import { parseCliArgs } from './cli.js';
import { SessionStore } from './session/store.js';
import { randomUUID } from 'crypto';
import type { Message } from './agent/types.js';
const cliOpts = parseCliArgs();
const sessionStore = new SessionStore();
// 会话 ID：resume 时用恢复的 id，否则新建
let sessionId: string = randomUUID();
// 当前会话累积消息（resume 时预载，streamingQuery onMessages 时更新）
let sessionMessages: Message[] = [];

function getGitBranch(): string {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'no-git'; }
}
function getShortDir(): string {
  return process.cwd().replace(/\\/g, '/').split('/').slice(-2).join('/');
}
const GIT_BRANCH = getGitBranch();
const SHORT_DIR = getShortDir();

const childToolRegistry = createDefaultRegistry(todoManager, undefined, scheduler, backgroundManager, taskBoard, worktreeManager);
const toolRegistry = createDefaultRegistry(todoManager, undefined, scheduler, backgroundManager, taskBoard, worktreeManager);
const taskTool = createTaskTool(childToolRegistry, worktreeManager, SMALL_MODEL);
toolRegistry.register(taskTool.definition, taskTool.executor);
const spawnSoTool = createSpawnSelfOrganizingTool(childToolRegistry, todoManager, inboxManager, { model: SMALL_MODEL });
toolRegistry.register(spawnSoTool.definition, spawnSoTool.executor);
// spawn_agent：派角色化子代理（explore/plan/general）
// 透传 permissionChecker：让子代理也受 plan 模式约束（读 allow / 写 deny）
const spawnAgentTool = createSpawnAgentTool(childToolRegistry, SMALL_MODEL, permissionChecker);
toolRegistry.register(spawnAgentTool.definition, spawnAgentTool.executor);
const loadSkillTool = createLoadSkillTool(skillRegistry);
toolRegistry.register(loadSkillTool.definition, loadSkillTool.executor);
const sendMessageTool = createSendMessageTool(teammateManager);
toolRegistry.register(sendMessageTool.definition, sendMessageTool.executor);
const readInboxTool = createReadInboxTool(teammateManager);
toolRegistry.register(readInboxTool.definition, readInboxTool.executor);
const shutdownRequestTool = createShutdownRequestTool(negotiationManager, teammateManager);
toolRegistry.register(shutdownRequestTool.definition, shutdownRequestTool.executor);
const respondRequestTool = createRespondRequestTool(negotiationManager);
toolRegistry.register(respondRequestTool.definition, respondRequestTool.executor);
const submitPlanTool = createSubmitPlanTool(negotiationManager);
toolRegistry.register(submitPlanTool.definition, submitPlanTool.executor);
const approvePlanTool = createApprovePlanTool(negotiationManager);
toolRegistry.register(approvePlanTool.definition, approvePlanTool.executor);
const memWrite = createMemoryWriteTool(memoryManager);
toolRegistry.register(memWrite.definition, memWrite.executor);
const memRead = createMemoryReadTool(memoryManager);
toolRegistry.register(memRead.definition, memRead.executor);
const memList = createMemoryListTool(memoryManager);
toolRegistry.register(memList.definition, memList.executor);
// 注：ask_user_question 工具依赖 askManager（需 layout），在 askManager 实例化后注册（见下方 UI 状态区）

// ─────────────────────────────────────────────────────────────
// React + Ink 渲染层（charter 新架构）：alt screen + flexbox + Yoga
// 终端尺寸由 useTerminalSize hook 响应，无需手动 readTermSize。
// ─────────────────────────────────────────────────────────────

/**
 * React + Ink 渲染层（charter 新架构）：alt screen + flexbox + Yoga。
 * bootstrap() 装配 stores + PipelineToStoreAdapter + BlockPipeline，render(<ConnectedApp/>) 进 alt screen。
 * agent loop 的 pipeline.emit 透明路由到 messagesStore，Ink 自动重渲染。
 *
 * 循环依赖处理：askManager/planStore 等在 bootstrap 前构造，需要 printLine/setHint。
 * 用前向声明 tuiHandle（bootstrap 后赋值）+ 延迟绑定函数。pipeline 同理（bootstrap 内构造）。
 */
let tuiHandle: BootstrapHandle | null = null;

/** 统一输出管道（bootstrap 内构造，所有 agent 逻辑 emit Block 到此）。
 *  声明为 let，bootstrap 后赋值；agent loop 使用前必已赋值。 */
let pipeline = new BlockPipeline({
  printMessage: () => {},
  appendStreamingMarkdown: () => {},
  appendStreamingThinking: () => {},
  eraseStreamingThinking: () => {},
  sealStreaming: () => {},
  flushNow: () => {},
  clearMessages: () => {},
});

/** 把一行文本作为"系统消息"固化进消息区（延迟绑定到 bootstrap 后的 messagesStore）。 */
function printLine(text: string): void {
  tuiHandle?.printLine(text);
}

/** 带样式/角色的消息（延迟绑定）。
 *  - 'input' → 用户输入回显（带 ❯ 前缀，Footer 自带 ❯，去重）
 *  - 'error' → 红色错误
 *  - 'system' → 普通系统消息 */
function printStyled(text: string, role: 'system' | 'error' | 'input', style?: Record<string, unknown>): void {
  // style 参数旧实现未消费（样式由 role 决定）；新版 printStyled 也不消费，保留签名兼容
  void style;
  tuiHandle?.printStyled(text, role);
}

// 注：tool_result 的 diff 计算已移至 BlockPipeline（pendingToolInputs 缓存 +
// buildToolResultBlock 在 pipeline 内部）。index.ts 只 emit Block，不关心怎么算。

// ─────────────────────────────────────────────────────────────
// UI 状态
// ─────────────────────────────────────────────────────────────
// 注：输入态（text/cursor）由 inputStore 管理（bootstrap 内构造，ConnectedApp 订阅）。
// isProcessing 仍是模块级标志（agent loop 运行中标记，防重入）。
let isProcessing = false;

/**
 * AskUserManager：AI 向用户提问的挂起-应答状态机。
 * 物理本质：服务员把问题递给顾客（贴消息区 + 页脚提示）后站等回话。
 * 与 handleInput 共享同一实例：工具 executor 内 ask() 挂起，回车提交时 resolve()。
 */
const askManager = new AskUserManager({
  printLine: (s) => printLine(s),
  // 提问提示走消息区（charter StatusBar 无 hint 字段，提示信息进 messagesStore 显示）
  setHint: (s) => { if (s) printLine(s); },
});
// 注册 ask_user_question 工具（依赖 askManager）
const askTool = createAskUserTool(askManager);
toolRegistry.register(askTool.definition, askTool.executor);

/**
 * PlanStore：plan 文件落盘（plan 模式产出物的档案柜）。
 * 目录 ~/.micode/plans/，文件名 <sessionId>-<ts>.md。
 * 同时把 planDir 注册到 PermissionChecker，让 plan 模式下 write_file 写到该目录放行。
 */
const planStore = new PlanStore(join(homedir(), '.micode'));
permissionChecker.setPlanDir(planStore.getPlansDir());
// 注册 write_plan_file 与 exit_plan_mode 工具（依赖 planStore + askManager）
const writePlanTool = createWritePlanTool(planStore, () => sessionId);
toolRegistry.register(writePlanTool.definition, writePlanTool.executor);
const exitPlanTool = createExitPlanModeTool(askManager, planStore);
toolRegistry.register(exitPlanTool.definition, exitPlanTool.executor);
// 同时注册到 childToolRegistry：plan 角色子代理需要这两个工具（白名单由 roles.ts 控制）
childToolRegistry.register(writePlanTool.definition, writePlanTool.executor);
childToolRegistry.register(exitPlanTool.definition, exitPlanTool.executor);
// ask_user_question 同样需要给子代理（plan 角色白名单含此工具）
const askToolChild = createAskUserTool(askManager);
childToolRegistry.register(askToolChild.definition, askToolChild.executor);

/**
 * TAB 行为（对标 Claude Code）：
 *  - input 以 / 开头 → 补全（COMMAND_NAMES 过滤前缀，cycle 候选，写回 input）
 *  - 否则 → 循环 PermissionMode（build→plan→auto→build）
 *
 * completion：从 handle.completionStore 取当前候选池。
 *  - 若候选已可见且仍匹配当前 text（输入框前缀未变），cycle 推进高亮；
 *  - 否则（前缀变了或首次）按前缀重算候选。
 * 选中项经 inputStore.setText('/' + sel) 写回输入框。
 *
 * 模式切换走与 /build /plan /auto 斜杠命令一致的 3 处副作用：
 * permissionChecker.setMode + configStore.setPermissionMode + statusStore.setMode。
 */
function handleTab(
  text: string,
  handle: BootstrapHandle | null,
  cfgStore: ConfigStore,
  checker: PermissionChecker,
): void {
  if (!handle) return;
  const completion = handle.completionStore.getState();

  // 分支 1：补全（input 以 / 开头）
  if (text.startsWith('/')) {
    const prefix = text.slice(1);
    // 候选已可见且仍匹配当前 text（输入框前缀未变）→ cycle；否则重算
    const stillMatches = completion.visible
      && completion.candidates.length > 0
      && completion.candidates.every(c => c.startsWith(prefix));
    if (stillMatches) {
      completion.cycle();
    } else {
      const candidates = COMMAND_NAMES.filter(n => n.startsWith(prefix));
      completion.setCandidates(candidates);
    }
    const sel = completion.selected();
    if (sel) {
      handle.inputStore.getState().setText('/' + sel);
    }
    return;
  }

  // 分支 2：模式切换（build→plan→auto→build）
  completion.hide();
  const order: PermissionMode[] = ['build', 'plan', 'auto'];
  const cur = checker.getMode();
  const idx = order.indexOf(cur);
  const next = order[(idx + 1) % order.length]!;
  checker.setMode(next);
  cfgStore.setPermissionMode(next);
  handle.statusStore.getState().setMode(next);
}

/** Ctrl+O：切换覆盖层。有可折叠块时打开，已开则关闭。 */
function handleToggleOverlay(handle: BootstrapHandle | null): void {
  if (!handle) return;
  const overlay = handle.overlayStore.getState();
  if (overlay.visible) {
    overlay.close();
    return;
  }
  const expandable = handle.pipeline.getLastExpandableFullLines();
  if (!expandable) return; // 无可展开内容，静默忽略
  const title = expandable.kind === 'thinking' ? 'Thinking' : 'Tool result';
  overlay.open(title, expandable.lines);
}

/**
 * 用户提交输入（回车）。从旧 handleInput 的 byte===0x0d 块提取，接入 bootstrap 的 onSubmit 回调。
 *
 * 职责（与旧实现完全一致）：
 * 1. 'exit' 命令 → cleanup + 退出
 * 2. pending question（askManager.hasPending）→ resolve（/approve //reject 特判）
 * 3. 新 turn：history 落盘 + clearTurnState + emit user_input + 命令解析 + agent loop
 *
 * ink-store 迁移点：input/cursorPos 已由 inputStore 管理（submit 时清空），故删除旧
 * input=''/cursorPos=0/syncInput；layout.* → tuiHandle.statusStore。
 */
async function handleUserSubmit(rawText: string): Promise<void> {
  // 历史存占位符版本（省磁盘），agent/解析/回显用展开版本（需完整上下文）。
  // sessionStore 仍存展开版本（resume 后占位符 ID 跨 session 失效，需完整文本）。
  const trimmedRaw = rawText.trim();
  const userInput = expandPastedTextRefs(trimmedRaw);
  if (userInput === 'exit') {
    tuiHandle?.cleanup();
    process.exit(0);
  }

  // 1. 优先处理 pending question：agent 运行中也可回答
  if (askManager.hasPending()) {
    if (!userInput) return; // 空回车：忽略
    // plan 批准流特判：/approve /reject 走专属副作用（切 mode + resolve）
    if (userInput === '/approve' || userInput.startsWith('/reject')) {
      pipeline.emit({ kind: 'user_input', text: userInput });
      if (userInput === '/approve') {
        permissionChecker.setMode('build');
        configStore.setPermissionMode('build');
        tuiHandle?.statusStore.getState().setMode('build');
        printLine('✓ Plan approved. Switched to build mode.');
        askManager.resolve('approve');
      } else {
        const reason = userInput.slice('/reject'.length).trim();
        printLine(`✗ Plan rejected${reason ? ': ' + reason : ''}.`);
        askManager.resolve(reason || 'reject');
      }
      return;
    }
    pipeline.emit({ kind: 'user_input', text: userInput });
    askManager.resolve(userInput);
    return;
  }

  // 2. 新 turn
  if (!userInput || isProcessing) return;
  await historyManager.addEntry(trimmedRaw, currentProject);
  // clearTurnState 必须在 user_input emit 之前（见旧注释）
  pipeline.clearTurnState();
  pipeline.emit({ kind: 'user_input', text: userInput });

  // 检查 ! 前缀拦截
  const blockReq = parseBlockPrefix(userInput);
  if (blockReq) {
    skillNegotiator.block(blockReq.skillName, 'default');
    printLine(`Skill "${blockReq.skillName}" blocked.`);
    return;
  }

  const cmd = parseCommand(userInput);
  if (cmd) {
    if (['skill', 'trigger', 'y', 'n', 'edit'].includes(cmd.name)) {
      const result = executeCommand(cmd, { skillRegistry, negotiator: skillNegotiator, userId: 'default' });
      printLine(result.message);
    } else {
      const result = executeCommand(cmd, configStore, { permissionChecker, themeStore: tuiHandle?.themeStore });
      printLine(result.message);
      if (cmd.name === 'plan' || cmd.name === 'build' || cmd.name === 'auto') {
        tuiHandle?.statusStore.getState().setMode(permissionChecker.getMode());
      }
    }
    return;
  }

  // 3. Agent 循环
  todoManager.incrementRounds();
  const reminder = todoManager.getReminder() || todoManager.getVerificationNudge();
  const skillsDescription = skillRegistry.describeAvailable();
  const currentMode = permissionChecker.getMode();
  const planModeInstruction = currentMode === 'plan'
    ? '\n\n## PLAN MODE ACTIVE\n' +
      'You MUST NOT make any edits, run write tools, or otherwise change the system. ' +
      'Only read-only operations and the plan-related tools (write_plan_file, exit_plan_mode) are allowed.\n' +
      '\n' +
      '## Communication（重要）\n' +
      'Always give the user a concise verbal update — never chain tool calls in silence:\n' +
      '- Before a batch of tool calls: one short sentence on what you are about to look at and why.\n' +
      '- After exploration is complete: a thorough but concise summary of what you found, the architecture/design, ' +
      'and (if you propose changes) how the user can verify them. This summary is your deliverable.\n' +
      'The user should never feel the task is half-done or left hanging.\n' +
      '\n' +
      'Workflow:\n' +
      '1. Explore the codebase — prefer dedicated read-only tools:\n' +
      '   - read_file (view a file OR list a directory)\n' +
      '   - glob (find files by name pattern, e.g. "**/*.ts")\n' +
      '   - grep (search file contents by regex)\n' +
      '   For cases those tools cannot cover (git log, find with complex filters),\n' +
      '   you MAY use run_bash with read-only commands (ls/cat/grep/git status/git diff).\n' +
      '   NEVER run write commands (mkdir/rm/git commit/npm install/...).\n' +
      '2. When you have a complete plan, call write_plan_file with the full Markdown content\n' +
      '3. Call exit_plan_mode to submit it for user approval\n' +
      '4. The user will respond with /approve (you may then implement) or /reject <reason> (revise and resubmit)\n' +
      'For large or unfamiliar codebases, consider spawning an explore agent (spawn_agent role="explore") ' +
      'to investigate in parallel without bloating your main context.\n' +
      'Do NOT execute the plan until it is approved and the mode switches to build.'
    : '';

  const systemPrompt = [
    'You are a helpful assistant. Answer questions directly with text — do NOT use tools for simple conversation.',
    'You have tools (run_bash, read_file, write_file, etc.) for when you need to perform real operations on the system.',
    'Only use tools when the user asks you to do something concrete (run a command, read/edit a file, search code).',
    'For questions, explanations, and advice, respond with plain text — never wrap your reply in a Bash echo command.',
    '',
    skillsDescription,
    reminder ? `\n${reminder}` : '',
    planModeInstruction,
  ].join('\n');

  isProcessing = true;
  let thinkingContent = '';
  let thinkingStart = Date.now();
  pipeline.emit({ kind: 'thinking_start' });

  // API Key 显式取自 anthropic provider 槽位（不读 defaultProvider）。
  // 原因：客户端恒为 AnthropicStreamClient，只支持 Anthropic 兼容端点 + X-Api-Key 头。
  // 若用 getApiKey(getDefaultProvider())，当 defaultProvider=openai 时会拿到假 key
  // （如 sk-test-123），发给 miMo 网关 → 401 Invalid API Key。
  const apiKey = configStore.getApiKey('anthropic');
  if (!apiKey) {
    tuiHandle?.printStyled(`[Error] No API Key for anthropic provider. Use /login anthropic <key> to configure.`, 'error');
    isProcessing = false;
    return;
  }

  const streamClient = new AnthropicStreamClient({ apiKey, model: MODEL });
  const compactClient = new AnthropicStreamClient({ apiKey, model: SMALL_MODEL });
  const eventBus = new StreamEventBus();
  eventBus.onToolCall(d => {
    pipeline.emit({ kind: 'tool_call', name: d.name, input: d.input, toolUseId: d.toolUseId });
    tuiHandle?.setSpinnerLabel(`Running ${d.name}`);
  });
  eventBus.onToolResult(d => {
    pipeline.emit({ kind: 'tool_result', name: d.name, output: d.output, toolUseId: d.toolUseId });
  });
  eventBus.onLoopEnd(() => {
    tuiHandle?.stopSpinner();
  });
  const allToolDefs = Array.from(toolRegistry.tools.values()).map(t => t.definition);
  const tools = currentMode === 'plan'
    ? allToolDefs.filter(t => !WRITE_TOOLS.includes(t.name))
    : allToolDefs;
  const ac = new AbortController();

  // agent 循环（与旧实现 verbatim，仅 layout.* → tuiHandle.statusStore）
  let assistantText = '';
  let persistedCount = sessionMessages.length;
  const blockTypes = new Map<number, string>();
  let thinkingActive = true; // 已乐观 emit thinking_start
  tuiHandle?.startSpinner('Thinking…');
  try {
    for await (const msg of streamingQuery(streamClient, toolRegistry, userInput, {
      systemPrompt, tools, signal: ac.signal, maxTurns: 10,
      eventBus, compactClient, permissionChecker,
      initialMessages: sessionMessages.length > 0 ? sessionMessages : undefined,
      onMessages: (finalMessages) => {
        const newMsgs = finalMessages.slice(persistedCount);
        sessionMessages = finalMessages;
        persistedCount = finalMessages.length;
        for (const m of newMsgs) {
          void sessionStore.append(sessionId, m);
        }
      },
    })) {
      if ('type' in msg && msg.type === 'content_block_start') {
        const cbs = msg as { type: 'content_block_start'; index: number; blockType: string };
        blockTypes.set(cbs.index, cbs.blockType);
        if (cbs.blockType === 'thinking' && !thinkingActive) {
          pipeline.emit({ kind: 'thinking_start' });
          thinkingStart = Date.now();
          thinkingActive = true;
        }
      } else if ('type' in msg && msg.type === 'content_block_stop') {
        const cstop = msg as { type: 'content_block_stop'; index: number };
        if (blockTypes.get(cstop.index) === 'thinking' && thinkingActive) {
          const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
          pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
          thinkingContent = '';
          thinkingActive = false;
          tuiHandle?.setSpinnerLabel('Generating…');
        }
      } else if ('type' in msg && msg.type === 'content_block_delta') {
        const delta = msg as { type: 'content_block_delta'; deltaType: string; content: string };
        if (delta.content) tuiHandle?.spinnerOnToken();
        if (delta.deltaType === 'text' && delta.content) {
          if (assistantText === '' && thinkingContent) {
            const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
            pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
            thinkingContent = '';
            thinkingActive = false;
            tuiHandle?.setSpinnerLabel('Generating…');
          }
          assistantText += delta.content;
          pipeline.emit({ kind: 'assistant_text', text: assistantText, isFinal: false });
        } else if (delta.deltaType === 'thinking' && delta.content) {
          thinkingContent += delta.content;
          pipeline.emit({ kind: 'thinking_delta', content: delta.content });
        }
      } else if ('type' in msg && msg.type === 'message_start') {
        // 上下文占用：input_tokens / context_window(200000) → 进度条百分比
        const ms = msg as { type: 'message_start'; inputTokens?: number };
        if (typeof ms.inputTokens === 'number') {
          tuiHandle?.statusStore.getState().setContextPct(ms.inputTokens / 200000);
        }
      } else if ('type' in msg && msg.type === 'assistant') {
        if (assistantText) {
          pipeline.emit({ kind: 'assistant_text', text: assistantText, isFinal: true });
          assistantText = '';
        }
      } else if ('type' in msg && msg.type === 'tool_result') {
        const tr = msg as { type: 'tool_result'; name: string; output: string };
        const hookResult = await hookRunner.run({
          name: 'PostToolUse',
          payload: { tool_name: tr.name, output: tr.output },
        });
        if (hookResult.message) {
          pipeline.emit({ kind: 'hook', text: hookResult.message });
        }
      }
    }
    if (assistantText) {
      pipeline.emit({ kind: 'assistant_text', text: assistantText, isFinal: true });
      assistantText = '';
    }
  } catch (err) {
    // formatErrorForDisplay 只取 message（不含堆栈），超长截断——
    // 避免把整个 Error.stack 刷屏到终端（之前的 [system] [Error] Error [ERR_UNHANDLED_ERROR]... 问题）
    tuiHandle?.printStyled(`[Error] ${formatErrorForDisplay(err)}`, 'error');
  } finally {
    tuiHandle?.stopSpinner();
    isProcessing = false;
    if (thinkingContent) {
      const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
      pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
      thinkingContent = '';
    }
    printLine('');
  }
  historyManager.reset();
}


// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

// CLI 参数处理：--list 列出会话后退出（不进 TUI）
if (cliOpts.list) {
  sessionStore.list().then(sessions => {
    if (sessions.length === 0) {
      console.log('No sessions found.');
    } else {
      console.log('Sessions (most recent first):');
      for (const s of sessions) {
        const preview = s.firstUserInput.slice(0, 40);
        console.log(`  ${s.id}  ${preview}  (${s.messageCount} msgs)`);
      }
      console.log('\nResume with: micode --resume <id>  or  micode --continue');
    }
    process.exit(0);
  });
} else {
  // --resume <id> 或 --continue：加载历史会话（同步读取，避免顶层 await）
  const resumeId = cliOpts.resume ?? (cliOpts.continueLatest ? sessionStore.getLastSessionIdSync() : null);
  if (resumeId) {
    sessionMessages = sessionStore.loadSync(resumeId);
    sessionId = resumeId;
  }

  // 装配 Ink 渲染层：stores + PipelineToStoreAdapter + BlockPipeline + render(<ConnectedApp/>)。
  // bootstrap 内部进 alt screen（useAltScreen），render 挂载 ConnectedApp。
  // LOGO 区只显示 version + dir；mode/model/branch/contextPct 在 StatusBar 显示。
  tuiHandle = bootstrap({
    logo: { version: VERSION, dir: SHORT_DIR },
    status: {
      mode: configStore.getPermissionMode(),
      model: MODEL,
      dir: SHORT_DIR,
      branch: GIT_BRANCH,
    },
    renderMode: 'inline',
    themeName: cliOpts.theme ?? configStore.getTheme(),
    onSubmit: (text) => { void handleUserSubmit(text); },
    onExit: () => { cleanupOnExit(); process.exit(0); },
    onTab: (text) => { handleTab(text, tuiHandle, configStore, permissionChecker); },
    onToggleOverlay: () => { handleToggleOverlay(tuiHandle); },
  });
  // pipeline 由 bootstrap 内构造，赋值到外层 let pipeline（agent loop 使用）
  pipeline = tuiHandle.pipeline;

  // resume 时回显历史消息到消息区（让用户看到之前的对话）
  if (sessionMessages.length > 0) {
    printLine(`── resumed ${sessionMessages.length} messages ──`);
    for (const m of sessionMessages) {
      if (m.role === 'user') {
        const text = typeof m.content === 'string' ? m.content : '(结构化内容)';
        pipeline.emit({ kind: 'user_input', text });
      } else {
        // assistant：从 content 提取文本
        const text = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((b): b is { type: 'text'; text: string } =>
                  typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
                .map(b => b.text)
                .join('')
            : '';
        if (text) {
          pipeline.emit({ kind: 'assistant_text', text, isFinal: true });
        }
      }
    }
    printLine('');
  }

  // 终端尺寸变化由 useTerminalSize hook 自动响应（ConnectedApp 内），无需手动 listener。

  // 进程退出兜底：杀后台子进程 + 卸载 Ink + 退 alt screen + 主屏 resume hint
  function cleanupOnExit(): void {
    backgroundManager.killAll();
    tuiHandle?.stopSpinner();
    tuiHandle?.cleanup();
    // 退出 alt screen 后，在主屏打印 resume hint（对齐 Claude Code）
    process.stdout.write(`\x1b[2mResume this session with:\nmicode --resume ${sessionId}\n\x1b[0m`);
  }
  process.on('SIGINT', () => { cleanupOnExit(); process.exit(0); });
  process.on('SIGTERM', () => { cleanupOnExit(); process.exit(0); });
  process.on('exit', () => { cleanupOnExit(); });

  // SessionStart hook：返回的 message 经 printLine 进 messagesStore（hook 不直写终端）
  void hookRunner.run({ name: 'SessionStart', payload: {} }).then(r => { if (r.message) printLine(r.message); });

  // 调度检查器
  setInterval(() => {
    scheduler.check();
    const notifications = scheduler.drain();
    for (const n of notifications) {
      printStyled(`[scheduled:${n.scheduleId}] ${n.prompt}`, 'system');
    }
  }, 60000);
} // end of else（非 --list 分支，进入 TUI）
