'use strict';
// Execute production modal handlers. The existing harness only adapts image
// decoding, canvas and viewport layout; this suite never replaces fit/edit.
const assert = require('node:assert/strict');
const {harness,plain} = require('./msi_alignment_regression.js');
const Transform = require('../viewer/alignment-transform.js');
const tests = [];
const test = (name,run) => tests.push({name,run});
const I = [[1,0,0],[0,1,0],[0,0,1]];
const points = [[1,1],[5,1],[5,4],[1,4]];
const truth = {flip_lr:false,flip_ud:false,scale_pct:80,rotate_deg:5,offx:0.3,offy:0.4};
const trueT = Transform.fromScalars(truth);
const apply = (T,p) => [T[0][0]*p[0]+T[0][1]*p[1]+T[0][2],T[1][0]*p[0]+T[1][1]*p[1]+T[1][2]];
const current = h => JSON.parse(h.$('[data-he-img]').dataset.tMatrix);
const near = (a,b,tolerance=1e-10) => assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=tolerance,`${a} != ${b}`);
const nearMatrix = (A,B) => {for(let i=0;i<3;i++)for(let j=0;j<3;j++)near(A[i][j],B[i][j]);};
const controls = h => ({scale:Number(h.$('[data-scale-num]').value),rotate:Number(h.$('[data-rotate-num]').value),
  offx:Number(h.$('[data-offx-num]').value),offy:Number(h.$('[data-offy-num]').value)});
function fresh(section) {
  section.meta.alignment = {};
  delete section.meta.world_coords.T_he_to_msi;
  delete section.meta.world_coords.T_he_to_msi_by_source;
}
function clickPosition(h,side,p) {
  const image = h.$(`[data-${side}-img]`), rect = image.getBoundingClientRect();
  // The HE pane shows original pixels even when the registration changes.
  const q = side === 'he' ? p : apply(JSON.parse(image.dataset.displayMatrix),p);
  const ss = Number(image.dataset.ss)||1;
  return {clientX:rect.left+q[0]*ss/image.naturalWidth*rect.width,
    clientY:rect.top+q[1]*ss/image.naturalHeight*rect.height};
}
async function pick(h,side,p) {
  await h.click(`[data-pick="${side}"]`);
  await h.fire(`[data-${side}-img]`,'click',clickPosition(h,side,p));
}
async function pair(h,p,target=apply(trueT,p)) {
  await pick(h,'he',p); await pick(h,'msi',target);
}
async function cancel(h) {h.assertNumericUnchanged();await h.click('[data-modal-cancel]');}
function seeded(record) {
  return section => {
    section.meta.alignment.HE_STAIN.bySource['file-1'] = plain(record);
    section.meta.world_coords.T_he_to_msi = plain(record.T_he_to_msi || Transform.fromScalars(record));
  };
}

test('new automatic drafts wait for three complete pairs; incomplete pairs keep the transform',async()=>{
  const h = await harness({prepare:fresh});
  assert.equal(h.$('[data-auto-fit]').checked,true);
  const initial = current(h);
  await pair(h,points[0]); await pair(h,points[1]);
  assert.deepEqual(current(h),initial);
  assert.equal(h.$('[data-solve]').disabled,false,'two-point Solve remains available explicitly');
  assert.match(h.$('[data-qc]').innerHTML,/2組.*暫定/);
  await pick(h,'he',points[2]);
  assert.deepEqual(current(h),initial);
  await pick(h,'msi',apply(trueT,points[2]));
  nearMatrix(current(h),trueT); near(controls(h).scale,80);
  assert.equal(h.$('[data-auto-fit]').checked,true);
  assert.match(h.$('[data-qc]').innerHTML,/0\.000 px/);
  await cancel(h);
});

test('explicit two-point Solve fits and retains its provisional accuracy label',async()=>{
  const h = await harness({prepare:fresh});
  await pair(h,points[0]); await pair(h,points[1]);
  assert.deepEqual(current(h),I);
  await h.click('[data-solve]');
  nearMatrix(current(h),trueT);
  assert.equal(h.$('[data-auto-fit]').checked,true);
  assert.match(h.$('[data-qc]').innerHTML,/2組.*暫定/);
  await cancel(h);
});

test('manual edits retain their transform on later pairs, and Solve returns to automatic',async()=>{
  const h = await harness({prepare:fresh});
  for(const point of points.slice(0,3))await pair(h,point);
  const before = current(h), anchor = [11/3,2];
  await h.input('[data-scale-num]',96);
  const manual = current(h);
  assert.equal(h.$('[data-auto-fit]').checked,false);
  const a = apply(before,anchor), b = apply(manual,anchor); near(a[0],b[0]); near(a[1],b[1]);
  await pair(h,points[3]);
  assert.deepEqual(current(h),manual);
  assert.match(h.$('[data-qc]').innerHTML,/候補 RMSE: .*未適用/);
  await h.click('[data-solve]');
  nearMatrix(current(h),trueT); assert.equal(h.$('[data-auto-fit]').checked,true);
  await cancel(h);
});

test('tiny scales use numeric and logarithmic controls with the raw HE centroid fixed',async()=>{
  const raw = [[500,500],[2500,500],[3000,1800],[700,2400]], center = [1675,1300];
  const parameters = {...truth,scale_pct:0.15,rotate_deg:10};
  const T = Transform.fromScalars(parameters);
  const h = await harness({prepare:seeded({...parameters,T_he_to_msi:T,
      landmarks:{he:raw,msi:raw.map(p=>apply(T,p))}}),
    images:images=>Object.assign(images.HE_STAIN,{naturalWidth:4000,naturalHeight:3000})});
  near(controls(h).scale,0.15);
  near(Number(h.$('[data-scale]').value),Math.log10(0.15));
  assert.ok(Number(h.$('[data-scale]').min)<Math.log10(0.15));
  const fixed = apply(current(h),center);
  await h.input('[data-scale-num]',0.25);
  near(controls(h).scale,0.25);
  let q = apply(current(h),center); near(q[0],fixed[0]);near(q[1],fixed[1]);
  await h.input('[data-scale]',Math.log10(0.15));
  near(controls(h).scale,0.15);
  q = apply(current(h),center); near(q[0],fixed[0]);near(q[1],fixed[1]);
  assert.equal(h.$('[data-auto-fit]').checked,false);
  await cancel(h);
});

test('invalid scale values preserve the last valid matrix and all dependent offsets',async()=>{
  const h = await harness({prepare:seeded({...truth,T_he_to_msi:trueT,landmarks:{he:[],msi:[]}})});
  const before = current(h);
  for(const invalid of [0,-1,'','NaN','Infinity']) {
    await h.input('[data-scale-num]',invalid);
    assert.deepEqual(current(h),before);
    assert.match(h.$('[data-fit-status]').textContent,/直前の変換を保持/);
    await h.fire('[data-scale-num]','blur');
    near(controls(h).scale,truth.scale_pct);
  }
  await cancel(h);
});

test('a scale slider gesture returning to its start restores the exact canonical matrix',async()=>{
  const parameters = {...truth,scale_pct:0.15,rotate_deg:10};
  const T = Transform.fromScalars(parameters);
  const h = await harness({prepare:seeded({...parameters,T_he_to_msi:T,landmarks:{he:[],msi:[]}}),
    images:images=>Object.assign(images.HE_STAIN,{naturalWidth:4000,naturalHeight:3000})});
  const before = current(h), start = h.$('[data-scale]').value;
  await h.fire('[data-scale]','pointerdown',{pointerId:1,button:0});
  await h.input('[data-scale]',Math.log10(0.25));
  assert.notDeepEqual(current(h),before);
  await h.input('[data-scale]',start);
  await h.fire('[data-scale]','pointerup',{pointerId:1});
  assert.deepEqual(current(h),before,'returning the pointer to its start must not round or migrate the saved transform');
  await cancel(h);
});

test('matrix-only true affine records disable scalar controls and save without projection',async()=>{
  const affine = [[0.8,0.06,0.3],[-0.03,0.7,0.5],[0,0,1]];
  const h = await harness({prepare:seeded({T_he_to_msi:affine,landmarks:{he:[],msi:[]}})});
  assert.deepEqual(current(h),affine);
  for(const selector of ['[data-scale]','[data-scale-num]','[data-rotate-num]','[data-offx-num]','[data-offy-num]','[data-flip-lr]','[data-flip-ud]']) {
    assert.equal(h.$(selector).disabled,true,selector+' must be read-only for a true affine');
  }
  await h.input('[data-scale-num]',50);
  assert.deepEqual(current(h),affine,'even a synthetic input event cannot bypass the affine guard');
  await h.click('[data-save]'); await h.pending;
  assert.equal(h.closed,true);
  assert.deepEqual(h.section.meta.alignment,h.initialSection.meta.alignment);
  assert.deepEqual(h.section.meta.alignment.HE_STAIN.bySource['file-1'].T_he_to_msi,affine);
  h.assertNumericUnchanged();
});

test('matrix-only common imports restore the global canonical matrix and save unchanged',async()=>{
  const T=[[2,0,13],[0,2,-7],[0,0,1]];
  const h=await harness({prepare:section=>{
    fresh(section);section.meta.alignmentSourceMode='__all__';section.meta.perSourceAlign=false;
    section.meta.world_coords.T_he_to_msi=plain(T);
  }});
  assert.equal(h.$('[data-align-source]').value,'__all__');
  assert.deepEqual(current(h),T);near(controls(h).scale,200);near(controls(h).offx,13);near(controls(h).offy,-7);
  await h.click('[data-save]');await h.pending;
  assert.deepEqual(h.section.meta.world_coords.T_he_to_msi,T);
  assert.deepEqual(h.section.meta.alignment,h.initialSection.meta.alignment);
  h.assertNumericUnchanged();
});

test('an unknown common render contract blocks editing instead of seeding identity',async()=>{
  const first=await harness();await first.input('[data-scale-num]',150);await first.click('[data-apply-all]');
  const section=plain(first.section),layer=section.meta.alignment.HE_STAIN;
  layer.renderContract='future-render-contract';
  for(const map of ['byFrame','bySource','sharedByCoordinate','byGroup'])
    for(const record of Object.values(layer[map]||{}))record.renderContract='future-render-contract';
  const h=await harness({section});
  assert.equal(h.$('[data-save]').disabled,true);
  assert.equal(h.$('[data-pick="he"]').disabled,true);
  assert.match(h.$('[data-pick-status]').textContent,/保存済みの位置合わせ設定を確認できません/);
  await h.click('[data-modal-cancel]');assert.equal(h.saves.length,0);
  assert.deepEqual(h.section.meta.alignment,section.meta.alignment);
});

test('explicit Solve converts an affine only after matching landmarks have been chosen',async()=>{
  const affine = [[0.8,0.06,0.3],[-0.03,0.7,0.5],[0,0,1]];
  const h = await harness({prepare:seeded({T_he_to_msi:affine,landmarks:{he:[],msi:[]}})});
  assert.equal(h.$('[data-auto-fit]').checked,false);
  for(const point of points.slice(0,3))await pair(h,point);
  assert.deepEqual(current(h),affine);
  await h.click('[data-solve]');
  nearMatrix(current(h),trueT); assert.equal(h.$('[data-scale-num]').disabled,false);
  assert.equal(h.$('[data-auto-fit]').checked,true);
  await h.click('[data-save]');await h.pending;
  const record = h.section.meta.alignment.HE_STAIN.bySource['file-1'];
  assert.equal(record.transformModel,'similarity');assert.equal(record.fitMode,'automatic');
  assert.equal(record.renderContract,'msi-shared-display-v1');
  assert.equal(record.frame.version,'msi-alignment-frame-v2');nearMatrix(record.T_he_to_msi,trueT);
  h.assertNumericUnchanged();
});

test('matrix-only similarity imports derive controls but preserve exact matrix on unchanged Save',async()=>{
  const h = await harness({prepare:seeded({T_he_to_msi:trueT,landmarks:{he:[],msi:[]}})});
  assert.deepEqual(current(h),trueT);near(controls(h).scale,80);near(controls(h).rotate,5);
  assert.equal(h.$('[data-auto-fit]').checked,false);
  await h.click('[data-save]');await h.pending;
  assert.deepEqual(h.section.meta.alignment,h.initialSection.meta.alignment);
  h.assertNumericUnchanged();
});

test('viewport re-layout preserves fit and QC; clearing points retains the last transform',async()=>{
  const h = await harness({prepare:fresh});
  for(const point of points.slice(0,3))await pair(h,point);
  const before = current(h), qc = h.$('[data-qc]').innerHTML;
  for(const side of ['he','msi']) {
    h.$(`[data-${side}-img]`).clientWidth = 1037;
    h.$(`[data-${side}-img]`).clientHeight = 613;
  }
  await h.window.fire('resize');await h.flush();
  assert.deepEqual(current(h),before);assert.equal(h.$('[data-qc]').innerHTML,qc);
  await h.click('[data-clear-lm]');
  assert.deepEqual(current(h),before);
  assert.match(h.$('[data-pick-status]').textContent,/HE 0 \/ MSI 0/);
  assert.equal(h.$('[data-solve]').disabled,true);
  await cancel(h);
});

test('manual edits and landmark Solve invalidate prior silhouette Dice',async()=>{
  const record = {...truth,T_he_to_msi:trueT,landmarks:{he:points,msi:points.map(p=>apply(trueT,p))},autoAligned:{dice:0.93}};
  for(const action of ['manual','solve']) {
    const h = await harness({prepare:seeded(record)});
    assert.match(h.$('[data-qc]').innerHTML,/Dice 0\.930/);
    if(action==='manual')await h.input('[data-offx-num]',0.8);
    else await h.click('[data-solve]');
    assert.doesNotMatch(h.$('[data-qc]').innerHTML,/Dice/);
    await h.click('[data-save]');await h.pending;
    assert.equal(h.section.meta.alignment.HE_STAIN.bySource['file-1'].autoAligned,null);
    h.assertNumericUnchanged();
  }
});

test('a degenerate automatic fit preserves the current transform and all entered points',async()=>{
  const h = await harness({prepare:fresh});
  const before = current(h);
  for(const target of [[1,1],[3,1],[3,4]])await pair(h,[1,1],target);
  assert.deepEqual(current(h),before);
  assert.match(h.$('[data-pick-status]').textContent,/HE 3 \/ MSI 3/);
  assert.match(h.$('[data-fit-status]').textContent,/直前の変換と対応点を保持/);
  await cancel(h);
});

test('saving freezes landmark and transform edits until storage finishes',async()=>{
  const h=await harness({prepare:fresh});
  for(const p of points.slice(0,3))await pair(h,p);
  await h.click('[data-pick="he"]');
  const before=current(h),status=h.$('[data-pick-status]').textContent;
  const put=h.context.ProjectStorage.putProject;
  let finish,entered;const started=new Promise(resolve=>{entered=resolve;});
  h.context.ProjectStorage.putProject=async(...args)=>{entered();await new Promise(resolve=>{finish=resolve;});return put(...args);};
  const saving=h.click('[data-save]');await started;
  for(const selector of ['[data-pick="he"]','[data-pick="msi"]','[data-scale-num]','[data-auto-fit]','[data-align-msi]'])
    assert.equal(h.$(selector).disabled,true,selector+' is frozen while saving');
  await h.fire('[data-he-img]','click',clickPosition(h,'he',points[3]));
  await h.input('[data-scale-num]',99);await h.click('[data-clear-lm]');
  assert.deepEqual(current(h),before);assert.equal(h.$('[data-pick-status]').textContent,status);
  finish();await saving;await h.pending;
  const saved=h.section.meta.alignment.HE_STAIN.bySource['file-1'];
  assert.equal(saved.landmarks.he.length,3);nearMatrix(saved.T_he_to_msi,before);
  h.assertNumericUnchanged();
});

(async()=>{
  let failures=0;
  for(const {name,run} of tests) {
    try {await run();console.log('PASS '+name);}
    catch(error){failures++;console.error('FAIL '+name+'\n'+(error.stack||error));}
  }
  console.log(`Alignment interaction regression: ${tests.length-failures}/${tests.length} paths passed.`);
  if(failures)process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
