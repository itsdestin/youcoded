#!/usr/bin/env node
// Measurement probe (not a pass/fail test): what does Claude Code's composer do to text set with
// $.prompt.fill({mode:'replace'}) when read back with $.prompt.read()? Offline: fake API, bwrap,
// no network, HOME=/tmp, dummy token. Run: node test-conpty/probe-composer-fill.mjs --no-auth --out <new dir>
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
  ['U+200B alone','a\u200Bb'],['U+200C alone','a\u200Cb'],['U+200D alone','a\u200Db'],
  ['ZWJ family emoji','x 👨\u200D👩\u200D👧 y'],['Persian ZWNJ','می\u200Cخواهم'],
  ['U+2060 word joiner','a\u2060b'],['U+FEFF BOM/ZWNBSP','a\uFEFFb'],['U+00A0 nbsp','a\u00A0b'],
  ['tab','a\tb'],['CRLF','line1\r\nline2'],['lone CR','line1\rline2'],['LF multi-line','line1\nline2\nline3'],
  ['trailing spaces','abc   '],['leading spaces','   abc'],['leading+trailing newline','\nabc\n'],
  ['3000-char single line','x'.repeat(3000)],['3000-char varied','0123456789'.repeat(300)],
  ['40 lines',Array.from({length:40},(_,i)=>'line '+(i+1)).join('\n')],
  ['quote marker','\u2983"Still open: should the first"_chat_x\u2984 what'],
  ['attachment path trailing','hello\n\nAttached: "/tmp/p/notes.txt"'],
  // Context probes: is the strip rule about the neighbours (ASCII vs non-ASCII) rather than the character?
  ['ZWSP between Persian letters','می\u200Bخواهم'],['ZWSP between emoji','👨\u200B👩'],['ZWNJ between CJK','漢\u200C字'],
  ['ZWNJ non-ASCII then ASCII','é\u200Cb'],['ZWNJ ASCII then non-ASCII','b\u200Cé'],['ZWJ ASCII then emoji','a\u200D👩'],
  ['ZWSP at start','\u200Babc'],['ZWSP at end','abc\u200B'],['ZWSP between spaces','a \u200B b'],
  ['Hindi ZWJ','क्\u200Dष'],['Persian ZWNJ then Latin','می\u200Ca'],['two ZWSP in a row','a\u200B\u200Bb'],
  ['Persian whole sentence + ASCII','سلام می\u200Cخواهم test'],['ZWSP only','\u200B'],
  ['control U+0001','a\u0001b'],['U+200E LRM','a\u200Eb'],['U+00AD soft hyphen','a\u00ADb'],['U+034F CGJ','a\u034Fb'],
 ];
 const results=[];
 const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{const m=JSON.parse(b);if(m.result)results.push(m.result);if(m.done)results.done=true;res.end('{"ok":true}');});});
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
    const r1=await $.prompt.read();rec.out=r1.text;rec.readKeys=Object.keys(r1);rec.read=r1;
    await wait($,400);const r2=await $.prompt.read();rec.out400=r2.text;
    await $.prompt.fill({text:'',mode:'replace'});const r3=await $.prompt.read();rec.clearedTo=r3.text;
   }catch(e){rec.error=String(e&&e.message||e);}
   await send($,url,{result:rec});
  }
 }catch(e){await send($,url,{result:{name:'FATAL',error:String(e&&e.message||e)}});}
 await send($,url,{done:true});
}
function onStart($,e,next){if(!started){started=true;$.clock.after(0,()=>run($));}return next(e);}
export function register(on){on('session.start',onStart);}
`);
 const home='/tmp/h/home',config=home+'/.claude',project='/tmp/h/project';for(const p of[config,project])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(config+'/.claude.json',JSON.stringify({hasCompletedOnboarding:true,numStartups:3,theme:'dark',projects:{[project]:{hasTrustDialogAccepted:true}}}));fs.writeFileSync(config+'/settings.json',JSON.stringify({promptSuggestionEnabled:false}));
 const api=await startFakeApi(Array(5).fill({text:'OK',wordMs:0}));
 const env={PATH:'/usr/bin:/bin',HOME:home,CLAUDE_CONFIG_DIR:config,TMPDIR:'/tmp',LANG:'C.UTF-8',TERM:'xterm-256color',ANTHROPIC_BASE_URL:api.url,ANTHROPIC_AUTH_TOKEN:'dummy-local-token',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',PROBE_URL:url};
 const worker=fork(desktop+'/src/main/pty-worker.js',[],{cwd:project,env,stdio:['ignore','pipe','pipe','ipc']});
 worker.on('message',m=>{if(m.type==='data'){fs.appendFileSync(O+'/terminal.raw',m.data);worker.send({type:'ack',n:m.data.length});}});
 worker.stderr.on('data',b=>fs.appendFileSync(O+'/worker.stderr',b));
 worker.send({type:'spawn',sessionId:'probe',command:cli,args:['--model','haiku','--permission-mode','default','--setting-sources','user','--plugin-dir',plugin,'--debug-file',O+'/debug.log'],controlEnv:{PROBE_URL:url},cwd:project,cols:120,rows:40});
 const end=Date.now()+60000;while(!results.done&&Date.now()<end)await sleep(100);
 worker.send({type:'kill'});await sleep(300);await api.close();srv.close();
 const cps=s=>[...s].map(c=>'U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')).join(' ');
 const rows=results.map(r=>({name:r.name,error:r.error,fill:r.fill,identical:r.out===r.text,identicalAfter400:r.out400===r.text,inLen:r.text?.length,outLen:r.out?.length,in:r.text&&r.text.length<=80?cps(r.text):undefined,out:r.out!==undefined&&r.out.length<=80?cps(r.out):undefined,outPrefix:r.out?.slice(0,60),readKeys:r.readKeys,clearedTo:r.clearedTo,before:r.before}));
 fs.writeFileSync(O+'/results.json',JSON.stringify({cli,done:!!results.done,rows,raw:results},null,2));
 for(const r of rows)console.log(JSON.stringify(r));
}
