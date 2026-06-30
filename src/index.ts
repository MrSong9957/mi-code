#!/usr/bin/env node
// MiCode 主入口 —— 备用屏全屏画布渲染（alt screen + 整屏重画 + 逐格 diff）
//
// 物理本质：把整块终端屏幕当成一张虚拟画布（二维字符格子）。
// 上面大格是消息区（流式 token 在这里刷新），下面小格钉死状态栏 + 输入框。
// 每次状态变都在内存里重画一张新画布，和上一张逐格比对，只把"变了样的格子"
// 刷到终端——状态栏/输入框那几行格子没变就一个字节都不写，所以它们纹丝不动。
// 备用屏没有原生 scrollback，消息超出一屏时自动滚屏（视口取最后 N 行）。
//
// 这是 Claude Code 全屏模式的同款机制（文档 docs/Claude-Code-终端渲染架构-流式与输入框共存.md）。

import 'dotenv/config';
import { execSync } from 'child_process';
import { createDefaultRegistry } from './agent/tool-registry.js';
import { AnthropicStreamClient } from './agent/anthropic-stream-client.js';
import { streamingQuery } from './agent/streaming-query.js';
import { StreamEventBus } from './agent/stream-event-bus.js';
import { UILayout } from './ui/index.js';
import { BlockPipeline } from './ui/block-pipeline.js';
import { ConfigStore } from './config/index.js';
import { parseCommand, executeCommand } from './commands/index.js';
import { TodoManager } from './agent/todo.js';
import { createTaskTool } from './agent/tools/task-tool.js';
import { SkillRegistry, SkillNegotiator, createLoadSkillTool } from './skills/index.js';
import { parseBlockPrefix } from './commands/parser.js';
import { PermissionChecker } from './permission/index.js';
import { HookRunner, preToolSafetyCheck, postToolLogger, sessionStartLogger } from './hooks/index.js';
import { TeammateManager, createSendMessageTool, createReadInboxTool, NegotiationManager, createShutdownRequestTool, createRespondRequestTool, createSubmitPlanTool, createApprovePlanTool } from './agent/team/index.js';
import { ScheduleManager } from './agent/scheduler/index.js';
import { WorktreeManager } from './worktree/index.js';
import { TaskBoard } from './task-board/index.js';
import { HistoryManager } from './history.js';

const VERSION = "1.0.0";

// ─────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────
const configStore = new ConfigStore();
const MODEL = configStore.getModel();
const SMALL_MODEL = configStore.getSmallModel(configStore.getDefaultProvider());

const todoManager = new TodoManager();
const skillRegistry = new SkillRegistry();
skillRegistry.loadFromDir('skills');
const skillNegotiator = new SkillNegotiator();
const permissionChecker = new PermissionChecker({
  mode: configStore.getPermissionMode(),
  rules: configStore.getPermissionRules(),
  workdir: process.cwd(),
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
const historyManager = new HistoryManager();
const currentProject = process.cwd();

function getGitBranch(): string {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'no-git'; }
}
function getShortDir(): string {
  return process.cwd().replace(/\\/g, '/').split('/').slice(-2).join('/');
}
const GIT_BRANCH = getGitBranch();
const SHORT_DIR = getShortDir();

const childToolRegistry = createDefaultRegistry(todoManager, undefined, undefined, undefined, taskBoard, worktreeManager);
const toolRegistry = createDefaultRegistry(todoManager, undefined, undefined, undefined, taskBoard, worktreeManager);
const taskTool = createTaskTool(childToolRegistry, worktreeManager, SMALL_MODEL);
toolRegistry.register(taskTool.definition, taskTool.executor);
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

// ─────────────────────────────────────────────────────────────
// 渲染器：备用屏全屏画布（状态栏 + 输入框钉死底部，消息区上方流式刷新）
// ─────────────────────────────────────────────────────────────

function readTermSize(): { rows: number; cols: number } {
  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;
  const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  return { rows, cols };
}

/**
 * 主屏模式（对齐 Claude Code 默认）：无需备用屏/鼠标/同步更新检测。
 * 滚动交给终端原生 scrollback（用户用滚动条翻历史）。
 */
const termSize = readTermSize();

/**
 * UILayout：统一消息格式化 + 流式 Markdown 渲染 + 帧缓冲
 * 物理本质：排版工厂的总管——消息进、格式化、分区、渲染、终端出。
 */
const layout = new UILayout({
  rows: termSize.rows,
  cols: termSize.cols,
  writer: (s: string) => process.stdout.write(s),
  status: { mode: 'Act', model: MODEL, branch: GIT_BRANCH, dir: SHORT_DIR, contextUsage: 0 },
});

/**
 * 统一输出管道：所有渲染经 pipeline.emit(Block)，统一块间空行 + 格式契约。
 * pipeline 直接调 layout 的 raw* 原语（透传到 Renderer），不走 layout.send。
 */
const pipeline = new BlockPipeline({
  printMessage: (text, role, style) => layout.rawPrintMessage(text, (role ?? 'system') as 'user' | 'assistant' | 'system', style ?? {}),
  appendStreamingMarkdown: (text, isFinal, opts) => layout.rawAppendStreamingMarkdown(text, isFinal, opts ?? {}),
  finalizeStreaming: () => layout.rawFinalizeStreaming(),
  flushNow: () => layout.commit(),
  clearMessages: () => layout.rawClearMessages(),
});

/** 把一行文本作为"系统消息"固化进消息区（非模型内容：banner / hook / 提示等，直走 UILayout，不经 pipeline）。 */
function printLine(text: string): void {
  layout.send('system', text);
}

/** 把一行带样式的消息固化进消息区（非模型内容，按样式路由 UILayout 类型）。 */
function printStyled(text: string, style: Record<string, unknown>): void {
  if ((style as Record<string, unknown>).fg === 'green' && (style as Record<string, unknown>).bold) {
    // input 类型：UILayout 会添加 ❯ 前缀，所以去掉原始文本中的 ❯
    const cleanText = text.replace(/^❯\s*/, '');
    layout.send('input', cleanText);
  } else if ((style as Record<string, unknown>).fg === 'red') {
    layout.send('error', text);
  } else {
    layout.send('system', text);
  }
}

// 注：tool_result 的 diff 计算已移至 BlockPipeline（pendingToolInputs 缓存 +
// buildToolResultBlock 在 pipeline 内部）。index.ts 只 emit Block，不关心怎么算。

// ─────────────────────────────────────────────────────────────
// UI 状态
// ─────────────────────────────────────────────────────────────
let input = '';
let cursorPos = 0;
let isProcessing = false;

/** 同步输入态到渲染器并请求重绘（节流，不直接写屏）。 */
function syncInput(): void {
  layout.setInput(input, cursorPos);
}

// ─────────────────────────────────────────────────────────────
// 输入处理：Buffer 原始字节，手动解码 UTF-8
//
// 竞态修复：handler 顶部把数据并入 pending 缓冲（不丢弃），异步处理函数清空并消费它，
// finally 里检查是否又有新数据到达，有则续处理——确保连按按键零丢失。
// ─────────────────────────────────────────────────────────────
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let pending = Buffer.alloc(0);
  let historyBusy = false;

  process.stdin.on('data', (buf: Buffer) => {
    pending = Buffer.concat([pending, buf]);
    if (historyBusy) return;
    historyBusy = true;
    void handleInput();
  });

  async function handleInput() {
    try {
      const data = pending;
      pending = Buffer.alloc(0);

      for (let i = 0; i < data.length; ) {
        const byte = data[i]!;

        // Ctrl+C —— 始终生效（先退出、恢复光标，再退出进程）
        if (byte === 0x03) {
          layout.exit();
          process.exit(0);
        }

        // Ctrl+J —— 多行输入换行（预留 prompt 宽度空格对齐，最多 MAX_INPUT_LINES 行）
        if (byte === 0x0a) {
          const currentLines = input.split('\n').length;
          if (currentLines < 3) { // MAX_INPUT_LINES
            const promptPad = ' '.repeat([...layout.getPrompt()].length);
            const chars = [...input];
            input = chars.slice(0, cursorPos).join('') + '\n' + promptPad + chars.slice(cursorPos).join('');
            cursorPos += 1 + promptPad.length;
            syncInput();
          }
          i++; continue;
        }

        // Ctrl+O —— 预留：思考内容展开/折叠（待实现）
        if (byte === 0x0f) {
          i++; continue;
        }

        // ESC 序列检测（方向键）
        if (byte === 0x1b && i + 2 < data.length && data[i + 1] === 0x5b) {
          if (data[i + 2] === 0x41) {  // 上箭头：光标上移一行
            const lines = input.split('\n');
            let offset = 0;
            for (let li = 0; li < lines.length; li++) {
              const lineLen = [...lines[li]!].length;
              if (cursorPos <= offset + lineLen) {
                // 当前行是 li，光标在该行的 col = cursorPos - offset
                if (li > 0) {
                  const col = cursorPos - offset;
                  const prevLineLen = [...lines[li - 1]!].length;
                  const prevOffset = offset - prevLineLen - 1;
                  cursorPos = prevOffset + Math.min(col, prevLineLen);
                  syncInput();
                }
                break;
              }
              offset += lineLen + 1;
            }
            i += 3; continue;
          }
          if (data[i + 2] === 0x42) {  // 下箭头：光标下移一行
            const lines = input.split('\n');
            let offset = 0;
            for (let li = 0; li < lines.length; li++) {
              const lineLen = [...lines[li]!].length;
              if (cursorPos <= offset + lineLen) {
                if (li < lines.length - 1) {
                  const col = cursorPos - offset;
                  const nextLineLen = [...lines[li + 1]!].length;
                  const nextOffset = offset + lineLen + 1;
                  cursorPos = nextOffset + Math.min(col, nextLineLen);
                  syncInput();
                }
                break;
              }
              offset += lineLen + 1;
            }
            i += 3; continue;
          }
          if (data[i + 2] === 0x44) {  // 左箭头
            if (cursorPos > 0) { cursorPos--; syncInput(); }
            i += 3; continue;
          }
          if (data[i + 2] === 0x43) {  // 右箭头
            const maxPos = [...input].length;
            if (cursorPos < maxPos) { cursorPos++; syncInput(); }
            i += 3; continue;
          }
        }

        // 回车（仅 CR 提交，LF 由 Ctrl+J 处理）
        if (byte === 0x0d) {
          if (input.trim() === 'exit') {
            layout.exit();
            process.exit(0);
          }
          if (input.trim() && !isProcessing) {
            const userInput = input.trim();
            await historyManager.addEntry(userInput, currentProject);
            // 用户输入固化进消息区
            printStyled(`❯ ${userInput}`, { fg: 'green', bold: true });
            input = '';
            cursorPos = 0;

            // 检查 ! 前缀拦截
            const blockReq = parseBlockPrefix(userInput);
            if (blockReq) {
              skillNegotiator.block(blockReq.skillName, 'default');
              printLine(`Skill "${blockReq.skillName}" blocked.`);
              syncInput();
            } else {
              const cmd = parseCommand(userInput);
              if (cmd) {
                if (['skill', 'trigger', 'y', 'n', 'edit'].includes(cmd.name)) {
                  const result = executeCommand(cmd, { skillRegistry, negotiator: skillNegotiator, userId: 'default' });
                  printLine(result.message);
                } else {
                  const result = executeCommand(cmd, configStore, { permissionChecker });
                  printLine(result.message);
                }
                syncInput();
              } else {
                // Agent 循环
                todoManager.incrementRounds();
                const reminder = todoManager.getReminder() || todoManager.getVerificationNudge();
                const skillsDescription = skillRegistry.describeAvailable();
                const systemPrompt = [
                  'You are a helpful assistant that can execute shell commands and manipulate files.',
                  '',
                  skillsDescription,
                  reminder ? `\n${reminder}` : '',
                ].join('\n');

                isProcessing = true;
                let thinkingContent = '';
                let thinkingStart = Date.now();
                pipeline.emit({ kind: 'thinking_start' });

                const apiKey = configStore.getApiKey(configStore.getDefaultProvider());
                if (apiKey) {
                  const streamClient = new AnthropicStreamClient({ apiKey, model: MODEL });
                  const compactClient = new AnthropicStreamClient({ apiKey, model: SMALL_MODEL });
                  const eventBus = new StreamEventBus();
                  // 工具显示经统一管道：emit Block，pipeline 内部缓存 input + 计算 diff。
                  eventBus.onToolCall(d => {
                    pipeline.emit({ kind: 'tool_call', name: d.name, input: d.input });
                  });
                  eventBus.onToolResult(d => {
                    pipeline.emit({ kind: 'tool_result', name: d.name, output: d.output });
                  });
                  const tools = Array.from(toolRegistry.tools.values()).map(t => t.definition);
                  const ac = new AbortController();

                  (async () => {
                    // 当前 assistant 回合的累积文本（流式 Markdown 渲染用）
                    let assistantText = '';
                    try {
                      for await (const msg of streamingQuery(streamClient, toolRegistry, userInput, {
                        systemPrompt,
                        tools,
                        signal: ac.signal,
                        maxTurns: 10,
                        eventBus,
                        compactClient,
                      })) {
                        // AI 输出期间：累积 token，经 pipeline 渲染进消息区
                        if ('type' in msg && msg.type === 'content_block_delta') {
                          const delta = msg as { type: 'content_block_delta'; deltaType: string; content: string };
                          if (delta.deltaType === 'text' && delta.content) {
                            // 文本开始时，先固化思考内容
                            if (assistantText === '' && thinkingContent) {
                              const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
                              pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
                              thinkingContent = '';
                            }
                            assistantText += delta.content;
                            pipeline.emit({ kind: 'assistant_text', text: assistantText, isFinal: false });
                          } else if (delta.deltaType === 'thinking' && delta.content) {
                            thinkingContent += delta.content;
                            pipeline.emit({ kind: 'thinking_delta', content: delta.content });
                          }
                        } else if ('type' in msg && msg.type === 'assistant') {
                          // 一条 assistant 消息完成：finalize 流式（落定进 scrollback），下一条会新建
                          if (assistantText) {
                            pipeline.emit({ kind: 'assistant_text', text: assistantText, isFinal: true });
                            assistantText = '';
                          }
                        } else if ('type' in msg && msg.type === 'tool_result') {
                          const tr = msg as { type: 'tool_result'; name: string; output: string };
                          // 工具结果显示已由 eventBus.onToolResult 经 pipeline 处理，
                          // 这里仅跑 PostToolUse hook。
                          void hookRunner.run({
                            name: 'PostToolUse',
                            payload: { tool_name: tr.name, output: tr.output },
                          }).then(r => { if (r.message) printLine(r.message); });
                        }
                      }
                      // 循环结束兜底：若还有未收尾的累积文本，最终解析一次
                      if (assistantText) {
                        pipeline.emit({ kind: 'assistant_text', text: assistantText, isFinal: true });
                        assistantText = '';
                      }
                    } catch (err) {
                      layout.send('error', `[Error] ${err}`);
                    } finally {
                      isProcessing = false;
                      // 如果还在思考状态（没有收到文本），显示内容并折叠
                      if (thinkingContent) {
                        const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
                        pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
                        thinkingContent = '';
                      }
                      printLine('');
                      syncInput();
                    }
                  })();
                } else {
                  layout.send('error', `[Error] No API Key for ${configStore.getDefaultProvider()}. Use /login <provider> <key> to configure.`);
                  isProcessing = false;
                  layout.setHint(undefined);
                  syncInput();
                }
              }
            }
          } else if (!isProcessing) {
            input = '';
            cursorPos = 0;
            syncInput();
          }
          historyManager.reset();
          i++;
          continue;
        }

        // 退格
        if (byte === 0x08 || byte === 0x7F) {
          if (cursorPos > 0) {
            const chars = [...input];
            chars.splice(cursorPos - 1, 1);
            input = chars.join('');
            cursorPos--;
          }
          syncInput();
          i++;
          continue;
        }

        // 其他控制字符跳过
        if (byte < 0x20) { i++; continue; }

        // UTF-8 多字节字符
        let charLen = 1;
        if ((byte & 0xE0) === 0xC0) charLen = 2;
        else if ((byte & 0xF0) === 0xE0) charLen = 3;
        else if ((byte & 0xF8) === 0xF0) charLen = 4;

        if (i + charLen > data.length) {
          pending = data.subarray(i);
          break;
        }

        const char = data.subarray(i, i + charLen).toString('utf8');
        const chars = [...input];
        chars.splice(cursorPos, 0, char);
        input = chars.join('');
        cursorPos++;
        i += charLen;
        // 可打印字符入框后同步输入态（节流重绘）
        syncInput();
      }

      // 兜底：处理完一批按键后确保输入框反映最新 input（流式期间也照常，输入框始终可编辑）
      syncInput();
    } catch (err) {
      // 经统一管道显示
      layout.send('error', `[stdin handler error] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      historyBusy = false;
      // 处理期间若有新数据到达（连按按键），续处理，确保零丢失
      if (pending.length > 0) {
        historyBusy = true;
        void handleInput();
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

// 进入渲染模式（隐藏光标 + 画首帧）
layout.enter();

// 终端尺寸变化 → UILayout fullReset 重排
process.stdout.on('resize', () => {
  const { rows, cols } = readTermSize();
  layout.resize(rows, cols);
});

// 进程退出兜底：恢复光标
function cleanupOnExit(): void {
  layout.exit();
}
process.on('SIGINT', () => { cleanupOnExit(); process.exit(0); });
process.on('SIGTERM', () => { cleanupOnExit(); process.exit(0); });
process.on('exit', () => { cleanupOnExit(); });

// 一次性 banner（进消息区）
printLine('');
printStyled(' ▐▛███▜▌   MiCode v' + VERSION, { fg: 'cyan' });
printStyled('▝▜█████▛▘  TypeScript CLI · Node.js Runtime', { fg: 'cyan' });
printStyled('  ▘▘ ▝▝    ' + process.cwd(), { fg: 'cyan' });
printStyled(`model: ${MODEL}  ·  dir: ${SHORT_DIR}  ·  branch: ${GIT_BRANCH}`, { dim: true });
printLine('');

// SessionStart hook：返回的 message 经渲染器画进消息区（hook 不直写终端）
void hookRunner.run({ name: 'SessionStart', payload: {} }).then(r => { if (r.message) printLine(r.message); });

// 调度检查器
setInterval(() => {
  scheduler.check();
  const notifications = scheduler.drain();
  for (const n of notifications) {
    printStyled(`[scheduled:${n.scheduleId}] ${n.prompt}`, { fg: 'magenta' });
  }
}, 60000);

// 首次显示输入框
syncInput();
