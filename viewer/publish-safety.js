(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.PublishSafety=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const copy=value=>JSON.parse(JSON.stringify(value));
 const revision=value=>Number.isSafeInteger(value)&&value>=0;
 const error=(code,message)=>Object.assign(new Error(message),{code});
 const uuid=()=>globalThis.crypto.randomUUID();
 function baseline(project,slug){
   const info=project.shareInfo||{};
   if(info.slug!==slug)return {create:true,revision:0};
   if(!revision(info.serverRevision))throw error('PUBLISH_BASELINE_UNKNOWN','このローカル版がどの公開版に対応するか未確認です。共有最新版を別コピーで取得して比較してください。');
   return {create:false,revision:info.serverRevision};
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
     throw error('PUBLISH_INVALID_RECEIPT','公開完了の確認に失敗しました。同じプロジェクトから再試行してください。');
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
   if(!/^[A-Za-z0-9_-]+$/.test(job.slug||''))throw error('PUBLISH_INVALID_SLUG','共有URLの名前を確認してください。');
   hooks.freezeSources(snapshot);
   const oldPending=snapshot.shareInfo&&snapshot.shareInfo.pendingPublish;
   let resumedCreate=false;
   if(oldPending&&oldPending.slug===job.slug){
     // A lost commit response is reconciled before a fresh request. Never attach
     // the latest server revision to an unknown local snapshot.
     const state=await hooks.state(job.slug,oldPending.jobId);
     let previousReceipt=state&&state.receipt;
     if(!previousReceipt&&oldPending.commitArgs){
       const ticket=await hooks.session(oldPending);
       previousReceipt=ticket.receipt||await hooks.commit({...oldPending.commitArgs,_publish_token:ticket.token});
     }
     if(previousReceipt){
       assertReceipt(previousReceipt,oldPending);
       const receipt=localReceipt(previousReceipt,oldPending,oldPending.settings||settings,oldPending,hooks.url(job.slug));
       await hooks.receipt(receipt);await hooks.release(oldPending.jobId);snapshot.shareInfo={...(snapshot.shareInfo||{}),slug:receipt.slug,serverRevision:receipt.serverRevision,blobPaths:receipt.blobPaths};
       if(oldPending.publishedEditEpoch===job.publishedEditEpoch&&JSON.stringify(oldPending.settings)===JSON.stringify(settings))return receipt;
     }else resumedCreate=!!oldPending.create&&state&&state.exists===false;
   }
   const base=resumedCreate?{create:true,revision:0}:baseline(snapshot,job.slug);job.create=base.create;job.baseServerRevision=base.revision;
   const session=await hooks.session(job);
   if(!session||session.protocol!==2||!session.token||session.object_prefix!==job.slug+'/publish-v2/'+job.jobId+'/')
     throw error('PUBLISH_PROTOCOL_REQUIRED','サーバの公開APIをv2へ更新してから、アプリを再読み込みしてください。');
   const media=hooks.media(snapshot),paths=new Map(),assets={uploadedPaths:[],blobPaths:{}},pins=[];
   const trusted=(snapshot.shareInfo&&snapshot.shareInfo.slug===job.slug&&snapshot.shareInfo.blobPaths)||{};
   const add=(entry,key,assign)=>{
     if(!entry)throw error('PUBLISH_SOURCE_MISSING','登録原本の参照がありません: '+key);
     const identity=entry.blobId?'blob:'+entry.blobId:'path:'+entry.storagePath;
     if(!entry.blobId&&!entry.storagePath)throw error('PUBLISH_SOURCE_MISSING','登録原本の参照がありません: '+key);
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
   const sections=(snapshot.sections||[]).map(section=>{
     const storage={images:{},msiSeries:{},msiFiles:{}};
     for(const [key,entry]of Object.entries(section.images||{}))add(entry,section.displayName+' / '+key,ref=>{storage.images[key]={...ref,filename:entry.filename||ref.filename,alignmentImageReference:hooks.imageIdentity(entry)};});
     for(const [key,entry]of Object.entries(section.msiSeries||{}))add(entry,section.displayName+' / '+key,ref=>{
       const out={...entry,...ref,filename:entry.filename||ref.filename};delete out.sourceUrl;delete out.storagePath;storage.msiSeries[key]=out;
     });
     for(const [key,entry]of Object.entries(section.msiFiles||{}))add(entry,section.displayName+' / source '+key,ref=>{
       const out={...entry,...ref,filename:entry.filename||ref.filename};delete out.sourceUrl;delete out.storagePath;storage.msiFiles[key]=out;
     });
     const meta={...(section.meta||{}),overlays:(snapshot.overlays||[]).filter(o=>!hooks.viewerOverlay(o))};delete meta.__alignMaster;
     return {id:section.id,ordinal:section.ordinal||0,displayName:section.displayName||'Section',meta,storagePaths:storage};
   });
   const photoItems=[];
   for(const item of media.items){const out=hooks.publicPhoto(item,null);photoItems.push(out);add(item,'ROI写真 / '+item.filename,ref=>{out.storagePath=ref.path;out.mime=ref.mime||item.mime;});}
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
     if(missing.length)throw error('PUBLISH_SOURCE_MISSING','原本を確認できないため公開を中止しました: '+missing.join(', '));
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
         colormap:snapshot.meta?.colormap||null,msiSmoothing:snapshot.meta?.msiSmoothing==='linear'?'linear':'none',
         otsuBgRemove:!!snapshot.meta?.otsuBgRemove,otsuStrength:Number.isFinite(snapshot.meta?.otsuStrength)?snapshot.meta.otsuStrength:0}};
     const commitArgs={...args};delete commitArgs._publish_token;
     await hooks.intent({...intent,...assets,commitArgs});hooks.assertActive();
     let server;
     try{server=await hooks.commit(args);}catch(e){
       // The exact same immutable request is retried. SQL returns its receipt
       // if the first commit succeeded, and never runs a legacy writer.
       if(e.code==='40001'||e.code==='22023'||e.code==='28000'||e.code==='PGRST202'||e.cancelled)throw e;
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
   return {sections:sections.length,sources:sources.size,molecules,images,rois:(project.rois||[]).length};
 }
 return {run,baseline,summary,parallel,ownedRois};
});
