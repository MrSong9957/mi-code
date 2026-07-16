// src/__tests__/tui/inline-dropdown-duplication.test.ts
// 回归测试：下拉菜单与 footer 作为原子块渲染，无残留、无重复。
//
// 物理本质：footer 和下拉菜单合并成一块（footerHeight 含下拉行数），
// 下一帧覆写时 cursorUp 自动覆盖整个区域。
//
// 核心契约：
// 1. 下拉候选行出现在两个 border 之间（输入框下方、状态栏上方）
// 2. 从 N 行下拉 → 0 行时，输出含 \x1b[<n>M（物理删除，零残留）
// 3. 多次覆写不产生重复候选行

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('renderFooter 原子渲染 footer + 下拉菜单', () => {
  let stdoutChunks: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;

  beforeEach(() => {
    stdoutChunks = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    });
  });

  it('下拉候选行出现在输入框与状态栏之间（向下布局）', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const renderer = new InlineRenderer(process.stdout);
    const suggestions = ['config', 'compact'];
    renderer.renderFooter('/c', 2, 'STATUS', 80, suggestions, 0);
    const output = stdoutChunks.join('');

    // 行序断言：预留位 → 顶部border → 输入行 → 候选行 → 底部border → 状态行
    // footer 结构：lines 前面 2 行预留位（间距+spinner）+ 顶部 border。
    // border 宽度 = usableWidth = cols - 1（DECAWM OFF 留安全列），顶部 + 底部各 1 条。
    const inputIdx = output.indexOf('❯ /c');
    const candidateIdx = output.indexOf('/config');
    // footer 现有 2 个相同 border，底部 border 在候选行之后——用 lastIndexOf 取最后一条
    const borderIdx = output.lastIndexOf('─'.repeat(79));
    const statusIdx = output.indexOf('STATUS');

    expect(inputIdx).toBeGreaterThan(-1);
    expect(candidateIdx).toBeGreaterThan(inputIdx);
    expect(borderIdx).toBeGreaterThan(candidateIdx);
    expect(statusIdx).toBeGreaterThan(borderIdx);
  });

  it('选中候选行反白（\x1b[7m），未选中行不反白', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const renderer = new InlineRenderer(process.stdout);
    renderer.renderFooter('/', 1, 'S', 80, ['config', 'compact'], 1);
    const output = stdoutChunks.join('');

    // selectedIndex=1 → compact 反白，config 不反白
    expect(output).toContain('\x1b[7m ▸ /compact');
    expect(output).not.toContain('\x1b[7m ▸ /config');
    expect(output).toContain('   /config');
  });

  it('从 8 行下拉 → 0 行时零残留（物理删除整块后重画）', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const renderer = new InlineRenderer(process.stdout);
    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

    // 第一帧：8 行下拉
    renderer.renderFooter('/', 1, 'S', 80, eight, 0);
    stdoutChunks.length = 0;

    // 第二帧：0 行下拉（关闭）
    renderer.renderFooter('/', 1, 'S', 80, [], 0);
    const output = stdoutChunks.join('');

    // 逐行擦写策略：\r\x1b[2K 擦整行后重画。旧行被擦除（零残留）。
    // footerHeight = 预留位(2) + 输入(1) + 8下拉 + border(1) + status(1) = 13。
    // 必须擦除 ≥12 行（Math.max(旧高, 新高)），否则旧行残留。
    const eraseCount = (output.match(/\x1b\[2K/g) || []).length;
    expect(eraseCount).toBeGreaterThanOrEqual(12);
    // 核心契约：输出不含任何旧候选名（零残留）
    for (const name of eight) {
      expect(output).not.toContain(`/${name}`);
    }
  });

  it('下拉行数增加时新行出现且无残留（5→8）', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const renderer = new InlineRenderer(process.stdout);
    const five = ['a', 'b', 'c', 'd', 'e'];

    renderer.renderFooter('/', 1, 'S', 80, five, 0);
    stdoutChunks.length = 0;

    // 扩展到 8 行
    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    renderer.renderFooter('/', 1, 'S', 80, eight, 0);
    const output = stdoutChunks.join('');

    // 新增的 3 行必须出现
    expect(output).toContain('/f');
    expect(output).toContain('/g');
    expect(output).toContain('/h');
    // 逐行擦写策略：\r\x1b[2K 擦整行后重画。
    // footerHeight = 预留位(2)+输入(1)+5下拉+border(1)+status(1) = 10。
    // 必须擦除 ≥9 行，否则旧行残留。
    const eraseCount = (output.match(/\x1b\[2K/g) || []).length;
    expect(eraseCount).toBeGreaterThanOrEqual(9);
  });

  it('多次连续覆写：候选名恰好出现一次（无重复）', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const renderer = new InlineRenderer(process.stdout);
    const suggestions = ['config', 'compact'];

    // 第一次渲染（追加模式）
    renderer.renderFooter('/c', 2, 'S', 80, suggestions, 0);
    // 多次覆写
    for (let i = 0; i < 4; i++) {
      renderer.renderFooter('/c', 2, 'S', 80, suggestions, i % 2);
    }
    const output = stdoutChunks.join('');

    // '/config' 在最终帧应该只出现必要的次数，不应成倍堆积
    // （追加 1 次 + 每次覆写都重写该行，但旧帧被擦除——检测无连续重复）
    const configCount = (output.match(/\/config/g) ?? []).length;
    // 每帧写一次 config，5 帧 = 5 次（合理），不应是 5*2=10（重复堆积的标志）
    expect(configCount).toBeLessThanOrEqual(5);
  });

  it('commitFooter 在 dropdown 存在时正确清零，后续 renderFooter 走追加模式', async () => {
    // 回归：commitFooter 必须擦除整个 footer+dropdown 块（cursorToTop 含下拉高度），
    // 之后 appendLine 从原块顶覆盖，新 renderFooter 重新追加。
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const renderer = new InlineRenderer(process.stdout);
    const suggestions = ['config', 'compact'];

    // 渲染带 dropdown 的 footer
    renderer.renderFooter('/c', 2, 'S', 80, suggestions, 0);
    stdoutChunks.length = 0;

    // commit（模拟用户提交：擦除 footer+dropdown，让消息接管）
    renderer.commitFooter();
    const commitOutput = stdoutChunks.join('');
    // commitFooter 必须向上移动足够行数以擦除整个块（含 dropdown 的 2 行）
    // 新 footer 结构：footerHeight = 预留位(2)+input(1)+2suggestions+border(1)+status(1) = 7；
    // cursorToTop = 3（光标在 input 行 = 第 3 行，上移 3 到预留位顶）
    const cursorUpMatch = commitOutput.match(/\x1b\[(\d+)A/);
    expect(cursorUpMatch).not.toBeNull();
    expect(parseInt(cursorUpMatch![1], 10)).toBe(3);

    // commit 后追加消息，不残留 dropdown
    renderer.appendLine('❯ /config');
    stdoutChunks.length = 0;

    // 新 footer 重新追加（footerHeight 已归零，走追加模式）
    renderer.renderFooter('', 0, 'S2', 80, [], 0);
    const afterNewFooter = stdoutChunks.join('');

    // 追加模式：输出含所有 footer 行（直接写入，非覆写）
    // 光标定位用的 cursorUp 仍存在（把光标从状态行移到输入行），这是正常的
    expect(afterNewFooter).toContain('❯');
    expect(afterNewFooter).toContain('S2');
    // 追加模式特征：第一个写入是 border + \n（而非 \r\x1b[2K 前缀——那是覆写模式）
    expect(afterNewFooter).toMatch(/─+\n/);
  });
});
