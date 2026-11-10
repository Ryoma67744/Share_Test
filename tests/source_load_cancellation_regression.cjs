'use strict';
const assert=require('node:assert/strict');
const {runtime}=require('./viewer-runtime.cjs');
const SourceLoader=require('../viewer/source-loader.js');
const Scheduler=require('../viewer/section-load-scheduler.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(kind) {
    const fetches=[],rows=new Map(),notifications=[],project={id:'project'},scheduler=Scheduler.create({concurrency:2});
    const loader=SourceLoader.create({storage:{getBlob:async id=>rows.get(id),putBlob:async row=>rows.set(row.id,row)},createId:()=> 'original',
        resolveSource:entry=>({path:entry.storagePath,url:'https://example.test/'+entry.storagePath,kind:entry.kind}),
        fetchBlob:(url,{signal})=>{const gate=deferred();fetches.push({url,signal,...gate});return gate.promise;}});
    const App={project,viewMode:'compound',focusCompoundKey:'MSI_a',shareMode:true,queueSaveDerived(){},
        requestLayerLoad:(panel,key,type,run,options)=>scheduler.enqueue({key:panel.section.id+'|'+key,kind:type,run,panel,automatic:!!options.automatic}),
        promoteLayerLoad:(panel,key,priority=0,automatic=false)=>scheduler.promote(panel.section.id+'|'+key,priority,automatic)};
    class Image {
        set src(value) {this.url=value;queueMicrotask(()=>{this.complete=true;this.naturalWidth=2;this.naturalHeight=1;this.onload?.();});}
    }
    let parseGate=null;
    const c=runtime({App,Image,MSI_LAYER_CACHE_MAX:16,ensureLocalBlob:(entry,owner,options)=>{assert.equal(owner,project);return loader.ensure(entry,options);},
        decodeImageBlobToDataUrl:async()=> 'he-pixels',parseWorkerAvailable:()=>true,
        callParseWorker:async()=>{if(parseGate)await parseGate.promise;return {dataUrl:'msi-pixels',values:new Float64Array([2,6]),rawRange:[2,6],width:2,height:1};},
        msiSourceReference:()=> 'unchanged-reference',_msiDerivedSig:JSON.stringify,_msiCellSig:JSON.stringify,_bumpMethodSeries(){},
        _notifyMsiLoadFailed:error=>notifications.push(error),showToast:message=>notifications.push(message),console:{log(){},warn(){}},
        document:{createElement:()=>({})},get2dContext:()=>({drawImage(){},getImageData:()=>({data:[2,2,2,255]})})});
    const key=kind==='image'?'HE_STAIN':'MSI_a';
    function panel(id) {
        const entry={kind:kind==='image'?'image':'txt',storagePath:'project/publish-v2/one/source',filename:'source'};loader.reserve(entry);
        const p=Object.create(c.Panel.prototype);
        Object.assign(p,{project,section:{id,meta:{},images:kind==='image'?{[key]:entry}:{},msiSeries:kind==='image'?{}:{[key]:entry}},
            imageSources:{},imageDataUrls:{},imageSettings:{},msiValueRasters:new Map(),_loadEpoch:0,
            _msiLoadInFlight:new Map(),_msiLoadErrors:new Map(),_msiLru:new Set(),_thumbDirty:new Set(),visibleLayers:new Set(),dom:{}});
        return p;
    }
    return {panel,key,loader,scheduler,fetches,notifications,rows,setParseGate:gate=>parseGate=gate};
}
async function sameOriginalConsumers(kind) {
    const f=fixture(kind),a=f.panel('a'),b=f.panel('b');
    const first=a.ensureLayerLoaded(f.key,{automatic:true}),second=b.ensureLayerLoaded(f.key,{automatic:true});
    // HE's image lane is intentionally one at a time, so an explicit source
    // consumer models ZIP/report while that HE is pending.
    const extra=kind==='image'?f.loader.ensure(b.section.images[f.key]):null;
    await tick();assert.equal(f.fetches.length,1);
    f.scheduler.cancelWhere(job=>job.panel===a);
    assert.equal(await first,false);assert.equal(f.fetches[0].signal.aborted,false,'another source consumer retains the download');
    f.fetches[0].resolve(new Blob(['x,y,A\n0,0,2\n1,0,6']));
    if(extra)await extra;
    assert.equal(await second,true);assert.equal(f.fetches.length,1);
    assert.equal(a.imageSources[f.key],undefined);assert.ok(b.imageSources[f.key]);assert.equal(f.notifications.length,0);
    assert.equal(a._msiLoadErrors.size,0);assert.equal(a._imageLoadErrors?.size||0,0);
    f.scheduler.dispose();await f.loader.dispose();
}
async function cancelAndImmediatelyRequestAgain(kind) {
    const f=fixture(kind),p=f.panel('a'),first=p.ensureLayerLoaded(f.key,{automatic:true});await tick();
    f.scheduler.cancelWhere(job=>job.automatic);
    // Do not await the old promise: this exercises the in-flight slot before
    // its completion cleanup, with exactly the same scientific identity.
    const retry=p.ensureLayerLoaded(f.key,{automatic:true,retry:false});assert.notEqual(first,retry);
    assert.equal(await first,false);await tick();assert.equal(f.fetches[0].signal.aborted,true);
    assert.equal(f.fetches.length,2);f.fetches[1].resolve(new Blob(['fresh original']));
    assert.equal(await retry,true);f.fetches[0].resolve(new Blob(['obsolete original']));await tick();
    assert.equal(await f.rows.get('original').blob.text(),'fresh original');assert.equal(f.notifications.length,0);
    f.scheduler.dispose();await f.loader.dispose();
}
async function explicitJoinKeepsAutomaticSource(kind) {
    const f=fixture(kind),p=f.panel('a'),automatic=p.ensureLayerLoaded(f.key,{automatic:true});await tick();
    const explicit=p.ensureLayerLoaded(f.key,{automatic:false});assert.equal(automatic,explicit);
    f.scheduler.cancelWhere(job=>job.automatic);assert.equal(f.fetches[0].signal.aborted,false);
    f.fetches[0].resolve(new Blob(['required by export']));assert.equal(await explicit,true);assert.equal(f.notifications.length,0);
    f.scheduler.dispose();await f.loader.dispose();
}
async function staleParseDoesNotCommit() {
    const f=fixture('msi'),p=f.panel('a'),parseGate=deferred();f.setParseGate(parseGate);
    const before=JSON.stringify(p.section),load=p.ensureLayerLoaded(f.key,{automatic:true});await tick();
    f.fetches[0].resolve(new Blob(['source']));await tick();f.scheduler.cancelWhere(job=>job.automatic);assert.equal(await load,false);
    parseGate.resolve();await tick();assert.equal(p.msiValueRasters.size,0);assert.equal(p.imageSources[f.key],undefined);
    assert.equal(JSON.stringify(p.section),before,'cancelled parse cannot backfill numerical metadata');assert.equal(f.notifications.length,0);
    f.scheduler.dispose();await f.loader.dispose();
}
async function main() {
    for(const kind of ['msi','image']) {await sameOriginalConsumers(kind);await cancelAndImmediatelyRequestAgain(kind);await explicitJoinKeepsAutomaticSource(kind);}
    await staleParseDoesNotCommit();
    console.log('Source load cancellation regression: PASS (real scheduler/panel/source chain, MSI+HE retry, explicit consumers and stale parse)');
}
const watchdog=setTimeout(()=>{console.error('Source load cancellation regression timed out');process.exitCode=1;},10000);
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
