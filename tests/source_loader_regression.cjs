'use strict';
const assert = require('node:assert/strict');
const Loader = require('../viewer/source-loader.js');
const Store = require('../project-store-safety.js');
const memoryIdb = require('./helpers/memory-idb.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(overrides = {}) {
    const rows = new Map(), calls = {read:0, leased:0, put:0, fetch:0}, lease = {id:'lease'};
    const storage = {
        async getBlob(id) {calls.read++;return rows.get(id) || null;},
        async getBlobWithLease(id, actual) {assert.equal(actual,lease);calls.leased++;return rows.get(id) || null;},
        async putBlob(row, settings) {assert.equal(settings.lease,lease);calls.put++;rows.set(row.id,row);}
    };
    let serial = 0;
    const session = Loader.create({storage,lease,createId:()=>'reserved-'+(++serial),
        resolveSource:entry=>({path:entry.storagePath,url:entry.storagePath?'https://example.test/'+entry.storagePath:'',kind:entry.kind}),
        fetchBlob:async()=>{calls.fetch++;return new Blob([new Uint8Array([0,1,2,128,255])]);}, ...overrides});
    return {session,storage,rows,calls,lease};
}
const entry = (path='project/publish-v2/r1/original.txt') => ({kind:'txt',storagePath:path,filename:'original.txt',
    sourceReference:{file:'reference',revision:7},sourceFileId:'file-one',x:'x',y:'y',v:'MRM-1'});
const aborted = promise => assert.rejects(promise,{name:'AbortError',code:'SOURCE_CANCELLED'});

async function metadataAndSharedFetch() {
    const gate=deferred();let fetches=0;
    const f=fixture({fetchBlob:async()=>{fetches++;return gate.promise;}}), a=entry(), b={...entry(),v:'MRM-2'};
    const scientific=structuredClone(a);
    const reserved=f.session.reserve(a);
    assert.equal(f.session.reserve(b),reserved);
    assert.equal(a.blobId,b.blobId);
    const withoutId={...a};delete withoutId.blobId;
    assert.deepEqual(withoutId,scientific,'reservation must not alter scientific selectors/references');
    assert.deepEqual(f.calls,{read:0,leased:0,put:0,fetch:0},'metadata reservation is synchronous and does not read/download bytes');
    assert.equal(f.session.getState(a).status,'idle');
    const first=f.session.ensure(a),second=f.session.ensure(b),snapshot=Object.freeze({...a});
    const third=f.session.ensure(snapshot);
    await tick();assert.equal(fetches,1);assert.equal(f.calls.leased,1);
    assert.equal(f.session.getState(b).status,'loading');
    const bytes=new Uint8Array([0,1,2,128,255]);gate.resolve(new Blob([bytes]));
    const records=await Promise.all([first,second,third]);
    assert.equal(records[0],records[1]);assert.equal(records[1],records[2]);
    assert.deepEqual(new Uint8Array(await records[0].blob.arrayBuffer()),bytes,'byte identity is preserved');
    assert.equal(f.calls.put,1);assert.equal(f.calls.leased,2);assert.equal(f.calls.read,0);
    assert.equal(f.session.getState(a).status,'ready');
    assert.equal(await f.session.ensure(Object.freeze({blobId:a.blobId})),records[0],'ID-only snapshot finds its reserved source');
    assert.equal(fetches,1);assert.equal(f.calls.put,1);assert.equal(f.calls.leased,3,'warm reuse is atomically pinned');
    // A completed result must not conceal later IndexedDB eviction.
    f.rows.clear();await f.session.ensure(a);
    assert.equal(fetches,2);assert.equal(a.blobId,reserved.id);assert.equal(f.calls.put,2);
    await f.session.dispose();
}

async function existingAndIdentity() {
    const f=fixture(), a={...entry(),blobId:'existing'};
    const original={id:'existing',blob:new Blob(['existing original'])};f.rows.set('existing',original);
    f.session.reserve(a);assert.equal(await f.session.ensure(a),original);
    assert.equal(a.blobId,'existing');assert.equal(f.calls.fetch,0);assert.equal(f.calls.put,0);
    const conflict={...a,blobId:'different'};
    await assert.rejects(f.session.ensure(conflict),{code:'SOURCE_IDENTITY_CHANGED'});
    assert.equal(conflict.blobId,'different','ensure must not silently swap a snapshot ID');
    const moved={...a,storagePath:'project/publish-v2/r2/changed.txt'};
    await assert.rejects(f.session.ensure(moved),{code:'SOURCE_IDENTITY_CHANGED'});
    a.blobId='changed-in-place';
    await assert.rejects(f.session.ensure(a),{code:'SOURCE_IDENTITY_CHANGED'});
    await f.session.dispose();
    const pq=fixture(), parquet={kind:'parquet',sourceUrl:'https://example.test/huge.parquet'};
    assert.equal(pq.session.reserve(parquet),null);assert.equal(await pq.session.ensure(parquet),null);
    assert.equal(parquet.blobId,undefined);assert.deepEqual(pq.calls,{read:0,leased:0,put:0,fetch:0});
    await pq.session.dispose();
}

async function cancellationIsPerConsumer() {
    const gate=deferred();let fetchSignal;
    const f=fixture({fetchBlob:(_,options)=>{fetchSignal=options.signal;return gate.promise;}}), a=entry();
    const firstAbort=new AbortController(), secondAbort=new AbortController();
    const first=f.session.ensure(a,{signal:firstAbort.signal});const firstRejected=aborted(first);
    const second=f.session.ensure({...a},{signal:secondAbort.signal});
    await tick();firstAbort.abort();await firstRejected;
    assert.equal(fetchSignal.aborted,false,'a remaining export/panel must keep its shared download');
    gate.resolve(new Blob(['still needed']));assert.equal((await second).id,a.blobId);
    assert.equal(f.calls.put,1);await f.session.dispose();

    const gated=deferred();let activeSignal, fetches=0;
    const c=fixture({fetchBlob:(_,options)=>{activeSignal=options.signal;fetches++;return fetches===1?gated.promise:Promise.resolve(new Blob(['retry']));}}), e=entry();
    const controller=new AbortController(), cancelledRequest=c.session.ensure(e,{signal:controller.signal}), rejected=aborted(cancelledRequest);
    await tick();controller.abort();await rejected;assert.equal(activeSignal.aborted,true);
    const retried=await c.session.ensure(e);assert.equal(await retried.blob.text(),'retry');
    gated.resolve(new Blob(['obsolete late bytes']));await tick();
    assert.equal(c.calls.put,1,'an ignored abort response cannot save stale bytes');
    assert.equal(await c.rows.get(e.blobId).blob.text(),'retry');await c.session.dispose();
    const synchronous=new AbortController();
    const instant=fixture({fetchBlob:()=>{synchronous.abort();return Promise.reject(new Error('transport abort'));}});
    await aborted(instant.session.ensure(entry(),{signal:synchronous.signal}));
    await instant.session.dispose();await tick();assert.equal(instant.calls.put,0);
}

async function currentChecksAndDisposal() {
    const gate=deferred();let firstCurrent=true;
    const f=fixture({fetchBlob:()=>gate.promise}), a=entry();
    const old=f.session.ensure(a,{current:()=>firstCurrent}), rejected=aborted(old);
    const live=f.session.ensure({...a});await tick();firstCurrent=false;
    gate.resolve(new Blob(['live consumer']));await rejected;assert.ok(await live);assert.equal(f.calls.put,1);
    await f.session.dispose();

    const late=deferred();let signal;
    const d=fixture({fetchBlob:(_,options)=>{signal=options.signal;return late.promise;}}), item=entry();
    const request=d.session.ensure(item), requestRejected=aborted(request);
    await tick();await d.session.dispose();await requestRejected;
    assert.equal(signal.aborted,true);assert.equal(d.calls.put,0);
    late.resolve(new Blob(['old project']));await tick();assert.equal(d.calls.put,0);
    assert.equal(d.session.getState(item).status,'idle');
    await aborted(d.session.ensure(item));assert.equal(d.session.dispose(),d.session.dispose(),'disposal is idempotent');

    const commit=deferred(), s=fixture();let commitStarted=false;
    const save=s.storage.putBlob.bind(s.storage);
    s.storage.putBlob=async(...args)=>{commitStarted=true;await commit.promise;return save(...args);};
    const loading=s.session.ensure(entry()), loadingRejected=aborted(loading);await tick();assert.ok(commitStarted);
    let drained=false;const disposal=s.session.dispose().then(()=>{drained=true;});
    await loadingRejected;await tick();assert.equal(drained,false,'lease release must wait for an already-started commit');
    commit.resolve();await disposal;assert.equal(drained,true);

    let projectCurrent=true;const projectGate=deferred(), p=fixture({current:()=>projectCurrent,fetchBlob:()=>projectGate.promise});
    const stale=p.session.ensure(entry()), staleRejected=aborted(stale);await tick();projectCurrent=false;
    projectGate.resolve(new Blob(['old project']));await staleRejected;assert.equal(p.calls.put,0);await p.session.dispose();
}

async function failuresAndRetry() {
    for(const [status,code,state] of [[404,'SOURCE_MISSING','missing'],[410,'SOURCE_MISSING','missing'],[503,'SOURCE_FETCH_FAILED','error']]) {
        let fails=true;const f=fixture({fetchBlob:async()=>{if(fails)throw new Error('原本を取得できませんでした (HTTP '+status+')。');return new Blob(['recovered']);}}), a=entry();
        assert.equal(f.session.getState(a).status,'idle');
        await assert.rejects(f.session.ensure(a),{code,status});assert.equal(f.session.getState(a).status,state);
        fails=false;assert.equal(await (await f.session.ensure(a)).blob.text(),'recovered');
        assert.deepEqual(f.session.getState(a),{status:'ready',error:null});await f.session.dispose();
    }
    const network=fixture({fetchBlob:async()=>{throw new TypeError('Failed to fetch');}}), a=entry();
    await assert.rejects(network.session.ensure(a),{code:'SOURCE_FETCH_FAILED',status:null});
    assert.equal(network.session.getState(a).status,'error','CORS/network errors are not proof of a missing original');await network.session.dispose();
    const missing=fixture(), local={blobId:'not-in-idb'};
    await assert.rejects(missing.session.ensure(local),{code:'SOURCE_UNAVAILABLE'});
    assert.equal(missing.session.getState(local).status,'missing');assert.equal(missing.calls.fetch,0);await missing.session.dispose();
    const quota=fixture(), q=entry();quota.storage.putBlob=async()=>{throw Object.assign(new Error('Quota exceeded'),{name:'QuotaExceededError'});};
    await assert.rejects(quota.session.ensure(q),error=>error.code==='SOURCE_STORAGE_FAILED'&&error.cause.name==='QuotaExceededError');
    assert.equal(quota.session.getState(q).status,'error');await quota.session.dispose();
    const vanished=fixture(), v=entry();vanished.storage.putBlob=async()=>{};
    await assert.rejects(vanished.session.ensure(v),{code:'SOURCE_STORAGE_VERIFY_FAILED'});
    assert.equal(vanished.session.getState(v).status,'error');await vanished.session.dispose();
    const corrupt=fixture();corrupt.storage.putBlob=async row=>{corrupt.rows.set(row.id,{...row,blob:new Blob(['wrong size'])});};
    await assert.rejects(corrupt.session.ensure(entry()),{code:'SOURCE_STORAGE_VERIFY_FAILED'});await corrupt.session.dispose();
    const concurrent=fixture(), c=entry();concurrent.storage.putBlob=async row=>{
        concurrent.rows.set(row.id,{...row,blob:new Blob(['first committed original'])});
        throw Object.assign(new Error('immutable ID already saved'),{code:'BLOB_ID_EXISTS'});
    };
    assert.equal(await (await concurrent.session.ensure(c)).blob.text(),'first committed original','ID collision never overwrites existing original bytes');
    await concurrent.session.dispose();
}

async function realLeaseBoundary() {
    const mem=memoryIdb();let serial=0;
    const store=Store.create({transaction:mem.transaction,locks:null,uid:p=>p+(++serial),indexRowFor:p=>({id:p.id})});
    const owner=await store.beginBlobLease({kind:'share-view'}), borrower=await store.beginBlobLease({kind:'share-view'});
    await store.putBlob({id:'existing',blob:new Blob(['protected'])},{lease:owner});
    let fetches=0;
    const storage={...store,getBlob:async id=>mem.stores.blobs.get(id)||null};
    const session=Loader.create({storage,lease:borrower,fetchBlob:async()=>{fetches++;throw new Error('not needed');}});
    assert.ok(await session.ensure({blobId:'existing'}));
    await store.finishBlobLease(owner);
    assert.ok(mem.stores.blobs.get('existing'),'atomic borrow protects bytes when the original owner closes');
    assert.equal(fetches,0);await session.dispose();await store.finishBlobLease(borrower);
    assert.equal(mem.stores.blob_pins.size,0);
}

async function main() {
    await metadataAndSharedFetch();await existingAndIdentity();await cancellationIsPerConsumer();
    await currentChecksAndDisposal();await failuresAndRetry();await realLeaseBoundary();
    console.log('Source loader regression: PASS (fixed identities, deferred bytes, shared inflight, consumer cancellation, lease reuse, stale guards, verification and failures)');
}
const watchdog=setTimeout(()=>{console.error('Source loader regression timed out with an unsettled request');process.exitCode=1;},10000);
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
