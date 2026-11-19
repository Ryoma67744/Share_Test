'use strict';
const assert = require('node:assert/strict');
const {changeDetails,missingAlignmentGroups,missingPublishedAlignmentSections} = require('../viewer/publish-safety.js');
const filename = 'slide.ome.tif';
const record = {scope:'group', groupId:'g1', transform:[1,0,0,1,10,20]};
const alignment = {HE_STAIN:{byGroup:{g1:record}}};
const path = 'fixture/publish-v2/original';
const local = {
    displayName:'Sample',
    shareInfo:{slug:'fixture', serverRevision:1, blobPaths:{imported:{path}}},
    sections:[{id:'local-1',displayName:'Section A',meta:{alignment},
        images:{HE_STAIN:{filename,blobId:'imported'}}}],
    rois:[
        {colorKey:'a',name:'Tissue',polysBySection:{'local-1':[[1,1],[2,1],[2,2]]}},
        {colorKey:'v',_collab:true,name:'Shared ROI',polysBySection:{'local-1':[[0,0]]}}
    ]
};
const doc = {
    publish_revision:1,meta:{display_name:'Sample',project_meta:{msiSmoothing:'none',roiMedia:{version:1,items:[]}}},
    sections:[{id:'server-uuid',ordinal:1,display_name:'Section A',meta:{overlays:[],client_id:'local-1',alignment},
        storage_paths:{images:{HE_STAIN:{path,filename}}}}],
    rois:[
        {section_id:'server-uuid',created_by:'viewer',color_key:'v',name:'Their ROI',poly_msi:[]},
        {section_id:'server-uuid',created_by:'master',color_key:'a',name:'Tissue',poly_msi:[[1,1],[2,1],[2,2]]}
    ]
};
assert.deepEqual(changeDetails(local, doc), []);
const changed = structuredClone(local);
changed.displayName = 'Renamed';
changed.sections[0].meta.alignment.HE_STAIN.byGroup = {};
changed.sections[0].images.HE_STAIN = {blobId:'replacement',storagePath:path,filename};
changed.rois[0].polysBySection['local-1'][0][0] = 3;
changed.sections.push({id:'second', displayName:'New', meta:{}, msiFiles:{f:{filename:'msi.raw'}}});
const before = structuredClone([changed,doc]);
const rows = changeDetails(changed,doc);
assert.deepEqual([changed,doc],before,'inspection does not modify local or published documents');
assert.ok(rows.some(row => row.field==='プロジェクト名' && row.kind==='different'));
assert.ok(rows.some(row => row.section==='Section A' && row.field==='共通位置合わせ'
    && row.protectedAlignment && row.item.includes('HE_STAIN') && row.item.includes('g1') && row.kind==='server'));
assert.ok(rows.some(row => row.field==='ROI' && row.item.includes('Tissue') && row.kind==='different'));
assert.ok(rows.some(row => row.field==='HE/IF画像' && row.kind==='unverified'),
    'a new local blob cannot reuse a stale storagePath as proof');
assert.ok(rows.some(row => row.section==='New' && row.field==='MSI原本' && row.kind==='local'));
assert.equal(rows.filter(row => row.item.includes('Their ROI') || row.item.includes('Shared ROI')).length,0);
const newRows = changeDetails(local,null);
assert.ok(newRows.some(row => row.section==='Section A' && row.field==='共通位置合わせ' && row.kind==='local'));
assert.ok(newRows.every(row => !row.protectedAlignment && row.kind!=='server'));
const removed = changeDetails({...local,sections:[]},doc);
assert.ok(removed.some(row=>row.field==='切片' && row.kind==='server'));
assert.ok(removed.every(row=>!row.protectedAlignment), 'explicit whole-section removal is distinct from losing a group on an existing section');
const reverseKeys = structuredClone(doc);
reverseKeys.sections[0].meta.alignment.HE_STAIN.byGroup.g1 = {transform:[1,0,0,1,10,20],groupId:'g1',scope:'group'};
assert.deepEqual(changeDetails(local,reverseKeys),[]);
const duplicateLabels = structuredClone(changed);
duplicateLabels.sections[1].displayName='Section A';
assert.ok(changeDetails(duplicateLabels,doc).some(row=>row.section==='Section A (local-1)' && row.protectedAlignment));
const withPhoto = structuredClone(local), publicWithPhoto = structuredClone(doc);
withPhoto.meta = {roiMedia:{version:1,items:[
    {id:'photo',sectionId:'local-1',filename:'roi.png',blobId:'imported',umPerPixel:null,roiSnapshot:{vertices:[[1,2]],geometry:null}}
]}};
publicWithPhoto.meta.project_meta.roiMedia.items.push(
    {id:'photo',sectionId:'local-1',filename:'roi.png',storagePath:path,roiSnapshot:{vertices:[[1,2]]}});
assert.deepEqual(changeDetails(withPhoto,publicWithPhoto),[], 'SQL strips null object fields from published photo metadata');
const savedGroups = {alignment:{
    HE:{byGroup:{g1:{},g2:null}}, IF:{byGroup:{g3:{}}}, oldStyle:{bySource:{x:{}}}
}};
assert.deepEqual(missingAlignmentGroups(savedGroups,{alignment:{HE:{byGroup:{g2:null}}}}),
    [{layer:'HE',groupId:'g1'},{layer:'IF',groupId:'g3'}]);
assert.deepEqual(missingAlignmentGroups({}, savedGroups),[]);
const originalRows = {sections:[
    {id:'uuid',display_name:'First',meta:{client_id:'local',...savedGroups}},
    {id:'old-uuid-only',display_name:'First',meta:savedGroups},
    {id:'deleted-uuid',display_name:'Removed',meta:{client_id:'removed',...savedGroups}}
]};
assert.deepEqual(missingPublishedAlignmentSections(originalRows,[
    {id:'local',displayName:'Edited',meta:{alignment:{HE:{byGroup:{g1:[],g2:null}}}}},
    {id:'old-uuid-only',displayName:'First',meta:{}},
    {id:'brand-new',displayName:'First',meta:{}}
]), [
    {sectionId:'uuid',clientSectionId:'local',sectionName:'Edited',missing:[{layer:'IF',groupId:'g3'}]}
]);
const legacyLocal = structuredClone(local), legacyRemote = structuredClone(doc);
legacyLocal.sections[0].msiFiles = {f:{id:'f',filename:'sample.raw',kind:'raw',blobId:'imported'}};
legacyLocal.sections[0].msiSeries = {compound:{filename:'sample.raw',kind:'raw',sourceFileId:'f',blobId:'imported'}};
legacyRemote.sections[0].storage_paths.msiSeries = {compound:{filename:'sample.raw',kind:'raw',sourceFileId:'f',path}};
assert.deepEqual(changeDetails(legacyLocal,legacyRemote), [], 'imported legacy file-level entry resolves via the published molecule source');
console.log('Published change locations: PASS');
