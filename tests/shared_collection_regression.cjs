'use strict';
// Real ZIP/CRC reading plus the production Import ZIP. No cloud/IDB changes.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const Collection=require('../viewer/shared-collection.js');
const Loader=require('../viewer/source-loader.js');
const Archive=require('../viewer/project-archive.js');
const Ratio=require('../viewer/msi-ratio-model.js');
const Transform=require('../viewer/alignment-transform.js');
const JSZip=require('../vendor/jszip.min.js');
const {context,MemoryZip}=require('./zip_compatibility_regression.js');
const {standalone,displayContext}=require('./viewer-runtime.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const sources={
    'p/original.txt':new Blob(['x\ty\tX\tY\n01\t2\tNA\t1\n3\t4\t0\t2\n']),
    'p/original.parquet':new Blob([Uint8Array.from([80,65,82,49,0,255,128,80,65,82,49])]),
    'p/HE.png':new Blob([Uint8Array.from([137,80,78,71,0,255,1])],{type:'image/png'}),
    'p/photo.png':new Blob([Uint8Array.from([137,80,78,71,4,6,8])],{type:'image/png'}),
    'p/shared-he.png':new Blob([Uint8Array.from([137,80,78,71,9,7,5])],{type:'image/png'}),
    'p/alignment-source.csv':new Blob(['x,y,X\n10,-1,1\n14,-1,2\n10,7,3\n14,7,4\n'])
};
const vertices=[[0,0],[3,0],[3,4],[0,4]];
const affine=[[0.001234567890123,0.0005,2.34],[-0.0001,0.0015,-3.4],[0,0,1]];
const alignment={...Transform.upgrade({T_he_to_msi:affine,landmarks:{he:[[1,2]],msi:[[3,4]]}},'import'),
    alignment_raster_basis:'legacy-msi-pixel-edges-v1',imageIdentity:'published-he',scope:'source',
    frame:{version:'msi-alignment-frame-v2',key:'frame',sourceFileId:'file',measurementKey:'source-one',
        readerKey:'reader',coordinateKey:'grid',confirmed:true}};
function fixture() {
    const a={kind:'txt',path:'p/original.txt',filename:'original.txt',sourceFileId:'file',sourceReference:'source-one',
        x:'x',y:'y',v:'X',archiveProvenance:Archive.registeredSource(),rasterW:30,rasterH:60};
    const b={...a,v:'Y'};
    const pq={kind:'parquet',path:'p/original.parquet',filename:'original.parquet',sourceFileId:'pq',
        sourceReference:'parquet-one',colIdx:0,annotation:'ions',sourceBytes:sources['p/original.parquet'].size,
        rasterW:100,rasterH:200,archiveProvenance:Archive.registeredSource()};
    const ratio={id:'published-ratio',name:'X / Y',revision:1,operation:'divide',calculationVersion:'msi-ratio-v1',
        numeratorPolicy:'nonnegative',invalidPolicy:'exclude',denominatorMin:0,
        bindings:{client:{numerator:Ratio.makeInputRef(a,'MSI_A'),denominator:Ratio.makeInputRef(b,'MSI_B'),coordinateConfirmed:true}},
        display:{rangePolicy:'maximum'}};
    const media={version:1,items:[{id:'photo',roiKey:'ROI_1',sectionId:'client',filename:'photo.png',mime:'image/png',
        width:100,height:200,storagePath:'p/photo.png',sourceRef:'source-one',roiSnapshot:{vertices},title:'photo',revision:1}]};
    const doc={id:'published-server-project',publish_revision:7,updated_at:'2026-11-27T00:00:00Z',meta:{project_slug:'public',display_name:'日本語 project',
        project_meta:{memo:{freeNote:'exact note'},msiUserWindow:{MSI_A:{min:2,max:9}},physical:{pitchX:30,pitchY:60},
            msiRatios:{schemaVersion:1,definitions:[ratio]},roiMedia:media,shareInfo:{viewerPassword:'never-copy'}}},
        anatomy_palette:{ROI_1:{name:'ROI',rgba:[255,0,0,200]}},
        sections:[{id:'server',ordinal:1,display_name:'Sample',meta:{client_id:'client',alignment:{HE:clone(alignment)},
            overlays:[{id:'published',name:'Published overlay',layers:[]}],physical:{widthUm:900,heightUm:3600}},
            storage_paths:{images:{HE:{path:'p/HE.png',filename:'HE.png',mime:'image/png',alignmentImageReference:'published-he'}},
                msiSeries:{MSI_A:a,MSI_B:b,MSI_PQ:pq},msiFiles:{file:{...a,id:'file'},pq:{...pq,id:'pq'}}}}]};
    const rois=[{id:'roi',colorKey:'ROI_1',name:'ROI',rgba:[255,0,0,200],polysBySection:{server:vertices},
        geometryBySection:{server:{version:'msi-source-v1',sourceRef:'source-one',displayGeometry:{W:30,H:60}}}}];
    return {doc,rois,media};
}
function project(f=fixture()) {
    return Collection.projectFromDoc(f.doc,'public',{rois:f.rois,roiMedia:f.media,ratios:f.doc.meta.project_meta.msiRatios});
}
function alignmentScope() {
    const scope=displayContext({console,App:{panels:new Map()},MsiAlignmentTransform:Transform});
    const html=fs.readFileSync(path.join(__dirname,'../viewer/index.html'),'utf8');
    vm.runInContext(html.match(/^const SECTION_ALIGN_(?:WC|META)_KEYS = .*;$/gm).join('\n')+'\n'+[
        'captureSectionAlignment','applySectionAlignment','_overlayFromRow','buildLegacyMsiGrid','buildMsiGrid','createMsiSourceGeometry'
    ].map(standalone).join('\n'),scope);
    return scope;
}
function collaborationFixture() {
    const f=fixture(),scope=alignmentScope(),section=f.doc.sections[0];
    section.meta.visibleLayers=['HE','MSI_A'];
    const entry={kind:'txt',path:'p/alignment-source.csv',filename:'alignment-source.csv',sourceFileId:'alignment-source',
        sourceReference:'alignment-original',sourceRevision:'revision-1',x:'x',y:'y',v:'X',sep:','};
    const rows=[{x:10,y:-1,v:1},{x:14,y:-1,v:2},{x:10,y:7,v:3},{x:14,y:7,v:4}];
    entry.sourceGeometry=clone(scope.createMsiSourceGeometry(rows,entry));
    section.storage_paths.msiSeries.MSI_SHARED_ALIGN=entry;
    section.storage_paths.msiFiles['alignment-source']={...entry};
    const image={id:'shared-image',project_id:f.doc.id,section_id:section.id,layer_key:'HE_STAIN_shared',
        filename:'shared-he.png',mime:'image/png',storage_path:'p/shared-he.png',updated_at:'2026-11-27T00:00:00Z'};
    const preview=project(f),frame=clone(scope.alignmentFrameDescriptor(preview.sections[0],'MSI_SHARED_ALIGN'));
    assert.equal(frame.confirmed,true);
    const sharedT=[[1.2,0.15,7],[-0.2,0.95,-3],[0,0,1]];
    const sharedRecord={...Transform.upgrade({T_he_to_msi:sharedT},'import'),scope:'source',
        alignment_raster_basis:'legacy-msi-pixel-edges-v1',frame:{...frame,version:'msi-alignment-frame-v2'},
        imageIdentity:scope.alignmentImageIdentity({__shareImage:image.id,storagePath:image.storage_path})};
    const payload={alignment:{HE_STAIN_shared:{byFrame:{[frame.key]:sharedRecord}}},
        alignmentFrameVersion:'msi-alignment-frame-v2',alignmentMsiKey:'MSI_SHARED_ALIGN',alignmentHeKey:'HE_STAIN_shared',
        alignmentSourceMode:'alignment-source',perSourceAlign:true,
        world_coords:{T_he_to_msi:sharedT,msi_um_per_px:{x:20,y:30}}};
    f.collaboration={images:[image],alignments:[{project_id:f.doc.id,section_id:section.id,payload,version:4}],
        overlays:[{id:'shared-overlay',project_id:f.doc.id,name:'Shared overlay',layers:[{key:'MSI_A',color:'#ff00ff'},
            {key:'MSI_B',color:'#00ff00'}],bg:'he',match_brightness:true,version:3}]};
    return {...f,sharedT,frame};
}
async function sharedRoundTrip() {
    const f=collaborationFixture(),scope=alignmentScope(),before=clone(f);
    const make=value=>Collection.projectFromDoc(value.doc,'public',{rois:value.rois,roiMedia:value.media,
        collaboration:value.collaboration,captureAlignment:scope.captureSectionAlignment,
        applyAlignment:scope.applySectionAlignment,overlayFromRow:scope._overlayFromRow});
    const input=make(f),built=await Collection.projectZip(input,{resolveSource,fetchBlob:async path=>sources[path],
        imageIdentity:scope.alignmentImageIdentity});
    assert.deepEqual(clone(f),before,'saved shared rows and published source remain unchanged');
    const zip=await loadZip(built.blob),manifest=await innerManifest(zip);
    assert.equal(manifest.exportMode,'shared-saved-originals');assert.equal(built.originalCount,6);
    assert.equal(manifest.collaborationSnapshot.alignmentPolicy,'shared-with-master-fallback');
    assert.deepEqual(manifest.sections[0].meta.__alignMaster.alignment.HE.T_he_to_msi,affine);
    const rawShared=manifest.sections[0].images.HE_STAIN_shared;
    assert.deepEqual(await zip.file(rawShared.fullPath).async('uint8array'),new Uint8Array(await sources['p/shared-he.png'].arrayBuffer()));
    for(const offline of [false,true]) {
        const target=context(offline);await target.importZipFile(await toImportZip(zip),{review:()=>true});
        const restored=target.saved,section=restored.sections[0];
        const resolved=scope.resolveHeMsiAlignment(section,'HE_STAIN_shared','MSI_SHARED_ALIGN');
        assert.equal(resolved.status,'ready');assert.equal(resolved.origin,'frame');
        assert.equal(resolved.renderContract,'msi-shared-display-v1');assert.equal(resolved.effectiveDisplayKind,'msi');
        assert.deepEqual(clone(resolved.T),f.sharedT,'the real renderer resolves the restored shared affine');
        assert.equal(scope.alignmentFrameDescriptor(section,'MSI_SHARED_ALIGN').key,f.frame.key);
        assert.deepEqual(section.meta.__alignMaster.alignment.HE.T_he_to_msi,affine);
        assert.deepEqual(section.meta.world_coords.msi_um_per_px,{x:20,y:30});
        assert.ok(section.meta.visibleLayers.includes('HE_STAIN_shared'),'shared hydration enables the attached layer');
        assert.equal(restored.overlays.length,2);const overlay=restored.overlays.find(row=>row.id==='shared-overlay');
        assert.equal(overlay.matchBrightness,true);assert.equal(overlay._server,undefined);assert.equal(overlay._serverVersion,undefined);
        assert.deepEqual(overlay.layers,f.collaboration.overlays[0].layers);
        assert.deepEqual(new Uint8Array(await target.blobs.get(section.images.HE_STAIN_shared.blobId).blob.arrayBuffer()),
            new Uint8Array(await sources['p/shared-he.png'].arrayBuffer()));
        assert.deepEqual(new Uint8Array(await target.blobs.get(restored.meta.roiMedia.items[0].blobId).blob.arrayBuffer()),
            new Uint8Array(await sources['p/photo.png'].arrayBuffer()));
        assert.deepEqual(restored.rois[0].polysBySection[section.id],vertices);
        assert.equal(Ratio.validateProjectReferences(restored).valid,true);
        const badImage=clone(section);badImage.images.HE_STAIN_shared.alignmentImageReference='wrong-image';
        assert.equal(scope.resolveHeMsiAlignment(badImage,'HE_STAIN_shared','MSI_SHARED_ALIGN').reason,'image-changed');
        const badGeometry=clone(section);badGeometry.msiSeries.MSI_SHARED_ALIGN.sourceGeometry.legacy.x=[[11,0],[15,1]];
        assert.equal(scope.resolveHeMsiAlignment(badGeometry,'HE_STAIN_shared','MSI_SHARED_ALIGN').reason,'coordinate-mismatch');
    }
    await assert.rejects(Collection.projectZip(input,{resolveSource,imageIdentity:scope.alignmentImageIdentity,fetchBlob:async path=>{
        if(path==='p/shared-he.png')throw new Error('shared original missing');return sources[path];
    }}),/shared original missing/);
    const conflict=collaborationFixture();conflict.collaboration.images[0].layer_key='HE';
    assert.throws(()=>make(conflict),{code:'COLLECTION_SHARED_IMAGE_CONFLICT'});
    const masterV2=collaborationFixture();masterV2.collaboration.alignments[0].payload.alignment={};
    const masterOnly=await Collection.projectZip(make(masterV2),{resolveSource,imageIdentity:scope.alignmentImageIdentity,fetchBlob:async path=>sources[path]});
    assert.equal(masterOnly.manifest.format,'desi_data_share_v3','the preserved master affine also requires a v3 archive');
    const unsupported=collaborationFixture();unsupported.doc.sections[0].meta.alignment.HE.renderContract='future';
    await assert.rejects(Collection.projectZip(make(unsupported),{resolveSource,fetchBlob:async path=>sources[path]}),/Unsupported/);
}
const resolveSource=entry=>({path:entry.storagePath || entry.path,url:entry.storagePath || entry.path});
async function loadZip(blob) {return JSZip.loadAsync(await blob.arrayBuffer(),{checkCRC32:true});}
async function innerManifest(zip) {
    for(const path of Object.keys(zip.files).filter(path=>/^[^/]+\.json$/.test(path))) {
        const value=JSON.parse(await zip.file(path).async('string'));if(value.format?.startsWith('desi_data_share_'))return value;
    }
    throw new Error('Missing project manifest');
}
async function toImportZip(zip) {
    const memory=new MemoryZip();
    for(const [name,file] of Object.entries(zip.files)) if(!file.dir)
        memory.file(name,/\.json$/i.test(name)?await file.async('string'):new Blob([await file.async('uint8array')]));
    return memory;
}
async function archiveRoundTrip() {
    const input=project(),before=clone(input),reads=[];
    const built=await Collection.projectZip(input,{resolveSource,fetchBlob:async path=>{reads.push(path);return sources[path];}});
    assert.deepEqual(clone(input),before,'export must not mutate the source doc or visible project');
    assert.equal(reads.length,4,'shared HE/TXT/Parquet references download only once per original');
    assert.equal(built.originalCount,4);
    const zip=await loadZip(built.blob),manifest=await innerManifest(zip);
    assert.equal(manifest.format,'desi_data_share_v3');
    assert.equal(manifest.exportMode,'published-originals');
    assert.deepEqual(manifest.sections[0].data,[],'derivative policy is explicit; originals are the restoration source');
    assert.deepEqual(manifest.sections[0].meta.alignment.HE.T_he_to_msi,affine);
    assert.ok(!JSON.stringify(manifest).includes('never-copy'));
    assert.equal(manifest.offlineSettings.overlays.length,1);
    assert.equal(manifest.offlineSettings.overlays[0].id,'published');
    assert.equal(manifest.roiMedia.items[0].sectionId,'server');
    assert.equal(manifest.sections[0].originalSeries.MSI_A.sourcePath,manifest.sections[0].originalSeries.MSI_B.sourcePath);
    for(const [key,ent] of Object.entries(manifest.sections[0].originalSeries)) {
        const source=key==='MSI_PQ'?sources['p/original.parquet']:sources['p/original.txt'];
        assert.deepEqual(await zip.file(ent.sourcePath).async('uint8array'),new Uint8Array(await source.arrayBuffer()));
        for(const field of ['blobId','sourceUrl','storagePath','path'])assert.equal(ent[field],undefined);
    }
    await Archive.prepareImport(zip,manifest);
    for(const offline of [false,true]) {
        const target=context(offline);
        await target.importZipFile(await toImportZip(zip),{review:()=>true});
        const restored=target.saved,section=restored.sections[0];
        assert.deepEqual(section.meta.alignment.HE.T_he_to_msi,affine);
        assert.deepEqual(section.meta.physical,{widthUm:900,heightUm:3600});
        assert.deepEqual(restored.meta.physical,{pitchX:30,pitchY:60});
        assert.equal(restored.memo.freeNote,'exact note');
        assert.equal(section.msiSeries.MSI_PQ.kind,'parquet');assert.equal(section.msiSeries.MSI_PQ.colIdx,0);
        assert.equal(section.msiSeries.MSI_A.v,'X');assert.equal(section.msiSeries.MSI_B.v,'Y');
        assert.deepEqual(new Uint8Array(await target.blobs.get(section.msiSeries.MSI_PQ.blobId).blob.arrayBuffer()),
            new Uint8Array(await sources['p/original.parquet'].arrayBuffer()));
        assert.equal(restored.meta.roiMedia.items[0].sectionId,section.id);
        assert.deepEqual(restored.rois[0].polysBySection[section.id],vertices);
        assert.equal(Ratio.validateProjectReferences(restored).valid,true,'ratio bindings survive the existing importer');
        assert.equal(restored.meta.msiRatios.definitions[0].name,'X / Y');
    }
    const missing=project();
    await assert.rejects(Collection.projectZip(missing,{resolveSource,fetchBlob:async path=>{
        if(path==='p/photo.png')throw Object.assign(new Error('HTTP 404 photo'),{status:404});return sources[path];
    }}),/HTTP 404/);
    const mismatch=project();mismatch.sections[0].msiSeries.MSI_PQ.sourceBytes=99;mismatch.sections[0].msiFiles.pq.sourceBytes=99;
    await assert.rejects(Collection.projectZip(mismatch,{resolveSource,fetchBlob:async path=>sources[path]}),{code:'SOURCE_SIZE_MISMATCH'});
    const topAlias=fixture();topAlias.doc.sections[0].client_id='client';delete topAlias.doc.sections[0].meta.client_id;
    assert.equal(Ratio.validateProjectReferences(project(topAlias)).valid,true,'legacy top-level client aliases preserve canonical ratio bindings');
}
async function sessions() {
    const calls=[],stored=new Map();let asks=0,version=0;
    const storage={getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)};
    const row=slug=>({token:slug+'-token-'+(++version),role:'viewer',expires_at:new Date(Date.now()+3600000).toISOString()});
    const api={unlockPublicProject:async slug=>{calls.push(['public',slug]);if(slug==='private')throw {code:'28P02',message:'not_public'};return [row(slug)];},
        unlockProject:async(slug,password)=>{calls.push(['private',slug]);if(password!=='correct')throw {code:'28P01'};return row(slug);}};
    const broker=Collection.createSessions({api,storage,askPassword:async entry=>{assert.equal(entry.slug,'private');return ++asks===1?'wrong':'correct';}});
    const pub=await broker.get({slug:'public'}),privateSession=await broker.get({slug:'private'});
    assert.notEqual(pub.token,privateSession.token);assert.equal(asks,2);
    assert.equal((await broker.get({slug:'private'})).token,privateSession.token);assert.equal(asks,2,'cached per-project tokens avoid repeated passwords');
    let attempts=0;
    const token=await broker.run({slug:'public'},async session=>{if(++attempts===1)throw {code:'28000'};return session.token;});
    assert.notEqual(token,pub.token,'expired tokens reauthorize only the affected project');
    assert.ok(!JSON.stringify([...stored]).includes('correct'),'passwords are never stored');
    const network=Collection.createSessions({api:{unlockPublicProject:async()=>{throw new Error('network unavailable');}},askPassword:()=>{throw new Error('must not prompt for a network error');}});
    await assert.rejects(network.get({slug:'x'}),/network unavailable/);
}
function clientWithFetch(fetchImpl) {
    const html=fs.readFileSync(path.join(__dirname,'../viewer/index.html'),'utf8');
    const start=html.indexOf('const SupabaseClient = (() => {');
    const code=html.slice(start,html.indexOf('\n})();',start)+6);
    const scope=vm.createContext({window:{DESI_OFFLINE:false},console,SUPABASE_URL:'https://example.test',SUPABASE_ANON_KEY:'test-only',
        URL,Headers,Response,Request,AbortController,WebSocket:globalThis.WebSocket,crypto:globalThis.crypto,
        fetch:fetchImpl,setTimeout,clearTimeout,setInterval,clearInterval,
        ShareRefresh:require('../viewer/share-refresh.js')});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../vendor/supabase.min.js'),'utf8')+'\n'+code+'\nglobalThis.api=SupabaseClient;',scope);
    return scope.api;
}
async function paginatedRois() {
    // Execute the real Supabase wrapper with the shipped client and a fake
    // HTTP transport. A server cap smaller than our requested page size must
    // not truncate the backup or drop count/range information.
    const rows=Array.from({length:1007},(_,index)=>({id:'roi-'+String(index).padStart(5,'0'),section_id:'section',
        version:1,color_key:'ROI_'+index,poly_msi:[[index,0],[index+1,0],[index,1]]}));
    const requests=[];
    const fetchImpl=async(url,settings)=>{
        const parsed=new URL(url),offset=Number(parsed.searchParams.get('offset')||0);
        assert.match(new Headers(settings.headers).get('prefer'),/count=exact/);
        assert.equal(parsed.searchParams.get('order'),'id.asc');
        assert.equal(parsed.searchParams.get('limit'),'500');
        requests.push(offset);
        const page=rows.slice(offset,offset+137);
        return new Response(JSON.stringify(page),{status:206,headers:{'Content-Type':'application/json',
            'Content-Range':offset+'-'+(offset+page.length-1)+'/'+rows.length}});
    };
    const actual=await Collection.readRois(clientWithFetch(fetchImpl),'test-token',[{id:'section'}]);
    assert.equal(actual.length,1007);assert.equal(requests.length,8);assert.deepEqual(clone(actual),rows);
    const reverse=clone(rows).reverse();assert.equal(Collection.roiSignature(reverse),Collection.roiSignature(rows));
    reverse[0].version++;assert.notEqual(Collection.roiSignature(reverse),Collection.roiSignature(rows));
    const call=api=>Collection.readRois(api,'token',[{id:'section'}]);
    await assert.rejects(call({listRoisPage:async()=>({rows:[],count:null})}),{code:'COLLECTION_ROI_COUNT'});
    let count=0;
    await assert.rejects(call({listRoisPage:async()=>({rows:[rows[0]],count:++count===1?2:3})}),{code:'COLLECTION_ROI_CHANGED'});
    await assert.rejects(call({listRoisPage:async()=>({rows:[rows[0]],count:2})}),{code:'COLLECTION_ROI_CHANGED'});
    await assert.rejects(call({listRoisPage:async()=>({rows:[rows[0],{...rows[0],id:'another'}],count:2})}),{code:'COLLECTION_ROI_DUPLICATE'});
    count=0;
    await assert.rejects(call({listRoisPage:async()=>({rows:++count===1?[rows[0]]:[],count:2})}),{code:'COLLECTION_ROI_COUNT'});
}
async function paginatedCollaboration() {
    const sections=Array.from({length:1007},(_,n)=>({id:'section-'+String(n).padStart(5,'0')})),doc={id:'project',sections};
    const records=Object.fromEntries(['overlays','alignments','images'].map(kind=>[kind,sections.map((s,n)=>({
        ...(kind==='alignments'?{}:{id:kind+'-'+String(n).padStart(5,'0')}),project_id:'project',section_id:s.id,
        ...(kind==='alignments'?{payload:{},version:1}:kind==='images'?{layer_key:'HE_STAIN_shared',storage_path:'p/shared/'+n+'.png'}:{layers:[],version:1})
    }))]));
    const requests=[];
    const api=clientWithFetch(async(url,settings)=>{
        const parsed=new URL(url),kind=parsed.pathname.split('/').pop().replace('list_share_',''),offset=Number(parsed.searchParams.get('offset')||0);
        assert.match(new Headers(settings.headers).get('prefer'),/count=exact/);
        assert.equal(JSON.parse(settings.body).p_token,'project-token');
        assert.equal(parsed.searchParams.get('order'),kind==='alignments'?'section_id.asc':'id.asc');
        assert.equal(parsed.searchParams.get('limit'),'500');requests.push([kind,offset]);
        const page=records[kind].slice(offset,offset+137);
        return new Response(JSON.stringify(page),{status:206,headers:{'Content-Type':'application/json',
            'Content-Range':offset+'-'+(offset+page.length-1)+'/'+records[kind].length}});
    });
    const actual=await Collection.readCollaboration(api,'project-token',doc);
    assert.deepEqual(clone(actual),records);assert.equal(requests.length,24,'all three RPCs traverse the lower server page cap');
    const reordered=Object.fromEntries(Object.entries(actual).map(([key,rows])=>[key,rows.slice().reverse()]));
    assert.equal(Collection.collaborationSignature(actual),Collection.collaborationSignature(reordered));
    reordered.images[0]={...reordered.images[0],storage_path:'changed'};
    assert.notEqual(Collection.collaborationSignature(actual),Collection.collaborationSignature(reordered));
    const empty=async()=>({rows:[],count:0}),base={listShareOverlaysPage:empty,listShareImagesPage:empty,listShareAlignmentsPage:empty};
    const call=overrides=>Collection.readCollaboration({...base,...overrides},'project-token',doc);
    await assert.rejects(call({listShareImagesPage:async()=>({rows:[],count:null})}),{code:'COLLECTION_SHARED_COUNT'});
    await assert.rejects(call({listShareImagesPage:async()=>({rows:[{...records.images[0],project_id:'wrong'}],count:1})}),{code:'COLLECTION_SHARED_ROWS'});
    await assert.rejects(call({listShareAlignmentsPage:async()=>({rows:[{...records.alignments[0],section_id:'absent'}],count:1})}),{code:'COLLECTION_SHARED_ROWS'});
    await assert.rejects(call({listShareOverlaysPage:async()=>({rows:[records.overlays[0]],count:2})}),{code:'COLLECTION_SHARED_ROWS'});
    let read=0;
    await assert.rejects(call({listShareImagesPage:async()=>({rows:++read===1?[records.images[0]]:[],count:2})}),{code:'COLLECTION_SHARED_COUNT'});
    read=0;
    await assert.rejects(call({listShareAlignmentsPage:async()=>({rows:[records.alignments[read]],count:++read===1?2:3})}),{code:'COLLECTION_SHARED_CHANGED'});
    await assert.rejects(call({listShareImagesPage:async()=>{throw {code:'PGRST202'};}}),{code:'PGRST202'},'missing collaboration RPC cannot produce a complete backup');
}
async function collections() {
    const entries=Collection.collect({children:[{type:'project',slug:'public',displayName:'Same'},
        {type:'folder',name:'Nested',children:[{type:'project',slug:'second',displayName:'Same'},
            {type:'project',slug:'public',displayName:'Same'},{type:'project',slug:'missing',displayName:'Missing'}]}]});
    assert.equal(entries.length,3);assert.deepEqual(entries[0].folders,[[],['Nested']]);
    const parts=[],loading=[];
    const options={name:'Matsuoka',resolveSource,fetchBlob:async path=>sources[path],onPart:part=>parts.push(part),
        loadProject:async entry=>{loading.push(entry.slug);if(entry.slug==='missing')throw new Error('original missing');return {project:project(),revision:7};}};
    const result=await Collection.run(entries,options);
    assert.deepEqual(loading,['public','second','missing']);
    assert.deepEqual(result.results.map(row=>row.status),['ready','ready','failed'],JSON.stringify(result.results));assert.equal(parts.length,1);
    const zip=await loadZip(parts[0].blob),manifest=JSON.parse(await zip.file('manifest.json').async('string'));
    assert.equal(manifest.complete,false);assert.equal(manifest.projectCount,3);assert.equal(manifest.results[2].error,'original missing');
    assert.equal(new Set(result.results.filter(r=>r.archivePath).map(r=>r.archivePath)).size,2,'same names cannot collide');
    assert.equal(Object.keys(zip.files).filter(name=>/\.zip$/.test(name)).length,2);
    for(const row of result.results.filter(r=>r.status==='ready'))await Archive.prepareImport(
        await JSZip.loadAsync(await zip.file(row.archivePath).async('uint8array'),{checkCRC32:true}),
        await innerManifest(await JSZip.loadAsync(await zip.file(row.archivePath).async('uint8array'))));
    const retried=[];
    const retry=await Collection.run(entries.filter(e=>result.results.some(r=>r.slug===e.slug&&r.status!=='ready')),
        {...options,loadProject:async entry=>{retried.push(entry.slug);return {project:project()};}});
    assert.deepEqual(retried,['missing']);assert.equal(retry.results[0].status,'ready');
    const split=[];
    const divided=await Collection.run(entries.slice(0,2),{...options,partBytes:1,onPart:part=>split.push(part)});
    assert.equal(split.length,2);assert.ok(divided.parts.every(part=>part.count===1));
    const last=JSON.parse(await (await loadZip(split[1].blob)).file('manifest.json').async('string'));
    assert.equal(last.finalPart,true);assert.equal(last.complete,true);assert.ok(last.results.every(row=>row.status==='ready'));
    const named=[];
    const renamed=await Collection.run(entries.slice(0,1),{...options,filenameKind:'selected-destination-name',
        resolvePartFilename:async({filename})=>filename.replace(/\.zip$/,'__2.zip'),onPart:part=>named.push(part)});
    const renamedZip=await loadZip(named[0].blob),renamedManifest=JSON.parse(await renamedZip.file('manifest.json').async('string'));
    const renamedReport=JSON.parse(await renamedZip.file('download-results.json').async('string'));
    assert.match(named[0].filename,/__2\.zip$/);assert.equal(renamedManifest.filename,named[0].filename);
    assert.equal(renamedManifest.projects[0].part,named[0].filename);assert.equal(renamedReport[0].part,named[0].filename);
    assert.equal(renamed.parts[0].filename,named[0].filename);assert.equal(renamed.results[0].part,named[0].filename);
    assert.equal(renamedReport[0].partFilenameKind,'selected-destination-name');
    const aborter=new AbortController(),cancelParts=[];let fetched=0;
    const cancelled=await Collection.run(entries,{...options,signal:aborter.signal,onPart:part=>cancelParts.push(part),
        fetchBlob:async path=>{fetched++;aborter.abort();return sources[path];}});
    assert.equal(cancelled.cancelled,true);assert.equal(fetched,1);assert.equal(cancelParts.length,0);
    assert.ok(cancelled.results.every(row=>row.status==='cancelled'));
    const changed=await Collection.run(entries.slice(0,1),{...options,loadProject:async()=>({project:project(),validate:async()=>{throw new Error('published revision changed');}})});
    assert.equal(changed.results[0].status,'failed');assert.equal(changed.parts.length,0);
}
async function remoteParquetSingleExport() {
    const target=context(false,true);vm.runInContext(standalone('freezeMsiSourceReferences'),target);
    const p=target.App.project,section=p.sections[0];
    section.msiSeries.MSI_PQ={kind:'parquet',blobId:null,sourceUrl:'https://example.test/p/original.parquet',
        storagePath:'p/original.parquet',sourceFileId:'pq',sourceReference:'parquet-source',filename:'remote.parquet',colIdx:0};
    section.msiFiles.pq={...section.msiSeries.MSI_PQ};
    let fetched=0;
    target.ShareRefresh={fetchBlob:async()=>{fetched++;return sources['p/original.parquet'];}};
    target.SupabaseClient.publicUrl=(_,path)=>'https://example.test/'+path;
    const before=clone(p);await target.exportProjectAsZip();
    assert.deepEqual(target.alerts,[]);assert.ok(target.exported);assert.equal(fetched,1);
    assert.deepEqual(p,before,'single-project export never replaces the shared Range source with an IDB ID');
    const manifest=await innerManifest(target.exported);
    const entry=manifest.sections[0].originalSeries.MSI_PQ;
    assert.ok(entry.sourcePath);assert.equal(entry.sourceReference,'parquet-source');
    assert.deepEqual(new Uint8Array(await (await target.exported.file(entry.sourcePath).async('blob')).arrayBuffer()),
        new Uint8Array(await sources['p/original.parquet'].arrayBuffer()));
    const reader=Loader.createArchiveReader({resolveSource,fetchBlob:async()=>new Blob(['bad'])});
    const raw={kind:'parquet',sourceUrl:'unused',storagePath:'p/original.parquet',sourceBytes:9};
    reader.prepare(raw);await assert.rejects(reader.ensure(raw),{code:'SOURCE_SIZE_MISMATCH'});reader.dispose();
}
async function main() {
    assert.equal(await Collection.crc32(new Blob(['123456789'])),0xcbf43926,'standard CRC32 fixture');
    const large=new Blob(['x'.repeat(3*1024*1024)]),slice=large.slice.bind(large);let largestRead=0;
    large.slice=(start,end)=>{largestRead=Math.max(largestRead,end-start);return slice(start,end);};
    large.arrayBuffer=()=>{throw new Error('must not materialize the complete original/inner ZIP');};
    const bounded=await Collection.storedZip([{path:'large-original.bin',blob:large}]);
    assert.ok(largestRead<=512*1024);assert.equal((await loadZip(bounded)).files['large-original.bin']._data.uncompressedSize,large.size);
    await assert.rejects(Collection.storedZip([{path:'too-large.bin',blob:{size:0xffffffff,slice(){throw new Error('must fail before reading');}}}]),{code:'COLLECTION_TOO_LARGE'});
    await archiveRoundTrip();await sharedRoundTrip();await sessions();await paginatedRois();await paginatedCollaboration();await collections();await remoteParquetSingleExport();
    console.log('Shared collection: PASS (nested/auth, exact-source v3 import, saved collaboration/image/affine restoration, 3 RPC pagination, source/ROI/ratio preservation, filename collisions, partial/retry/cancel/split, remote Parquet single export)');
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixture,project,sources,collaborationFixture};
