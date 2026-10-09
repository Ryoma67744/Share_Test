'use strict';
// One test inventory for developer machines, CI, and release builds.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const files=fs.readdirSync(path.join(root,'tests')).filter(f=>/_regression\.(?:js|cjs)$/.test(f)).sort();
const tasks=files.map(f=>({name:'tests/'+f,args:[path.join(root,'tests',f)],cwd:root}));
tasks.push({name:'connector selftest',args:[path.join(root,'connector/src/selftest.js')],cwd:path.join(root,'connector')});
let failed=0;
for(const task of tasks) {
  console.log('\nRunning '+task.name);
  const result=spawnSync(process.execPath,task.args,{cwd:task.cwd,stdio:'inherit',windowsHide:true});
  if(result.error || result.status!==0) {failed++;console.error('FAIL '+task.name+(result.error?': '+result.error.message:''));}
  else console.log('PASS '+task.name);
}
console.log('\nResult: '+(tasks.length-failed)+'/'+tasks.length+' passed.');
process.exitCode=failed?1:0;
