// EXPERIMENT ONLY: transport encoding, never application/installer inputs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stage} from './linux-build-bench.mjs';
const self=fileURLToPath(import.meta.url);
const root=fileURLToPath(new URL('../',import.meta.url));
const evidence=path.resolve(process.env.BENCH_EVIDENCE || path.join(root,'bench-evidence'));
async function fileHash(file) {
  const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file)) hash.update(chunk);return hash.digest('hex');
}
export async function verifyStream(file,expectedHash,expectedBytes) {
  assert.match(expectedHash,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(expectedBytes)&&expectedBytes>0);
  const hash=createHash('sha256');let bytes=0;
  const child=spawn('zstd',['-d','-c','--',file],{stdio:['ignore','pipe','inherit']});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>code===0&&!signal?resolve():reject(new Error('Transport decompression failed')));});
  // WHY stream: prepared Office/Electron TAR exceeds safe single-buffer sizes.
  const stream=(async()=>{for await(const chunk of child.stdout){hash.update(chunk);bytes+=chunk.length;}})();
  await Promise.all([done,stream]);
  assert.equal(bytes,expectedBytes,'Decompressed TAR size mismatch');assert.equal(hash.digest('hex'),expectedHash,'Decompressed TAR hash mismatch');
}
export async function compressPrepared(directory=evidence) {
  const archive=path.join(directory,'prepared.tar'),receipt=path.join(directory,'archive-info.json');
  const original=JSON.parse(fs.readFileSync(receipt));
  assert.equal(fs.statSync(archive).size,original.bytes);assert.equal(await fileHash(archive),original.sha256,'Original TAR receipt mismatch');
  const raw=path.join(directory,'prepared.raw.tar');assert.ok(!fs.existsSync(raw),'Refuse to overwrite retained original TAR');
  const temporary=path.join(directory,'prepared.zstd.tmp');assert.ok(!fs.existsSync(temporary),'Refuse to overwrite compression output');
  const infoTemporary=path.join(directory,'archive-info.json.tmp');assert.ok(!fs.existsSync(infoTemporary));
  try {
    await stage('transport-compress','zstd',['-1','-T0','--keep','-o',temporary,'--',archive],{evidence:directory});
    await stage('transport-proof',process.execPath,[self,'verify-stream',temporary,original.sha256,String(original.bytes)],{evidence:directory});
    const bytes=fs.statSync(temporary).size;
    const info={bytes,sha256:await fileHash(temporary),transport:'zstd -1 -T0; exact original TAR bytes verified; GNU tar -xpf autodetect; upload compression-level 0',original,ratio:bytes/original.bytes,decompressedSha256:original.sha256};
    fs.writeFileSync(infoTemporary,JSON.stringify(info,null,2)+'\n');
    // WHY retain original privately and rename atomically only AFTER full proof.
    // No partial compressed stream can masquerade as the prepared transport.
    fs.renameSync(archive,raw);fs.renameSync(temporary,archive);fs.renameSync(infoTemporary,receipt);
    return info;
  }finally{fs.rmSync(temporary,{force:true});fs.rmSync(infoTemporary,{force:true});}
}
async function main() {
  const [command,...args]=process.argv.slice(2);
  if(command==='prepare') {
    assert.equal(args.length,0);
    // Existing preflight remains its own unchanged required workflow step.
    await stage('preparation-original',process.execPath,[path.join(root,'scripts/linux-build-bench.mjs'),'prepare']);
    await compressPrepared();
  }else if(command==='verify-stream') {
    assert.equal(args.length,3);await verifyStream(args[0],args[1],Number(args[2]));
  }else throw new Error('Use prepare | verify-stream <archive> <sha256> <bytes>');
}
if(process.argv[1]&&path.resolve(process.argv[1])===self) main().catch(error=>{console.error(error);process.exitCode=1;});
