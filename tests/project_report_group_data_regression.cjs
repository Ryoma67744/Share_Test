'use strict';
const assert = require('node:assert/strict');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const Data = require('../viewer/project-report-data.js');
const options = {createCanvas, nearestUpscale:false};
const raster = values => ({W:values.length,H:1,values:Float64Array.from(values)});
const close = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
const style = (patch={}) => ({mode:'same',rangePolicy:'maximum',lut:Array.from({length:256},(_,i)=>[i,0,0]),
  background:[0,0,0],colormap:'red',smoothing:'none',otsu:false,...patch});
function fixture(displayStyle=null) {
  let loads=0;
  const entries=[['a',[0,100,999999,NaN],100],['b',[0,200],200],['c',[0,10000],10000]].map(([sectionId,values,max])=>({
    sectionId,name:sectionId,raster:raster(values),stats:{mean:max/3,max,n:3},displayAuto:{max,rawRange:[0,max]},
    // Both old sources of manual display bounds must be ignored by explicit plans.
    manualWindow:{min:8,max:9},displayWindow:{min:8,max:9}}));
  entries[0].raster.measuredMask=Uint8Array.from([1,1,0,1]);
  const outputPlan={version:1,groups:[{id:'ab',name:'A and B',kind:'compare',sectionIds:['a','b']},
    {id:'only-c',name:'C',kind:'independent',sectionIds:['c']}]};
  const input={projectName:'Synthetic groups',sections:entries.map(entry=>({id:entry.sectionId,name:entry.name})),
    outputPlan,displayStyle,molecules:[{key:'m',name:'M',loadEntries:async()=>{loads++;return entries;}}]};
  return {input,entries,loads:()=>loads};
}
async function pixel(image,x) {
  const decoded=await loadImage(image.data),canvas=createCanvas(image.width,image.height);
  canvas.getContext('2d').drawImage(decoded,0,0);
  return [...canvas.getContext('2d').getImageData(x,0,1,1).data];
}
function assertUnchanged(f,before) {
  assert.equal(JSON.stringify(f.entries),before,'raw measurements, masks, manual ranges and original statistics stay unchanged');
}
async function pooledScopes() {
  const f=fixture(),before=JSON.stringify(f.entries),planBefore=JSON.stringify(f.input.outputPlan);
  const result=await Data.prepare(f.input,options),m=result.molecules[0];
  assert.equal(f.loads(),1,'one measurement load per molecule, not one per output group');
  close(m.outputScales.ab.max,199.4);close(m.outputScales['only-c'].max,9980);
  assert.equal(m.outputScales.ab.sampleCount,4,'masked and nonfinite cells do not affect the pooled percentile');
  assert.equal(m.outputScales.ab.policy,'pooled-p99.8');assert.equal(m.outputScales.ab.upperBasis,'percentile');
  assert.deepEqual(m.sections.map(entry=>entry.outputGroupId),['ab','ab','only-c']);
  assert.deepEqual(m.sections[0].displayWindow,m.sections[1].displayWindow);
  assert.equal(m.sections[0].displayWindow.min,0);close(m.sections[0].displayWindow.max,199.4);
  close(m.sections[2].displayWindow.max,9980);
  assert.deepEqual(await pixel(m.sections[0].image,1),[...Data.colorAt(100,199.4),255]);
  assert.equal((await pixel(m.sections[0].image,2))[3],0,'missing pixels remain transparent');
  assert.equal(m.sections[0].mean,100/3);assert.equal(m.sections[0].n,3,'source-row statistics are not pooled display statistics');
  assertUnchanged(f,before);
  result.outputPlan.groups[0].sectionIds.pop();assert.equal(JSON.stringify(f.input.outputPlan),planBefore,'prepared plan is detached');
  // Raising an independent section must not change another group's image or range.
  f.entries[2].raster.values[1]=1e12;
  const changed=await Data.prepare(f.input,options);
  assert.deepEqual(changed.molecules[0].outputScales.ab,m.outputScales.ab);
  assert.equal(changed.molecules[0].sections[0].image.data,m.sections[0].image.data);
}
async function styledScopes() {
  for(const mode of ['same','individual']) {
    const f=fixture(style({mode})),before=JSON.stringify(f.entries);
    // Original row maximum can exceed a duplicate-coordinate raster average.
    f.entries[1].raster.values[1]=100;
    const modified=JSON.stringify(f.entries),result=await Data.prepare(f.input,options),m=result.molecules[0];
    assert.deepEqual(m.sections.map(entry=>entry.displayWindow),[{min:0,max:200},{min:0,max:200},{min:0,max:10000}]);
    assert.deepEqual(await pixel(m.sections[1].image,1),[128,0,0,255],'uses source auto ceiling, not current UI/manual/raster maximum');
    assert.equal(m.sections[1].max,200);assert.equal(m.outputScales.ab.policy,'display-maximum');
    assertUnchanged(f,modified);assert.notEqual(modified,before);
  }
  const f=fixture(style({mode:'same',rangePolicy:'legacy'}));
  f.input.outputPlan.groups=[{id:'single-compare',name:'One comparison',kind:'compare',sectionIds:['a']},
    {id:'single-independent',name:'Independent',kind:'independent',sectionIds:['b']},
    {id:'c',name:'C',kind:'independent',sectionIds:['c']}];
  f.entries[0].displayAuto={max:60,rawRange:[-2,100]};
  f.entries[1].displayAuto={max:80,rawRange:[-4,100]};
  const result=await Data.prepare(f.input,options),m=result.molecules[0];
  assert.deepEqual(m.sections[0].displayWindow,{min:0,max:60},'a one-section comparison retains comparison semantics');
  assert.deepEqual(m.sections[1].displayWindow,{min:-4,max:80},'an independent legacy section uses its own automatic lower and upper bounds');
  assert.equal(result.outputPlan.groups[0].kind,'compare');
  assert.equal(m.outputScales['single-compare'].policy,'display-adaptive');
}
async function negativeAndUnavailable() {
  const f=fixture(style({rangePolicy:'legacy'}));
  f.entries[0].displayAuto={max:-4,rawRange:[-10,-4]};f.entries[1].displayAuto={max:-2,rawRange:[-8,-2]};
  f.entries[0].raster=raster([-10,-4]);f.entries[1].raster=raster([-8,-2]);
  const m=(await Data.prepare(f.input,options)).molecules[0];
  assert.deepEqual(m.sections.slice(0,2).map(entry=>entry.displayWindow),[{min:-10,max:-2},{min:-10,max:-2}]);
  const empty=fixture(style());
  empty.entries[0].raster=raster([0,0]);empty.entries[0].displayAuto={max:0,rawRange:[0,0]};
  empty.entries[1].raster=raster([-8,-2]);empty.entries[1].displayAuto={max:-2,rawRange:[-8,-2]};
  empty.entries[2].missingReason='Source unavailable';delete empty.entries[2].raster;
  const out=(await Data.prepare(empty.input,options)).molecules[0];
  assert.deepEqual(out.sections[0].displayWindow,{min:0,max:1});assert.ok(out.sections[0].image,'valid all-zero measurements stay visible');
  assert.equal(out.outputScales.ab.available,true);assert.equal(out.outputScales['only-c'].available,false);
  assert.equal(out.sections[2].image,null);assert.equal(out.sections[2].missingReason,'Source unavailable');
  assert.equal(out.sections[2].outputGroupId,'only-c','failed registered entries retain their requested group');
  const invalid=fixture();invalid.entries[1].transform=[[0,0,0],[0,0,0],[0,0,1]];
  const bad=(await Data.prepare(invalid.input,options)).molecules[0];
  close(bad.outputScales.ab.max,99.8);assert.equal(bad.sections[1].image,null,'invalid image transforms do not contribute to a group range');
}
async function ratioScopes() {
  const f=fixture(style()),ratioStyle=style({mode:'individual',rangePolicy:'legacy',ranges:{whole:{same:{max:999},a:{max:9999}}}});
  f.input.molecules[0].kind='ratio';f.input.molecules[0].ratio={denominatorMin:1};f.input.molecules[0].displayStyle=ratioStyle;
  f.entries.forEach((entry,i)=>{entry.displayAuto={max:[10,20,300][i],rawRange:[0,[10,20,300][i]]};
    entry.ratioStatistics={nValid:3,totalRatio:2,mean:2,max:2};entry.ratioRois=[{roiId:'r',name:'ROI',status:'ready',statistics:{nValid:1,totalRatio:3}}];});
  const before=JSON.stringify(f.entries),m=(await Data.prepare(f.input,options)).molecules[0];
  assert.deepEqual(m.sections.map(entry=>entry.displayWindow),[{min:0,max:20},{min:0,max:20},{min:0,max:300}]);
  assert.equal(m.outputScales.ab.policy,'display-adaptive','uses the ratio layer style and its existing automatic ceiling');
  assert.equal(m.sections[0].ratioStatistics.totalRatio,2);assert.equal(m.sections[0].ratioRois[0].statistics.totalRatio,3);
  assert.equal(m.intensityScale.statisticsBasis,'valid-paired-original-rows');assertUnchanged(f,before);
}
async function guards() {
  const invalidPlans=[
    {version:2,groups:[]},
    {version:1,groups:[{id:'a',kind:'independent',sectionIds:['a','b','c']}]},
    {version:1,groups:[{id:'a',kind:'compare',sectionIds:['a','b','b','c']}]},
    {version:1,groups:[{id:'a',kind:'compare',sectionIds:['a','b']}]},
    {version:1,groups:[{id:'a',kind:'compare',sectionIds:['a','b','c','excluded']}]}
  ];
  for(const outputPlan of invalidPlans){const f=fixture();f.input.outputPlan=outputPlan;await assert.rejects(Data.prepare(f.input,options),/比較グループ/);assert.equal(f.loads(),0);}
  const extra=fixture();extra.entries.push({sectionId:'excluded',raster:raster([1])});
  await assert.rejects(Data.prepare(extra.input,options),/対象切片/);
  const noAuto=fixture(style());delete noAuto.entries[0].displayAuto;
  await assert.rejects(Data.prepare(noAuto.input,options),/自動表示範囲/,'manual windows must not conceal missing automatic metadata');
  const frozen=fixture(style()),oldLoad=frozen.input.molecules[0].loadEntries;
  frozen.input.molecules[0].loadEntries=async()=>{frozen.input.outputPlan.groups[0].name='changed while loading';frozen.input.displayStyle.lut[255][0]=0;return oldLoad();};
  const captured=await Data.prepare(frozen.input,options);
  assert.equal(captured.outputPlan.groups[0].name,'A and B');
  assert.deepEqual(await pixel(captured.molecules[0].sections[2].image,1),[255,0,0,255],'palette is frozen before asynchronous source loading');
  const abort=fixture(),controller=new AbortController();
  await assert.rejects(Data.prepare(abort.input,{...options,signal:controller.signal,createCanvas:(w,h)=>{controller.abort();return createCanvas(w,h);}}),error=>error.name==='AbortError');
  assert.equal(abort.loads(),1);
  // One shared allocation is counted once for each registered image, even in
  // different groups. Grouping must not bypass the aggregate safety limit.
  const cap=fixture(),values=new Float32Array(10000001);
  cap.entries[0].raster={W:values.length,H:1,values};cap.entries[1].raster={W:values.length,H:1,values};
  delete cap.entries[0].raster.measuredMask;
  await assert.rejects(Data.prepare(cap.input,options),/2,000万/);
}
(async()=>{await pooledScopes();await styledScopes();await negativeAndUnavailable();await ratioScopes();await guards();
  console.log('Project report grouped data regression: PASS (scoped automatic ranges, original pixels/statistics, snapshots, cancellation and limits)');
})().catch(error=>{console.error(error);process.exitCode=1;});
