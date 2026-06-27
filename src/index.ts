#!/usr/bin/env node
import 'dotenv/config';
import { renderTree, type RenderNode } from './renderer/index.js';
import { execSync } from 'child_process';
import { createDefaultRegistry } from './agent/tool-registry.js';
// import { runWithVercelAI } from './agent/llm-vercel.js'; // 旧路径，已替换为流式
import { AnthropicStreamClient } from './agent/anthropic-stream-client.js';
import { streamingQuery } from './agent/streaming-query.js';
import { StreamEventBus } from './agent/stream-event-bus.js';
import { StreamEventRenderer } from './renderer/stream-renderer.js';
import { ConfigStore } from './config/index.js';
import { parseCommand, executeCommand } from './commands/index.js';
import { TodoManager } from './agent/todo.js';
import { createTaskTool } from './agent/tools/task-tool.js';
import { SkillRegistry, SkillNegotiator, createLoadSkillTool } from './skills/index.js';
import { parseBlockPrefix } from './commands/parser.js';
import { PermissionChecker } from './permission/index.js';
import { HookRunner, preToolSafetyCheck, sessionStartLogger } from './hooks/index.js';
import { TeammateManager, createSendMessageTool, createReadInboxTool, NegotiationManager, createShutdownRequestTool, createRespondRequestTool, createSubmitPlanTool, createApprovePlanTool } from './agent/team/index.js';
import { ScheduleManager } from './agent/scheduler/index.js';
import { WorktreeManager } from './worktree/index.js';
import { TaskBoard } from './task-board/index.js';
import { HistoryManager } from './history.js';

const VERSION = "1.0.0";

// 初始化配置
const configStore = new ConfigStore();
const MODEL = configStore.getModel();

// 初始化 TodoManager
const todoManager = new TodoManager();

// 初始化技能系统
const skillRegistry = new SkillRegistry();
skillRegistry.loadFromDir('skills');
const skillNegotiator = new SkillNegotiator();

// 初始化权限系统（从配置加载模式与规则，持久化重启可恢复）
const permissionChecker = new PermissionChecker({
  mode: configStore.getPermissionMode(),
  rules: configStore.getPermissionRules(),
  workdir: process.cwd(),
});

// 初始化团队系统
const teammateManager = new TeammateManager('.team');
const negotiationManager = new NegotiationManager();

// 初始化调度系统
const scheduler = new ScheduleManager('.schedules.json');
scheduler.load();

// 初始化 Hook 系统
const hookRunner = new HookRunner();
hookRunner.register('PreToolUse', preToolSafetyCheck);
hookRunner.register('SessionStart', sessionStartLogger);

// 初始化 Worktree 系统（启动时恢复：清理已不存在的 worktree 索引）
const worktreeManager = new WorktreeManager(process.cwd());
worktreeManager.recover();

// 初始化任务看板（从 .tasks.json 断点恢复）
const taskBoard = new TaskBoard();
taskBoard.load(process.cwd());

// 初始化历史管理器
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

// 状态
let input = '';
let cursorPos = 0;  // 光标在 input 中的字符索引
const messages: string[] = [];
let systemMessage = 'Ready';
let systemVisible = true;
let isProcessing = false;  // Agent 是否正在处理

// 权限确认状态机：当工具触发 ask 决策时，暂停输入循环等待用户 y/n
let awaitingPermission = false;
let pendingPermissionResolve: ((approved: boolean) => void) | null = null;
let pendingPermissionPrompt = '';  // 显示给用户的确认提示行

// Agent 组件
// 子代理工具注册表（没有 task 工具，禁止递归；含 taskBoard + worktree 工具）
const childToolRegistry = createDefaultRegistry(todoManager, undefined, undefined, undefined, taskBoard, worktreeManager);
// 父代理工具注册表（有 task 工具）
const toolRegistry = createDefaultRegistry(todoManager, undefined, undefined, undefined, taskBoard, worktreeManager);
const taskTool = createTaskTool(childToolRegistry, worktreeManager);
toolRegistry.register(taskTool.definition, taskTool.executor);
// 注册 load_skill 工具
const loadSkillTool = createLoadSkillTool(skillRegistry);
toolRegistry.register(loadSkillTool.definition, loadSkillTool.executor);
// 注册团队工具
const sendMessageTool = createSendMessageTool(teammateManager);
toolRegistry.register(sendMessageTool.definition, sendMessageTool.executor);
const readInboxTool = createReadInboxTool(teammateManager);
toolRegistry.register(readInboxTool.definition, readInboxTool.executor);
// 注册协商工具
const shutdownRequestTool = createShutdownRequestTool(negotiationManager, teammateManager);
toolRegistry.register(shutdownRequestTool.definition, shutdownRequestTool.executor);
const respondRequestTool = createRespondRequestTool(negotiationManager);
toolRegistry.register(respondRequestTool.definition, respondRequestTool.executor);
const submitPlanTool = createSubmitPlanTool(negotiationManager);
toolRegistry.register(submitPlanTool.definition, submitPlanTool.executor);
const approvePlanTool = createApprovePlanTool(negotiationManager);
toolRegistry.register(approvePlanTool.definition, approvePlanTool.executor);

// 构建 UI 树
function buildTree(): RenderNode {
  // 计算终端高度
  const terminalHeight = process.stdout.rows || 24;

  // 固定区域高度（底部）
  // input: 上边框(1) + 内容(1) + 下边框(1) = 3行
  // statusBar: 1行
  // root paddingY: 2行
  const bottomFixedHeight = 3 + 1 + 2; // 6行

  // 消息区高度 = 终端高度 - 底部固定区域 - banner高度
  // banner: 3行内容 + marginY(1) = 4行
  const bannerHeight = 4;
  const messageAreaHeight = Math.max(3, terminalHeight - bottomFixedHeight - bannerHeight);

  return {
    type: 'box',
    props: { flexDirection: 'column', paddingX: 1, paddingY: 1 },
    children: [
      // Banner
      buildBanner(),
      // 消息区（固定高度）
      buildMessages(messageAreaHeight),
      // 输入框（固定在底部）
      buildInput(),
      // 状态栏（固定在底部）
      buildStatusBar(),
    ],
  };
}

function buildBanner(): RenderNode {
  return {
    type: 'box',
    props: { flexDirection: 'column', marginY: 1 },
    children: [
      { type: 'text', text: ' ▐▛███▜▌   MiCode v' + VERSION, props: { color: 'cyan' } },
      { type: 'text', text: '▝▜█████▛▘  TypeScript CLI · Node.js Runtime', props: { color: 'cyan' } },
      { type: 'text', text: '  ▘▘ ▝▝    ' + process.cwd(), props: { color: 'cyan' } },
    ],
  };
}

function buildMessages(maxHeight: number): RenderNode {
  const lines: RenderNode[] = [];

  if (messages.length === 0) {
    lines.push({ type: 'text', text: 'Welcome to MiCode. Type something to start.', props: { dim: true } });
  } else {
    // 只显示最近的N条消息，确保输入框固定在底部
    const startIdx = Math.max(0, messages.length - maxHeight);
    for (let i = startIdx; i < messages.length; i++) {
      lines.push({ type: 'text', text: messages[i], props: {} });
    }
  }

  // 权限确认提示行（ask 闸门）
  if (awaitingPermission) {
    lines.push({ type: 'text', text: pendingPermissionPrompt, props: { color: 'yellow' } });
  }

  return {
    type: 'box',
    props: { flexDirection: 'column', marginY: 1, height: maxHeight },
    children: lines,
  };
}

function buildInput(): RenderNode {
  const cursor = '❯';
  return {
    type: 'box',
    props: { borderStyle: 'single', borderColor: 'white', paddingX: 1 },
    children: [
      { type: 'text', text: cursor + ' ' + input, props: { bold: true, color: 'white' } },
    ],
  };
}

function buildStatusBar(): RenderNode {
  return {
    type: 'box',
    props: { flexDirection: 'row', justifyContent: 'space-between' },
    children: [
      // 左侧各项（不同颜色）
      { type: 'text', text: 'Plan', props: { bold: true, color: 'yellow' } },
      { type: 'text', text: ' | ', props: { color: 'gray' } },
      { type: 'text', text: MODEL, props: { bold: true, color: 'cyan' } },
      { type: 'text', text: ' | ', props: { color: 'gray' } },
      { type: 'text', text: SHORT_DIR, props: { bold: true, color: 'blue' } },
      { type: 'text', text: ' | ', props: { color: 'gray' } },
      { type: 'text', text: GIT_BRANCH, props: { bold: true, color: 'magenta' } },
      // 右侧系统消息
      { type: 'text', text: systemVisible ? systemMessage : '', props: { color: 'green' } },
    ],
  };
}

// 计算单个字符的终端宽度（与 renderer 一致）
function charWidth(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 0x4E00 && code <= 0x9FFF) return 2;  // CJK
  if (code >= 0x3000 && code <= 0x303F) return 2;  // CJK 符号
  if (code >= 0xFF00 && code <= 0xFFEF) return 2;  // 全角字符
  if (code >= 0x2E80 && code <= 0x2FDF) return 2;  // CJK 部首
  return 1;
}

/**
 * 请求用户权限确认（ask 闸门）
 *
 * 由 runWithVercelAI 在权限决策为 ask 时调用。设置 awaitingPermission=true，
 * 渲染提示行后挂起 Promise，等待输入循环处理 y/n 按键时 resolve。
 */
function requestPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  reason: string,
): Promise<boolean> {
  // 构造简短的可读提示
  const detail = toolName === 'run_bash'
    ? (toolInput.command as string) ?? ''
    : (toolInput.path as string) ?? JSON.stringify(toolInput).slice(0, 60);
  pendingPermissionPrompt = `⚠ Permission: ${toolName} — ${reason}${detail ? `\n   ${detail}` : ''}\n   Allow? [y/N]`;

  return new Promise<boolean>((resolve) => {
    pendingPermissionResolve = resolve;
    awaitingPermission = true;
    input = '';          // 清空当前输入，避免干扰确认
    cursorPos = 0;
    scheduleRender();
  });
}

// 渲染循环
function scheduleRender() {
  renderTree(buildTree());
  // 将终端光标定位到输入框内的正确位置
  positionCursor();
}

// 计算并定位终端光标到输入框
function positionCursor() {
  // 布局计算（行和列都是 1-based）：
  // 行：root paddingY(1) + banner marginY(1) + banner 3行 + messages marginY(1) + messages行数 + input marginY(1) + border上(1)
  // 注意：消息区高度受限制，只显示最近的N条消息

  // 计算实际显示的消息行数（考虑高度限制）
  const terminalHeight = process.stdout.rows || 24;
  const bottomFixedHeight = 3 + 1 + 2; // input(3) + statusBar(1) + root paddingY(2)
  const bannerHeight = 4;
  const maxMessageLines = Math.max(3, terminalHeight - bottomFixedHeight - bannerHeight);

  // 计算消息区实际占用的行数（每条消息可能有多行）
  let messageAreaLines = 0;
  if (messages.length === 0) {
    messageAreaLines = 1; // "Welcome to MiCode..." 占一行
  } else {
    const startIdx = Math.max(0, messages.length - maxMessageLines);
    for (let i = startIdx; i < messages.length; i++) {
      // 每条消息按换行符分割，计算行数
      const msgLines = messages[i].split('\n').length;
      messageAreaLines += msgLines;
    }
  }

  // 权限确认提示行
  const promptLines = awaitingPermission ? pendingPermissionPrompt.split('\n').length : 0;
  const totalMessageLines = Math.min(maxMessageLines, messageAreaLines + promptLines);

  const inputRow = 1 + 1 + 3 + 1 + totalMessageLines + 1 + 1;
  // 列：root内容起始(2) + box border左(1) + box paddingX(1) + "❯ "(2) + 光标前文本宽度
  const chars = [...input];
  const beforeWidth = chars.slice(0, cursorPos).reduce((w, c) => w + charWidth(c), 0);
  const inputCol = 2 + 1 + 1 + 2 + beforeWidth;
  // ANSI: \x1b[{row};{col}H (1-based)
  process.stdout.write(`\x1b[${inputRow};${inputCol}H`);
}

// 输入处理：用 Buffer 原始字节手动处理 UTF-8，支持中文等多字节字符
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  // 不设 encoding — 用 Buffer 接收原始字节，手动解码 UTF-8
  let pending = Buffer.alloc(0);
  let historyBusy = false;

  process.stdin.on('data', async (buf: Buffer) => {
    if (historyBusy) return;
    historyBusy = true;
    try {
    // 拼接上次未完成的字节
    const data = Buffer.concat([pending, buf]);
    pending = Buffer.alloc(0);

    for (let i = 0; i < data.length; ) {
      const byte = data[i]!;

      // Ctrl+C (0x03) —— 始终生效，含权限确认中
      if (byte === 0x03) {
        process.stdout.write('\x1b[?25h');
        process.exit(0);
      }

      // ── 权限确认拦截：ask 闸门等待 y/n ──
      if (awaitingPermission) {
        // y / Y (0x79 / 0x59) → 同意
        if (byte === 0x79 || byte === 0x59) {
          awaitingPermission = false;
          const resolve = pendingPermissionResolve;
          pendingPermissionResolve = null;
          pendingPermissionPrompt = '';
          resolve?.(true);
          scheduleRender();
        }
        // n / N / 回车 → 拒绝
        else if (byte === 0x6e || byte === 0x4e || byte === 0x0d || byte === 0x0a) {
          awaitingPermission = false;
          const resolve = pendingPermissionResolve;
          pendingPermissionResolve = null;
          pendingPermissionPrompt = '';
          resolve?.(false);
          scheduleRender();
        }
        // 其余按键忽略（包括退格、普通字符），跳到下一字节
        i++;
        continue;
      }

      // ESC 序列检测 (方向键)
      if (byte === 0x1b && i + 2 < data.length && data[i + 1] === 0x5b) {
        // 上箭头: \x1b[A
        if (data[i + 2] === 0x41) {
          if (!isProcessing) {
            const historyInput = await historyManager.up(input, currentProject);
            if (historyInput !== null) {
              input = historyInput;
              cursorPos = [...input].length;
              scheduleRender();
            }
          }
          i += 3;
          continue;
        }
        // 下箭头: \x1b[B
        if (data[i + 2] === 0x42) {
          if (!isProcessing) {
            const historyInput = await historyManager.down(currentProject);
            if (historyInput !== null) {
              input = historyInput;
              cursorPos = [...input].length;
              scheduleRender();
            }
          }
          i += 3;
          continue;
        }
      }

      // 回车 (CR=0x0D, LF=0x0A)
      if (byte === 0x0d || byte === 0x0a) {
        if (input.trim() === 'exit') {
          process.stdout.write('\x1b[?25h');
          process.exit(0);
        }
        if (input.trim() && !isProcessing) {
          const userInput = input.trim();
          await historyManager.addEntry(userInput, currentProject);
          messages.push('> ' + userInput);
          input = '';
          cursorPos = 0;
          scheduleRender();

          // 检查 ! 前缀拦截（S10 协商协议）
          const blockReq = parseBlockPrefix(userInput);
          if (blockReq) {
            skillNegotiator.block(blockReq.skillName, 'default');
            messages.push(`Skill "${blockReq.skillName}" blocked.`);
            systemMessage = 'Skill blocked';
            systemVisible = true;
            setTimeout(() => { systemVisible = false; scheduleRender(); }, 3000);
            scheduleRender();
          } else {
            // 检查是否是斜杠命令
            const cmd = parseCommand(userInput);
            if (cmd) {
              // 技能相关命令（/skill, /trigger, /y, /n, /edit）走协商器
              if (['skill', 'trigger', 'y', 'n', 'edit'].includes(cmd.name)) {
                const result = executeCommand(cmd, {
                  skillRegistry,
                  negotiator: skillNegotiator,
                  userId: 'default',
                });
                messages.push(result.message);
              } else {
                const result = executeCommand(cmd, configStore, { permissionChecker });
                messages.push(result.message);
              }
              systemMessage = 'Command executed';
              systemVisible = true;
              setTimeout(() => { systemVisible = false; scheduleRender(); }, 3000);
              scheduleRender();
            } else {
              // Nag reminder：如果连续 3 轮没更新 todo，注入提醒
              // 智能 nudge：全部完成后注入验证提示
              todoManager.incrementRounds();
              const reminder = todoManager.getReminder() || todoManager.getVerificationNudge();
              const skillsDescription = skillRegistry.describeAvailable();
              const systemPrompt = [
                'You are a helpful assistant that can execute shell commands and manipulate files.',
                '',
                skillsDescription,
                reminder ? `\n${reminder}` : '',
              ].join('\n');

              // 异步执行 Agent 循环
              isProcessing = true;
              systemMessage = 'Thinking...';
              systemVisible = true;
              scheduleRender();

              const apiKey = configStore.getApiKey(configStore.getDefaultProvider());
              if (apiKey) {
                // 流式渲染路径
                const streamClient = new AnthropicStreamClient({ apiKey, model: MODEL });
                const eventBus = new StreamEventBus();

                // 流式内容缓冲区
                let streamBuffer = '';
                let toolBuffer = '';

                const tools = Array.from(toolRegistry.tools.values()).map(t => t.definition);
                const ac = new AbortController();

                (async () => {
                  try {
                    for await (const msg of streamingQuery(streamClient, toolRegistry, userInput, {
                      systemPrompt,
                      tools,
                      signal: ac.signal,
                      maxTurns: 10,
                      eventBus,
                    })) {
                      // 处理流式消息，将内容添加到messages数组
                      if ('type' in msg && msg.type === 'content_block_delta') {
                        const deltaMsg = msg as { type: 'content_block_delta'; deltaType: string; content: string };
                        if (deltaMsg.deltaType === 'text' && deltaMsg.content) {
                          streamBuffer += deltaMsg.content;
                          // 更新最后一条消息或添加新消息
                          if (messages.length > 0 && messages[messages.length - 1].startsWith('[Streaming]')) {
                            messages[messages.length - 1] = '[Streaming] ' + streamBuffer;
                          } else {
                            messages.push('[Streaming] ' + streamBuffer);
                          }
                          scheduleRender();
                        }
                      } else if ('type' in msg && msg.type === 'assistant') {
                        const assistantMsg = msg as { type: 'assistant'; content: Array<{ type: string; text?: string }> };
                        // 助手消息完成，将缓冲区内容转为正式消息
                        if (streamBuffer) {
                          // 替换最后的流式消息为正式消息
                          if (messages.length > 0 && messages[messages.length - 1].startsWith('[Streaming]')) {
                            messages[messages.length - 1] = streamBuffer;
                          } else {
                            messages.push(streamBuffer);
                          }
                          streamBuffer = '';
                          scheduleRender();
                        }
                        // 处理工具调用结果
                        for (const block of assistantMsg.content) {
                          if (block.type === 'tool_use' && 'name' in block) {
                            const toolBlock = block as { type: 'tool_use'; name: string; input: Record<string, unknown> };
                            toolBuffer += `[Tool: ${toolBlock.name}]\n`;
                          }
                        }
                      }
                    }
                    systemMessage = 'Done';
                  } catch (err) {
                    messages.push(`[Error] ${err}`);
                    systemMessage = 'Error';
                  } finally {
                    isProcessing = false;
                    systemVisible = true;
                    setTimeout(() => { systemVisible = false; scheduleRender(); }, 3000);
                    scheduleRender();
                  }
                })();
              } else {
                messages.push(`[Error] No API Key for ${configStore.getDefaultProvider()}. Use /login <provider> <key> to configure.`);
                systemMessage = 'No API Key';
                systemVisible = true;
                setTimeout(() => { systemVisible = false; scheduleRender(); }, 3000);
                isProcessing = false;
                scheduleRender();
              }
            }
          }
        } else if (!isProcessing) {
          input = '';
          cursorPos = 0;
          scheduleRender();
        }
        historyManager.reset();
        i++;
        continue;
      }

      // 退格 (BS=0x08, DEL=0x7F)
      if (byte === 0x08 || byte === 0x7F) {
        if (cursorPos > 0) {
          const chars = [...input];
          chars.splice(cursorPos - 1, 1);
          input = chars.join('');
          cursorPos--;
        }
        scheduleRender();
        i++;
        continue;
      }

      // 其他控制字符 (< 0x20) → 跳过
      if (byte < 0x20) {
        i++;
        continue;
      }

      // 确定 UTF-8 字符的字节数
      let charLen = 1;
      if ((byte & 0xE0) === 0xC0) charLen = 2;       // 110xxxxx → 2 字节
      else if ((byte & 0xF0) === 0xE0) charLen = 3;   // 1110xxxx → 3 字节 (中文)
      else if ((byte & 0xF8) === 0xF0) charLen = 4;   // 11110xxx → 4 字节 (emoji)

      // 字节不够，存入 pending 等下次 data
      if (i + charLen > data.length) {
        pending = data.subarray(i);
        break;
      }

      // 解码完整 UTF-8 字符并插入到光标位置
      const char = data.subarray(i, i + charLen).toString('utf8');
      const chars = [...input];
      chars.splice(cursorPos, 0, char);
      input = chars.join('');
      cursorPos++;
      i += charLen;
    }

    scheduleRender();
    } catch (err) {
      console.error('[stdin handler error]', err);
    } finally {
      historyBusy = false;
    }
  });
}

// 窗口大小变化
process.stdout.on('resize', () => {
  scheduleRender();
});

// 显示终端光标并渲染
process.stdout.write('\x1b[?25h');

// 触发 SessionStart hook
hookRunner.run({ name: 'SessionStart', payload: {} });

// 启动调度检查器（每 60 秒检查一次）
setInterval(() => {
  scheduler.check();
  const notifications = scheduler.drain();
  for (const n of notifications) {
    messages.push(`[scheduled:${n.scheduleId}] ${n.prompt}`);
  }
  if (notifications.length > 0) scheduleRender();
}, 60000);

scheduleRender();
