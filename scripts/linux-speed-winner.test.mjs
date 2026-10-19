import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprint } from './linux-build-bench.mjs';
import { createRequire } from 'node:module';
import { verifyRun, verifyArtifact, verifyContents, verifyCaseUnion, verifyPackages, validateWorkflow, fetchReceipts, loadReceipts, validateSource, validateNeeds, verifyFiles, pins, control, winners } from './linux-speed-winner.mjs';
const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const YAML = require('yaml');
const run = () => ({ id: control.run, head_sha: control.sha, head_branch: control.branch, path: control.path, workflow_id: control.workflow, event: 'pull_request', status: 'completed', conclusion: 'success', repository: {id: control.repositoryId, full_name: control.repository}, head_repository: {id:control.repositoryId,full_name:control.repository}, run_attempt:1 });
const artifact = name => ({id:pins[name].id,name,digest:pins[name].digest,expired:false,expires_at:'2099-01-01T00:00:00Z',workflow_run:{id:control.run,head_sha:control.sha,head_branch:control.branch,repository_id:control.repositoryId,head_repository_id:control.repositoryId}});

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
function packageRecord(id) {
  const rpm=id.startsWith('rpm-');
  const original={'requires':id.endsWith('default')?'rpmlib(PayloadIsXz) <= 5.2-1\n':'','flags-REQUIRE':id.endsWith('default')?'rpmlib(PayloadIsXz)\t16777226\t5.2-1\n':''};
  // Removing the exact xz line leaves a trailing newline in the real harness.
  for (const key of Object.keys(original)) original[key]='application-dependency\n'+original[key];
  return {info:{id,fingerprint:digest,bytes:42},metric:{exitCode:0},payload:{payload:[{path:'application',sha256:sha('same application')}],metadata:rpm?Object.keys(original).map(key=>({path:key,sha256:sha('application-dependency\n')})):[{path:'control',sha256:sha('same control')}]},...(rpm?{capability:{compressor:id.endsWith('fast')?'gzip':'xz',original}}:{})};
}
function packageFixture() {
  const records=winners.map(packageRecord);
  const receipts=Object.fromEntries(['deb','rpm','pacman'].map(target=> {
    const r=packageRecord(`${target}-default`);
    return [`evidence-${target}-default`,{'fingerprint.json':{digest},'package-info.json':r.info,'package.json':r.metric,'payload.json':r.payload,...(r.capability?{'rpm-compression-capability.json':r.capability}:{})}];
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
    x => {x.jobs.inventory.needs='prep';}, x => {x.jobs.prep.steps.find(s=>s.run?.includes('typecheck')).run='true';},
    x => {x.jobs.inventory.steps.find(s=>s.run?.includes('receipt')).run+=' && node scripts/linux-build-bench.mjs discover';},
    x => {x.jobs.packages.steps.find(s=>s.run?.includes('package-total')).run+=' --publish always';},
    x => {x.jobs.gate.needs.pop();}, x => {x.jobs.shards.steps.find(s=>s.run?.includes('shard-total')).run+=' --testNamePattern=fast';},
    x => {x.jobs.prep.steps[0].with['persist-credentials']=true;},
  ];
  for (const mutate of mutations) { const changed=structuredClone(w); mutate(changed); assert.throws(()=>validateWorkflow(changed)); }
});
