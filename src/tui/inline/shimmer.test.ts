// shimmer 纯函数测试（动画三：shimmer 光效）
//
// 对标 Claude Code SpinnerAnimationRow.tsx:136-138 + GlimmerMessage.tsx 的
// computeGlimmerIndex + computeShimmerSegments。
//
// shimmer：高亮段（3 显示列）在文字上从右→左扫过，扫出文字外有 10 列缓冲
// 后从另一侧重新进入。cycleLength = width + 20（双侧各 10 缓冲）。
//
// 关键：按"显示宽度"切分（CJK 算 2 列），不按字符索引，避免切到全角字符中间。

import { describe, it, expect } from 'vitest';
import { computeGlimmerIndex, computeShimmerSegments } from './shimmer.js';

describe('computeGlimmerIndex：高亮段起始列（右→左扫描）', () => {
  const width = 10;  // 假设 message 显示宽度 10 列
  const opts = { speed: 200, cyclePad: 10, stalled: false };

  it('初始（time=0）：高亮段在文字右侧 10 列外（width + cyclePad）', () => {
    // glimmerIndex = 10 + 10 - floor(0/200) % 30 = 20
    expect(computeGlimmerIndex(0, width, opts)).toBe(20);
  });

  it('随 time 增加，glimmerIndex 递减（右→左移动）', () => {
    const i0 = computeGlimmerIndex(0, width, opts);     // 20
    const i1 = computeGlimmerIndex(200, width, opts);   // 19
    const i2 = computeGlimmerIndex(400, width, opts);   // 18
    expect(i0).toBe(20);
    expect(i1).toBe(19);
    expect(i2).toBe(18);
    // 递减趋势
    expect(i1).toBeLessThan(i0);
    expect(i2).toBeLessThan(i1);
  });

  it('循环：超过 cycleLength 后回到起点（不停在末尾）', () => {
    // cycleLength = 10 + 20 = 30；floor(time/200)%30
    // time = 200*30 = 6000 → pos%30 = 0 → glimmerIndex = 20（同 time=0）
    expect(computeGlimmerIndex(6000, width, opts)).toBe(20);
    // time = 200*31 → pos%30 = 1 → 19
    expect(computeGlimmerIndex(6200, width, opts)).toBe(19);
  });

  it('stalled 时返回 -100（高亮段停用，全部走 before）', () => {
    expect(computeGlimmerIndex(0, width, { ...opts, stalled: true })).toBe(-100);
    expect(computeGlimmerIndex(1000, width, { ...opts, stalled: true })).toBe(-100);
  });

  it('高亮段会扫出文字左侧（glimmerIndex 变负）', () => {
    // 扫到最左：pos 接近 cycleLength 时 glimmerIndex 接近 width+10-cycleLength = 0
    // pos=20 → glimmerIndex = 10+10-20 = 0；pos=29 → 10+10-29 = -9
    expect(computeGlimmerIndex(200 * 29, width, opts)).toBe(-9);
  });
});

describe('computeShimmerSegments：按显示宽度切三段', () => {
  it('纯 ASCII：高亮段在中间时切成 before/shimmer/after', () => {
    // message = "Generating"，宽度 10
    // 列映射：G0 e1 n2 e3 r4 a5 t6 i7 n8 g9
    // glimmerIndex = 5 → 高亮列 [4,5,6] = r,a,t
    const { before, shimmer, after } = computeShimmerSegments('Generating', 5);
    expect(before).toBe('Gene');      // 列 0-3
    expect(shimmer).toBe('rat');      // 列 4-6（glimmerIndex 中心 5，左右各 1）
    expect(after).toBe('ing');        // 列 7-9
  });

  it('高亮段在文字最左侧（glimmerIndex=0）：before 空，shimmer 取与高亮列有交集的字符', () => {
    // glimmerIndex=0 → 高亮列 {-1,0,1}，-1 在文字外
    // 'G'(列0)✓ 'e'(列1)✓ 'n'(列2)✗ → shimmer='Ge'
    const { before, shimmer, after } = computeShimmerSegments('Generating', 0);
    expect(before).toBe('');
    expect(shimmer).toBe('Ge');       // 仅列 0,1 有交集（列 -1 在文字外）
    expect(after).toBe('nerating');
  });

  it('高亮段完全在文字右侧（glimmerIndex-1 >= width）：全 before，无 shimmer', () => {
    // width=10, glimmerIndex=15 → 高亮列 [14,15,16] 全 >= 10
    const { before, shimmer, after } = computeShimmerSegments('Generating', 15);
    expect(before).toBe('Generating');
    expect(shimmer).toBe('');
    expect(after).toBe('');
  });

  it('高亮段完全在文字左侧（glimmerIndex+1 < 0）：全 before', () => {
    // glimmerIndex=-5 → 高亮列 [-6,-5,-4] 全 < 0
    const { before, shimmer, after } = computeShimmerSegments('Generating', -5);
    expect(before).toBe('Generating');
    expect(shimmer).toBe('');
    expect(after).toBe('');
  });

  it('stalled（glimmerIndex=-100）：全 before', () => {
    const { before, shimmer, after } = computeShimmerSegments('Generating', -100);
    expect(before).toBe('Generating');
    expect(shimmer).toBe('');
    expect(after).toBe('');
  });

  it('CJK 安全：全角字符按 2 列计算，不切到字符中间', () => {
    // message = "生成中" = 3 个全角字符 = 6 列
    // glimmerIndex = 3 → 高亮列 [2,3,4]
    //   列 0-1 = '生'(2列)，列 2-3 = '成'(2列)，列 4-5 = '中'(2列)
    //   高亮列 2,3,4 → '成'(列2-3) + '中'左半(列4) → 但不能切半字
    //   实际：列2 属于 '成'，列3 属于 '成'，列4 属于 '中'
    //   高亮段覆盖列2-4 → '成'完全高亮 + '中'完全高亮（列4-5）
    //   所以 shimmer = '成中'（列2,3,4,5 都在高亮影响范围）
    const { before, shimmer, after } = computeShimmerSegments('生成中', 3);
    expect(before).toBe('生');
    expect(shimmer).toBe('成中');
    expect(after).toBe('');
  });

  it('高亮段正好覆盖单个全角字符（不拆分）', () => {
    // message = "生成中"，glimmerIndex = 1 → 高亮列 [0,1,2]
    //   列0-1 = '生'(完全高亮)，列2 = '成'左半 → 不拆，'成'整体算
    //   高亮列 0,1,2：'生'(0-1)高亮，'成'的列2 被触及 → '成'整体进 shimmer
    const { before, shimmer, after } = computeShimmerSegments('生成中', 1);
    expect(before).toBe('');
    expect(shimmer).toBe('生成');
    expect(after).toBe('中');
  });

  it('空 message：全 before（空串）', () => {
    const { before, shimmer, after } = computeShimmerSegments('', 5);
    expect(before).toBe('');
    expect(shimmer).toBe('');
    expect(after).toBe('');
  });

  it('三段拼接等于原 message（内容不丢不重）', () => {
    const msg = 'CraftingCode';
    for (const gi of [0, 3, 5, 8, 12, -2, 20, -100]) {
      const { before, shimmer, after } = computeShimmerSegments(msg, gi);
      expect(before + shimmer + after).toBe(msg);
    }
  });
});
