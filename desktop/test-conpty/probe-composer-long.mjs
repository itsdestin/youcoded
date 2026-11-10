#!/usr/bin/env node
// Measurement probe (card #246, not a pass/fail test): what does Claude Code's composer do to LONG text set with
// $.prompt.fill({mode:'replace'}), and what does Enter then submit? Offline: fake API, bwrap, no network, HOME=/tmp.
// Run: node test-conpty/probe-composer-long.mjs --no-auth --out <new dir>
// WHY: the queue's read-back check failed on a ~170-line message (desktop.log cleanupLength=1036). Claude Code 2.1.322
// shortens a draft over 10,000 characters to first 500 + "[...Truncated text #N +L lines...]" + last 500.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fileURLToPath} from 'node:url';import {fork,spawnSync} from 'node:child_process';
import {startFakeApi} from './fake-anthropic.mjs';
const self=fileURLToPath(import.meta.url),desktop=path.resolve(path.dirname(self),'..'),args=process.argv.slice(2),option=k=>args[args.indexOf(k)+1];
const out=path.resolve(option('--out'));
const cli=process.env.CLAUDE_CLI||(()=>{const d=path.join(process.env.HOME||'','.local/share/claude/versions');return path.join(d,fs.readdirSync(d).filter(n=>/^\d+(\.\d+)*$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1));})();
if(!args.includes('--no-auth'))throw Error('Explicit --no-auth required');
if(!args.includes('--inside')){
 fs.mkdirSync(out,{recursive:false});fs.mkdirSync(out+'/tmp');
 const cmd=['--die-with-parent','--new-session','--unshare-net','--unshare-pid','--clearenv','--ro-bind','/','/','--proc','/proc','--dev','/dev','--bind',out,out,'--bind',out+'/tmp','/tmp','--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/bin','--setenv','CLAUDE_CLI',cli,'--chdir',desktop,process.execPath,self,'--inside','--no-auth','--out',out,...(args.includes('--short')?['--short']:[])];
 const r=spawnSync('/usr/bin/bwrap',cmd,{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:240000,maxBuffer:5e6});console.log(r.stdout);console.error(r.stderr);console.log('cli='+cli+' sandbox exit='+r.status);process.exitCode=r.status??1;
}else{
 const O='/tmp/_o';fs.mkdirSync(O,{recursive:true});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const lines=(n,w)=>Array.from({length:n},(_,i)=>('L'+i+' ').padEnd(w,'x')).join('\n');
 const one=n=>'y'.repeat(n);
 const shortSet=args.includes('--short');
 const probes=shortSet?[
  ['starts with #','# heading then words'],['literal [Image #1]','see [Image #1] above'],
  ['literal [Pasted text #1 +3 lines]','see [Pasted text #1 +3 lines] above'],['starts with space and !',' !ls'],
  ['starts with &','& run this in background'],['only ?','?'],['starts with !','!ls -la please'],
 ]:[
  ['9,999 one line',one(9999)],['10,000 one line',one(10000)],['10,001 one line',one(10001)],
  ['170 lines ~60 wide (~10.4k)',lines(170,60)],['170 lines ~40 wide (~7k)',lines(170,40)],
  ['30,000 multi-line',lines(500,59)],['100,000 one line',one(100000)],
  ['11k with Attached line',lines(180,60)+'\n\nAttached: "/tmp/p/paste-1.png"'],
  ['11k containing literal [Pasted text #1 +3 lines]',lines(90,60)+'\n[Pasted text #1 +3 lines]\n'+lines(90,60)],
 ];
 const results=[];let enterWaiter=null;
 const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{const m=JSON.parse(b);if(m.result)results.push(m.result);if(m.done)results.done=true;if(m.pressEnter){enterWaiter=true;}res.end('{"ok":true}');});});
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+srv.address().port;
 const plugin=out+'/probe-plugin';fs.mkdirSync(plugin+'/.claude-plugin',{recursive:true});fs.mkdirSync(plugin+'/hooks',{recursive:true});
 fs.writeFileSync(plugin+'/.claude-plugin/plugin.json',JSON.stringify({name:'composer-long-probe',version:'1.0.0',description:'probe'}));
 fs.writeFileSync(plugin+'/hooks/hooks.json',JSON.stringify({modules:['./register.js']}));
 fs.writeFileSync(plugin+'/hooks/register.js',`
const probes=${JSON.stringify(probes)};
let started=false;let submitted=null;
async function send($,url,body){await $.http.fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
async function wait($,ms){await new Promise(r=>$.clock.after(ms,r));}
async function run($){
 const url=await $.env.get('PROBE_URL');
 try{
  await wait($,2500);
  for(const [name,text] of probes){
   const rec={name,inLen:text.length};
   try{
    const fill=await $.prompt.fill({text,mode:'replace'});rec.fillIsFilled=fill.isFilled;rec.fillReturnedLen=fill.text?.length;
    const r1=await $.prompt.read();rec.readNowLen=r1.text.length;rec.readNowEqual=r1.text===text;
    await wait($,400);const r2=await $.prompt.read();rec.read400Len=r2.text.length;rec.read400Equal=r2.text===text;
    rec.read400Head=r2.text.slice(495,560);
    submitted=null;await send($,url,{pressEnter:true});
    for(let i=0;i<50&&submitted===null;i++)await wait($,100);
    rec.submitSeen=submitted!==null;
    if(submitted!==null){rec.submitLen=submitted.length;rec.submitEqual=submitted===text;rec.submitEqualTrim=submitted===text.trim();}
    await wait($,300);const r3=await $.prompt.read();rec.afterDropLen=r3.text.length;
    await $.prompt.fill({text:'',mode:'replace'});
   }catch(e){rec.error=String(e&&e.message||e);}
   await send($,url,{result:rec});
  }
 }catch(e){await send($,url,{result:{name:'FATAL',error:String(e&&e.message||e)}});}
 await send($,url,{done:true});
}
function onStart($,e,next){if(!started){started=true;$.clock.after(0,()=>run($));}return next(e);}
// WHY drop: we only want to see what Enter WOULD submit, never call the model.
async function onSubmit($,e,next){submitted=e.text;return {drop:'probe: measured, not sent'};}
export function register(on){on('session.start',onStart);on('prompt.submit',onSubmit);}
`);
 const home='/tmp/h/home',config=home+'/.claude',project='/tmp/h/project';for(const p of[config,project])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(config+'/.claude.json',JSON.stringify({hasCompletedOnboarding:true,numStartups:3,theme:'dark',projects:{[project]:{hasTrustDialogAccepted:true}}}));fs.writeFileSync(config+'/settings.json',JSON.stringify({promptSuggestionEnabled:false}));
 const api=await startFakeApi(Array(5).fill({text:'OK',wordMs:0}));
 const env={PATH:'/usr/bin:/bin',HOME:home,CLAUDE_CONFIG_DIR:config,TMPDIR:'/tmp',LANG:'C.UTF-8',TERM:'xterm-256color',ANTHROPIC_BASE_URL:api.url,ANTHROPIC_AUTH_TOKEN:'dummy-local-token',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',PROBE_URL:url};
 const worker=fork(desktop+'/src/main/pty-worker.js',[],{cwd:project,env,stdio:['ignore','pipe','pipe','ipc']});
 worker.on('message',m=>{if(m.type==='data'){fs.appendFileSync(O+'/terminal.raw',m.data);worker.send({type:'ack',n:m.data.length});}});
 worker.stderr.on('data',b=>fs.appendFileSync(O+'/worker.stderr',b));
 worker.send({type:'spawn',sessionId:'probe',command:cli,args:['--model','haiku','--permission-mode','default','--setting-sources','user','--plugin-dir',plugin,'--debug-file',O+'/debug.log'],controlEnv:{PROBE_URL:url},cwd:project,cols:120,rows:40});
 const end=Date.now()+180000;
 while(!results.done&&Date.now()<end){if(enterWaiter){enterWaiter=null;worker.send({type:'input',data:'\r'});}await sleep(50);}
 worker.send({type:'kill'});await sleep(300);await api.close();srv.close();
 fs.writeFileSync(O+'/results.json',JSON.stringify({cli,done:!!results.done,results},null,2));
 for(const r of results)console.log(JSON.stringify(r));
}
