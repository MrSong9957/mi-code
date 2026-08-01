// 捕获 dist 所有未处理错误/rejection,写到文件
const fs = require('fs');
const path = require('path');
const logFile = process.env.PROBE_LOG;
process.on('uncaughtException', (e) => { fs.appendFileSync(logFile, 'UNCAUGHT: ' + (e && e.stack || e) + '\n'); });
process.on('unhandledRejection', (e) => { fs.appendFileSync(logFile, 'UNHANDLED REJECTION: ' + (e && e.stack || e) + '\n'); });
const origExit = process.exit;
process.exit = function(code) { fs.appendFileSync(logFile, 'process.exit(' + code + ') called\n' + new Error().stack + '\n'); return origExit.apply(this, arguments); };
