// src/__tests__/tui/input-physical-rows.test.ts
// 物理行模型测试。随 Step 2 起逐步累积。
//
// Step 2:prompt/continuation 常量导出。
// 契约:宽度由 stringWidth(字符串) 计算,不硬编码——若 prompt 改样式,宽度自动跟随。

import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import {
  PROMPT,
  CONTINUATION_INDENT,
  PROMPT_WIDTH,
  CONTINUATION_INDENT_WIDTH,
} from '../../tui/state/input-viewport.js';

describe('prompt/continuation 常量与宽度(从字符串计算,非硬编码)', () => {
  it('PROMPT / CONTINUATION_INDENT 字符串值', () => {
    expect(PROMPT).toBe('❯ ');
    expect(CONTINUATION_INDENT).toBe('  ');
  });

  it('PROMPT_WIDTH = stringWidth(PROMPT),非硬编码', () => {
    expect(PROMPT_WIDTH).toBe(stringWidth(PROMPT));
    expect(PROMPT_WIDTH).toBeGreaterThan(0);
  });

  it('CONTINUATION_INDENT_WIDTH = stringWidth(CONTINUATION_INDENT),非硬编码', () => {
    expect(CONTINUATION_INDENT_WIDTH).toBe(stringWidth(CONTINUATION_INDENT));
    expect(CONTINUATION_INDENT_WIDTH).toBeGreaterThan(0);
  });
});

// Step 4:物理行模型 computeInputViewportLayout(前缀/宽度/breakKind/源区间)。
// 接口分阶段:本步产出 InputPhysicalRow(含 cursorColMap),但**不**产出 cursorVisibleRow/Col(Step 6)。
// _cursor 入参暂不读取(Step 6 启用)。
import {
  computeInputViewportLayout,
} from '../../tui/state/input-viewport.js';

const L = (input: string, cursor: number, cols = 80) =>
  computeInputViewportLayout(input, cursor, cols, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);

describe('computeInputViewportLayout 物理行模型 (Step 4)', () => {
  it('AAA\\n888:2 物理行,[prompt,continuation],[none,hard],源区间连续', () => {
    const l = L('AAA\n888', 7);
    expect(l.physicalRowCount).toBe(2);
    expect(l.visibleRows.map(r => r.prefixKind)).toEqual(['prompt', 'continuation']);
    expect(l.visibleRows.map(r => r.breakKind)).toEqual(['none', 'hard']);
    expect(l.visibleRows[0]).toMatchObject({ sourceStart: 0, sourceEnd: 3, text: 'AAA', logicalLineIndex: 0 });
    expect(l.visibleRows[1]).toMatchObject({ sourceStart: 4, sourceEnd: 7, text: '888', logicalLineIndex: 1 });
  });

  it('软折行:首物理行扣 PROMPT_WIDTH,续物理行扣 CONTINUATION_INDENT_WIDTH', () => {
    const firstBudget = (80 - 1) - PROMPT_WIDTH;   // 77
    const l = L('a'.repeat(firstBudget + 1), firstBudget + 1, 80);
    expect(l.physicalRowCount).toBe(2);
    expect(l.visibleRows[0]!.breakKind).toBe('none');
    expect(l.visibleRows[1]!.breakKind).toBe('soft');
    expect(l.visibleRows[1]!.prefixKind).toBe('continuation');
  });
});

// Step 5:物理行边界 edge-case coverage。
// 性质:可能直接 GREEN(Step 4 split + wrapLineWithSpans 天然处理空逻辑行)。仅在失败时补实现。
describe('computeInputViewportLayout 物理行边界 (Step 5)', () => {
  it('空输入:1 物理行,prompt,none,源区间 [0,0)', () => {
    const l = L('', 0);
    expect(l.physicalRowCount).toBe(1);
    expect(l.visibleRows[0]).toMatchObject({ prefixKind: 'prompt', breakKind: 'none', sourceStart: 0, sourceEnd: 0, text: '' });
  });

  it('AAA\\n:2 物理行,第二行是空逻辑行(hard),源区间 [4,4)', () => {
    const l = L('AAA\n', 4);
    expect(l.physicalRowCount).toBe(2);
    expect(l.visibleRows[1]).toMatchObject({ breakKind: 'hard', text: '', sourceStart: 4, sourceEnd: 4, logicalLineIndex: 1 });
  });

  it('AAA\\n\\n888:3 物理行,中间空逻辑行(hard)', () => {
    const l = L('AAA\n\n888', 8);
    expect(l.physicalRowCount).toBe(3);
    expect(l.visibleRows.map(r => r.logicalLineIndex)).toEqual([0, 1, 2]);
    expect(l.visibleRows[1]).toMatchObject({ text: '', breakKind: 'hard' });
  });

  it('\\n:2 物理行,首行空(prompt,none),次行空(hard)', () => {
    const l = L('\n', 1);
    expect(l.physicalRowCount).toBe(2);
    expect(l.visibleRows[0]).toMatchObject({ prefixKind: 'prompt', breakKind: 'none', text: '' });
    expect(l.visibleRows[1]).toMatchObject({ prefixKind: 'continuation', breakKind: 'hard', text: '' });
  });

  it('单词边界空格:sourceStart/sourceEnd 归属前一行尾部(不进下一行)', () => {
    // 'hello world' 软折行:空格属前一行。cols=10: usableWidth=9, 首行 budget=9-PROMPT_WIDTH(2)=7
    // → 'hello'(5列)+' '(触发,空格丢弃)→ 'world' 下一行
    const l = L('hello world', 11, 10);
    const helloRow = l.visibleRows.find(r => r.text === 'hello')!;
    const worldRow = l.visibleRows.find(r => r.text === 'world')!;
    expect(helloRow.sourceEnd).toBe(worldRow.sourceStart); // 连续,空格在 helloRow 区间内
  });
});

// Step 6:cursor 定位(cursorVisibleRow/Col + 三条边界契约 + 匹配优先级)。
// 三条契约:
//  1. 软折行边界归下一物理行行首;
//  2. 硬换行字符位置归前一行末;
//  3. \n 后 cursor 归下一逻辑行行首。
// 优先级:开区间内(1) > 行首 sourceStart(2,从前往后) > 行末 sourceEnd(3,从后往前归前一行) > 末行兜底(4)。
describe('computeInputViewportLayout cursor 定位 (Step 6)', () => {
  // === 契约1:软折行边界归下一物理行行首 ===
  it('软折行边界:cursor 在折行点归下一物理行行首(cursorVisibleCol=前缀宽+0)', () => {
    const firstBudget = (80 - 1) - PROMPT_WIDTH; // 77
    const text = 'a'.repeat(firstBudget + 1);     // 折成 [0,77)+[77,78)
    const l = L(text, firstBudget, 80);           // cursor=77 在折行点
    expect(l.cursorVisibleRow).toBe(1);           // 归下一物理行(行1)
    expect(l.cursorVisibleCol).toBe(CONTINUATION_INDENT_WIDTH + 0); // 行首,内容列=0
  });

  // === 契约2:硬换行字符位置归前一行末 ===
  it('硬换行:cursor 指向 \\n(cursor=3 in "AAA\\n888")归前一行末(cursorVisibleRow=0)', () => {
    const l = L('AAA\n888', 3);
    expect(l.cursorVisibleRow).toBe(0);
    expect(l.cursorVisibleCol).toBe(PROMPT_WIDTH + 3); // 'AAA' 末,内容列=3
  });
  it('硬换行:cursor 在源区间内("AAA\\n888" cursor=5)→ cursorVisibleRow=1', () => {
    expect(L('AAA\n888', 5).cursorVisibleRow).toBe(1);
  });

  // === 契约3:\n 后的 cursor 归下一逻辑行行首 ===
  it('\\n 后 cursor:AAA\\n888 cursor=4(下一逻辑行行首)→ cursorVisibleRow=1,内容列=0', () => {
    const l = L('AAA\n888', 4);
    expect(l.cursorVisibleRow).toBe(1);
    expect(l.cursorVisibleCol).toBe(CONTINUATION_INDENT_WIDTH + 0);
  });

  // === 零长度空行 / 连续空行 / 尾随空行(优先级2 行首命中)===
  it('零长度空行:AAA\\n\\n888 cursor=4 → cursorVisibleRow=1', () => {
    const l = L('AAA\n\n888', 4);
    expect(l.cursorVisibleRow).toBe(1);
    expect(l.cursorVisibleCol).toBe(CONTINUATION_INDENT_WIDTH);
  });
  it('连续空行:\\n\\n cursor=1 → cursorVisibleRow=1(第二行行首)', () => {
    expect(L('\n\n', 1).cursorVisibleRow).toBe(1);
  });
  it('连续空行:\\n\\n cursor=2 → cursorVisibleRow=2(第三行行首)', () => {
    expect(L('\n\n', 2).cursorVisibleRow).toBe(2);
  });
  it('尾随空行:AAA\\n cursor=4 → cursorVisibleRow=1', () => {
    expect(L('AAA\n', 4).cursorVisibleRow).toBe(1);
  });
  it('输入末尾:AAA cursor=3 → cursorVisibleRow=0(优先级3 末行)', () => {
    const l = L('AAA', 3);
    expect(l.cursorVisibleRow).toBe(0);
    expect(l.cursorVisibleCol).toBe(PROMPT_WIDTH + 3);
  });

  // === CJK 列定位(查 cursorColMap)===
  it('CJK cursorVisibleCol:cursorColMap 查询(中=2),不落字符中间', () => {
    const l = L('你好世界', 2, 80); // cursor=2 在 '你好' 后
    expect(l.cursorVisibleCol).toBe(PROMPT_WIDTH + 4);
  });
});
