'use strict';
// Real ROI drawing/migration/quantification functions, with deterministic I/O.
const assert=require('node:assert/strict'),vm=require('node:vm');
const {html,standalone}=require('./viewer-runtime.cjs');
const Groups=require('../viewer/msi-spatial-groups.js');
const plain=v=>JSON.parse(JSON.stringify(v));
const nodes=new Map(),messages=[];
function node(){return {value:'group',textContent:'',style:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){}};}
const ctx=vm.createContext({console,Map,Set,Float64Array,setTimeout,clearTimeout,
    MsiSpatialGroups:Groups,msiSourceNumber:Number,window:{DESI_OFFLINE:false},
    document:{getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}},
    showToast:s=>messages.push(s),prompt:()=> 'Shared cortex',uid:()=> 'new-roi',
    pickUnusedColorKey:()=>({key:'ROI_1',rgba:[255,0,0,200]}),storeRoiPaletteColor(){},
    populateRoiList(){},updateAnalysisModeUi(){},SupabaseClient:{},_shareTokenExpired:false,DEFAULT_ANATOMY_PALETTE:{},
});
const functions=['pointInPolygon','buildLegacyMsiGrid','buildMsiGrid','msiSourceReference','createMsiSourceGeometry',
    'msiAxisInterpolate','msiValidRoiGeometry','roiContainsSourcePoint','msiRoiGeometryMeta','msiLayerSourceGeometry',
    'roiPolygonForDisplay','collectRoiSourceRows','extractRoiRawFromSection','encodeRoiPolygon','decodeRoiPolygon','remapRoiGeometry',
    'ensureSpatialServerSupport','_isMissingRpc','_isStaleVersionError','groupRoiRowsByColor'];
vm.runInContext(functions.map(name=>(html.includes('async function '+name+'(')?'async ':'')+standalone(name)).join('\n')+'\n'+html.slice(html.indexOf('const App = {'),html.indexOf('\n};',html.indexOf('const App = {'))+3)+'\nthis.app=App;',ctx);
const app=ctx.app;
const rows=[{x:0,y:0,v:10,rowId:'a'},{x:0,y:0,v:30,rowId:'b'},
    {x:1,y:0,v:100,rowId:'c'},{x:0,y:1,v:50,rowId:'d'},{x:1,y:1,v:NaN,rowId:'e'}];
const section={id:'section',meta:{},msiSeries:{}};
const grids=new Map();
function add(key,source,dx=0,factor=1){
    const entry={kind:'txt',sourceFileId:source,x:'x',y:'y',v:'v'};
    const data=rows.map(r=>({...r,x:r.x+dx,v:r.v*factor}));
    // The complete grid is present even when one intensity is unavailable.
    const geometry=ctx.createMsiSourceGeometry(data.map(r=>({...r,v:Number.isFinite(r.v)?r.v:0})),entry);
    section.msiSeries[key]=entry;grids.set(key,{rows:data,sourceGeometry:geometry});
    Groups.ensureGroup(section,entry,geometry);return entry;
}
add('MSI_A','file-a');add('MSI_B','file-b',0,2);add('MSI_SHIFT','shifted',10);
let focus='MSI_A',saved=null,failSave=false;
const panel={section,_pickRefMsiKey:()=>focus,setDrawingPointerActive(){},
    msiValueRasters:new Map([...grids].map(([k,g])=>[k,{sourceGeometry:g.sourceGeometry}]))};
app.project={id:'project',sections:[section],rois:[]};app.panels=new Map([['section',panel]]);app.activeSectionId='section';
app.redrawAllRois=()=>{};app.renderAnalysis=()=>{};app.sectionVisibility=()=>({flushDeferred(){}});
app.queueSave=()=>{};app._flushSave=async()=>{if(failSave)return false;saved=plain(app.project);return true;};
app._verifyPersistence=async()=>{};
ctx._ensureRoiRawGrid=async(s,key)=>grids.get(key);
const poly=[[-.5,-.5],[1.5,-.5],[1.5,.5],[-.5,.5]];
function method(name){const start=html.indexOf('    '+name+'(');return vm.runInContext('({'+html.slice(start,html.indexOf('\n    }',start)+6).trim()+'})',ctx)[name];}
const drawingMatches=method('_drawingMatchesMsiSource');

(async()=>{
    await app.startDrawing();assert.equal(app.drawing.mode,true);
    assert.equal(app.drawing.sourceGeometry.version,'msi-group-v1');
    const originalFrame=plain(app.drawing.sourceGeometry);
    app.drawing.vertices=plain(poly);focus='MSI_B';
    assert.equal(drawingMatches.call(panel),true,'drawing continues across verified same-coordinate sources');
    focus='MSI_SHIFT';assert.equal(drawingMatches.call(panel),false);
    await app.finalizeDrawing();assert.equal(app.drawing.mode,true,'wrong frame retains unfinished vertices');
    assert.equal(app.project.rois.length,0);
    focus='MSI_B';await app.finalizeDrawing();
    assert.equal(app.project.rois.length,1);const roi=app.project.rois[0];
    assert.deepEqual(plain(roi.geometryBySection.section),originalFrame,'editing on B retains the common frame established on A');
    for(const key of ['MSI_A','MSI_B'])assert.deepEqual(plain(ctx.roiPolygonForDisplay(roi,section,key,poly)),poly);
    assert.equal(ctx.roiPolygonForDisplay(roi,section,'MSI_SHIFT',poly),null);
    const qa=await ctx.extractRoiRawFromSection(panel,'MSI_A',poly,roi);
    const qb=await ctx.extractRoiRawFromSection(panel,'MSI_B',poly,roi);
    assert.deepEqual(plain(qa.values),[10,30,100]);assert.deepEqual(plain(qb.values),[20,60,200]);
    assert.deepEqual(plain(qa.rowIds),['a','b','c']);assert.equal(qa.nUniqueCoordinates,2);
    assert.equal((await ctx.extractRoiRawFromSection(panel,'MSI_SHIFT',poly,roi)).reason,'roi-group-mismatch');
    assert.equal(saved.rois[0].geometryBySection.section.version,'msi-group-v1');
    const transported=ctx.decodeRoiPolygon(plain(ctx.encodeRoiPolygon(roi,'section')));
    assert.deepEqual(plain(transported.geometry),originalFrame);
    const imported=plain(section);imported.id='imported';imported.meta.client_id='imported';
    const remapped=ctx.remapRoiGeometry(roi.geometryBySection,{section:'imported'});
    assert.equal(Groups.roiCompatible(remapped.imported,grids.get('MSI_B').sourceGeometry,imported,imported.msiSeries.MSI_B),true);
    assert.equal(Groups.roiCompatible(originalFrame,grids.get('MSI_B').sourceGeometry,imported,imported.msiSeries.MSI_B),false,'a distinct section does not borrow an ROI');

    add('MSI_LATE','file-late',0,3);panel.msiValueRasters.set('MSI_LATE',{sourceGeometry:grids.get('MSI_LATE').sourceGeometry});
    assert.deepEqual(plain((await ctx.extractRoiRawFromSection(panel,'MSI_LATE',poly,roi)).values),[30,90,300]);
    assert.deepEqual(plain(roi.geometryBySection.section),originalFrame,'later membership does not rewrite the ROI');
    const changed={...section.msiSeries.MSI_B,sourceRevision:'changed'};
    assert.equal(Groups.roiCompatible(originalFrame,grids.get('MSI_B').sourceGeometry,section,changed),false);

    // Explicitly source-scoped drawing and existing legacy ROIs remain strict.
    nodes.get('roi-create-scope').value='source';focus='MSI_A';ctx.uid=()=> 'individual';
    await app.startDrawing();app.drawing.vertices=plain(poly);await app.finalizeDrawing();
    const individual=app.project.rois.find(r=>r.id==='individual');
    assert.equal(individual.geometryBySection.section.version,'msi-source-v1');
    assert.equal(ctx.roiPolygonForDisplay(individual,section,'MSI_B',poly),null);
    const beforeRows=await ctx.extractRoiRawFromSection(panel,'MSI_A',poly,individual);
    await app.shareRoisInSection(['individual']);
    assert.equal(individual.geometryBySection.section.version,'msi-group-v1');
    assert.deepEqual(plain((await ctx.extractRoiRawFromSection(panel,'MSI_A',poly,individual)).rowIds),plain(beforeRows.rowIds));
    assert.deepEqual(plain((await ctx.extractRoiRawFromSection(panel,'MSI_B',poly,individual)).values),[20,60,200]);
    const invalid={id:'ambiguous',name:'Old ROI',polysBySection:{section:plain(poly)}};
    app.project.rois.push(invalid);const beforeInvalid=plain(invalid);
    await assert.rejects(app.shareRoisInSection(['ambiguous']),/描画元/);
    assert.deepEqual(plain(invalid),beforeInvalid,'ambiguous legacy geometry is preserved');

    // Conversion first validates all candidates; one failure leaves every ROI intact.
    const legacy=plain(individual);legacy.id='legacy';legacy.geometryBySection.section={version:'msi-source-v1',
        sourceRef:grids.get('MSI_A').sourceGeometry.sourceRef,displayGeometry:plain(grids.get('MSI_A').sourceGeometry.displayGeometry)};
    app.project.rois.push(legacy);const legacyBefore=plain(legacy);
    await assert.rejects(app.shareRoisInSection(['legacy','ambiguous']),/描画元/);assert.deepEqual(plain(legacy),legacyBefore);
    failSave=true;await assert.rejects(app.shareRoisInSection(['legacy']),/未保存/);
    assert.equal(legacy.geometryBySection.section.version,'msi-group-v1','failed local save retains reviewable edits');failSave=false;

    // Capability errors cannot silently create old-format shared ROIs.
    app.shareMode={token:'shared'};nodes.get('roi-create-scope').value='group';focus='MSI_A';
    ctx.SupabaseClient.spatialGroupCapabilities=async()=>({version:0});
    await app.startDrawing();assert.equal(app.drawing.mode,false);assert.match(messages.at(-1),/サーバ/);
    ctx.SupabaseClient.spatialGroupCapabilities=async()=>({version:1,roiGeometry:'msi-group-v1',alignmentScope:'group',protectDowngrade:true});
    assert.equal(await ctx.ensureSpatialServerSupport(),true);
    // A pending edit of an already-published color must survive an old poll,
    // including a request failure, and hold the edit lock until it settles.
    app.project.rois=[roi];roi.serverIdsBySection={section:{id:'remote-roi',version:1}};
    const oldRemote={id:'remote-roi',section_id:'section',color_key:roi.colorKey,name:roi.name,
        version:1,poly_msi:plain(ctx.encodeRoiPolygon(roi,'section'))};
    let depth=0,completeWrite;
    app._tryAcquireRoiLock=async()=>{depth++;return true;};app._releaseRoiLock=()=>{depth--;};
    app.refreshAnalysisScope=()=>{};
    ctx.fetchAllShareRois=async()=>[oldRemote];
    ctx.SupabaseClient.updateRoi=async()=>new Promise((resolve,reject)=>{completeWrite={resolve,reject};});
    await app.startDrawing(roi.id);app.drawing.vertices=poly.map(p=>[p[0],p[1]+.1]);
    const edited=plain(app.drawing.vertices),writing=app.finalizeDrawing();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(depth,1,'save retains lock after drawing is closed');assert.equal(roi._unsynced,true);
    await app._refreshShareRois();assert.equal(app.project.rois[0],roi);assert.deepEqual(plain(roi.polysBySection.section),edited);
    completeWrite.reject(new Error('fixture offline'));await writing;
    assert.equal(depth,0);assert.equal(roi._unsynced,true);
    await app._refreshShareRois();assert.deepEqual(plain(app.project.rois[0].polysBySection.section),edited);

    // A late poll started before a successful edit must not restore old data.
    let completePoll;ctx.fetchAllShareRois=()=>new Promise(resolve=>{completePoll=resolve;});
    const stalePoll=app._refreshShareRois();
    ctx.SupabaseClient.updateRoi=async()=>({id:'remote-roi',version:2});
    await app.startDrawing(roi.id);app.drawing.vertices=plain(poly);await app.finalizeDrawing();
    completePoll([oldRemote]);await stalePoll;assert.equal(app.project.rois[0],roi);assert.equal(roi.serverIdsBySection.section.version,2);

    // A membership enrolled during migration preflight cannot be overwritten
    // with the older staged registry.
    app.shareMode=null;app.project.rois=[legacy];legacy.geometryBySection.section=plain(legacyBefore.geometryBySection.section);
    ctx._ensureRoiRawGrid=async(s,key)=>{add('MSI_CONCURRENT','concurrent',0,4);return grids.get(key);};
    await assert.rejects(app.shareRoisInSection(['legacy']),/確認中/);
    assert.equal(legacy.geometryBySection.section.version,'msi-source-v1');
    assert.ok(Groups.resolveMembership(section,section.msiSeries.MSI_CONCURRENT,grids.get('MSI_CONCURRENT').sourceGeometry));
    console.log('Spatial ROI regression: PASS (drawing, shared editing, independent source rows, late members, legacy migration, transport, save/capability failures)');
})().catch(e=>{console.error(e);process.exitCode=1;});
