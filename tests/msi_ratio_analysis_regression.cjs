'use strict';
const assert=require('node:assert/strict');
const Core=require('../viewer/msi-ratio-core.js');
const Model=require('../viewer/msi-ratio-model.js');
const Display=require('../viewer/msi-display-settings.js');
const Analysis=require('../viewer/msi-analysis-core.js');
const Service=require('../viewer/msi-analysis-service.js');
const Runtime=require('../viewer/msi-ratio-app.js');
global.document={getElementById:()=>null,createElement:()=>({setAttribute(){},append(){}})};
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
const until=async predicate=>{for(let i=0;i<100&&!predicate();i++)await pause();assert.ok(predicate(),'Expected asynchronous operation to start');};
const sourceGeometry={sourceRef:'original',displayGeometry:{version:'msi-proportional-v1',W:3,H:1,x:{origin:0,step:1},y:{origin:0,step:1}}};
const points=[{x:0,y:0},{x:0,y:0},{x:1,y:0},{x:2,y:0}],ids=[10,11,12,13];
function snapshot(values){return Analysis.snapshot({positions:points,rowIds:ids,sourceFrame:'original'},
  {values,sourceCells:values.map(value=>({status:'valid',value,token:String(value)}))},sourceGeometry,{});}
function fixture({numeric=true,unavailable=false}={}) {
  const sources={x:snapshot([10,10,0,7]),y:snapshot([1,10,2,0])},calls={reads:[],ops:[],workers:0},results=new Map();
  let sequence=0,service;
  class Transport {
    constructor(){calls.workers++;}
    postMessage(message){
      calls.ops.push(message.op);
      Promise.resolve().then(async()=>{
        if(message.op==='ratio'&&calls.gate)await calls.gate;
        if(message.op==='ratio-roi'&&calls.roiGate)await calls.roiGate;
        if(this.terminated)return;
        try {
          let result;const p=message.payload;
          if(message.op==='ratio'){
            const X=Analysis.input({...sources.x,sourceFrame:p.leftSourceFrame}),Y=Analysis.input({...sources.y,sourceFrame:p.rightSourceFrame});
            const calculated=Core.calculate(X,Y,p.options),handle={id:'result-'+(++sequence)};
            if(calculated.status==='unavailable')result={...calculated,handle};
            else {
              const displayed=Analysis.ratioDisplay(calculated,sourceGeometry);results.set(handle.id,{calculated,...displayed});
              result={...calculated,...displayed,handle,numerator:sources.x,denominator:sources.y};
              delete result.positions;delete result.rowIds;
            }
          }else if(message.op==='ratio-roi'){
            if(calls.expireNextRoi){calls.expireNextRoi=false;throw Object.assign(new Error('evicted'),{code:'ANALYSIS_HANDLE_EXPIRED'});}
            const r=results.get(p.handle.id).calculated;
            result=p.selections.map(s=>({id:s.id,status:'ready',reason:null,statistics:Core.summarize(r,(x,y)=>x>=s.poly[0][0]&&x<=s.poly[1][0])}));
          }else if(message.op==='ratio-keep'){
            const r=results.get(p.handle.id);result=Analysis.ratioKeep(r.calculated,r.raster,p.x,p.y);
          }else throw new Error('Unexpected operation: '+message.op);
          this.onmessage?.({data:{id:message.id,generation:message.generation,result}});
        }catch(error){this.onmessage?.({data:{id:message.id,generation:message.generation,error:{message:error.message,code:error.code}}});}
      });
    }
    terminate(){this.terminated=true;}
  }
  service=Service.create({createWorker:()=>{if(unavailable)throw Object.assign(new Error('unsupported'),{code:'ANALYSIS_WORKER_UNAVAILABLE'});return new Transport();}});
  const section={id:'s',meta:{},msiSeries:{MSI_X:{kind:'txt',sourceReference:'original',v:'X'},MSI_Y:{kind:'txt',sourceReference:'original',v:'Y'}}};
  const def={id:'test',name:'X / Y',revision:1,operation:'divide',calculationVersion:'msi-ratio-v1',denominatorMin:0,
    numeratorPolicy:'nonnegative',invalidPolicy:'exclude',bindings:{s:{numerator:Model.makeInputRef(section.msiSeries.MSI_X,'MSI_X'),
      denominator:Model.makeInputRef(section.msiSeries.MSI_Y,'MSI_Y'),coordinateConfirmed:false,coordinateEvidence:''}}};
  const project={id:'p',meta:{msiRatios:{schemaVersion:1,definitions:[def]}},sections:[section],
    rois:[{id:'roi',name:'First coordinate',polysBySection:{s:[[0,0],[0,0],[0,1],[0,1]]}}]};
  const app={project,panels:new Map(),getMsiDisplaySettings:()=>Display.preset('hdi'),queueSave(){},
    updateMsiDisplaySettings(){},setFocusCompoundKey(key){this.focusCompoundKey=key;},refreshMsiDisplayControls(){},repaintAllMsi(){},
    recomputeMsiAbsScale(){},viewMode:'compound',focusCompoundKey:'MSI_X'};
  class Panel {renderComposite(){}renderMsiThumbnail(){}}
  const grid=key=>{const snap=sources[key==='MSI_X'?'x':'y'];return {...Analysis.grid(snap),handle:{id:key,generation:service.generation}};};
  const hooks={app,Panel,viewerBase:'http://localhost/viewer/',contextKey:()=>project.id,
    sourceReference:e=>e.sourceReference,frameKey:e=>e.sourceReference,sourceIdentity:(s,k)=>JSON.stringify(s.msiSeries[k]),
    readGrid:async(s,key)=>grid(key),readPair:async(s,x,y,options)=>{calls.reads.push(options);return [grid(x),grid(y)];},
    roiMeta:()=>null,roiContains:(poly,meta,geometry,x)=>x>=poly[0][0]&&x<=poly[1][0],
    roiSelection:(s,poly,meta,geometry)=>({poly,meta,geometry}),
    otsuGrid:()=>calls.keep||null,otsuStamp:()=>calls.keep?'mask':'',inputLabel:(s,k)=>k,safeName:s=>s,
    refreshToolbar(){},setColormap(){},currentColormap:()=>'',colormap:()=>[]};
  if(numeric)hooks.numericService=()=>service;
  const runtime=Runtime.install(hooks),key=Model.displayKey(def.id);
  return {runtime,app,section,project,def,key,sources,calls,service};
}
(async()=>{
  const old=fixture({numeric:false}),f=fixture(),before=JSON.stringify(f.project);
  const expected=await old.runtime.resolve(old.section,old.key),actual=await f.runtime.resolve(f.section,f.key);
  for(const key of ['values','valid','reasons','denominatorOrder','rowIds'])assert.deepEqual(Array.from(actual[key]),Array.from(expected[key]),key);
  assert.deepEqual(Array.from(actual.values),[10,1,0,NaN]);
  assert.deepEqual(Array.from(actual.raster.values),[5.5,0,NaN]);
  assert.deepEqual(actual.statistics,expected.statistics);
  assert.equal(actual.statistics.totalRatio,20/13);assert.equal(actual.statistics.mean,11/3);
  assert.deepEqual(actual.roiStats,expected.roiStats);
  assert.equal(actual.roiStats[0].statistics.totalRatio,20/11);
  assert.equal(actual.robustMax,expected.robustMax);assert.deepEqual(actual.displayAuto,expected.displayAuto);
  assert.deepEqual(Object.keys(actual.positions),['length'],'No eager object array is restored on the UI');
  assert.deepEqual(Array.from(actual.positions,p=>({x:p.x,y:p.y})),Array.from(expected.positions,p=>({x:p.x,y:p.y})));
  assert.deepEqual(Array.from(actual.numerator.values),[10,10,0,7]);assert.equal(JSON.stringify(f.project),before,'Derived work does not mutate source/project metadata');
  await f.runtime.resolve(f.section,f.key,{roiStats:false});
  assert.equal(f.calls.ops.filter(op=>op==='ratio').length,1,'Completed typed cache is reused');
  f.calls.keep={W:3,H:1,keep:Uint8Array.from([1,0,1])};
  const masked=await f.runtime.resolve(f.section,f.key,{roiStats:false});
  assert.deepEqual(Array.from(masked.keepGrid.keep),[1,0,1]);assert.ok(f.calls.ops.includes('ratio-keep'));

  const cancelled=fixture();let release;cancelled.calls.gate=new Promise(resolve=>release=resolve);
  const one=new AbortController(),two=new AbortController();
  const first=cancelled.runtime.resolve(cancelled.section,cancelled.key,{signal:one.signal,roiStats:false});
  const second=cancelled.runtime.resolve(cancelled.section,cancelled.key,{signal:two.signal,roiStats:false});
  await until(()=>cancelled.calls.ops.includes('ratio'));one.abort();
  await assert.rejects(first,e=>e.code==='RATIO_CANCELLED');release();
  assert.deepEqual(Array.from((await second).values),[10,1,0,NaN]);
  assert.equal(cancelled.calls.ops.filter(op=>op==='ratio').length,1,'Aborting one consumer does not cancel its peer');
  assert.equal(cancelled.service.generation,1);

  const stale=fixture();let finishStale;stale.calls.gate=new Promise(resolve=>finishStale=resolve);
  const staleRequest=stale.runtime.resolve(stale.section,stale.key,{roiStats:false});
  await until(()=>stale.calls.ops.includes('ratio'));stale.def.denominatorMin=2;finishStale();
  await assert.rejects(staleRequest,e=>e.code==='RATIO_SOURCE_CHANGED');
  const edited=await stale.runtime.resolve(stale.section,stale.key,{roiStats:false});
  assert.deepEqual(Array.from(edited.valid),[0,1,0,0],'Changed inputs cannot reuse a superseded numeric result');
  const roiEdit=fixture();let finishRoi;roiEdit.calls.roiGate=new Promise(resolve=>finishRoi=resolve);
  const roiRequest=roiEdit.runtime.resolve(roiEdit.section,roiEdit.key);
  await until(()=>roiEdit.calls.ops.includes('ratio-roi'));roiEdit.project.rois[0].polysBySection.s[0][0]=1;finishRoi();
  await assert.rejects(roiRequest,e=>e.code==='RATIO_SOURCE_CHANGED','ROI changes during Worker work reject the old summary');

  const expired=fixture();expired.calls.expireNextRoi=true;
  assert.deepEqual((await expired.runtime.resolve(expired.section,expired.key)).statistics,expected.statistics);
  assert.equal(expired.calls.reads.length,2);assert.equal(expired.calls.reads[1].force,true,'Same-generation eviction forces source handle reconstruction once');
  const absent=fixture({unavailable:true});
  await assert.rejects(absent.runtime.resolve(absent.section,absent.key),e=>e.code==='ANALYSIS_WORKER_UNAVAILABLE');
  assert.equal(absent.calls.ops.length,0,'Unavailable worker never falls back to main-thread calculation');

  const bounded=fixture();let active=0,peak=0;const started=[],releases=[];
  for(let i=0;i<6;i++){
    const section={id:'s'+i,msiSeries:bounded.section.msiSeries};
    bounded.app.panels.set(section.id,{section,visibleLayers:new Set(),dom:{canvasCell:{querySelector:()=>null}},
      ensureMsiLayerLoaded:async()=>{started.push(i);peak=Math.max(peak,++active);await new Promise(resolve=>releases.push(resolve));active--;return true;},
      setupCanvasSize(){},populateThumbnails(){},rebuildLayerBar(){},renderComposite(){},drawAllRois(){}});
  }
  bounded.app.isSectionLoadWanted=panel=>['s3','s4'].includes(panel.section.id);
  const switching=bounded.runtime.activate('MSI_X');await until(()=>started.length===2);assert.deepEqual(started,[3,4]);
  while(started.length<6){releases.splice(0).forEach(resolve=>resolve());await pause();}
  releases.splice(0).forEach(resolve=>resolve());await switching;assert.equal(peak,2);
  for(const item of [old,f,cancelled,stale,roiEdit,expired,absent,bounded])item.service.dispose();
  console.log('Ratio analysis regression: PASS (exact legacy rows/statistics/raster/ROI, lazy views, worker mask, consumer cancellation, handle retry, no main fallback, bounded visible-first activation)');
})().catch(error=>{console.error(error);process.exitCode=1;});
