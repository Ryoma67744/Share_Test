'use strict';
const assert=require('node:assert/strict');
const Core=require('../viewer/msi-ratio-core.js');
const Model=require('../viewer/msi-ratio-model.js');
const Display=require('../viewer/msi-display-settings.js');
const Runtime=require('../viewer/msi-ratio-app.js');
global.document={getElementById:()=>null,createElement:()=>({setAttribute(){},append(){}})};
class FakeWorker {
  static instances=[];
  constructor(){FakeWorker.instances.push(this);}
  postMessage(message){this.message=message;}
  terminate(){this.terminated=true;}
}
global.Worker=FakeWorker;
function fixture(n) {
  const section={id:'s',meta:{},msiSeries:{
    MSI_X:{kind:'txt',sourceReference:'original',v:'X'},MSI_Y:{kind:'txt',sourceReference:'original',v:'Y'}}};
  const def={id:'test',name:'X / Y',revision:1,operation:'divide',calculationVersion:'msi-ratio-v1',denominatorMin:0,
    numeratorPolicy:'nonnegative',invalidPolicy:'exclude',bindings:{s:{numerator:Model.makeInputRef(section.msiSeries.MSI_X,'MSI_X'),
      denominator:Model.makeInputRef(section.msiSeries.MSI_Y,'MSI_Y'),coordinateConfirmed:false,coordinateEvidence:''}}};
  const project={id:'p',meta:{msiRatios:{schemaVersion:1,definitions:[def]}},sections:[section],
    rois:[{id:'roi',name:'Legacy ROI',polysBySection:{s:[[0,0],[2,0],[2,1],[0,1]]}}]};
  const app={project,panels:new Map(),getMsiDisplaySettings:()=>Display.preset('hdi'),queueSave(){},
    updateMsiDisplaySettings(){},setFocusCompoundKey(){},refreshMsiDisplayControls(){},repaintAllMsi(){}};
  class Panel {renderComposite(){}renderMsiThumbnail(){}}
  const geometry={sourceRef:'original',displayGeometry:{version:'msi-proportional-v1',W:n,H:1,x:{origin:0,step:1},y:{origin:0,step:1}}};
  const rows=Array.from({length:n},(_,i)=>({rowId:i,x:i,y:0,v:2,sourceCells:{v:{status:'valid'}}}));
  const runtime=Runtime.install({app,Panel,viewerBase:'http://localhost/viewer/',contextKey:()=>project.id,
    sourceReference:e=>e.sourceReference,frameKey:e=>e.sourceReference,sourceIdentity:(s,k)=>JSON.stringify(s.msiSeries[k]),
    readGrid:async()=>({rows,sourceGeometry:geometry}),roiMeta:()=>null,roiContains:()=>true,
    otsuGrid:()=>null,otsuStamp:()=>'',inputLabel:(s,k)=>k,safeName:s=>s});
  return {runtime,app,section,def,rows};
}
(async()=>{
  const small=fixture(2),key=Model.displayKey(small.def.id);
  const result=await small.runtime.resolve(small.section,key);
  assert.equal(result.statistics.totalRatio,1);assert.equal(result.roiStats[0].status,'ready');
  small.section.msiSeries.MSI_OTHER={kind:'txt',sourceReference:'different-source',v:'Z'};
  const ambiguous=await small.runtime.resolve(small.section,key);
  assert.equal(ambiguous.roiStats[0].status,'unavailable');
  assert.equal(ambiguous.roiStats[0].reason,'legacy-roi-source-ambiguous');
  assert.equal(ambiguous.roiStats[0].statistics,null);

  const large=fixture(50000),controller=new AbortController();
  large.rows[1].sourceCells.v={status:'missing',token:'original missing token'};
  large.rows[2].sourceCells.v={status:'unsafe-integer',token:'99999999999999999999999999'};
  large.rows[3].sourceCells.x={status:'unsupported-decimal',token:'original coordinate token'};
  const pending=large.runtime.resolve(large.section,Model.displayKey(large.def.id),{signal:controller.signal});
  for(let attempt=0;attempt<10&&!FakeWorker.instances.length;attempt++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(FakeWorker.instances.length,1,'Large source starts a calculation worker');
  const worker=FakeWorker.instances[0];assert.equal(worker.message.X.values.length,50000);
  assert.equal(worker.message.X.positions,worker.message.Y.positions,'Verified matching coordinates share one compact worker payload');
  assert.equal(worker.message.X.rowIds,worker.message.Y.rowIds);
  assert.equal(worker.message.X.sourceCells[1].status,'missing');
  assert.equal(worker.message.X.sourceCells[2].status,'unsafe-integer');
  assert.equal(worker.message.X.positions[3].sourceCells.x.status,'unsupported-decimal');
  assert.equal(worker.message.X.sourceCells[2].token,undefined,'Original tokens are not duplicated into the worker');
  assert.equal(large.rows[2].sourceCells.v.token,'99999999999999999999999999','Raw cache metadata stays unchanged');
  assert.equal(worker.message.options.signal,undefined,'AbortSignal is not sent as scientific options');
  controller.abort();
  await assert.rejects(pending,error=>error.code==='RATIO_CANCELLED');
  assert.equal(worker.terminated,true,'Abort terminates the active calculation worker');
  console.log('Ratio runtime regression: PASS (legacy ROI ambiguity, worker AbortSignal cancellation)');
})().catch(error=>{console.error(error);process.exitCode=1;});
