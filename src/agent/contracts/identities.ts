/**
 * Wave A 公共身份与不可变值校验。
 *
 * 这些函数只负责"是字符串吗"、"非空吗"、"已经冻结了吗"。
 * 它们不承载 Authority、不维护全局 ID generator、不感知 Provider。
 * 任何对权威/信任/Placement 的判断必须由各自的契约字段决定,不能从 ID 前缀推断。
 */

/**
 * 校验一个 identity 字段是非空字符串,否则抛出带 `field` 的错误。
 *
 * 返回值是原值,不做任何权威性推断 —— 例如 `system:memory-1` 这样的前缀
 * 只是字符串,不携带 trust。调用方必须使用独立字段决定 Authority/Trust。
 */
export function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * 递归深冻结一个值,返回 `Readonly<T>`。
 *
 * - 对原始值(string/number/null/undefined/boolean)原样返回。
 * - 对已冻结对象不做二次处理(幂等)。
 * - 对函数作为属性时不抛错(freezing 一个函数属性在 JS 中合法但通常无意义)。
 * - 数组同样递归冻结其元素。
 *
 * 不复制输入:调用方传入的对象会被就地冻结。
 * 需要保留可变副本的调用方应在传入前自行深拷贝。
 */
export function freezeSnapshot<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    // 先递归冻结子节点,再冻结当前层。这样如果某个子节点抛错,当前层不会被部分冻结。
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeSnapshot(child);
    }
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
