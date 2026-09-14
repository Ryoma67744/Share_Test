'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../viewer/index.html'),'utf8');
const plain=v=>JSON.parse(JSON.stringify(v));
function fn(name) {
  const at=html.indexOf('function '+name+'('); assert.ok(at>=0,name);
  const start=html.slice(at-6,at)==='async '?at-6:at;
  return html.slice(start,html.indexOf('\n}',at)+2);
}
function method(name) {
  const at=html.indexOf('    '+name+'(');assert.ok(at>=0,name);
  return html.slice(at,html.indexOf('\n    }',at)+6).trim();
}
const store=new Map(),calls=[],notices=[];
let remoteVersion=4;
const App={shareMode:{token:'token'},panels:new Map(),_refreshShareAlignments:async()=>{}};
const ctx=vm.createContext({JSON,Object,Array,Map,Set,Number,Math,console,App,
  _shareAlignBySection:store,_shareAlignServerMissing:false,_shareAlignWriteGen:0,
  showToast:s=>notices.push(s),_isMissingRpc:()=>false,_isStaleVersionError:e=>e.code==='40001',
  SupabaseClient:{async upsertShareAlignment(token,id,payload,version) {
    calls.push({id,payload:plain(payload),version});
    if(version!==remoteVersion) {const e=new Error('stale_version');e.code='40001';throw e;}
    remoteVersion++;return {version:remoteVersion};
  }}});
for(const name of ['SECTION_ALIGN_WC_KEYS','SECTION_ALIGN_META_KEYS'])
  vm.runInContext(new RegExp('const '+name+' = \\[[^\\]]*\\];').exec(html)[0],ctx);
vm.runInContext(html.slice(html.indexOf('function alignmentFrameDescriptor('),html.indexOf('function createMsiSourceGeometry(')),ctx);
for(const name of ['buildHeToMsiAffine','captureSectionAlignment','applySectionAlignment',
  'getShareAlignmentVersion','pushShareAlignment']) vm.runInContext(fn(name),ctx);
vm.runInContext('this.resolve=({'+method('_resolveTHeToMsi')+'})._resolveTHeToMsi',ctx);

const geometry={displayGeometry:{version:'msi-proportional-v1',W:2,H:2,x:{origin:10,step:4},y:{origin:-1,step:8}},
  legacy:{W:2,H:2,confirmed:true,x:[[10,0],[14,1]],y:[[-1,0],[7,1]]}};
const ent={kind:'xlsx',sourceFileId:'measurement-1',sourceRevision:'rev1',blobId:'blob-1',
  sheet:'Sheet1',col_x:'A',col_y:'B',col_v:'C',annotation:'A',sourceGeometry:geometry};
const sec={id:'original-section',images:{HE_STAIN:{blobId:'he-original'},IF_STAIN:{blobId:'if-original'}},
  msiSeries:{MSI_A:plain(ent),MSI_B:{...plain(ent),col_v:'D',annotation:'B'}},
  meta:{perSourceAlign:true,world_coords:{msi_um_per_px:{x:20,y:30}},alignment:{},notes:'untouched'}};
const frame=ctx.alignmentFrameDescriptor(sec,'MSI_A');
assert.ok(frame.confirmed);
assert.equal(ctx.alignmentFrameDescriptor(sec,'MSI_B').key,frame.key,'molecule selection shares measurement coordinates');
assert.ok(ctx.alignmentLegacySourceIsUnambiguous(sec,frame));
const frozen=plain(sec);
frozen.id='reimported-section';
for(const [key,e] of Object.entries(frozen.msiSeries)) {
  e.sourceReference=JSON.stringify(['measurement-1','xlsx','Sheet1',1,key,'rev1']);
  e.blobId='imported-blob';e.sourceUrl='https://storage/new';
}
assert.equal(ctx.alignmentFrameDescriptor(frozen,'MSI_A').key,frame.key,'sharing/reimport storage identity is stable');
assert.equal(ctx.alignmentFrameDescriptor(frozen,'MSI_B').key,frame.key,'frozen molecule annotation is excluded');
const defaultSheet=plain(frozen);delete defaultSheet.msiSeries.MSI_A.sheet;
assert.notEqual(ctx.alignmentFrameDescriptor(defaultSheet,'MSI_A').key,frame.key,
  'removing a reader option uses the parser default rather than the frozen old selector');
const resized=plain(sec);resized.msiSeries.MSI_A.sourceGeometry.displayGeometry.W=100;
assert.equal(ctx.alignmentFrameDescriptor(resized,'MSI_A').key,frame.key,'display raster resolution does not move legacy landmarks');
for(const patch of [{sheet:'Sheet2'},{func:2},{col_x:'F'},{sourceRevision:'rev2'},{sourceFileId:'measurement-2'}]) {
  const changed=plain(sec);Object.assign(changed.msiSeries.MSI_A,patch);
  assert.notEqual(ctx.alignmentFrameDescriptor(changed,'MSI_A').key,frame.key,JSON.stringify(patch));
}
const changedCoords=plain(sec);changedCoords.msiSeries.MSI_A.sourceGeometry.legacy.x=[[20,0],[24,1]];
assert.notEqual(ctx.alignmentFrameDescriptor(changedCoords,'MSI_A').key,frame.key,'same dimensions with different coordinates are not compatible');
assert.equal(ctx.alignmentLegacySourceIsUnambiguous(changedCoords,frame),false,
  'already-loaded differing geometry blocks legacy reuse despite identical reader selectors');
const pq=plain(sec);for(const e of Object.values(pq.msiSeries))e.kind='parquet';
pq.msiSeries.MSI_A.annotation='section-1';pq.msiSeries.MSI_B.annotation='section-2';
assert.notEqual(ctx.alignmentFrameDescriptor(pq,'MSI_A').key,ctx.alignmentFrameDescriptor(pq,'MSI_B').key,
  'Parquet annotation selects different section rows even when both have identical coordinates');
const raw=plain(sec);for(const e of Object.values(raw.msiSeries))e.kind='raw';
raw.msiSeries.MSI_B.snap=false;
assert.notEqual(ctx.alignmentFrameDescriptor(raw,'MSI_A').readerKey,ctx.alignmentFrameDescriptor(raw,'MSI_B').readerKey,
  'raw snapping affects the legacy raster basis and cannot be grouped before loading');
const ambiguous=plain(sec);ambiguous.msiSeries.MSI_B.sheet='Sheet2';
assert.equal(ctx.alignmentLegacySourceIsUnambiguous(ambiguous,frame),false,'same-file different sheets cannot seed a legacy per-source record');
const unloaded=plain(sec);delete unloaded.msiSeries.MSI_A.sourceGeometry;delete unloaded.msiSeries.MSI_B.sourceGeometry;
assert.equal(ctx.alignmentFrameDescriptor(unloaded,'MSI_A').confirmed,false);
assert.notEqual(ctx.alignmentFrameDescriptor(unloaded,'MSI_A').key,ctx.alignmentFrameDescriptor(unloaded,'MSI_B').key,
  'unknown coordinate frames cannot share points merely by filename or dimensions');
const pendingAnchor=plain(sec);pendingAnchor.meta.alignmentMsiKey='MSI_B';delete pendingAnchor.msiSeries.MSI_B.sourceGeometry;
assert.equal(ctx.alignmentLegacySeedIsCompatible(pendingAnchor,frame),false,'an unloaded saved anchor cannot be guessed from another molecule');
pendingAnchor.msiSeries.MSI_B.sourceGeometry=plain(geometry);
assert.equal(ctx.alignmentLegacySeedIsCompatible(pendingAnchor,frame),true,'confirming the single saved anchor allows ordinary legacy reuse');
pendingAnchor.msiSeries.MSI_B.sourceGeometry.legacy.confirmed=false;
pendingAnchor.msiSeries.MSI_B.sourceGeometry.legacy.reason='legacy-render-quant-axis-mismatch';
assert.equal(ctx.alignmentLegacySeedIsCompatible(pendingAnchor,frame),false,'known legacy intensity-dependent axes are not silently reused');

const The=[[1,0,11],[0,1,12],[0,0,1]],Tif=[[2,0,21],[0,2,22],[0,0,1]];
function record(T,heKey) {return {frame:plain(frame),T_he_to_msi:T,alignment_raster_basis:'legacy-msi-pixel-edges-v1',
  imageIdentity:ctx.alignmentImageIdentity(sec.images[heKey]),landmarks:{he:[[0,0],[5,5]],msi:[[11,12],[16,17]]}};}
sec.meta.alignment={HE_STAIN:{byFrame:{[frame.key]:record(The,'HE_STAIN')}},
  IF_STAIN:{byFrame:{[frame.key]:record(Tif,'IF_STAIN')}}};
sec.meta.alignmentFrameVersion='msi-alignment-frame-v1';sec.meta.alignmentHeKey='HE_STAIN';
sec.meta.world_coords.T_he_to_msi=[[99,0,0],[0,99,0],[0,0,1]];
sec.meta.world_coords.T_he_to_msi_by_source={'measurement-1':sec.meta.world_coords.T_he_to_msi};
const panel={section:sec,_pickRefMsiKey:()=> 'MSI_A',_sourceHasGenuineAlignment:()=>true};
assert.deepEqual(plain(ctx.resolve.call(panel,'HE_STAIN')),The);
assert.deepEqual(plain(ctx.resolve.call(panel,'IF_STAIN')),Tif,'each HE/IF layer resolves its own transform');
assert.deepEqual(plain(ctx.resolve.call(panel,'HE_STAIN','MSI_B')),The);
const swapped=plain(sec);swapped.images.HE_STAIN.blobId='replacement-image';
assert.equal(ctx.resolve.call({...panel,section:swapped},'HE_STAIN'),null,'replaced HE cannot inherit old coordinates');
const wrongSheet=plain(sec);wrongSheet.msiSeries.MSI_A.sheet='different';
assert.equal(ctx.resolve.call({...panel,section:wrongSheet},'HE_STAIN'),null,'known incompatible reader cannot fall back to bySource/global');
const badT=plain(sec);badT.meta.alignment.HE_STAIN.byFrame[frame.key].T_he_to_msi[0][0]=null;
assert.equal(ctx.resolve.call({...panel,section:badT},'HE_STAIN'),null,'malformed affine is not drawn');
const badBasis=plain(sec);badBasis.meta.alignment.HE_STAIN.byFrame[frame.key].alignment_raster_basis='future-pixel-basis';
assert.equal(ctx.resolve.call({...panel,section:badBasis},'HE_STAIN'),null,'an unknown saved coordinate basis is not drawn');

// Run the real composite renderer, including its fallback branches. A managed
// mismatch must not draw the HE raw image as if an identity alignment applied.
vm.runInContext('this.render=({'+method('renderComposite')+'}).renderComposite;this.status=({'+method('_showAlignmentUnavailable')+'})._showAlignmentUnavailable',ctx);
const I=[[1,0,0],[0,1,0],[0,0,1]],draws=[];
ctx.sectionLayerCanvasLinear=()=>I;ctx.heMsiDisplayWarp=()=>null;
ctx.document={createElement:()=>({style:{},setAttribute(){}})};
App.viewMode='free';App.roiOnlyMode=false;App.msiSmoothing='none';
const drawPanel={...panel,section:swapped,
  dom:{host:{appendChild(){}},cdisp:{width:20,height:20,classList:{toggle(){}}}},
  displayCtx:{clearRect(){},save(){},restore(){},transform(){},translate(){},drawImage(img){draws.push(img);}},
  imageSources:{HE_STAIN:{complete:true,naturalWidth:20,naturalHeight:20}},
  imageSettings:{HE_STAIN:{opacity:1}},visibleLayers:new Set(['HE_STAIN']),
  _maybeWarnRasterDimMismatch(){},_ensureViewerTransform(){},_ensureDrawableLoaded(){},
  registeredMsiKeys:()=>['MSI_A'],getMsiRefSize:()=>({w:2,h:2}),_msiCanvasMatrix:()=>I,
  updateScaleBar(){},_resolveTHeToMsi:ctx.resolve,_showAlignmentUnavailable:ctx.status};
ctx.render.call(drawPanel);
assert.equal(draws.length,0,'mismatched managed HE is excluded from the actual composite');
assert.match(drawPanel.dom.alignmentStatus.textContent,/HE\/IF を非表示/);
assert.match(drawPanel.dom.alignmentStatus.textContent,/保存時と異なります/);
drawPanel.section=sec;ctx.render.call(drawPanel);
assert.equal(draws.length,1,'verified alignment resumes normal HE rendering');
assert.equal(drawPanel.dom.alignmentStatus.hidden,true,'status clears when geometry becomes valid');
drawPanel.section={...sec,meta:{}};ctx.render.call(drawPanel);
assert.equal(draws.length,2,'ordinary unmanaged legacy HE keeps existing default rendering');

// A common record from the previous release can repair missing per-frame
// records on read alone, including the real composite's hide/show decision.
const commonSection=plain(sec);
commonSection.msiSeries.MSI_C={...plain(ent),sourceFileId:'measurement-2',blobId:'blob-2'};
commonSection.meta.alignment.HE_STAIN.sharedByCoordinate={[frame.coordinateKey]:record(The,'HE_STAIN')};
commonSection.meta.alignment.IF_STAIN.sharedByCoordinate={[frame.coordinateKey]:record(Tif,'IF_STAIN')};
const commonPanel={...panel,section:commonSection,_pickRefMsiKey:()=> 'MSI_C',msiValueRasters:new Map()};
const cFrame=ctx.alignmentFrameDescriptor(commonSection,'MSI_C',commonPanel);
const commonBefore=plain(commonSection);
assert.deepEqual(plain(ctx.resolve.call(commonPanel,'HE_STAIN')),The,'legacy common setting repairs a source missing from byFrame');
assert.deepEqual(plain(ctx.resolve.call(commonPanel,'IF_STAIN')),Tif,'each image retains its own common setting');
assert.deepEqual(commonSection,commonBefore,'resolution does not mutate old project data');
const pendingCommon=plain(commonSection);delete pendingCommon.msiSeries.MSI_C.sourceGeometry;
drawPanel.section=pendingCommon;drawPanel._pickRefMsiKey=()=> 'MSI_C';drawPanel.msiValueRasters=new Map();
let beforeDraw=draws.length;
ctx.render.call(drawPanel);
assert.equal(draws.length,beforeDraw,'unloaded coordinates remain pending');
assert.match(drawPanel.dom.alignmentStatus.textContent,/読み込み後/);
drawPanel.msiValueRasters.set('MSI_C',{sourceGeometry:plain(geometry)});
ctx.render.call(drawPanel);
assert.equal(draws.length,beforeDraw+1,'HE is actually drawn once the compatible source loads');
assert.equal(drawPanel.dom.alignmentStatus.hidden,true);
const commonOnly=plain(commonSection);
delete commonOnly.meta.alignment.HE_STAIN.byFrame;
drawPanel.section=commonOnly;ctx.render.call(drawPanel);
assert.equal(draws.length,beforeDraw+2,'a common-only record is sufficient for rendering');
const brokenCommon=plain(commonOnly);
brokenCommon.meta.alignment={HE_STAIN:brokenCommon.meta.alignment.HE_STAIN};
brokenCommon.meta.alignment.HE_STAIN.sharedByCoordinate[frame.coordinateKey].T_he_to_msi=[[0,0,0],[0,0,0],[0,0,1]];
drawPanel.section=brokenCommon;ctx.render.call(drawPanel);
assert.equal(draws.length,beforeDraw+2,'a singular common-only transform cannot fall through to raw unaligned HE');
assert.match(drawPanel.dom.alignmentStatus.textContent,/変換設定/);

// New common records bind the registered inventory, revision and reader, so
// identical dimensions/coordinates alone cannot enroll a replacement source.
const modernCommon=plain(commonSection);
const common=modernCommon.meta.alignment.HE_STAIN.sharedByCoordinate[frame.coordinateKey];
Object.assign(common,{scope:'shared',editOrder:3,targetKeys:[ctx.alignmentTargetKey(frame),ctx.alignmentTargetKey(cFrame)]});
const resolveCommon=s=>ctx.resolve.call({...commonPanel,section:s},'HE_STAIN');
for(const patch of [{sourceFileId:'new-file',blobId:'new-blob'},{sourceRevision:'new-revision'},{sheet:'different-sheet'}]) {
  const changed=plain(modernCommon);Object.assign(changed.msiSeries.MSI_C,patch);
  assert.equal(resolveCommon(changed),null,'common target inventory rejects '+JSON.stringify(patch));
  assert.match(ctx.alignmentUnavailableReason(changed,'HE_STAIN','MSI_C',commonPanel),/対象外/);
}
const shifted=plain(modernCommon);shifted.msiSeries.MSI_C.sourceGeometry.legacy.x=[[20,0],[24,1]];
assert.equal(resolveCommon(shifted),null);
assert.match(ctx.alignmentUnavailableReason(shifted,'HE_STAIN','MSI_C',commonPanel),/座標配置が異なります/);
const replacedCommon=plain(modernCommon);replacedCommon.images.HE_STAIN.blobId='new-he-image';
assert.equal(resolveCommon(replacedCommon),null);
assert.match(ctx.alignmentUnavailableReason(replacedCommon,'HE_STAIN','MSI_C',commonPanel),/画像が保存時と異なります/);
const individual=Object.assign(record(Tif,'HE_STAIN'),{frame:plain(cFrame),scope:'source',editOrder:2});
modernCommon.meta.alignment.HE_STAIN.byFrame[cFrame.key]=individual;
assert.deepEqual(plain(resolveCommon(modernCommon)),The,'later common edit supersedes a stale exact-frame entry');
individual.editOrder=4;
assert.deepEqual(plain(resolveCommon(modernCommon)),Tif,'later individual edit wins');
individual.T_he_to_msi=[[0,0,0],[0,0,0],[0,0,1]];
assert.equal(resolveCommon(modernCommon),null,'corruption in the latest individual entry is not hidden by an older common setting');
individual.T_he_to_msi=Tif;
delete common.editOrder;delete individual.editOrder;
assert.deepEqual(plain(resolveCommon(modernCommon)),Tif,'unknown legacy ordering preserves a valid individual alignment');
const transported={...plain(commonSection),id:'reimported-common',meta:{}};
ctx.applySectionAlignment(transported,plain(ctx.captureSectionAlignment(modernCommon)));
assert.deepEqual(plain(resolveCommon(transported)),Tif,'target inventory and precedence survive the ZIP/share metadata transport');
assert.deepEqual(transported.meta.alignment.HE_STAIN.sharedByCoordinate[frame.coordinateKey].targetKeys,common.targetKeys);
const legacyReaderChanged=plain(commonSection);legacyReaderChanged.msiSeries.MSI_A.sheet='another-sheet';
assert.equal(ctx.resolve.call({...panel,section:legacyReaderChanged},'HE_STAIN'),null,'old common data cannot silently rebind a known reader change');

// Alignment metadata traverses the exact capture/apply pair used by shared
// master selection, JSON transport and import. It never mutates source arrays.
const snapshot=plain(sec),payload=ctx.captureSectionAlignment(sec);
const restored={id:'restored',images:plain(sec.images),msiSeries:plain(sec.msiSeries),meta:{notes:'keep me',perSourceAlign:false}};
ctx.applySectionAlignment(restored,plain(payload));
assert.deepEqual(plain(ctx.captureSectionAlignment(restored)),plain(payload));
assert.equal(restored.meta.perSourceAlign,true);
assert.equal(restored.meta.notes,'keep me');
assert.deepEqual(sec,snapshot,'capture is independent of saved data');
payload.alignment.HE_STAIN.byFrame[frame.key].landmarks.he[0][0]=999;
assert.equal(sec.meta.alignment.HE_STAIN.byFrame[frame.key].landmarks.he[0][0],0);
assert.equal(restored.meta.alignment.HE_STAIN.byFrame[frame.key].landmarks.he[0][0],0);
ctx.applySectionAlignment(restored,{world_coords:{},alignment:{}});
assert.equal(restored.meta.perSourceAlign,undefined,'switching to older master clears new per-source mode');
assert.equal(restored.meta.alignmentFrameVersion,undefined);
assert.equal(restored.meta.alignmentHeKey,undefined);
assert.deepEqual(restored.msiSeries,sec.msiSeries,'metadata application leaves original numerical source definitions untouched');

// Explicit immutable image reference is carried by both current and legacy
// ZIP import and both server-document import paths, even when blobs relocate.
const stableImageId=ctx.alignmentImageIdentity(sec.images.HE_STAIN);
assert.equal(ctx.alignmentImageIdentity({blobId:'new-blob',storagePath:'new-path',alignmentImageReference:stableImageId}),stableImageId);
assert.match(html,/alignmentImageReference:alignmentImageIdentity\(ent\)/,'ZIP serialization retains image identity');
assert.match(html,/alignmentImageReference:alignmentImageIdentity\(t\.ent\)/,'publish serialization retains image identity');
assert.equal((html.match(/alignmentImageReference:(?:ref|img|ent)\.alignmentImageReference/g)||[]).length,4,
  'all ZIP/server image import constructors retain identity');
(async()=>{
  // Execute PNG export itself: resolve only after lazy geometry loads and pin
  // the original MSI key while the user switches to a different-sized image.
  vm.runInContext(fn('bakeAlignedHeToMsiPng'),ctx);
  let focus='MSI_C',loadCount=0,resolveKey=null,paintedTransform=null;
  const exportSection=plain(commonSection);delete exportSection.msiSeries.MSI_C.sourceGeometry;
  const exportPanel={...commonPanel,section:exportSection,msiValueRasters:new Map(),
    _pickRefMsiKey:()=>focus,
    async ensureMsiLayerLoaded(key){loadCount++;assert.equal(key,'MSI_C');focus='MSI_A';this.msiValueRasters.set(key,{sourceGeometry:plain(geometry)});return true;},
    msiRasterSize:key=>key==='MSI_C'?{w:2,h:2}:{w:99,h:100},
    _resolveTHeToMsi(he,key){resolveKey=key;assert.equal(loadCount,1);return ctx.resolve.call(this,he,key);}};
  ctx._ensureHeImage=async()=>({complete:true,naturalWidth:20,naturalHeight:20});
  ctx.get2dContext=()=>({transform(...args){paintedTransform=args;},drawImage(){}});
  ctx.document={createElement:()=>({toBlob:cb=>cb({type:'image/png'})})};
  const png=await ctx.bakeAlignedHeToMsiPng(exportPanel,exportSection,'HE_STAIN');
  assert.ok(png);assert.equal(png.w,2);assert.equal(png.h,2);assert.equal(resolveKey,'MSI_C');
  assert.deepEqual(paintedTransform,[1,0,0,1,11,12]);
  focus='MSI_C';loadCount=0;
  ctx._ensureHeImage=async()=>{exportSection.images.HE_STAIN.blobId='replaced-during-export';return {};};
  assert.equal(await ctx.bakeAlignedHeToMsiPng(exportPanel,exportSection,'HE_STAIN'),null,'an HE replacement during decoding aborts the export');
  store.set(sec.id,{payload:{old:true},version:4});
  const baseline=ctx.getShareAlignmentVersion(sec);
  const draft=ctx.captureSectionAlignment(sec);draft.perSourceAlign=false;
  store.set(sec.id,{payload:{remote:true},version:5});remoteVersion=5;
  assert.equal(await ctx.pushShareAlignment(sec,{payload:draft,expectedVersion:baseline}),false,
    'polling while editing cannot promote stale draft baseline');
  assert.equal(calls.at(-1).version,4);assert.equal(store.get(sec.id).version,5);
  assert.ok(notices.some(s=>/他の人が先に更新/.test(s)));
  assert.deepEqual(sec,snapshot,'failed save cannot change the active metadata or sources');
  assert.equal(await ctx.pushShareAlignment(sec,{payload:draft,expectedVersion:5}),true);
  assert.equal(calls.at(-1).payload.perSourceAlign,false,'save uses independent draft rather than live metadata');
  assert.equal(store.get(sec.id).version,6);
  draft.alignment.HE_STAIN.byFrame[frame.key].landmarks.he[0][0]=1234;
  assert.equal(store.get(sec.id).payload.alignment.HE_STAIN.byFrame[frame.key].landmarks.he[0][0],0,
    'server cache cannot alias the continuing editor draft');
  assert.equal(await ctx.pushShareAlignment(sec),true,'legacy non-modal callers retain existing API');
  assert.equal(calls.at(-1).version,6);
  assert.equal(calls.at(-1).payload.perSourceAlign,true);
  console.log('MSI alignment persistence regression: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
