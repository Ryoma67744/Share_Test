'use strict';
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {runtime,previewMethod,html}=require('./viewer-runtime.cjs');
const {create}=require('../viewer/section-load-scheduler.js');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(){
  const decodes=[],reads=[];let decodeBlob;
  class Image {set src(url){this.url=url;decodes.push(this);} finish(){this.complete=true;this.naturalWidth=4;this.naturalHeight=3;this.onload();}}
  const project={id:'original'},App={project},scheduler=create();
  App.requestLayerLoad=(p,key,kind,run)=>scheduler.enqueue({key,kind,run});
  const c=runtime({App,Image,ensureLocalBlob:async(ent,p)=>{reads.push(p);return {blob:ent.blobId,mime:'image/png'};},
    document:{createElement:()=>({})},get2dContext:()=>({drawImage(){},getImageData:()=>({data:[40,80,120,255]})}),
    decodeImageBlobToDataUrl:blob=>decodeBlob?decodeBlob(blob):Promise.resolve('data:'+blob)});
  const p=Object.create(c.Panel.prototype);
  Object.assign(p,{project,section:{id:'section',images:{HE_STAIN:{blobId:'first'}},meta:{layerDisplay:{HE_STAIN:{vmin:4,vmax:90}}}},
    imageSources:{},imageDataUrls:{},imageSettings:{},_loadEpoch:0,
    renderComposite(){}});
  App.panels=new Map([['section',p]]);
  const start=html.indexOf('    setHeGrayscaleAll(on) {');
  App.setHeGrayscaleAll=vm.runInContext('({'+html.slice(start,html.indexOf('\n    },',start)+6)+'})',c).setHeGrayscaleAll;
  const preview={_rebakeCellImages(){}};
  for(const method of ['_snapshotGrayscale','_applyHeGrayscale','_restoreGrayscale'])preview[method]=previewMethod(method,{App});
  return {p,App,preview,reads,decodes,setDecoder:fn=>decodeBlob=fn};
}
async function main(){
  const f=fixture(),a=f.p.ensureImageLayerLoaded('HE_STAIN'),b=f.p.ensureImageLayerLoaded('HE_STAIN');
  assert.equal(a,b);await flush();assert.equal(f.decodes.length,1);assert.equal(f.p.imageDataUrls.HE_STAIN,undefined);
  f.decodes[0].finish();assert.equal(await a,true);assert.equal(f.p.isImageLayerReady('HE_STAIN'),true);
  assert.equal(f.p.imageSettings.HE_STAIN.vmin,4);assert.equal(f.p.imageSettings.HE_STAIN.vmax,90);
  assert.equal(await f.p.ensureImageLayerLoaded('HE_STAIN'),true);assert.equal(f.reads.length,1);
  const g=fixture();let done;g.setDecoder(()=>new Promise(r=>done=r));
  const old=g.p.ensureImageLayerLoaded('HE_STAIN');await flush();g.App.project={id:'another'};g.p._loadEpoch++;
  done('stale');assert.equal(await old,false);assert.equal(g.decodes.length,0);assert.equal(g.reads[0],g.p.project,'blob repair captures its own project');
  const h=fixture(),loading=h.p.ensureImageLayerLoaded('HE_STAIN');await flush();h.p.section.images.HE_STAIN={blobId:'replacement'};
  h.decodes[0].finish();assert.equal(await loading,false);assert.equal(h.p.imageSources.HE_STAIN,undefined);
  const retry=h.p.ensureImageLayerLoaded('HE_STAIN');await flush();h.decodes[1].finish();assert.equal(await retry,true);
  assert.equal(h.p.imageDataUrls.HE_STAIN,'data:replacement');
  const gone=fixture(),job=gone.p.ensureImageLayerLoaded('HE_STAIN');await flush();gone.p._destroyed=true;
  gone.decodes[0].finish();assert.equal(await job,false);assert.equal(gone.p.imageDataUrls.HE_STAIN,undefined);

  const mono=fixture(),mainPending=mono.p.ensureImageLayerLoaded('HE_STAIN');await flush();
  const unchanged=JSON.stringify(mono.p.section.meta);
  mono.App.setHeGrayscaleAll(true);
  mono.decodes[0].finish();assert.equal(await mainPending,true);
  assert.equal(mono.p.imageSettings.HE_STAIN.grayscale,true,'main Mono intent reaches an image decoded later');
  assert.equal(JSON.stringify(mono.p.section.meta),unchanged,'transient Mono does not change persisted settings');

  const live=fixture(),previewPending=live.p.ensureImageLayerLoaded('HE_STAIN');await flush();
  live.preview._snapshotGrayscale();live.preview._applyHeGrayscale(true);
  live.decodes[0].finish();assert.equal(await previewPending,true);
  assert.equal(live.p.imageSettings.HE_STAIN.grayscale,true,'Preview Mono applies during a pending decode');
  live.preview._restoreGrayscale();
  assert.equal(live.p.imageSettings.HE_STAIN.grayscale,false,'close restores a layer first decoded in Preview');
  assert.equal(live.p._heGrayscaleIntent,undefined,'Preview intent is removed on close');

  const early=fixture(),earlyPending=early.p.ensureImageLayerLoaded('HE_STAIN');await flush();
  early.App.setHeGrayscaleAll(true);
  early.preview._snapshotGrayscale();early.preview._applyHeGrayscale(false);early.preview._restoreGrayscale();
  early.decodes[0].finish();assert.equal(await earlyPending,true);
  assert.equal(early.p.imageSettings.HE_STAIN.grayscale,true,'closing before decode restores the prior main Mono intent');

  const saved=fixture();saved.p.section.meta.layerDisplay.HE_STAIN.grayscale=true;
  const savedPending=saved.p.ensureImageLayerLoaded('HE_STAIN');await flush();
  saved.preview._snapshotGrayscale();saved.preview._applyHeGrayscale(false);
  saved.decodes[0].finish();assert.equal(await savedPending,true);
  saved.preview._restoreGrayscale();
  assert.equal(saved.p.imageSettings.HE_STAIN.grayscale,true,'registered pending layer restores its persisted grayscale');
  assert.equal(saved.p.section.meta.layerDisplay.HE_STAIN.grayscale,true,'Preview never changes persisted grayscale');
  console.log('Image load lifecycle regression: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
