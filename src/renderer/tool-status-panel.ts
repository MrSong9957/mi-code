// 工具状态面板：显示工具调用的执行状态
//
// 物理本质：快递追踪面板。
// 你下单了（工具调用开始），面板显示"处理中..."。
// 快递到了（工具执行完成），面板显示"已签收"。
// 如果快递丢了（执行失败），面板显示"异常"。

import { ANSI } from './colors.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL = 80;

export class ToolStatusPanel {
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private startTime = 0;
  private write: (text: string) => void;
  private currentToolName = '';
  private currentInput = '';
  private isTTY: boolean;

  constructor(write?: (text: string) => void) {
    this.write = write ?? ((text: string) => process.stdout.write(text));
    this.isTTY = process.stdout.isTTY ?? false;
  }

  start(toolName: string, input: string): void {
    this.currentToolName = toolName;
    this.currentInput = input;
    this.startTime = Date.now();

    const icon = this.getToolIcon(toolName);
    const inputPreview = this.formatInput(input);
    const width = 56;

    this.write('\n');
    this.write(`${ANSI.cyan}┌─ ${ANSI.bold}Tool: ${toolName}${ANSI.reset}${ANSI.cyan} ${'─'.repeat(width - toolName.length - 8)}┐${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}│${ANSI.reset} ${icon} ${ANSI.gray}${inputPreview}${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}│${ANSI.reset} ${ANSI.yellow}⏳ executing... (0.0s)${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}└${'─'.repeat(width)}┘${ANSI.reset}`);

    if (this.isTTY) {
      this.spinnerFrame = 0;
      this.spinnerTimer = setInterval(() => {
        this.updateSpinner();
      }, SPINNER_INTERVAL);
    }
  }

  complete(output: string, duration: number): void {
    this.stopSpinner();

    const summary = this.formatOutputSummary(output);
    const width = 56;

    if (this.isTTY) {
      // 保存光标位置 → 回退 3 行 → 清除 → 恢复光标
      this.write('\x1b[s');
      this.write('\x1b[3A');
      this.write('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K');
      this.write('\x1b[u');
    }

    this.write(`${ANSI.cyan}┌─ ${ANSI.bold}Tool: ${this.currentToolName}${ANSI.reset}${ANSI.cyan} ${'─'.repeat(width - this.currentToolName.length - 8)}┐${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}│${ANSI.reset} ${this.getToolIcon(this.currentToolName)} ${ANSI.gray}${this.formatInput(this.currentInput)}${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}│${ANSI.reset} ${ANSI.green}✅ done (${this.formatDuration(duration)})${ANSI.reset} — ${ANSI.white}${summary}${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}└${'─'.repeat(width)}┘${ANSI.reset}\n`);
  }

  fail(error: string, duration: number): void {
    this.stopSpinner();

    const width = 56;

    if (this.isTTY) {
      this.write('\x1b[s');
      this.write('\x1b[3A');
      this.write('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K');
      this.write('\x1b[u');
    }

    this.write(`${ANSI.cyan}┌─ ${ANSI.bold}Tool: ${this.currentToolName}${ANSI.reset}${ANSI.cyan} ${'─'.repeat(width - this.currentToolName.length - 8)}┐${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}│${ANSI.reset} ${this.getToolIcon(this.currentToolName)} ${ANSI.gray}${this.formatInput(this.currentInput)}${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}│${ANSI.reset} ${ANSI.red}❌ failed (${this.formatDuration(duration)})${ANSI.reset} — ${ANSI.red}${error}${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}└${'─'.repeat(width)}┘${ANSI.reset}\n`);
  }

  private updateSpinner(): void {
    if (!this.isTTY) return;

    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
    const frame = SPINNER_FRAMES[this.spinnerFrame];
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    this.write('\x1b[s');
    this.write('\x1b[2A');
    this.write('\x1b[2K');
    this.write(`${ANSI.cyan}│${ANSI.reset} ${ANSI.yellow}${frame} executing... (${elapsed}s)${ANSI.reset}\n`);
    this.write(`${ANSI.cyan}└${'─'.repeat(56)}┘${ANSI.reset}`);
    this.write('\x1b[u');
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private getToolIcon(toolName: string): string {
    const icons: Record<string, string> = {
      read_file: '📄',
      write_file: '✏️',
      edit_file: '✏️',
      bash: '💻',
      grep: '🔍',
      glob: '📂',
      web_fetch: '🌐',
      web_search: '🔍',
    };
    return icons[toolName] ?? '🔧';
  }

  private formatInput(input: string): string {
    if (!input) return '...';
    const preview = input.length > 40 ? input.substring(0, 40) + '...' : input;
    return preview;
  }

  private formatOutputSummary(output: string): string {
    const lines = output.split('\n').length;
    const bytes = Buffer.byteLength(output, 'utf8');

    if (bytes < 1024) {
      return `${lines} lines, ${bytes}B`;
    }
    return `${lines} lines, ${(bytes / 1024).toFixed(1)}KB`;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
}
