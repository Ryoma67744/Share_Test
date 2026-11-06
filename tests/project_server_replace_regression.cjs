'use strict';
const assert=require('node:assert/strict');
const Store=require('../project-store-safety.js'),memoryIdb=require('./helpers/memory-idb.cjs');
async function fixture(recovery=true){
 const mem=memoryIdb();let n=0;
 const make=()=>Store.create({transaction:mem.transaction,locks:null,uid:p=>p+'-'+(++n),nowIso:()=> '2026-11-06T10:00:00.000Z',
  indexRowFor:p=>({id:p.id,displayName:p.displayName,storageRevision:p.storageRevision,shared:!!p.shareInfo})});
 const a=make(),b=make();
 for(const id of ['original','photo'])await a.putBlob({id,blob:new Blob([id])});
 const old={id:'local',displayName:'Local old',createdAt:'2025-01-01T00:00:00Z',sections:[{id:'section',msiFiles:{raw:{blobId:'original'}}}],
  rois:[{id:'roi',polysBySection:{section:[[0,0],[1,0],[0,1]]}}],meta:{roiMedia:{items:[{id:'photo-item',blobId:'photo'}]}},
  shareInfo:{slug:'shared',serverRevision:4,viewerPassword:'synthetic-only'}};
 await a.putProject(old,{createOnly:true});await a.getProject(old.id,{activate:true});await a.setRecoveryEnabled(recovery);
 const lease=await a.beginBlobLease({kind:'cloud-import',projectId:old.id});
 for(const id of ['incoming','unused'])await a.putBlob({id,blob:new Blob([id])},{lease});
 const incoming={id:'new-download-id',displayName:'Server new',sections:[{id:'server-section',images:{HE:{blobId:'incoming'}}}],rois:[],meta:{},
  shareInfo:{slug:'shared',serverRevision:5,blobPaths:{incoming:{path:'shared/immutable'}}}};
 const settings={expectedRevision:1,expectedServerRevision:5,lease};
 return {mem,a,b,old,incoming,settings,lease};
}
const state=mem=>Object.fromEntries(Object.entries(mem.stores).map(([name,rows])=>[name,structuredClone([...rows])]));
async function success(recovery){
 const {mem,a,b,old,incoming,settings,lease}=await fixture(recovery);
 const callerCopy=structuredClone(incoming),oldCopy=await a.getProject(old.id);
 const result=await a.replaceProjectFromServer(old.id,incoming,settings);
 assert.deepEqual(incoming,callerCopy,'the caller document is not rewritten during commit');
 assert.equal(result.project.id,old.id);assert.equal(result.previousStorageRevision,1);assert.equal(result.storageRevision,2);
 assert.equal(result.project.createdAt,old.createdAt);assert.equal(result.project.shareInfo.serverRevision,5);
 assert.equal(mem.stores.projects.size,2);assert.deepEqual(await b.getProject(old.id),result.project);
 const backup=await b.getProject(result.backupProject.id);assert.notEqual(backup.id,old.id);assert.equal(backup.storageRevision,1);
 assert.equal(backup.shareInfo,undefined);assert.equal(backup.__share,undefined);assert.equal(backup.__publishPending,undefined);
 assert.deepEqual(backup.sections,oldCopy.sections);assert.deepEqual(backup.rois,oldCopy.rois);assert.deepEqual(backup.meta,oldCopy.meta);
 assert.match(backup.displayName,/Local old.*サーバー版取り込み前/);
 assert.equal(mem.stores.project_index.get(old.id).storageRevision,2);assert.equal(mem.stores.project_index.get(backup.id).shared,false);
 assert.equal(mem.stores.project_recovery.size,0,'explicit backup is independent of automatic recovery');
 const session=[...mem.stores.blob_pins.values()].find(row=>row.kind==='editing-session');
 assert.ok(session.blobIds.includes('incoming'));assert.equal(!!session.project,recovery);
 if(recovery)assert.equal(session.savedRevision,2);
 assert.equal(mem.stores.blob_pins.has(lease.id),false);assert.equal(await a.finishBlobLease(lease),false);
 assert.ok(mem.stores.blobs.has('incoming'));assert.equal(mem.stores.blobs.has('unused'),false);
 for(const id of ['original','photo']){assert.equal(await b.deleteBlob(id),false);assert.equal(await mem.stores.blobs.get(id).blob.text(),id);}
 // A second tab holding the previous record cannot overwrite the newly accepted server copy.
 oldCopy.displayName='stale overwrite';await assert.rejects(()=>b.putProject(oldCopy),{code:'LOCAL_PROJECT_CONFLICT'});
 assert.equal((await a.getProject(old.id)).displayName,'Server new');
 await a.releaseProject();
}
async function rejectedChanges(){
 const cases=[
  ['other-tab edit',async f=>{const p=await f.b.getProject('local');p.displayName='Other tab saved';await f.b.putProject(p);}],
  ['other-tab deletion',f=>f.b.deleteProject('local',{expectedRevision:1})],
  ['unpublished edits',f=>f.b.patchProject('local',p=>{p.__publishPending=true;})],
  ['pending receipt',f=>f.b.patchProject('local',p=>{p.shareInfo.pendingPublish={jobId:'pending'};})],
  ['legacy pending marker',f=>f.b.patchProject('local',p=>{p.pendingPublish={jobId:'pending'};})],
  ['changed destination',f=>f.b.patchProject('local',p=>{p.shareInfo.slug='another';})],
  ['newer baseline',f=>f.b.patchProject('local',p=>{p.shareInfo.serverRevision=6;})]
 ];
 for(const [name,change] of cases){
  const f=await fixture(false);await change(f);
  if(!name.startsWith('other-tab'))f.settings.expectedRevision=(await f.a.getProject('local')).storageRevision;
  const before=state(f.mem);
  await assert.rejects(()=>f.a.replaceProjectFromServer('local',f.incoming,f.settings),{code:'LOCAL_PROJECT_CONFLICT'},name);
  assert.deepEqual(state(f.mem),before,name+' leaves all existing stores and the live download lease unchanged');
  await f.a.finishBlobLease(f.lease);assert.equal(f.mem.stores.blobs.has('incoming'),false);assert.equal(f.mem.stores.blobs.has('unused'),false);
  await f.a.releaseProject();
 }
}
async function invalidInputs(){
 const cases=[
  ['missing expected local revision',f=>{delete f.settings.expectedRevision;}],
  ['null expected local revision',f=>{f.settings.expectedRevision=null;}],
  ['unknown server revision',f=>{f.incoming.shareInfo.serverRevision=null;}],
  ['unexpected server revision',f=>{f.settings.expectedServerRevision=6;}],
  ['null expected server revision',f=>{f.settings.expectedServerRevision=null;}],
  ['partial download',f=>{f.incoming.__importFailures=1;}],
  ['incoming pending',f=>{f.incoming.__publishPending=true;}],
  ['missing original',f=>{f.incoming.sections[0].images.HE.blobId='absent';}]
 ];
 for(const [name,change] of cases){const f=await fixture();change(f);const before=state(f.mem);
  await assert.rejects(()=>f.a.replaceProjectFromServer('local',f.incoming,f.settings),undefined,name);assert.deepEqual(state(f.mem),before,name);
  await f.a.finishBlobLease(f.lease);await f.a.releaseProject();}
 const f=await fixture();const before=state(f.mem);
 await assert.rejects(()=>f.b.replaceProjectFromServer('local',f.incoming,f.settings),{code:'BLOB_LEASE_OWNER'});
 await assert.rejects(()=>f.a.replaceProjectFromServer('local',f.incoming,{...f.settings,lease:{...f.lease}}),{code:'BLOB_LEASE_OWNER'});
 assert.deepEqual(state(f.mem),before);await f.a.finishBlobLease(f.lease);await f.a.releaseProject();
}
async function abortAndFreeze(){
 const f=await fixture(false),before=state(f.mem),input=structuredClone(f.incoming);
 f.mem.failNextCommit=true;
 await assert.rejects(()=>f.a.replaceProjectFromServer('local',f.incoming,f.settings),{name:'QuotaExceededError'});
 assert.deepEqual(state(f.mem),before,'commit abort rolls back project, backup, both indexes, pins and blob cleanup');
 assert.deepEqual(f.incoming,input);assert.ok(f.mem.stores.blob_pins.has(f.lease.id));
 const promise=f.a.replaceProjectFromServer('local',f.incoming,f.settings);
 f.incoming.displayName='caller later edit';f.incoming.shareInfo.slug='caller later slug';f.settings.expectedRevision=999;
 const result=await promise;
 assert.equal(result.project.displayName,'Server new');assert.equal(result.project.shareInfo.slug,'shared');assert.equal(result.storageRevision,2);
 assert.equal(await f.a.finishBlobLease(f.lease),false);await f.a.releaseProject();
}
async function main(){await success(true);await success(false);await rejectedChanges();await invalidInputs();await abortAndFreeze();
 console.log('Project server replace regression: PASS (atomic independent backup, CAS/pending guards, original retention, lease commit/abort, frozen inputs)');}
main().catch(error=>{console.error(error);process.exitCode=1;});
