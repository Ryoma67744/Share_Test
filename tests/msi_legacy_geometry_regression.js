'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'viewer/index.html'),'utf8');
const connector=fs.readFileSync(path.join(root,'connector/src/msi.js'),'utf8');
function lift(source,name){
  const start=source.search(new RegExp('(?:async )?function '+name+'\\('));
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n}',start)+2);
}
const common=['pointInPolygon','buildMsiGrid','buildLegacyMsiGrid','msiSourceReference',
  'createMsiSourceGeometry','msiAxisInterpolate','msiValidRoiGeometry','roiContainsSourcePoint'];
const viewer=vm.createContext({App:{panels:new Map()},console});
const cv=vm.createContext({console});
for(const name of common){
  vm.runInContext(lift(html,name),viewer);
  vm.runInContext(lift(connector,name),cv);
}
for(const name of ['msiSourceCell','msiSourceRow','msiRoiGeometryMeta','extractRoiRawFromSection'])
  vm.runInContext(lift(html,name),viewer);
vm.runInContext(lift(connector,'extractRoiValues'),cv);
const def={kind:'txt',sourceFileId:'original'};
const poly=[[-0.5,-0.5],[5,-0.5],[5,2],[-0.5,2]];
const make=tuples=>tuples.map((r,i)=>viewer.msiSourceRow(...r,i));
const plain=x=>JSON.parse(JSON.stringify(x));
const cases=[
  {name:'valid',rows:make([[0,0,0],[1,0,10],[1,0,30],[2,0,-5]]),confirmed:true},
  {name:'invalid intensity shifts origin',rows:make([[0,0,'bad'],[1,0,10],[2,0,20]]),confirmed:false,reason:'legacy-render-quant-axis-mismatch'},
  {name:'invalid intensity preserves supported axes',rows:make([[0,0,10],[1,0,'bad'],[1,0,20],[2,0,30]]),confirmed:true},
  {name:'blank intensity formerly zero does not remove an axis',rows:make([[0,0,''],[1,0,10],[2,0,20]]),confirmed:true},
  {name:'null intensity formerly zero does not remove an axis',rows:make([[0,0,null],[1,0,10],[2,0,20]]),confirmed:true},
  ...[null,'','bad',undefined].map(value=>({name:'unconfirmed coordinate '+String(value),rows:make([[value,0,99],[1,0,10],[2,0,20]]),confirmed:false,reason:'legacy-coordinate-unconfirmed'})),
];
async function main(){
  for(const test of cases){
    const before=JSON.stringify(test.rows);
    const g=viewer.createMsiSourceGeometry(test.rows,def);
    const cg=cv.createMsiSourceGeometry(test.rows,def);
    assert.deepEqual(plain(g),plain(cg),test.name+' viewer/connector parity');
    assert.equal(g.legacy.confirmed,test.confirmed,test.name);
    if(test.reason)assert.equal(g.legacy.reason,test.reason);
    const section={id:'sec',msiSeries:{MSI_A:def}};
    viewer._ensureRoiRawGrid=async()=>({rows:test.rows,sourceGeometry:g});
    const panel={section,project:{rois:[]}};
    const old=await viewer.extractRoiRawFromSection(panel,'MSI_A',poly,{});
    if(!test.confirmed){
      assert.equal(old.unavailable,true,test.name);
      assert.equal(old.reason,test.reason);
      assert.throws(()=>cv.extractRoiValues(test.rows,poly,cg,null,def),/Legacy ROI geometry is unconfirmed/);
    }else{
      assert.equal(old.unavailable,false,test.name);
      assert.deepEqual([...old.values],[...cv.extractRoiValues(test.rows,poly,cg,null,def)]);
    }
    // New ROIs remain anchored to original coordinates, even where the old
    // renderer's treatment cannot be reconstructed safely.
    const meta={version:'msi-source-v1',sourceRef:g.sourceRef,displayGeometry:g.displayGeometry};
    const fresh=await viewer.extractRoiRawFromSection(panel,'MSI_A',poly,{geometryBySection:{sec:meta}});
    assert.equal(fresh.unavailable,false,test.name+' new ROI remains supported');
    assert.deepEqual([...fresh.values],[...cv.extractRoiValues(test.rows,poly,cg,meta,def)]);
    assert.equal(JSON.stringify(test.rows),before,'source rows changed');
  }
  const rows=make([[0,0,'bad'],[1,0,10],[2,0,20]]);
  const positions=rows.map(r=>({x:r.x,y:r.y,sourceCells:{x:r.sourceCells.x,y:r.sourceCells.y}}));
  const col={values:rows.map(r=>r.v),sourceCells:rows.map(r=>r.sourceCells.v)};
  assert.equal(viewer.createMsiSourceGeometry(positions,def,col).legacy.reason,'legacy-render-quant-axis-mismatch',
    'ROI source matrix passes selected value/cell information into its geometry check');
  assert.equal(viewer.createMsiSourceGeometry(positions,def).legacy.reason,'legacy-value-axis-unconfirmed');
  assert.equal(viewer.createMsiSourceGeometry(rows,{...def,kind:'parquet'}).legacy.confirmed,true,
    'Legacy Parquet geometry used all coordinate rows independently of the selected intensity');
  const raw=make([[10,0,10],[20,0,20]]);raw[0].legacyX=0;raw[1].legacyX=1;
  assert.equal(viewer.createMsiSourceGeometry(raw,{...def,kind:'raw'}).legacy.confirmed,true);
  console.log('Legacy ROI geometry safety regression: PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
