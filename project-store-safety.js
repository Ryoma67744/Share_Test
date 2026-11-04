/* Shared IndexedDB write boundary. No network and no scientific transformations. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProjectStoreSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const VERSION = 5;
    const referenceStores = ['projects', 'project_recovery', 'blob_pins', 'archive_jobs'];
    const clone = value => structuredClone(value);
    const revision = value => value == null ? 0 : Number.isSafeInteger(value) && value >= 0 ? value : null;
    const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const completion = tx => new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        tx.onerror = () => {}; // abort carries the final transaction result
    });
    function upgrade(db) {
        for (const name of ['projects', 'blobs', 'project_index', 'pq_index', 'project_recovery', 'blob_pins', 'archive_jobs']) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, {keyPath: 'id'});
        }
    }
    function collectBlobIds(project) {
        const ids = new Set();
        for (const section of (project && project.sections) || []) {
            for (const field of ['images', 'msiSeries', 'msiFiles']) {
                for (const entry of Object.values(section[field] || {})) if (entry && entry.blobId) ids.add(entry.blobId);
            }
        }
        for (const item of (project && project.meta && project.meta.roiMedia && project.meta.roiMedia.items) || []) {
            if (item && item.blobId) ids.add(item.blobId);
        }
        return ids;
    }
    function detach(project) {
        delete project.storageRevision;
        delete project.shareInfo; delete project.__share; delete project.__publishPending; delete project.publishEditEpoch;
        if (project.meta) {
            for (const k of ['shareInfo', '__share', '__publishPending', 'viewerPassword', 'adminPassword', 'masterPassword']) delete project.meta[k];
        }
        return project;
    }
    function conflict(message, details) {
        return Object.assign(new Error(message), {name: 'ProjectConflictError', code: 'LOCAL_PROJECT_CONFLICT'}, details);
    }
    function create(options) {
        const transaction = options.transaction;
        const uid = options.uid || (prefix => prefix + '_' + globalThis.crypto.randomUUID());
        const now = options.nowIso || (() => new Date().toISOString());
        const writerId = uid('writer');
        const sessionId = 'edit:' + writerId;
        // Explicit null models an environment without Web Locks, including in
        // test runtimes that now provide their own native navigator.locks.
        const locks = options.locks === null ? null : options.locks || (typeof navigator !== 'undefined' && navigator.locks);
        const blobLeases = new Map();
        const leaseError = () => Object.assign(new Error('この読み込みの原本保持は終了したか、別のタブが所有しています。'), {code:'BLOB_LEASE_OWNER'});
        function ownedLease(handle, allowClosed = false) {
            const state = handle && blobLeases.get(handle.id);
            if (!state || state.handle !== handle || (!allowClosed && (state.closed || state.closing))) throw leaseError();
            return state;
        }
        async function leaseRow(tx, handle) {
            const row = await request(tx.objectStore('blob_pins').get(handle.id));
            if (!row || row.kind !== 'blob-lease' || row.ownerId !== writerId) throw leaseError();
            return row;
        }
        function closeLease(state) {
            state.closed = true; state.closing = false;
            if (state.unlock) state.unlock();
        }
        async function beginBlobLease(settings = {}) {
            if (!['cloud-import','share-view'].includes(settings.kind)) throw new Error('Unknown blob lease kind');
            const handle = Object.freeze({id:'load:'+uid('lease')});
            const state = {handle,closed:false,closing:false,unlock:null};
            // Acquire the lifetime lock BEFORE publishing a durable lease row.
            // No unload/pagehide handler releases it: a BFCache page may return.
            if (locks) await new Promise((resolve,reject) => {
                const held = new Promise(release => {state.unlock=release;});
                locks.request('desi-blob-lease:'+handle.id, async () => {resolve();await held;}).catch(reject);
            });
            blobLeases.set(handle.id,state);
            try {
                await run(['blob_pins'],'readwrite',tx=>request(tx.objectStore('blob_pins').add({
                    id:handle.id,kind:'blob-lease',purpose:settings.kind,ownerId:writerId,
                    liveness:locks?'web-lock':'unknown',projectId:settings.projectId||null,blobIds:[],ownedBlobIds:[],updatedAt:now()
                })));
            } catch(error) {closeLease(state);throw error;}
            return handle;
        }
        async function pinBlobLease(handle, ids) {
            ownedLease(handle);
            return run(['blob_pins','blobs'],'readwrite',async tx=>{
                const row=await leaseRow(tx,handle), pinned=new Set(row.blobIds);
                for(const id of ids) {
                    if(!await request(tx.objectStore('blobs').get(id))) throw new Error('原本がありません: '+id);
                    pinned.add(id);
                }
                row.blobIds=[...pinned];await request(tx.objectStore('blob_pins').put(row));
            });
        }
        async function removeLeaseRow(tx, row, discard) {
            await request(tx.objectStore('blob_pins').delete(row.id));
            if(discard) {
                const used=await usedBlobs(tx);
                // Only bytes created by this load may be reclaimed here.
                for(const id of row.ownedBlobIds||[]) if(!used.has(id)) await request(tx.objectStore('blobs').delete(id));
            }
        }
        async function finishBlobLease(handle, settings = {}) {
            const state=ownedLease(handle,true);
            if(state.closed)return false;
            if(state.closing)throw leaseError();
            if(settings.project) {
                if(settings.createOnly!==true)throw new Error('A cloud import must create a separate project');
                return putProject(settings.project,{createOnly:true,blobLease:handle});
            }
            state.closing=true;
            try {
                await run([...referenceStores,'blobs'],'readwrite',async tx=>{
                    await removeLeaseRow(tx,await leaseRow(tx,handle),settings.discard!==false);
                });
                closeLease(state);return true;
            } catch(error) {state.closing=false;throw error;}
        }
        async function reclaimInactiveBlobLeases() {
            if(!locks)return 0; // Unknown liveness is retained; there is no TTL.
            const rows=await run(['blob_pins'],'readonly',tx=>request(tx.objectStore('blob_pins').getAll()));
            let reclaimed=0;
            for(const row of rows) {
                if(row.kind!=='blob-lease'||row.liveness!=='web-lock')continue;
                await locks.request('desi-blob-lease:'+row.id,{ifAvailable:true},async lock=>{
                    if(!lock)return;
                    // Hold the liveness lock through the deletion transaction.
                    await run([...referenceStores,'blobs'],'readwrite',async tx=>{
                        const current=await request(tx.objectStore('blob_pins').get(row.id));
                        if(!current||current.kind!=='blob-lease'||current.liveness!=='web-lock'||current.ownerId!==row.ownerId)return;
                        await removeLeaseRow(tx,current,true);reclaimed++;
                    });
                });
            }
            return reclaimed;
        }
        let activeProjectId = null, sessionLock = null, unlockSession = null;
        async function ensureSessionLock() {
            if (!locks || sessionLock) return sessionLock;
            sessionLock = new Promise((resolve, reject) => {
                const held = new Promise(release => { unlockSession = release; });
                locks.request('desi-project-edit:' + sessionId, async () => { resolve(); await held; }).catch(reject);
            });
            return sessionLock;
        }
        async function sessionInactive(id) {
            if (!locks || id === sessionId) return false;
            return locks.request('desi-project-edit:' + id, {ifAvailable:true}, lock => !!lock);
        }
        async function writeSession(tx, project, extraIds = []) {
            if (!project) return;
            const pins = tx.objectStore('blob_pins');
            const previous = await request(pins.get(sessionId));
            const ids = new Set([...collectBlobIds(project), ...extraIds]);
            // Retain new originals written before their project definitions are saved.
            if (previous && previous.projectId === project.id) for (const id of previous.blobIds || []) ids.add(id);
            await request(pins.put({id:sessionId,kind:'editing-session',projectId:project.id,
                project:clone(project),blobIds:[...ids],updatedAt:now()}));
        }
        async function run(names, mode, work) {
            const tx = await transaction(names, mode);
            const done = completion(tx);
            try { const value = await work(tx); await done; return value; }
            catch (error) { try { tx.abort(); } catch (_) {} await done.catch(() => {}); throw error; }
        }
        const saveRecord = async (tx, record) => {
            await request(tx.objectStore('projects').put(record));
            await request(tx.objectStore('project_index').put(options.indexRowFor(record)));
        };
        async function getProject(id, settings = {}) {
            if (!id) return null;
            if (settings.activate) await ensureSessionLock();
            const project = await run(settings.activate ? ['projects','blob_pins'] : ['projects'], settings.activate ? 'readwrite' : 'readonly', async tx => {
                const project = await request(tx.objectStore('projects').get(id));
                if (!project) return null;
                // Legacy revision zero is a read token, never a backfill write.
                if (project.storageRevision == null) project.storageRevision = 0;
                if (settings.activate) await writeSession(tx, project);
                return project;
            });
            if (settings.activate) activeProjectId = project ? project.id : null;
            return project;
        }
        async function releaseProject() {
            activeProjectId = null;
            await run(['blob_pins'], 'readwrite', tx => request(tx.objectStore('blob_pins').delete(sessionId)));
            if (unlockSession) unlockSession(); sessionLock = null; unlockSession = null;
        }
        async function putProject(project, settings = {}) {
            if (!project || !project.id || project.__summary) throw new Error('putProject requires a complete project record');
            const record = clone(project); // Freeze BEFORE any await.
            if (options.prepare) options.prepare(record);
            if (Array.isArray(record.rois)) record.rois = record.rois.filter(r => !(r && r._collab));
            const expected = Object.prototype.hasOwnProperty.call(settings, 'expectedRevision')
                ? settings.expectedRevision : project.storageRevision;
            const load = settings.blobLease && ownedLease(settings.blobLease);
            if(load && !settings.createOnly)throw new Error('A cloud import must create a separate project');
            if(load)load.closing=true;
            let failure = null;
            let committed;
            try { committed = await run(load ? [...referenceStores,'project_index','blobs'] : ['projects', 'project_index', 'project_recovery', 'blob_pins'], 'readwrite', async tx => {
                const projects = tx.objectStore('projects');
                const lease = load && await leaseRow(tx,settings.blobLease);
                if(lease)for(const id of collectBlobIds(record))if(!await request(tx.objectStore('blobs').get(id)))throw new Error('取り込み原本がありません: '+id);
                if (activeProjectId === record.id) await writeSession(tx, record);
                if (settings.createOnly) {
                    while (await request(projects.get(record.id))) record.id = uid('proj');
                    record.storageRevision = 1; record.updatedAt = now();
                    await request(projects.add(record));
                    await request(tx.objectStore('project_index').put(options.indexRowFor(record)));
                    if(lease)await removeLeaseRow(tx,lease,true);
                    return record;
                }
                const current = await request(projects.get(record.id));
                const actualRevision = current ? revision(current.storageRevision) : null;
                if (!current || expected == null || revision(expected) == null || actualRevision !== expected) {
                    const recoveryId = 'recovery:' + writerId + ':' + record.id;
                    const previous = await request(tx.objectStore('project_recovery').get(recoveryId));
                    await request(tx.objectStore('project_recovery').put({id: recoveryId, projectId: record.id,
                        project: record, expectedRevision: expected ?? null, actualRevision,
                        createdAt: previous ? previous.createdAt : now(), updatedAt: now()}));
                    failure = conflict('別のタブで更新または削除されています。今回の編集は回復用下書きに保存しました。',
                        {projectId: record.id, recoveryId, expectedRevision: expected ?? null, actualRevision, recovered: true});
                    return null; // Commit the recovery without touching the authoritative project.
                }
                record.storageRevision = actualRevision + 1; record.updatedAt = now();
                await saveRecord(tx, record);
                return record;
            }); } catch(error) {if(load)load.closing=false;throw error;}
            if(load)closeLease(load);
            if (failure) { if (options.onConflict) { try { options.onConflict(failure); } catch (_) {} } throw failure; }
            // Never advance the caller's token before durable commit.
            project.id = committed.id; project.storageRevision = committed.storageRevision;
            return committed;
        }
        async function patchProject(id, mutate, settings = {}) {
            return run(['projects', 'project_index'], 'readwrite', async tx => {
                const current = await request(tx.objectStore('projects').get(id));
                if (!current) return {applied: false, project: null, reason: 'deleted'};
                const previousStorageRevision = revision(current.storageRevision);
                if (previousStorageRevision == null || (settings.expectedRevision != null && settings.expectedRevision !== previousStorageRevision)) {
                    throw conflict('別のタブで更新されています。最新の内容を確認してください。', {projectId: id, actualRevision: previousStorageRevision});
                }
                const apply = mutate(current);
                if (apply && typeof apply.then === 'function') throw new Error('patchProject mutator must be synchronous');
                if (apply === false) return {applied: false, project: current, previousStorageRevision, storageRevision: previousStorageRevision};
                if (current.id !== id) throw new Error('patchProject cannot change project identity');
                current.storageRevision = previousStorageRevision + 1; current.updatedAt = now();
                await saveRecord(tx, current);
                return {applied: true, project: current, previousStorageRevision, storageRevision: current.storageRevision};
            });
        }
        async function recordPublishReceipt(id, receipt) {
            const nextRevision = receipt.serverRevision;
            const baseRevision = receipt.baseServerRevision;
            if (!receipt.slug || !Number.isSafeInteger(baseRevision) || baseRevision < 0
                || !Number.isSafeInteger(nextRevision) || nextRevision !== baseRevision + 1
                || !Number.isSafeInteger(receipt.publishedEditEpoch) || receipt.publishedEditEpoch < 0) throw new Error('Invalid publish receipt');
            return patchProject(id, project => {
                const share = project.shareInfo || {};
                const targetChanged = (share.slug || null) !== receipt.slug;
                if (targetChanged) {
                    const intent = share.pendingPublish;
                    if (!intent || intent.jobId !== receipt.jobId || intent.slug !== receipt.slug
                        || intent.previousSlug !== (share.slug || null) || intent.create !== true
                        || intent.baseServerRevision !== 0 || baseRevision !== 0) return false;
                }
                const previous = share.serverRevision;
                if (!targetChanged && Number.isSafeInteger(previous) && previous >= nextRevision) return false;
                project.shareInfo = targetChanged ? {} : Object.assign({}, share);
                for (const key of ['slug', 'serverRevision', 'url', 'isPublic', 'uploadedPaths', 'jobId', 'viewerPassword', 'adminPassword', 'blobPaths']) {
                    if (receipt[key] !== undefined) project.shareInfo[key] = clone(receipt[key]);
                }
                if (share.pendingPublish && share.pendingPublish.jobId === receipt.jobId) delete project.shareInfo.pendingPublish;
                if (receipt.publishedAt) project.shareInfo.lastSyncedAt = receipt.publishedAt;
                if (!project.shareInfo.publishedAt && receipt.publishedAt) project.shareInfo.publishedAt = receipt.publishedAt;
                if ((project.publishEditEpoch || 0) === receipt.publishedEditEpoch) delete project.__publishPending;
                else project.__publishPending = true;
            });
        }
        async function listRecoveries() {
            const result = await run(['project_recovery','blob_pins'], 'readonly', async tx => ({
                drafts:await request(tx.objectStore('project_recovery').getAll()),
                sessions:await request(tx.objectStore('blob_pins').getAll())
            }));
            const rows = result.drafts;
            for (const row of result.sessions) if (row.kind === 'editing-session' && row.project && await sessionInactive(row.id)) rows.push(row);
            return rows.map(row => ({id:row.id,projectId:row.projectId,kind:row.kind || 'conflict',
                displayName:row.project.displayName || row.projectId,updatedAt:row.updatedAt,
                expectedRevision:row.expectedRevision,actualRevision:row.actualRevision}));
        }
        async function restoreRecovery(id) {
            const session = id.startsWith('edit:');
            if (session && !await sessionInactive(id)) throw new Error('この保持データは別のタブで使用中です');
            return run(['project_recovery', 'projects', 'project_index','blob_pins'], 'readwrite', async tx => {
                const recoveryStore = tx.objectStore(session ? 'blob_pins' : 'project_recovery');
                const recovery = await request(recoveryStore.get(id));
                if (!recovery) return null;
                const project = detach(clone(recovery.project));
                do { project.id = uid('proj'); } while (await request(tx.objectStore('projects').get(project.id)));
                project.displayName = (project.displayName || 'Project') + ' (recovered)';
                project.storageRevision = 1; project.createdAt = now(); project.updatedAt = now();
                await request(tx.objectStore('projects').add(project));
                await request(tx.objectStore('project_index').put(options.indexRowFor(project)));
                await request(recoveryStore.delete(id));
                return project;
            });
        }
        async function discardRecovery(id) {
            const session = id.startsWith('edit:');
            if (session && !await sessionInactive(id)) throw new Error('この保持データは別のタブで使用中です');
            return run([...referenceStores,'blobs'], 'readwrite', async tx => {
                const store=tx.objectStore(session ? 'blob_pins':'project_recovery');
                const row=await request(store.get(id));if(!row)return false;
                const candidates=session ? row.blobIds || [] : collectBlobIds(row.project);
                await request(store.delete(id));const used=await usedBlobs(tx);
                for(const blobId of candidates)if(!used.has(blobId))await request(tx.objectStore('blobs').delete(blobId));
                return true;
            });
        }
        async function usedBlobs(tx) {
            const used = new Set();
            for (const name of referenceStores) {
                for (const row of await request(tx.objectStore(name).getAll())) {
                    const ids = name === 'projects' ? collectBlobIds(row) : name === 'project_recovery' ? collectBlobIds(row.project)
                        : name === 'blob_pins' ? row.blobIds || [] : row.ownedBlobIds || [];
                    for (const id of ids) used.add(id);
                }
            }
            return used;
        }
        async function putBlob(record, settings = {}) {
            if (!record || !record.id || !record.blob) throw new Error('putBlob requires an original blob and ID');
            record = {...record}; // Freeze identity/metadata before the transaction await; Blob bytes are immutable.
            if(settings.lease)ownedLease(settings.lease);
            return run(['blobs','blob_pins'], 'readwrite', async tx => {
                if (settings.lease) {
                    const row=await leaseRow(tx,settings.lease);
                    row.blobIds=[...new Set([...row.blobIds,record.id])];
                    row.ownedBlobIds=[...new Set([...row.ownedBlobIds,record.id])];
                    await request(tx.objectStore('blob_pins').put(row));
                } else if (activeProjectId) {
                    const pins = await request(tx.objectStore('blob_pins').getAll());
                    const pin = pins.find(row => row.id === sessionId);
                    const jobOwned = pins.some(row => row.id !== sessionId && (row.blobIds || []).includes(record.id));
                    if (!jobOwned && pin && pin.project) await writeSession(tx, pin.project, [record.id]);
                }
                // Blob IDs are immutable original identities, including for cloud path reuse.
                const blobs = tx.objectStore('blobs');
                if (await request(blobs.get(record.id))) throw Object.assign(new Error('Blob ID already exists; use a new ID for a different original'), {code:'BLOB_ID_EXISTS'});
                await request(blobs.add(record)); return record.id;
            });
        }
        async function renameBlob(id, filename) {
            return run(['blobs'], 'readwrite', async tx => {
                const blobs = tx.objectStore('blobs'), record = await request(blobs.get(id));
                if (!record) return false;
                record.filename = String(filename); await request(blobs.put(record)); return true;
            });
        }
        async function deleteBlob(id, settings = {}) {
            if (!id) return false;
            return run([...referenceStores, 'blobs'], 'readwrite', async tx => {
                if (settings.ownerId !== undefined) {
                    const original = await request(tx.objectStore('blobs').get(id));
                    if (!original || original.archiveOwnerId !== settings.ownerId) return false;
                }
                if ((await usedBlobs(tx)).has(id)) return false;
                await request(tx.objectStore('blobs').delete(id)); return true;
            });
        }
        async function deleteProject(id, settings = {}) {
            return run([...referenceStores, 'project_index', 'blobs'], 'readwrite', async tx => {
                const project = await request(tx.objectStore('projects').get(id));
                if (!project) return false;
                if (settings.expectedRevision != null && revision(project.storageRevision) !== settings.expectedRevision) {
                    throw conflict('別のタブで更新されています。削除前に最新の内容を確認してください。', {projectId: id});
                }
                const owned = collectBlobIds(project);
                await request(tx.objectStore('projects').delete(id));
                await request(tx.objectStore('project_index').delete(id));
                const used = await usedBlobs(tx);
                for (const blobId of owned) if (!used.has(blobId)) await request(tx.objectStore('blobs').delete(blobId));
                return true;
            });
        }
        async function pruneShareOrphans() {
            // An unleased blob may belong to a live older tab or unfinished
            // legacy import. Absence from project records does not prove death.
            return reclaimInactiveBlobLeases();
        }
        async function pinBlobs(id, blobIds, meta = {}) {
            return run(['blob_pins'], 'readwrite', async tx => {
                const previous = await request(tx.objectStore('blob_pins').get(id));
                if(previous && previous.kind==='blob-lease')throw leaseError();
                const ids = [...new Set([...(previous && previous.blobIds || []), ...blobIds])];
                await request(tx.objectStore('blob_pins').put({id, blobIds: ids, projectId: meta.projectId || null,
                    kind: meta.kind || 'job', updatedAt: now()}));
            });
        }
        const releaseBlobPins = id => run(['blob_pins'], 'readwrite', async tx => {
            const row=await request(tx.objectStore('blob_pins').get(id));
            if(row && row.kind==='blob-lease')throw leaseError();
            await request(tx.objectStore('blob_pins').delete(id));
        });
        const putArchiveJob = job => run(['archive_jobs'], 'readwrite', tx => request(tx.objectStore('archive_jobs').put(clone(job))));
        const getArchiveJobs = () => run(['archive_jobs'], 'readonly', tx => request(tx.objectStore('archive_jobs').getAll()));
        const deleteArchiveJob = id => run(['archive_jobs'], 'readwrite', tx => request(tx.objectStore('archive_jobs').delete(id)));
        return {getProject, releaseProject, putProject, patchProject, recordPublishReceipt, listRecoveries, restoreRecovery, discardRecovery,
            deleteProject, putBlob, renameBlob, deleteBlob, pruneShareOrphans, pinBlobs, releaseBlobPins, putArchiveJob, getArchiveJobs, deleteArchiveJob,
            beginBlobLease,pinBlobLease,finishBlobLease,reclaimInactiveBlobLeases};
    }
    // Accessible, persistent recovery entry point shared by both pages.
    function mountRecoveryUi(storage, options = {}) {
        if (typeof document === 'undefined') return;
        let button = document.getElementById('local-recovery-button');
        if (!button) {
            button = document.createElement('button'); button.id = 'local-recovery-button'; button.type = 'button';
            button.textContent = '回復用下書き'; button.hidden = true;
            button.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:99990;padding:9px 14px;background:#fff7ed;border:2px solid #c2410c;border-radius:6px;color:#7c2d12';
            document.body.appendChild(button);
        }
        const refresh = async () => { try { const rows = await storage.listRecoveries(); button.hidden = !rows.length; button.textContent = '回復用下書き (' + rows.length + ')'; } catch (_) {} };
        button.onclick = async () => {
            if (document.getElementById('local-recovery-dialog')) return;
            const rows = await storage.listRecoveries();
            const dialog = document.createElement('dialog'); dialog.id = 'local-recovery-dialog';
            dialog.setAttribute('aria-label', '保存競合の回復'); dialog.style.cssText = 'max-width:620px;padding:24px;border-radius:8px';
            const title = document.createElement('h2'); title.textContent = '保存競合の回復'; dialog.appendChild(title);
            const text = document.createElement('p'); text.textContent = '別のタブの保存は変更していません。下書きを共有先のない別プロジェクトとして復元できます。'; dialog.appendChild(text);
            for (const row of rows) {
                const item = document.createElement('p'), label = document.createElement('span'), restore = document.createElement('button');
                label.textContent = row.displayName + ' — ' + row.updatedAt + (row.kind === 'editing-session' ? ' (終了したタブの保持データ) ' : ' ');
                restore.type = 'button'; restore.textContent = '別コピーとして復元';
                restore.onclick = async () => {
                    restore.disabled = true;
                    try { const project = await storage.restoreRecovery(row.id); if (project) {
                        restore.remove(); discard.remove();
                        label.textContent = project.displayName + ' — 復元しました。 ';
                        if (options.projectUrl) {
                            const link=document.createElement('a');link.textContent='別タブで開く';link.href=options.projectUrl(project.id);link.target='_blank';link.rel='noopener';item.appendChild(link);
                        }
                        await refresh(); if (options.onRestored) await options.onRestored(project);
                    } } catch (error) { restore.disabled = false; label.textContent = String(error.message || error); }
                };
                const discard = document.createElement('button'); discard.type='button'; discard.textContent='下書き・保持を破棄';
                discard.onclick = async () => {
                    if (!confirm('この下書き・保持データを破棄しますか? 他のプロジェクトや処理が参照しない原本だけが削除されます。')) return;
                    try { await storage.discardRecovery(row.id); item.remove(); await refresh(); }
                    catch (error) { label.textContent=String(error.message || error); }
                };
                item.append(label, restore, discard); dialog.appendChild(item);
            }
            const close = document.createElement('button'); close.type = 'button'; close.textContent = '閉じる'; close.onclick = () => dialog.close();
            dialog.appendChild(close); dialog.addEventListener('close', () => { dialog.remove(); button.focus(); });
            document.body.appendChild(dialog); dialog.showModal(); close.focus();
        };
        refresh();
        return {refresh, notify: () => { refresh(); button.hidden = false; }};
    }
    return {VERSION, upgrade, create, collectBlobIds, mountRecoveryUi};
});
