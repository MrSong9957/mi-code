// 路径沙箱：防止路径逃逸工作区
import { resolve, isAbsolute } from 'path';

// 工作目录（默认为 process.cwd()）
let workdir = process.cwd();

/** 设置工作目录 */
export function setWorkdir(dir: string): void {
  workdir = resolve(dir);
}

/** 获取当前工作目录 */
export function getWorkdir(): string {
  return workdir;
}

/**
 * 路径沙箱：确保路径在工作目录内
 *
 * 物理本质：给路径加围栏，防止跑到外面去。
 * 就像快递员只能在小区内送件，不能跑出小区大门。
 */
export function safePath(p: string): string {
  // 如果是绝对路径，直接解析；否则相对于工作目录
  const resolved = isAbsolute(p) ? resolve(p) : resolve(workdir, p);

  // 检查是否逃逸工作区
  if (!resolved.startsWith(workdir)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }

  return resolved;
}
