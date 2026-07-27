// 提示词统一导出。
// .md 源文件经 scripts/gen-prompts.mjs 生成 .generated.ts。
// 改提示词:编辑 .md → 运行 npm run gen:prompts → 提交 .generated.ts。
export { plannerPrompt } from './planner.generated.js';
export { systemPrompt } from './system.generated.js';
