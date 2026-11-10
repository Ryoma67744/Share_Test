'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../viewer/tic-core.js');
const Runtime = require('../viewer/tic-runtime.js');
const Cache = require('../viewer/tic-cache.js');
const AnalysisCore = require('../viewer/msi-analysis-core.js');
const AnalysisWorker = require('../viewer/msi-analysis-worker.js');
const html = fs.readFileSync(path.join(__dirname,'../viewer/index.html'),'utf8');
const tick = () => new Promise(resolve=>setImmediate(resolve));
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

// Independent reference for the previous _generateSyntheticTic + finalizer math.
function legacy(layers,w,h) {
    const accum=new Float64Array(w*h),count=new Uint32Array(w*h);
    for(const layer of layers){
        if(layer.width!==w||layer.height!==h)continue;
        const rr=layer.rawRange;
        for(let i=0;i<w*h;i++){
            if(layer.values&&Array.isArray(rr)&&Number.isFinite(rr[0])&&rr[1]>rr[0]){
                const v=layer.values[i];if(!Number.isFinite(v))continue;
                accum[i]+=Math.round(Math.max(0,Math.min(1,(v-rr[0])/(rr[1]-rr[0])))*255);
            }else{const j=i*4,d=layer.pixels;if(!d||!d[j+3])continue;accum[i]+=.299*d[j]+.587*d[j+1]+.114*d[j+2];}
            count[i]++;
        }
    }
    let max=0;for(let i=0;i<count.length;i++)if(count[i])max=Math.max(max,accum[i]/count[i]);
    const result=new Uint8ClampedArray(w*h*4),norm=max>0?255/max:0;
    for(let i=0;i<count.length;i++)if(count[i]){const g=Math.max(0,Math.min(255,Math.round(accum[i]/count[i]*norm)));result.set([g,g,g,255],i*4);}
    return result;
}
function numeric() {
    const cases=[
        [{values:new Float64Array([0,4,NaN,100]),rawRange:[0,10]},{values:new Float64Array([-1,20,NaN,1]),rawRange:[-1,20]}],
        [{values:new Float64Array([0,0,NaN,0]),rawRange:[0,1]},{values:new Float64Array([7,7,NaN,7]),rawRange:[0,7]}],
        [{pixels:new Uint8ClampedArray([100,20,30,255,1,2,3,0,255,255,255,255,0,0,0,255])},
         {values:new Float64Array([5,4,NaN,1]),rawRange:[1,5]}]
    ];
    for(const layers of cases){layers.forEach(l=>{l.width=2;l.height=2;});const state=Core.create(2,2);layers.forEach(l=>Core.accumulate(state,l));assert.deepEqual(Core.finish(state).pixels,legacy(layers,2,2));}
    const state=Core.create(2,2);assert.equal(Core.accumulate(state,{width:3,height:1,values:new Float64Array(3),rawRange:[0,1]}),false);assert.equal(Core.finish(state),null);
    assert.throws(()=>Core.create(0,1));
}
function signatures() {
    const scope={project:'p',section:'s',shared:false},entries=[{key:'MSI_A',entry:{kind:'raw',blobId:'b1',func:1,channel:0,snap:true,bakeMode:'robust'}},{key:'MSI_B',entry:{kind:'txt',blobId:'b2',x:'x',y:'y',v:'b'}}];
    const sig=items=>Core.describe(scope,items,{w:2,h:2},{parser:'v1'});
    const base=sig(entries);assert.equal(base.durable,true);
    for(const [field,value] of [['blobId','changed'],['snap',false],['channel',2],['range',[0,8]],['bakeMode','full'],['sourceRevision','v2'],['sep',',']]){
        const changed=structuredClone(entries);changed[0].entry[field]=value;assert.notEqual(sig(changed).signature,base.signature,field);
    }
    const ui=structuredClone(entries);Object.assign(ui[0].entry,{rawMean:9,rawRange:[0,7],rasterW:2,compoundMeta:{name:'new name'}});assert.equal(sig(ui).signature,base.signature);
    assert.notEqual(sig([...entries].reverse()).signature,base.signature);
    assert.equal(Core.describe({...scope,shared:true},[{key:'MSI_A',entry:{sourceUrl:'https://example.test/old'}}],{w:2,h:2},{}).durable,false);
    assert.equal(Core.describe({...scope,shared:true},[{key:'MSI_A',entry:{storagePath:'p/publish-v2/revision/source'}}],{w:2,h:2},{}).durable,true);
}
function source(name) {
    let start=html.indexOf('async function '+name+'(');
    if(start<0)start=html.indexOf('function '+name+'(');
    assert.ok(start>=0,'production function '+name);
    return html.slice(start,html.indexOf('\n}',start)+2);
}
async function worker() {
    const build=source('_buildParseWorkerSource');
    const names=build.match(/const fns = \[([\s\S]*?)\];/)[1].split(',').map(x=>x.trim()).filter(Boolean);
    const c=vm.createContext({console,TextDecoder,TextEncoder,Blob,structuredClone,TicCore:Core,MsiAnalysisCore:AnalysisCore,MsiAnalysisWorker:AnalysisWorker,PARSE_WORKER_LIBS:[],MSI_ROBUST_PERCENTILE:.998,MSI_DEFAULT_DISPLAY_PERCENTILE:.99});
    vm.runInContext(names.map(source).join('\n')+'\n'+build,c);
    const generated=vm.runInContext('_buildParseWorkerSource()',c);
    const responses=[];
    const w=vm.createContext({console,TextDecoder,TextEncoder,Blob,structuredClone,importScripts(){},self:{postMessage:r=>responses.push(r)}});
    vm.runInContext(generated,w);
    // Verify real generated worker code; replace only PNG encoding (no canvas in Node).
    vm.runInContext('_encodePixelsToDataUrl = async (w,h,p) => JSON.stringify(Array.from(p));',w);
    const blob=new Blob(['x,y,A,B\n0,0,0,10\n1,0,20,2\n0,1,,3\n1,1,5,0']);
    let id=0;
    const call=async(op,payload)=>{await w.self.onmessage({data:{id:++id,op,payload}});const msg=responses.pop();assert.equal(msg.ok,true,msg.error);return msg.result;};
    const rasters=[];
    for(const v of ['A','B'])rasters.push(await call('txt-raster',{blob,def:{kind:'txt',x:'x',y:'y',v,bakeMode:'full'}}));
    const probe=await call('tic-probe',{rasterOp:'txt-raster',blob,def:{kind:'txt',x:'x',y:'y',v:'A',bakeMode:'full'}});
    assert.equal(probe.width,rasters[0].width);assert.equal(probe.height,rasters[0].height);
    assert.equal(probe.dataUrl,undefined,'geometry probe must not encode an MSI PNG');
    await call('tic-begin',{jobId:'a',width:rasters[0].width,height:rasters[0].height});
    for(const v of ['A','B'])assert.equal((await call('tic-step',{jobId:'a',rasterOp:'txt-raster',blob,def:{kind:'txt',x:'x',y:'y',v,bakeMode:'full'}})).contributed,true);
    const result=await call('tic-finish',{jobId:'a'});
    assert.deepEqual(JSON.parse(result.dataUrl),Array.from(legacy(rasters,result.width,result.height)));
    assert.equal(w.self.__ticJobs.size,0);
    await call('tic-dispose',{jobId:'does-not-exist'});
}
function spec(overrides={}) {
    return {signature:'s1',durable:true,width:2,height:2,entries:[{key:'A'},{key:'B'}],current:()=>true,available:()=>true,
        step:(_key,run)=>run(),source:async entry=>entry,decodeCache:async row=>row.data,
        encodeCache:data=>({size:1,data}),accept:async()=>true,
        call:async(op)=>op==='tic-finish'?{dataUrl:'png',width:2,height:2}:op==='tic-step'?{contributed:true}:{ok:true},...overrides};
}
async function runtime() {
    const stored=new Map(),calls=[],cache={get:async key=>stored.get(key),put:async(key,blob)=>{stored.set(key,{data:blob.data});return true;},remove:async key=>stored.delete(key)};
    const r=Runtime.create({cache}),owner={};
    const s=spec({call:async(op)=>{calls.push(op);return op==='tic-finish'?{dataUrl:'png',width:2,height:2}:{contributed:true};}});
    assert.equal(await r.ensure(owner,s),true);assert.equal(owner._ticJob.state,'ready');assert.equal(stored.size,1);
    assert.equal(calls.filter(x=>x==='tic-step').length,2);
    const second=Runtime.create({cache}),o2={};assert.equal(await second.ensure(o2,s),true);assert.equal(o2._ticJob.cacheHit,true);assert.equal(calls.filter(x=>x==='tic-step').length,2);

    let writes=0;const incomplete=Runtime.create({cache:{get:async()=>null,put:async()=>{writes++;},remove:async()=>{}}}),io={};
    assert.equal(await incomplete.ensure(io,spec({call:async op=>op==='tic-finish'?{dataUrl:'partial',width:2,height:2}:{contributed:false}})),true);
    assert.equal(io._ticJob.state,'incomplete');assert.equal(writes,0);

    const gate=deferred(),co={},ops=[],cancelled=Runtime.create();
    const pending=cancelled.ensure(co,spec({call:async op=>{ops.push(op);if(op==='tic-begin')return gate.promise;return {contributed:true};}}));
    await tick();cancelled.cancel(co);gate.resolve({started:true});assert.equal(await pending,false);assert.ok(ops.includes('tic-dispose'),'begin cancellation frees worker accumulator');assert.ok(!ops.includes('tic-step'));

    const g=deferred(),changing=Runtime.create(),changed={};let alive=true,accepted=0;
    const stale=changing.ensure(changed,spec({current:()=>alive,call:async op=>op==='tic-finish'?g.promise:{contributed:true},accept:async()=>{accepted++;return true;}}));
    await tick();alive=false;g.resolve({dataUrl:'stale',width:2,height:2});assert.equal(await stale,false);assert.equal(accepted,0);

    const retry=Runtime.create(),retryOwner={};let available=false;
    assert.equal(await retry.ensure(retryOwner,spec({available:()=>available})),false);available=true;
    assert.equal(await retry.ensure(retryOwner,spec({available:()=>available,retry:true})),true);

    // A hidden automatic job must not make a report/export inherit its cancelled
    // background demand. Explicit demand replaces pending work, reusing ready work.
    const upgrade=Runtime.create(),exportOwner={},background=deferred();
    const automatic=upgrade.ensure(exportOwner,spec({step:()=>background.promise}));
    await tick();
    const explicit=upgrade.ensure(exportOwner,spec({explicit:true,retry:true}));
    assert.notEqual(explicit,automatic);assert.equal(exportOwner._ticJob.explicit,true);
    background.resolve(false);
    assert.equal(await automatic,false);assert.equal(await explicit,true);
    assert.equal(upgrade.ensure(exportOwner,spec({explicit:true,retry:true})),explicit,'ready explicit job remains reusable');
    const warm=Runtime.create(),warmOwner={};
    const ready=warm.ensure(warmOwner,spec());await ready;
    assert.equal(warm.ensure(warmOwner,spec({explicit:true})),ready,'ready automatic result can satisfy export');
    const absent=Cache.create({indexedDB:null});assert.equal(await absent.get('missing'),null);assert.equal(await absent.put('s',new Blob(['x']),1,1),false);
}
async function panelLifecycle() {
    const {runtime:viewerRuntime}=require('./viewer-runtime.cjs');
    const entries={A:{kind:'txt',blobId:'original-a',v:'A'},B:{kind:'txt',blobId:'original-b',v:'B'}};
    const section={id:'section',meta:{visibleLayers:['HE_STAIN_TIC']},images:{},msiSeries:entries};
    const project={id:'project',sections:[section]}, before=JSON.stringify(project), ops=[], repairs=[];
    const App={project,requestBackgroundLayer:async(_p,_id,run)=>run()};
    const raster=()=>({width:2,height:1,values:new Float32Array([0,10]),rawRange:[0,10],pixels:new Uint8ClampedArray([0,0,0,255,255,255,255,255])});
    const encode=async(width,height,pixels)=>JSON.stringify({width,height,pixels:Array.from(pixels)});
    let workers=true, wrongContribution=false, descriptions=0, derivedRuntime=Runtime.create();
    const accumulators=new Map();
    const c=viewerRuntime({App,TicCore:{...Core,describe(...args){descriptions++;return Core.describe(...args);}},
        TicCache:{blobDataUrl:async blob=>blob,dataUrlBlob:()=>null},getTicRuntime:()=>derivedRuntime,
        MSI_ROBUST_PERCENTILE:.99,_parsePending:new Map(),_pqInFlight:0,
        parseWorkerAvailable:()=>workers,
        ensureLocalBlob:async(entry,owner)=>{assert.equal(owner,project);repairs.push(entry.blobId);return {blob:new Blob(['data'])};},
        parseTxtToRows:()=>[],computeRasterPixels:raster,_encodePixelsToDataUrl:encode,
        callParseWorker:async(op,p)=>{
            ops.push(op);
            if(op==='tic-probe')return {width:2,height:1};
            if(op==='tic-begin'){accumulators.set(p.jobId,Core.create(p.width,p.height));return {started:true};}
            if(op==='tic-dispose'){accumulators.delete(p.jobId);return {disposed:true};}
            if(op==='tic-step')return {contributed:wrongContribution&&p.def.v==='B'?false:Core.accumulate(accumulators.get(p.jobId),raster())};
            const result=Core.finish(accumulators.get(p.jobId));return {dataUrl:await encode(result.width,result.height,result.pixels),width:result.width,height:result.height};
        }});
    const panel=Object.create(c.Panel.prototype);
    Object.assign(panel,{project,section,imageSources:{},imageDataUrls:{},imageSettings:{},visibleLayers:new Set(['HE_STAIN_TIC']),
        registeredMsiKeys:()=>Object.keys(section.msiSeries),msiRasterSize:()=>null,isNonTargetSection:()=>false,
        _imageFromDataUrl:async data=>{const image=JSON.parse(data);return {naturalWidth:image.width,naturalHeight:image.height};},
        rebuildLayerBar(){},populateThumbnails(){},setupCanvasSize(){},renderComposite(){}});
    assert.equal(await panel.ensureTicBackdrop(),true,'TIC-only visibility establishes missing geometry');
    assert.equal(ops.filter(x=>x==='tic-probe').length,1);
    assert.equal(ops.filter(x=>x==='tic-step').length,2);
    assert.deepEqual(Object.keys(panel.imageSources),['HE_STAIN_TIC'],'no full MSI image load for TIC');
    assert.equal(JSON.stringify(project),before,'TIC does not edit original project/visibility');
    assert.ok(descriptions<=8,'full fingerprints are not computed for every source step');
    const pixels=panel.imageDataUrls.HE_STAIN_TIC;

    panel.invalidateTicBackdrop(false);
    derivedRuntime=Runtime.create();workers=false;
    assert.equal(await panel.ensureTicBackdrop(),false,'automatic unsupported-worker path never parses on main thread');
    assert.equal(await panel.ensureTicBackdrop({explicit:true}),true,'explicit export retains no-worker fallback');
    assert.equal(panel.imageDataUrls.HE_STAIN_TIC,pixels);

    panel.invalidateTicBackdrop(false);workers=true;wrongContribution=true;derivedRuntime=Runtime.create();
    assert.equal(await panel.ensureTicBackdrop(),true);assert.equal(panel._ticJob.state,'incomplete');
    wrongContribution=false;
    const steps=ops.filter(x=>x==='tic-step').length;
    assert.equal(await panel.ensureTicBackdrop({explicit:true}),true);assert.equal(panel._ticJob.state,'ready');
    assert.equal(ops.filter(x=>x==='tic-step').length,steps+2,'explicit retry recomputes an installed partial result');

    panel.invalidateTicBackdrop(false);
    let evicted=0;
    derivedRuntime=Runtime.create({cache:{get:async()=>({width:2,height:1,blob:JSON.stringify({width:9,height:9})}),
        remove:async()=>{evicted++;},put:async()=>true}});
    assert.equal(await panel.ensureTicBackdrop(),true);assert.equal(evicted,1,'valid PNG with wrong geometry is discarded');
    assert.equal(panel.imageDataUrls.HE_STAIN_TIC,pixels);
    assert.ok(repairs.length>=2,'source recovery uses ensureLocalBlob');

    section.meta.ticDataUrl=pixels;
    panel.invalidateTicBackdrop(false);
    assert.equal(panel.imageDataUrls.HE_STAIN_TIC,pixels,'invalidation preserves authored saved TIC');
    assert.equal(accumulators.size,0);
}
(async()=>{numeric();signatures();await worker();await runtime();await panelLifecycle();console.log('TIC background regression: passed');})().catch(error=>{console.error(error);process.exitCode=1;});
