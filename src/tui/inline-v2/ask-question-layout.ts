// AskQuestion 问卷导航栏(tabs)宽度分配纯函数。
// 物理本质:把有限的终端宽度按权重分给各个 question header + Submit,
// 当前页优先(weight=2),其他页次之(weight=1),Submit 固定预留。

import { displayWidth } from '../inline/text-layout.js';
import type { AskQuestion } from '../../agent/ask-user-types.js';

export interface TabSlice {
  /** 显示文本(可能已截断并带 …) */
  label: string;
  /** 是否为当前页 */
  active: boolean;
  /** 显示宽度(列) */
  width: number;
  /** 是否被截断 */
  truncated: boolean;
}

export interface ComputeTabLayoutOptions {
  pageIndex: number;
  /** 每个 question 是否已答(与 questions 等长) */
  answered: boolean[];
  cols: number;
  submitText: string;
}

const MIN_TAB_WIDTH = 6;

/**
 * 按显示宽度截断文本(CJK 感知)。
 * 超过 budget 时按字符(含 CJK 全角 2 列)累加,保证结果 displayWidth <= budget。
 * JavaScript 的 String.slice 按码点数量,与终端列数不一致(CJK 全角=2列),
 * 极窄模式下用 slice(0,3) 会让中文 header 溢出。统一用此函数。
 */
function truncateByDisplayWidth(text: string, budget: number): { text: string; truncated: boolean } {
  if (displayWidth(text) <= budget) return { text, truncated: false };
  let result = '';
  let width = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (width + cw > budget) break;
    result += ch;
    width += cw;
  }
  return { text: result, truncated: true };
}

/**
 * 计算 tabs 布局。Submit 永远可见;当前页 weight=2,其他 weight=1。
 */
export function computeTabLayout(
  questions: AskQuestion[],
  opts: ComputeTabLayoutOptions,
): TabSlice[] {
  const { pageIndex, answered, cols } = opts;
  const submitText = ` ✓ ${opts.submitText} `;
  const submitWidth = displayWidth(submitText);

  // 极窄降级阈值:当可用宽度装不下"每个 tab 至少 MIN_TAB_WIDTH"时,降级。
  // 原阈值 cols <= submitWidth + MIN_TAB_WIDTH 只考虑单个 tab,但多 tab 场景下
  // 各 tab 的 MIN_TAB_WIDTH 下限之和会超过 available,导致总宽溢出。
  // 正确判断:available < MIN_TAB_WIDTH * questions.length 时降级。
  const availableForTabs = cols - submitWidth;
  const needsNarrowFallback = availableForTabs < MIN_TAB_WIDTH * questions.length
    || cols <= submitWidth + MIN_TAB_WIDTH;

  // 极窄降级:只显示当前页前 3 显示列 + Submit(Submit 也可能被截断)
  // 关键:所有截断必须用 truncateByDisplayWidth(CJK 感知),不能用 slice(0,3)。
  //   slice 按码点数量,中文 header(如"认证配置")slice(0,3)="认证配"占 6 列,会溢出。
  if (needsNarrowFallback) {
    const tabs: TabSlice[] = questions.map((q, i) => {
      const header = q.header || `Q${i + 1}`;  // 使用 index 保证 Q1/Q2/Q3 唯一
      if (i !== pageIndex) return { label: '', active: false, width: 0, truncated: false };
      const { text, truncated } = truncateByDisplayWidth(header, 3);  // 前 3 显示列
      return { label: text, active: true, width: displayWidth(text), truncated };
    });
    // Submit 截断:当前页占完后,剩余预算给 Submit;放不下则截断,极端情况只留 ✓
    const currentPageWidth = tabs[pageIndex]?.width ?? 0;
    const submitBudget = Math.max(1, cols - currentPageWidth);  // 至少留 1 列
    const { text: submitLabel, truncated: submitTrunc } = truncateByDisplayWidth(submitText, submitBudget);
    const finalLabel = submitLabel || '✓';  // 极端兜底:至少 ✓
    tabs.push({ label: finalLabel, active: false, width: displayWidth(finalLabel), truncated: submitTrunc || finalLabel === '✓' });
    return tabs;
  }

  const available = cols - submitWidth;
  // 计算每个 tab 理想宽度:符号(✓/○ 2字符)+ header + 间距(2)
  const ideals = questions.map(q => 2 + displayWidth(q.header || 'Q') + 2);
  const idealTotal = ideals.reduce((s, w) => s + w, 0);

  // 全部装得下
  if (idealTotal <= available) {
    const tabs: TabSlice[] = questions.map((q, i) => ({
      label: `${answered[i] ? '✓' : '○'} ${q.header}`,
      active: i === pageIndex,
      width: ideals[i]!,
      truncated: false,
    }));
    tabs.push({ label: submitText, active: false, width: submitWidth, truncated: false });
    return tabs;
  }

  // 需要按权重分配:当前页 weight=2,其他 weight=1
  const weights = questions.map((_, i) => i === pageIndex ? 2 : 1);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const tabs: TabSlice[] = questions.map((q, i) => {
    const budget = Math.max(MIN_TAB_WIDTH, Math.floor((available * weights[i]!) / totalWeight));
    const fullLabel = `${answered[i] ? '✓' : '○'} ${q.header}`;
    const fullWidth = displayWidth(fullLabel);
    if (fullWidth <= budget) {
      return { label: fullLabel, active: i === pageIndex, width: fullWidth, truncated: false };
    }
    // 截断:保留符号 + 部分 header + …(用 truncateByDisplayWidth 保证 CJK 安全)
    const prefix = `${answered[i] ? '✓' : '○'} `;
    const prefixWidth = displayWidth(prefix);
    const headerBudget = Math.max(1, budget - prefixWidth - 1); // -1 给 …
    const { text: header } = truncateByDisplayWidth(q.header, headerBudget);
    const label = `${prefix}${header}…`;
    return { label, active: i === pageIndex, width: displayWidth(label), truncated: true };
  });
  tabs.push({ label: submitText, active: false, width: submitWidth, truncated: false });
  return tabs;
}
