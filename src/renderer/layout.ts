// 分区算术：由 (rows, cols) 算三区（消息区 / 状态栏 / 输入框）的 y 偏移与高度
//
// 物理本质：竖着把书桌切两格——上面大格（消息区，占满剩余高度），
// 下面小格（状态栏 + 输入框，钉死底部）。分家靠纯算术（flexbox 思路），
// 不靠 DECSTBM（文档§5.2）。

/** 一个矩形区域：起点行 top + 高度 height */
export interface Region {
  top: number;
  height: number;
}

/** 分区计算入参（高度单位均为"行"） */
export interface LayoutOptions {
  statusBarHeight?: number;
  inputHeight?: number;
}

/** 分区计算结果 */
export interface Layout {
  rows: number;
  cols: number;
  message: Region;
  statusBar: Region;
  input: Region;
  /** 页脚总高度 = 状态栏 + 输入框 */
  footerHeight: number;
  /** 页脚起始行 = 状态栏 top */
  footerTop: number;
}

/**
 * 计算分区。页脚优先（flexShrink=0 思路），消息区吃剩余高度（flexGrow=1）。
 * 不够页脚时，消息区降到 0；绝不返回负数。
 */
export function computeLayout(rows: number, cols: number, options: LayoutOptions = {}): Layout {
  const statusBarHeight = options.statusBarHeight ?? 1;
  const inputHeight = options.inputHeight ?? 1;

  const footerHeight = statusBarHeight + inputHeight;
  const messageHeight = Math.max(0, rows - footerHeight);

  const messageTop = 0;
  const statusBarTop = messageTop + messageHeight;
  const inputTop = statusBarTop + Math.min(statusBarHeight, Math.max(0, rows - messageHeight));

  return {
    rows,
    cols,
    message: { top: messageTop, height: messageHeight },
    statusBar: { top: statusBarTop, height: Math.min(statusBarHeight, Math.max(0, rows - messageHeight)) },
    input: { top: inputTop, height: Math.min(inputHeight, Math.max(0, rows - messageHeight - Math.min(statusBarHeight, Math.max(0, rows - messageHeight)))) },
    footerHeight,
    footerTop: statusBarTop,
  };
}
