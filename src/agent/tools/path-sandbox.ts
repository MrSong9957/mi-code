// 路径沙箱：防止路径逃逸工作区
//
// 物理本质：小区门禁。
// 两道关卡确保"快递员（文件工具）只能在小区（workdir）内送件"：
//   1. 词法门禁：看车牌前缀（startsWith + 尾部分隔符）
//      防止 "京A123" 误匹配 "京A1234"（前缀碰撞）。
//   2. 真实门禁：顺着车道走到头看它真正通到哪（realpath）
//      防止"围墙内挖地道"（符号链接指向工作区外）。
//
// 两道关卡缺一不可：只看车牌会被同前缀兄弟目录骗；
// 只看真实路径又拦不住词法层就跑远的请求。
import { resolve, isAbsolute, sep, dirname } from 'path';
import { realpathSync } from 'fs';

// 工作目录（默认为 process.cwd()；由 index.ts 显式 setWorkdir 锚定）
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
 * 对路径回溯到最近存在的祖先，再 realpath 解析
 *
 * 物理本质：查字典时找不到词，就退一格查前缀。
 * 写文件常写尚不存在的深层路径（a/b/c/new.txt），
 * realpathSync 会因目标不存在而失败——于是回溯到 dirname，
 * 直到命中存在的祖先（最坏退到根目录，必然存在），再 realpath。
 *
 * 返回值：祖先的真实绝对路径（不含不存在的尾部段）。
 * 用于"真实门禁"判定，而非用于返回给调用方。
 */
function realpathExistingAncestor(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p; // 到根目录仍失败，回退返回
    return realpathExistingAncestor(parent);
  }
}

/** 判定 resolved 是否落在 root 之内（统一用尾部分隔符，防前缀碰撞） */
function isWithin(resolved: string, root: string): boolean {
  if (resolved === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return resolved.startsWith(prefix);
}

/**
 * 路径沙箱：确保路径在工作目录内
 *
 * 物理本质：给路径加围栏，防止跑到外面去。
 * 就像快递员只能在小区内送件，不能跑出小区大门。
 *
 * 两道关卡：
 *   1. 词法关卡：resolve 后用「尾部分隔符前缀」判定，拦 .. 穿越与前缀碰撞。
 *   2. 真实关卡：realpath 解析后再次判定，拦符号链接指向工作区外的逃逸。
 *
 * 返回词法路径（非 realpath），保证写文件时路径直观、调用方语义不变。
 */
export function safePath(p: string): string {
  // 如果是绝对路径，直接解析；否则相对于工作目录
  const resolved = isAbsolute(p) ? resolve(p) : resolve(workdir, p);

  // 关卡 1：词法门禁——拦 .. 穿越与前缀碰撞（workdir=/a/sub 不放行 /a/sub_evil）
  if (!isWithin(resolved, workdir)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }

  // 关卡 2：真实门禁——拦符号链接逃逸（workdir 内软链指向外部）
  const realRoot = realpathExistingAncestor(workdir);
  const realResolved = realpathExistingAncestor(resolved);
  if (!isWithin(realResolved, realRoot)) {
    throw new Error(`Path escapes workspace (symlink): ${p}`);
  }

  return resolved;
}
