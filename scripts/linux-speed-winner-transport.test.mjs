import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {manifest} from './linux-build-bench.mjs';
import {compressPrepared,verifyStream} from './linux-speed-winner-transport.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
test('real zstd -1 -T0 transport preserves exact TAR bytes and GNU tar -xpf autodetect/modes/binary/links',async()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winner-transport-'));
  try {
    const app=path.join(dir,'linux-unpacked');fs.mkdirSync(app);
    fs.writeFileSync(path.join(app,'binary file'),Buffer.from([0,255,1,128,10]));
    fs.writeFileSync(path.join(app,'executable'),'#!/bin/sh\necho fixture\n',{mode:0o751});
    fs.symlinkSync('binary file',path.join(app,'symbolic link'));
    const expected=manifest(app);
    const archive=path.join(dir,'prepared.tar');execFileSync('tar',['-cf',archive,'-C',dir,'linux-unpacked']);
    const raw=fs.readFileSync(archive);const original={bytes:raw.length,sha256:hash(raw),transport:'original uncompressed tar'};
    fs.writeFileSync(path.join(dir,'archive-info.json'),JSON.stringify(original));
    const info=await compressPrepared(dir);
    assert.equal(info.original.sha256,hash(raw));assert.equal(info.original.bytes,raw.length);
    assert.deepEqual(fs.readFileSync(path.join(dir,'prepared.raw.tar')),raw);
    assert.equal(info.sha256,hash(fs.readFileSync(archive)));assert.equal(info.bytes,fs.statSync(archive).size);
    console.log('Tiny fixture transport only:',JSON.stringify({rawBytes:raw.length,compressedBytes:info.bytes,ratio:info.ratio}));
    assert.equal(info.ratio,info.bytes/raw.length);assert.equal(info.decompressedSha256,hash(raw));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'archive-info.json'))),info);
    await verifyStream(archive,original.sha256,original.bytes);
    await assert.rejects(verifyStream(archive,'0'.repeat(64),original.bytes));
    await assert.rejects(verifyStream(archive,original.sha256,original.bytes+1));
    const out=path.join(dir,'restored');fs.mkdirSync(out);
    // Exact unchanged packageVariant restore command: no extension hint or -I.
    execFileSync('tar',['-xpf',archive,'-C',out]);
    assert.deepEqual(manifest(path.join(out,'linux-unpacked')),expected);
    for(const name of ['transport-compress','transport-proof']) {const metric=JSON.parse(fs.readFileSync(path.join(dir,name+'.json')));assert.equal(metric.exitCode,0);assert.ok(metric.wallSeconds>=0);assert.ok(metric.userSeconds>=0);}
    await assert.rejects(compressPrepared(dir));
    const corrupt=path.join(dir,'corrupt.tar');fs.writeFileSync(corrupt,'not a zstd stream');
    await assert.rejects(verifyStream(corrupt,original.sha256,original.bytes));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('bad original receipt fails before replacing raw tar or archive-info',async()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winner-transport-fail-'));
  try {
    fs.writeFileSync(path.join(dir,'prepared.tar'),'original');
    const receipt=JSON.stringify({bytes:8,sha256:'0'.repeat(64)});fs.writeFileSync(path.join(dir,'archive-info.json'),receipt);
    await assert.rejects(compressPrepared(dir));
    assert.equal(fs.readFileSync(path.join(dir,'prepared.tar'),'utf8'),'original');
    assert.equal(fs.readFileSync(path.join(dir,'archive-info.json'),'utf8'),receipt);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
