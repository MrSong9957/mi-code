// 对照:不用 bracketed paste,直接写多行(模拟非 paste 模式或终端不支持 bracketed)
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const MULTILINE = '第一行内容。\n第二行内容。\n第三行尾部。';
function startMock(reqLog) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = ''; req.on('data', d => body += d);
      req.on('end', () => { try { fs.appendFileSync(reqLog, body + '\n===END===\n'); } catch {}
        res.writeHead(200, {'Content-Type':'text/event-stream'});
        res.write('data: '+JSON.stringify({id:'m',object:'chat.completion.chunk',model:'mock',choices:[{delta:{role:'assistant',content:'ok'},finish_reason:null,index:0}]})+'\n\n');
        res.write('data: '+JSON.stringify({id:'m',object:'chat.completion.chunk',model:'mock',choices:[{delta:{},finish_reason:'stop',index:0}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}})+'\n\n');
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    s.listen(0, () => resolve(s));
  });
}
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-raw-'));
  const reqLog = path.join(home, 'req.log');
  fs.mkdirSync(path.join(home,'.micode'),{recursive:true});
  const server = await startMock(reqLog);
  const port = server.address().port;
  fs.writeFileSync(path.join(home,'.micode','config.json'), JSON.stringify({defaultProvider:'openai',providers:{openai:{apiKey:'t',model:'m',baseUrl:'http://127.0.0.1:'+port+'/v1'}},permissions:{mode:'auto',rules:[]},theme:'dark',spinnerVerbs:{mode:'append',verbs:[]}}));
  const p = pty.spawn(process.execPath, [path.join(process.cwd(),'dist','index.js')], {name:'xterm-256color',cols:110,rows:36,cwd:process.cwd(),env:{...process.env,USERPROFILE:home,HOME:home,FORCE_COLOR:'1',CI:''}});
  let raw=''; p.onData(d=>raw+=d);
  setTimeout(()=>{ p.write(MULTILINE); }, 2500);  // 不带 bracketed,直接写(含 \n)
  setTimeout(()=>{ p.write('\r'); }, 3000);
  setTimeout(()=>{ try{p.kill();}catch{} server.close();
    console.log('预期:', JSON.stringify(MULTILINE), 'len='+MULTILINE.length);
    const idx = raw.lastIndexOf('❯'); if(idx>=0) console.log('输入框:', JSON.stringify(raw.slice(idx, idx+200)));
    try { const c=fs.readFileSync(reqLog,'utf8'); const reqs=c.split('===END===').filter(s=>s.trim());
      for(let i=0;i<reqs.length;i++){ try{ const p2=JSON.parse(reqs[i].trim()); for(const m of (p2.messages||[])){ if(m.role==='user'){ const cc=typeof m.content==='string'?m.content:JSON.stringify(m.content); console.log('mock收到 user len='+cc.length+': '+JSON.stringify(cc.slice(0,150))); console.log('  匹配? '+(cc===MULTILINE?'YES':'NO')); }} }catch{} }
    } catch(e){ console.log('无日志:',e.message); }
    process.exit(0);
  }, 5000);
}
main();
