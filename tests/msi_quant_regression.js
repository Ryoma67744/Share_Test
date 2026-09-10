'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'viewer/index.html'),'utf8');
function lift(source,name){
  const start=source.search(new RegExp('(?:async )?function '+name+'\\('));
  assert.ok(start>=0,'missing '+name);
  // All lifted pure functions end at their own column-zero closing brace.
  return source.slice(start,source.indexOf('\n}',start)+2);
}
const names=['pointInPolygon','calcStats','buildLegacyMsiGrid','buildMsiGrid','msiSourceReference',
  'createMsiSourceGeometry','msiAxisInterpolate','msiValidRoiGeometry','roiContainsSourcePoint','msiRoiGeometryMeta',
  'msiSourceStats','percentileOfSorted','deriveBakeStats','blankStats','bakeRasterFromValues',
  'computeRasterPixels','scatterParquetColumn','parquetSourceRows','parquetAccumulateTicAndStats','msiMaxIntensity','msiQuantMean',
  'extractRoiRawFromSection','msiLayerSourceGeometry','msiLegacyRasterPointToDisplay',
  'msiDisplayRasterPointToLegacy','roiPolygonForDisplay','_roiGridKey','otsuHasMasks','msiOtsuSourceKey','otsuCurrentRecords'];
const ctx=vm.createContext({console,Float64Array,Float32Array,Uint32Array,Uint8ClampedArray,Map,Set,
  msiSourceNumber:Number, App:{panels:new Map()},MSI_ROBUST_PERCENTILE:0.999,MSI_DEFAULT_DISPLAY_PERCENTILE:0.999});
vm.runInContext(names.map(n=>lift(html,n)).join('\n')+'\nthis.api={'+names.join(',')+'};',ctx);
const api=ctx.api;
const plain=v=>JSON.parse(JSON.stringify(v));
const rows=[{x:0,y:0,v:10,rowId:'a'},{x:0,y:0,v:30,rowId:'b'},{x:1,y:0,v:100,rowId:'c'}];
const original=JSON.stringify(rows);
const def={kind:'txt',sourceFileId:'fixture'};
const geometry=api.createMsiSourceGeometry(rows,def);
const poly=[[-0.5,-0.5],[1.5,-0.5],[1.5,0.5],[-0.5,0.5]];
const expected=140/3;
for(const mode of ['robust','full'])for(const range of [null,[0,20],[0,10000]]) {
  const result=api.computeRasterPixels(rows,range,mode);
  assert.equal(result.rawMean,expected);assert.equal(result.rawTrueMax,100);
  assert.equal(result.sourceStats.n,3);assert.equal(result.sourceStats.nUniqueCoordinates,2);
  assert.deepEqual([...result.values],[20,100]);
  assert.equal(result.diag.dupCells,1);assert.equal(result.diag.dupRows,1);
}
assert.equal(JSON.stringify(rows),original,'display bake mutates source rows');
const sec={W:2,H:1,rowIdx:Int32Array.from([0,1,2]),cellIdx:Int32Array.from([0,0,1])};
assert.deepEqual([...api.scatterParquetColumn(Float64Array.from([10,30,100]),sec)],[20,100]);
const precise=[{x:0,y:0,v:1.0000000000000002},{x:1,y:0,v:1.0000000000000004}];
assert.deepEqual([...api.computeRasterPixels(precise,null,'full').values],precise.map(r=>r.v));
assert.deepEqual(plain(api.calcStats([])),{mean:null,sd:null,max:null,n:0});
assert.equal(api.computeRasterPixels([{x:0,y:0,v:NaN}],null,'full').rawTrueMax,null);
const missing=[{x:0,y:0,v:0},{x:1,y:0,v:-5},{x:2,y:0,v:NaN},{x:NaN,y:0,v:100}];
const missingStats=api.msiSourceStats(missing);
assert.equal(missingStats.mean,95/3);assert.equal(missingStats.n,3);assert.equal(missingStats.invalidCoordinates,1);
const blocked=api.msiSourceStats([{x:0,y:0,v:1},{x:1,y:0,v:NaN,sourceCells:{v:{status:'unsafe-integer'}}}]);
assert.equal(blocked.mean,null);assert.equal(blocked.max,null);assert.equal(blocked.precisionBlocked,true);
assert.equal(api.msiMaxIntensity({rawTrueMax:123,rawRange:[0,100],statMax:999}).value,null);
assert.equal(api.msiQuantMean({rawMean:15}),null);
assert.equal(api.msiMaxIntensity({rawTrueMax:123,quantVersion:'msi-source-rows-v1'}).value,123);
const irregular=[{x:0,y:0,v:10},{x:0.1,y:0,v:30},{x:10,y:0,v:100}];
const irregularGeom=api.createMsiSourceGeometry(irregular,def),g=api.buildMsiGrid(irregular);
assert.equal(g.W,101);assert.equal(g.xIndex.get(0.1),1);assert.equal(g.xIndex.get(10),100);
assert.equal(irregularGeom.legacy.W,3);
const legacyPoly=[[-0.5,-0.5],[1.5,-0.5],[1.5,0.5],[-0.5,0.5]];
assert.deepEqual(irregular.map(r=>api.roiContainsSourcePoint(legacyPoly,null,irregularGeom,r.x,r.y)),[true,true,false]);
const newMeta={version:'msi-source-v1',sourceRef:geometry.sourceRef,displayGeometry:geometry.displayGeometry};
assert.deepEqual(rows.map(r=>api.roiContainsSourcePoint(poly,newMeta,geometry,r.x,r.y)),[true,true,true]);
assert.equal(api.roiContainsSourcePoint(poly,{...newMeta,sourceRef:'other'},geometry,0,0),null);
for(const bad of [{...newMeta,version:'future'},{...newMeta,displayGeometry:{...newMeta.displayGeometry,x:{origin:0,step:0}}}])
  assert.equal(api.roiContainsSourcePoint(poly,bad,geometry,0,0),null);
const large=api.buildMsiGrid([{x:0,y:0},{x:1e-12,y:1e-12},{x:1e9,y:1e9}]);
assert.ok(large.W*large.H<=4194304);assert.ok(large.W<=4096&&large.H<=4096);
const section={id:'section',msiSeries:{MSI_A:def},meta:{}};
const roi={id:'roi',polysBySection:{section:legacyPoly}};
const panel={section,project:{rois:[roi]},msiValueRasters:new Map([['MSI_A',{sourceGeometry:irregularGeom}]])};
ctx.App.panels.set(section.id,panel);
const displayed=api.roiPolygonForDisplay(roi,section,'MSI_A',legacyPoly);
for(const row of irregular){
  const d=irregularGeom.displayGeometry;
  assert.equal(api.pointInPolygon((row.x-d.x.origin)/d.x.step,0,displayed),
    api.roiContainsSourcePoint(legacyPoly,null,irregularGeom,row.x,row.y));
}
for(const p of [[0,0],[0.5,0],[1,0],[1.5,0],[2,0]]) {
  const mapped=api.msiLegacyRasterPointToDisplay(section,'MSI_A',p);
  const back=api.msiDisplayRasterPointToLegacy(section,'MSI_A',mapped);
  assert.ok(Math.abs(back[0]-p[0])<1e-12);
}
assert.equal(api.otsuHasMasks({meta:{otsu:{bySource:{a:{keepB64:'x'}}}}}),false);
const maskKey=api.msiOtsuSourceKey(def);
assert.equal(api.otsuHasMasks({msiSeries:{MSI_A:def},meta:{otsu:{bySource:{[maskKey]:{W:1,H:1,keepB64:'x',sourceFrameKey:maskKey,geometryVersion:'msi-proportional-v1'}}}}}),true);
const oldKey=api._roiGridKey(section,'MSI_A',def);
assert.equal(api._roiGridKey(section,'MSI_A',{...def,bakeMode:'full',rawRange:[0,10]}),oldKey);
assert.notEqual(api._roiGridKey(section,'MSI_A',{...def,sourceRevision:'changed'}),oldKey);
for(const field of ['sheet','func','annotation','col_x','data_start_row'])
  assert.notEqual(api._roiGridKey(section,'MSI_A',{...def,sourceReference:geometry.sourceRef,[field]:'changed'}),api._roiGridKey(section,'MSI_A',{...def,sourceReference:geometry.sourceRef}));
// Connector shares the same source-position membership and original row order.
const connector=fs.readFileSync(path.join(root,'connector/src/msi.js'),'utf8');
const cnames=['pointInPolygon','buildLegacyMsiGrid','buildMsiGrid','msiSourceReference','createMsiSourceGeometry','msiAxisInterpolate','msiValidRoiGeometry','roiContainsSourcePoint','extractRoiValues','stats'];
const cc=vm.createContext({Float64Array,Map,Set});
vm.runInContext(cnames.map(n=>lift(connector,n)).join('\n')+'\nthis.api={'+cnames.join(',')+'};',cc);
const cvals=cc.api.extractRoiValues(rows,poly,cc.api.createMsiSourceGeometry(rows,def),newMeta,def);
assert.deepEqual([...cvals],[10,30,100]);assert.equal(cc.api.stats(cvals).mean,expected);
assert.equal(cc.api.stats(cvals).sd,api.calcStats([10,30,100]).sd);
assert.equal(cc.api.stats(cvals).nUniqueCoordinates,2);
async function main(){
  ctx._ensureRoiRawGrid=async()=>({rows,sourceGeometry:geometry});
  const p={section,project:{rois:[]}};
  const r={geometryBySection:{section:newMeta}};
  for(const mask of [false,true]){
    ctx.App.otsuBgRemove=mask;
    ctx.otsuKeepGridForLayer=()=>{throw new Error('quantification must not read Otsu');};
    const result=await api.extractRoiRawFromSection(p,'MSI_A',poly,r);
    assert.equal(result.unavailable,false);assert.deepEqual([...result.values],[10,30,100]);
    assert.deepEqual([...result.rowIds],['a','b','c']);assert.equal(result.nUniqueCoordinates,2);
  }
  const pg={...sec,sourceRows:rows.map((r,i)=>({x:r.x,y:r.y,rowId:i})),label:'A',dupCells:1,dupRows:1};
  ctx.parquetEnsureGeometry=async()=>({sections:[pg]});
  ctx._pqFiles=new Map([['fixture',{fileId:'worker-file'}]]);
  ctx.callParquetWorker=async()=>[Float64Array.from([10,30,100])];
  ctx.msiSourceCell=raw=>({type:'number',status:'valid',token:String(raw),value:raw});
  const target={sectionId:'section',label:'A',W:1,H:1,accum:new Float64Array(1),count:new Uint32Array(1)};
  const tic=await api.parquetAccumulateTicAndStats('fixture',{},[{key:'MSI_A',colIdx:0}],[target],{batch:1});
  assert.equal(target.W,2);assert.equal(target.accum.length,2);
  const ticStats=tic.statsByKey.get('MSI_A').section;
  assert.equal(ticStats.rawMean,expected);assert.equal(ticStats.rawTrueMax,100);
  assert.equal(ticStats.sourceStats.n,3);assert.equal(ticStats.diag.dupRows,1);
  console.log('MSI numeric preservation regression: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
