// 捕获 paste/submit 边界的文本,写到 PASTE_LOG
const fs = require('fs');
const logFile = process.env.PASTE_LOG;
const expected = process.env.PASTE_EXPECTED || '';
const w = (s) => { try { fs.appendFileSync(logFile, s + '\n'); } catch {} };
w(`[probe] expected multiline length=${expected.length} lines=${expected.split('\n').length}`);
w(`[probe] expected first40=${JSON.stringify(expected.slice(0,40))}`);
w(`[probe] expected last40=${JSON.stringify(expected.slice(-40))}`);

// hook handleUserSubmit:但它是 dist 内部函数,无法直接 hook。
// 改为 hook splitSubmitTracks(从 submit-transformer.js 导出)—— 但 require 时机问题。
// 最可靠:hook console + 拦截 stdin。
