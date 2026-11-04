'use strict';
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {context, MemoryZip} = require('./zip_compatibility_regression.js');
const Archive = require('../viewer/project-archive.js');
const XLSX = require('../connector/node_modules/xlsx');
const clone = value => JSON.parse(JSON.stringify(value));
const text = value => new Blob([value], {type: 'text/csv'});
async function digest(blob) { return createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex'); }
function v1(copies = ['x,y,v\n0,0,0\n1,0,10\n', 'x,y,v\n0,0,0\n1,0,10\n']) {
  // The 2026-05-03 initial exporter wrote per-layer files and msiFiles
  // WITHOUT a path/blobId. It also stored ROI polygons without source geometry.
  const zip = new MemoryZip(), series = {};
  copies.forEach((source, i) => {
    const key = 'MSI_' + i, rel = 'data/msi_' + key + '__original.txt';
    zip.file('sections/old-section/' + rel, source instanceof Blob ? source : text(source));
    series[key] = {kind: 'txt', path: rel, filename: 'original.txt', sourceFileId: 'file', x: 'x', y: 'y', v: 'v'};
  });
  zip.file('sections/old-section/atlas.json', JSON.stringify({id: 'old-section', displayName: 'A', meta: {world_coords: {msi_um_per_px: {x: '70', y: '70'}}},
    images: {}, msiSeries: series, msiFiles: {file: {id: 'file', kind: 'txt', filename: 'original.txt'}}}));
  zip.file('project.json', JSON.stringify({format: 'desi_data_share_v1', id: 'old-project', displayName: 'Legacy', sectionOrder: ['old-section'],
    rois: [{id: 'old-roi', colorKey: 'r', polysBySection: {'old-section': [[0, 0], [1, 0], [0, 1]]}}], roiHidden: {'old-roi': true}}));
  return zip;
}
async function main() {
  for (const offline of [false, true]) {
    const target = context(offline);
    const zip = v1(); await target.importZipFile(zip);
    const saved = target.saved, sec = saved.sections[0], a = sec.msiSeries.MSI_0, b = sec.msiSeries.MSI_1;
    assert.equal(a.blobId, b.blobId, 'byte-identical per-layer copies share one original');
    assert.equal(sec.msiFiles.file.blobId, a.blobId, 'file-level original is restored');
    assert.equal(a.archiveProvenance.basis, 'legacy-v1-file');
    assert.equal(saved.roiHidden[saved.rois[0].id], true);
    assert.deepEqual(clone(saved.rois[0].polysBySection[sec.id]), [[0,0],[1,0],[0,1]]);
    assert.deepEqual(clone(saved.rois[0].geometryBySection), {}, 'do not invent old ROI geometry');
    assert.equal(sec.meta.world_coords.msi_um_per_px.x, '70', 'archive bytes/metadata are not numerically corrected');
    target.App.project = saved; await target.exportProjectAsZip();
    assert.ok(target.exported, 'initial-v1 recovery can be exported again');
    const again = context(!offline); await again.importZipFile(target.exported);
    assert.equal(again.saved.sections[0].msiSeries.MSI_0.archiveProvenance.basis, 'legacy-v1-file');
    assert.equal(await digest(target.blobs.get(a.blobId).blob), await digest(again.blobs.get(again.saved.sections[0].msiSeries.MSI_0.blobId).blob));
    assert.equal(target.ProjectStorage.__archiveTest.jobs.size, 0);
    assert.equal(target.ProjectStorage.__archiveTest.pins.size, 0);
  }
  // Real XLSX bytes model two old per-sheet ROI-augmented versions of one source.
  const variants = ['S1','S2'].map(changed => {
    const book = XLSX.utils.book_new();
    for (const sheet of ['S1','S2']) XLSX.utils.book_append_sheet(book,
      XLSX.utils.aoa_to_sheet([['x','y','v', ...(sheet === changed ? ['ROI'] : [])], [0,0,10,...(sheet === changed ? [1] : [])]]), sheet);
    return new Blob([XLSX.write(book, {bookType: 'xlsx', type: 'buffer'})]);
  });
  const variantsZip = v1(variants), atlasPath = 'sections/old-section/atlas.json';
  const atlas = JSON.parse(await variantsZip.file(atlasPath).async('string'));
  atlas.msiFiles.file.kind = 'xlsx';
  Object.values(atlas.msiSeries).forEach((entry, i) => Object.assign(entry, {kind: 'xlsx', sheet: 'S' + (i + 1), col_x: 'A', col_y: 'B', col_v: 'C', data_start_row: 2}));
  variantsZip.file(atlasPath, JSON.stringify(atlas));
  const target = context(false); await target.importZipFile(variantsZip);
  const sec = target.saved.sections[0], entries = Object.values(sec.msiSeries);
  assert.notEqual(entries[0].sourceFileId, entries[1].sourceFileId, 'distinct workbook variants are separate sources');
  assert.notEqual(entries[0].blobId, entries[1].blobId);
  for (let i=0; i<2; i++) {
    assert.equal(await digest(target.blobs.get(entries[i].blobId).blob), await digest(variants[i]));
    assert.equal(entries[i].archiveGeometryUnconfirmed, true, 'old source-specific geometry is not guessed');
    assert.equal(sec.msiFiles[entries[i].sourceFileId].blobId, entries[i].blobId);
  }
  target.App.project = target.saved; await target.exportProjectAsZip(); assert.ok(target.exported);

  for (const background of [null, 'drop', 'flag']) {
    const csv = text('x,y,A,ROI\n0,0,0,\n1,0,10,\n');
    const doc = {format:'desi_data_share_v2', displayName:'CSV legacy', sections:[{id:'s', images:{},
      data:[{path:'Data/A.csv', bgRemoved:background, compounds:[{layerKey:'MSI_A',vHeader:'A',sourceFileId:'f'}]}],
      msiFilesMeta:{f:{kind:'xlsx',filename:'old.xlsx'}}}]};
    const archive = new MemoryZip().file('Legacy.json',JSON.stringify(doc)).file('Data/A.csv',csv);
    const imported = context(false); await imported.importZipFile(archive);
    const entry = imported.saved.sections[0].msiSeries.MSI_A;
    assert.equal(entry.archiveProvenance.basis,'legacy-derived-csv');assert.equal(entry.archiveProvenance.background,background);
    assert.equal(await imported.blobs.get(entry.blobId).blob.text(),await csv.text(),'no 0/blank correction');
    imported.App.project = imported.saved; await imported.exportProjectAsZip();
    const roundtrip=context(true);await roundtrip.importZipFile(imported.exported);
    assert.deepEqual(clone(roundtrip.saved.sections[0].msiSeries.MSI_A.archiveProvenance),clone(entry.archiveProvenance),'new originalSeries marker never upgrades old CSV provenance');
  }
  for (const offline of [false,true]) {
    const missing=context(offline,true);missing.console={...console,error(){}};missing.blobs.delete('he');await missing.exportProjectAsZip();
    assert.equal(missing.exported,undefined,'missing HE aborts complete snapshot in both runtimes');
    assert.match(missing.alerts[0],/whole-slide.png/);
    const invalid=v1();delete invalid.files['sections/old-section/data/msi_MSI_1__original.txt'];
    const rejected=context(offline);await assert.rejects(rejected.importZipFile(invalid),/ZIPに原本がありません/);
    assert.equal(rejected.blobs.size,0,'preflight fails before writing any original');assert.equal(rejected.projects.size,0);
  }
  const mixedDoc={format:'desi_data_share_v2',sections:[{id:'s',images:{},data:[{path:'Data/a.csv',compounds:[{layerKey:'MSI_C',vHeader:'A'}]}],
    msiFilesMeta:{r:{sourcePath:'Source/a.raw.zip'},p:{sourcePath:'Source/a.parquet'}},
    rawSeries:{MSI_R:{sourceFileId:'r',func:2,channel:3}},parquetSeries:{MSI_P:{sourceFileId:'p',colIdx:8,annotation:'A'}}}]};
  const mixed=new MemoryZip().file('Project.json',JSON.stringify(mixedDoc)).file('Data/a.csv',text('x,y,A\n0,0,3\n'))
    .file('Source/a.raw.zip',text('raw fixture bytes')).file('Source/a.parquet',text('parquet fixture bytes'));
  const mixedTarget=context(true);await mixedTarget.importZipFile(mixed);
  const mixedSeries=mixedTarget.saved.sections[0].msiSeries;
  assert.equal(mixedSeries.MSI_C.archiveProvenance.basis,'legacy-derived-csv');
  assert.equal(mixedSeries.MSI_R.archiveProvenance.basis,'legacy-v2-file');assert.equal(mixedSeries.MSI_R.func,2);
  assert.equal(mixedSeries.MSI_P.archiveProvenance.basis,'legacy-v2-file');assert.equal(mixedSeries.MSI_P.colIdx,8);
  const conflict=clone(mixedDoc);conflict.sections[0].originalSeries={MSI_R:{kind:'raw',sourceFileId:'r',sourcePath:'Source/different.raw.zip'}};
  const conflicting=new MemoryZip();Object.assign(conflicting.files,mixed.files);
  conflicting.file('Project.json',JSON.stringify(conflict)).file('Source/different.raw.zip',text('different'));
  await assert.rejects(context(false).importZipFile(conflicting),/conflicts with its original/);

  // Real JSZip compression/CRC and production importer, not only the in-memory container.
  const JSZip=require('../vendor/jszip.min.js'),real=new JSZip(),fixture=v1();
  for(const [name,file] of Object.entries(fixture.files)){
    const value=await file.async('blob');real.file(name,value instanceof Blob?await value.arrayBuffer():value);
  }
  const packed=await real.generateAsync({type:'uint8array',compression:'STORE'}),realTarget=context(false);
  realTarget.JSZip=JSZip;await realTarget.importZipFile(packed);assert.equal(realTarget.saved.sections.length,1);
  const damaged=Buffer.from(packed);const needle=Buffer.from('x,y,v\n0,0,0\n1,0,10\n');
  const position=damaged.indexOf(needle);assert.ok(position>0);damaged[position+4]^=1;
  const corruptTarget=context(false);corruptTarget.JSZip=JSZip;
  await assert.rejects(corruptTarget.importZipFile(damaged),/CRC32/);assert.equal(corruptTarget.blobs.size,0);
  // Failure/cancellation cleanup cannot remove an existing project's original.
  const failed=context(false,true), storage=failed.ProjectStorage, before=failed.blobs.size;
  const controller=new AbortController();
  await assert.rejects(Archive.withImport(storage,async stage=>{await stage.putBlob({id:'new-stage',blob:text('new')});controller.abort();await stage.putProject({id:'new',sections:[]});},{signal:controller.signal}),e=>e.name==='AbortError');
  assert.equal(failed.blobs.size,before);assert.equal(storage.__archiveTest.jobs.size,0);
  await assert.rejects(Archive.withImport(storage,stage=>stage.putBlob({id:'he',blob:text('overwrite')})),/collision/);
  assert.equal(failed.blobs.size,before);
  const live=context(false,true);const beforeProject=JSON.stringify(live.App.project);
  const session=await Archive.beginExport(live.App.project,live.ProjectStorage,{currentProject:()=>live.App.project,readMedia:async item=>live.blobs.get(item.blobId)});
  assert.equal(JSON.stringify(live.App.project),beforeProject,'snapshot never modifies registered project');
  assert.equal(session.project.sections[0].msiSeries.MSI_A.archiveProvenance.basis,'unknown');
  live.App.project.sections[0].msiSeries.MSI_A.blobId='changed';assert.throws(session.assertCurrent,/changed/);await session.close();
  assert.equal(live.ProjectStorage.__archiveTest.pins.size,0);

  // Crash recovery uses a cross-tab exclusive lock and protected storage deletion.
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');let grant=false;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name,_options,callback)=>callback(grant?{}:null)}}});
  try {
    const crashed=context(false,true), st=crashed.ProjectStorage;
    await st.putBlob({id:'orphan',archiveOwnerId:'crashed',blob:text('uncommitted')});
    await st.putProject({id:'existing',sections:[{images:{HE:{blobId:'he'}}}]},{createOnly:true});
    await st.putArchiveJob({id:'crashed',kind:'zip-import',state:'staging',ownedBlobIds:['orphan','he']});
    await st.pinBlobs('crashed',['orphan','he']);
    await Archive.recoverImports(st);assert.equal(st.__archiveTest.jobs.size,1,'live/locked job retained');
    grant=true;await Archive.recoverImports(st);assert.equal(crashed.blobs.has('orphan'),false);assert.equal(crashed.blobs.has('he'),true,'project references survive recovery');
    assert.equal(st.__archiveTest.jobs.size,0);assert.equal(st.__archiveTest.pins.size,0);
  } finally { if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator; }
  assert.equal(Archive.qualityLabel(Archive.registeredSource()),'');
  assert.match(Archive.qualityLabel({version:1,basis:'legacy-derived-csv'}),/reference statistics/);
  console.log('Archive compatibility: PASS (v1 original variants, v2 provenance, complete snapshots, cancellation and crash recovery)');
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
