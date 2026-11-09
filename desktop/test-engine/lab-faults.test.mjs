import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createReadMutation,applyFixtureChange} from './lab-faults.mjs';

test('partial mutation writes attempt rollback and explicitly report failed restoration',()=>{
 for(const failRollback of [false,true]){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-write-failure-')),file=path.join(root,'note.txt');
  const originalWrite=fs.writeSync;fs.writeFileSync(file,'original');let calls=0;
  try{
   fs.writeSync=(fd,buffer,offset,length,position)=>{
    calls++;if(calls===1)return originalWrite(fd,buffer,offset,1,position);
    if(calls===2||failRollback)throw new Error('simulated disk failure');
    return originalWrite(fd,buffer,offset,length,position);
   };
   assert.throws(()=>applyFixtureChange(root,{file:'note.txt',expectedBefore:'original',replacement:'replacement'}),error=>{
    assert.equal(error.evidence.applied,false);assert.equal(error.evidence.rollbackAttempted,true);
    assert.equal(error.evidence.restorationVerified,!failRollback);return true;
   });
   if(!failRollback)assert.equal(fs.readFileSync(file,'utf8'),'original');
  }finally{fs.writeSync=originalWrite;fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('rollback refuses an intervening write whose bytes are not the controller partial state',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-write-conflict-')),file=path.join(root,'note.txt');
 const originalWrite=fs.writeSync;fs.writeFileSync(file,'original');let calls=0;
 try{
  fs.writeSync=(fd,buffer,offset,length,position)=>{calls++;if(calls===1)return originalWrite(fd,buffer,offset,1,position);const other=Buffer.from('other user edit');originalWrite(fd,other,0,other.length,0);fs.ftruncateSync(fd,other.length);throw new Error('simulated failure after external change');};
  assert.throws(()=>applyFixtureChange(root,{file:'note.txt',expectedBefore:'original',replacement:'replacement'}),error=>{assert.equal(error.evidence.rollbackAttempted,false);assert.equal(error.evidence.restorationVerified,false);return true;});
  assert.equal(fs.readFileSync(file,'utf8'),'other user edit');
 }finally{fs.writeSync=originalWrite;fs.rmSync(root,{recursive:true,force:true});}
});

test('external fixture change occurs once after successful matching Read, never before',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-race-'));
 try{
  const file=path.join(root,'note.txt');fs.writeFileSync(file,'old');
  const mutation=createReadMutation(root,{file:'note.txt',expectedBefore:'old',replacement:'user-new'});
  mutation.observe({type:'tool-use',data:{toolUseId:'r',toolName:'Read',toolInput:{file_path:file}}});
  assert.equal(fs.readFileSync(file,'utf8'),'old');
  mutation.observe({type:'tool-result',data:{toolUseId:'r',isError:false}});
  assert.equal(fs.readFileSync(file,'utf8'),'user-new');assert.equal(mutation.evidence().applied,true);
  mutation.observe({type:'tool-result',data:{toolUseId:'r',isError:false}});
  assert.equal(mutation.evidence().applications,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('mutation writes through a pinned descriptor even when the pathname is swapped after read',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-race-'));
 const outside=path.join(os.tmpdir(),`yc-outside-${process.pid}-${Date.now()}`);
 const file=path.join(root,'note.txt');fs.writeFileSync(file,'old');fs.writeFileSync(outside,'outside');
 const originalRead=fs.readFileSync;let swapped=false;
 try{
  const mutation=createReadMutation(root,{file:'note.txt',expectedBefore:'old',replacement:'new'});
  mutation.observe({type:'tool-use',data:{toolUseId:'r',toolName:'Read',toolInput:{file_path:file}}});
  fs.readFileSync=(target,...args)=>{
   const result=originalRead(target,...args);
   if(typeof target==='number'&&!swapped){swapped=true;fs.unlinkSync(file);fs.symlinkSync(outside,file);}
   return result;
  };
  mutation.observe({type:'tool-result',data:{toolUseId:'r',isError:false}});
  assert.equal(swapped,true,'mutation must use a descriptor');
  assert.equal(originalRead(outside,'utf8'),'outside');
 }finally{fs.readFileSync=originalRead;fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{force:true});}
});

test('refuses escaping paths/symlinks and never overwrites unexpected file content',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-race-'));
 try{
  assert.throws(()=>createReadMutation(root,{file:'../outside',expectedBefore:'old',replacement:'new'}),/fixture/i);
  const file=path.join(root,'note.txt');fs.writeFileSync(file,'different');
  const mutation=createReadMutation(root,{file:'note.txt',expectedBefore:'old',replacement:'new'});
  mutation.observe({type:'tool-use',data:{toolUseId:'r',toolName:'Read',toolInput:{file_path:file}}});
  assert.throws(()=>mutation.observe({type:'tool-result',data:{toolUseId:'r',isError:false}}),/changed/i);
  assert.equal(fs.readFileSync(file,'utf8'),'different');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
