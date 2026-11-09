import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function writePrivateJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=path.join(path.dirname(file),`.yc-result-${randomUUID()}.tmp`);
  let fd;
  try{
    // Exclusive random file: never follow a preplanted predictable .tmp symlink.
    fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,file);
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
