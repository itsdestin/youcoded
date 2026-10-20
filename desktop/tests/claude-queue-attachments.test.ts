import { describe,it,expect } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,readdir } from 'node:fs/promises';
import { join } from 'node:path';import { tmpdir } from 'node:os';import { randomUUID } from 'node:crypto';
import { retainQueueAttachments } from '../src/main/claude-queue-attachments';
describe('durable queued clipboard files',()=>{
 it('cleans only newly unpublished copies if a later source is missing, retaining shared accepted files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'queue-files-'));try{
   const clipboard=join(root,'clipboard');await mkdir(clipboard);const a=join(clipboard,'paste-1.png'),b=join(clipboard,'paste-2.png'),missing=join(clipboard,'paste-3.png');await writeFile(a,'accepted');await writeFile(b,'new');const id=randomUUID();
   const accepted=await retainQueueAttachments(root,id,[a],clipboard);
   await expect(retainQueueAttachments(root,id,[a,b,missing],clipboard)).rejects.toThrow();
   expect(await readFile(accepted[0],'utf8')).toBe('accepted');expect(await readdir(join(root,'queue-files',id))).toHaveLength(1);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5});}
 });
 it('retains the app-owned expiring paste across source removal, without redirecting project edit targets',async()=>{
  const root=await mkdtemp(join(tmpdir(),'queue-files-'));
  try{const clipboard=join(root,'clipboard');await mkdir(clipboard);const paste=join(clipboard,'paste-123.png'),project=join(root,'project.png');await writeFile(paste,'clipboard-image');await writeFile(project,'project-image');const id=randomUUID();
   const [a,b]=await Promise.all([retainQueueAttachments(root,id,[paste,project],clipboard),retainQueueAttachments(root,id,[paste,project],clipboard)]);
   expect(a).toEqual(b);expect(a[1]).toBe(project);expect(a[0]).not.toBe(paste);await rm(paste);
   expect(await readFile(a[0],'utf8')).toBe('clipboard-image');expect(await retainQueueAttachments(root,id,[paste,project],clipboard)).toEqual(a);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5});}
 });
});
