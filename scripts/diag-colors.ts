// 配色诊断：检查当前终端的 truecolor 是否生效 + 打印各 token 实际颜色
// 用法：node --import tsx scripts/diag-colors.ts
import { detectColorLevel } from '../src/renderer/capabilities.js';
import { fg, setColorLevel, getColorLevel } from '../src/renderer/colors.js';
import { darkTheme, getTheme } from '../src/renderer/theme.js';

console.log('=== 终端能力探测 ===');
console.log('COLORTERM:', process.env.COLORTERM ?? '(unset)');
console.log('TERM:', process.env.TERM ?? '(unset)');
console.log('WT_SESSION:', process.env.WT_SESSION ? '(set)' : '(unset)');
console.log('TERM_PROGRAM:', process.env.TERM_PROGRAM ?? '(unset)');
console.log('detectColorLevel():', detectColorLevel());

console.log('\n=== 自动探测模式（detectColorLevel）===');
setColorLevel(detectColorLevel());
console.log('当前 colorLevel:', getColorLevel());
console.log('fg("brand") 输出:', JSON.stringify(fg('brand')));

console.log('\n=== 强制 truecolor 模式 ===');
setColorLevel('truecolor');
for (const [token, spec] of Object.entries(darkTheme.tokens)) {
  const sample = `${fg(token)}████ ${token} — rgb(${spec.rgb.join(',')}) \x1b[0m`;
  console.log(sample);
}

console.log('\n=== 强制 ansi16 模式（降级对比）===');
setColorLevel('ansi16');
for (const [token, spec] of Object.entries(darkTheme.tokens)) {
  const sample = `${fg(token)}████ ${token} — ansi16:${spec.ansi16 || '(default)'} \x1b[0m`;
  console.log(sample);
}

console.log('\n=== 对比：旧配色 vs 新配色 ===');
setColorLevel('truecolor');
console.log('旧 magenta (assistant ●):', `\x1b[35m████ magenta\x1b[0m`);
console.log('新 brand  (claude 橙):  ', `${fg('brand')}████ brand rgb(215,119,87)\x1b[0m`);
console.log('旧 cyan    (边框):      ', `\x1b[36m████ cyan\x1b[0m`);
console.log('新 accent  (浅蓝紫):    ', `${fg('accent')}████ accent rgb(177,185,249)\x1b[0m`);
console.log('旧 red     (错误):      ', `\x1b[31m████ red\x1b[0m`);
console.log('新 error   (亮红):      ', `${fg('error')}████ error rgb(255,107,128)\x1b[0m`);
