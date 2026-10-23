#!/usr/bin/env node
// Measurement probe (not pass/fail): does a queued message reach the SAME running turn, or get deferred
// until after it, depending on how attachments are worded? Same gated-batch setup as
// test-claude-queue-transport.mjs (Bash tool blocks until a release file exists; message enqueued meanwhile),
// but the transport gets a custom `prepare` that returns the wire text under test.
// Offline: fake API, bwrap, no network, HOME=/tmp, dummy token.  Run: node ... --no-auth --out <new dir>
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {fork,spawnSync} from 'node:child_process';import {createRequire} from 'node:module';
import {startFakeApi} from './fake-anthropic.mjs';
const self=fileURLToPath(import.meta.url),desktop=path.resolve(path.dirname(self),'..'),args=process.argv.slice(2),option=k=>args[args.indexOf(k)+1];
const out=path.resolve(option('--out'));
const cli=process.env.CLAUDE_CLI||(()=>{const d=path.join(process.env.HOME||'','.local/share/claude/versions');return path.join(d,fs.readdirSync(d).filter(n=>/^\d+(\.\d+)*$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1));})();
if(!args.includes('--no-auth'))throw Error('Explicit --no-auth required');
if(!args.includes('--inside')){
 fs.mkdirSync(out,{recursive:false});fs.mkdirSync(out+'/tmp');
 const cmd=['--die-with-parent','--new-session','--unshare-net','--unshare-pid','--clearenv','--ro-bind','/','/','--proc','/proc','--dev','/dev','--bind',out,out,'--bind',out+'/tmp','/tmp','--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/bin','--setenv','CLAUDE_CLI',cli,'--chdir',desktop,process.execPath,self,'--inside','--no-auth','--out',out];
 const r=spawnSync('/usr/bin/bwrap',cmd,{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:240000,maxBuffer:5e6});console.log(r.stdout);console.error(r.stderr);console.log('cli='+cli+' sandbox exit='+r.status+' (details: '+out+'/tmp/_o/summary.json)');process.exitCode=r.status??1;
}else{
 const require=createRequire(import.meta.url),{ClaudeControlBridge}=require(desktop+'/dist/main/claude-control-bridge.js'),{ClaudeQueue}=require(desktop+'/dist/main/claude-queue.js'),{ClaudeQueueStore}=require(desktop+'/dist/main/claude-queue-store.js'),{ClaudeQueueTransport}=require(desktop+'/dist/main/claude-queue-transport.js');
 const O='/tmp/_o';fs.mkdirSync(O,{recursive:true}); // WHY: bwrap shadows <out> under /tmp; /tmp/_o lands in <out>/tmp/_o
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function wait(label,p,ms=20000){const end=performance.now()+ms;while(performance.now()<end){if(p())return;await sleep(15);}throw Error('Timeout '+label);}
 const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
 const variants={
  'a-trailing-Attached':(w,p)=>`${w}\n\nAttached: "${p}/notes.txt"`,
  'b-leading-bare-path':(w,p)=>`"${p}/img.png" ${w}`,
  'c-current-Read-this-entire-file':(w,p)=>`${w}\nRead this entire file: ${JSON.stringify(p+'/notes.txt')}`,
  'd-no-path-control':(w)=>w,
 };
 const results=[];
 for(const [name,make] of Object.entries(variants)){
  const dir=O+'/'+name,home='/tmp/'+name+'/home',config=home+'/.claude',project='/tmp/'+name+'/project';for(const p of[dir,config,project])fs.mkdirSync(p,{recursive:true});
  fs.writeFileSync(config+'/.claude.json',JSON.stringify({hasCompletedOnboarding:true,numStartups:3,theme:'dark',projects:{[project]:{hasTrustDialogAccepted:true}}}));fs.writeFileSync(config+'/settings.json',JSON.stringify({promptSuggestionEnabled:false}));fs.writeFileSync(project+'/notes.txt','UNIQUE_ACTUAL_READ');fs.writeFileSync(project+'/img.png',PNG);
  const MARK='PROBE_MARK_'+name.slice(0,1).toUpperCase(),words='Please look at this '+MARK;
  const wire=make(words,project);
  const events=[],requests=[],pending=new Map();const record=(kind,data)=>{events.push({seq:events.length,at:Date.now(),kind,data});};
  const queue=new ClaudeQueue({storage:new ClaudeQueueStore(dir+'/storage'),ready:()=>true,publish:s=>record('snapshot',s)});await queue.restore();
  let worker,api,exit=null,error=null,nativeInc,queueId,bound=false,releasedAt=null,toolEndedAt=null;
  const bridge=new ClaudeControlBridge(dir+'/deployment',{pollMs:5000});
  const transport=new ClaudeQueueTransport({queue,inputSafe:()=>true,prepare:async()=>({wireText:wire,files:[]}),worker:async(_id,command)=>{
   const requestId='worker-'+events.length+'-'+Math.random();record('worker-send',{...command,requestId});
   return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(requestId);resolve({status:'unknown'});},12000);pending.set(requestId,{resolve,timer});worker.send({...command,requestId});});
  }});
  bridge.attachQueueTransport(transport);bridge.on('queue-evidence',(_id,e)=>record('native-evidence',e));bridge.on('native-ready',(_id,inc)=>{nativeInc=inc;});
  bridge.on('state',async(_id,state)=>{record('native-state',state);if(!bound&&nativeInc&&state.claudeSessionId){bound=true;queueId=await queue.bind({provider:'claude',conversationId:state.claudeSessionId},nativeInc);transport.bind('app',{queueId,incarnation:nativeInc,alias:{provider:'claude',conversationId:state.claudeSessionId},cwd:project});}});
  const rows=()=>{const files=[];const walk=p=>{if(!fs.existsSync(p))return;for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else if(f.endsWith('.jsonl'))files.push(f);}};walk(config+'/projects');return files.flatMap(f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)));};
  try{
   let count=0;const code=`import pathlib,time\np=pathlib.Path('${project}')\n(p/'start-a').write_text('START')\nwhile not (p/'release').exists(): time.sleep(.01)\n(p/'complete-a').write_text('DONE')\nprint('COMPLETE_a')`;
   const gate=`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(code).toString('base64')}'))"`;
   api=await startFakeApi(Array(15).fill(body=>{const n=++count;requests.push({n,at:Date.now(),messages:body.messages});record('api',{n});
    if(n===1)return {tools:[{name:'Bash',input:{command:gate,description:'Gate first batch'}}]};return {text:'SCRIPTED_DONE',wordMs:0};}));
   const prepared=await bridge.prepare('app');
   const env={PATH:'/usr/bin:/bin',HOME:home,CLAUDE_CONFIG_DIR:config,TMPDIR:'/tmp',LANG:'C.UTF-8',TERM:'xterm-256color',ANTHROPIC_BASE_URL:api.url,ANTHROPIC_AUTH_TOKEN:'dummy-local-token',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
   worker=fork(desktop+'/src/main/pty-worker.js',[],{cwd:project,env,stdio:['ignore','pipe','pipe','ipc']});worker.on('message',m=>{if(m.type==='data'){fs.appendFileSync(dir+'/terminal.raw',m.data);worker.send({type:'ack',n:m.data.length});}else{record('worker',m);if(m.type==='queue-worker-result'){const p=pending.get(m.requestId);if(p){clearTimeout(p.timer);pending.delete(m.requestId);p.resolve(m);}}}});worker.on('exit',(code,signal)=>{exit={code,signal};});worker.stderr.on('data',b=>fs.appendFileSync(dir+'/worker.stderr',b));
   worker.send({type:'spawn',sessionId:'queue-probe',command:cli,args:['--model','haiku','--permission-mode','default','--setting-sources','user',...prepared.args,'--allowedTools','Bash','Read','--debug-file',dir+'/debug.log'],controlEnv:prepared.env,cwd:project,cols:120,rows:40});
   await wait('native binding',()=>queueId);worker.send({type:'input',data:'ORIGINAL_QUEUE_TASK\r'});
   await wait('gated tool started',()=>fs.existsSync(project+'/start-a'));
   await queue.enqueue(queueId,{sendEpoch:queue.snapshot(queueId).sendEpoch,sendId:'probe',originalText:words,attachments:[],displayContent:words});
   // Let the offer/stage/enter happen while the tool is STILL blocked, then release it.
   await wait('native accepts (while tool still blocked)',()=>events.some(e=>e.kind==='native-evidence'&&e.data.kind==='accepted'),25000).catch(e=>record('note',String(e)));
   const apiBeforeRelease=count;releasedAt=Date.now();fs.writeFileSync(project+'/release','release');
   await wait('turn finished',()=>requests.some(r=>JSON.stringify(r.messages.at(-1)).includes('COMPLETE_a'))&&requests.some(r=>r.n>=2),20000).catch(e=>record('note',String(e)));
   await sleep(6000); // allow a deferred (post-turn) delivery to show up as an extra request
   const has=r=>JSON.stringify(r.messages).includes(MARK);
   const firstWith=requests.find(has);
   const rec=rows().filter(r=>JSON.stringify(r).includes(MARK)&&(r.type==='user'||r.type==='attachment'));
   results.push({variant:name,wire,apiRequestsTotal:count,apiRequestsBeforeRelease:apiBeforeRelease,markFirstSeenInRequest:firstWith?.n??null,
    reachedSameTurn:firstWith?firstWith.n===2&&firstWith.n>apiBeforeRelease-0:false,
    nativeEvidence:events.filter(e=>e.kind==='native-evidence').map(e=>e.data.kind+(e.data.detail?':'+e.data.detail:'')),
    transcriptRows:rec.map(r=>({type:r.type,attachmentType:r.attachment?.type,origin:r.attachment?.origin??r.origin,isMeta:r.isMeta,content:r.attachment?.prompt??r.message?.content})),
    requestTails:requests.map(r=>({n:r.n,lastMsgRole:r.messages.at(-1).role,lastMsg:JSON.stringify(r.messages.at(-1).content).slice(0,900)})),
    queueLeft:queue.snapshot(queueId).items.map(i=>i.status)});
  }catch(e){error=e.stack;results.push({variant:name,error});}
  finally{await transport.close().catch(()=>{});await bridge.close();if(worker?.connected)worker.send({type:'kill'});await wait('worker exit',()=>exit!==null,5000).catch(()=>{});for(const p of pending.values()){clearTimeout(p.timer);p.resolve({status:'unknown'});}if(api)await api.close();}
  fs.writeFileSync(dir+'/events.json',JSON.stringify(events,null,2));
  console.log(JSON.stringify({variant:name,markFirstSeenInRequest:results.at(-1).markFirstSeenInRequest,total:results.at(-1).apiRequestsTotal,error:results.at(-1).error?.split('\n')[0]}));
 }
 fs.writeFileSync(O+'/summary.json',JSON.stringify(results,null,2));
}
