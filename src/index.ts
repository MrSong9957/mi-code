#!/usr/bin/env node
// src/index.ts

const VERSION = "1.0.0";

// ANSI 颜色
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const banner = `
 ${cyan("▐▛███▜▌")}   ${bold("MiCode")} ${dim(`v${VERSION}`)}
${cyan("▝▜█████▛▘")}  ${dim("TypeScript CLI · Node.js Runtime")}
${cyan("  ▘▘ ▝▝")}    ${dim(process.cwd())}
`;

console.log(banner);

const width = process.stdout.columns || 80;
console.log(dim("─".repeat(width)));
console.log(bold("❯ ") + dim("Type 'help' to get started"));
console.log(dim("─".repeat(width)));
console.log();

process.stdin.resume();
