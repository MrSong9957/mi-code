// 模拟真实终端分块 paste:把 bracketed paste 内容拆成多个小 chunk 间隔发送
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
// 用更长的多行文本(接近你那段提示词的规模)
const MULTILINE = '先暂停收尾和其他手动验收。按 systematic-debugging 调查这个问题，不要改代码。\n\n真实 TTY 复现：一次性粘贴多行提示词后，用户消息只显示部分内容且顺序异常。\n\n请沿这条链路找第一个数据发生变化的位置：\n\n终端 paste\n→ 输入组件 buffer\n→ submit 得到的完整字符串\n→ handleUserSubmit 收到的用户文本\n→ 发给模型的 messages\n→ TUI 历史消息渲染';
function startMock(reqLog) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = ''; req.on('data', d => body += d);
      req.on('end', () => { try { fs.appendFileSync(reqLog, body + '\n===END===\n'); } catch {}
        res.writeHead(200, {'Content-Type':'text/event-stream'});
        res.write('data: '+JSON.stringify({id:'m',object:'chat.completion.chunk',model:'mock',choices:[{delta:{role:'assistant',content:'收到'},finish_reason:null,index:0}]})+'\n\n');
        res.write('data: '+JSON.stringify({id:'m',object:'chat.completion.chunk',model:'mock',choices:[{delta:{},finish_reason:'stop',index:0}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+'\n\n');
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    s.listen(0, () => resolve(s));
  });
}
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-chunk-'));
  const reqLog = path.join(home, 'req.log');
  fs.mkdirSync(path.join(home,'.micode'),{recursive:true});
  const server = await startMock(reqLog);
  const port = server.address().port;
  fs.writeFileSync(path.join(home,'.micode','config.json'), JSON.stringify({defaultProvider:'openai',providers:{openai:{apiKey:'t',model:'m',baseUrl:'http://127.0.0.1:'+port+'/v1'}},permissions:{mode:'auto',rules:[]},theme:'dark',spinnerVerbs:{mode:'append',verbs:[]}}));
  const p = pty.spawn(process.execPath, [path.join(process.cwd(),'dist','index.js')], {name:'xterm-256color',cols:110,rows:40,cwd:process.cwd(),env:{...process.env,USERPROFILE:home,HOME:home,FORCE_COLOR:'1',CI:''}});
  let raw=''; p.onData(d=>raw+=d);
  setTimeout(() => {
    // 分块:先发 paste start + 前半,间隔,再发后半 + paste end
    const full = '\x1b[200~' + MULTILINE + '\x1b[201~';
    const mid = Math.floor(full.length / 2);
    p.write(full.slice(0, mid));
    setTimeout(() => { p.write(full.slice(mid)); }, 200);
  }, 2500);
  setTimeout(() => { p.write('\r'); }, 3500);
  setTimeout(() => { try{p.kill();}catch{} server.close();
    console.log('预期 len='+MULTILINE.length+' lines='+MULTILINE.split('\n').length);
    console.log('预期首40: '+JSON.stringify(MULTILINE.slice(0,40)));
    console.log('预期尾40: '+JSON.stringify(MULTILINE.slice(-40)));
    try { const c=fs.readFileSync(reqLog,'utf8'); const reqs=c.split('===END===').filter(s=>s.trim());
      for(let i=0;i<reqs.length;i++){ try{ const p2=JSON.parse(reqs[i].trim()); for(const m of (p2.messages||[])){ if(m.role==='user'){ const cc=typeof m.content==='string'?m.content:JSON.stringify(m.content); console.log('mock收到 user len='+cc.length); console.log('  首40: '+JSON.stringify(cc.slice(0,40))); console.log('  尾40: '+JSON.stringify(cc.slice(-40))); console.log('  完整匹配? '+(cc===MULTILINE?'YES':'NO — '+(cc.length<MULTILINE.length?'截断':'内容不同'))); }} }catch{} }
    } catch(e){ console.log('无日志:',e.message); }
    process.exit(0);
  }, 6000);
}
main();
