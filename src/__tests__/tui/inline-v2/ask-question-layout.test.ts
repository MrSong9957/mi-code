import { describe, it, expect } from 'vitest';
import { computeTabLayout } from '../../../tui/inline-v2/ask-question-layout.js';

describe('computeTabLayout', () => {
  const questions = [
    { header: 'Auth', question: 'q1', options: [], multiSelect: false },
    { header: 'Library', question: 'q2', options: [], multiSelect: false },
  ];

  it('宽终端全部显示 + Submit 可见', () => {
    const tabs = computeTabLayout(questions, { pageIndex: 0, answered: [true, false], cols: 80 });
    expect(tabs.every(t => t.truncated === false)).toBe(true);
    expect(tabs.some(t => t.label.includes('Submit'))).toBe(true);
    const totalWidth = tabs.reduce((sum, t) => sum + t.width, 0);
    expect(totalWidth).toBeLessThanOrEqual(80);
  });

  it('窄终端:当前页优先分配,其他截断带 …', () => {
    const qs = [
      { header: 'Auth', question: 'q1', options: [], multiSelect: false },
      { header: 'Library', question: 'q2', options: [], multiSelect: false },
      { header: 'Runtime', question: 'q3', options: [], multiSelect: false },
      { header: 'Deploy', question: 'q4', options: [], multiSelect: false },
    ];
    const tabs = computeTabLayout(qs, { pageIndex: 1, answered: [true, false, false, false], cols: 40 });
    expect(tabs.some(t => t.label.includes('Submit'))).toBe(true);
    const currentTab = tabs[1]!;
    expect(currentTab.active).toBe(true);
    const totalWidth = tabs.reduce((sum, t) => sum + t.width, 0);
    expect(totalWidth).toBeLessThanOrEqual(40);
  });

  it('极窄终端(16列):降级只显示当前页前3字符 + Submit', () => {
    const qs = [
      { header: 'Auth', question: 'q1', options: [], multiSelect: false },
      { header: 'Library', question: 'q2', options: [], multiSelect: false },
    ];
    const tabs = computeTabLayout(qs, { pageIndex: 0, answered: [false, false], cols: 16 });
    expect(tabs[1]!.label).toBe('');
    expect(tabs.some(t => t.label.includes('Submit'))).toBe(true);
    const totalWidth = tabs.reduce((sum, t) => sum + t.width, 0);
    expect(totalWidth).toBeLessThanOrEqual(16);
  });

  it('窄终端(20列,2题):available 不足以容纳各 tab 最小宽度,降级', () => {
    // cols=20,submitWidth=10,availableForTabs=10 < MIN_TAB_WIDTH*2=12 → 走极窄降级。
    // 验证:非当前页清空、当前页前 3 列、Submit 完整、总宽不超。
    const qs = [
      { header: 'Auth', question: 'q1', options: [], multiSelect: false },
      { header: 'Library', question: 'q2', options: [], multiSelect: false },
    ];
    const tabs = computeTabLayout(qs, { pageIndex: 0, answered: [false, false], cols: 20 });
    expect(tabs[1]!.label).toBe('');          // 非当前页降级清空
    expect(tabs[0]!.active).toBe(true);
    const submitTab = tabs[tabs.length - 1]!;
    expect(submitTab.label).toContain('Submit');
    expect(submitTab.truncated).toBe(false);  // Submit 完整(预算够)
    const totalWidth = tabs.reduce((sum, t) => sum + t.width, 0);
    expect(totalWidth).toBeLessThanOrEqual(20);
  });

  it('窄终端(24列,2题):available 足够,走权重分支非降级', () => {
    // cols=24,availableForTabs=14 >= MIN_TAB_WIDTH*2=12 → 走权重分支。
    // 验证:两个 tab 都显示(可能截断)、Submit 完整、总宽不超。
    const qs = [
      { header: 'Auth', question: 'q1', options: [], multiSelect: false },
      { header: 'Library', question: 'q2', options: [], multiSelect: false },
    ];
    const tabs = computeTabLayout(qs, { pageIndex: 0, answered: [false, false], cols: 24 });
    expect(tabs[0]!.label).toContain('Auth');  // 当前页显示
    expect(tabs[1]!.label).not.toBe('');        // 非当前页也显示(非降级)
    const totalWidth = tabs.reduce((sum, t) => sum + t.width, 0);
    expect(totalWidth).toBeLessThanOrEqual(24);
  });

  it('极端窄终端(12列):Submit 也被截断,总宽不超', () => {
    const qs = [
      { header: 'Auth', question: 'q1', options: [], multiSelect: false },
    ];
    const tabs = computeTabLayout(qs, { pageIndex: 0, answered: [false], cols: 12 });
    expect(tabs[0]!.label).toBe('Aut');
    const submitTab = tabs[tabs.length - 1]!;
    expect(submitTab.truncated).toBe(true);
    const totalWidth = tabs.reduce((sum, t) => sum + t.width, 0);
    expect(totalWidth).toBeLessThanOrEqual(12);
  });

  it('CJK header 极窄:按显示宽度截断,不溢出', () => {
    const qs = [
      { header: '认证配置', question: 'q1', options: [], multiSelect: false },
    ];
    const tabs = computeTabLayout(qs, { pageIndex: 0, answered: [false], cols: 14 });
    expect(tabs[0]!.width).toBeLessThanOrEqual(3);
    const totalWidth = tabs.reduce((sum, t) => sum + t.width, 0);
    expect(totalWidth).toBeLessThanOrEqual(14);
  });
});
