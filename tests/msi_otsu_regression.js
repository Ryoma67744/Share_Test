'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.resolve(__dirname,'../viewer/index.html'),'utf8');
function lift(name){
  const start=html.search(new RegExp('(?:async )?function '+name+'\\('));
  assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n}',start)+2);
}
function method(name){
  const start=html.indexOf('    '+name+'('),end=html.indexOf('\n    },',start);
  assert.ok(start>=0&&end>start,name);return 'function '+html.slice(start+4,end+6);
}
const names=['msiSourceReference','msiOtsuSourceKey','otsuCurrentRecords','otsuAnalysisRecord',
  'computeSectionOtsuMasks','buildMsiGrid','computeOtsuThreshold','buildOtsuRecordFromTic',
  'packBitsToB64','unpackBitsFromB64','otsuHasMasks','_otsuKeepGridRaw','otsuKeepGridForLayer'];
const calls=[];
const ctx=vm.createContext({console,Uint8Array,Int32Array,Float64Array,Map,Set,
  btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),
  OTSU_NBINS:256,_otsuTicCache:new Map(),_otsuKeepDecodeCache:new Map(),
  App:{panels:new Map(),otsuBgRemove:true,otsuStrength:0},
  ensureLocalBlob:async ent=>({blob:{arrayBuffer:async()=>new ArrayBuffer(0)}}),
  blobContentSig:async()=> 'source-bytes-fixture',
  extractSourceMatrixForExport:async(buf,repr,entries)=>{
    calls.push({sheet:repr.sheet,func:repr.func,entries:entries.map(e=>e.ent)});
    for(const entry of entries){assert.equal(entry.ent.sheet,repr.sheet);assert.equal(entry.ent.func,repr.func);}
    const forward=repr.sheet==='first'||repr.func===1;
    return {positions:[{x:0,y:0},{x:1,y:0}],cols:entries.map(e=>({values:forward?[0,100]:[100,0]}))};
  }});
vm.runInContext(names.map(lift).join('\n')+'\n'+['_otsuSourceKeys','_otsuIsFresh','_rethresholdSectionFromCache'].map(method).join('\n')
  +'\nObject.assign(App,{_otsuSourceKeys,_otsuIsFresh,_rethresholdSectionFromCache});this.api={'+names.join(',')+'};',ctx);
const api=ctx.api;
async function verifyTwoFrames(kind){
  const a={sourceFileId:'same-file',blobId:'local-blob',kind,col_x:'A',col_y:'B',col_v:'C'},b={...a};
  if(kind==='xlsx'){a.sheet='first';b.sheet='second';}else{a.func=1;b.func=2;}
  const sec={id:kind,meta:{},msiSeries:{MSI_A:a,MSI_B:b}};
  const res=await api.computeSectionOtsuMasks(sec,{}, {manualThreshold:50,useLogScale:false});
  assert.equal(Object.keys(res.bySource).length,2,'different coordinate frames must have distinct masks');
  sec.meta.otsu={...res,manual:true};
  assert.equal(api.otsuHasMasks(sec),true);
  assert.deepEqual([...api.otsuKeepGridForLayer(sec,'MSI_A').keep],[0,1]);
  assert.deepEqual([...api.otsuKeepGridForLayer(sec,'MSI_B').keep],[1,0]);
  assert.equal(ctx.App._otsuSourceKeys(sec).size,2);
  assert.equal(ctx.App._otsuIsFresh(sec,{manualThreshold:50}),true);
  ctx.App.panels.set(sec.id,{_pickRefMsiKey:()=> 'MSI_B'});
  assert.equal(api.otsuAnalysisRecord(sec),res.bySource[api.msiOtsuSourceKey(b)]);
  // Changes in storage location after sharing cannot invalidate a persisted mask.
  for(const ent of [a,b]){ent.sourceReference=api.msiSourceReference(ent);ent.blobId=null;ent.sourceUrl='https://storage/source';}
  assert.deepEqual([...api.otsuKeepGridForLayer(sec,'MSI_A').keep],[0,1]);
  assert.equal(ctx.App._otsuIsFresh(sec,{manualThreshold:50}),true);
  ctx.App.otsuBgRemove=false;assert.equal(api.otsuKeepGridForLayer(sec,'MSI_A'),null);
  ctx.App.otsuBgRemove=true;
  // A frame-only change must not reuse another frame's old record.
  a.col_x='D';assert.equal(api.otsuKeepGridForLayer(sec,'MSI_A'),null);
  assert.equal(ctx.App._otsuIsFresh(sec,{manualThreshold:50}),false);
}
async function main(){
  await verifyTwoFrames('xlsx');await verifyTwoFrames('raw');
  assert.equal(calls.length,4,'same blob different sheets/functions need independent matrix reads');
  const ent={sourceFileId:'p',kind:'parquet',annotation:'section-A'};
  const key=api.msiOtsuSourceKey(ent),rec={W:2,H:1,keepB64:api.packBitsToB64(Uint8Array.from([1,0])),geometryVersion:'msi-proportional-v1'};
  const sec={id:'parquet',msiSeries:{MSI_A:ent},meta:{otsu:{bySource:{p:rec}}}};
  assert.equal(api.otsuHasMasks(sec),false,'legacy source-ID-only records require recomputation');
  assert.equal(api.otsuKeepGridForLayer(sec,'MSI_A'),null);
  sec.meta.otsu.bySource[key]={...rec,sourceFrameKey:key};
  assert.deepEqual([...api.otsuKeepGridForLayer(sec,'MSI_A').keep],[1,0]);
  assert.notEqual(api.msiOtsuSourceKey({...ent,annotation:'section-B'}),key);
  // Automatic-mask strength adjustment reads exactly the frame cache it wrote.
  const auto={id:'auto',msiSeries:{MSI_A:{sourceFileId:'auto',kind:'xlsx',sheet:'first'}},meta:{}};
  auto.meta.otsu=await api.computeSectionOtsuMasks(auto,{},{});
  assert.equal(ctx.App._rethresholdSectionFromCache(auto),true);
  console.log('MSI Otsu source-frame regression: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
