(function(root,factory){'use strict';const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.PublishSafety=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
    // Only developer-owned UI text is registered here; project and input values stay unchanged.
    const _uiT = (source, params) => globalThis.AppI18n ? globalThis.AppI18n.t(source, params) : String(source).replace(/\{(\w+)\}/g, (match, key) => params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key] ?? '') : match);
    const _uiText = (node, source, params) => {
        let target = node;
        if (globalThis.AppI18n && String(node.tagName || '').toUpperCase() === 'LABEL') { target = node.ownerDocument.createElement('span'); node.appendChild(target); }
        if (globalThis.AppI18n) globalThis.AppI18n.setText(target, source, params); else target.textContent = _uiT(source, params);
        return node;
    };
    const _uiAttr = (node, name, source, params) => { if (globalThis.AppI18n) globalThis.AppI18n.setAttribute(node, name, source, params); else node.setAttribute(name, _uiT(source, params)); return node; };
    const _uiTextNode = (doc, source, params) => _uiText(doc.createElement('span'), source, params);

 const copy=value=>JSON.parse(JSON.stringify(value));
 const revision=value=>Number.isSafeInteger(value)&&value>=0;
 const error=(code,message)=>Object.assign(new Error(message),{code});
  const isConflict=e=>!!e&&(e.code==='PT409'||e.code==='40001');
 const uuid=()=>globalThis.crypto.randomUUID();
 function baseline(project,slug){
   const info=project.shareInfo||{};
   if(info.slug!==slug)return {create:true,revision:0};
   if(!revision(info.serverRevision))throw error('PUBLISH_BASELINE_UNKNOWN',_uiT("このローカル版がどの公開版に対応するか未確認です。比較画面で共有版を確認してください。"));
   return {create:false,revision:info.serverRevision};
 }
 function confirmedOverwriteBaseline(project,slug,confirmation){
   if(!confirmation||typeof confirmation!=='object'||Array.isArray(confirmation)
     ||confirmation.slug!==slug||project.shareInfo?.slug!==slug||!revision(confirmation.serverRevision))
     throw error('PUBLISH_OVERWRITE_INVALID',_uiT("比較画面で確認した同じ共有URLの公開版を指定してください。"));
   if(project.__importFailures>0)
     throw error('PUBLISH_SOURCE_MISSING',_uiT("共有版の取得が一部失敗したローカル版からは上書きできません。原本とROIを完全に取得してから比較してください。"));
   if(revision(project.shareInfo.serverRevision)&&project.shareInfo.serverRevision>confirmation.serverRevision)
     throw error('PT409',_uiT("比較後に公開版が更新されています。もう一度共有版を確認してください。"));
   return {create:false,revision:confirmation.serverRevision};
 }
 async function parallel(items,limit,fn){
   let index=0,failure;const settled=await Promise.allSettled(Array.from({length:Math.min(limit,items.length)},async()=>{
     while(index<items.length&&!failure){const item=items[index++];try{await fn(item);}catch(e){failure=e;throw e;}}
   }));
   if(failure)throw failure;for(const s of settled)if(s.status==='rejected')throw s.reason;
 }
 function assertReceipt(receipt,job){
   if(!receipt||receipt.protocol!==2||receipt.ok!==true||receipt.slug!==job.slug||receipt.request_id!==job.jobId
     ||!revision(receipt.server_revision)||receipt.server_revision!==job.baseServerRevision+1)
     throw error('PUBLISH_INVALID_RECEIPT',_uiT("公開完了の確認に失敗しました。同じプロジェクトから再試行してください。"));
 }
 function localReceipt(server,job,meta,assets,url){
   return {slug:job.slug,serverRevision:server.server_revision,publishedAt:server.committed_at,lastSyncedAt:server.committed_at,
     url,isPublic:!!meta.isPublic,viewerPassword:meta.isPublic?null:meta.viewerPassword,adminPassword:meta.adminPassword||null,
     uploadedPaths:assets.uploadedPaths||[],blobPaths:assets.blobPaths||{},jobId:job.jobId,
     baseServerRevision:job.baseServerRevision,publishedEditEpoch:job.publishedEditEpoch,sourceStorageRevision:job.sourceStorageRevision};
 }
 function ownedRois(project,encodeRoi){
   return (project.rois||[]).filter(r=>!r._collab).flatMap(r=>Object.keys(r.polysBySection||{}).map(sectionId=>({
     sectionId,colorKey:r.colorKey||'default',name:r.name||'',polyMsi:encodeRoi(r,sectionId),createdBy:'master',version:r.version||1})));
 }
 async function run(project,meta,hooks,options={}){
   // Copy all metadata before the first await. Blob objects are captured below;
   // Blob is immutable, so retaining it does not copy a large RAW into memory.
   const snapshot=copy(project),settings=copy(meta),job={projectId:project.id,sourceSlug:project.shareInfo?.slug||null,previousSlug:project.shareInfo?.slug||null,slug:meta.slug,jobId:(hooks.uuid||uuid)(),
     publishedEditEpoch:project.publishEditEpoch||0,sourceStorageRevision:project.storageRevision||0};
   if(!/^[A-Za-z0-9_-]+$/.test(job.slug||''))throw error('PUBLISH_INVALID_SLUG',_uiT("共有URLの名前を確認してください。"));
   // Approval changes this request's CAS base only. Do not promote an unknown
   // local baseline until a verified receipt is recorded, or persist a flag
   // that could silently authorize a later automatic publish.
   const overwrite=options.confirmedOverwrite===undefined?null
     :confirmedOverwriteBaseline(snapshot,job.slug,options.confirmedOverwrite);
   const oldPending=snapshot.shareInfo&&snapshot.shareInfo.pendingPublish;
   if(overwrite&&oldPending&&oldPending.slug!==job.slug)
     throw error('PUBLISH_PENDING_CONFLICT',_uiT("別の共有URLへの公開処理が未確認です。その処理を確認してから上書きしてください。"));
   hooks.freezeSources(snapshot);
   if(snapshot.meta && snapshot.meta.msiRatios!=null){
     const model=typeof module==='object'&&module.exports?require('./msi-ratio-model.js'):root.MsiRatioModel;
     if(!model)throw error('PUBLISH_RATIO_MODEL_MISSING',_uiT("比の保存形式を検証できません。アプリを再読み込みしてください。"));
     const check=model.validateProjectReferences(snapshot);
     if(!check.valid)throw error('PUBLISH_RATIO_SOURCE_MISSING',_uiT("比の入力参照を確認してください。修復または除外してから公開してください: {0}", {"0":(check.errors.join('; '))}));
     snapshot.meta.msiRatios=model.normalizeRegistry(snapshot.meta.msiRatios);
   }
   let resumedCreate=false;
   if(oldPending&&oldPending.slug===job.slug){
     // A lost commit response is reconciled before a fresh request. Never attach
     // the latest server revision to an unknown local snapshot.
     const state=await hooks.state(job.slug,oldPending.jobId);
     if(overwrite&&(!state||state.protocol!==2))throw error('PUBLISH_PROTOCOL_REQUIRED',_uiT("共有公開版を確認できません。アプリとサーバの公開APIを確認してください。"));
     let previousReceipt=state&&state.receipt;
     // A fresh overwrite must never publish an older pending document first.
     // Its original receipt may be reconciled; an uncommitted intent is then
     // superseded by a new request bound to the explicitly approved revision.
     if(!overwrite&&!previousReceipt&&oldPending.commitArgs){
       const ticket=await hooks.session(oldPending);
       previousReceipt=ticket.receipt||await hooks.commit({...oldPending.commitArgs,_publish_token:ticket.token});
     }
     if(previousReceipt){
       assertReceipt(previousReceipt,oldPending);
       const receipt=localReceipt(previousReceipt,oldPending,oldPending.settings||settings,oldPending,hooks.url(job.slug));
       await hooks.receipt(receipt);await hooks.release(oldPending.jobId);job.sourceSlug=receipt.slug;job.previousSlug=receipt.slug;snapshot.shareInfo={...(snapshot.shareInfo||{}),slug:receipt.slug,serverRevision:receipt.serverRevision,blobPaths:receipt.blobPaths};
       if(overwrite&&receipt.serverRevision>overwrite.revision)
         throw error('PT409',_uiT("比較後に公開版が更新されています。もう一度共有版を確認してください。"));
       if(oldPending.publishedEditEpoch===job.publishedEditEpoch&&JSON.stringify(oldPending.settings)===JSON.stringify(settings)
         &&(!overwrite||(state.exists===true&&receipt.serverRevision===overwrite.revision&&state.server_revision===overwrite.revision)))return receipt;
     }else resumedCreate=!!oldPending.create&&state&&state.exists===false;
     if(overwrite&&(state.exists!==true||state.server_revision!==overwrite.revision))
       throw error('PT409',_uiT("比較後に公開版が更新されています。もう一度共有版を確認してください。"));
   }
   const base=overwrite||(resumedCreate?{create:true,revision:0}:baseline(snapshot,job.slug));job.create=base.create;job.baseServerRevision=base.revision;
   const session=await hooks.session(job);
   if(!session||session.protocol!==2||!session.token||session.object_prefix!==job.slug+'/publish-v2/'+job.jobId+'/')
     throw error('PUBLISH_PROTOCOL_REQUIRED',_uiT("サーバの公開APIをv2へ更新してから、アプリを再読み込みしてください。"));
   const media=hooks.media(snapshot),paths=new Map(),assets={uploadedPaths:[],blobPaths:{}},pins=[];
   const trusted=(snapshot.shareInfo&&snapshot.shareInfo.slug===job.slug&&snapshot.shareInfo.blobPaths)||{};
   const add=(entry,key,assign)=>{
     if(!entry)throw error('PUBLISH_SOURCE_MISSING',_uiT("登録原本の参照がありません: {0}", {"0":(key)}));
     const identity=entry.blobId?'blob:'+entry.blobId:'path:'+entry.storagePath;
     if(!entry.blobId&&!entry.storagePath)throw error('PUBLISH_SOURCE_MISSING',_uiT("登録原本の参照がありません: {0}", {"0":(key)}));
     let asset=paths.get(identity);
     if(!asset){
       const known=entry.blobId&&trusted[entry.blobId];
       const reusable=!options.forceFullUpload&&known&&typeof known.path==='string'&&known.path.startsWith(job.slug+'/')?known.path:null;
       const remoteOnly=!entry.blobId&&typeof entry.storagePath==='string'&&entry.storagePath.startsWith(job.slug+'/');
       asset={entry,key,assign:[],path:reusable||(remoteOnly?entry.storagePath:session.object_prefix+(hooks.uuid||uuid)()),reuse:!!(reusable||remoteOnly)};
       paths.set(identity,asset);if(entry.blobId)pins.push(entry.blobId);
     }
     asset.assign.push(assign);
   };
   // Array order is the visible section order. Legacy saved projects can have
   // duplicate/missing ordinals after delete + add; normalize only this immutable
   // publish document, retaining IDs, names, originals and ROI references.
   const sections=(snapshot.sections||[]).map((section,index)=>{
     const storage={images:{},msiSeries:{},msiFiles:{}};
     for(const [key,entry]of Object.entries(section.images||{}))add(entry,section.displayName+' / '+key,ref=>{storage.images[key]={...ref,filename:entry.filename||ref.filename,alignmentImageReference:hooks.imageIdentity(entry)};});
     for(const [key,entry]of Object.entries(section.msiSeries||{}))add(entry,section.displayName+' / '+key,ref=>{
       const out={...entry,...ref,filename:entry.filename||ref.filename};delete out.sourceUrl;delete out.storagePath;storage.msiSeries[key]=out;
     });
     for(const [key,entry]of Object.entries(section.msiFiles||{}))add(entry,section.displayName+' / source '+key,ref=>{
       const out={...entry,...ref,filename:entry.filename||ref.filename};delete out.sourceUrl;delete out.storagePath;storage.msiFiles[key]=out;
     });
     const meta={...(section.meta||{}),overlays:(snapshot.overlays||[]).filter(o=>!hooks.viewerOverlay(o))};delete meta.__alignMaster;
     return {id:section.id,ordinal:index+1,displayName:section.displayName||'Section',meta,storagePaths:storage};
   });
   const photoItems=[];
   for(const item of media.items){const out=hooks.publicPhoto(item,null);photoItems.push(out);add(item,_uiT("ROI写真 / {0}", {"0":(item.filename)}),ref=>{out.storagePath=ref.path;out.mime=ref.mime||item.mime;});}
   const rois=ownedRois(snapshot,hooks.encodeRoi);
   await hooks.pin(job.jobId,[...new Set(pins)],job.projectId);
   try{
     const missing=[];
     await parallel([...paths.values()],8,async asset=>{
       if(asset.entry.blobId){const stored=await hooks.blob(asset.entry.blobId);asset.blob=stored&&stored.blob;asset.mime=(stored&&stored.mime)||asset.entry.mime;}
       if(asset.reuse){if(!await hooks.exists(asset.path))asset.reuse=false;}
       if(!asset.reuse&&!asset.blob){
         // Direct cloud originals must be copied to a new namespace when the
         // user publishes a different slug. Capture the Blob before uploading.
         if(asset.entry.storagePath)asset.blob=await hooks.remoteBlob(asset.entry.storagePath);
         if(!asset.blob){missing.push(asset.key);return;}
       }
       if(!asset.reuse&&!asset.path.startsWith(session.object_prefix))asset.path=session.object_prefix+(hooks.uuid||uuid)();
       if(asset.blob&&(!(asset.blob.size>=0)||typeof asset.blob.arrayBuffer!=='function'))missing.push(asset.key);
     });
     if(missing.length)throw error('PUBLISH_SOURCE_MISSING',_uiT("原本を確認できないため公開を中止しました: {0}", {"0":(missing.join(', '))}));
     // Pin a retry intent before the first upload, and persist its paths before
     // commit. A later retry can reconcile a successful-but-lost response.
     const intent={...job,replacesJobId:oldPending?.jobId||null,settings,uploadedPaths:[],blobPaths:{}};await hooks.intent(intent);
     const uploads=[...paths.values()].filter(a=>!a.reuse),totalBytes=uploads.reduce((n,a)=>n+a.blob.size,0);
     hooks.start(uploads.length,totalBytes);let done=0;
     await parallel(uploads,3,async asset=>{
       hooks.assertActive();
       await hooks.upload(asset.path,asset.blob,asset.mime||asset.blob.type||'application/octet-stream',session.token);
       hooks.progress(++done,uploads.length);
     });
     for(const asset of paths.values()){
       const ref={path:asset.path,mime:asset.mime||asset.entry.mime||'application/octet-stream',filename:asset.entry.filename||asset.key};
       asset.assign.forEach(assign=>assign(ref));assets.uploadedPaths.push(asset.path);
       if(asset.entry.blobId)assets.blobPaths[asset.entry.blobId]={path:asset.path,mime:ref.mime,size:asset.blob?asset.blob.size:trusted[asset.entry.blobId]?.size};
     }
     hooks.assertActive();
     const args={_publish_token:session.token,_request_id:job.jobId,_expected_revision:job.baseServerRevision,_create_only:job.create,
       _slug:job.slug,_display_name:snapshot.displayName||job.slug,_viewer_pw:settings.viewerPassword||null,_admin_pw:settings.adminPassword||null,
       _sections:sections,_rois:rois,_is_public:!!settings.isPublic,
       _meta:{anatomyPalette:snapshot.anatomyPalette||{},memo:snapshot.memo||{},roiMedia:{version:1,items:photoItems},
         colormap:snapshot.meta?.colormap||null,msiSmoothing:['linear','median'].includes(snapshot.meta?.msiSmoothing)?snapshot.meta.msiSmoothing:'none',
         ...(snapshot.meta?.msiDisplay ? {msiDisplay:copy(snapshot.meta.msiDisplay)} : {}),
         ...(snapshot.meta?.msiRatios ? {msiRatios:copy(snapshot.meta.msiRatios)} : {}),
         otsuBgRemove:!!snapshot.meta?.otsuBgRemove,otsuStrength:Number.isFinite(snapshot.meta?.otsuStrength)?snapshot.meta.otsuStrength:0}};
     const commitArgs={...args};delete commitArgs._publish_token;
     await hooks.intent({...intent,...assets,commitArgs});hooks.assertActive();
     let server;
     try{server=await hooks.commit(args);}catch(e){
       // The exact same immutable request is retried. SQL returns its receipt
       // if the first commit succeeded, and never runs a legacy writer.
       if(isConflict(e)||e.code==='0A000'||e.code==='22023'||e.code==='28000'||e.code==='PGRST202'||e.cancelled)throw e;
       server=await hooks.commit(args);
     }
     assertReceipt(server,job);
     const receipt=localReceipt(server,job,settings,assets,hooks.url(job.slug));await hooks.receipt(receipt);return receipt;
   }finally{await hooks.release(job.jobId);hooks.close();}
 }
 function summary(project){
   const sections=project.sections||[],sources=new Set();let molecules=0,images=0;
   for(const s of sections){const paths=s.storage_paths||{};images+=Object.keys(s.images||paths.images||{}).length;
     for(const e of Object.values(s.msiSeries||paths.msiSeries||{})){molecules++;sources.add(e.sourceReference||e.sourceFileId||e.blobId||e.path||'unknown');}}
   return {sections:sections.length,sources:sources.size,molecules,images,rois:(project.rois||[]).reduce((n,r)=>n+(r.polysBySection?Object.keys(r.polysBySection).length:(r.section_id||r.sectionId?1:0)),0)};
 }
 // Mirrors _assert_spatial_alignment_preserved_v1. JSON null is an existing
 // entry: this guard checks for a missing path, not transform validity.
 function missingAlignmentGroups(savedPayload, attemptedPayload) {
   const missing = [];
   for (const [layer, record] of Object.entries(savedPayload?.alignment || {})) {
     const groups = record?.byGroup;
     if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
     const next = attemptedPayload?.alignment?.[layer]?.byGroup;
     for (const groupId of Object.keys(groups)) {
       if (!next || !Object.hasOwn(next,groupId) || next[groupId] === undefined)
         missing.push({layer,groupId});
     }
   }
   return missing;
 }
 function missingPublishedAlignmentSections(doc, submittedSections) {
   // The publish writer matches existing rows by meta.client_id. An omitted
   // whole section is a different operation and never fires this update guard.
   const saved = new Map((doc?.sections || []).filter(s => s.meta?.client_id)
     .map(s => [s.meta.client_id,s]));
   const findings = [];
   for (const submitted of submittedSections || []) {
     const section = saved.get(submitted.id);
     if (!section) continue;
     const missing = missingAlignmentGroups(section.meta,submitted.meta);
     if (missing.length) findings.push({sectionId:section.id, clientSectionId:submitted.id,
       sectionName:submitted.displayName || section.display_name || submitted.id, missing});
   }
   return findings;
 }
 // Compare the metadata used by the publisher with get_project_doc/list_rois.
 // Server UUIDs identify ROI rows; section.meta.client_id identifies the local section.
 function sameJson(a, b, stripNullKeys = false) {
   if (a === b) return true;
   if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
   if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length
     && a.every((value, index) => sameJson(value,b[index],stripNullKeys));
   if (Array.isArray(b)) return false;
   // projects.meta is written through jsonb_strip_nulls. Null array entries
   // and null fields in section metadata, ROI polygons, and the palette are retained.
   const keysOf = obj => Object.keys(obj).filter(key =>
     obj[key] !== undefined && (!stripNullKeys || obj[key] !== null));
   const keys = keysOf(a);
   return keys.length === keysOf(b).length
     && keys.every(k => Object.hasOwn(b,k) && sameJson(a[k],b[k],stripNullKeys));
 }
 const keysOfBoth = (a, b) => new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
 const withoutFields = (obj, fields) => Object.fromEntries(
   Object.entries(obj || {}).filter(([key, value]) => value !== undefined && !fields.includes(key)));
 const mapBy = (items, keyOf) => {
   const map = Object.create(null);
   for (const item of items || []) map[keyOf(item)] = item;
   return map;
 };
 function changeDetails(project, doc, hooks = {}) {
   const rows = [];
   const localSections = project.sections || [], serverSections = doc?.sections || [];
   const localById = mapBy(localSections, s => s.id);
   const clientId = section => String(section?.meta?.client_id || section?.client_id || section?.id);
   const remoteById = mapBy(serverSections, clientId);
   const labels = new Map();
   const names = new Map();
   for (const id of keysOfBoth(localById, remoteById)) {
     const name = localById[id]?.displayName || remoteById[id]?.display_name || remoteById[id]?.displayName || id;
     labels.set(id, name);
     names.set(name, 1 + (names.get(name) || 0));
   }
   const emit = (id, field, item, kind, protectedAlignment = false) => {
     const name = labels.get(id) || id;
     const section = names.get(name) > 1 ? name + ' (' + id + ')' : name;
     rows.push({sectionId:id, section, field, item, kind, protectedAlignment});
   };
   const compare = (id, field, item, local, server, protectedAlignment = false) => {
     const stripNullKeys = ['メモ','表示設定','MSI比'].includes(field);
     if (!sameJson(local, server, stripNullKeys)) emit(id, field, item, local === undefined ? 'server'
       : server === undefined ? 'local' : 'different', protectedAlignment && local === undefined);
   };
   const serverMeta = doc?.meta?.project_meta || {}, meta = project.meta || {};
   compare('', 'プロジェクト名', '', project.displayName || project.shareInfo?.slug, doc?.meta?.display_name ?? doc?.display_name ?? doc?.displayName);
   if (doc && typeof project.shareInfo?.isPublic === 'boolean' && typeof doc.is_public === 'boolean')
     compare('', '公開範囲', '', project.shareInfo.isPublic, doc.is_public);
   const memo = hooks.normalizeMemo || (m => m || {});
   const leftMemo = memo(project.memo), rightMemo = memo(serverMeta.memo);
   for (const key of keysOfBoth(leftMemo, rightMemo))
     compare('', 'メモ', key, leftMemo[key], rightMemo[key]);
   compare('', '配色', '', project.anatomyPalette || {}, doc?.anatomy_palette || {});
   const defaults = {colormap:null, msiSmoothing:'none', otsuBgRemove:false, otsuStrength:0, msiDisplay:null};
   for (const [key, fallback] of Object.entries(defaults))
     compare('', '表示設定', key, meta[key] ?? fallback, serverMeta[key] ?? fallback);
   const ratios = mapBy(meta.msiRatios?.definitions, item => item.id);
   const ratioRegistry = serverMeta.msiRatios?.definitions?.length && hooks.publicRatios
     ? hooks.publicRatios(doc) : serverMeta.msiRatios;
   const publicRatios = mapBy(ratioRegistry?.definitions, item => item.id);
   for (const key of keysOfBoth(ratios, publicRatios))
     compare('', 'MSI比', ratios[key]?.name || publicRatios[key]?.name || key, ratios[key], publicRatios[key]);

   // Paths attest to an existing Storage reference, never to byte-for-byte equality.
   // A new local blob may retain its predecessor's storagePath, so only trust the
   // blob-to-path mapping in the publish/import receipt while a blobId is present.
   function compareAsset(id, field, key, local, server, normalizedLocal, normalizedServer) {
     const filename = local?.filename || server?.filename;
     const title = filename && filename !== key ? key + ' / ' + filename : key;
     if (!local || !server || !sameJson(normalizedLocal, normalizedServer, field === 'ROI写真')) {
       emit(id, field, title, !local ? 'server' : !server ? 'local' : 'different');
       return;
     }
     const localPath = local.blobId ? project.shareInfo?.blobPaths?.[local.blobId]?.path : local.storagePath;
     const serverPath = server.path || server.storagePath;
     if (localPath && serverPath) {
       if (localPath !== serverPath) emit(id, field, title, 'different');
     } else {
       emit(id, field, title, 'unverified');
     }
   }
   const transport = ['path','storagePath','sourceUrl','sourcePath','blobId','mime'];
   const localMedia = meta.roiMedia?.items?.length && hooks.localPhotos ? hooks.localPhotos(project) : meta.roiMedia;
   const publicMedia = serverMeta.roiMedia?.items?.length && hooks.publicPhotos ? hooks.publicPhotos(doc) : serverMeta.roiMedia;
   const photos = mapBy(localMedia?.items, item => item.id), publicPhotos = mapBy(publicMedia?.items, item => item.id);
   for (const key of keysOfBoth(photos, publicPhotos)) {
     const l = photos[key], r = publicPhotos[key];
     compareAsset(l?.sectionId || r?.sectionId || '', 'ROI写真', l?.title || r?.title || key, l, r,
       withoutFields(l, transport), withoutFields(r, transport));
   }
   const localOrder = new Map(localSections.map((section, i) => [section.id, i + 1]));
   const localOverlays = (project.overlays || []).filter(o => !(hooks.isViewerOverlay ? hooks.isViewerOverlay(o) : o._local || o._server));
   const roiSections = new Map(serverSections.map(s => [String(s.id), clientId(s)]));
   const sectionRois = new Map();
   const roiPair = (id, color) => {
     if (!sectionRois.has(id)) sectionRois.set(id, new Map());
     const map = sectionRois.get(id);
     if (!map.has(color)) map.set(color, {local:[], server:[]});
     return map.get(color);
   };
   for (const roi of project.rois || []) {
     if (roi._collab) continue;
     for (const [id, vertices] of Object.entries(roi.polysBySection || {})) {
       const geometry = roi.geometryBySection?.[id];
       const polygon = hooks.encodeRoi ? hooks.encodeRoi(roi,id)
         : geometry ? {version:'msi-roi-polygon-v1',vertices,geometry} : vertices;
       roiPair(id, roi.colorKey || 'default').local.push({name:roi.name || '', polygon});
     }
   }
   for (const roi of doc?.rois || []) {
     if (roi.created_by === 'viewer') continue;
     const id = roiSections.get(String(roi.section_id)) || roi.section_id;
     let polygon = roi.poly_msi;
     if (polygon?.geometry?.version === 'msi-group-v1' && polygon.geometry.sectionId === roi.section_id)
       polygon = {...polygon, geometry:{...polygon.geometry, sectionId:id}};
     roiPair(id, roi.color_key || 'default').server.push({name:roi.name || '', polygon});
   }
   for (const id of keysOfBoth(localById, remoteById)) {
     const l = localById[id], r = remoteById[id], paths = r?.storage_paths || r?.storagePaths || {};
     if (!l || !r) {
       emit(id, '切片', '', l ? 'local' : 'server');
       if (!l) continue;
     } else {
       compare(id, '切片名', '', l.displayName || 'Section', r.display_name || r.displayName || 'Section');
       compare(id, '切片順', '', localOrder.get(id), r.ordinal);
     }
     // Older exports only carried file references inside their molecule layers.
     // The importer derives a file entry for these; don't report it as a new original.
     const derivedFiles = new Map();
     for (const ref of Object.values(paths.msiSeries || {})) {
       const key = ref.sourceFileId;
       if (!key || !l.msiFiles?.[key] || paths.msiFiles?.[key] || !ref.path) continue;
       if (!derivedFiles.has(key))
         derivedFiles.set(key,{id:key, filename:ref.filename, kind:ref.kind, path:ref.path});
       else if (derivedFiles.get(key)?.path !== ref.path) derivedFiles.set(key,null);
     }
     for (const [type, field] of [['images','HE/IF画像'],['msiFiles','MSI原本'],['msiSeries','分子レイヤー']]) {
       for (const key of keysOfBoth(l[type], paths[type])) {
         const a = l[type]?.[key];
         const b = paths[type]?.[key] ?? (type === 'msiFiles' ? derivedFiles.get(key) : undefined);
         if (!b && type === 'msiFiles' && derivedFiles.has(key)) {
           emit(id,field,key,'unverified');
           continue;
         }
         let left, right;
         if (type === 'images') {
           left = {filename:a?.filename, identity:a && (hooks.imageIdentity ? hooks.imageIdentity(a) : a.alignmentImageReference)};
           right = {filename:b?.filename, identity:b?.alignmentImageReference};
           // Older published images may not have an explicit alignment identity.
           if (!right.identity) {
             delete left.identity;
             delete right.identity;
           }
         } else {
           left = withoutFields(a, transport); right = withoutFields(b, transport);
           if (a && type === 'msiSeries' && !left.sourceReference && right.sourceReference && hooks.sourceReference)
             left.sourceReference = hooks.sourceReference(a);
         }
         compareAsset(id, field, key, a, b, left, right);
       }
     }
     const lm = l.meta || {}, rm = r?.meta || {};
     for (const layer of keysOfBoth(lm.alignment, rm.alignment)) {
       const a = lm.alignment?.[layer], b = rm.alignment?.[layer];
       const image = l.images?.[layer]?.filename || paths.images?.[layer]?.filename;
       const source = image && image !== layer ? layer + ' / ' + image : layer;
       for (const group of keysOfBoth(a?.byGroup, b?.byGroup)) {
         const registry = [lm,rm].flatMap(m => m.spatialGroups?.groups || []).find(g => g.id === group);
         const filenames = (registry?.members || []).map(m =>
           l.msiFiles?.[m.sourceFileId]?.filename || paths.msiFiles?.[m.sourceFileId]?.filename).filter(Boolean);
         const title = [source,group,...new Set(filenames)].join(' / ');
         compare(id, '共通位置合わせ', title, a?.byGroup?.[group], b?.byGroup?.[group], r?.meta?.client_id === l.id);
       }
       const scopes = ['bySource','byFrame','sharedByCoordinate'];
       for (const scope of scopes) {
         for (const key of keysOfBoth(a?.[scope], b?.[scope])) {
           const left = a?.[scope]?.[key], right = b?.[scope]?.[key], record = left || right;
           const fileId = record?.frame?.sourceFileId || key;
           const filename = l.msiFiles?.[fileId]?.filename || paths.msiFiles?.[fileId]?.filename;
           const measurement = record?.msiKey || record?.frame?.measurementKey;
           const title = [source,scope,measurement || filename || key].join(' / ');
           compare(id, '位置合わせ', title, left, right);
         }
       }
       const left = withoutFields(a,['byGroup',...scopes]), right = withoutFields(b,['byGroup',...scopes]);
       compare(id, '位置合わせ', source, Object.keys(left).length ? left : undefined, Object.keys(right).length ? right : undefined);
     }
     for (const key of keysOfBoth(lm.layerDisplay, rm.layerDisplay))
       compare(id,'切片設定', 'layerDisplay / ' + key, lm.layerDisplay?.[key], rm.layerDisplay?.[key]);
     const skip = ['client_id','__alignMaster','alignment','overlays','layerDisplay'];
     for (const key of keysOfBoth(lm,rm))
       if (!skip.includes(key)) compare(id,'切片設定',key,lm[key],rm[key]);
     compare(id,'重ね合わせ','',localOverlays,rm.overlays || []);
     for (const [color, pair] of sectionRois.get(id) || []) {
       const title = (pair.local[0]?.name || pair.server[0]?.name || color);
       compare(id, 'ROI', title === color ? title : title + ' (' + color + ')',
         pair.local.length ? pair.local : undefined, pair.server.length ? pair.server : undefined);
     }
   }
   const priority = row => row.protectedAlignment ? 0 : row.kind === 'unverified' ? 2 : 1;
   return rows.sort((a,b) => priority(a) - priority(b));
 }
 return {run,baseline,summary,changeDetails,missingAlignmentGroups,missingPublishedAlignmentSections,parallel,ownedRois,isConflict};
});
