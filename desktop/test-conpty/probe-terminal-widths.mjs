#!/usr/bin/env node
// Measurement probe: how WIDE does Claude Code draw emoji and other joined characters? Each probe text is put in its
// message box, then the terminal bytes up to that moment are saved, so a replay into the app's own terminal copy
// (shared/terminal-widths.ts) can be compared with what Claude Code meant. Offline: fake API, bwrap, no network.
// Run: node test-conpty/probe-terminal-widths.mjs --no-auth --out <new dir>   then: node test-conpty/check-terminal-widths.mjs <dir>
// WHY a throwaway plugin instead of the bridge: the bridge only fills real queue items; this registers
// the same hook shape (session.start + $.http.fetch loopback) and walks a probe list.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fileURLToPath} from 'node:url';import {fork,spawnSync} from 'node:child_process';
import {startFakeApi} from './fake-anthropic.mjs';
const self=fileURLToPath(import.meta.url),desktop=path.resolve(path.dirname(self),'..'),args=process.argv.slice(2),option=k=>args[args.indexOf(k)+1];
const out=path.resolve(option('--out'));
const cli=process.env.CLAUDE_CLI||(()=>{const d='/home/destin/.local/share/claude/versions';return path.join(d,fs.readdirSync(d).filter(n=>/^\d+(\.\d+)*$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1));})();
if(!args.includes('--no-auth'))throw Error('Explicit --no-auth required');
if(!args.includes('--inside')){
 fs.mkdirSync(out,{recursive:false});fs.mkdirSync(out+'/tmp');
 const cmd=['--die-with-parent','--new-session','--unshare-net','--unshare-pid','--clearenv','--ro-bind','/','/','--proc','/proc','--dev','/dev','--bind',out,out,'--bind',out+'/tmp','/tmp','--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/bin','--setenv','CLAUDE_CLI',cli,'--chdir',desktop,process.execPath,self,'--inside','--no-auth','--out',out];
 const r=spawnSync('/usr/bin/bwrap',cmd,{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:120000,maxBuffer:5e6});console.log(r.stdout);console.error(r.stderr);console.log('cli='+cli+' sandbox exit='+r.status);process.exitCode=r.status??1;
}else{
  // WHY O: bwrap binds <out>/tmp over /tmp, so the sandbox sees <out> under the shadowed /tmp; /tmp/_o lands in <out>/tmp/_o.
 const O='/tmp/_o';fs.mkdirSync(O,{recursive:true});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const probes=[
  ['family ZWJ','x 👨\u200D👩\u200D👧 y'],['couple ZWJ','x 👩\u200D❤\uFE0F\u200D👨 y'],['rainbow flag','x 🏳\uFE0F\u200D🌈 y'],
  ['heart VS16','x ❤\uFE0F y'],['heart plain','x ❤ y'],['skin tone','x 👍🏽 y'],['flag JP','x 🇯🇵 y'],['lone regional indicator','x 🇯 y'],
  ['keycap','x 1\uFE0F\u20E3 y'],['plain emoji','x 🙂 y'],['CJK','x 漢字 y'],['Persian ZWNJ','x می\u200Cخواهم y'],
  ['Hindi','x क्\u200Dष y'],['combining accent','x e\u0301 y'],
  ['copyright VS16','x ©\uFE0F y'],['check VS16','x ✔\uFE0F y'],['record VS16','x ⏺\uFE0F y'],['sparkle VS16','x ✳\uFE0F y'],['arrow VS16','x ↔\uFE0F y'],
  ['copyright plain','x © y'],['check plain','x ✔ y'],['finger skin tone','x ☝🏽 y'],['smile ZWJ check','x 🙂\u200D✔ y'],['heart ZWJ heart','x ❤\u200D❤ y'],
  ['digit VS16 no keycap','x 1\uFE0F y'],['emoji then accent','x 🙂\u0301 y'],['letter then skin tone','x a🏽 y'],['checklist prompt','Repeat back exactly, nothing else: 👨\u200D👩\u200D👧 می\u200Cخواهم a\u200Cb'],
 ];
 const results=[];const marks=[];let rawLength=0;let worker;
 const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{const m=JSON.parse(b);if(m.mark)marks.push({name:m.mark,offset:rawLength});if(m.submit)worker.send({type:'input',data:'\r'});if(m.result)results.push(m.result);if(m.done)results.done=true;res.end('{"ok":true}');});});
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+srv.address().port;
 const plugin=out+'/probe-plugin';fs.mkdirSync(plugin+'/.claude-plugin',{recursive:true});fs.mkdirSync(plugin+'/hooks',{recursive:true});
 fs.writeFileSync(plugin+'/.claude-plugin/plugin.json',JSON.stringify({name:'composer-probe',version:'1.0.0',description:'probe'}));
 fs.writeFileSync(plugin+'/hooks/hooks.json',JSON.stringify({modules:['./register.js']}));
 fs.writeFileSync(plugin+'/hooks/register.js',`
const probes=${JSON.stringify(probes)};
let started=false;
async function send($,url,body){await $.http.fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
async function wait($,ms){await new Promise(r=>$.clock.after(ms,r));}
async function run($){
 const url=await $.env.get('PROBE_URL');
 try{
  await wait($,2500);
  for(const [name,text] of probes){
   const rec={name,text};
   try{
    const before=await $.prompt.read();rec.before=before.text;
    const fill=await $.prompt.fill({text,mode:'replace'});rec.fill=fill;
    await wait($,600);const r2=await $.prompt.read();rec.out=r2.text;
    await send($,url,{mark:name});await wait($,200);
    await $.prompt.fill({text:'',mode:'replace'});await wait($,300);
   }catch(e){rec.error=String(e&&e.message||e);}
   await send($,url,{result:rec});
  }
  // The real failure (2026-10-22): SEND the emoji message, let Claude answer with the same text, then type the next message.
  const said=probes.find(p=>p[0]==='checklist prompt')[1];
  await $.prompt.fill({text:said,mode:'replace'});await wait($,600);
  await send($,url,{submit:true});await wait($,5000);
  await send($,url,{mark:'sent and answered'});await send($,url,{result:{name:'sent and answered',text:''}});
  await $.prompt.fill({text:'next message',mode:'replace'});await wait($,600);
  await send($,url,{mark:'next message after reply'});await send($,url,{result:{name:'next message after reply',text:'next message'}});
 }catch(e){await send($,url,{result:{name:'FATAL',error:String(e&&e.message||e)}});}
 await send($,url,{done:true});
}
function onStart($,e,next){if(!started){started=true;$.clock.after(0,()=>run($));}return next(e);}
export function register(on){on('session.start',onStart);}
`);
 const home='/tmp/h/home',config=home+'/.claude',project='/tmp/h/project';for(const p of[config,project])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(config+'/.claude.json',JSON.stringify({hasCompletedOnboarding:true,numStartups:3,theme:'dark',projects:{[project]:{hasTrustDialogAccepted:true}}}));fs.writeFileSync(config+'/settings.json',JSON.stringify({promptSuggestionEnabled:false}));
 const api=await startFakeApi([{text:probes.find(p=>p[0]==='checklist prompt')[1],wordMs:0},...Array(4).fill({text:'OK',wordMs:0})]);
 const env={PATH:'/usr/bin:/bin',HOME:home,CLAUDE_CONFIG_DIR:config,TMPDIR:'/tmp',LANG:'C.UTF-8',TERM:'xterm-256color',ANTHROPIC_BASE_URL:api.url,ANTHROPIC_AUTH_TOKEN:'dummy-local-token',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',PROBE_URL:url};
 worker=fork(desktop+'/src/main/pty-worker.js',[],{cwd:project,env,stdio:['ignore','pipe','pipe','ipc']});
 worker.on('message',m=>{if(m.type==='data'){fs.appendFileSync(O+'/terminal.raw',m.data);rawLength+=m.data.length;worker.send({type:'ack',n:m.data.length});}});
 worker.stderr.on('data',b=>fs.appendFileSync(O+'/worker.stderr',b));
 worker.send({type:'spawn',sessionId:'probe',command:cli,args:['--model','haiku','--permission-mode','default','--setting-sources','user','--plugin-dir',plugin,'--debug-file',O+'/debug.log'],controlEnv:{PROBE_URL:url},cwd:project,cols:120,rows:40});
 const end=Date.now()+60000;while(!results.done&&Date.now()<end)await sleep(100);
 worker.send({type:'kill'});await sleep(300);await api.close();srv.close();
 fs.writeFileSync(O+'/marks.json',JSON.stringify({cli,cols:120,rows:40,done:!!results.done,marks,results},null,2));
 console.log(JSON.stringify({cli,marks:marks.length,done:!!results.done}));
}
