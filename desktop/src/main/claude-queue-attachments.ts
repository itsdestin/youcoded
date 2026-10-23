import { promises as fs, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { uploadDir } from './upload-store';
/** Preserve the app's expiring clipboard/uploads. Ordinary project paths retain their editing targets. */
export async function retainQueueAttachments(userDataRoot: string, queueId: string, paths: string[], clipboardRoot = path.join(os.tmpdir(),'claude-desktop-attachments'), uploadsRoot = uploadDir()): Promise<string[]> {
 if(!/^[a-f0-9-]{36}$/i.test(queueId))throw Error('Invalid queue attachment identity');
 const clipboard = clipboardRoot; const retained: string[] = [],created:string[]=[];
 try {for(const original of paths){
  const ownedPaste=path.dirname(original)===clipboard&&/^paste-[0-9]+\.png$/.test(path.basename(original));
  const ownedUpload=path.dirname(original)===uploadsRoot;
  if(!ownedPaste&&!ownedUpload){retained.push(original);continue;}
  const directory=path.join(userDataRoot,'queue-files',queueId);// WHY keep the original name after the hash (2026-10-22): other screens and a reloaded chat show this path as the file chip.
  const ext=path.extname(original).match(/^\.[a-zA-Z0-9]{1,12}$/)?.[0]??'.bin';const shown=path.basename(original,path.extname(original)).replace(/[^A-Za-z0-9._-]/g,'_').slice(0,64)||'file';
  const target=path.join(directory,createHash('sha256').update(original).digest('hex').slice(0,32)+'-'+shown+ext);
  try{const old=await fs.stat(target);if(old.isFile()&&old.size<=32*1024*1024){retained.push(target);continue;}}catch{/* first preservation */}
  const stat=await fs.stat(original);if(!stat.isFile()||stat.size>32*1024*1024)throw Error('Queued clipboard image is too large or unavailable.');
  // WHY link a private completed copy: concurrent captures keep the first immutable file, never replace it.
  await fs.mkdir(directory,{recursive:true,mode:0o700});const temporary=`${target}.${process.pid}.${randomUUID()}.tmp`;
  try{await fs.copyFile(original,temporary,constants.COPYFILE_EXCL);const copied=await fs.stat(temporary);if(copied.size>32*1024*1024)throw Error('Queued clipboard image exceeds limits.');try{await fs.link(temporary,target);created.push(target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
  finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
  retained.push(target);
 }
 return retained;
 }catch(error){
  // Only this capture's unpublished files; never delete reused/accepted shared attachments.
  await Promise.all(created.map(file=>fs.rm(file,{force:true}).catch(()=>{})));throw error;
 }
}
