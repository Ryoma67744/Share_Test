'use strict';
const assert = require('node:assert/strict');
const Store = require('../project-store-safety.js');
const memoryIdb = require('./helpers/memory-idb.cjs');
const fs = require('node:fs'), vm = require('node:vm');
function setup(locks = null) {
 const memory=memoryIdb();let sequence=0;
 const make=()=>Store.create({transaction:memory.transaction,locks,uid:p=>p+'-'+(++sequence),indexRowFor:p=>({id:p.id,storageRevision:p.storageRevision,displayName:p.displayName})});
 return {memory,a:make(),b:make(),make};
}
const project=(id='p')=>({id,displayName:'Initial',sections:[{id:'s',msiFiles:{raw:{blobId:'original'}}}],rois:[],meta:{roiMedia:{items:[{blobId:'photo'}]}}});
function lockManager() {
 const held=new Map();
 return {held,request(name,settings,callback) {
  if(typeof settings==='function'){callback=settings;settings={};}
  if(held.has(name))return Promise.resolve(callback(null));
  const token={name};held.set(name,token);
  return Promise.resolve().then(()=>callback(token)).finally(()=>{if(held.get(name)===token)held.delete(name);});
 }};
}
async function recoveryPreferences() {
 assert.equal(Store.VERSION,6);
 const upgradeNames=new Set(['projects','blobs']);
 Store.upgrade({objectStoreNames:{contains:name=>upgradeNames.has(name)},createObjectStore(name){upgradeNames.add(name);}});
 assert.ok(upgradeNames.has('preferences'),'v4/v5 upgrade adds a separate preferences store');
 const {memory,a,b,make}=setup(lockManager());
 assert.equal(await a.getRecoveryEnabled(),true);assert.equal(memory.stores.preferences.size,0,'default ON does not alter project records');
 const p=project();await a.putProject(p,{createOnly:true});
 const active=await a.getProject(p.id,{activate:true}),stale=await b.getProject(p.id,{activate:true});
 active.displayName='Saved';await a.putProject(active);
 const ownPin=()=>[...memory.stores.blob_pins.values()].find(row=>row.project?.displayName==='Saved'||row.id==='edit:writer-1');
 assert.equal(ownPin().savedRevision,active.storageRevision);
 assert.equal(ownPin().project.storageRevision,active.storageRevision,'session snapshot uses the committed revision');
 stale.displayName='Existing recovery';await assert.rejects(()=>b.putProject(stale),e=>e.recovered===true);
 const drafts=structuredClone([...memory.stores.project_recovery]);
 const otherPin=structuredClone([...memory.stores.blob_pins.values()].find(row=>row.project?.displayName==='Existing recovery'));
 memory.failNextCommit=true;
 await assert.rejects(()=>a.setRecoveryEnabled(false),{name:'QuotaExceededError'});
 assert.equal(await b.getRecoveryEnabled(),true);assert.ok(ownPin().project,'failed settings commit restores the active snapshot too');
 assert.equal(await a.setRecoveryEnabled(false),false);
 assert.equal(await b.getRecoveryEnabled(),false);assert.equal(await make().getRecoveryEnabled(),false,'new tabs see the same setting');
 assert.equal(ownPin().project,undefined);assert.equal(ownPin().recoveryDisabled,true);
 assert.deepEqual(memory.stores.blob_pins.get(otherPin.id),otherPin,'OFF does not remove another session snapshot');
 assert.deepEqual([...memory.stores.project_recovery],drafts,'OFF does not delete old conflict drafts');
 await assert.rejects(()=>a.setRecoveryEnabled('false'),TypeError);
 stale.displayName='OFF conflict';stale.sections.push({id:'new',images:{HE:{blobId:'unsaved-original'}}});
 await assert.rejects(()=>b.putProject(stale),e=>e.code==='LOCAL_PROJECT_CONFLICT'&&e.recovered===false&&/OFF/.test(e.message));
 assert.equal((await b.getProject(p.id)).displayName,'Saved','OFF still rejects stale writes');
 assert.deepEqual([...memory.stores.project_recovery],drafts,'OFF conflict neither creates nor replaces recovery');
 assert.equal(memory.stores.blob_pins.get(otherPin.id).project,undefined);
 await a.putBlob({id:'new-off-original',blob:new Blob(['unchanged bytes'])});
 assert.ok(ownPin().blobIds.includes('new-off-original'),'snapshot-free sessions pin new originals');
 assert.equal(await b.deleteBlob('new-off-original'),false);
 memory.failNextCommit=true;
 await assert.rejects(()=>a.putBlob({id:'failed-original',blob:new Blob(['failed'])}),{name:'QuotaExceededError'});
 assert.equal(memory.stores.blobs.has('failed-original'),false);assert.ok(!ownPin().blobIds.includes('failed-original'));
 memory.failNextCommit=true;await assert.rejects(()=>a.setRecoveryEnabled(true),{name:'QuotaExceededError'});
 assert.equal(await b.getRecoveryEnabled(),false,'failed ON update does not change the global preference');
 await b.setRecoveryEnabled(true);stale.displayName='ON again';
 await assert.rejects(()=>b.putProject(stale),e=>e.recovered===true);
 assert.equal(memory.stores.project_recovery.values().next().value.project.displayName,'ON again');
 const fresh=await a.getProject(p.id,{activate:true});fresh.displayName='Saved again';await a.putProject(fresh);
 assert.ok(ownPin().project);assert.equal(ownPin().recoveryDisabled,undefined);
 assert.equal((await a.getProject(p.id)).recoveryEnabled,undefined,'preferences never become exportable project metadata');
 await a.releaseProject();await b.releaseProject();
}
async function inactiveSessionCleanup() {
 const locks=lockManager(),{memory,a,b}=setup(locks);
 const p=project();await a.putProject(p,{createOnly:true});
 for(const id of ['original','photo','unused','draft-ref','job-ref','archive-ref'])memory.stores.blobs.set(id,{id,blob:new Blob([id])});
 await a.setRecoveryEnabled(false);await a.getProject(p.id,{activate:true});
 for(const id of ['created','draft-protected','job-protected','archive-protected'])await a.putBlob({id,blob:new Blob([id])});
 const pin=[...memory.stores.blob_pins.values()].find(row=>row.kind==='editing-session');
 memory.stores.project_recovery.set('old-draft',{id:'old-draft',projectId:'old',project:{id:'old',sections:[{images:{HE:{blobId:'draft-protected'}}}]}});
 await b.pinBlobs('job',['job-protected']);await b.putArchiveJob({id:'archive',ownedBlobIds:['archive-protected']});
 await b.listRecoveries();assert.ok(memory.stores.blob_pins.has(pin.id),'a live OFF session must retain all original pins');
 locks.held.delete('desi-project-edit:'+pin.id); // Model the realm ending, not a TTL.
 await b.listRecoveries();assert.equal(memory.stores.blob_pins.has(pin.id),false);
 assert.equal(memory.stores.blobs.has('created'),false,'only inactive, unreferenced held originals are reclaimed');
 for(const id of ['original','photo','draft-protected','job-protected','archive-protected','unused'])assert.ok(memory.stores.blobs.has(id),id+' remains referenced or was never owned by this session');
 const unknown={id:'edit:unknown',kind:'editing-session',liveness:'unknown',recoveryDisabled:true,blobIds:['unknown-original']};
 memory.stores.blob_pins.set(unknown.id,unknown);memory.stores.blobs.set('unknown-original',{id:'unknown-original',blob:new Blob(['unknown'])});
 await b.listRecoveries();assert.ok(memory.stores.blob_pins.has(unknown.id));assert.ok(memory.stores.blobs.has('unknown-original'),'unknown liveness is never timed out');
 // A normal saved session has a committed revision marker; older snapshots
 // with matching revision alone do not prove that the unsaved edit is duplicate.
 await b.setRecoveryEnabled(true);const c=Store.create({transaction:memory.transaction,locks,uid:p=>p+'-third',indexRowFor:p=>({id:p.id})});
 const saved=await c.getProject(p.id,{activate:true});saved.displayName='Final';
 const oldRevision=saved.storageRevision;saved.storageRevision=999;
 await c.putProject(saved,{expectedRevision:oldRevision});
 const savedPin=memory.stores.blob_pins.get('edit:writer-third');assert.equal(savedPin.savedRevision,oldRevision+1);assert.equal(savedPin.project.storageRevision,oldRevision+1);
 locks.held.delete('desi-project-edit:'+savedPin.id);assert.ok(!(await b.listRecoveries()).some(row=>row.id===savedPin.id));
 assert.equal(memory.stores.blob_pins.has(savedPin.id),false,'normally saved snapshot is not another recovery draft');
 const legacy={...structuredClone(savedPin),id:'edit:legacy'};delete legacy.savedRevision;delete legacy.liveness;
 memory.stores.blob_pins.set(legacy.id,legacy);
 const extra={...structuredClone(savedPin),id:'edit:extra',blobIds:[...savedPin.blobIds,'unfinished']};memory.stores.blob_pins.set(extra.id,extra);
 memory.stores.blobs.set('unfinished',{id:'unfinished',blob:new Blob(['new original'])});
 const recoverable=await b.listRecoveries();assert.ok(recoverable.some(row=>row.id===legacy.id));assert.ok(recoverable.some(row=>row.id===extra.id));
 assert.ok(memory.stores.blobs.has('unfinished'),'same-revision snapshot with extra originals is retained');
 // The explicit owner release follows the same proven-inactive cleanup path.
 const d=Store.create({transaction:memory.transaction,locks,uid:p=>p+'-fourth',indexRowFor:p=>({id:p.id})});
 await d.setRecoveryEnabled(false);await d.getProject(p.id,{activate:true});await d.putBlob({id:'release-extra',blob:new Blob(['extra'])});
 await d.releaseProject();await b.listRecoveries();assert.equal(memory.stores.blobs.has('release-extra'),false);
}
async function main(){
 await recoveryPreferences();await inactiveSessionCleanup();
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
 console.log('Project store safety regression: PASS (CAS, recovery preference/rollback, inactive pins, immutable originals, receipt and lists)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
