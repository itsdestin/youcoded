import test from 'node:test';
import './linux-speed-winner-transport.test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as winnerModule from './linux-speed-winner.mjs';
import { fingerprint, normalizeMetadata } from './linux-build-bench.mjs';
import { createRequire } from 'node:module';
import { normalizeRpmDump, deriveRpmDump, verifyRun, verifyArtifact, verifyContents, verifyCaseUnion, verifyPackages, validateWorkflow, fetchReceipts, loadReceipts, validateSource, validateNeeds, verifyFiles, pins, control, winners } from './linux-speed-winner.mjs';
const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const YAML = require('yaml');
const run = () => ({ id: control.run, head_sha: control.sha, head_branch: control.branch, path: control.path, workflow_id: control.workflow, event: 'pull_request', status: 'completed', conclusion: 'success', repository: {id: control.repositoryId, full_name: control.repository}, head_repository: {id:control.repositoryId,full_name:control.repository}, run_attempt:1 });
const artifact = name => ({id:pins[name].id,name,digest:pins[name].digest,expired:false,expires_at:'2099-01-01T00:00:00Z',workflow_run:{id:control.run,head_sha:control.sha,head_branch:control.branch,repository_id:control.repositoryId,head_repository_id:control.repositoryId}});

test('all unchanged cheap checks start concurrently and every result remains required', async () => {
  assert.equal(typeof winnerModule.runCheapChecks, 'function');
  const started = [], release = [];
  const complete = winnerModule.runCheapChecks((name, command, args) => {
    started.push({name,command,args});
    return new Promise((resolve,reject) => release.push({resolve,reject}));
  });
  assert.deepEqual(started.map(x=>x.name), ['types','knip','lint','design-lint']);
  assert.deepEqual(started.map(x=>x.args), [['run','typecheck'],['run','knip'],['run','lint'],['run','lint:design']]);
  release[0].reject(new Error('intentional failed check'));
  for (const entry of release.slice(1)) entry.resolve({exitCode:0});
  await assert.rejects(complete, /cheap validation/);
  assert.equal((await winnerModule.runCheapChecks(async()=>({exitCode:0}))).length,4);
});

test('immutable successful same-repository PR run and artifact provenance fail closed', () => {
  verifyRun(run());
  for (const [key,value] of Object.entries({id:1,head_sha:'wrong',head_branch:'master',path:'other.yml',workflow_id:1,event:'push',status:'queued',conclusion:'failure',run_attempt:2,repository:{id:1},head_repository:{id:1}})) {
    assert.throws(() => verifyRun({...run(),[key]:value}), key);
  }
  for (const name of Object.keys(pins)) {
    verifyArtifact(name,artifact(name));
    for (const [key,value] of Object.entries({id:1,name:'latest',digest:'sha256:bad',expired:true,expires_at:'2000-01-01',workflow_run:{...artifact(name).workflow_run,head_sha:'wrong'}})) assert.throws(() => verifyArtifact(name,{...artifact(name),[key]:value}), key);
    assert.throws(() => verifyArtifact(name,{...artifact(name),workflow_run:{...artifact(name).workflow_run,head_repository_id:1}}));
    assert.throws(() => verifyContents(name,{}));
    assert.throws(() => verifyContents(name,Object.fromEntries(Object.keys(pins[name].files).map(f => [f,Buffer.from('{}')]))));
  }
});
test('always gate rejects missing, unknown, failed, skipped and cancelled prerequisites',()=> {
  const needs=()=>Object.fromEntries(['prep','inventory','packages','shards'].map(n=>[n,{result:'success'}]));
  validateNeeds(needs());
  for(const name of Object.keys(needs())) {
    const missing=needs();delete missing[name];assert.throws(()=>validateNeeds(missing));
    for(const result of ['failure','cancelled','skipped','unknown',null]) {const n=needs();n[name].result=result;assert.throws(()=>validateNeeds(n));}
  }
  assert.throws(()=>validateNeeds({...needs(),extra:{result:'success'}}));
});
test('fresh files-only discovery is independently compared, with no missing/extra/duplicate or escaped paths',()=> {
  const expected=['tests/a.test.ts','src/b.spec.tsx'];
  const raw=expected.map(file=>({file:`/runner/desktop/${file}`}));
  assert.deepEqual(verifyFiles(expected,raw).sort(),expected.sort());
  for(const changed of [raw.slice(1),[...raw,raw[0]],[...raw,{file:'tests/extra.test.ts'}],[{file:'../tests/a.test.ts'},raw[1]],[{file:'tests/../tests/a.test.ts'},raw[1]]]) assert.throws(()=>verifyFiles(expected,changed));
});
const cases = [{file:'tests/a.test.ts',name:'suite > pass',status:'passed'},{file:'tests/a.test.ts',name:'suite > old skip',status:'pending'}];
test('complete case union retains every pre-existing skip and no added skip, duplicate, failure or omission', () => {
  verifyCaseUnion(cases,structuredClone(cases));
  for (const changed of [cases.slice(0,1),[...cases,cases[0]],cases.map(c=>({...c,status:'pending'})),cases.map(c=>({...c,name:c.name+'changed'})),cases.map(c=>({...c,status:'failed'}))]) assert.throws(() => verifyCaseUnion(cases,changed));
});
const digest='fixture-digest';
const sha = text => createHash('sha256').update(text).digest('hex');
const actualDump='/opt/YouCoded/resources/office/editors/sdkjs/slide/themes/src/05_green leaf.pptx 68836 1792374950 89d5c4d531a8d399a8443d6e00b04c23 0100644 root root 0 0 0 X\n';
const dumpEntry=raw=>({path:'dump',type:'file',mode:420,size:Buffer.byteLength(normalizeMetadata('rpm-dump',raw)),sha256:sha(normalizeMetadata('rpm-dump',raw))});
test('actual RPM space-path failure normalizes only mtime, including tabs, numeric paths and spaced link targets',()=> {
  for(const raw of [actualDump,actualDump.replace('05_green leaf','05_green\t leaf'),actualDump.replace('05_green leaf','123 456'),actualDump.replace(' X\n',' ../../target with spaces\n')]) {
    const changed=raw.replace('1792374950','1792379310');
    assert.equal(normalizeRpmDump(raw),normalizeRpmDump(changed));
    assert.equal(normalizeRpmDump(raw),raw.replace('1792374950','<build timestamp>'));
    for(const [a,b] of [['05_green','06_green'],['68836','68837'],['89d5c4d','99d5c4d'],['0100644','0100755'],['root root','user root'],['root root','root group'],['0 0 0 X','1 0 0 X'],['0 0 0 X','0 1 0 X'],['0 0 0 X','0 0 7 X'],[' X\n',' different link\n']]) {
      if(raw.includes(a)) assert.notEqual(normalizeRpmDump(raw),normalizeRpmDump(raw.replace(a,b)));
    }
  }
  const ambiguous=actualDump.replace(' X\n',' /link 1 2 abcd 0100644 root root 0 0 0 X\n');
  for(const raw of ['', 'not a dump\n', actualDump+'\n',actualDump.replace('0100644','invalid'),ambiguous]) assert.throws(()=>normalizeRpmDump(raw));
});
test('derived dump requires old hashed receipt equality before changing only derived size/hash',()=> {
  const old={payload:[{path:'app',sha256:'immutable'}],metadata:[dumpEntry(actualDump),{path:'scripts',sha256:'immutable'}]};
  const snapshot=structuredClone(old);const derived=deriveRpmDump(old,actualDump);
  assert.deepEqual(old,snapshot);assert.deepEqual(derived.payload,old.payload);assert.deepEqual(derived.metadata[1],old.metadata[1]);
  assert.deepEqual(derived.metadata[0],{...old.metadata[0],size:Buffer.byteLength(normalizeRpmDump(actualDump)),sha256:sha(normalizeRpmDump(actualDump))});
  for(const raw of [undefined,actualDump.replace('68836','68837'),actualDump.replace('1792374950','1792379310'),actualDump.replace('0100644','0100755')]) assert.throws(()=>deriveRpmDump(old,raw));
  for(const key of ['sha256','size','mode','type']) {const bad=structuredClone(old);bad.metadata[0][key]='wrong';assert.throws(()=>deriveRpmDump(bad,actualDump));}
  assert.throws(()=>deriveRpmDump({...old,metadata:[]},actualDump));
  assert.throws(()=>deriveRpmDump({...old,metadata:[...old.metadata,old.metadata[0]]},actualDump));
});
function packageRecord(id) {
  const rpm=id.startsWith('rpm-');
  const rawDump=id.endsWith('fast')?actualDump.replace('1792374950','1792379310'):actualDump;
  const original={'requires':id.endsWith('default')?'rpmlib(PayloadIsXz) <= 5.2-1\n':'','flags-REQUIRE':id.endsWith('default')?'rpmlib(PayloadIsXz)\t16777226\t5.2-1\n':''};
  // Removing the exact xz line leaves a trailing newline in the real harness.
  for (const key of Object.keys(original)) original[key]='application-dependency\n'+original[key];
  return {info:{id,fingerprint:digest,bytes:42},metric:{exitCode:0},payload:{payload:[{path:'application',sha256:sha('same application')}],metadata:rpm?[...Object.keys(original).map(key=>({path:key,sha256:sha('application-dependency\n')})),dumpEntry(rawDump)]:[{path:'control',sha256:sha('same control')}]},...(rpm?{rawDump,capability:{compressor:id.endsWith('fast')?'gzip':'xz',original}}:{})};
}
function packageFixture() {
  const records=winners.map(packageRecord);
  const receipts=Object.fromEntries(['deb','rpm','pacman'].map(target=> {
    const r=packageRecord(`${target}-default`);
    return [`evidence-${target}-default`,{'fingerprint.json':{digest},'package-info.json':r.info,'package.json':r.metric,'payload.json':r.payload,...(r.capability?{'rpm-compression-capability.json':r.capability,'rpm-dump-raw.txt':r.rawDump}:{})}];
  }));
  return {records,receipts};
}
test('four winners retain complete immutable default payload/metadata and exact RPM capability comparison', () => {
  assert.deepEqual(winners,['AppImage-default','deb-fast','rpm-fast','pacman-fast']);
  const {records,receipts}=packageFixture();
  assert.equal(verifyPackages(records,receipts,digest).length,4);
  const mutations=[
    f=>f.records.pop(), f=>f.records.push(f.records[0]),f=>delete f.receipts['evidence-deb-default'],
    f=>f.receipts['evidence-deb-default']['fingerprint.json'].digest='wrong',
    f=>f.receipts['evidence-rpm-default']['package-info.json'].id='rpm-fast',
    f=>f.records[1].payload.payload[0].sha256='wrong',f=>f.records[1].payload.metadata[0].sha256='wrong',
    f=>delete f.records[2].rawDump,
    f=>delete f.receipts['evidence-rpm-default']['rpm-dump-raw.txt'],
    ...['68836','89d5c4d','0100644','root root','0 0 0 X','05_green'].map(token=>f=> {
      // Even a coherent changed raw+legacy receipt must fail against the full
      // default canonical, rather than being hidden by the timestamp exception.
      f.records[2].rawDump=f.records[2].rawDump.replace(token,token==='68836'?'68837':token==='0100644'?'0100755':token==='0 0 0 X'?'1 0 0 X':token==='root root'?'user root':token==='05_green'?'06_green':'99d5c4d');
      f.records[2].payload.metadata=f.records[2].payload.metadata.map(e=>e.path==='dump'?dumpEntry(f.records[2].rawDump):e);
    }),
    f=>f.records[2].payload.payload[0].sha256='changed RPM application',
    f=>f.records[2].payload.metadata.find(e=>e.path==='dump').mode=0o755,
    f=>f.records[1].metric.exitCode=1, f=>f.records[2].capability.compressor='xz',
    f=>f.records[2].capability.original.requires+='rpmlib(PayloadIsXz) <= 5.2-1\n',
    f=>f.receipts['evidence-rpm-default']['rpm-compression-capability.json'].original['flags-REQUIRE']='rpmlib(PayloadIsXz)\t16777227\t5.2-1\n',
  ];
  for(const mutate of mutations) {const f=packageFixture();mutate(f);assert.throws(()=>verifyPackages(f.records,f.receipts,digest));}
});
test('API error, failed run, expired receipt, corrupt archive, absent receipt paths and reloaded hashes cannot fall back',async()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winner-receipt-test-'));
  try {
    await assert.rejects(fetchReceipts(dir,{request:async()=>{throw new Error('API 403');}}),/API 403/);
    await assert.rejects(fetchReceipts(dir,{request:async()=>({...run(),conclusion:'failure'})}),/Uncertified control run/);
    const response=(suffix,binary)=> {
      if(suffix===`actions/runs/${control.run}`) return run();
      const name=Object.keys(pins).find(n=>pins[n].id===Number(suffix.split('/')[2]));
      return binary?Buffer.from('corrupt archive'):artifact(name);
    };
    await assert.rejects(fetchReceipts(dir,{request:async(s,b)=>response(s,b)}),/archive hash mismatch/);
    await assert.rejects(fetchReceipts(dir,{request:async(s,b)=>s.includes('/runs/')?run():{...response(s,b),expired:true}}),/Uncertified artifact/);
    assert.throws(()=>loadReceipts(dir));
    fs.writeFileSync(path.join(dir,'provenance.json'),JSON.stringify({run:run(),artifacts:Object.fromEntries(Object.keys(pins).map(n=>[n,artifact(n)]))}));
    assert.throws(()=>loadReceipts(dir),/ENOENT/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('full production working-tree fingerprint still equals certified frozen digest',()=> {
  assert.equal(fingerprint().digest,control.digest);
  assert.throws(()=>validateSource({'evidence-inventory':{'fingerprint.json':{digest:control.digest}}},{digest:'changed'}));
});
test('entire real workflow matches executable fixed specification; mutations cannot relax any command or policy', () => {
  const w = YAML.parse(fs.readFileSync(new URL('../.github/workflows/linux-speed-winner.yml',import.meta.url),'utf8'));
  validateWorkflow(w);
  const mutations = [
    x => {x.on.workflow_dispatch={};}, x => {x.permissions.actions='write';},
    x => {x.jobs.prep.if='true';}, x => {x.jobs.gate.if='success()';},
    x => {x.jobs.packages.strategy.matrix.variant.pop();}, x => {x.jobs.shards.strategy.matrix.shard.pop();},
    x => {x.jobs.inventory.needs='prep';}, x => {x.jobs.prep.steps.find(s=>s.run?.includes('cheap-preflight-total')).run='true';},
    x => {x.jobs.inventory.steps.find(s=>s.run?.includes('receipt')).run+=' && node scripts/linux-build-bench.mjs discover';},
    x => {x.jobs.packages.steps.find(s=>s.run?.includes('package-total')).run+=' --publish always';},
    x => {x.jobs.gate.needs.pop();}, x => {x.jobs.shards.steps.find(s=>s.run?.includes('shard-total')).run+=' --testNamePattern=fast';},
    x => {x.jobs.prep.steps[0].with['persist-credentials']=true;},
    x => {x.jobs.prep.steps.find(s=>s.run?.includes('preparation-total')).run='node scripts/linux-build-bench.mjs prepare';},
    x => {x.jobs.prep.steps.find(s=>s.run?.includes('zstd --version')).run='true';},
    x => {x.jobs.packages.steps.find(s=>s.run?.includes('zstd --version')).run='true';},
    x => {x.jobs.prep.steps.find(s=>s.with?.name==='winner-evidence-prep').with.path='bench-evidence/*';},
  ];
  for (const mutate of mutations) { const changed=structuredClone(w); mutate(changed); assert.throws(()=>validateWorkflow(changed)); }
});
