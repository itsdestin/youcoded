#!/usr/bin/env node
// Offline actual production bridge/plugin/queue/worker smoke. No app, SDK, auth or paid route.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {fork,spawnSync} from 'node:child_process';import {createRequire} from 'node:module';import assert from 'node:assert/strict';
import {startFakeApi} from './fake-anthropic.mjs';
const self=fileURLToPath(import.meta.url),desktop=path.resolve(path.dirname(self),'..'),args=process.argv.slice(2),option=k=>args[args.indexOf(k)+1];
const out=path.resolve(option('--out')); const cli=(()=>{ // WHY: the pinned 2.1.303 binary was pruned; use CLAUDE_CLI or the newest installed version (numeric sort).
 if(process.env.CLAUDE_CLI)return process.env.CLAUDE_CLI;const dir=path.join(process.env.HOME||'','.local/share/claude/versions');
 const v=fs.readdirSync(dir).filter(n=>/^\d+(\.\d+)*$/.test(n)).sort((a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]??0)-(y[i]??0);if(d)return d;}return 0;});
 if(!v.length)throw Error('No Claude CLI under '+dir);return path.join(dir,v.at(-1));})();
if(!args.includes('--no-auth'))throw Error('Explicit --no-auth required');
if(!args.includes('--inside')){
 fs.mkdirSync(out,{recursive:false});fs.mkdirSync(out+'/tmp');
 const cmd=['--die-with-parent','--new-session','--unshare-net','--unshare-pid','--clearenv','--ro-bind','/','/','--proc','/proc','--dev','/dev','--bind',out,out,'--bind',out+'/tmp','/tmp','--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/bin',...(process.env.CLAUDE_CLI?['--setenv','CLAUDE_CLI',process.env.CLAUDE_CLI]:[]),'--chdir',desktop,process.execPath,self,'--inside','--no-auth','--out',out,...(args.includes('--review-regressions')?['--review-regressions']:[])];
 const r=spawnSync('/usr/bin/bwrap',cmd,{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:120000,maxBuffer:200000});fs.writeFileSync(out+'/launch.json',JSON.stringify({cmd,exit:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr},null,2));console.log(r.stdout);console.error(r.stderr);console.log('sandbox exit='+r.status);process.exitCode=r.status??1;
}else{
 const require=createRequire(import.meta.url),{ClaudeControlBridge}=require(desktop+'/dist/main/claude-control-bridge.js'),{ClaudeQueue}=require(desktop+'/dist/main/claude-queue.js'),{ClaudeQueueStore}=require(desktop+'/dist/main/claude-queue-store.js'),{ClaudeQueueTransport}=require(desktop+'/dist/main/claude-queue-transport.js');
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function wait(label,p,ms=20000){const end=performance.now()+ms;while(performance.now()<end){if(p())return;await sleep(15);}throw Error('Timeout '+label);}
 const results=[];
 for(const mode of (args.includes('--review-regressions')?['delayed-admitted','failed-admitted']:['fifo','cancel','expired','lost','idle','joiner','nested'])){
  const idleMode=mode==='idle'||mode==='joiner'; /* joiner: idle delivery of text whose zero-width non-joiner Claude Code's box drops (2026-10-22) */ const dir=out+'/'+mode,home='/tmp/'+mode+'/home',config=home+'/.claude',project='/tmp/'+mode+'/project';for(const p of[dir,config,project])fs.mkdirSync(p,{recursive:true});
  fs.writeFileSync(config+'/.claude.json',JSON.stringify({hasCompletedOnboarding:true,numStartups:3,theme:'dark',projects:{[project]:{hasTrustDialogAccepted:true}}}));fs.writeFileSync(config+'/settings.json',JSON.stringify({promptSuggestionEnabled:false}));fs.writeFileSync(project+'/notes.txt','UNIQUE_ACTUAL_READ_é');
  const events=[],requests=[],pending=new Map();const record=(kind,data)=>{events.push({seq:events.length,at:Date.now(),kind,data});fs.appendFileSync(dir+'/events.jsonl',JSON.stringify(events.at(-1))+'\n');};
  function transcriptHeads(marker){const files=[];const walk=p=>{if(!fs.existsSync(p))return;for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else if(f.endsWith('.jsonl'))files.push(f);}};walk(config+'/projects');return files.flatMap(f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l))).filter(r=>(r.type==='user'&&JSON.stringify(r.message?.content).includes(marker))||(r.type==='attachment'&&r.attachment?.type==='queued_command'&&JSON.stringify(r.attachment.prompt).includes(marker)));}
  const queue=new ClaudeQueue({storage:new ClaudeQueueStore(dir+'/storage'),ready:()=>true,publish:s=>record('snapshot',s)});await queue.restore();let worker,api,exit=null,error=null,nativeInc,queueId,bound=false,revokeInjected=false,expectedWire,admittedAckDone=false;
  const bridge=new ClaudeControlBridge(dir+'/deployment',{pollMs:5000});
  const transport=new ClaudeQueueTransport({queue,inputSafe:()=>true,worker:async(_id,command)=>{
   if(mode==='cancel'&&command.type==='queue-enter'&&!revokeInjected){revokeInjected=true;void transport.revoke('app');return {status:'revoked'};}
   if(mode==='expired'&&command.type==='queue-enter') { await new Promise(r=>setTimeout(r,Math.max(0,command.expiresAt-Date.now()+10))); }
   const requestId='worker-'+events.length+'-'+Math.random();record('worker-send',{...command,requestId});
   return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(requestId);resolve({status:'unknown'});},12000);pending.set(requestId,{resolve,timer});worker.send({...command,requestId});});
  }});
  const event=transport.event.bind(transport);transport.event=async(id,inc,e)=>{if(mode==='lost'&&['accepted','transcript'].includes(e.kind)){record('dropped-evidence',e);throw Error('Scripted receipt loss');}if(e.kind==='admitted'&&mode.endsWith('-admitted')) { await event(id,inc,e); if(mode==='failed-admitted'){admittedAckDone=true;throw Error('Scripted admitted acknowledgement failure before next');} const acquisition=events.find(x=>x.kind==='worker-send'&&x.data.type==='queue-acquire');await new Promise(r=>setTimeout(r,Math.max(0,acquisition.data.expiresAt-Date.now()+30)));admittedAckDone=true;record('late-admitted-ack',{});return; }return event(id,inc,e);};
  bridge.attachQueueTransport(transport);bridge.on('queue-evidence',(_id,e)=>record('native-evidence',e));bridge.on('native-ready',(_id,inc)=>{nativeInc=inc;record('native-ready',{inc});});bridge.on('state',async(_id,state)=>{record('native-state',state);if(!bound&&nativeInc&&state.claudeSessionId){bound=true;queueId=await queue.bind({provider:'claude',conversationId:state.claudeSessionId},nativeInc);transport.bind('app',{queueId,incarnation:nativeInc,alias:{provider:'claude',conversationId:state.claudeSessionId},cwd:project});}});
  try{
   let count=0,mainCount=0,childCount=0;const command=n=>{const code=`import pathlib,time\np=pathlib.Path('${project}')\n(p/'start-${n}').write_text('START')\nwhile not (p/'release').exists(): time.sleep(.01)\n(p/'complete-${n}').write_text('DONE')\nprint('COMPLETE_${n}')`;return `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(code).toString('base64')}'))"`;};
   api=await startFakeApi(Array(15).fill(body=>{const n=++count;requests.push(body);const nested=mode==='nested'&&JSON.stringify(body.messages?.[0]?.content).includes('CHILD_QUEUE_TASK');record('api',{n,nested,messages:body.messages});
    if(mode==='nested') { if(nested) return ++childCount===1?{tools:[{name:'Bash',input:{command:command('a'),description:'Nested gated batch'}}]}:{text:'CHILD_DONE',wordMs:0}; if(++mainCount===1)return {tools:[{name:'Agent',input:{description:'Actual nested exclusion',prompt:'CHILD_QUEUE_TASK: do the gated child tool',subagent_type:'claude'}}]};return {text:'SCRIPTED_DONE',wordMs:0}; }
    if(idleMode)return {text:'SCRIPTED_DONE',wordMs:0};
    if(n===1)return {tools:[{name:'Bash',input:{command:command('a'),description:'Gate first batch'}}]};if(n===2&&mode==='fifo')return {tools:[{name:'Bash',input:{command:'echo SECOND_BATCH',description:'Second action batch'}}]};if(n===3&&mode==='fifo')return {tools:[{name:'Read',input:{file_path:project+'/notes.txt'}}]};return {text:'SCRIPTED_DONE',wordMs:0};}));
   const prepared=await bridge.prepare('app');assert.ok(prepared);
   const env={PATH:'/usr/bin:/bin',HOME:home,CLAUDE_CONFIG_DIR:config,TMPDIR:'/tmp',LANG:'C.UTF-8',TERM:'xterm-256color',ANTHROPIC_BASE_URL:api.url,ANTHROPIC_AUTH_TOKEN:'dummy-local-token',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
   worker=fork(desktop+'/src/main/pty-worker.js',[],{cwd:project,env,stdio:['ignore','pipe','pipe','ipc']});worker.on('message',m=>{if(m.type==='data'){fs.appendFileSync(dir+'/terminal.raw',m.data);worker.send({type:'ack',n:m.data.length});}else{record('worker',m);if(m.type==='queue-worker-result'){const p=pending.get(m.requestId);if(p){clearTimeout(p.timer);pending.delete(m.requestId);p.resolve(m);}}}});worker.on('exit',(code,signal)=>{exit={code,signal};});worker.stderr.on('data',b=>fs.appendFileSync(dir+'/worker.stderr',b));
   worker.send({type:'spawn',sessionId:'queue-smoke',command:cli,args:['--model','haiku','--permission-mode','default','--setting-sources','user',...prepared.args,'--allowedTools','Bash','Read','Agent','--debug-file',dir+'/debug.log'],controlEnv:prepared.env,cwd:project,cols:120,rows:40});
   await wait('native binding',()=>queueId);worker.send({type:'input',data:'ORIGINAL_QUEUE_TASK\r'});if(idleMode)await wait('authoritative original idle',()=>requests.length===1&&events.some(e=>e.kind==='native-state'&&e.data.turnId===null&&events.some(x=>x.kind==='api'&&x.seq<e.seq)));
   else await wait('actual batch tool start',()=>fs.existsSync(project+'/start-a'));
   const text='QUEUE_HEAD_ONE '+('é🙂 漢字 '.repeat(100))+(mode==='joiner'?' a\u200Cb':'');
   expectedWire=(await require(desktop+'/dist/main/claude-queue-input.js').prepareClaudeQueueInput({text,attachments:[project+'/notes.txt'],cwd:project})).wireText;
   await queue.enqueue(queueId,{sendEpoch:queue.snapshot(queueId).sendEpoch,sendId:'head-one',originalText:text,attachments:[project+'/notes.txt'],displayContent:'Exact original head one'});
   if(mode==='fifo')await queue.enqueue(queueId,{sendEpoch:queue.snapshot(queueId).sendEpoch,sendId:'head-two',originalText:'QUEUE_HEAD_TWO',attachments:[],displayContent:'Head two'});
   fs.writeFileSync(project+'/release','release'); if(idleMode)transport.requestIdle('app');
   if(mode.endsWith('-admitted')) {
    await wait('admitted acknowledgement fault injected',()=>admittedAckDone);
    await wait('original task passed expired/released fence',()=>requests.length>=2);
    assert.ok(!JSON.stringify(requests[1].messages).includes('QUEUE_HEAD_ONE'));
    const attempt=queue.snapshot(queueId).items[0].attempt;assert.ok(attempt?.admission);assert.equal(attempt.receipt,undefined);
    await wait('terminal non-invocation proof published',()=>events.some(e=>e.kind==='native-evidence'&&(e.data.detail?.startsWith('Native terminal not-invoked')||/called=false; evidence=not-invoked/.test(e.data.detail??''))));
    transport.reconcile('app',attempt.attemptId);
    await wait('terminal native non-invocation cleanup',()=>queue.snapshot(queueId).items[0].status==='waiting');
    assert.equal(transcriptHeads('QUEUE_HEAD_ONE').length,0);assert.equal(events.filter(e=>e.kind==='worker-send'&&e.data.type==='queue-enter').length,1);
   }
   else if(['fifo','idle','joiner','nested'].includes(mode))await wait('native accepts',()=>events.filter(e=>e.kind==='native-evidence'&&e.data.kind==='accepted').length===(mode==='fifo'?2:1));
   else if(mode==='lost')await wait('lost receipt quarantined',()=>queue.snapshot(queueId).paused&&queue.snapshot(queueId).items[0]?.status==='uncertain');
   else await wait('native revoke settled',()=>events.some(e=>e.kind==='worker'&&e.data.status==='released'));
   await wait('original task completed',()=>requests.some(b=>b.messages?.some(m=>m.role==='assistant'&&JSON.stringify(m.content).includes('SCRIPTED_DONE')))||requests.length>=(mode==='fifo'?4:2));
   if(mode==='fifo'){
    assert.ok(JSON.stringify(requests[1].messages).includes('QUEUE_HEAD_ONE'));assert.ok(JSON.stringify(requests[1].messages).includes('Attached: '));assert.ok(!JSON.stringify(requests[1].messages).includes('Read this entire file:')); /* an attached file is a plain trailing line, reaching the SAME running turn */
    assert.ok(JSON.stringify(requests[2].messages).includes('QUEUE_HEAD_TWO'));assert.ok(JSON.stringify(requests[3].messages).includes('UNIQUE_ACTUAL_READ_é'));
    await wait('both real transcript confirmations',()=>queue.snapshot(queueId).items.length===0);
   }else if(idleMode) { assert.ok(JSON.stringify(requests[1].messages).includes('QUEUE_HEAD_ONE')); if(mode==='joiner')assert.ok(JSON.stringify(requests[1].messages).includes('a\\u200cb')||JSON.stringify(requests[1].messages).includes('a\u200Cb'),'the model receives the exact original bytes');await wait('idle transcript confirmation',()=>queue.snapshot(queueId).items.length===0); }
   else if(mode==='nested') { const childRequests=events.filter(e=>e.kind==='api'&&e.data.nested);assert.equal(childRequests.length,2);assert.ok(childRequests.every(e=>!JSON.stringify(e.data.messages).includes('QUEUE_HEAD_ONE')));const parent=events.filter(e=>e.kind==='api'&&!e.data.nested);assert.ok(parent.some(e=>JSON.stringify(e.data.messages).includes('QUEUE_HEAD_ONE'))); /* parent may finish before its background Agent; only child exclusion is asserted here */ }
   else if(mode==='lost') { assert.ok(JSON.stringify(requests[1].messages).includes('QUEUE_HEAD_ONE'));const enters=events.filter(e=>e.kind==='worker-send'&&e.data.type==='queue-enter');assert.equal(enters.length,1);transport.requestIdle('app');assert.equal(queue.snapshot(queueId).items[0].status,'uncertain'); }
   else {assert.ok(!JSON.stringify(requests[1].messages).includes('QUEUE_HEAD_ONE'));assert.ok(['waiting','uncertain'].includes(queue.snapshot(queueId).items[0].status));}
   if(['fifo','lost','idle','nested'].includes(mode)) { await wait('exactly one real human head row',()=>transcriptHeads('QUEUE_HEAD_ONE').length===1); const row=transcriptHeads('QUEUE_HEAD_ONE')[0];const content=row.attachment?.prompt??row.message?.content;const actual=typeof content==='string'?content:content.filter(c=>c.type==='text').map(c=>c.text).join('');assert.equal(actual,expectedWire,'actual durable human input preserves full prepared Unicode/trailing whitespace'); record('actual-transcript-heads',{headOne:transcriptHeads('QUEUE_HEAD_ONE').map(r=>({type:r.type,uuid:r.uuid,origin:r.attachment?.origin??r.origin}))}); }
   if(mode==='fifo') { await wait('exactly one second human row',()=>transcriptHeads('QUEUE_HEAD_TWO').length===1); }
   if(['cancel','expired'].includes(mode)) assert.equal(transcriptHeads('QUEUE_HEAD_ONE').length,0);
  }catch(e){error=e.stack;record('error',error);}
  finally{await transport.close().catch(e=>record('close-error',String(e)));await bridge.close();if(worker?.connected)worker.send({type:'kill'});await wait('owned worker exit',()=>exit!==null,5000).catch(()=>{});for(const p of pending.values()){clearTimeout(p.timer);p.resolve({status:'unknown'});}if(api)await api.close();}
  fs.writeFileSync(dir+'/result.json',JSON.stringify({mode,error,requests,events,exit},null,2));results.push({mode,error,requests:requests.length});console.log(JSON.stringify(results.at(-1)));if(error)break;
 }
 fs.writeFileSync(out+'/summary.json',JSON.stringify(results,null,2));process.exitCode=results.some(r=>r.error)?1:0;
}
