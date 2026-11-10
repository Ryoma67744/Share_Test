/* Session-scoped original loading. This module never interprets scientific data. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SourceLoader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const failure = (code, message, cause) => Object.assign(new Error(message), {code}, cause ? {cause} : {});
    const cancelled = () => Object.assign(failure('SOURCE_CANCELLED', '原本の読み込みを中断しました。'), {name:'AbortError'});
    const active = current => {try {return !current || current() !== false;} catch (_) {return false;}};
    const hasBlob = record => !!record?.blob && typeof record.blob.arrayBuffer === 'function';
    function waitWithSignal(promise, signal) {
        if (signal.aborted) {
            // A hook may synchronously trigger cancellation before returning
            // its promise. Observe its rejection even though it is now stale.
            Promise.resolve(promise).catch(() => {});
            return Promise.reject(cancelled());
        }
        return new Promise((resolve, reject) => {
            const abort = () => {signal.removeEventListener('abort', abort);reject(cancelled());};
            signal.addEventListener('abort', abort, {once:true});
            Promise.resolve(promise).then(value => {
                signal.removeEventListener('abort', abort);resolve(value);
            }, error => {signal.removeEventListener('abort', abort);reject(error);});
        });
    }
    function create(options = {}) {
        const storage = options.storage;
        if (!storage?.getBlob || !storage?.putBlob || (options.lease && !storage.getBlobWithLease)) {
            throw new TypeError('SourceLoader requires Blob storage and atomic lease reads.');
        }
        const byKey = new Map(), byId = new Map(), bindings = new WeakMap(), pending = new Set();
        const createId = options.createId || (() => 'blob_' + globalThis.crypto.randomUUID());
        let disposed = false, disposal = null;
        const sessionActive = () => !disposed && active(options.current);
        const assertSession = () => {if (!sessionActive()) throw cancelled();};
        function describe(entry, override) {
            const source = override || options.resolveSource?.(entry) || {};
            return {
                path:source.path || entry.storagePath || entry.path || '',
                url:source.url || entry.sourceUrl || '',
                mime:source.mime || entry.mime || '',
                filename:source.filename || entry.filename || '',
                parquet:String(source.kind || entry.kind || '').toLowerCase() === 'parquet',
                key:source.key || ''
            };
        }
        function identityError() {
            return failure('SOURCE_IDENTITY_CHANGED', '原本の参照が読み込み開始時から変わりました。');
        }
        function lookup(entry, descriptor) {
            const bound = bindings.get(entry);
            const id = entry.blobId;
            const key = descriptor.key || (descriptor.path ? 'path:' + descriptor.path : descriptor.url ? 'url:' + descriptor.url : id ? 'id:' + id : '');
            const handle = bound || (key && byKey.get(key)) || (id && byId.get(id));
            if (handle) {
                if ((id && id !== handle.id) || (bound && id !== handle.id)
                    || (descriptor.path && handle.path && descriptor.path !== handle.path)
                    || (descriptor.key && handle.explicitKey && descriptor.key !== handle.explicitKey)
                    || (!descriptor.path && !handle.path && descriptor.url && handle.url && descriptor.url !== handle.url)) throw identityError();
                // A copied export/TIC entry may contain only the reserved ID.
                if (key && !byKey.has(key)) byKey.set(key, handle);
            }
            return {handle, key};
        }
        function reserve(entry, override) {
            assertSession();
            if (!entry || typeof entry !== 'object') throw new TypeError('Source entry is required.');
            const descriptor = describe(entry, override);
            if (descriptor.parquet) return null; // Parquet retains the existing HTTP Range pipeline.
            const found = lookup(entry, descriptor);
            let handle = found.handle;
            if (!handle) {
                const id = entry.blobId || createId('blob');
                if (!id || byId.has(id)) throw identityError();
                handle = {...descriptor, id, explicitKey:descriptor.key, status:'idle', error:null, job:null};
                handle.public = Object.freeze({id, path:handle.path, url:handle.url});
                byId.set(id, handle);
                byKey.set(found.key || 'id:' + id, handle);
            }
            // This is the only metadata write. Call reserve before panel identity
            // snapshots; ensure never replaces a pre-existing ID.
            if (!entry.blobId) entry.blobId = handle.id;
            bindings.set(entry, handle);
            return handle.public;
        }
        function getState(entry) {
            if (!entry || typeof entry !== 'object') return {status:'idle', error:null};
            const handle = bindings.get(entry) || byId.get(entry.blobId);
            return {status:handle?.status || 'idle', error:handle?.error || null};
        }
        function settle(consumer, error, record) {
            if (consumer.done) return;
            consumer.done = true;
            consumer.signal?.removeEventListener('abort', consumer.abort);
            consumer.job.consumers.delete(consumer);
            if (error) consumer.reject(error); else consumer.resolve(record);
        }
        function stopUnused(job) {
            if (!job.consumers.size && !job.finished) {
                job.cancelled = true;
                job.controller.abort();
            }
        }
        function check(job) {
            for (const consumer of [...job.consumers]) {
                if (consumer.signal?.aborted || !active(consumer.current)) settle(consumer, cancelled());
            }
            if (!sessionActive() || job.cancelled || !job.consumers.size) {
                job.cancelled = true;job.controller.abort();throw cancelled();
            }
        }
        const read = id => options.lease ? storage.getBlobWithLease(id, options.lease) : storage.getBlob(id);
        async function load(handle, job) {
            check(job);
            // Always check storage: IndexedDB may have evicted bytes since the
            // last completed load. Do not retain large Blob objects in this map.
            let record = await read(handle.id);
            check(job);
            if (hasBlob(record)) return record;
            if (!handle.url || !options.fetchBlob) throw failure('SOURCE_UNAVAILABLE', 'この原本の取得先がありません。');
            let blob;
            try {
                blob = await waitWithSignal(options.fetchBlob(handle.url, {signal:job.controller.signal}), job.controller.signal);
            } catch (cause) {
                check(job);
                const status = Number(cause?.status || cause?.response?.status || /\bHTTP\s+(\d{3})\b/i.exec(cause?.message || '')?.[1]) || null;
                const missing = status === 404 || status === 410;
                throw Object.assign(failure(missing ? 'SOURCE_MISSING' : 'SOURCE_FETCH_FAILED',
                    missing ? '共有原本が見つかりません。公開元で再公開してください。' : (cause?.message || '原本を取得できませんでした。'), cause), {status});
            }
            check(job);
            if (!blob || typeof blob.arrayBuffer !== 'function') throw failure('SOURCE_FETCH_FAILED', '原本の応答を読み取れませんでした。');
            let collision = false;
            try {
                await storage.putBlob({id:handle.id, blob, mime:handle.mime || blob.type || 'application/octet-stream',
                    filename:handle.filename || handle.path.split('/').pop() || ''}, {lease:options.lease});
            } catch (cause) {
                check(job);
                // An explicit original operation can have stored this same ID
                // while our fetch was running. Never overwrite the first bytes.
                if (cause?.code === 'BLOB_ID_EXISTS') collision = true;
                else throw failure('SOURCE_STORAGE_FAILED', cause?.message || '原本を保存できませんでした。', cause);
            }
            check(job);
            record = await read(handle.id);
            check(job);
            if (!hasBlob(record) || (!collision && record.blob.size !== blob.size)) {
                throw failure('SOURCE_STORAGE_VERIFY_FAILED', '原本を保存できませんでした。保存容量を確認してください。');
            }
            return record;
        }
        function start(handle, job) {
            handle.status = 'loading';handle.error = null;
            const task = Promise.resolve().then(() => load(handle, job)).then(record => {
                check(job);
                handle.status = 'ready';handle.error = null;
                job.finished = true;
                if (handle.job === job) handle.job = null;
                for (const consumer of [...job.consumers]) settle(consumer, null, record);
            }).catch(error => {
                const aborted = !sessionActive() || job.cancelled || error?.name === 'AbortError';
                handle.status = aborted ? 'idle' : ['SOURCE_MISSING','SOURCE_UNAVAILABLE'].includes(error?.code) ? 'missing' : 'error';
                handle.error = aborted ? null : error;
                job.finished = true;
                if (handle.job === job) handle.job = null;
                for (const consumer of [...job.consumers]) settle(consumer, aborted ? cancelled() : error);
            }).finally(() => {
                job.finished = true;
                if (handle.job === job) handle.job = null;
                pending.delete(task);
            });
            job.promise = task;pending.add(task);
        }
        function ensure(entry, request = {}) {
            try {
                assertSession();
                if (request.signal?.aborted || !active(request.current)) throw cancelled();
                const reserved = reserve(entry);
                if (!reserved) return Promise.resolve(null);
                const handle = byId.get(reserved.id);
                // If cancellation caught a storage commit in flight, wait for
                // it before retrying. This prevents two writers for one ID.
                if (handle.job?.cancelled) {
                    const wait = request.signal ? waitWithSignal(handle.job.promise, request.signal) : handle.job.promise;
                    return wait.then(() => ensure(entry, request));
                }
                let job = handle.job, fresh = false;
                if (!job) {
                    job = {consumers:new Set(), controller:new AbortController(), cancelled:false, finished:false, promise:null};
                    handle.job = job;fresh = true;
                }
                const result = new Promise((resolve, reject) => {
                    const consumer = {job, signal:request.signal, current:request.current, resolve, reject, done:false};
                    consumer.abort = () => {settle(consumer, cancelled());stopUnused(job);};
                    job.consumers.add(consumer);
                    consumer.signal?.addEventListener('abort', consumer.abort, {once:true});
                });
                if (fresh) start(handle, job);
                return result;
            } catch (error) {return Promise.reject(error);}
        }
        function dispose() {
            if (disposal) return disposal;
            disposed = true;
            for (const handle of byId.values()) if (handle.job) {
                for (const consumer of [...handle.job.consumers]) settle(consumer, cancelled());
                stopUnused(handle.job);
            }
            // The owner releases the Blob lease only after this drain. Fetch
            // cancellation is immediate; a committed storage write is drained.
            disposal = Promise.all([...pending]).then(() => {});
            return disposal;
        }
        return {reserve, ensure, getState, dispose};
    }
    return {create};
});
