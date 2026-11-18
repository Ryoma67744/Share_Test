'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Archive = require('../viewer/project-archive.js');
const Transform = require('../viewer/alignment-transform.js');
const {context,MemoryZip} = require('./zip_compatibility_regression.js');
const legacyReader = require('./fixtures/archive/legacy_v2_manifest_reader.cjs');
const {commonFiles,readLock} = require('../tools/build.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const affine = [[0.00123456789012345,0.00037,6.123456789012345],
  [-0.00011,0.0017,-2.125],[0,0,1]];
function record() {
  return Object.assign(Transform.upgrade({T_he_to_msi:affine,landmarks:{he:[[500,600]],msi:[[2,3]]}},'import'),{
    alignment_raster_basis:'legacy-msi-pixel-edges-v1',imageIdentity:'he',scope:'source',
    frame:{version:'msi-alignment-frame-v2',key:'saved-coordinate-key',sourceFileId:'source',
      measurementKey:'source-one',readerKey:'reader-one',coordinateKey:'grid-one',confirmed:true}});
}
function manifest(alignment,format='desi_data_share_v3') {
  return {format,id:'alignment-project',displayName:'Alignment archive',
    sections:[{id:'s',meta:{alignment},images:{},data:[]}],rois:[]};
}
const zipFor = doc => new MemoryZip().file('Alignment.json',JSON.stringify(doc));
async function exportedDoc(zip) {
  for (const name of Object.keys(zip.files).filter(name=>/^[^/]+\.json$/i.test(name))) {
    const doc = JSON.parse(await zip.file(name).async('string'));
    if (doc.format && doc.format.startsWith('desi_data_share_v')) return doc;
  }
  throw new Error('Missing test export manifest');
}
async function main() {
  // The format decision and capability gate visit exactly alignment data,
  // including unknown markers, without traversing images or numeric arrays.
  const good = record();
  assert.equal(Archive.formatForProject(manifest({HE:good})),'desi_data_share_v3');
  assert.equal(Archive.requiresAlignmentV2({alignment:{HE:{byFrame:{k:good}}}}),true);
  assert.equal(Archive.requiresAlignmentV2({sections:[{meta:{alignment:{HE:good}}}]}),true);
  assert.equal(Archive.requiresAlignmentV2({meta:{alignment:{HE:{renderContract:null}}}}),true);
  assert.equal(Archive.requiresAlignmentV2({alignment:{HE:{frame:{version:'future-v9'}}}}),true);
  const irrelevant = {sections:[{meta:{alignment:{HE:{scale_pct:100}}}}]};
  Object.defineProperty(irrelevant,'images',{get(){throw new Error('image data must not be traversed');}});
  Object.defineProperty(irrelevant,'sourceRows',{get(){throw new Error('source rows must not be traversed');}});
  assert.equal(Archive.requiresAlignmentV2(irrelevant),false);
  assert.equal(Archive.requiresAlignmentV2({unrelated:{alignmentContractVersion:999},bytes:new Uint8Array(1024)}),false);
  assert.equal(Archive.formatForProject(irrelevant),'desi_data_share_v2');

  // SQL and older projects allow null layer/member placeholders. They are
  // neither active registrations nor a declaration of the corrected format.
  // An unmarked missing/null frame version remains legacy metadata as well.
  for (const frame of [null,{}, {version:null}, {version:'msi-alignment-frame-v1'}]) {
    const placeholders = {HE:{scale_pct:100,frame,
      bySource:{removed:null},byFrame:{removed:null},byGroup:{removed:null},sharedByCoordinate:{removed:null}},IF:null};
    const doc = manifest(placeholders,'desi_data_share_v2');
    assert.equal(Archive.requiresAlignmentV2(doc),false);
    assert.equal(Archive.formatForProject(doc),'desi_data_share_v2');
    const prepared = await Archive.prepareImport(zipFor(doc),doc);
    assert.deepEqual(prepared.doc.sections[0].meta.alignment,placeholders);
    const target = context(false); await target.importZipFile(zipFor(doc));
    assert.deepEqual(target.saved.sections[0].meta.alignment,placeholders);
    target.App.project = target.saved;await target.exportProjectAsZip();
    assert.deepEqual(target.alerts,[]);
    const exported = await exportedDoc(target.exported);
    assert.equal(exported.format,'desi_data_share_v2');
    assert.deepEqual(exported.sections[0].meta.alignment,placeholders);
  }
  const mixedPlaceholder = manifest({HE:{...record(),bySource:{kept:record(),removed:null}},IF:null});
  assert.equal(Archive.requiresAlignmentV2(mixedPlaceholder),true);
  assert.deepEqual((await Archive.prepareImport(zipFor(mixedPlaceholder),mixedPlaceholder)).doc.sections[0].meta.alignment,
    mixedPlaceholder.sections[0].meta.alignment);
  assert.throws(()=>Archive.formatForProject(manifest({HE:{bySource:{invalid:42}}})),/Invalid ZIP alignment/);

  // Validation is read-only and preserves every general-affine coefficient;
  // all supported nesting scopes carry the same required contract.
  for (const collection of ['bySource','byFrame','sharedByCoordinate','byGroup']) {
    const doc = manifest({HE:{[collection]:{key:record()}}});
    const before = JSON.stringify(doc);
    const prepared = await Archive.prepareImport(zipFor(doc),doc);
    assert.deepEqual(prepared.doc.sections[0].meta.alignment,doc.sections[0].meta.alignment);
    assert.equal(JSON.stringify(doc),before);
  }

  // Execute the actual production exporter and importer in all online/offline
  // combinations. A true affine and both canonical/provenance fields survive
  // a second ZIP round trip without scalar projection or automatic fitting.
  for (const sourceOffline of [false,true]) {
    const source = context(sourceOffline,true);
    const section = source.App.project.sections[0];
    section.meta.alignment = {HE:Object.assign(record(),{
      byFrame:{'saved-coordinate-key':record()},bySource:{source:record()}})};
    section.meta.alignmentFrameVersion = 'msi-alignment-frame-v2';
    const before = clone(source.App.project);
    await source.exportProjectAsZip();
    assert.deepEqual(source.alerts,[]); assert.ok(source.exported);
    const doc = await exportedDoc(source.exported);
    assert.equal(doc.format,'desi_data_share_v3');
    assert.deepEqual(doc.sections[0].meta.alignment,before.sections[0].meta.alignment);
    assert.deepEqual(clone(source.App.project),before);
    await assert.rejects(legacyReader(source.exported),/v1\/v2.*not found/,
      'the prior production manifest gate rejects v3 before archive writes');
    for (const targetOffline of [false,true]) {
      const target = context(targetOffline);
      await target.importZipFile(source.exported);
      const restored = target.saved.sections[0].meta.alignment;
      assert.deepEqual(restored,before.sections[0].meta.alignment);
      assert.deepEqual(restored.HE.T_he_to_msi,affine);
      assert.equal(restored.HE.transformModel,'affine');
      assert.equal(restored.HE.fitMode,'manual');
      assert.equal(restored.HE.frame.version,'msi-alignment-frame-v2');
      target.App.project = target.saved;
      await target.exportProjectAsZip();
      assert.deepEqual(target.alerts,[]); assert.ok(target.exported);
      const twice = await exportedDoc(target.exported);
      assert.equal(twice.format,'desi_data_share_v3');
      assert.deepEqual(twice.sections[0].meta.alignment,restored);
    }
    // The actual ZIP codec also retains canonical matrix number precision.
    const JSZip = require('../vendor/jszip.min.js'), packed = new JSZip();
    for (const [name,file] of Object.entries(source.exported.files)) {
      const value = await file.async('blob');
      packed.file(name,value instanceof Blob ? await value.arrayBuffer() : value);
    }
    const bytes = await packed.generateAsync({type:'uint8array',compression:'DEFLATE'});
    const physical = context(false); physical.JSZip = JSZip;
    await physical.importZipFile(bytes);
    assert.deepEqual(physical.saved.sections[0].meta.alignment.HE.T_he_to_msi,affine);
  }

  // Legacy v2 alignments remain untouched and export as v2. Merely possessing
  // a valid affine matrix does not silently opt them into a new render rule.
  const legacy = {scale_pct:12.5,rotate_deg:20,offx:3,offy:4,flip_lr:false,flip_ud:true,
    T_he_to_msi:affine,landmarks:{he:[[7,8]],msi:[[1.5,2.5]]},
    frame:{version:'msi-alignment-frame-v1',key:'old-key'}};
  for (const offline of [false,true]) {
    const doc = manifest({HE:legacy},'desi_data_share_v2'), zip = zipFor(doc);
    assert.equal((await legacyReader(zip)).format,'desi_data_share_v2');
    const target = context(offline); await target.importZipFile(zip);
    assert.deepEqual(target.saved.sections[0].meta.alignment.HE,legacy);
    target.App.project = target.saved; await target.exportProjectAsZip();
    assert.deepEqual(target.alerts,[]);
    assert.equal((await exportedDoc(target.exported)).format,'desi_data_share_v2');
    assert.deepEqual((await exportedDoc(target.exported)).sections[0].meta.alignment.HE,legacy);
  }

  // Unknown, partial, malformed, downgraded, or non-invertible marked records
  // fail in preflight, before even a staging journal, Blob, or project write.
  const invalidRecords = [
    {...record(),renderContract:'future-display-v9'},
    {...record(),renderContract:null},
    {...record(),alignmentContractVersion:3},
    {...record(),alignmentContractVersion:'2'},
    {...record(),alignmentContractVersion:null},
    {...record(),alignment_raster_basis:'pixel-centers-v9'},
    {...record(),alignment_raster_basis:null},
    {...record(),T_he_to_msi:null},
    {...record(),T_he_to_msi:[[0,0,0],[0,0,0],[0,0,1]]},
    {...record(),T_he_to_msi:[[1e-8,0,0],[0,1e-8,0],[0,0,1]]},
    {...record(),T_he_to_msi:[[1,0,0],[0,1,0],[0,1,1]]},
    {...record(),T_he_to_msi:[[1,0,NaN],[0,1,0],[0,0,1]]},
    {...record(),T_he_to_msi:[[1,0,'0'],[0,1,0],[0,0,1]]},
    {...record(),frame:{version:'msi-alignment-frame-v1',key:'old-key'}},
    {...record(),frame:{version:'msi-alignment-frame-v2',key:''}},
    {...record(),frame:{version:'msi-alignment-frame-v2',key:null}},
    {...record(),frame:{version:null,key:'key'}},
    {...record(),frame:null},
    {frame:{version:'msi-alignment-frame-v99',key:'future-key'}},
    {alignmentContractVersion:2},
    {renderContract:null,alignmentContractVersion:null,frame:{version:'msi-alignment-frame-v1'}},
  ];
  for (const broken of invalidRecords) {
    const target = context(false), doc = manifest({HE:{byFrame:{k:broken}}});
    let journalWrites = 0;
    const putJob = target.ProjectStorage.putArchiveJob;
    target.ProjectStorage.putArchiveJob = async job => { journalWrites++; return putJob(job); };
    await assert.rejects(target.importZipFile(zipFor(doc)),/alignment contract/);
    assert.equal(target.blobs.size,0); assert.equal(target.projects.size,0); assert.equal(journalWrites,0);
  }
  const downgraded = manifest({HE:record()},'desi_data_share_v2');
  const target = context(false);
  await assert.rejects(target.importZipFile(zipFor(downgraded)),/requires ZIP format desi_data_share_v3/);
  assert.equal(target.blobs.size,0); assert.equal(target.projects.size,0);
  assert.throws(()=>Archive.verifyExport(zipFor(downgraded),downgraded),/requires ZIP format/);
  const v1 = new MemoryZip().file('project.json',JSON.stringify({format:'desi_data_share_v1'}))
    .file('sections/s/atlas.json',JSON.stringify({id:'s',meta:{alignment:{HE:record()}},images:{},msiSeries:{}}));
  await assert.rejects(context(false).importZipFile(v1),/requires ZIP format/);
  await assert.rejects(Archive.prepareImport(new MemoryZip(),manifest({HE:{byFrame:[]}})),/Invalid ZIP alignment/);

  const badExport = context(false,true); badExport.console = {...console,error(){}};
  badExport.App.project.sections[0].meta.alignment = {HE:{...record(),renderContract:'future-v9'}};
  await badExport.exportProjectAsZip();
  assert.equal(badExport.exported,undefined); assert.match(badExport.alerts[0],/alignment contract/);
  assert.equal(badExport.ProjectStorage.__archiveTest.jobs.size,0);

  // Web and offline distributions share this common file selection API.
  const repo = path.resolve(__dirname,'..');
  assert.ok(commonFiles(repo,readLock(repo)).includes('viewer/alignment-transform.js'));
  console.log('Alignment archive regression: PASS (v3 exact affine round trips, legacy v2, old-reader rejection, preflight validation, capability scan, distribution module)');
}
main().catch(error=>{console.error(error.stack || error);process.exitCode=1;});
