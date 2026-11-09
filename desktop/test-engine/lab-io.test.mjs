import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writePrivateJson} from './lab-io.mjs';
test('predictable temporary symlinks cannot redirect result writes; every replacement is private',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-result-'));
 try{
  const file=path.join(root,'result.json'),outside=path.join(root,'outside');
  fs.writeFileSync(outside,'keep');fs.symlinkSync(outside,file+'.tmp');
  fs.writeFileSync(file,'old',{mode:0o666});fs.chmodSync(file,0o666);
  writePrivateJson(file,{ok:true});
  assert.equal(fs.readFileSync(outside,'utf8'),'keep');
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{ok:true});
  assert.equal(fs.statSync(file).mode&0o777,0o600);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
