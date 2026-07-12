// src/tui/input/paste-handler.ts
// 粘贴内容占位符管理器
//
// 物理本质：剪贴板的「临时仓库」。
// 粘贴时把原文存进内存字典，输入框只显示占位符快捷方式，
// 提交时再把占位符展开回原文。省磁盘、省 token、省眼。
//
// TODO: 图片占位符 [Image #N] 走单独 content block（需图片捕获+ImageBlock 类型，
// 当前零基础设施，标记为未来工作）。

const TRUNCATE_THRESHOLD = 10000;
const PREVIEW_CHARS = 500;

let nextPasteId = 1;
const pastedContents = new Map<number, string>();

/** 存储粘贴内容，返回占位符 */
export function storePastedContent(content: string): string {
  const id = nextPasteId++;
  pastedContents.set(id, content);
  const lineCount = content.split('\n').length;
  if (content.length > TRUNCATE_THRESHOLD) {
    // 超长截断：前后各保留 500 字符预览，中间用 Truncated 标记
    const front = content.slice(0, PREVIEW_CHARS);
    const back = content.slice(-PREVIEW_CHARS);
    return `[${front}...Truncated text #${id} +${lineCount} lines...${back}]`;
  }
  return `[Pasted text #${id} +${lineCount} lines]`;
}

/**
 * 将文本中的占位符展开为原始内容。
 *
 * 两种占位符格式：
 * - 普通：[Pasted text #N +M lines]
 * - 截断：[<前500字符>...Truncated text #N +M lines...<后500字符>]
 *   截断格式的前后预览是任意字符（.*?），正则用 [\s\S] 匹配（含换行）。
 */
export function expandPastedTextRefs(text: string): string {
  return text.replace(/\[Pasted text #(\d+) \+(\d+) lines\]/g, (_match, idStr) => {
    const id = Number(idStr);
    const content = pastedContents.get(id);
    return content ?? _match;
  }).replace(/\[[\s\S]*?\.\.\.Truncated text #(\d+) \+(\d+) lines\.\.\.[\s\S]*?\]/g, (_match, idStr) => {
    const id = Number(idStr);
    const content = pastedContents.get(id);
    return content ?? _match;
  });
}

/** 重置所有粘贴状态（新 session 或测试用） */
export function resetPasteState(): void {
  nextPasteId = 1;
  pastedContents.clear();
}
