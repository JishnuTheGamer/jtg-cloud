import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
let count = 0;
async function check(folder) {
  for (const entry of await readdir(folder,{withFileTypes:true})) {
    const filename=path.join(folder,entry.name);
    if(entry.isDirectory())await check(filename);
    else if(/\.(mjs|cjs|js)$/.test(filename)) {
      const result=spawnSync(process.execPath,['--check',filename],{stdio:'inherit'});
      if(result.status!==0)process.exit(result.status||1);count++;
    }
  }
}
for(const folder of ['src','public','scripts','tests'])await check(folder);
const result=spawnSync(process.execPath,['--check','ecosystem.config.cjs'],{stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
console.log(`${count+1} JavaScript files passed syntax checks.`);
