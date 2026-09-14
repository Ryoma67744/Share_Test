'use strict';
const assert = require('node:assert/strict');
const { runtime, previewMethod } = require('./viewer-runtime.cjs');
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function fixture() {
  const decodes=[], notifications=[];
  class Image {
    constructor(){this.complete=false;this.naturalWidth=0;this.naturalHeight=0;}
    set src(value){this.url=value;decodes.push(this);}
    finish(ok=true){this.complete=true;if(ok){this.naturalWidth=12;this.naturalHeight=8;this.onload();}else this.onerror(new Error('synthetic decode failure'));}
  }
  const App={viewMode:'compound',focusCompoundKey:'MSI_a',activeSectionId:'s',queueSave(){},broadcastSync(){}};
  const c=runtime({Image,App,Toolbar:{refreshOpacity(){},refreshRange(){}},MSI_LAYER_CACHE_MAX:2,
    _notifyMsiLoadFailed:e=>notifications.push(e),console:{warn(){},log(){}},
    document:{getElementById:()=>null},});
  const p=Object.create(c.Panel.prototype);
  Object.assign(p,{section:{id:'s',meta:{},msiSeries:Object.fromEntries(['a','b','c'].map(k=>['MSI_'+k,{blobId:k}]))},
    project:{},imageSources:{},imageDataUrls:{},imageSettings:{},msiValueRasters:new Map(),
    _msiLoadInFlight:new Map(),_msiLoadErrors:new Map(),_msiLru:new Set(),_thumbDirty:new Set(),
    _thumbPaint:new Map(),visibleLayers:new Set(),
    dom:{},loads:0,paints:0,thumbs:0,painted:null,
    async loadMsiLayer(key){this.loads++;await this.attachImage(key,key);},
    renderMsiThumbnail(){this.thumbs++;},setupCanvasSize(){return false;},
    renderComposite(){
      this.paints++;const k=App.focusCompoundKey;this._ensureDrawableLoaded([k]);
      const img=this.imageSources[k];this.painted=img&&img.complete&&img.naturalWidth>0&&this.imageSettings[k]?k:null;
    },
  });
  return {p,App,c,decodes,notifications};
}
const tests=[
  ['thumbnail decode joined by main view',async()=>{
    const {p,decodes}=fixture();p._thumbDirty.add('MSI_a');p._observeThumb('MSI_a',{});
    await flush();p.renderComposite();let prematurelyReady=false;
    const joined=p.ensureMsiLayerLoaded('MSI_a').then(ok=>{prematurelyReady=ok;return ok;});
    await flush();assert.equal(prematurelyReady,false,'an Image object is not a decoded image');
    assert.equal(p.painted,null);decodes[0].finish();assert.equal(await joined,true);await flush();
    assert.equal(p.loads,1,'requests share the decode');assert.equal(p.painted,'MSI_a','main must repaint without a second user action');
    assert.equal(p.thumbs,1);
  }],
  ['decode failure and explicit retry',async()=>{
    const {p,decodes,notifications}=fixture();const first=p.ensureMsiLayerLoaded('MSI_a');await flush();
    decodes[0].finish(false);assert.equal(await first,false,'decode error is not success');
    assert.equal(p.imageSources.MSI_a,undefined,'broken image is removed');
    p.renderComposite();await flush();assert.equal(p.loads,1,'paint must not automatically retry forever');
    const retry=p.ensureMsiLayerLoaded('MSI_a');await flush();decodes[1].finish();
    assert.equal(await retry,true);assert.equal(p.loads,2);assert.equal(notifications.length,1);
  }],
  ['last selection wins even with reverse completion order',async()=>{
    const {p,App,decodes}=fixture();p.renderComposite();await flush();
    App.focusCompoundKey='MSI_b';p.renderComposite();await flush();
    App.focusCompoundKey='MSI_c';p.renderComposite();await flush();
    const current=p.ensureMsiLayerLoaded('MSI_c');await flush();
    decodes.find(i=>i.url==='MSI_c').finish();await current;await flush();
    decodes.find(i=>i.url==='MSI_a').finish();await flush();
    for(const img of decodes.filter(i=>!i.complete))img.finish();await flush();
    assert.equal(App.focusCompoundKey,'MSI_c');assert.equal(p.painted,'MSI_c');
  }],
  ['destroyed panel receives no decoded image',async()=>{
    const {p,decodes}=fixture();const load=p.ensureMsiLayerLoaded('MSI_a');await flush();p._destroyed=true;
    decodes[0].finish();assert.equal(await load,false);assert.equal(p.imageSources.MSI_a,undefined);
  }],
  ['opacity survives new layers, eviction and pending synchronization',async()=>{
    const {p,App,decodes}=fixture();
    const load=async key=>{const job=p.ensureMsiLayerLoaded(key);await flush();decodes.at(-1).finish();assert.equal(await job,true);};
    await load('MSI_a');p.applyOpacity(40);App.focusCompoundKey='MSI_b';await load('MSI_b');
    assert.equal(p.imageSettings.MSI_b.opacity,.4,'new image inherits section opacity');
    delete p.imageSources.MSI_a;App.focusCompoundKey='MSI_a';await load('MSI_a');
    assert.equal(p.imageSettings.MSI_a.opacity,.4,'reinitialization preserves opacity');
    const f=fixture();f.p.applySyncedField('opacity',40);const pending=f.p.ensureMsiLayerLoaded('MSI_a');await flush();f.decodes[0].finish();await pending;
    assert.equal(f.p.imageSettings.MSI_a.opacity,.4,'unloaded synchronization target retains opacity');
    p.applyOpacity(0);App.focusCompoundKey='MSI_c';await load('MSI_c');assert.equal(p.imageSettings.MSI_c.opacity,0,'zero is a setting');
  }],
  ['Preview override includes late loads and restores on close',async()=>{
    const {p,App,decodes}=fixture();App.panels=new Map([['s',p]]);
    const load=async key=>{const job=p.ensureMsiLayerLoaded(key);await flush();decodes.at(-1).finish();await job;};
    await load('MSI_a');p.applyOpacity(40);const before=JSON.stringify(p.section.meta);
    let raf;const globals={App,requestAnimationFrame:fn=>{raf=fn;return 1;}};
    const preview={_rebakeCellImages(){}};
    for(const method of ['_snapshotOpacity','_applyPreviewOpacity','_restoreOpacity'])preview[method]=previewMethod(method,globals);
    preview._snapshotOpacity();preview._applyPreviewOpacity(.8);raf();
    App.focusCompoundKey='MSI_b';await load('MSI_b');assert.equal(p.imageSettings.MSI_b.opacity,.8);
    preview._restoreOpacity();assert.equal(p.imageSettings.MSI_a.opacity,.4);assert.equal(p.imageSettings.MSI_b.opacity,.4);
    App.focusCompoundKey='MSI_c';await load('MSI_c');assert.equal(p.imageSettings.MSI_c.opacity,.4);
    assert.equal(JSON.stringify(p.section.meta),before,'Preview does not write its temporary opacity');
    const reopened=fixture();reopened.p.section=JSON.parse(JSON.stringify(p.section));
    const job=reopened.p.ensureMsiLayerLoaded('MSI_a');await flush();reopened.decodes[0].finish();await job;
    assert.equal(reopened.p.imageSettings.MSI_a.opacity,.4,'saved section restores opacity');
  }],
  ['real LRU eviction preserves settings',async()=>{
    const {p,App,decodes}=fixture();p.applySyncedField('opacity',40);
    for(const key of ['MSI_a','MSI_b','MSI_c','MSI_a']) {
      App.focusCompoundKey=key;const job=p.ensureMsiLayerLoaded(key);await flush();decodes.at(-1).finish();await job;
      assert.equal(p.imageSettings[key].opacity,.4);
      assert.ok(p._msiLru.size<=2,'cache remains bounded');
      if(key==='MSI_c')assert.equal(p.imageSources.MSI_a,undefined,'first image was really evicted');
    }
  }],
  ['late old source decode cannot replace the new revision',async()=>{
    const {p,decodes}=fixture();const old=p.ensureMsiLayerLoaded('MSI_a');await flush();
    p.section.msiSeries.MSI_a={blobId:'replacement'};
    const current=p.ensureMsiLayerLoaded('MSI_a');await flush();decodes[1].finish();assert.equal(await current,true);
    decodes[0].finish();assert.equal(await old,false);assert.equal(p.imageSources.MSI_a,decodes[1]);
    assert.equal(p.isMsiLayerReady('MSI_a'),true);
  }],
  ['release during parsing cannot commit rasters or derived values',async()=>{
    const {p,c,decodes}=fixture();delete p.loadMsiLayer;
    p.section.msiSeries.MSI_a={blobId:'a',kind:'parquet'};
    let finish;c.parquetSrcForEnt=async()=> 'synthetic';c.buildParquetRaster=()=>new Promise(r=>{finish=r;});
    const before=JSON.stringify(p.section),job=p.ensureMsiLayerLoaded('MSI_a');await flush();
    p.releaseCaches();finish({dataUrl:'ignored',values:new Float32Array([5]),width:1,height:1});
    assert.equal(await job,false);assert.equal(p.msiValueRasters.size,0);assert.equal(decodes.length,0);
    assert.equal(JSON.stringify(p.section),before,'stale parser cannot backfill the old section');
  }],
  ['changing the reader on the same source invalidates an old parse',async()=>{
    const {p,c,decodes}=fixture();delete p.loadMsiLayer;
    p.section.msiSeries.MSI_a={blobId:'a',kind:'parquet',colIdx:1,annotation:'A'};
    let finish;c.parquetSrcForEnt=async()=> 'synthetic';c.buildParquetRaster=()=>new Promise(r=>{finish=r;});
    const job=p.ensureMsiLayerLoaded('MSI_a');await flush();
    p.section.msiSeries.MSI_a.colIdx=2;p.section.msiSeries.MSI_a.annotation='B';
    const before=JSON.stringify(p.section);
    finish({dataUrl:'wrong-column',values:new Float32Array([5]),width:1,height:1});
    assert.equal(await job,false);assert.equal(decodes.length,0);assert.equal(p.msiValueRasters.size,0);
    assert.equal(JSON.stringify(p.section),before,'old column must not overwrite the new selection');
  }],
  ['direct re-bake becomes ready without an extra lazy load',async()=>{
    const {p,c,decodes}=fixture();delete p.loadMsiLayer;
    const ent=p.section.msiSeries.MSI_a={blobId:'a',kind:'parquet',bakeMode:'robust'};
    let parses=0;c.parquetSrcForEnt=async()=> 'synthetic';
    c.buildParquetRaster=async()=>{parses++;return {dataUrl:'synthetic',values:new Float32Array([5]),width:1,height:1};};
    c.msiSourceReference=()=> 'synthetic';c._msiDerivedSig=JSON.stringify;c._msiCellSig=JSON.stringify;c._bumpMethodSeries=()=>{};
    const first=p.ensureMsiLayerLoaded('MSI_a');await flush();decodes[0].finish();assert.equal(await first,true);
    ent.bakeMode='full';assert.equal(p.isMsiLayerReady('MSI_a'),false);
    const rebake=p.loadMsiLayer('MSI_a',ent);await flush();decodes[1].finish();await rebake;
    assert.equal(p.isMsiLayerReady('MSI_a'),true);
    assert.equal(await p.ensureMsiLayerLoaded('MSI_a'),true);assert.equal(parses,2,'ready re-bake is not parsed again');
  }],
];
(async()=>{let failures=0;for(const [name,run]of tests){try{await run();console.log('PASS '+name);}catch(e){failures++;console.error('FAIL '+name+'\n'+e.stack);}}if(failures)process.exitCode=1;})();
