import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const digest=text=>createHash('sha256').update(text).digest('hex');

export function validateFixtureChange(config){
 if(!config||typeof config.file!=='string'||!config.file||['.','..'].includes(config.file)||/[\/\\\x00]/.test(config.file)||Buffer.byteLength(config.file)>255)throw new Error('Mutation requires a flat relative fixture path');
 for(const field of ['expectedBefore','replacement'])if(typeof config[field]!=='string'||Buffer.byteLength(config[field])>1024*1024)throw new Error('Mutation requires bounded exact text contents');
}

export function applyFixtureChange(root,config){
 validateFixtureChange(config);
 if(process.platform!=='linux')throw new Error('Controller mutation requires Linux descriptor-relative fixture access');
 const base=fs.realpathSync(root),before=Buffer.from(config.expectedBefore),after=Buffer.from(config.replacement);
 const dir=fs.openSync(base,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);let fd;
 try{
  fd=fs.openSync(`/proc/self/fd/${dir}/${config.file}`,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1)throw new Error('Fixture mutation refuses nonregular or hardlinked files');
  if(stat.size!==before.length||!fs.readFileSync(fd).equals(before))throw new Error('Fixture changed unexpectedly before scheduled mutation; refusing overwrite');
  // WHY: keep writes and any recovery on the verified inode. Recovery is best-effort,
  // never atomic, and refuses bytes that no longer match our tracked partial write.
  let known=Buffer.from(before);
  const matches=bytes=>{
   if(fs.fstatSync(fd).size!==bytes.length)return false;
   const actual=Buffer.alloc(bytes.length);let offset=0;
   while(offset<actual.length){const n=fs.readSync(fd,actual,offset,actual.length-offset,offset);if(!n)return false;offset+=n;}
   return actual.equals(bytes);
  };
  const writeAll=(bytes,track)=>{
   let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw new Error('Incomplete controller write');
    if(track){if(known.length<offset+n)known=Buffer.concat([known,Buffer.alloc(offset+n-known.length)]);bytes.copy(known,offset,offset,offset+n);}
    offset+=n;
   }
  };
  try{
   writeAll(after,true);fs.ftruncateSync(fd,after.length);known=Buffer.from(after);fs.fsyncSync(fd);
   if(!matches(after))throw new Error('Controller write verification failed');
  }catch{
   let rollbackAttempted=false,restorationVerified=false;
   try{if(matches(known)){rollbackAttempted=true;writeAll(before,false);fs.ftruncateSync(fd,before.length);fs.fsyncSync(fd);restorationVerified=matches(before);}}catch{/* Preserve an explicit unverified restoration outcome. */}
   throw Object.assign(new Error('Controller mutation write failed'),{evidence:{kind:'external-change-between-turns',file:config.file,controllerOwned:true,applied:false,applications:0,writeFailed:true,rollbackAttempted,restorationVerified,restorationScope:'original-pinned-inode',beforeHash:digest(before),afterHash:digest(after),atMs:Date.now()}});
  }
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.closeSync(dir);}
 return {kind:'external-change-between-turns',file:config.file,applied:true,applications:1,controllerOwned:true,beforeHash:digest(before),afterHash:digest(after),atMs:Date.now()};
}

/** Deterministic external change in a declared fixture, synchronized to successful native Read. */
export function createReadMutation(root,config){
  if(process.platform!=='linux')throw new Error('Synchronized mutation currently requires Linux descriptor-relative fixture access');
  const base=fs.realpathSync(root);
  if(!config||typeof config.file!=='string'||!config.file||path.isAbsolute(config.file)
    ||config.file.includes('/')||config.file.includes('\\')||config.file==='..'||typeof config.expectedBefore!=='string'||typeof config.replacement!=='string')
    throw new Error('Mutation requires a relative fixture path and exact before/after contents');
  const file=path.resolve(base,config.file);
  function checkPath(){
    const actual=fs.realpathSync(file),relative=path.relative(base,actual);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||actual!==file)
      throw new Error('Mutation path escapes fixture or traverses a symlink');
  }
  checkPath();
  const reads=new Set();
  const evidence={kind:'external-change-after-read',file:config.file,applied:false,applications:0,
    beforeHash:digest(config.expectedBefore),afterHash:digest(config.replacement),triggerToolUseId:null};
  return {
    observe(event){
      if(evidence.applied)return;
      const d=event.data??{};
      if(d.agentId||d.parentAgentToolUseId)return;
      if(event.type==='tool-use'&&d.toolName==='Read'&&typeof d.toolInput?.file_path==='string'
        &&path.resolve(base,d.toolInput.file_path)===file) reads.add(d.toolUseId);
      if(event.type!=='tool-result'||!reads.has(d.toolUseId)||d.isError!==false)return;
      checkPath();
      applyFixtureChange(base,config);
      Object.assign(evidence,{applied:true,applications:1,triggerToolUseId:d.toolUseId,atMs:Date.now()});
    },
    evidence(){return {...evidence};},
  };
}
