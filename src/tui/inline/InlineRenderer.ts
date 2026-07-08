import { cursorUp, eraseLine, eraseLines, hideCursor, showCursor } from './ansi-utils.js';

const PROMPT = '❯ ';

export class InlineRenderer {
  private footerLineCount = 0;

  constructor(private stdout: NodeJS.WriteStream) {}

  appendLine(ansiText: string): void {
    this.stdout.write(ansiText + '\n');
  }

  rewriteCurrentLine(ansiText: string): void {
    this.stdout.write('\r\x1b[K' + ansiText);
  }

  renderFooter(input: string, cursorPos: number, statusText: string): void {
    const seq: string[] = [];

    if (this.footerLineCount > 0) {
      seq.push(eraseLines(this.footerLineCount));
    }

    const inputLines = input.split('\n');
    const border = '─'.repeat(40);

    seq.push(border + '\n');
    for (let i = 0; i < inputLines.length; i++) {
      const prefix = i === 0 ? PROMPT : '';
      seq.push(prefix + inputLines[i] + '\n');
    }
    seq.push(border + '\n');
    seq.push(statusText + '\n');

    this.footerLineCount = 2 + inputLines.length + 1;

    this.stdout.write(seq.join(''));

    const inputLineIndex = inputLines.length - 1;
    const cursorX = (inputLineIndex === 0 ? PROMPT.length : 0) + cursorPos;
    const cursorY = this.footerLineCount - 1 - inputLineIndex;

    this.stdout.write(hideCursor);
    if (cursorY > 0) {
      this.stdout.write(cursorUp(cursorY));
    }
    this.stdout.write(`\r\x1b[${cursorX + 1}G`);
    this.stdout.write(showCursor);
  }

  commitFooter(): void {
    this.footerLineCount = 0;
  }
}
