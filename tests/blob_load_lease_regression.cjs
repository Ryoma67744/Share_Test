'use strict';
const assert=require('node:assert/strict');
const Store=require('../project-store-safety.js'),memoryIdb=require('./helpers/memory-idb.cjs');
function lockManager(){
 const held=new Map();
 return {held,request(name,options,callback){
  if(typeof options==='function'){callback=options;options={};}
  if(held.has(name))return Promise.resolve(callback(null));
  const token={name};held.set(name,token);
  return Promise.resolve().then(()=>callback(token)).finally(()=>{if(held.get(name)===token)held.delete(name);});
 }};
}
async function main(){
 const mem=memoryIdb(),locks=lockManager();let n=0;
 const make=()=>Store.create({transaction:mem.transaction,locks,uid:p=>p+(++n),indexRowFor:p=>({id:p.id})});
 const a=make(),b=make(),blob=id=>({id,blob:new Blob([id])});
 const lease=await a.beginBlobLease({kind:'cloud-import',projectId:'source'});
 mem.failNextCommit=true;
 await assert.rejects(()=>a.putBlob(blob('rolled-back'),{lease}),/quota/);
 assert.equal(mem.stores.blobs.has('rolled-back'),false);assert.deepEqual(mem.stores.blob_pins.get(lease.id).blobIds,[]);
 await a.putBlob(blob('raw'),{lease});await b.pruneShareOrphans();assert.equal(mem.stores.blobs.has('raw'),true);
 await assert.rejects(()=>b.finishBlobLease(lease),{code:'BLOB_LEASE_OWNER'});
 await assert.rejects(()=>a.finishBlobLease({...lease}),{code:'BLOB_LEASE_OWNER'});
 await assert.rejects(()=>b.releaseBlobPins(lease.id),{code:'BLOB_LEASE_OWNER'});
 await assert.rejects(()=>b.pinBlobs(lease.id,[]),{code:'BLOB_LEASE_OWNER'});
 const project={id:'import',sections:[{msiFiles:{raw:{blobId:'raw'}}}]};
 mem.failNextCommit=true;
 await assert.rejects(()=>a.finishBlobLease(lease,{project,createOnly:true}),/quota/);
 assert.equal(mem.stores.projects.has('import'),false);assert.equal(mem.stores.blob_pins.has(lease.id),true);
 await a.finishBlobLease(lease,{project,createOnly:true});await b.pruneShareOrphans();
 assert.equal(mem.stores.blob_pins.has(lease.id),false);assert.equal(mem.stores.blobs.has('raw'),true);
 await assert.rejects(()=>a.putBlob(blob('too-late'),{lease}),{code:'BLOB_LEASE_OWNER'});
 assert.equal(await a.finishBlobLease(lease),false);
 const shared=await a.beginBlobLease({kind:'share-view'});await a.putBlob(blob('cached'),{lease:shared});
 await a.pinBlobLease(shared,['raw']);await b.pruneShareOrphans();assert.equal(mem.stores.blobs.has('cached'),true);
 const second=await b.beginBlobLease({kind:'share-view'});await b.pinBlobLease(second,['cached']);
 await a.finishBlobLease(shared);assert.equal(mem.stores.blobs.has('cached'),true,'another live lease retains bytes');
 await b.finishBlobLease(second);assert.equal(mem.stores.blobs.has('raw'),true,'abort cannot remove a project original');
 await a.getProject('import',{activate:true});
 const abort=await a.beginBlobLease({kind:'cloud-import'});await a.putBlob(blob('aborted'),{lease:abort});await a.finishBlobLease(abort);
 assert.equal(mem.stores.blobs.has('aborted'),false);assert.equal(mem.stores.projects.size,1);
 assert.equal(mem.stores.blobs.has('raw'),true,'the prior active master original remains protected');
 assert.ok(![...mem.stores.blob_pins.values()].some(row=>row.kind==='editing-session'&&row.blobIds.includes('aborted')),'cloud loads do not attach to an unrelated editing session');
 await a.releaseProject();
 await a.putBlob(blob('legacy-unleased'));await b.pruneShareOrphans();assert.equal(mem.stores.blobs.has('legacy-unleased'),true);
 const incomplete=await a.beginBlobLease({kind:'cloud-import'});
 await assert.rejects(()=>a.finishBlobLease(incomplete,{project:{id:'missing',sections:[{images:{HE:{blobId:'absent'}}}]},createOnly:true}),/原本がありません/);
 assert.equal(mem.stores.projects.has('missing'),false);await a.finishBlobLease(incomplete);
 const crashed=await a.beginBlobLease({kind:'share-view'});await a.putBlob(blob('crashed-cache'),{lease:crashed});
 assert.equal(await b.reclaimInactiveBlobLeases(),0);locks.held.delete('desi-blob-lease:'+crashed.id);
 assert.equal(await b.reclaimInactiveBlobLeases(),1);assert.equal(mem.stores.blobs.has('crashed-cache'),false);
 // A browser without Web Locks cannot prove another tab has ended.
 const withoutLocks=Store.create({transaction:mem.transaction,uid:p=>p+(++n),indexRowFor:p=>({id:p.id})});
 const unknown=await withoutLocks.beginBlobLease({kind:'share-view'});await withoutLocks.putBlob(blob('unknown-live'),{lease:unknown});
 assert.equal(await withoutLocks.reclaimInactiveBlobLeases(),0);assert.equal(mem.stores.blobs.has('unknown-live'),true);
 assert.equal(await b.reclaimInactiveBlobLeases(),0,'a lock-capable tab cannot reclaim a lease with unknown liveness');
 await withoutLocks.finishBlobLease(unknown);
 console.log('Blob load lease regression: PASS (atomic pins, owner checks, commit/abort, live/crashed leases, no-TTL fallback)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
