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
import { OpenAIStreamClient } from './agent/openai-stream-client.js';
import { GoogleStreamClient } from './agent/google-stream-client.js';
import type { StreamingLLMClient } from './agent/types.js';
import { formatErrorForDisplay } from './cli/format-error.js';
import { streamingQuery } from './agent/streaming-query.js';
import { StreamEventBus } from './agent/stream-event-bus.js';
import { stripImagesForPersistence } from './agent/image-utils.js';
import type { ContentBlock } from './agent/types.js';
import { formatUserContentForResume } from './utils/format-content.js';
import { BlockPipeline } from './ui/block-pipeline.js';
import { bootstrap, type BootstrapHandle } from './tui/bootstrap.js';
import { readSpinnerContext } from './tui/spinner-context.js';
import { EMPTY_SPINNER_CONTEXT } from './tui/state/spinner-store.js';
import { finalizeTurnLifecycle, handleTurnLoopEnd, startTurnThinking, finishTurnThinking, idleTurnThinking, type TurnThinkingState } from './tui/turn-lifecycle.js';
import { writeResumeHint } from './cli/resume-hint.js';
import { ConfigStore, SUPPORTED_PROVIDERS } from './config/index.js';
import { parseCommand, executeCommand } from './commands/index.js';
import { processImageCommand } from './commands/image-command.js';
import { getModelsForProvider } from './commands/model-options.js';
import { TodoManager } from './agent/todo.js';
import { createTaskTool } from './agent/tools/task-tool.js';
import { createSpawnAgentTool } from './agent/tools/spawn-agent-tool.js';
import { createSpawnSelfOrganizingTool } from './agent/tools/spawn-self-organizing-tool.js';
import { runSubagent } from './agent/subagent.js';
import { plannerPrompt } from './prompts/index.js';
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
import { PlanStore, type PlanContext } from './plan/plan-store.js';
import { applyPlanApproval } from './plan/plan-approval-transition.js';
import { createWritePlanTool, createExitPlanModeTool, createReadPlanTool } from './agent/tools/plan-tools.js';
import { setWorkdir, getWorkdir } from './agent/tools/path-sandbox.js';
import { HistoryManager } from './history.js';
import { splitSubmitTracks, commitNewTurn } from './tui/input/submit-transformer.js';

const VERSION = "1.0.0";

// ─────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────
const configStore = new ConfigStore();

// ── 模型/provider 解析（动态,支持运行时 /model /provider 切换）──
// 旧实现：顶层 const MODEL = anthropic 槽位硬编码 → /model 命令改配置但不生效。
// 新实现：getter 函数每次调用时读当前 configStore → /model /provider 即时生效。
//
// createStreamClient 工厂按 provider 分发:
//   anthropic → AnthropicStreamClient
//   openai    → OpenAIStreamClient
//   google    → GoogleStreamClient
//   default   → AnthropicStreamClient(回退)
const SUPPORTED_PROVIDERS_SET = new Set(SUPPORTED_PROVIDERS);

/** 当前 defaultProvider(校验是否支持) */
function currentProvider(): string {
  const p = configStore.getDefaultProvider();
  return SUPPORTED_PROVIDERS_SET.has(p) ? p : 'anthropic';
}

/** 当前主模型名(读当前 provider 槽位) */
function currentModel(): string {
  return configStore.getModel();
}

/** 当前小模型名(子代理/压缩用) */
function currentSmallModel(): string {
  return configStore.getSmallModel();
}

/**
 * 创建流式客户端(工厂,按 provider 分发)。
 *
 * 三大 provider 已全部接入:
 *   anthropic → AnthropicStreamClient
 *   openai    → OpenAIStreamClient
 *   google    → GoogleStreamClient
 * 未识别的 provider 回退 anthropic。
 * compactClient(小模型)也走此工厂。
 */
function createStreamClient(provider: string, apiKey: string, model: string, baseUrl?: string): StreamingLLMClient {
  switch (provider) {
    case 'openai':
      return new OpenAIStreamClient({ apiKey, model, baseUrl });
    case 'google':
      return new GoogleStreamClient({ apiKey, model });
    case 'anthropic':
    default:
      return new AnthropicStreamClient({ apiKey, model, baseUrl });
  }
}

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
let currentPlanContext: PlanContext | null = null;
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

/** 主 agent 最近一轮的 system prompt（供 fork 子代理继承） */
let lastSystemPrompt = '';

const childToolRegistry = createDefaultRegistry(todoManager, undefined, scheduler, backgroundManager, taskBoard, worktreeManager);
const toolRegistry = createDefaultRegistry(todoManager, undefined, scheduler, backgroundManager, taskBoard, worktreeManager);
// task / spawn_self_organizing / spawn_agent 都用同一个 clientProvider 闭包：
// 每次 spawn 时读取当前 provider 配置，让子代理走主 agent 的多 provider 路径
// （streamingQuery），支持 OpenAI/MiMo 等非 Anthropic provider。
// modelChoice 让不同角色用不同模型（explore=small 便宜, plan/inherit=主模型）。
const subagentClientProvider = (modelChoice?: 'small' | 'inherit') => {
  const provider = currentProvider();
  const apiKey = configStore.getApiKey(provider);
  const baseUrl = configStore.getProvider(provider)?.baseUrl;
  const model = modelChoice === 'inherit' ? currentModel() : currentSmallModel();
  return createStreamClient(provider, apiKey ?? '', model, baseUrl);
};
const taskTool = createTaskTool(childToolRegistry, worktreeManager, subagentClientProvider);
toolRegistry.register(taskTool.definition, taskTool.executor);
const spawnSoTool = createSpawnSelfOrganizingTool(childToolRegistry, todoManager, inboxManager, {
  clientProvider: subagentClientProvider,
  permissionChecker,
});
toolRegistry.register(spawnSoTool.definition, spawnSoTool.executor);
// spawn_agent：派角色化子代理（explore/plan/general）
// 透传 permissionChecker：让子代理也受 plan 模式约束（读 allow / 写 deny）
// 透传技能目录：让子代理 system prompt 含技能发现信息（对齐 CC skill discovery）
function truncateSkillsDescription(desc: string, maxLines = 20): string {
  const lines = desc.split('\n');
  if (lines.length <= maxLines) return desc;
  return lines.slice(0, maxLines).join('\n') + `\n... and ${lines.length - maxLines} more skills`;
}
const spawnAgentTool = createSpawnAgentTool(
  childToolRegistry,
  subagentClientProvider,
  permissionChecker,
  runSubagent,
  truncateSkillsDescription(skillRegistry.describeAvailable()),
  () => lastSystemPrompt,  // getParentSystemPrompt
);
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

function refreshSpinnerContext(): void {
  if (!tuiHandle) return;
  const fallback = tuiHandle.spinnerStore.getState().context;
  tuiHandle.setSpinnerContext(readSpinnerContext(teammateManager, todoManager, fallback));
}

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

// ESC 中断句柄：handleUserSubmit 内创建 ac 时写入，abort/rewind 回调读它。
// 模块级是因为 onAbortStream/onRewindLastTurn 在 bootstrap 时注册，
// 远早于 handleUserSubmit 执行——闭包必须能拿到最新值。
let currentAbortController: AbortController | null = null;
// 撤回时回填的原文（用户实际发送的 agentText 展开版，不是占位符 historyText）
let lastSubmittedAgentText: string | null = null;
// 撤回判断用:本次提交前 messagesStore 的长度(在 commitNewTurn emit user_input 之前快照)。
// hasMeaningful 只检查 [lastSubmitMsgsLen..] 这段——避免历史 turn 残留的 assistant/tool
// 让当前 turn 的撤回被误判为软中断。
let lastSubmitMsgsLen = 0;
// 提交去重：防止鼠标事件等误触发导致同一文本被重复提交
const SUBMIT_DEDUP_WINDOW_MS = 2000;
let lastSubmitText = '';
let lastSubmitAt = 0;

const askManager = new AskUserManager({
  open: (id, request, done) => tuiHandle?.askQuestionStore.getState().open(id, request, done),
  close: (id) => tuiHandle?.askQuestionStore.getState().close(id),
});
// 注册 ask_user_question 工具（依赖 askManager）
const askTool = createAskUserTool(askManager);
toolRegistry.register(askTool.definition, askTool.executor);

/**
 * PlanStore：plan 文件落盘（plan 模式产出物的档案柜）。
 * 目录 ~/.micode/plans/，文件名 <sessionId>-<ts>.md。
 * 同时把 planDir 注册到 PermissionChecker，让 plan 模式下 write_file 写到该目录放行。
 */
const configuredPlansDir = configStore.getPlansDirectory();
const planStore = new PlanStore(join(homedir(), '.micode'), configuredPlansDir);
permissionChecker.setPlanDir(planStore.getPlansDir());
// 注册 write_plan_file 与 exit_plan_mode 工具（依赖 planStore + askManager）
const writePlanTool = createWritePlanTool(planStore, () => currentPlanContext);
toolRegistry.register(writePlanTool.definition, writePlanTool.executor);
const exitPlanTool = createExitPlanModeTool(askManager, planStore, {
  getUsagePercent: () => Math.round((tuiHandle?.statusStore.getState().contextPct ?? 0) * 100),
  getPlanContext: () => currentPlanContext,
  onApprove: (mode, clearContext) => applyPlanApproval(mode, clearContext, {
    clearPipeline: () => pipeline.clear(),
    triggerClearScreen: () => tuiHandle?.clearScreenStore.getState().triggerClearScreen(),
    clearSessionMessages: () => { sessionMessages = []; },
    rotateSessionId: () => { sessionId = randomUUID(); },
    resetContextUsage: () => tuiHandle?.statusStore.getState().setContextPct(0),
    setPermissionMode: (next) => permissionChecker.setMode(next),
    setConfigMode: (next) => configStore.setPermissionMode(next),
    setStatusMode: (next) => tuiHandle?.statusStore.getState().setMode(next),
  }),
});
toolRegistry.register(exitPlanTool.definition, exitPlanTool.executor);
// read_plan_file：只读工具，plan 模式下自然可见（不在 WRITE_TOOLS）
const readPlanTool = createReadPlanTool(planStore, () => currentPlanContext);
toolRegistry.register(readPlanTool.definition, readPlanTool.executor);
// 同时注册到 childToolRegistry：plan/explore 角色子代理需要这些工具（白名单由 roles.ts 控制）
childToolRegistry.register(writePlanTool.definition, writePlanTool.executor);
childToolRegistry.register(readPlanTool.definition, readPlanTool.executor);
// 注意：exit_plan_mode 和 ask_user_question 不注册到 childToolRegistry，
// 子代理不能直接与用户交互（由 SUBAGENT_DISALLOWED_TOOLS 兜底）

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
  // TAB = 接受当前高亮项(对标 Claude Code):选中 + 尾空格 + 关闭菜单
  // 上下箭头负责 cycle(handleTab 不 cycle,只接受第一项或当前高亮项)
  if (text.startsWith('/')) {
    const prefix = text.slice(1);
    // 如未打开或前缀不匹配,先 filter 打开;否则直接接受当前高亮
    const stillMatches = completion.visible
      && completion.candidates.length > 0
      && completion.candidates.every(c => c.name.startsWith(prefix));
    if (!stillMatches) {
      completion.filter(prefix);
    }
    const sel = completion.selected();
    completion.hide();
    if (sel) {
      handle.inputStore.getState().setText('/' + sel + ' ');
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
 * 2. 新 turn：history 落盘 + clearTurnState + emit user_input + 命令解析 + agent loop
 *
 * ink-store 迁移点：input/cursorPos 已由 inputStore 管理（submit 时清空），故删除旧
 * input=''/cursorPos=0/syncInput；layout.* → tuiHandle.statusStore。
 */
/**
 * ESC 中断当前 LLM 流。幂等：无任务运行(ac 为 null)或已 aborted 时空操作。
 * 由 React 层的 useInputHandler 通过 BootstrapOptions.onAbortStream 调用。
 */
function handleAbortStream(): void {
  currentAbortController?.abort();
}

/**
 * ESC 双击撤回末条 user turn。
 * 时序:先读当前 messages 判断 hasMeaningful(abort 前流式块还在),
 *       再中断流并等 finally 完成,最后操作 store + 同步 sessionMessages + 回填输入框。
 *
 * 语义:
 *  - 硬撤回(无有意义 assistant 内容):删末条 user 及其后 + 同步 sessionMessages + 换 sessionId + 回填
 *  - 软中断(有有意义内容):仅 finalize 流式为 [interrupted],不删、不回填、不换 sessionId
 */
async function handleRewindLastTurn(): Promise<void> {
  const handle = tuiHandle;
  if (!handle) return;

  // 1. 先读当前 messages(必须在 abort 之前——abort 后流式块可能被清理)
  const msgs = handle.messagesStore.getState().messages;
  // 只在本次提交后的范围 [lastSubmitMsgsLen..] 内找末条 user——
  // 避免历史 turn 残留干扰(若用全表末条 user,会错误地指向历史 turn)。
  let userIdx = -1;
  for (let i = msgs.length - 1; i >= lastSubmitMsgsLen; i--) {
    if (msgs[i]!.role === 'user') { userIdx = i; break; }
  }
  if (userIdx === -1) return; // 幂等:本次提交范围内无 user 可撤回

  // 判断本次提交的 user 之后是否有"有意义的 assistant 内容"
  // (finalized 的 lines 有非空 content,或流式的 streamingText trim 后非空)
  // 注意:只看 userIdx 之后的消息——这些都是本次 turn 的产物(因为 user 是本范围内的末条)。
  const hasMeaningful = msgs.slice(userIdx + 1).some((m) => {
    if (m.role !== 'assistant') return false;
    if (!m.finalized) return (m.streamingText ?? '').trim().length > 0;
    return m.lines.some((l) => (l.content ?? '').trim().length > 0);
  });

  // 2. 若仍在跑,先中断并等流真正停止(isProcessing 翻 false)
  if (currentAbortController && !currentAbortController.signal.aborted) {
    currentAbortController.abort();
    // 轮询等 finally 完成,2s 超时兜底防止死锁
    for (let i = 0; i < 100 && isProcessing; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // 3. 操作 store
  if (hasMeaningful) {
    // 软中断:仅 finalize 流式为 [interrupted]
    handle.messagesStore.getState().finalizeStreamingAsInterrupted();
    return; // 不删 user、不回填、不换 sessionId
  }

  // 硬撤回:删末条 user 及其后
  handle.messagesStore.getState().rewindLastUserTurn();

  // 4. 同步 sessionMessages(关注点分离:store 外做)
  let uIdx = -1;
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    if (sessionMessages[i]!.role === 'user') { uIdx = i; break; }
  }
  if (uIdx !== -1) {
    sessionMessages = sessionMessages.slice(0, uIdx);
  }

  // 5. 换 sessionId(旧 jsonl 保留,resume 时新会话不带撤回的消息)
  sessionId = randomUUID();

  // 6. 回填输入框(用户实际发送的 agentText 展开版)
  if (lastSubmittedAgentText !== null) {
    handle.inputStore.getState().setText(lastSubmittedAgentText);
    lastSubmittedAgentText = null;
  }

  // 7. 打印撤回标记(inline 模式视觉层降级)
  // inline 模式下终端无法擦除已输出到 scrollback 的行——messagesStore 已正确删除,
  // 但屏幕上原消息物理残留。打印简短标记让用户知道撤回已生效,把"作废的旧消息"
  // 与"新对话"在视觉上隔开。(alt-screen 模式下 Ink diff 引擎会自动擦除,此标记冗余)
  printLine('── 上一条消息已撤回 ──');
}

async function handleUserSubmit(rawText: string): Promise<void> {
  const now = Date.now();
  const trimmedForDedup = rawText.trim();
  const isDup = trimmedForDedup === lastSubmitText && now - lastSubmitAt < SUBMIT_DEDUP_WINDOW_MS;

  if (isDup) return;
  lastSubmitText = trimmedForDedup;
  lastSubmitAt = now;

  // 历史存占位符版本（省磁盘），agent/解析/回显用展开版本（需完整上下文）。
  // sessionStore 仍存展开版本（resume 后占位符 ID 跨 session 失效，需完整文本）。
  const { historyText: trimmedRaw, agentText: userInput } = splitSubmitTracks(rawText);
  if (userInput === 'exit') {
    tuiHandle?.cleanup();
    process.exit(0);
  }

  // 新 turn
  // 快照提交前的 messagesStore 长度(撤回判断用,见 handleRewindLastTurn)。
  // 必须在 commitNewTurn emit user_input 之前——emit 后 user 消息就进 store 了。
  lastSubmitMsgsLen = tuiHandle?.messagesStore.getState().messages.length ?? 0;
  const committed = await commitNewTurn(
    {
      addEntry: (i, p) => historyManager.addEntry(i, p),
      clearTurnState: () => pipeline.clearTurnState(),
      emit: (b) => pipeline.emit(b),
    },
    { historyText: trimmedRaw, agentText: userInput, project: currentProject, isProcessing }
  );
  if (!committed) return;
  currentPlanContext = { sessionId, turnId: randomUUID() };
  planStore.beginTurn(currentPlanContext);

  // 检查 ! 前缀拦截
  const blockReq = parseBlockPrefix(userInput);
  if (blockReq) {
    skillNegotiator.block(blockReq.skillName, 'default');
    printLine(`Skill "${blockReq.skillName}" blocked.`);
    return;
  }

  const cmd = parseCommand(userInput);
  // /image 特殊路径:提取图片后继续走 agent loop(不短路 return)。
  // 其他斜杠命令短路 return,不进 agent loop。
  let userMessageForAgent: string | ContentBlock[] | null = null;
  if (cmd && cmd.name === 'image') {
    const imgResult = await processImageCommand(cmd.args, sessionId);
    if ('error' in imgResult) {
      printLine(`✗ ${imgResult.error}`);
      return;
    }
    userMessageForAgent = imgResult.content;
  } else if (cmd) {
    // /model 无参数 → 打开交互式模型选择界面
    if (cmd.name === 'model' && cmd.args.length === 0) {
      const provider = currentProvider();
      const model = currentModel();
      const providerConfig = configStore.getProvider(provider);
      const options = getModelsForProvider(provider, model, providerConfig?.models);
      tuiHandle?.selectStore.getState().open('Select model', options, (opt) => {
        configStore.setModel(provider, opt.value);
        tuiHandle?.statusStore.getState().setModel(opt.value);
        printLine(`Model switched to: ${opt.label} (${opt.value})`);
      });
      return;
    }
    if (['skill', 'trigger', 'y', 'n', 'edit'].includes(cmd.name)) {
      const result = executeCommand(cmd, { skillRegistry, negotiator: skillNegotiator, userId: 'default' });
      printLine(result.message);
    } else {
      const result = executeCommand(cmd, configStore, { permissionChecker, themeStore: tuiHandle?.themeStore });
      printLine(result.message);
      if (cmd.name === 'plan' || cmd.name === 'build' || cmd.name === 'auto') {
        tuiHandle?.statusStore.getState().setMode(permissionChecker.getMode());
      }
      // /model /provider:即时更新状态栏模型显示(下次对话用新 model 构造 streamClient)
      if (cmd.name === 'model' || cmd.name === 'provider') {
        tuiHandle?.statusStore.getState().setModel(currentModel());
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
    ? `\n\n${plannerPrompt}`
    : '';

  const systemPrompt = [
    'You are a helpful assistant. Answer questions directly with text — do NOT use tools for simple conversation.',
    'You have tools (run_bash, read_file, write_file, etc.) for when you need to perform real operations on the system.',
    'Only use tools when the user asks you to do something concrete (run a command, read/edit a file, search code).',
    'For questions, explanations, and advice, respond with plain text — never wrap your reply in a Bash echo command.',
    '',
    // 意图检测层：探索型/规划型任务优先 spawn 子代理，避免主上下文膨胀。
    // 在任何模式下生效（不限于 plan 模式），让"生成改造计划"等请求自动触发委派。
    'When the user\'s request implies a multi-step investigation, planning, architecture analysis,',
    'or restructuring task (e.g. "generate a plan", "改造", "分析架构", "refactor"), spawn explore',
    'sub-agents (spawn_agent role="explore") to investigate in parallel FIRST, before reading files',
    'yourself. Each sub-agent returns a summary you can synthesize — this keeps your context focused.',
    '',
    // AUTO-0025 Task 5:显式委派约束。
    // 当用户明确要求"用子代理/spawn agent"时,主 agent 不能在子代理失败后静默用自己的工具重做。
    // 子代理输出携带 [Subagent status=...] 前缀,主 agent 据此判断成功/失败。
    // 注意:此约束仅限用户显式要求子代理的场景;主 agent 自己选择的自动委派失败后仍可容错。
    'When the user explicitly requires a subagent (e.g. "用子代理", "use a subagent", "spawn an agent"),',
    'do not replace an incomplete or failed subagent run with your own filesystem/tool investigation.',
    'Report the subagent status (from the [Subagent status=...] prefix) and available partial result.',
    'This restriction does not apply to automatic delegation that you selected yourself.',
    '',
    skillsDescription,
    reminder ? `\n${reminder}` : '',
    planModeInstruction,
  ].join('\n');

  // 记录最近一轮的 system prompt，供 fork 子代理继承
  lastSystemPrompt = systemPrompt;

  isProcessing = true;

  // 动态读 provider/apiKey/model(支持运行时 /model /provider 切换)。
  // createStreamClient 工厂按 provider 分发(anthropic/openai)。
  const provider = currentProvider();
  const model = currentModel();
  const apiKey = configStore.getApiKey(provider);
  if (!apiKey) {
    tuiHandle?.printStyled(`[Error] No API Key for ${provider} provider. Use /login ${provider} <key> to configure.`, 'error');
    isProcessing = false;
    return;
  }

  // baseUrl(可选):用于第三方 Anthropic/OpenAI 兼容服务(如 MiMo)。
  // 不配置时各 SDK 走官方端点。
  const baseUrl = configStore.getProvider(provider)?.baseUrl;
  const streamClient = createStreamClient(provider, apiKey, model, baseUrl);
  const compactClient = createStreamClient(provider, apiKey, currentSmallModel(), baseUrl);
  const eventBus = new StreamEventBus();
  const activeToolIds = new Set<string>();
  // AUTO-0025-transient:用不可变 TurnThinkingState 替换原始 thinkingActive/thinkingContent/thinkingStart。
  // 所有退出路径(content_block_stop thinking、首个 assistant text、onToolCall、loop-end、finally)
  // 统一走 finishTurnThinking,幂等保证只 emit 一次 thinking_end。
  let thinking: TurnThinkingState = idleTurnThinking();
  const turnLifecycle = {
    activeToolIds,
    setSpinnerHasActiveTools: (hasActiveTools: boolean) => {
      tuiHandle?.setSpinnerHasActiveTools(hasActiveTools);
    },
    emitThinkingEnd: (durationSec: number) => {
      pipeline.emit({ kind: 'thinking_end', durationSec, filesRead: 0 });
    },
    stopSpinner: () => {
      tuiHandle?.stopSpinner();
    },
    now: Date.now,
  };
  eventBus.onToolCall(d => {
    // AUTO-0025-transient:工具乱序兼容——thinking 仍 active 时,先幂等结束 thinking,
    // 再创建工具行。多个并行 tool_call 只 emit 一次 thinking_end(第二次 finish 因 active=false 跳过)。
    thinking = finishTurnThinking(turnLifecycle, thinking);
    tuiHandle?.setSpinnerMode('tool-use');
    activeToolIds.add(d.toolUseId);
    tuiHandle?.setSpinnerHasActiveTools(true);
    pipeline.emit({ kind: 'tool_call', name: d.name, input: d.input, toolUseId: d.toolUseId });
  });
  eventBus.onToolResult(d => {
    activeToolIds.delete(d.toolUseId);
    tuiHandle?.setSpinnerHasActiveTools(activeToolIds.size > 0);
    // AUTO-0025-transient Task 3:传 durationMs,供 spawn_agent 完成展示用。
    pipeline.emit({ kind: 'tool_result', name: d.name, output: d.output, toolUseId: d.toolUseId, durationMs: d.duration });
    refreshSpinnerContext();
  });
  eventBus.onLoopEnd(() => {
    handleTurnLoopEnd(turnLifecycle);
  });
  eventBus.onError(d => {
    if (d.recoverable) {
      // 可恢复错误（如 context_overflow 压缩）：静默处理，不阻断用户
      return;
    }
    // 不可恢复错误：显示给用户
    tuiHandle?.printStyled(`[Error] ${d.message}`, 'error');
  });
  const allToolDefs = Array.from(toolRegistry.tools.values()).map(t => t.definition);
  const tools = currentMode === 'plan'
    ? allToolDefs.filter(t => !WRITE_TOOLS.includes(t.name))
    : allToolDefs;
  const ac = new AbortController();
  currentAbortController = ac;
  lastSubmittedAgentText = userInput;

  // agent 循环（与旧实现 verbatim，仅 layout.* → tuiHandle.statusStore）
  let assistantText = '';
  let persistedCount = sessionMessages.length;
  const blockTypes = new Map<number, string>();
  // Spinner 立即启动(label="Connecting..."),收到第一个 event 后切到正常 verb。
  // 兼顾"用户有即时反馈"和"状态准确"。
  let spinnerStarted = false;
  let gotAnyResponse = false; // 是否收到过任何 assistant 内容(用于空响应检测)
  refreshSpinnerContext();
  tuiHandle?.startSpinner('requesting');
  tuiHandle?.setSpinnerLabel('Connecting');
  spinnerStarted = true;
  try {
    // 不传 maxTurns：对齐 Claude Code，默认无限循环，依赖 LLM 自主 end_turn + 用户 ESC +
    // budget 软限制退出。需要时可通过 StreamingQueryOptions.maxTurns 显式注入安全网。
    for await (const msg of streamingQuery(streamClient, toolRegistry, userMessageForAgent ?? userInput, {
      systemPrompt, tools, signal: ac.signal,
      eventBus, compactClient, permissionChecker,
      initialMessages: sessionMessages.length > 0 ? sessionMessages : undefined,
      onMessages: (finalMessages) => {
        const newMsgs = finalMessages.slice(persistedCount);
        sessionMessages = finalMessages;
        persistedCount = finalMessages.length;
        for (const m of newMsgs) {
          // 持久化前 strip image base64(只存 cachePath),避免 JSONL 膨胀
          void sessionStore.append(sessionId, stripImagesForPersistence(m));
        }
      },
    })) {
      // 第一个 event 到达 → 清除 "Connecting" label,恢复到 spinner 默认 verb
      if (spinnerStarted) {
        tuiHandle?.setSpinnerLabel('');
        tuiHandle?.setSpinnerMode('responding');
        spinnerStarted = false;
      }

      if ('type' in msg && msg.type === 'content_block_start') {
        const cbs = msg as { type: 'content_block_start'; index: number; blockType: string };
        blockTypes.set(cbs.index, cbs.blockType);
        if (cbs.blockType === 'thinking' && !thinking.active) {
          thinking = startTurnThinking(thinking, Date.now());
          pipeline.emit({ kind: 'thinking_start' });
          tuiHandle?.setSpinnerMode('thinking');
        }
      } else if ('type' in msg && msg.type === 'content_block_stop') {
        const cstop = msg as { type: 'content_block_stop'; index: number };
        if (blockTypes.get(cstop.index) === 'thinking' && thinking.active) {
          thinking = finishTurnThinking(turnLifecycle, thinking);
          tuiHandle?.setSpinnerMode('responding');
        }
      } else if ('type' in msg && msg.type === 'content_block_delta') {
        const delta = msg as { type: 'content_block_delta'; deltaType: string; content: string };
        if (delta.content) tuiHandle?.spinnerOnToken(delta.content.length);
        if (delta.deltaType === 'text' && delta.content) {
          gotAnyResponse = true;
          if (assistantText === '' && thinking.active) {
            thinking = finishTurnThinking(turnLifecycle, thinking);
            tuiHandle?.setSpinnerMode('responding');
          }
          assistantText += delta.content;
          pipeline.emit({ kind: 'assistant_text', text: assistantText, isFinal: false });
        } else if (delta.deltaType === 'thinking' && delta.content) {
          // 无 start 的隐式 delta(防御):先 start 再 emit delta
          if (!thinking.active) {
            thinking = startTurnThinking(thinking, Date.now());
            pipeline.emit({ kind: 'thinking_start' });
          }
          pipeline.emit({ kind: 'thinking_delta', content: delta.content });
        }
      } else if ('type' in msg && msg.type === 'message_start') {
        // 上下文占用：input_tokens / context_window(200000) → 进度条百分比
        const ms = msg as { type: 'message_start'; inputTokens?: number };
        if (typeof ms.inputTokens === 'number') {
          tuiHandle?.statusStore.getState().setContextPct(ms.inputTokens / 200000);
        }
      } else if ('type' in msg && msg.type === 'assistant') {
        gotAnyResponse = true;
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
    // 空响应检测:stream 结束但没收到任何 assistant 内容
    if (!gotAnyResponse) {
      const hasImage = Array.isArray(userMessageForAgent) && userMessageForAgent.some(b => b.type === 'image');
      tuiHandle?.printStyled(
        hasImage
          ? '[Warning] API 返回空响应。该模型可能不支持图片输入(vision)。请换用支持 vision 的模型。'
          : '[Warning] API 返回空响应,没有生成任何内容。',
        'error',
      );
    }
  } catch (err) {
    // 中断判断：用 ac.signal.aborted，不用 err.name/instanceof Error。
    // 实测：ac.abort('user-cancel') 抛出的 err 是字符串(不是 Error)，err.name 是 undefined。
    // 只有 ac.signal.aborted 在三种 abort 形态下都为 true。
    if (ac.signal.aborted) {
      // 用户主动中断：静默退出，不打印 [Error]
    } else {
      // formatErrorForDisplay 只取 message（不含堆栈），超长截断——
      // 避免把整个 Error.stack 刷屏到终端（之前的 [system] [Error] Error [ERR_UNHANDLED_ERROR]... 问题）
      tuiHandle?.printStyled(`[Error] ${formatErrorForDisplay(err)}`, 'error');
    }
  } finally {
    // AUTO-0025-transient:统一退出路径——finalizeTurnLifecycle 幂等结束 thinking + stop spinner。
    thinking = finalizeTurnLifecycle(turnLifecycle, thinking);
    isProcessing = false;
    currentAbortController = null;
    // lastSubmittedAgentText 在 turn 结束时清空。
    // 硬撤回分支(本函数之外)在用过后会单独置 null;正常完成 / soft-interrupt /
    // 异常退出都不会用它,但为防止边缘时序下读到上一轮的陈旧值,统一在此清。
    // (新 turn 的 handleUserSubmit 会重新赋值)
    lastSubmittedAgentText = null;
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
      model: currentModel(),
      dir: SHORT_DIR,
      branch: GIT_BRANCH,
    },
    renderMode: 'inline',
    themeName: cliOpts.theme ?? configStore.getTheme(),
    spinnerVerbs: configStore.getSpinnerVerbsConfig(),
    spinnerContext: readSpinnerContext(teammateManager, todoManager, EMPTY_SPINNER_CONTEXT),
    onSubmit: (text) => { void handleUserSubmit(text); },
    onExit: () => { cleanupOnExit(); process.exit(0); },
    onTab: (text) => { handleTab(text, tuiHandle, configStore, permissionChecker); },
    onToggleOverlay: () => { handleToggleOverlay(tuiHandle); },
    onAbortStream: () => { void handleAbortStream(); },
    onRewindLastTurn: () => { void handleRewindLastTurn(); },
  });
  // pipeline 由 bootstrap 内构造，赋值到外层 let pipeline（agent loop 使用）
  pipeline = tuiHandle.pipeline;

  // resume 时回显历史消息到消息区（让用户看到之前的对话）
  if (sessionMessages.length > 0) {
    printLine(`── resumed ${sessionMessages.length} messages ──`);
    for (const m of sessionMessages) {
      if (m.role === 'user') {
        const text = formatUserContentForResume(m.content);
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
  let cleanedUp = false;
  function cleanupOnExit(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    backgroundManager.killAll();
    tuiHandle?.stopSpinner();
    tuiHandle?.cleanup();
    writeResumeHint(process.stdout, sessionId);
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
