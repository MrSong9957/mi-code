import { describe, it, expect } from 'vitest';
import { StylePool } from '../../output/style-pool.js';

describe('StylePool', () => {
  it('should return same reference for equal styles', () => {
    const pool = new StylePool();
    const style1 = pool.get({ fg: 'red', bold: true });
    const style2 = pool.get({ fg: 'red', bold: true });
    expect(style1).toBe(style2); // === 比较
  });

  it('should return different reference for different styles', () => {
    const pool = new StylePool();
    const style1 = pool.get({ fg: 'red' });
    const style2 = pool.get({ fg: 'blue' });
    expect(style1).not.toBe(style2);
  });

  it('should handle empty style', () => {
    const pool = new StylePool();
    const style1 = pool.get({});
    const style2 = pool.get({});
    expect(style1).toBe(style2);
  });

  it('should handle undefined style', () => {
    const pool = new StylePool();
    const style1 = pool.get(undefined);
    const style2 = pool.get(undefined);
    expect(style1).toBe(style2);
  });

  it('should freeze style objects', () => {
    const pool = new StylePool();
    const style = pool.get({ fg: 'red' });
    expect(Object.isFrozen(style)).toBe(true);
  });

  describe('toAnsi', () => {
    it('should generate ANSI for bold red', () => {
      const pool = new StylePool();
      const ansi = pool.toAnsi({ fg: 'red', bold: true });
      expect(ansi).toContain('1');  // bold
      expect(ansi).toContain('31'); // red
    });

    it('should return empty for no style', () => {
      const pool = new StylePool();
      expect(pool.toAnsi({})).toBe('');
    });
  });
});
