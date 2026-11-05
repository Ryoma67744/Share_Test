'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Settings = require('../viewer/msi-display-settings.js');
const {html, standalone} = require('./viewer-runtime.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object') {Object.freeze(value); for (const item of Object.values(value)) freeze(item);}
  return value;
};

assert.equal(Settings.VERSION, 1);
for (const value of [null, undefined, false, '', {}, {version:0}, {version:2}, {version:'1'}])
  assert.equal(Settings.normalize(value), null, 'Missing/unknown schema versions never silently migrate');
const malformed = freeze({version:1,preset:'unknown',aspectMode:'unknown',rangePolicy:'unknown',extra:'ignored'});
assert.deepEqual(Settings.normalize(malformed), {version:1,preset:'current',aspectMode:'legacy',rangePolicy:'legacy'});
const old = freeze({id:'old',meta:{colormap:'viridis',msiSmoothing:'linear',memo:{text:'keep'}},
  sections:[{meta:{world_coords:{msi_um_per_px:{x:30,y:60}}},sourceRows:[[0,0,0],[1,0,123]]}],rois:[{points:[[0,0],[1,1]]}]});
const oldBytes = JSON.stringify(old);
assert.deepEqual(Settings.resolve(old), {version:1,preset:'current',aspectMode:'legacy',rangePolicy:'legacy',
  explicit:false,colormap:'viridis',interpolation:'linear'});
assert.equal(Settings.resolve({meta:{msiDisplay:{version:99,preset:'hdi'}}}).aspectMode, 'legacy');
assert.equal(JSON.stringify(old), oldBytes, 'Reading old display preferences never writes a migration or measurement');

const fresh = Settings.newProjectMeta();
assert.deepEqual(fresh, {msiDisplay:{version:1,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum'},
  colormap:'hotmetal',msiSmoothing:'none'});
const newResolved = Settings.resolve({meta:fresh});
assert.equal(newResolved.explicit, true);
assert.equal(newResolved.interpolation, 'none');
fresh.msiDisplay.aspectMode = 'legacy';
assert.equal(Settings.newProjectMeta().msiDisplay.aspectMode, 'physical', 'New projects own independent settings objects');

const transient = freeze({...Settings.preset('hdi'),colormap:'inferno',interpolation:'none'});
assert.deepEqual(Settings.resolve(old, transient), {version:1,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum',
  explicit:true,colormap:'inferno',interpolation:'none'});
assert.deepEqual(Settings.resolve(old, {version:999,preset:'hdi',colormap:'jet',interpolation:'none'}), Settings.resolve(old),
  'An unsupported override schema is ignored as a whole');
assert.equal(JSON.stringify(old), oldBytes, 'Transient overrides do not mutate saved project metadata');
const result = Settings.resolve(old, transient); result.aspectMode = 'legacy';
assert.equal(Settings.resolve(old, transient).aspectMode, 'physical', 'Resolved preferences do not alias their input');
assert.equal(Settings.preset('current').rangePolicy, 'legacy');
assert.equal(Settings.preset('current').aspectMode, 'legacy');
assert.equal(Settings.preset('hdi','legacy').aspectMode, 'legacy', 'A chosen aspect can be retained explicitly');

const lut = Settings.hotMetalLut();
assert.equal(lut.length,256);
assert.deepEqual(lut[0],[0,0,0]); assert.deepEqual(lut[255],[255,255,165]);
for (const rgb of lut) assert.ok(rgb.length===3 && rgb.every(v=>Number.isInteger(v)&&v>=0&&v<=255));
const knots = Settings.hotMetalLut(12);
assert.deepEqual([knots[0],knots[3],knots[6],knots[9],knots[11]],
  [[0,0,0],[0,0,255],[255,0,0],[255,255,0],[255,255,165]], 'HotMetal is black→blue→red→yellow→pale yellow');
assert.deepEqual(Settings.hotMetalLut(1),[[0,0,0]]);
lut[0][0]=99;
assert.deepEqual(Settings.hotMetalLut()[0],[0,0,0], 'LUT arrays do not share mutable pixels');

function method(name) {
  const appStart=html.indexOf('const App = {');
  let start=html.indexOf('    '+name+'(',appStart);
  if(start<0)start=html.indexOf('    async '+name+'(',appStart);
  assert.ok(start>=appStart,'Production App method exists: '+name);
  return html.slice(start,html.indexOf('\n    },',start)+6);
}
function fixture(storage=new Map()) {
  const nodes=new Map(),calls={save:0,resize:0,render:0,rois:0,recompute:0};
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:false});return nodes.get(id);}};
  const context=vm.createContext({MsiDisplaySettings:Settings,document,
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    setActiveColormap:map=>{calls.colormap=map;},showToast(){},
    Toolbar:{refreshRange(){},refreshOutlierClip(){}},SharePreview:{isOpen:()=>false}});
  vm.runInContext(standalone('msiDisplayContextKey')+'\n'+standalone('ensureMsiDisplayContext')+'\n'+
    'globalThis.app={'+['getMsiDisplaySettings','refreshMsiDisplayControls','updateMsiDisplaySettings',
      'setMsiDisplayPreset','setMsiOutlierClipAll','getMsiWindow','getMsiAbsMax','_organInScope'].map(method).join(',')+'};',context);
  const app=context.app;
  app.project=plain(old);app.project.sections[0].id='section';app.project.sections[0].msiSeries={};
  app.panels=new Map([['section',{section:app.project.sections[0],setupCanvasSize(){calls.resize++;},
    renderComposite(){calls.render++;},markAllThumbsDirty(){},drawAllRois(){calls.rois++;}}]]);
  app.queueSave=()=>{calls.save++;};app.recomputeMsiAbsScale=()=>{calls.recompute++;};app._bumpBakeModeVersion=()=>{};
  app.msiUserWindow={MSI_a:{min:10,max:50}};app.msiScaleMode='individual';app.otsuBgRemove=true;
  app.setOtsuBgRemove=async value=>{app.otsuBgRemove=value;};
  return {app,calls,nodes,storage,context};
}

async function main() {
  const local=fixture(),{app,calls,nodes}=local,science=JSON.stringify({sections:app.project.sections,rois:app.project.rois});
  app.getMsiDisplaySettings();app.refreshMsiDisplayControls();
  assert.equal(calls.save,0,'Opening an old project does not automatically persist display defaults');
  await app.setMsiDisplayPreset('hdi');
  assert.equal(app.getMsiDisplaySettings().preset,'hdi');
  assert.equal(app.project.meta.msiDisplay.aspectMode,'physical');
  assert.equal(app.project.meta.colormap,'hotmetal');assert.equal(app.msiSmoothing,'none');
  assert.equal(app.msiScaleMode,'same');assert.deepEqual(plain(app.msiUserWindow),{});
  assert.equal(app.otsuBgRemove,false);assert.ok(calls.save>0&&calls.resize>0&&calls.rois>0);
  assert.equal(nodes.get('tb-msi-physical').checked,true);
  assert.equal(JSON.stringify({sections:app.project.sections,rois:app.project.rois}),science,
    'Preset changes leave calibration, source rows and ROI vertices intact');
  await app.setMsiDisplayPreset('current');
  assert.equal(app.getMsiDisplaySettings().preset,'current','Current preset remains selected after restoring legacy clipping');
  assert.equal(nodes.get('tb-msi-style').value,'current');

  const shared=fixture();shared.app.project.__share=true;shared.app.shareMode={slug:'sample',role:'viewer',token:'one'};
  const source=JSON.stringify(shared.app.project);
  await shared.app.setMsiDisplayPreset('hdi');
  assert.equal(shared.calls.save,0);assert.equal(JSON.stringify(shared.app.project),source,'Shared style is session-only');
  assert.equal(shared.app.getMsiDisplaySettings().preset,'hdi');
  shared.app.shareMode.role='admin';
  assert.equal(shared.app.getMsiDisplaySettings().preset,'current','Viewer settings do not silently cross the role boundary');
  shared.app.updateMsiDisplaySettings({...Settings.preset('current'),colormap:'jet'},false);
  shared.app.shareMode.role='viewer';shared.app.shareMode.token='refreshed';
  assert.equal(shared.app.getMsiDisplaySettings().preset,'hdi','Refreshing credentials preserves the same role display choice');
  shared.app.shareMode.slug='other';
  assert.equal(shared.app.getMsiDisplaySettings().preset,'current','Other shared projects start from their own defaults');
  const reload=fixture(shared.storage);reload.app.project.__share=true;reload.app.shareMode={slug:'sample',role:'viewer',token:'new'};
  assert.equal(reload.app.getMsiDisplaySettings().preset,'hdi','A reload restores the same share/role session choice');
  assert.equal(JSON.stringify(shared.app.project),source);assert.equal(shared.calls.save,0);
  // Exercise the production numeric range path separately from project/session
  // switching. Display fallback bounds must never rewrite a measured zero or
  // negative source statistic, and manual values still override either edge.
  const ranges=fixture();ranges.context.ensureMsiDisplayContext=()=>{};
  ranges.app.project.meta=Settings.newProjectMeta();ranges.app.msiUserWindow={};
  const section=ranges.app.project.sections[0],key='MSI_signal';
  for (const maximum of [-7,0,120]) {
    const entry={rawRange:[-20,200],rawDispMax:60,rawTrueMax:maximum,sourceStats:{n:3,mean:-2,max:maximum}};
    section.msiSeries={[key]:entry};const original=JSON.stringify(entry);
    assert.equal(ranges.app.getMsiAbsMax(key),Math.max(0,maximum));
    for(const mode of ['same','individual']) {
      ranges.app.msiScaleMode=mode;
      assert.deepEqual(plain(ranges.app.getMsiWindow(key,entry.rawRange,entry.rawDispMax,entry.rawTrueMax)),
        {min:0,max:maximum>0?maximum:1},'Maximum mode uses a finite [0,1] window for nonpositive data');
      ranges.app.msiUserWindow[key]={min:-25,max:300};
      assert.deepEqual(plain(ranges.app.getMsiWindow(key,entry.rawRange,entry.rawDispMax,entry.rawTrueMax)),
        {min:-25,max:300},'Manual raw values override the maximum policy');
      delete ranges.app.msiUserWindow[key];
    }
    assert.equal(JSON.stringify(entry),original,'Display range calculation preserves original source statistics');
  }
  // Restoring the Current preset can await a slow re-bake. A later manual
  // display choice belongs to the user and must survive that completion.
  const racing=fixture();racing.app.otsuBgRemove=false;
  racing.app.project.sections[0].msiSeries={MSI_a:{bakeMode:'full',diag:{bakeMode:'full'},
    rawRange:[0,100],rawDispMax:100,rawTrueMax:100,sourceStats:{n:2,mean:50,max:100}}};
  const originalStatistics=JSON.stringify(racing.app.project.sections[0].msiSeries.MSI_a.sourceStats);
  let releaseRebake,rebakeStarted=false;
  racing.app._rebakeJobs=async()=>{
    rebakeStarted=true;
    await new Promise(resolve=>{releaseRebake=resolve;});
  };
  const applying=racing.app.setMsiDisplayPreset('current');
  assert.equal(rebakeStarted,true,'The test suspends the actual preset re-bake path');
  assert.equal(racing.app.getMsiDisplaySettings().preset,'current','Preset re-bake does not relabel Current as Custom');
  racing.app.updateMsiDisplaySettings({preset:'custom',colormap:'viridis',aspectMode:'physical',interpolation:'linear'});
  const latest=plain(racing.app.getMsiDisplaySettings()),saveCount=racing.calls.save;
  releaseRebake();await applying;
  assert.deepEqual(plain(racing.app.getMsiDisplaySettings()),latest,
    'A completed preset re-bake cannot overwrite newer palette, aspect or interpolation choices');
  assert.equal(racing.calls.save,saveCount,'Completing a stale display operation does not queue a settings overwrite');
  assert.equal(JSON.stringify(racing.app.project.sections[0].msiSeries.MSI_a.sourceStats),originalStatistics,
    'Concurrent display choices preserve the original source statistics');
  console.log('MSI display settings, HDI defaults, old-project preservation, role-scoped overrides and HotMetal: PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
