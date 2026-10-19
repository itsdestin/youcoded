// EXPERIMENT ONLY: frozen-source receipt reuse is NOT a production test cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fingerprint, compare, aggregateShards, aggregatePackages, stage } from './linux-build-bench.mjs';
import { workflow } from './linux-speed-winner-workflow.mjs';
const root = fileURLToPath(new URL('../',import.meta.url));
const evidence = path.resolve(process.env.BENCH_EVIDENCE || path.join(root,'bench-evidence'));
const read = p => JSON.parse(fs.readFileSync(p,'utf8'));
const write = (p,v) => { fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n'); };
const hash = b => createHash('sha256').update(b).digest('hex');
export const pins = read(new URL('./linux-speed-winner-pins.json',import.meta.url));
export const winners = ['AppImage-default','deb-fast','rpm-fast','pacman-fast'];
export const control = { repository:'itsdestin/youcoded', repositoryId:1183460513, run:39187420940, sha:'b9b5d064803cadcb57ce4f37f7b43f861989f856', branch:'session/29-linux-build-bench', path:'.github/workflows/linux-speed-benchmark.yml', workflow:388854109, digest:'3d60325827e6e335d0e0a7e089cb89979aa6dcafee062e798df4986fa7e49b89' };

export function verifyRun(r) {
  for (const [key,value] of Object.entries({id:control.run,head_sha:control.sha,head_branch:control.branch,path:control.path,workflow_id:control.workflow,event:'pull_request',status:'completed',conclusion:'success',run_attempt:1})) assert.equal(r[key],value,`Uncertified control run: ${key}`);
  for (const key of ['repository','head_repository']) { assert.equal(r[key]?.id,control.repositoryId); assert.equal(r[key]?.full_name,control.repository); }
}
export function verifyArtifact(name,a,now=Date.now()) {
  const p = pins[name]; assert.ok(p,'Unknown receipt');
  for (const [key,value] of Object.entries({id:p.id,name,digest:p.digest,expired:false})) assert.equal(a[key],value,`Uncertified artifact: ${key}`);
  assert.ok(Date.parse(a.expires_at)>now,'Certified artifact expired/missing expiry');
  for (const [key,value] of Object.entries({id:control.run,head_sha:control.sha,head_branch:control.branch,repository_id:control.repositoryId,head_repository_id:control.repositoryId})) assert.equal(a.workflow_run?.[key],value,`Uncertified artifact source: ${key}`);
}
export function verifyContents(name,files) {
  compare(Object.keys(pins[name].files).sort(),Object.keys(files).sort());
  for (const [file,digest] of Object.entries(pins[name].files)) assert.equal(hash(files[file]),digest,`Certified content hash mismatch: ${name}/${file}`);
  return Object.fromEntries(Object.entries(files).map(([file,bytes])=>[file,JSON.parse(bytes.toString())]));
}
export function verifyFiles(expected,raw) {
  const files=raw.map(x=> {
    const file=x.file.replaceAll('\\','/').split('/desktop/').at(-1).replace(/^\.\//,'');
    assert.ok(!file.split('/').includes('..'),'Discovery path escaped production roots');
    assert.match(file,/^(?:tests|src)\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/);
    return file;
  });
  assert.ok(files.length); assert.equal(files.length,new Set(files).size,'Duplicate discovery files');
  compare([...expected].sort(),[...files].sort());
  return files;
}
export function verifyCaseUnion(expected,actual) {
  // WHY compare all identities AND statuses: runnable-only discovery cannot prove
  // that the original pending cases survived, or detect an extra runtime skip.
  const canonical = cases => cases.map(c=> { assert.ok(['passed','pending','skipped','todo'].includes(c.status)); return JSON.stringify([c.file,c.name,c.status]); }).sort();
  compare(canonical(expected),canonical(actual));
}
function record(files) {
  return {info:files['package-info.json'],metric:files['package.json'],payload:files['payload.json'],...(files['rpm-compression-capability.json'] ? {capability:files['rpm-compression-capability.json']} : {})};
}
export function verifyPackages(records,receipts,digest) {
  compare(winners,[...records].sort((a,b)=>winners.indexOf(a.info.id)-winners.indexOf(b.info.id)).map(r=>r.info.id));
  const defaults = ['deb','rpm','pacman'].map(target=> {
    const files = receipts[`evidence-${target}-default`]; assert.ok(files,`Missing certified ${target} default`);
    assert.equal(files['fingerprint.json'].digest,digest);
    assert.equal(files['package-info.json'].id,`${target}-default`);
    return record(files);
  });
  // Original comparator remains unchanged: all seven logical records, all
  // manifests and the exact version/flag RPM exception are still required.
  aggregatePackages([...records,...defaults],digest);
  return records.map(r=>r.info);
}
export function validateWorkflow(w) { compare(workflow(),w); }
async function api(suffix,binary=false) {
  assert.ok(process.env.GITHUB_TOKEN,'Read-only GitHub token required');
  const r = await fetch(`https://api.github.com/repos/${control.repository}/${suffix}`,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'X-GitHub-Api-Version':'2022-11-28'}});
  assert.ok(r.ok,`Certified receipt API failed (${r.status}): ${suffix}; expired artifacts must not fall back`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.json();
}
export async function fetchReceipts(directory,{request=api,now=Date.now()}={}) {
  const run = await request(`actions/runs/${control.run}`); verifyRun(run);
  const metadata = {};
  await Promise.all(Object.entries(pins).map(async ([name,p])=> {
    const a = await request(`actions/artifacts/${p.id}`); verifyArtifact(name,a,now); metadata[name]=a;
    const zip = await request(`actions/artifacts/${p.id}/zip`,true);
    assert.equal(`sha256:${hash(zip)}`,p.digest,`Artifact archive hash mismatch: ${name}`);
    const archive = path.join(directory,`${p.id}.zip`); fs.mkdirSync(directory,{recursive:true}); fs.writeFileSync(archive,zip);
    try {
      // WHY no archive extraction: read only fixed pinned filenames, rejecting
      // duplicates/path aliases; zip traversal or symlinks cannot write files.
      const entries=execFileSync('unzip',['-Z1',archive],{encoding:'utf8'}).trim().split('\n');
      assert.equal(new Set(entries).size,entries.length,'Duplicate archive paths');
      assert.ok(entries.every(e=>!e.startsWith('/') && !e.split('/').includes('..')),'Unsafe artifact path');
      const files=Object.fromEntries(Object.keys(p.files).map(file=> { assert.equal(entries.filter(e=>e===file).length,1,`Missing receipt path: ${file}`); return [file,execFileSync('unzip',['-p',archive,file],{maxBuffer:32*1024*1024})]; }));
      verifyContents(name,files);
      for (const [file,bytes] of Object.entries(files)) { const out=path.join(directory,name,file); fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,bytes); }
    } finally { fs.rmSync(archive,{force:true}); }
  }));
  write(path.join(directory,'provenance.json'),{run,artifacts:metadata,verifiedAt:new Date(now).toISOString()});
}
export function loadReceipts(directory,now=Date.now()) {
  const provenance=read(path.join(directory,'provenance.json')); verifyRun(provenance.run);
  compare(Object.keys(pins).sort(),Object.keys(provenance.artifacts).sort());
  const receipts={};
  for (const name of Object.keys(pins)) {
    verifyArtifact(name,provenance.artifacts[name],now);
    receipts[name]=verifyContents(name,Object.fromEntries(Object.keys(pins[name].files).map(f=>[f,fs.readFileSync(path.join(directory,name,f))])));
  }
  return receipts;
}
export function validateSource(receipts,current=fingerprint()) {
  const original=receipts['evidence-inventory']['fingerprint.json'];
  assert.equal(current.digest,control.digest); compare(original.inputs,current.inputs); assert.equal(original.baseline,current.baseline); assert.equal(original.digest,current.digest);
  const summary=receipts['diagnostic-linux-summary']['summary.json'];
  compare(summary.fingerprint,original);
  assert.equal(summary.tests.files,1167); assert.equal(summary.tests.passed,20412); assert.equal(summary.tests.skipped,80); assert.equal(summary.tests.todo,0); assert.equal(summary.tests.failed,0);
  assert.equal(summary.tests.cases.length,20492);
  for (const target of ['deb','rpm','pacman']) {
    const files=receipts[`evidence-${target}-default`]; compare(files['fingerprint.json'],original);
    compare(summary.packages.find(p=>p.id===`${target}-default`),files['package-info.json']);
  }
  return summary;
}
async function receipt() {
  const dir=path.join(evidence,'certified');
  await fetchReceipts(dir);
  const receipts=loadReceipts(dir); validateSource(receipts);
  // Files-only Vitest discovery uses ordinary production config, without importing
  // the full suite. The certified runnable inventory is checked by ALL four runs.
  const raw=path.join(evidence,'fresh-files.json');
  await stage('discover-files',process.execPath,[path.join(root,'desktop/node_modules/vitest/vitest.mjs'),'list','--filesOnly',`--json=${raw}`]);
  const files=verifyFiles(receipts['evidence-inventory']['expected-files.json'],read(raw));
  assert.equal(files.length,1167);
  write(path.join(evidence,'receipt-verified.json'),{fingerprint:fingerprint(),files:files.length,control,verified:true});
}
export function validateNeeds(needs) {
  compare(['inventory','packages','prep','shards'],Object.keys(needs).sort());
  for (const [name,v] of Object.entries(needs)) assert.equal(v?.result,'success',`Failed/missing job: ${name}`);
}
function aggregate() {
  validateNeeds(JSON.parse(process.env.BENCH_NEEDS || '{}'));
  const results=path.join(root,'results');
  compare(['winner-evidence-AppImage-default','winner-evidence-deb-fast','winner-evidence-inventory','winner-evidence-pacman-fast','winner-evidence-prep','winner-evidence-rpm-fast',...[1,2,3,4].map(n=>`winner-evidence-shard-${n}`)].sort(),fs.readdirSync(results).sort());
  const inventory=path.join(results,'winner-evidence-inventory');
  const receipts=loadReceipts(path.join(inventory,'certified')); const current=fingerprint(); const original=validateSource(receipts,current);
  verifyFiles(receipts['evidence-inventory']['expected-files.json'],read(path.join(inventory,'fresh-files.json')));
  const verified=read(path.join(inventory,'receipt-verified.json')); assert.equal(verified.verified,true); assert.equal(verified.files,1167); compare(verified.control,control); compare(verified.fingerprint,current);
  const checkFingerprint=dir=>compare(current,read(path.join(dir,'fingerprint.json')));
  checkFingerprint(path.join(results,'winner-evidence-prep'));
  const shards=[1,2,3,4].map(n=> {const dir=path.join(results,`winner-evidence-shard-${n}`); checkFingerprint(dir); return read(path.join(dir,'shard.json'));});
  const tests=aggregateShards(receipts['evidence-inventory']['expected-files.json'],shards,current.digest,receipts['evidence-inventory']['expected-cases.json']);
  verifyCaseUnion(original.tests.cases,tests.cases);
  const records=winners.map(id=> { const dir=path.join(results,`winner-evidence-${id}`); checkFingerprint(dir); const r=record(Object.fromEntries(['package-info.json','package.json','payload.json',...(id.startsWith('rpm-')?['rpm-compression-capability.json']:[])].map(f=>[f,read(path.join(dir,f))]))); assert.equal(r.info.id,id); return r; });
  const packages=verifyPackages(records,receipts,current.digest);
  const timeline=read(path.join(evidence,'github-jobs.json')); assert.equal(timeline.total_count,timeline.jobs.length); assert.ok(timeline.jobs.length);
  write(path.join(evidence,'summary.json'),{fingerprint:current,control,tests,packages,timeline,limits:original.limits,timing:'Winner workflow only. Parent must record COMPLETED run/job timestamps including queue/setup/transfer/gate teardown; ordinary production CI is separate. No five-minute claim before that measurement.'});
}
async function main() {
  const [command,...args]=process.argv.slice(2); assert.equal(args.length,0);
  if(command==='receipt') await receipt(); else if(command==='aggregate') aggregate(); else throw new Error('Use receipt | aggregate');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=> {write(path.join(evidence,'winner-failure.json'),{message:error.message,stack:error.stack}); console.error(error); process.exitCode=1;});
