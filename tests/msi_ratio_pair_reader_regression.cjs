'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Model=require('../viewer/msi-ratio-model.js');
const html=fs.readFileSync(path.join(__dirname,'../viewer/index.html'),'utf8');
const begin=html.indexOf('const _ratioInputGridInFlight = new WeakMap();');
const end=html.indexOf('// 1 切片の全ソースファイルについて TIC',begin);
assert.ok(begin>0&&end>begin);
function fixture(){
  const cache=new Map(),project={id:'p'},calls={parse:0,single:0,geometry:[],stats:0};
  const section={id:'s',msiSeries:{MSI_X:{kind:'txt',blobId:'blob',sourceReference:'file',sourceRevision:'1',v:'X'},
    MSI_Y:{kind:'txt',blobId:'blob',sourceReference:'file',sourceRevision:'1',v:'Y'}}};
  const gridKey=(s,k,e)=>[s.id,k,e.sourceReference,e.sourceRevision,e.blobId,e.v].join('|');
  const sandbox={console,MsiRatioModel:Model,App:{project},
    msiOtsuSourceKey:e=>JSON.stringify([e.sourceReference,e.kind,e.x,e.y,e.func]),_roiGridKey:gridKey,
    _roiGridCacheGet:key=>cache.get(key)||null,_roiGridCacheSet:(key,value)=>cache.set(key,value),
    _ensureRoiRawGrid:async(s,k)=>{calls.single++;return {single:k};},
    ensureLocalBlob:async()=>({blob:{arrayBuffer:async()=>new ArrayBuffer(0)}}),
    extractSourceMatrixForExport:async(buf,ent,entries)=>{calls.parse++;if(calls.gate)await calls.gate;return {
      positions:[{x:0,y:0},{x:1,y:0}],rowIds:[4,5],cols:entries.map(item=>({layerKey:item.layerKey,values:item.ent.v==='X'?[10,20]:[1,2]}))};},
    createMsiSourceGeometry:(positions,ent,cols)=>{calls.geometry.push([ent.v,cols.length]);return {sourceRef:ent.sourceReference,
      displayGeometry:{W:2,H:1},legacy:{feature:ent.v}};},
    msiMatrixRows:(positions,col,rowIds)=>positions.map((p,i)=>({...p,rowId:rowIds[i],v:col.values[i]})),
    msiSourceStats:rows=>{calls.stats++;return {n:rows.length,sum:rows.reduce((sum,row)=>sum+row.v,0)};}};
  vm.createContext(sandbox);vm.runInContext(html.slice(begin,end),sandbox);
  return {section,cache,calls,sandbox,read:(x='MSI_X',y='MSI_Y')=>sandbox._ensureRatioInputGrids(section,x,y),gridKey};
}
(async()=>{
  const f=fixture(),[[x,y],[reverseY,reverseX]]=await Promise.all([f.read(),f.read('MSI_Y','MSI_X')]);
  assert.equal(f.calls.parse,1,'Concurrent reversed requests share exactly one table parse');
  assert.equal(f.calls.single,0);assert.equal(x,reverseX);assert.equal(y,reverseY);
  assert.equal(x.sourceStats.sum,30);assert.equal(y.sourceStats.sum,3);
  assert.deepEqual(f.calls.geometry,[['X',1],['Y',1]],'Each feature retains its ordinary geometry safety checks');
  assert.equal(f.calls.stats,2);assert.equal(f.cache.size,2);
  const cached=await f.read();assert.equal(cached[0],x);assert.equal(cached[1],y);assert.equal(f.calls.parse,1);
  f.cache.delete(f.gridKey(f.section,'MSI_Y',f.section.msiSeries.MSI_Y));
  const partial=await f.read();assert.equal(partial[0],x);assert.equal(partial[1].single,'MSI_Y');
  assert.equal(f.calls.single,1,'One cache miss reads only its missing feature');
  const same=await f.read('MSI_X','MSI_X');assert.equal(same[0],same[1]);

  for(const patch of [{blobId:'other'},{sourceReference:'other'},{kind:'parquet',colIdx:3},{x:'different-x'},
    {kind:'unknown'}]){
    const other=fixture();Object.assign(other.section.msiSeries.MSI_Y,patch);await other.read();
    assert.equal(other.calls.parse,0);assert.equal(other.calls.single,2,'Unproven frames use the ordinary source readers');
  }
  const analyte=fixture();analyte.section.msiSeries.MSI_Y.compound_index=0;await analyte.read();
  assert.equal(analyte.calls.parse,0,'Implicit analyte reader settings cannot be grouped with generic CSV');

  const stale=fixture();let release;stale.calls.gate=new Promise(resolve=>release=resolve);
  const pending=stale.read();
  while(!stale.calls.parse)await new Promise(resolve=>setTimeout(resolve,0));
  stale.section.msiSeries.MSI_Y.sourceRevision='2';release();
  const dropped=await pending;assert.equal(dropped[0],null);assert.equal(dropped[1],null);
  assert.equal(stale.cache.size,0,'An input changed during parse never populates either cache entry');
  console.log('Ratio paired reader regression: PASS (one parse, ordinary-grid parity, cache reuse, frame guards, stale rejection)');
})().catch(error=>{console.error(error);process.exitCode=1;});
