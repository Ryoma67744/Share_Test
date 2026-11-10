'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Groups=require('../viewer/msi-spatial-groups.js');
const {html}=require('./viewer-runtime.cjs');
const standalone=name=>{const start=html.search(new RegExp('(?:async )?function '+name+'\\('));
    assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n}',start)+2);};
const names=['msiSourceCell','msiSourceNumber','msiSourceRow','msiDelimitedRecords','msiTextTable','msiTextValueColumn',
    'parseTxtToRows','msiMatrixFromRows','msiSourceFrameKey','extractSourceMatrixForExport','msiCsvRowOrder','msiCsvCellText',
    'msiCellMetadata','buildOneCsvTable','buildSampleCsvGroups','csvEscape','buildMsiGrid','buildLegacyMsiGrid',
    'msiSourceReference','createMsiSourceGeometry','msiAxisInterpolate','pointInPolygon','roiContainsSourcePoint',
    'msiValidRoiGeometry','msiRoiGeometryMeta','roiPolygonForDisplay','msiLayerSourceGeometry',
    'tryAppendUserRoiColumnsToTxt','appendRoisToGenericLines','collectRoiSourceRows','extractRoiRawFromSection'];
const ctx=vm.createContext({console,TextEncoder,TextDecoder,Blob,Map,Set,Float64Array,Uint8Array,Promise,
    MsiSpatialGroups:Groups,ProjectArchive:require('../viewer/project-archive.js'),
    MsiRoiRange:require('../viewer/msi-roi-range.js'),findCompoundMeta:()=>null,formatDisplayName:x=>x,
    sanitizeCompoundName:x=>x,sortMethodKeys:keys=>keys,_yieldUi:async()=>{},parseAnalyteHeader:()=>null,
    ensureMsiDisplayContext(){},identStamp:value=>value,MSI_DEFAULT_DISPLAY_PERCENTILE:.999});
vm.runInContext(names.map(standalone).join('\n'),ctx);
const bytes=value=>new TextEncoder().encode(value).buffer;
const makeEntry=id=>({kind:'txt',sourceFileId:id,blobId:'blob-'+id,x:'x',y:'y',v:'value'});
const a=makeEntry('A'),b=makeEntry('B'),c=makeEntry('C');
const texts={A:'x,y,value\n0,0,10\n1,0,20\n',B:'x,y,value\n1,0,4\n0,0,2\n',C:'x,y,value\n0,0,1\n1,0,1\n'};
const rows=Object.fromEntries(Object.entries({A:a,B:b,C:c}).map(([id,ent])=>[id,ctx.parseTxtToRows(bytes(texts[id]),ent)]));
const geometries=Object.fromEntries(Object.entries({A:a,B:b,C:c}).map(([id,ent])=>[id,ctx.createMsiSourceGeometry(rows[id],ent)]));
const section={id:'s',meta:{},msiSeries:{MSI_A:a,MSI_B:b}};
Groups.ensureGroup(section,a,geometries.A);Groups.ensureGroup(section,b,geometries.B);
const roi={id:'roi',name:'Shared ROI',polysBySection:{s:[[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]]},
    geometryBySection:{s:Groups.roiMeta(section,a,geometries.A)}};
const project={id:'project',sections:[section],rois:[roi]};
ctx.ProjectStorage={getBlob:async id=>({blob:new Blob([texts[id.slice(5)]])})};
const parseCsv=table=>Array.from(ctx.msiDelimitedRecords(table.csvText,',').slice(1),row=>Array.from(row));

async function main(){
    const before=JSON.stringify({texts,rows,roi});
    const combined=await ctx.buildSampleCsvGroups(section,project,'none');
    assert.equal(combined.length,1,'verified same-section group sources can share an ROI-labelled CSV');
    assert.deepEqual(parseCsv(combined[0]),[['0','0','10','2','Shared ROI'],['1','0','20','4','']]);
    assert.equal(combined[0].sourceMetadata.roiAssignments[0].status,'resolved');
    const originalMeta=roi.geometryBySection.s;
    roi.geometryBySection.s={version:'msi-source-v1',sourceRef:geometries.A.sourceRef,displayGeometry:geometries.A.displayGeometry};
    const individual=await ctx.buildSampleCsvGroups(section,project,'none');
    assert.equal(individual.length,2,'equal coordinates do not merge differently scoped ROI labels');
    assert.equal(parseCsv(individual[0])[0].at(-1),'Shared ROI');
    assert.ok(parseCsv(individual[1]).every(row=>row.at(-1)===''));
    assert.equal(individual[1].sourceMetadata.roiAssignments[0].status,'unresolved');
    roi.geometryBySection.s=originalMeta;
    section.msiSeries.MSI_C=c;
    const unregistered=await ctx.buildSampleCsvGroups(section,project,'none');
    assert.equal(unregistered.length,2,'unregistered same-coordinate source remains separated');
    assert.equal(unregistered[1].sourceMetadata.roiAssignments[0].status,'unresolved');
    delete section.msiSeries.MSI_C;
    const appended=await ctx.tryAppendUserRoiColumnsToTxt(new Blob([texts.B]),section,b,project);
    assert.match(new TextDecoder().decode(appended),/0,0,2\tShared ROI|0,0,2,Shared ROI/,
        'TXT companion uses target source geometry and section membership');
    assert.equal(JSON.stringify({texts,rows,roi}),before,'exports leave original rows and saved ROI unchanged');

    // The actual media eligibility function accepts group members, but keeps
    // legacy source-scoped photographs and unknown sources isolated.
    const media=fs.readFileSync(path.join(__dirname,'../viewer/roi-media-app.js'),'utf8');
    const mediaFunction=name=>{const start=media.indexOf('    function '+name+'(');return media.slice(start,media.indexOf('\n    }',start)+6);};
    ctx.App={panels:new Map()};ctx.root=ctx;
    const rasterB={W:2,H:1,values:Float64Array.from([2,4]),sourceGeometry:geometries.B};
    const panel={section,msiValueRasters:new Map([['MSI_A',{sourceGeometry:geometries.A}],['MSI_B',rasterB]]),_msiLoadIdentity:()=> 'B'};
    ctx.App.panels.set(section.id,panel);
    vm.runInContext(mediaFunction('sourceKeyFor')+'\n'+mediaFunction('compatibility'),ctx);
    assert.equal(ctx.compatibility(roi,section,'MSI_B'),'');
    section.msiSeries.MSI_C=c;
    assert.notEqual(ctx.compatibility(roi,section,'MSI_C'),'');
    delete section.msiSeries.MSI_C;
    roi.geometryBySection.s={version:'msi-source-v1',sourceRef:geometries.A.sourceRef,displayGeometry:geometries.A.displayGeometry};
    assert.match(ctx.compatibility(roi,section,'MSI_B'),/測定ソース/);
    roi.geometryBySection.s=originalMeta;

    // Run the real ROI-only range method on a non-anchor group member.
    ctx._ensureRoiRawGrid=async()=>({rows:rows.B,sourceGeometry:geometries.B});
    const start=html.indexOf('    ensureRoiDisplayRange(section, key)');
    const method=vm.runInContext('({'+html.slice(start,html.indexOf('\n    },',start)+7)+'}).ensureRoiDisplayRange',ctx);
    const app={project,panels:ctx.App.panels,_roiDisplayRangeRequest:()=>({cacheKey:'s|MSI_B',signature:'fixed',ent:b,rois:[roi]})};
    const range=await method.call(app,section,'MSI_B');
    assert.equal(range.status,'ready');assert.equal(range.source.status,'ready');
    assert.equal(range.source.n,1);assert.equal(range.source.max,2);

    // Ratio membership must be valid for both measured inputs, even when their
    // numeric coordinates already permit the ratio itself to be calculated.
    global.MsiSpatialGroups=Groups;
    global.document={getElementById:()=>null,createElement:()=>({setAttribute(){},append(){}})};
    const Core=require('../viewer/msi-ratio-core.js'),Model=require('../viewer/msi-ratio-model.js');
    const Display=require('../viewer/msi-display-settings.js'),Runtime=require('../viewer/msi-ratio-app.js');
    const def={id:'ratio',name:'A/B',revision:1,operation:'divide',calculationVersion:'msi-ratio-v1',denominatorMin:0,
        numeratorPolicy:'nonnegative',invalidPolicy:'exclude',bindings:{s:{numerator:Model.makeInputRef(a,'MSI_A'),
            denominator:Model.makeInputRef(b,'MSI_B'),coordinateConfirmed:true,coordinateEvidence:'same coordinates'}}};
    project.meta={msiRatios:{schemaVersion:1,definitions:[def]}};
    const ratioApp={project,panels:new Map(),getMsiDisplaySettings:()=>Display.preset('hdi'),queueSave(){},
        updateMsiDisplaySettings(){},setFocusCompoundKey(){},refreshMsiDisplayControls(){},repaintAllMsi(){}};
    class Panel{renderComposite(){}renderMsiThumbnail(){}}
    let sourceReads=0;
    const hooks={app:ratioApp,Panel,viewerBase:'http://localhost/viewer/',contextKey:()=>project.id,
        sourceReference:Groups.sourceReference,frameKey:Groups.memberKey,sourceIdentity:(s,k)=>JSON.stringify(s.msiSeries[k]),
        readGrid:async(s,k)=>{sourceReads++;return {rows:rows[k.slice(4)],sourceGeometry:geometries[k.slice(4)]};},
        roiMeta:ctx.msiRoiGeometryMeta,roiContains:ctx.roiContainsSourcePoint,otsuGrid:()=>null,otsuStamp:()=>'',
        inputLabel:(s,k)=>k,safeName:s=>s};
    const runtime=Runtime.install(hooks);
    const result=await runtime.resolve(section,Model.displayKey(def.id));
    assert.equal(result.roiStats[0].status,'ready');
    assert.equal(result.roiStats[0].statistics.totalRatio,5);
    const ratioKey=Model.displayKey(def.id),poly=roi.polysBySection.s,ratioPanel={section,project,
        msiValueRasters:new Map([[ratioKey,result.raster]])};
    ratioApp.panels.set(section.id,ratioPanel);ctx.App=ratioApp;
    ctx._ensureRoiRawGrid=(sec,key)=>ratioApp.ratioRawGrid(sec,key);
    assert.equal(ratioApp.ratioRoiCompatible(section,ratioKey,roi.geometryBySection.s),true);
    assert.ok(ctx.roiPolygonForDisplay(roi,section,ratioKey,poly));
    assert.equal((await ctx.extractRoiRawFromSection(ratioPanel,ratioKey,poly,roi)).unavailable,false);
    const readsBeforeGuards=sourceReads;
    const group=section.meta.spatialGroups.groups[0],savedMembers=group.members;
    group.members=savedMembers.filter(member=>member.key!==Groups.memberKey(b));
    assert.equal(ratioApp.ratioRoiCompatible(section,ratioKey,roi.geometryBySection.s),false);
    assert.equal(ctx.roiPolygonForDisplay(roi,section,ratioKey,poly),null,'Y removal hides ratio ROI outline and clip geometry');
    const blockedRaw=await ctx.extractRoiRawFromSection(ratioPanel,ratioKey,poly,roi);
    assert.equal(blockedRaw.unavailable,true);assert.equal(blockedRaw.reason,'roi-group-mismatch');
    const unavailable=await runtime.resolve(section,Model.displayKey(def.id));
    assert.equal(unavailable.roiStats[0].reason,'roi-group-mismatch');
    assert.equal(unavailable.roiStats[0].statistics,null,'denominator without valid group membership cannot borrow numerator ROI');
    assert.equal(sourceReads,readsBeforeGuards,'overlay and quantitative guards reuse decoded ratio inputs');
    group.members=savedMembers;
    // Force the production numeric LRU to evict this small fixture. The visible
    // ratio frame must retain its verified membership without another decode.
    const bounded={MsiRatioCore:Core,MsiRatioModel:Model,MsiSpatialGroups:Groups,document:global.document};
    const runtimeSource=fs.readFileSync(path.join(__dirname,'../viewer/msi-ratio-app.js'),'utf8');
    assert.ok(runtimeSource.includes('MAX_CACHE_BYTES=128*1024*1024'));
    vm.runInNewContext(runtimeSource.replace('MAX_CACHE_BYTES=128*1024*1024','MAX_CACHE_BYTES=1'),bounded);
    const boundedApp={project,panels:new Map(),getMsiDisplaySettings:()=>Display.preset('hdi'),queueSave(){},
        updateMsiDisplaySettings(){},setFocusCompoundKey(){},refreshMsiDisplayControls(){},repaintAllMsi(){}};
    const boundedRuntime=bounded.MsiRatioApp.install({...hooks,app:boundedApp});
    await boundedRuntime.resolve(section,ratioKey);
    const beforeEvictedGuard=sourceReads;
    assert.equal(boundedApp.ratioRoiCompatible(section,ratioKey,roi.geometryBySection.s),true,
        'numeric cache eviction does not hide a valid shared ROI overlay');
    group.members=savedMembers.filter(member=>member.key!==Groups.memberKey(b));
    assert.equal(boundedApp.ratioRoiCompatible(section,ratioKey,roi.geometryBySection.s),false);
    group.members=savedMembers;
    b.sourceRevision='changed';
    assert.equal(boundedApp.ratioRoiCompatible(section,ratioKey,roi.geometryBySection.s),false,
        'retained display frames still reject current input revision changes');
    delete b.sourceRevision;
    assert.equal(sourceReads,beforeEvictedGuard,'cache eviction guards perform no raw source reads');
    console.log('MSI spatial downstream regression: PASS (CSV scopes, TXT labels, media, ROI range, ratio both-input membership)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
