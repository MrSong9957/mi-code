// src/render/index.ts
// 自研渲染层入口 + feature flag。
// spec §6：MICODE_DOUBLE_BUFFER=0 关闭，秒回滚 Ink 原生。

export const USE_DOUBLE_BUFFER = process.env.MICODE_DOUBLE_BUFFER !== '0';

export { createCustomRenderer, setCursorPos } from './renderer.js';
export type { CustomRendererOptions } from './renderer.js';
