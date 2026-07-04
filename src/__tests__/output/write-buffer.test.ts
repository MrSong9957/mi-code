import { describe, it, expect, vi } from 'vitest';
import { WriteBuffer } from '../../renderer/write-buffer.js';
import { bsu, esu } from '../../renderer/ansi.js';

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

  // ── BSU/ESU 同步更新包裹（P2.2）──

  describe('BSU/ESU 同步更新包裹', () => {
    it('useSyncUpdate=true 时 flush 包裹 BSU+ESU', () => {
      const written: string[] = [];
      const buf = new WriteBuffer((s) => written.push(s), { useSyncUpdate: true });

      buf.write('frame-content');
      buf.flush();

      expect(written).toEqual([`${bsu()}frame-content${esu()}`]);
    });

    it('useSyncUpdate=false（默认）时 flush 不包裹（裸写出）', () => {
      const written: string[] = [];
      const buf = new WriteBuffer((s) => written.push(s)); // 不传 useSyncUpdate

      buf.write('frame-content');
      buf.flush();

      expect(written).toEqual(['frame-content']);
    });

    it('flushRaw 始终不走 BSU（用于 enter/exit 等必须立即可见的序列）', () => {
      const written: string[] = [];
      const buf = new WriteBuffer((s) => written.push(s), { useSyncUpdate: true });

      buf.write('enter-seq');
      buf.flushRaw();

      expect(written).toEqual(['enter-seq']);
    });

    it('useSyncUpdate=true 时空 flush 不写出（无 BSU/ESU 垃圾）', () => {
      const written: string[] = [];
      const buf = new WriteBuffer((s) => written.push(s), { useSyncUpdate: true });

      buf.flush();

      expect(written).toEqual([]);
    });

    it('多次 write 合并后单次 BSU/ESU 包裹（不是每段都包）', () => {
      const written: string[] = [];
      const buf = new WriteBuffer((s) => written.push(s), { useSyncUpdate: true });

      buf.write('a');
      buf.write('b');
      buf.write('c');
      buf.flush();

      expect(written).toEqual([`${bsu()}abc${esu()}`]);
      expect(written.length).toBe(1);
    });
  });
});
