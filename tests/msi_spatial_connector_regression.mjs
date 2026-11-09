import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import Spatial from '../viewer/msi-spatial-groups.js';
import {createMsiSourceGeometry,extractRoiValues,roiContainsSourcePoint,stats,msiSourceReference,resolveRoiGeometryForSource} from '../connector/src/msi.js';

const clone=value=>JSON.parse(JSON.stringify(value));
const a={kind:'txt',sourceFileId:'pos',x:'x',y:'y',v:'signal'};
const b={...a,sourceFileId:'neg'};
const aRows=[{x:0,y:0,v:10,rowId:'a0'},{x:0,y:0,v:30,rowId:'a1'},
    {x:1,y:0,v:100,rowId:'a2'},{x:0,y:1,v:5,rowId:'a3'},{x:1,y:1,v:8,rowId:'a4'}];
const bRows=[{x:1,y:1,v:80,rowId:'b4'},{x:0,y:1,v:50,rowId:'b3'},
    {x:1,y:0,v:1000,rowId:'b2'},{x:0,y:0,v:100,rowId:'b0'},{x:0,y:0,v:300,rowId:'b1'}];
const section={id:'local-section',meta:{},msiSeries:{MSI_A:a,MSI_B:b}};
const ga=createMsiSourceGeometry(aRows,a),gb=createMsiSourceGeometry(bRows,b);
const roi=Spatial.roiMeta(section,a,ga);
Spatial.ensureGroup(section,b,gb);
const polygon=[[-0.5,-0.5],[1.5,-0.5],[1.5,0.5],[-0.5,0.5]];
const original=clone({section,aRows,bRows,roi,polygon});
const va=extractRoiValues(aRows,polygon,ga,roi,a,section);
const vb=extractRoiValues(bRows,polygon,gb,roi,b,section);
assert.deepEqual([...va],[10,30,100]);
assert.deepEqual([...vb],[1000,100,300]);
assert.deepEqual(va.rowIds,['a0','a1','a2']);
assert.deepEqual(vb.rowIds,['b2','b0','b1']);
assert.equal(stats(va).mean,140/3);
assert.equal(stats(vb).mean,1400/3);
assert.equal(stats(vb).n,3);
assert.equal(stats(vb).nUniqueCoordinates,2,'all duplicate rows remain quantitative inputs');
assert.deepEqual(clone({section,aRows,bRows,roi,polygon}),original,'read-only extraction never enrolls or changes metadata');

const serverSection={...clone(section),id:'server-section-uuid',meta:{...clone(section.meta),client_id:section.id}};
assert.deepEqual([...extractRoiValues(bRows,polygon,gb,roi,b,serverSection)],[1000,100,300]);
for(const foreign of [{...clone(section),id:'another-section'}, {...clone(section),meta:{}}])
    assert.throws(()=>extractRoiValues(bRows,polygon,gb,roi,b,foreign),/cannot be resolved/);
for(const patch of [{sourceFileId:'unregistered'},{sourceRevision:'new'},{sheet:'other'}]) {
    const changed={...b,...patch},geometry=createMsiSourceGeometry(bRows,changed);
    assert.throws(()=>extractRoiValues(bRows,polygon,geometry,roi,changed,section),/cannot be resolved/);
}
const shifted=bRows.map(row=>({...row,x:row.x+10}));
assert.throws(()=>extractRoiValues(shifted,polygon,createMsiSourceGeometry(shifted,b),roi,b,section),/cannot be resolved/);
const unknown={...roi,version:'future-roi'};
assert.throws(()=>extractRoiValues(bRows,polygon,gb,unknown,b,section),/cannot be resolved/);
assert.equal(roiContainsSourcePoint(polygon,roi,gb,0,0),null,'a group ROI needs section and measurement context');

// Legacy source-scoped ROI behavior is unchanged, including refusing a different source.
const legacy={version:'msi-source-v1',sourceRef:ga.sourceRef,displayGeometry:ga.displayGeometry};
assert.deepEqual([...extractRoiValues(aRows,polygon,ga,legacy,a)],[10,30,100]);
assert.throws(()=>extractRoiValues(bRows,polygon,gb,legacy,b,section),/cannot be resolved/);
assert.deepEqual([...extractRoiValues(aRows,polygon,ga,null,a)],[10,30,100]);

// A molecule with no valid values on one whole X axis still has the same raw
// acquisition coordinates. New groups use that complete frame; old unanchored
// polygons cannot inherit its ambiguous intensity-filtered historical frame.
const c={...a,sourceFileId:'missing-axis'};
const cRows=aRows.map(row=>({...row,v:row.x===1?NaN:row.v,rowId:'c'+row.rowId.slice(1)}));
const gc=createMsiSourceGeometry(cRows,c);
assert.equal(gc.currentConfirmed,true);
assert.equal(gc.legacy.confirmed,false);
assert.equal(gc.legacy.reason,'legacy-render-quant-axis-mismatch');
assert.equal(Spatial.geometryKey(gc),Spatial.geometryKey(ga));
const missingSection=clone(section);
missingSection.msiSeries.MSI_C=c;
assert.equal(Spatial.ensureGroup(missingSection,c,gc).groupId,roi.groupId);
assert.equal(Spatial.roiCompatible(roi,gc,missingSection,c),true);
const missingValues=extractRoiValues(cRows,polygon,gc,roi,c,missingSection);
assert.deepEqual([...missingValues],[10,30]);
assert.deepEqual(missingValues.rowIds,['c0','c1']);
assert.equal(stats(missingValues).n,2);
assert.equal(stats(missingValues).nUniqueCoordinates,1);
assert.throws(()=>extractRoiValues(cRows,polygon,gc,null,c),/Legacy ROI geometry is unconfirmed/);
const sourceScoped={version:'msi-source-v1',sourceRef:gc.sourceRef,displayGeometry:gc.displayGeometry};
assert.deepEqual([...extractRoiValues(cRows,polygon,gc,sourceScoped,c)],[10,30]);
assert.throws(()=>extractRoiValues(aRows,polygon,ga,sourceScoped,a,section),/cannot be resolved/);
for(const badGeometry of [
    createMsiSourceGeometry(cRows.map((row,i)=>i?row:{...row,x:NaN}),c),
    createMsiSourceGeometry(cRows.map((row,i)=>i?row:{...row,sourceCells:{x:{status:'invalid'}}}),c),
    createMsiSourceGeometry(cRows,{...c,archiveGeometryUnconfirmed:true}),
    createMsiSourceGeometry([],c)]) {
    assert.equal(badGeometry.currentConfirmed,false);
    assert.equal(Spatial.geometryKey(badGeometry),null,'invalid/unknown raw frames never join a group');
}

// Execute both real read-only tool paths with only transport/file readers stubbed.
// This catches losing section metadata during hydration as well as wrong-source
// geometry in stats and CSV, without a network or a live project's credentials.
const toolSource=await readFile(new URL('../connector/src/tools.js',import.meta.url),'utf8');
const lift=name=>{
    const start=toolSource.search(new RegExp('(?:async )?function '+name+'\\('));
    assert.ok(start>=0,name);
    return toolSource.slice(start,toolSource.indexOf('\n}',start)+2);
};
const match=(query,value)=>query==null||query===''||String(value).toLowerCase().includes(String(query).toLowerCase());
const context=vm.createContext({console,createMsiSourceGeometry,extractRoiValues,roiContainsSourcePoint,
    stats,msiSourceReference,resolveRoiGeometryForSource,ROI_STATS_MAX_PAIRS:25,matchStr:match,
    normName:value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,''),newRowCache:()=>({}),
    listProjectCatalog:async()=>[{slug:'fixture',is_public:true}],getReadToken:async()=>({token:'fixture-token'}),
    getProjectDoc:async()=>({meta:{},sections:[{id:serverSection.id,display_name:'Section',
        meta:clone(serverSection.meta),storage_paths:{msiSeries:clone(section.msiSeries)}}]}),
    listRois:async()=>[{name:'Tissue',color_key:'Red',poly_msi:{version:'msi-roi-polygon-v1',vertices:polygon,geometry:roi}}],
    loadRowsForDef:async def=>def.sourceFileId==='pos'?aRows:bRows});
vm.runInContext(['msiMaxIntensity','compoundInfo','findCatalogEntry','decodeConnectorRoiPolygon','loadProject',
    'narrowCompoundCandidates','getRoiStats','getMatrix'].map(lift).join('\n'),context);
const toolStats=await context.getRoiStats('fixture');
assert.deepEqual(clone(toolStats.results.map(row=>[row.compound_key,row.stats.mean,row.stats.n])),
    [['MSI_A',140/3,3],['MSI_B',1400/3,3]]);
const matrix=await context.getMatrix('fixture',{compound:'MSI_B',roi:'Tissue'});
assert.equal(matrix.total_rows,3);
assert.equal(matrix.csv,'x,y,value\n1,0,1000\n0,0,100\n0,0,300\n');
console.log('MSI shared-coordinate Connector regression: PASS');
