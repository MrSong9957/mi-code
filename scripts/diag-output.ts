// 完整复现：模拟 mi-code 启动后的真实输出，抓字节流
// 用法：node --import tsx scripts/diag-output.ts
import { Renderer } from '../src/renderer/renderer.js';

const out: string[] = [];
const r = new Renderer({
  rows: 24, cols: 80, writer: s => out.push(s),
  status: { model: 'claude-3', branch: 'master', mode: 'Act', dir: '~/mi-code', contextUsage: 0 },
});

r.enter();
// 模拟 banner（system 类型）
r.printMessage(' MiCode v1.0.0', 'system', {});
// 模拟 assistant ● + 文本
r.printMessage('● 你好，我是助手', 'system', { fg: 'brand' });
// 模拟代码块
r.printMessage('const x = 1;', 'system', {});
r.flushNow();

const all = out.join('');
console.log('=== 字节流（前 300 字符 cat -v 形式）===');
console.log(JSON.stringify(all.slice(0, 300)));
console.log('\n=== 颜色码统计 ===');
console.log('含 \\x1b[36m (cyan)?', all.includes('\x1b[36m'));
console.log('含 \\x1b[35m (magenta)?', all.includes('\x1b[35m'));
console.log('含 \\x1b[1m (bold)?', all.includes('\x1b[1m'));
console.log('含 \\x1b[?2026h (BSU)?', all.includes('\x1b[?2026h'));
console.log('含 \\x1b[?25l (hide cursor)?', all.includes('\x1b[?25l'));
r.destroy();
