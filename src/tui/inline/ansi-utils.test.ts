import { describe, it, expect } from 'vitest';
import { cursorUp, cursorDown, eraseLine, eraseLines, hideCursor, showCursor, sgr } from './ansi-utils.js';

describe('ansi-utils', () => {
  it('cursorUp generates correct escape', () => {
    expect(cursorUp(3)).toBe('\x1b[3A');
    expect(cursorUp(1)).toBe('\x1b[1A');
  });

  it('cursorDown generates correct escape', () => {
    expect(cursorDown(2)).toBe('\x1b[2B');
  });

  it('eraseLine is correct escape', () => {
    expect(eraseLine).toBe('\x1b[K');
  });

  it('eraseLines generates N line erasures', () => {
    const result = eraseLines(3);
    expect(result).toBe('\x1b[1A\x1b[K\x1b[1A\x1b[K\x1b[1A\x1b[K');
  });

  it('hideCursor/showCursor are correct', () => {
    expect(hideCursor).toBe('\x1b[?25l');
    expect(showCursor).toBe('\x1b[?25h');
  });

  it('sgr wraps code in CSI m', () => {
    expect(sgr('1')).toBe('\x1b[1m');
    expect(sgr('38;2;255;0;0')).toBe('\x1b[38;2;255;0;0m');
  });
});
