/* Session-scoped original loading. This module never interprets scientific data. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SourceLoader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
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

    const failure = (code, message, cause) => Object.assign(new Error(message), {code}, cause ? {cause} : {});
    const cancelled = () => Object.assign(failure('SOURCE_CANCELLED', _uiT("原本の読み込みを中断しました。")), {name:'AbortError'});
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
            return failure('SOURCE_IDENTITY_CHANGED', _uiT("原本の参照が読み込み開始時から変わりました。"));
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
            if (!handle.url || !options.fetchBlob) throw failure('SOURCE_UNAVAILABLE', _uiT("この原本の取得先がありません。"));
            let blob;
            try {
                blob = await waitWithSignal(options.fetchBlob(handle.url, {signal:job.controller.signal}), job.controller.signal);
            } catch (cause) {
                check(job);
                const status = Number(cause?.status || cause?.response?.status || /\bHTTP\s+(\d{3})\b/i.exec(cause?.message || '')?.[1]) || null;
                const missing = status === 404 || status === 410;
                throw Object.assign(failure(missing ? 'SOURCE_MISSING' : 'SOURCE_FETCH_FAILED',
                    missing ? _uiT("共有原本が見つかりません。公開元で再公開してください。") : (cause?.message || _uiT("原本を取得できませんでした。")), cause), {status});
            }
            check(job);
            if (!blob || typeof blob.arrayBuffer !== 'function') throw failure('SOURCE_FETCH_FAILED', _uiT("原本の応答を読み取れませんでした。"));
            let collision = false;
            try {
                await storage.putBlob({id:handle.id, blob, mime:handle.mime || blob.type || 'application/octet-stream',
                    filename:handle.filename || handle.path.split('/').pop() || ''}, {lease:options.lease});
            } catch (cause) {
                check(job);
                // An explicit original operation can have stored this same ID
                // while our fetch was running. Never overwrite the first bytes.
                if (cause?.code === 'BLOB_ID_EXISTS') collision = true;
                else throw failure('SOURCE_STORAGE_FAILED', cause?.message || _uiT("原本を保存できませんでした。"), cause);
            }
            check(job);
            record = await read(handle.id);
            check(job);
            if (!hasBlob(record) || (!collision && record.blob.size !== blob.size)) {
                throw failure('SOURCE_STORAGE_VERIFY_FAILED', _uiT("原本を保存できませんでした。保存容量を確認してください。"));
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
    // Export-only resolver. Work on archive copies, never on the visible
    // project's references. In particular, normal Parquet viewing continues
    // to use HTTP Range; a ZIP explicitly needs every original byte. Remote
    // originals are held as Blobs only for this export, not written to IDB.
    function createArchiveReader(options = {}) {
        const sources = new Map(), byId = new Map(), records = new Map();
        const controller = new AbortController();
        let serial = 0, disposed = false;
        const check = signal => {
            if (disposed || signal?.aborted || !active(options.current)) throw cancelled();
        };
        function prepare(entry) {
            check();
            const source = options.resolveSource?.(entry) || {};
            const path = source.path || entry.storagePath || entry.path || '';
            const url = source.url || entry.sourceUrl || '';
            const key = path ? 'path:' + path : url ? 'url:' + url : entry.blobId ? 'id:' + entry.blobId : '';
            if (!key) return null;
            let handle = sources.get(key);
            if (!handle) {
                handle = {id:entry.blobId || options.createId?.() || 'archive-original-' + (++serial),
                    localId:entry.blobId || null, path, url,
                    mime:source.mime || entry.mime, filename:source.filename || entry.filename,
                    bytes:Number(entry.sourceBytes) || null};
                sources.set(key, handle);
            }
            if (!entry.blobId) entry.blobId = handle.id;
            byId.set(entry.blobId, handle);
            return handle;
        }
        async function ensure(entry, request = {}) {
            check(request.signal);
            const handle = byId.get(entry.blobId) || prepare(entry);
            if (!handle) return null;
            if (records.has(handle.id)) return records.get(handle.id);
            let record = handle.localId && options.storage?.getBlob
                ? await options.storage.getBlob(handle.localId) : null;
            check(request.signal);
            if (!hasBlob(record)) {
                if (!handle.url || !options.fetchBlob) return null;
                const abort = () => controller.abort();
                request.signal?.addEventListener('abort', abort, {once:true});
                try {
                    const blob = await waitWithSignal(options.fetchBlob(handle.url, {
                        signal:controller.signal, onProgress:request.onProgress
                    }), controller.signal);
                    check(request.signal);
                    if (!hasBlob({blob})) throw failure('SOURCE_FETCH_FAILED', _uiT("原本の応答を読み取れませんでした。"));
                    if (handle.bytes != null && blob.size !== handle.bytes)
                        throw failure('SOURCE_SIZE_MISMATCH', _uiT("原本のサイズが公開情報と一致しません。再公開を確認してください。"));
                    record = {id:handle.id,blob,mime:handle.mime || blob.type,filename:handle.filename};
                } finally { request.signal?.removeEventListener('abort', abort); }
            }
            check(request.signal);
            records.set(handle.id, record);
            return record;
        }
        function dispose() {
            disposed = true;controller.abort();records.clear();sources.clear();byId.clear();
        }
        return {prepare, ensure, dispose};
    }
    return {create, createArchiveReader};
});
