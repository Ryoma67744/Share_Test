'use strict';
// Exercise the production bridge with the production coordinate and intensity
// helpers. Only browser decoding, layer acquisition and DOM events are fakes;
// colorization uses real canvas pixels. No browser process is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCanvas } = require('@napi-rs/canvas');
const { html, standalone, runtime } = require('./viewer-runtime.cjs');
const { element } = require('./roi-dom.cjs');
const model = require('../viewer/roi-media-model.js');
const service = require('../viewer/roi-media-service.js');
const msi = require('../viewer/roi-media-msi.js');
const source = fs.readFileSync(path.join(__dirname, '../viewer/roi-media-app.js'), 'utf8');
new vm.Script(source, { filename: 'roi-media-app.js' });
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function png(width = 16, height = 12) {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12); data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return new Blob([data], { type: 'application/octet-stream' });
}
function jpeg(width = 16, height = 12, progressive = false) {
  return new Blob([Uint8Array.from([255,216, 255,224,0,4,0,0,
    255,progressive ? 194 : 192,0,11,8,height >> 8,height & 255,width >> 8,width & 255,1,1,17,0, 255,217])]);
}
function tiff({ width = 16, height = 12, little = true, short = false, multi = false, sub = false, offset = 8, magic = 42 } = {}) {
  const count = sub ? 3 : 2, data = new Uint8Array(offset + 2 + count * 12 + 4), view = new DataView(data.buffer);
  data[0] = data[1] = little ? 73 : 77;
  view.setUint16(2, magic, little); view.setUint32(4, offset, little); view.setUint16(offset, count, little);
  for (const [index, tag, value] of [[0,256,width],[1,257,height], ...(sub ? [[2,330,120]] : [])]) {
    const at = offset + 2 + index * 12;
    view.setUint16(at, tag, little); view.setUint16(at + 2, short ? 3 : 4, little); view.setUint32(at + 4, 1, little);
    if (short) view.setUint16(at + 8, value, little); else view.setUint32(at + 8, value, little);
  }
  view.setUint32(offset + 2 + count * 12, multi ? 128 : 0, little);
  return new Blob([data]);
}

function fixture() {
  const geometry = { version:'msi-proportional-v1',W:16,H:12,x:{origin:0,step:1},y:{origin:0,step:1} };
  const sourceGeometry = ref => ({ sourceRef:ref,displayGeometry:plain(geometry),
    legacy:{ confirmed:true,W:16,H:12,x:[[0,0],[15,15]],y:[[0,0],[11,11]] } });
  const entry = (ref,max = 10) => ({ sourceReference:ref,rawRange:[0,max],rawDispMax:max,blobId:ref });
  const ctrl = { id:'ctrl',displayName:'Ctrl',ordinal:1,meta:{displayTransform:{version:2,baseOrientation:'native-raster'}},
    msiSeries:{MSI_A:entry('ctrl-source',20)} };
  const toxo = { id:'toxo4',displayName:'toxo4',ordinal:5,
    meta:{displayTransform:{version:2,baseOrientation:'native-raster'},viewerTransform:{rot:0},
      world_coords:{msi_um_per_px:{x:40,y:80}},otsu:{threshold:17}},
    msiSeries:{MSI_A:entry('toxo-source'),MSI_B:entry('toxo-source'),MSI_wrong:entry('different-acquisition'),MSI_TIC:entry('toxo-source')} };
  const roi = { id:'cyst',colorKey:'ROI_cyst',name:'toxo4_cyst',rgba:[200,50,10,255],
    polysBySection:{toxo4:[[6,4],[8,4],[8,6],[6,6]]},
    geometryBySection:{toxo4:{version:'msi-source-v1',sourceRef:'toxo-source',displayGeometry:plain(geometry)}} };
  const project = { id:'project',sections:[ctrl,toxo],rois:[roi],roiHidden:{} };
  const lut = Array.from({length:256},(_,i) => [i,255-i,Math.floor(i/2)]), background = [1,2,3];
  const loads = [], colorCalls = [], blobs = new Map(), decodes = [], closed = [], windows = [], notices = [];
  const app = { project,focusCompoundKey:'MSI_A',activeSectionId:'ctrl',activeRoiId:null,shareMode:null,
    msiScaleMode:'same',msiUserWindow:{MSI_A:{min:0,max:8}},otsuBgRemove:true,
    _organInScope:() => true,panels:new Map(),drawing:{mode:false} };
  for (const section of project.sections) {
    const imageSources = {}, msiValueRasters = new Map();
    for (const [key, ent] of Object.entries(section.msiSeries)) {
      const image = createCanvas(16,12), ctx = image.getContext('2d');
      ctx.fillStyle = '#808080'; ctx.fillRect(0,0,16,12); imageSources[key] = image;
      msiValueRasters.set(key,{W:16,H:12,values:new Float64Array(192).fill(section === ctrl ? 8 : 2),sourceGeometry:sourceGeometry(ent.sourceReference)});
    }
    app.panels.set(section.id,{section,imageSources,msiValueRasters,
      _msiLoadIdentity:key => section.msiSeries[key].sourceReference,
      ensureMsiLayerLoaded:async key => { loads.push([section.id,key]); return true; } });
  }
  const context = runtime({
    Uint8Array,DataView,ArrayBuffer,Blob,URL,Map,Set,_testApp:app,RoiMediaModel:model,RoiMediaService:service,
    getActiveColormap:() => lut,getColormapBackground:() => background,
    formatDisplayName:key => key.replace(/^MSI_/,''),
    RoiMediaMsi:{colorize(image, options) { colorCalls.push({image,options}); return msi.colorize(image,{...options,createCanvas}); }},
    _otsuKeepGridRaw(section) { assert.equal(section.meta.otsu.threshold,17, 'Otsu state was captured when opening'); return null; },
    ProjectStorage:{async getBlob(id) { return blobs.has(id) ? {blob:blobs.get(id)} : null; }},
    createImageBitmap:async blob => { decodes.push(blob); return {width:16,height:12,close() { closed.push(blob); }}; },
    RoiMediaViewer:{open(options) { windows.push(options); },close() {},refresh() {},hasUnsavedChanges:() => false,requestClose:() => true},
    showToast:message => notices.push(message),
    document:{createElement:tag => tag === 'canvas' ? createCanvas(1,1) : element(tag)},
  },['msiSourceReference','msiRoiGeometryMeta','msiValidRoiGeometry','msiLayerSourceGeometry',
    'roiPolygonForDisplay','msiAxisInterpolate','msiLegacyRasterPointToDisplay','msiDisplayPhysicalPitch',
    'msiRawFallbackMax','msiValueEval','msiWindowEval']);
  vm.runInContext('const App = _testApp; const _activeColormapName = "TestMap";',context);
  const start = html.indexOf('    getMsiWindow(key, rawRange, dispMax) {');
  assert.ok(start > 0);
  app.getMsiWindow = vm.runInContext('({' + html.slice(start,html.indexOf('\n    },',start)+7) + '}).getMsiWindow',context);
  vm.runInContext(source,context,{filename:'roi-media-app.js'});
  return {context,api:context.RoiMediaApp,app,project,roi,ctrl,toxo,lut,background,loads,colorCalls,blobs,decodes,closed,windows,notices};
}

async function preflight() {
  const f = fixture(), {api} = f;
  for (const [blob,mime] of [[png(),'image/png'],[jpeg(),'image/jpeg'],[jpeg(23,31,true),'image/jpeg'],
    [tiff(),'image/tiff'],[tiff({little:false}),'image/tiff'],[tiff({short:true}),'image/tiff'],
    [tiff({little:false,short:true}),'image/tiff'],[tiff({offset:2*1024*1024+64}),'image/tiff']]) {
    const info = await api.inspectImage(blob);
    assert.equal(info.mime,mime); assert.equal(info.byteSize,blob.size); assert.ok(info.width > 0 && info.height > 0);
  }
  const pngInfo = await api.inspectImage(png(345,678));
  assert.deepEqual(plain(pngInfo),{width:345,height:678,mime:'image/png',byteSize:33});
  const jpgInfo = await api.inspectImage(jpeg(789,234));
  assert.equal(jpgInfo.width,789); assert.equal(jpgInfo.height,234);
  for (const image of [png(16385,1),png(9000,9000),jpeg(20000,1),tiff({width:16385}),tiff({width:9000,height:9000})]) {
    await assert.rejects(api.decodePhoto(image),/大きすぎ/);
  }
  assert.equal(f.decodes.length,0, 'Oversized headers reject before any full-image decoder allocation');
  for (const blob of [tiff({multi:true}),tiff({sub:true})]) await assert.rejects(api.decodePhoto(blob),/複数/);
  await assert.rejects(api.inspectImage(tiff({magic:43})),/TIFF形式/);
  await assert.rejects(api.inspectImage(new Blob([])),/空/);
  await assert.rejects(api.inspectImage(new Blob(['not an image'])),/PNG/);
  await assert.rejects(api.inspectImage(png(0,12)),/寸法/);
  await assert.rejects(api.inspectImage(jpeg().slice(0,10)),/寸法/);
  await assert.rejects(api.inspectImage({size:api.MAX_BYTES+1,slice() { throw new Error('Must not read oversized file'); }}),/500 MiB/);
  assert.equal(f.decodes.length,0,'Multi-page TIFF and malformed headers cannot reach decoder');
  const decoded = await api.decodePhoto(png());
  assert.equal(decoded.width,16); assert.equal(decoded.height,12); assert.equal(decoded.mime,'image/png');
  assert.equal(f.decodes.length,1); decoded.dispose(); assert.equal(f.closed.length,1);
}

async function adapterChecks() {
  const f = fixture(), {api,app,project,roi,toxo,ctrl} = f;
  const baseline = JSON.stringify({project,activeSectionId:app.activeSectionId,focus:app.focusCompoundKey,window:app.msiUserWindow,drawing:app.drawing});
  const adapter = api.createAdapter(project,roi);
  assert.deepEqual(plain(adapter.sections(project,roi)),[{id:'toxo4',name:'toxo4'}], 'Ctrl selection must not decide the ROI photo section');
  assert.equal(adapter.preferredCompound(project,roi,'toxo4'),'MSI_A');
  const compounds = adapter.compounds(project,roi,'toxo4');
  assert.equal(compounds.items.find(x => x.key === 'MSI_B').disabled,false,'Another feature from the same measurement source is valid');
  assert.equal(compounds.items.find(x => x.key === 'MSI_wrong').disabled,true,'A different acquisition cannot be overlaid');
  await assert.rejects(adapter.loadMsi(project,roi,'toxo4','MSI_wrong'),/測定ソース/);
  assert.equal(f.loads.length,0,'An incompatible compound is rejected before loading');
  const frame = await adapter.loadMsi(project,roi,'toxo4','MSI_A');
  assert.deepEqual(f.loads,[['toxo4','MSI_A']]);
  assert.deepEqual(plain(frame.polygon),roi.polysBySection.toxo4);
  assert.deepEqual(plain(frame.pixelPitch),{x:40,y:80});
  assert.deepEqual([...frame.canvas.getContext('2d').getImageData(0,0,1,1).data],[64,191,32,255],
    'Pixels use toxo4 native intensity 2 / fixed maximum 8, not the selected Ctrl value');
  assert.equal(JSON.stringify({project,activeSectionId:app.activeSectionId,focus:app.focusCompoundKey,window:app.msiUserWindow,drawing:app.drawing}),baseline,
    'Opening and reading comparison images do not alter main app state or ROI geometry');
  const firstCanvas = frame.canvas;
  assert.equal((await adapter.loadMsi(project,roi,'toxo4','MSI_A')).canvas,firstCanvas,'Whole/crop requests reuse the same colored pixels');

  // The bridge keeps independent settings even if the main display changes.
  f.lut[64][0] = 250; f.background[0] = 255;
  app.msiUserWindow.MSI_A.max = 100; app.msiScaleMode = 'individual'; app.focusCompoundKey = 'MSI_wrong';
  app.otsuBgRemove = false; toxo.meta.otsu.threshold = 999; toxo.meta.viewerTransform.rot = 90;
  const bFrame = await adapter.loadMsi(project,roi,'toxo4','MSI_B');
  assert.match(bFrame.status,/強度 0–10/); // Captured Same mode, B's max across sections.
  const recolored = await adapter.loadMsi(project,roi,'toxo4','MSI_A');
  assert.deepEqual([...recolored.canvas.getContext('2d').getImageData(0,0,1,1).data],[64,191,32,255]);
  assert.deepEqual(plain(recolored.transform),plain(frame.transform),'Main rotation changes do not rotate the already opened comparison');
  assert.equal(adapter.preferredCompound(project,roi,'toxo4'),'MSI_A','Initial compound choice is captured');

  const incompatible = api.createAdapter(project,roi);
  assert.equal(incompatible.preferredCompound(project,roi,'toxo4'),null,'No silent fallback to another feature when the preferred compound is incompatible');
  const legacy = {...roi,geometryBySection:{}};
  assert.ok(incompatible.compounds(project,legacy,'toxo4').items.every(item => item.disabled),
    'A legacy ROI with several acquisition sources is not guessed');
  const shared = {...project,__share:true};
  assert.equal(adapter.editable(shared,roi),false);
  assert.equal(adapter.editable(project,{...roi,_collab:true}),false);
  assert.equal(ctrl.msiSeries.MSI_A.rawRange[1],20);
}

async function asynchronousChecks() {
  let f = fixture(), adapter = f.api.createAdapter(f.project,f.roi), gate = deferred();
  const panel = f.app.panels.get('toxo4');
  panel.ensureMsiLayerLoaded = () => gate.promise;
  const changedSource = adapter.loadMsi(f.project,f.roi,'toxo4','MSI_A');
  f.toxo.msiSeries.MSI_A.sourceReference = 'replaced-source'; gate.resolve(true);
  await assert.rejects(changedSource,/測定ソース/);
  assert.equal(f.colorCalls.length,0,'A changed source cannot produce a stale comparison frame');

  f = fixture(); adapter = f.api.createAdapter(f.project,f.roi); gate = deferred();
  f.app.panels.get('toxo4').ensureMsiLayerLoaded = () => gate.promise;
  const replacedEntry = adapter.loadMsi(f.project,f.roi,'toxo4','MSI_A');
  f.toxo.msiSeries.MSI_A = {...f.toxo.msiSeries.MSI_A}; gate.resolve(true);
  await assert.rejects(replacedEntry,/測定ソースが変更/);

  f = fixture(); adapter = f.api.createAdapter(f.project,f.roi); gate = deferred();
  f.app.panels.get('toxo4').ensureMsiLayerLoaded = () => gate.promise;
  const switched = adapter.loadMsi(f.project,f.roi,'toxo4','MSI_A');
  f.app.project = {id:'another'}; gate.resolve(true);
  await assert.rejects(switched,/プロジェクトが変更/);
  assert.equal(f.colorCalls.length,0);

  f = fixture(); adapter = f.api.createAdapter(f.project,f.roi);
  const attachment = {id:'photo',roiKey:f.roi.colorKey,sectionId:'toxo4',sourceRef:'toxo-source',
    roiSnapshot:model.snapshot(f.roi,f.toxo),blobId:'photo-file',filename:'photo.png',mime:'image/png',width:16,height:12};
  f.blobs.set('photo-file',png());
  const registered = await adapter.loadPhoto(attachment);
  assert.doesNotMatch(registered.status,/変更/); registered.dispose();
  f.roi.polysBySection.toxo4[0][0] += .125;
  const redrawn = await adapter.loadPhoto(attachment);
  assert.match(redrawn.status,/写真登録後にROI形状・座標が変更/); redrawn.dispose();
  f.roi.polysBySection.toxo4 = plain(attachment.roiSnapshot.vertices);
  f.roi.geometryBySection.toxo4.sourceRef = 'new-measurement';
  const newSource = await adapter.loadPhoto(attachment);
  assert.match(newSource.status,/写真登録後にROI形状・座標が変更/); newSource.dispose();
  await assert.rejects(adapter.loadMsi(f.project,f.roi,'toxo4','MSI_A'),/測定ソース/,
    'An old reference photo may be viewed with a warning, while wrong-frame MSI is blocked');

  f = fixture(); adapter = f.api.createAdapter(f.project,f.roi); gate = deferred();
  f.blobs.set('photo-file',png());
  f.context.createImageBitmap = async blob => { await gate.promise; return {width:16,height:12,close() { f.closed.push(blob); }}; };
  const pendingPhoto = adapter.loadPhoto({...attachment,roiSnapshot:model.snapshot(f.roi,f.toxo)});
  await new Promise(resolve => setImmediate(resolve));
  f.app.project = {id:'changed'}; gate.resolve();
  await assert.rejects(pendingPhoto,/表示対象が変更/);
  assert.equal(f.closed.length,1,'Decoded images are disposed if the project changes during decode');
}

async function legacyPhotoSourceChecks() {
  const f = fixture();
  f.roi.geometryBySection = {};
  delete f.toxo.msiSeries.MSI_wrong;
  const panel = f.app.panels.get('toxo4');
  for (const [key, entry] of Object.entries(f.toxo.msiSeries)) {
    entry.sourceReference = 'source-B';
    panel.msiValueRasters.get(key).sourceGeometry.sourceRef = 'source-B';
  }
  const attachment = {id:'legacy-photo',roiKey:f.roi.colorKey,sectionId:'toxo4',sourceRef:'source-A',
    roiSnapshot:model.snapshot(f.roi,f.toxo),blobId:'legacy-photo-file',filename:'photo.png',mime:'image/png',width:16,height:12};
  assert.equal(attachment.roiSnapshot.geometry,null);
  f.blobs.set('legacy-photo-file',png());
  const adapter = f.api.createAdapter(f.project,f.roi);
  assert.equal(model.snapshotMatches(attachment,f.roi,f.toxo),true,
    'An unchanged legacy polygon alone cannot prove that the acquisition source is still the same');

  adapter.selectPhoto(f.project,f.roi,'toxo4',attachment);
  let compounds = adapter.compounds(f.project,f.roi,'toxo4');
  assert.ok(compounds.items.length > 0 && compounds.items.every(item => item.disabled));
  assert.match(compounds.notice,/写真登録時とはMSI測定ソースが異なり/);
  assert.equal(adapter.preferredCompound(f.project,f.roi,'toxo4'),null);
  await assert.rejects(adapter.loadMsi(f.project,f.roi,'toxo4','MSI_A'),/写真登録時とはMSI測定ソースが異なり/);
  assert.equal(f.loads.length,0,'Selected source-A reference photo cannot load source-B MSI');
  const photo = await adapter.loadPhoto(attachment);
  assert.match(photo.status,/写真と現在のMSI測定ソースの対応を確認できません/);
  assert.doesNotMatch(photo.status,/ROI形状・座標が変更/,'A source-only mismatch is not mislabeled as an ROI redraw');
  photo.dispose();

  adapter.selectPhoto(f.project,f.roi,'toxo4',{...attachment,sourceRef:''});
  compounds = adapter.compounds(f.project,f.roi,'toxo4');
  assert.ok(compounds.items.every(item => item.disabled));
  assert.match(compounds.notice,/写真登録時のMSI測定ソースを確認できません/);
  await assert.rejects(adapter.loadMsi(f.project,f.roi,'toxo4','MSI_A'),/写真登録時のMSI測定ソースを確認できません/);
  const unresolved = await adapter.loadPhoto({...attachment,sourceRef:''});
  assert.match(unresolved.status,/測定ソースの対応を確認できません/); unresolved.dispose();

  adapter.selectPhoto(f.project,f.roi,'toxo4',null);
  assert.ok(adapter.compounds(f.project,f.roi,'toxo4').items.every(item => !item.disabled),
    'An ROI without a selected photograph may still inspect its uniquely identified current MSI source');
  assert.equal(adapter.preferredCompound(f.project,f.roi,'toxo4'),'MSI_A');
  const noPhoto = await adapter.loadMsi(f.project,f.roi,'toxo4','MSI_A');
  assert.deepEqual(plain(noPhoto.polygon),f.roi.polysBySection.toxo4);

  const confirmed = {...attachment,sourceRef:'source-B'};
  adapter.selectPhoto(f.project,f.roi,'toxo4',confirmed);
  assert.ok(adapter.compounds(f.project,f.roi,'toxo4').items.every(item => !item.disabled),
    'A retaken photo explicitly associated with current source B restores comparison');
  const gate = deferred();
  panel.ensureMsiLayerLoaded = () => gate.promise;
  const pending = adapter.loadMsi(f.project,f.roi,'toxo4','MSI_A');
  adapter.selectPhoto(f.project,f.roi,'toxo4',attachment);
  gate.resolve(true);
  await assert.rejects(pending,/写真登録時とはMSI測定ソースが異なり/,
    'Photo source compatibility is rechecked after asynchronous MSI loading');
}

function installProductionPersistence(f) {
  const projects = new Map(), events = [], control = { readbackError:null, writes:0, queueCalls:0, publishScheduled:0 };
  let nextId = 0;
  f.context.uid = prefix => prefix + '-' + ++nextId;
  f.context.ProjectStorage.putBlob = async record => {
    events.push('blob'); f.blobs.set(record.id,record.blob); return record.id;
  };
  f.context.ProjectStorage.putProject = async project => {
    events.push('project'); control.writes++; projects.set(project.id,structuredClone(project));
  };
  f.context.ProjectStorage.getProject = async id => {
    events.push('readback');
    if (control.readbackError) { const error = control.readbackError; control.readbackError = null; throw error; }
    const saved = projects.get(id); return saved ? structuredClone(saved) : null;
  };
  // Use the real save generation/debounce/flush behavior; the fake IDB only
  // supplies deterministic structured-clone writes and a read-back fault.
  const appStart = html.indexOf('const App = {');
  for (const name of ['queueSave','_doSave','_flushSave']) {
    let start = html.indexOf('    ' + name + '(',appStart);
    if (start < 0) start = html.indexOf('    async ' + name + '(',appStart);
    const end = html.indexOf('\n    },',start);
    assert.ok(start > appStart && end > start,'Production persistence method: ' + name);
    f.app[name] = vm.runInContext('({' + html.slice(start,end+7) + '})[' + JSON.stringify(name) + ']',f.context);
  }
  const queueSave = f.app.queueSave;
  f.app.queueSave = function (...args) { control.queueCalls++; return queueSave.apply(this,args); };
  Object.assign(f.app,{_savedRevision:0,_saveRevision:0,_syncState:'synced',
    _setSyncStatus(value) { this._syncState = value; },
    _scheduleAutoPublish() { control.publishScheduled++; },
    _showSaveError(message) { this._syncState = 'error'; f.notices.push(message); },
  });
  return {projects,events,control};
}

function productionUnloadHandler(f) {
  let callback;
  f.context.window = {addEventListener(name,listener) { assert.equal(name,'beforeunload'); callback = listener; }};
  const start = html.indexOf("        window.addEventListener('beforeunload', (e) => {");
  const end = html.indexOf('\n        });',start);
  assert.ok(start > 0 && end > start,'Production beforeunload listener');
  vm.runInContext('(function () {' + html.slice(start,end + '\n        });'.length) + '\n}).call(_testApp);',f.context);
  assert.equal(typeof callback,'function');
  return () => {
    let prevented = false;
    const event = {preventDefault() { prevented = true; },returnValue:''};
    callback(event);
    return {prevented,returnValue:event.returnValue};
  };
}

async function persistenceAndUnloadChecks() {
  const f = fixture(), persistence = installProductionPersistence(f), unload = productionUnloadHandler(f);
  const adapter = f.api.createAdapter(f.project,f.roi), gate = deferred(), started = deferred();
  f.context.createImageBitmap = async blob => {
    f.decodes.push(blob); started.resolve(); await gate.promise;
    return {width:16,height:12,close() { f.closed.push(blob); }};
  };
  assert.equal(f.api.hasPending(f.project),false);
  assert.equal(unload().prevented,false,'A clean project does not show a leave-page warning');
  const pending = adapter.add(f.project,f.roi,'toxo4',[png()]);
  await started.promise;
  assert.equal(persistence.control.queueCalls,0,'No project save exists yet during original photo decoding');
  assert.equal(f.app.saveTimer,undefined);
  assert.equal(f.app._saveInflight,undefined);
  assert.equal(f.api.hasPending(f.project),true,'Bridge exposes the real service transaction before queueSave begins');
  const busyWarning = unload();
  assert.equal(busyWarning.prevented,true,'Production beforeunload protects in-progress image registration');
  assert.ok(busyWarning.returnValue);
  gate.resolve();
  const [item] = await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.hasPending(f.project),false,'Pending protection clears after the verified registry save');
  assert.equal(unload().prevented,false);
  assert.equal(persistence.control.queueCalls,1);
  assert.equal(persistence.control.writes,1);
  assert.deepEqual(persistence.events,['blob','project','readback']);
  assert.equal(persistence.projects.get(f.project.id).meta.roiMedia.items[0].id,item.id);
  assert.equal(f.app._savedRevision,f.app._saveRevision);

  f.context.RoiMediaViewer.hasUnsavedChanges = () => true;
  assert.equal(f.api.hasPending(f.project),true,'Unsaved photo fields participate even without an active service write');
  assert.equal(unload().prevented,true,'Production unload handler protects an unsaved photo metadata form');
  f.context.RoiMediaViewer.hasUnsavedChanges = () => false;
  assert.equal(unload().prevented,false);

  // The bridge's actual onRollback must enqueue a new App save generation if
  // verification fails after putProject has already committed a replacement.
  const registryBefore = plain(f.project.meta.roiMedia), originalBlobId = item.blobId;
  const readbackFailure = new Error('Injected IDB read-back failure');
  persistence.control.readbackError = readbackFailure;
  await assert.rejects(adapter.replace(f.project,f.roi,'toxo4',item,png()),error => error === readbackFailure);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(persistence.control.queueCalls,3,'Replacement and rollback each advance the real App save revision');
  assert.equal(persistence.control.writes,3,'Rollback is persisted after the committed but unverified replacement');
  assert.equal(f.app._saveRevision,3);
  assert.equal(f.app._savedRevision,3);
  assert.deepEqual(plain(f.project.meta.roiMedia),registryBefore);
  assert.deepEqual(plain(persistence.projects.get(f.project.id).meta.roiMedia),registryBefore,
    'Reopening uses the restored old photo, not the rejected replacement');
  assert.equal(f.blobs.has(originalBlobId),true);
  assert.equal(f.api.hasPending(f.project),false);
  assert.equal(unload().prevented,false,'No stale pending marker remains after a persisted rollback');
}

function listHooks() {
  const f = fixture(), list = element('div'), doc = {getElementById:() => list,createElement:element};
  f.context.document = doc;
  f.context.roiFixedColorEditable = () => false;
  vm.runInContext(standalone('populateRoiList'),f.context);
  f.context.populateRoiList();
  const row = list.children[0], button = row.children[1].children.find(node => node.className === 'roi-photo-button');
  assert.ok(button,'Each ROI row has an accessible photo entry point');
  assert.match(button.getAttribute('aria-label'),/toxo4_cyst/);
  let prevented = 0, stopped = 0;
  const event = {preventDefault() { prevented++; },stopPropagation() { stopped++; }};
  row.listeners.contextmenu(event);
  button.listeners.click(event);
  assert.equal(prevented,2); assert.equal(stopped,2);
  assert.equal(f.windows.length,2,'Both right-click and photo button invoke the production comparison opener');
  for (const opened of f.windows) {
    assert.equal(opened.roi,f.roi);
    assert.deepEqual(plain(opened.adapter.sections(opened.project,opened.roi)),[{id:'toxo4',name:'toxo4'}]);
  }
  assert.equal(f.app.activeSectionId,'ctrl');
  assert.equal(f.app.activeRoiId,null,'Opening a comparison does not change ROI selection or invoke drawing');
  assert.equal(f.notices.length,0);
}

(async () => {
  await preflight(); await adapterChecks(); await asynchronousChecks(); await legacyPhotoSourceChecks();
  await persistenceAndUnloadChecks(); listHooks();
  console.log('ROI media app regression: preflight, section/source association, display isolation, async guards, persisted rollback, unload protection and ROI list entry points passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
