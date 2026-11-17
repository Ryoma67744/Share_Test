'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{spawnSync}=require('node:child_process');
if(!process.argv.includes('--gc-child')){
  const result=spawnSync(process.execPath,['--expose-gc',__filename,'--gc-child'],{encoding:'utf8',windowsHide:true});
  if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
  assert.equal(result.status,0,'isolated GC regression passed');
}else{
  (async()=>{
    let source=fs.readFileSync(path.join(__dirname,'../app-i18n.js'),'utf8');
    source=source.replace('global.AppI18n = Object.freeze({','global.__bindingCount=()=>bindings.size; global.AppI18n = Object.freeze({');
    const context=vm.createContext({});vm.runInContext(source,context);
    const api=context.AppI18n,weakNodes=[],weakPayloads=[];
    function createTemporaryBindings(){for(let i=0;i<10000;i++){
      const node={textContent:''},payload={name:'temporary '+i,body:new Uint8Array(1024)};
      // The parameter closure deliberately refers back to its own target.
      api.setText(node,'{name}',()=>({name:payload.name+node.textContent.slice(0,0)}));
      weakNodes.push(new WeakRef(node));weakPayloads.push(new WeakRef(payload));
    }}
    createTemporaryBindings();assert.equal(context.__bindingCount(),10000);
    for(let attempt=0;attempt<40;attempt++){
      await new Promise(resolve=>setTimeout(resolve,20));global.gc();
      await new Promise(resolve=>setTimeout(resolve,20));
      if(context.__bindingCount()===0)break;
    }
    assert.equal(context.__bindingCount(),0,'temporary bindings are reclaimed without a locale switch');
    assert.equal(weakNodes.filter(ref=>ref.deref()).length,0,'temporary target nodes are reclaimed');
    assert.equal(weakPayloads.filter(ref=>ref.deref()).length,0,'parameter closures and their payloads are reclaimed');
    console.log('Application language memory regression: PASS (10,000 temporary bindings, captured targets and payloads released without language changes)');
  })().catch(error=>{console.error(error);process.exitCode=1;});
}
