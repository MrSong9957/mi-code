#!/usr/bin/env node
// 预构建脚本:读取 src/prompts/*.md,为每个生成 .generated.ts。
// 用法:node scripts/gen-prompts.mjs
// 改提示词后重新运行此脚本,然后提交生成的 .generated.ts。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

const promptsDir = join(process.cwd(), 'src', 'prompts');

if (!existsSync(promptsDir)) {
  console.error('prompts dir not found:', promptsDir);
  process.exit(1);
}

const mdFiles = readdirSync(promptsDir).filter(f => f.endsWith('.md') && f !== 'README.md');

if (mdFiles.length === 0) {
  console.log('no .md prompt files found');
  process.exit(0);
}

for (const file of mdFiles) {
  const name = basename(file, '.md');
  const content = readFileSync(join(promptsDir, file), 'utf8');
  const escaped = JSON.stringify(content);
  const ts = `// AUTO-GENERATED from ${name}.md — do not edit manually.\n// Run: node scripts/gen-prompts.mjs\n/* eslint-disable */\nexport const ${name}Prompt = ${escaped};\n`;
  const outPath = join(promptsDir, `${name}.generated.ts`);
  writeFileSync(outPath, ts);
  console.log(`generated: ${name}.generated.ts (${content.length} chars)`);
}
