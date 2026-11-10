'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {deflateRawSync}=require('node:zlib');
const XLSX=require('../connector/node_modules/xlsx');
const Core=require('../viewer/msi-analysis-core.js'),Engine=require('../viewer/msi-analysis-worker.js');
const Ratio=require('../viewer/msi-ratio-core.js'),Range=require('../viewer/msi-roi-range.js'),Tic=require('../viewer/tic-core.js');
const html=fs.readFileSync(path.join(__dirname,'../viewer/index.html'),'utf8');
function source(name){
    let start=html.indexOf('async function '+name+'(');if(start<0)start=html.indexOf('function '+name+'(');
    assert.ok(start>=0,'production function '+name);return html.slice(start,html.indexOf('\n}',start)+2);
}
const build=source('_buildParseWorkerSource'),names=build.match(/const fns = \[([\s\S]*?)\];/)[1].split(',').map(s=>s.trim()).filter(Boolean);
const globals={console,TextDecoder,TextEncoder,Blob,Response,DecompressionStream,structuredClone,XLSX,
    MsiAnalysisCore:Core,MsiAnalysisWorker:Engine,MsiRatioCore:Ratio,MsiRoiRange:Range,TicCore:Tic,
    PARSE_WORKER_LIBS:[],MSI_ROBUST_PERCENTILE:.998,MSI_DEFAULT_DISPLAY_PERCENTILE:.99};
const baseline=vm.createContext({...globals});
vm.runInContext([...new Set([...names,'extractRawSourceMatrix','extractSourceMatrixForExport'])].map(source).join('\n')+'\n'+build,baseline);
const posts=[],worker=vm.createContext({...globals,importScripts(){},self:{postMessage(message,transfer){posts.push(structuredClone(message,{transfer}));}}});
vm.runInContext(baseline._buildParseWorkerSource(),worker);
vm.runInContext('_encodePixelsToDataUrl=async()=>"encoded-pixels";',worker);
let serial=0;
async function call(op,payload){
    const id=++serial;await worker.self.onmessage({data:structuredClone({id,generation:7,op,payload})});
    const reply=posts.find(item=>item.id===id);assert.ok(reply,'Worker replied');assert.equal(reply.generation,7);
    if(!reply.ok)throw Object.assign(new Error(reply.error.message),{code:reply.error.code});return reply.result;
}
const plain=value=>structuredClone(value);
function same(actual,expected,label){assert.deepEqual(plain(actual),plain(expected),label);}
async function originalParity(label,bytes,def,entries){
    const matrix=await baseline.extractSourceMatrixForExport(bytes,def,entries);
    const result=await call('source-open',{key:label,blob:new Blob([bytes]),def,entries,snapshots:true});
    for(let index=0;index<entries.length;index++){
        const actual=result.grids[index],col=matrix.cols[index],entry=entries[index].ent;
        const geometry=baseline.createMsiSourceGeometry(matrix.positions,entry,[col]);
        const rows=Array.from(baseline.msiMatrixRows(matrix.positions,col,matrix.rowIds));
        same(actual.sourceGeometry,geometry,label+' feature geometry');
        same(actual.sourceStats,baseline.msiSourceStats(rows),label+' original-row stats');
        same(Array.from(Core.rows(actual.snapshot)),rows,label+' row values, IDs and original cell tokens');
        for(let i=0;i<matrix.positions.length;i++)for(const axis of ['x','y'])
            same(Core.cell(actual.snapshot,i,axis),matrix.positions[i].sourceCells[axis],label+' coordinate token '+i+axis);
        assert.equal(actual.snapshot.sourceFrame,matrix.sourceFrame);
        const again=await call('source-snapshot',{handle:actual.handle});
        same(again.values,actual.snapshot.values,'sending a snapshot must not detach the cached column');
        assert.ok(actual.byteLength>=actual.snapshot.values.byteLength+actual.snapshot.x.byteLength+actual.snapshot.y.byteLength);
        const g=geometry.displayGeometry,meta={version:'msi-source-v1',sourceRef:geometry.sourceRef,displayGeometry:g};
        const poly=[[-1,-1],[g.W+1,-1],[g.W+1,g.H+1],[-1,g.H+1]],expected=baseline.collectRoiSourceRows({rows,sourceGeometry:geometry},poly,meta,meta);
        const roi=await call('roi',{handle:actual.handle,selection:{poly,meta,originalMeta:meta,geometry},includeValues:true});
        const stats=roi.stats;delete roi.stats;same(roi,expected,label+' ROI membership/precision');same(stats,baseline.calcStats(expected.values),label+' unchanged calcStats');
    }
    return result;
}
async function txt(){
    const bytes=new TextEncoder().encode('x,y,A,B\n2,0,1.0000000000000002,10\n2,0,,20\n,0,9,30\n1,0,-0,0\n1,1,-2,2\n1,2,bad,3\n3,2,1e3,4\n4,2,9007199254740993,5\n');
    const def={kind:'txt',blobId:'txt',sourceFileId:'txt-source',x:'x',y:'y',v:'A'};
    const result=await originalParity('txt',bytes,def,[{layerKey:'A',ent:def},{layerKey:'B',ent:{...def,v:'B'}}]);
    assert.equal(result.grids[0].snapshot.x,result.grids[1].snapshot.x,'same-matrix coordinates stay shared across the Worker reply');
    assert.equal(result.grids[0].snapshot.rowIds,result.grids[1].snapshot.rowIds);
    assert.notEqual(result.grids[0].sourceGeometry.legacy.reason,null,'invalid historical coordinates remain unconfirmed');
    const legacyBytes=new TextEncoder().encode('x,y,A,B\n0,0,1,1\n1,0,bad,2\n2,0,3,3');
    const legacy=await originalParity('feature-geometry',legacyBytes,{...def,blobId:'legacy'},[
        {layerKey:'A',ent:{...def,blobId:'legacy'}},{layerKey:'B',ent:{...def,blobId:'legacy',v:'B'}}]);
    assert.equal(legacy.grids[0].sourceGeometry.legacy.confirmed,false);
    assert.equal(legacy.grids[1].sourceGeometry.legacy.confirmed,true,'one MRM must not change another feature legacy geometry');
}
async function xlsx(){
    const wb=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([['x','y','A','B'],[2,0,1.0000000000000002,10],[2,0,null,20],[null,0,9,30],[1,0,-0,0],[1,1,-2,2],[1,2,'bad',3]]);
    sheet.C2.f='1+2^-52';sheet.C7={t:'e',v:7,w:'#DIV/0!'};
    XLSX.utils.book_append_sheet(wb,sheet,'MSI');const bytes=XLSX.write(wb,{type:'array',bookType:'xlsx'});
    const def={kind:'xlsx',blobId:'xlsx',sheet:'MSI',col_x:'A',col_y:'B',col_v:'C',data_start_row:2};
    const result=await originalParity('xlsx',bytes,def,[{layerKey:'A',ent:def},{layerKey:'B',ent:{...def,col_v:'D'}}]);
    assert.equal(Core.cell(result.grids[0].snapshot,0).formula,'1+2^-52');
    assert.equal(Core.cell(result.grids[0].snapshot,5).status,'invalid-cell');
}
async function raw(){
    // Reuse the established deterministic acquisition fixture; do not invent a
    // second RAW encoder for the analysis pipeline's golden comparison.
    const test=fs.readFileSync(path.join(__dirname,'viewer_preview_regression.js'),'utf8');
    const context=vm.createContext({TextEncoder,deflateRawSync});
    vm.runInContext(test.slice(test.indexOf('const RAW_FX ='),test.indexOf('function assembleWorkerFns(')),context);
    const bytes=vm.runInContext('buildZip(buildSyntheticRawMembers())',context);
    const def={kind:'raw',blobId:'raw',sourceFileId:'raw-source',func:1,channel:0,snap:true};
    await originalParity('raw',bytes,def,[{layerKey:'A',ent:def},{layerKey:'B',ent:{...def,channel:1}}]);
    await originalParity('raw-unsnapped',bytes,{...def,snap:false},[{layerKey:'A',ent:{...def,snap:false}}]);
}
async function parquet(){
    const cols=[[2,2,0,1,1],[0,0,0,0,1],['a','a','a','a','a']],roles={annIdx:2};
    const geom=await call('parquet-geometry',{cols,roles});
    const restored={...geom,sections:geom.sections.map(section=>{const {sourceCoordinates,...original}=Core.parquetSection(section);return {...original,sourceRows:Array.from(original.sourceRows)};})};
    same(restored,baseline.buildParquetGeometryColumns(cols,roles),'compact Parquet geometry preserves the original rows');
    const sec=geom.sections[0],column=[10,20,0,-2,'bad'];column._sourceCellStates={4:{type:'string',status:'invalid',token:'bad',value:NaN}};
    const def={kind:'parquet',sourceUrl:'https://example.test/immutable.parquet',colIdx:3,annotation:'a'};
    const actual=await call('source-register',{key:'parquet',def,layerKey:'A',column:Core.packParquetColumn(column),section:sec,snapshots:true});
    const rows=Array.from(baseline.parquetSourceRows(column,Core.parquetSection(sec)));
    same(Array.from(Core.rows(actual.snapshot)),rows,'Parquet original rows/statuses');same(actual.sourceStats,baseline.msiSourceStats(rows));
    assert.equal(actual.snapshot.coordinateCells.x,null);assert.equal(actual.snapshot.coordinateCells.y,null,'absent coordinate cells remain compact');
    const raster=await call('parquet-raster',{col:Core.packParquetColumn(column),sec,ent:def});same(raster,baseline.buildParquetRasterValues(column,Core.parquetSection(sec),def),'Parquet duplicate-cell averaging and bake');
    const size=sec.W*sec.H,slot=()=>({t:{sectionId:'s',accum:new Float64Array(size),count:new Uint32Array(size)},g:sec,values:new Float64Array(size),ticRaw:new Float64Array(size)});
    const expectedSlot=slot();expectedSlot.g=Core.parquetSection(sec);
    const started=await call('parquet-tic-start',{slots:[slot()]}),chunks=[[{key:'A'}],[{key:'B'}]],columns=[[column],[[2,4,6,8,10]]];
    for(let i=0;i<chunks.length;i++){
        const expected=baseline.accumulateParquetColumns(chunks[i],columns[i],[expectedSlot]);
        const reply=await call('parquet-tic-chunk',{handle:started.handle,chunk:chunks[i],cols:columns[i].map(Core.packParquetColumn)});same(reply.statsByKey,expected,'Parquet chunk statistics use original order');
    }
    const finished=await call('parquet-tic-finish',{handle:started.handle});
    same(finished.slots[0],{t:{accum:expectedSlot.t.accum,count:expectedSlot.t.count},ticRaw:expectedSlot.ticRaw},'Parquet raw TIC and baked TIC remain distinct and exact');
    await assert.rejects(call('parquet-tic-finish',{handle:started.handle}),{code:'ANALYSIS_HANDLE_EXPIRED'});
    const precise=Float64Array.from([NaN,20,0,-2,NaN]);
    precise._sourceCellStates={0:{type:'bigint',status:'unsafe-integer',token:'9007199254740993',value:NaN},4:{type:'undefined',status:'missing',token:null,value:NaN}};
    const preciseReply=await call('source-register',{key:'parquet-precision',def,layerKey:'A',column:Core.packParquetColumn(precise),section:sec,snapshots:true});
    assert.equal(preciseReply.sourceStats.precisionBlocked,true,'typed-array cell metadata must cross the Worker request boundary');
    assert.equal(Core.cell(preciseReply.snapshot,0).token,'9007199254740993');
    assert.equal(Core.cell(preciseReply.snapshot,4).status,'missing');
    const preciseRaster=await call('parquet-raster',{col:Core.packParquetColumn(precise),sec,ent:def});
    same(preciseRaster,baseline.buildParquetRasterValues(precise,Core.parquetSection(sec),def),'typed exceptional cells preserve raster source statistics');
    const typedSlot=slot();typedSlot.g=Core.parquetSection(sec);
    const typedTic=await call('parquet-tic-start',{slots:[slot()]}),expectedTyped=baseline.accumulateParquetColumns([{key:'unsafe'}],[precise],[typedSlot]);
    const typedChunk=await call('parquet-tic-chunk',{handle:typedTic.handle,chunk:[{key:'unsafe'}],cols:[Core.packParquetColumn(precise)]});
    same(typedChunk.statsByKey,expectedTyped,'typed exception metadata also survives batched TIC requests');
    await call('parquet-tic-finish',{handle:typedTic.handle});
}
async function cache(){
    let reads=0,parses=0;
    const functions={...baseline,parseXlsxSheet(...args){parses++;return baseline.parseXlsxSheet(...args);}};
    const engine=Engine.create({Core,RatioCore:Ratio,RoiRange:Range,functions});
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([[0,0,1,2],[1,0,3,4]]),'S');
    const buf=XLSX.write(wb,{type:'array',bookType:'xlsx'}),blob={async arrayBuffer(){reads++;await Promise.resolve();return buf;}};
    const def={kind:'xlsx',blobId:'shared-decode',sheet:'S',col_x:'A',col_y:'B',col_v:'C'};
    await Promise.all([engine.rows({blob,def}),engine.rows({blob,def:{...def,col_v:'D'}})]);
    assert.equal(reads,1);assert.equal(parses,1,'concurrent renderer/analysis requests share one decode');
    await engine.dispatch('source-open',{key:'shared-grid',blob,def});assert.equal(reads,1);assert.equal(parses,1);
    assert.ok(engine.snapshot().bytes<=128*1024*1024);
    const small=Engine.create({Core,RatioCore:Ratio,RoiRange:Range,functions,maxBytes:16000});
    const snapshots=[];for(let i=0;i<8;i++){
        const values=Float64Array.from({length:100},(_,k)=>k),snapshot={version:1,x:values.slice(),y:new Float64Array(100),values,rowIds:values.slice(),
            sourceGeometry:{displayGeometry:{W:100,H:1}},sourceFrame:'f',sourceCells:null,coordinateCells:{x:null,y:null}};
        snapshots.push(await small.dispatch('source-register',{key:'s'+i,snapshot}));assert.ok(small.snapshot().bytes<=16000);
    }
    await assert.rejects(small.dispatch('source-snapshot',{handle:snapshots[0].handle}),{code:'ANALYSIS_HANDLE_EXPIRED'});
}
async function fallbackPolicy(){
    let mainCalls=0,workerCalls=0,available=true;
    const context=vm.createContext({MSI_MAIN_THREAD_SOURCE_MAX_BYTES:4*1024*1024,
        getMsiAnalysisService:()=>available?{}:null,
        callParseWorker:async()=>{workerCalls++;throw new Error('worker failure');},
        inspectXlsxColumns:()=>{mainCalls++;return {small:true};}});
    vm.runInContext(source('inspectXlsxColumnsAuto'),context);
    await assert.rejects(context.inspectXlsxColumnsAuto({size:1024},new ArrayBuffer(1),'S',1),/worker failure/);
    assert.equal(mainCalls,0,'supported Worker failure cannot synchronously rerun XLSX inspection');
    available=false;
    same(await context.inspectXlsxColumnsAuto({size:1024},new ArrayBuffer(1),'S',1),{small:true});
    await assert.rejects(context.inspectXlsxColumnsAuto({size:5*1024*1024},new ArrayBuffer(1),'S',1),{code:'ANALYSIS_WORKER_REQUIRED'});
    assert.equal(mainCalls,1);assert.equal(workerCalls,1);
}
async function main(){await txt();await xlsx();await raw();await parquet();await cache();await fallbackPolicy();console.log('MSI analysis source regression: PASS (TXT/XLSX/RAW/Parquet golden rows, lexical cells, geometry, stats, ROI, transfer and bounded shared decode)');}
const watchdog=setTimeout(()=>{console.error('MSI analysis source regression timed out');process.exitCode=1;},30000);
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
