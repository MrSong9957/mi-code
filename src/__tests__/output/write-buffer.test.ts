import { describe, it, expect, vi } from 'vitest';
import { WriteBuffer } from '../../renderer/write-buffer.js';

describe('WriteBuffer', () => {
  it('should collect writes and flush as single call', () => {
    const written: string[] = [];
    const buf = new WriteBuffer((s) => written.push(s));

    buf.write('hello');
    buf.write(' ');
    buf.write('world');

    expect(buf.isEmpty).toBe(false);
    buf.flush();

    expect(written).toEqual(['hello world']);
    expect(buf.isEmpty).toBe(true);
  });

  it('should not call writer when empty', () => {
    const written: string[] = [];
    const buf = new WriteBuffer((s) => written.push(s));

    buf.flush();

    expect(written).toEqual([]);
  });

  it('should handle ANSI sequences correctly', () => {
    const written: string[] = [];
    const buf = new WriteBuffer((s) => written.push(s));

    buf.write('\x1b[1m');    // bold
    buf.write('text');
    buf.write('\x1b[0m');    // reset
    buf.flush();

    expect(written).toEqual(['\x1b[1mtext\x1b[0m']);
  });

  it('should report isEmpty correctly', () => {
    const buf = new WriteBuffer(() => {});

    expect(buf.isEmpty).toBe(true);
    buf.write('a');
    expect(buf.isEmpty).toBe(false);
    buf.flush();
    expect(buf.isEmpty).toBe(true);
  });

  it('should clear buffer after flush', () => {
    const written: string[] = [];
    const buf = new WriteBuffer((s) => written.push(s));

    buf.write('first');
    buf.flush();
    buf.write('second');
    buf.flush();

    expect(written).toEqual(['first', 'second']);
  });
});
