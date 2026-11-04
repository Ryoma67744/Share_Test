'use strict';
const assert = require('node:assert/strict');
const Store = require('../project-store-safety.js');
const memoryIdb = require('./helpers/memory-idb.cjs');
const fs = require('node:fs'), vm = require('node:vm');
function setup() {
 const memory=memoryIdb();let sequence=0;
 const make=()=>Store.create({transaction:memory.transaction,uid:p=>p+'-'+(++sequence),indexRowFor:p=>({id:p.id,storageRevision:p.storageRevision,displayName:p.displayName})});
 return {memory,a:make(),b:make(),make};
}
const project=(id='p')=>({id,displayName:'Initial',sections:[{id:'s',msiFiles:{raw:{blobId:'original'}}}],rois:[],meta:{roiMedia:{items:[{blobId:'photo'}]}}});
async function main(){
 const {memory,a,b,make}=setup();
 // Legacy records acquire a read token without silently writing a new baseline.
 memory.stores.projects.set('p',project());
 const one=await a.getProject('p'),two=await b.getProject('p');
 assert.equal(one.storageRevision,0);assert.equal(memory.stores.projects.get('p').storageRevision,undefined);
 one.displayName='Saved in A';two.displayName='Unsaved B';two.sections.push({id:'negative',msiSeries:{N:{blobId:'b-only'}}});
 await a.putProject(one);assert.equal(one.storageRevision,1);
 await assert.rejects(()=>b.putProject(two),e=>e.code==='LOCAL_PROJECT_CONFLICT'&&e.recovered);
 assert.equal(two.storageRevision,0);assert.equal((await b.getProject('p')).displayName,'Saved in A');
 assert.equal(memory.stores.project_index.get('p').displayName,'Saved in A');
 const reloaded=make(),recoveries=await reloaded.listRecoveries();assert.equal(recoveries.length,1);
 assert.equal(await a.deleteBlob('b-only'),false,'recovery original protected even after a reload');
 const recovered=await reloaded.restoreRecovery(recoveries[0].id);assert.notEqual(recovered.id,'p');assert.equal(recovered.sections.length,2);
 assert.equal(await a.deleteBlob('b-only'),false,'restored project now owns the original');
 assert.equal((await a.listRecoveries()).length,0);
 // Deletion cannot revive under an old tab's full-project save.
 const stale=await a.getProject('p');await a.deleteProject('p',{expectedRevision:1});
 await assert.rejects(()=>a.putProject(stale),{code:'LOCAL_PROJECT_CONFLICT'});assert.equal(await a.getProject('p'),null);
 // Missing tokens never steal the current version. New projects require createOnly.
 const current=project('new');await a.putProject(current,{createOnly:true});
 const unknown=structuredClone(current);delete unknown.storageRevision;
 await assert.rejects(()=>a.putProject(unknown),{code:'LOCAL_PROJECT_CONFLICT'});
 const collision=project('new');await a.putProject(collision,{createOnly:true});assert.notEqual(collision.id,'new');
 // Commit failures are never successes and never advance caller read tokens.
 const pending=await a.getProject('new');pending.displayName='lost if quota';memory.failNextCommit=true;
 await assert.rejects(()=>a.putProject(pending),{name:'QuotaExceededError'});
 assert.equal(pending.storageRevision,1);assert.equal((await a.getProject('new')).displayName,'Initial');
 // Snapshot contents cannot change while a queued transaction waits to start.
 const delayed=await a.getProject('new');delayed.displayName='snapshot';const saving=a.putProject(delayed);delayed.displayName='next edit';await saving;
 assert.equal((await a.getProject('new')).displayName,'snapshot');await a.putProject(delayed);assert.equal((await a.getProject('new')).displayName,'next edit');
 // Source IDs never change bytes. A filename patch retains the binary identity.
 await a.putBlob({id:'immutable',blob:new Blob(['first']),filename:'one'});
 await assert.rejects(()=>a.putBlob({id:'immutable',blob:new Blob(['other'])}),{code:'BLOB_ID_EXISTS'});
 await a.renameBlob('immutable','two');assert.equal(await memory.stores.blobs.get('immutable').blob.text(),'first');
 assert.equal(memory.stores.blobs.get('immutable').filename,'two');
 // An import's pre-write journal is not ownership proof if another writer
 // won a same-ID creation race. Cleanup must check the stored owner too.
 await a.putBlob({id:'collision-winner',blob:new Blob(['other writer']),archiveOwnerId:'job-A'});
 assert.equal(await a.deleteBlob('collision-winner',{ownerId:'job-B'}),false);
 assert.equal(await memory.stores.blobs.get('collision-winner').blob.text(),'other writer');
 assert.equal(await a.deleteBlob('collision-winner',{ownerId:'job-A'}),true);
 // Jobs and staging journals survive GC; cleanup lists intentionally do not pin.
 await a.pinBlobs('export',['pinned'],{kind:'zip-export'});await a.pinBlobs('export',['second']);
 await a.putArchiveJob({id:'import',ownedBlobIds:['staged'],cleanupBlobIds:['old']});
 for(const id of ['pinned','second','staged','old','orphan'])memory.stores.blobs.set(id,{id,blob:new Blob([id])});
 await a.pruneShareOrphans();for(const id of ['pinned','second','staged'])assert.ok(memory.stores.blobs.has(id));
 assert.ok(memory.stores.blobs.has('old'));assert.ok(memory.stores.blobs.has('orphan'),'unleased legacy originals have unknown liveness');
 await a.releaseBlobPins('export');await a.putArchiveJob({id:'import',ownedBlobIds:[],cleanupBlobIds:['staged']});
 assert.equal(await a.deleteBlob('staged'),true);assert.equal(await a.deleteBlob('pinned'),true);await a.deleteArchiveJob('import');
 assert.deepEqual(await a.getArchiveJobs(),[]);
 // A late network receipt only changes publish bookkeeping on the latest edit.
 const p=project('receipt');p.shareInfo={slug:'shared',serverRevision:4,pendingPublish:{jobId:'job'}};p.publishEditEpoch=5;p.__publishPending=true;
 await a.putProject(p,{createOnly:true});const edit=await b.getProject(p.id);edit.displayName='Newer ROI/edit';edit.publishEditEpoch=6;edit.rois.push({id:'later'});await b.putProject(edit);
 const receipt={slug:'shared',serverRevision:5,baseServerRevision:4,publishedEditEpoch:5,jobId:'job',publishedAt:'2026-11-04T00:00:00Z',uploadedPaths:['immutable/path'],blobPaths:{original:{path:'immutable/path',size:4}},viewerPassword:'private'};
 const applied=await a.recordPublishReceipt(p.id,receipt);assert.equal(applied.applied,true);assert.equal(applied.previousStorageRevision,2);
 const after=await a.getProject(p.id);assert.equal(after.displayName,'Newer ROI/edit');assert.equal(after.rois[0].id,'later');assert.equal(after.__publishPending,true);
 assert.equal(after.shareInfo.pendingPublish,undefined);assert.equal(after.shareInfo.viewerPassword,'private');assert.deepEqual(after.shareInfo.blobPaths,receipt.blobPaths);
 assert.equal((await a.recordPublishReceipt(p.id,receipt)).applied,false);assert.equal((await a.recordPublishReceipt(p.id,{...receipt,slug:'other',serverRevision:6,baseServerRevision:5})).applied,false);
 await assert.rejects(()=>a.recordPublishReceipt(p.id,{...receipt,serverRevision:8}),/Invalid publish receipt/);
 for(const base of [null,'',false,'0'])await assert.rejects(()=>a.recordPublishReceipt(p.id,{...receipt,baseServerRevision:base,serverRevision:1}),/Invalid publish receipt/);
 await a.recordPublishReceipt(p.id,{...receipt,serverRevision:6,baseServerRevision:5,publishedEditEpoch:6});assert.equal((await a.getProject(p.id)).__publishPending,undefined);
 await assert.rejects(()=>a.putProject(p),{code:'LOCAL_PROJECT_CONFLICT'});
 const draft=(await a.listRecoveries()).find(r=>r.projectId===p.id);const independent=await a.restoreRecovery(draft.id);assert.equal(independent.shareInfo,undefined);
 await a.deleteProject(p.id);assert.equal((await a.recordPublishReceipt(p.id,{...receipt,serverRevision:7,baseServerRevision:6})).applied,false);
 // Changing a published slug needs the exact durable create intent, not merely a newer receipt.
 const relink=project('relink');relink.shareInfo={slug:'old',serverRevision:8,viewerPassword:'old-secret',uploadedPaths:['old/path'],pendingPublish:{jobId:'create-new',slug:'new-slug',previousSlug:'old',baseServerRevision:0,create:true}};
 await a.putProject(relink,{createOnly:true});const firstReceipt={slug:'new-slug',serverRevision:1,baseServerRevision:0,jobId:'create-new',publishedEditEpoch:0,url:'new-url'};
 assert.equal((await a.recordPublishReceipt(relink.id,{...firstReceipt,jobId:'obsolete-job'})).applied,false);
 assert.equal((await a.recordPublishReceipt(relink.id,firstReceipt)).applied,true);
 const relinked=await a.getProject(relink.id);assert.equal(relinked.shareInfo.slug,'new-slug');assert.equal(relinked.shareInfo.viewerPassword,undefined);assert.equal(relinked.shareInfo.uploadedPaths,undefined);
 const first=project('first-publish');await a.putProject(first,{createOnly:true});assert.equal((await a.recordPublishReceipt(first.id,firstReceipt)).applied,false,'late receipts cannot implicitly select a share target');
 await a.patchProject(first.id,p=>{p.shareInfo={pendingPublish:{jobId:'create-new',slug:'new-slug',previousSlug:null,baseServerRevision:0,create:true}};});
 const editedDuringFirst=await a.getProject(first.id);editedDuringFirst.publishEditEpoch=1;editedDuringFirst.displayName='Edited during first upload';
 assert.equal(editedDuringFirst.__publishPending,undefined,'first publication has not assigned a share slug yet');
 await a.putProject(editedDuringFirst);
 assert.equal((await a.recordPublishReceipt(first.id,firstReceipt)).applied,true);
 const firstAfterReceipt=await a.getProject(first.id);
 assert.equal(firstAfterReceipt.displayName,'Edited during first upload');
 assert.equal(firstAfterReceipt.__publishPending,true,'first receipt must mark later edits pending even when no dirty flag existed');
 // Strict CAS applies to delete too; narrow updates cannot overwrite an entire stale object.
 const latest=await a.getProject('new');await a.patchProject('new',p=>{p.displayName='Rename';});
 await assert.rejects(()=>a.deleteProject('new',{expectedRevision:latest.storageRevision}),{code:'LOCAL_PROJECT_CONFLICT'});
 await assert.rejects(()=>a.patchProject('new',async p=>{}),/synchronous/);assert.equal((await a.getProject('new')).displayName,'Rename');
 // The actual manager rename advances the scientific edit epoch, so a late
 // receipt cannot mark a newer local name as published.
 const managerHtml=fs.readFileSync(require.resolve('../index.html'),'utf8');
 const renameStart=managerHtml.indexOf('await ProjectStorage.patchProject(localId, current => {');
 const renameEnd=managerHtml.indexOf('                    });',renameStart)+23;
 const renamed=project('rename-pending');renamed.shareInfo={slug:'name-share',serverRevision:1};renamed.publishEditEpoch=1;
 await a.putProject(renamed,{createOnly:true});
 await vm.runInNewContext('(async()=>{'+managerHtml.slice(renameStart,renameEnd)+'})()', {ProjectStorage:a,localId:renamed.id,cur:renamed.displayName,name:'Updated name'});
 const nameReceipt={slug:'name-share',baseServerRevision:1,serverRevision:2,publishedEditEpoch:1,jobId:'old-name'};
 await a.recordPublishReceipt(renamed.id,nameReceipt);
 assert.equal((await a.getProject(renamed.id)).__publishPending,true);
 assert.equal((await a.getProject(renamed.id)).publishEditEpoch,2);
 // Production manager list keeps every local ID, never adopts a same-name slug.
 const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
 const start=html.indexOf('async function buildRows()'),end=html.indexOf('\nfunction rowHtml',start);
 const context=vm.createContext({window:{},Map,Set,ProjectStorage:{listSummaries:async()=>[
  {id:'pos',displayName:'Same',shareInfo:{slug:'same'}},{id:'both',displayName:'Same',shareInfo:{slug:'same'}},{id:'unlinked',displayName:'Same'}]},serverRowsCache:[{slug:'same',display_name:'Same'}]});
 vm.runInContext(html.slice(start,end),context);const rows=await context.buildRows();assert.equal(rows.length,3);assert.equal(rows.find(r=>r.local.id==='unlinked').kind,'local-only');
 console.log('Project store safety regression: PASS (CAS, durable recovery, immutable originals, receipt and lists)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
