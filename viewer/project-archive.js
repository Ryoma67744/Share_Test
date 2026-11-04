/* ZIP compatibility and provenance. All conversions operate on copies. */
(function(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.ProjectArchive = api;
})(typeof globalThis === 'object' ? globalThis : this, function(root) {
    'use strict';
    const bases = new Set(['registered-source', 'legacy-v1-file', 'legacy-v2-file', 'legacy-derived-csv', 'unknown']);
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const activeJobs = new Set();
    const identifier = value => typeof value === 'string' && value.length > 0
        && !['__proto__', 'constructor', 'prototype'].includes(value);
    function cancelled(signal) {
        if (signal && signal.aborted) { const e = new Error('ZIP 処理を中止しました / ZIP operation cancelled'); e.name = 'AbortError'; throw e; }
    }
    function provenance(value, fallback = 'unknown') {
        const p = value && value.version === 1 && bases.has(value.basis) ? value : {basis: fallback};
        return {version: 1, basis: p.basis, background: ['drop', 'flag'].includes(p.background) ? p.background : null,
            variant: p.variant === true, originalStates: p.originalStates === 'preserved' ? 'preserved' : 'unknown'};
    }
    const registeredSource = () => provenance({version: 1, basis: 'registered-source', originalStates: 'preserved'});
    function qualityLabel(value) {
        const p = provenance(value);
        if (p.basis === 'registered-source') return '';
        if (p.basis === 'legacy-derived-csv') return p.background === 'drop'
            ? 'Legacy CSV; background removal selected; reference statistics'
            : p.background === 'flag' ? 'Legacy CSV with background flags; reference statistics'
                : 'Legacy CSV; original missing states unknown; reference statistics';
        if (p.basis === 'legacy-v1-file' || p.basis === 'legacy-v2-file')
            return 'Legacy archived file; original-file provenance unverified';
        return 'Source provenance unverified';
    }
    function path(value) {
        if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
            || value.split('/').some(x => !x || x === '.' || x === '..') || /^[a-z]+:/i.test(value))
            throw new Error('ZIP の参照パスが不正です / Invalid ZIP path: ' + value);
        return value;
    }
    function object(value, label) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ZIP ' + label);
        return value;
    }
    function entries(value, label) {
        const out = Object.entries(value || {});
        for (const [key, item] of out) { if (!identifier(key)) throw new Error('Invalid ZIP identifier: ' + key); object(item, label); }
        return out;
    }
    async function bytes(file) {
        const value = await file.async('uint8array');
        if (typeof value === 'string') return new TextEncoder().encode(value);
        if (value && typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
        return value instanceof Uint8Array ? value : new Uint8Array(value);
    }
    async function sameFile(zip, a, b, signal) {
        if (a === b) return true;
        // Only initial-v1 copies require byte comparison. Do not merge by filename/fid.
        const av = await bytes(zip.file(a)), bv = await bytes(zip.file(b));
        if (av.length !== bv.length) return false;
        for (let i = 0; i < av.length; i++) {
            if (i % 1048576 === 0) { cancelled(signal); await new Promise(resolve => setTimeout(resolve, 0)); }
            if (av[i] !== bv[i]) return false;
        }
        return true;
    }
    async function prepareImport(zip, originalDoc, options = {}) {
        const doc = clone(object(originalDoc, 'manifest')), overrides = new Map(), required = new Set();
        const sectionIds = new Set(), counts = {registered: 0, legacyFiles: 0, legacyCsv: 0, unknown: 0, variants: 0};
        function requireFile(value, label) {
            const p = path(value);
            if (!zip.file(p)) throw new Error('ZIPに原本がありません / ZIP original missing: ' + p + ' (' + label + ')');
            required.add(p); return p;
        }
        function addSection(id) {
            if (!identifier(id) || sectionIds.has(id)) throw new Error('ZIP の切片 ID が重複または不正です / Invalid section ID: ' + id);
            sectionIds.add(id);
        }
        function record(entry, fallback, background) {
            const p = provenance(entry.archiveProvenance, fallback);
            if (!entry.archiveProvenance && background) p.background = background;
            entry.archiveProvenance = p;
            counts[p.basis === 'registered-source' ? 'registered' : p.basis === 'legacy-derived-csv' ? 'legacyCsv'
                : p.basis === 'unknown' ? 'unknown' : 'legacyFiles']++;
        }
        if (doc.format === 'desi_data_share_v1') {
            const atlasPaths = Object.keys(zip.files).filter(p => /^sections\/[^/]+\/atlas\.json$/.test(p));
            if (!atlasPaths.length) throw new Error('ZIP に切片がありません / No sections in ZIP');
            for (const ap of atlasPaths) {
                cancelled(options.signal);
                const atlas = object(JSON.parse(await zip.file(ap).async('string')), 'atlas');
                addSection(atlas.id);
                const dir = ap.slice(0, -'atlas.json'.length), files = Object.fromEntries(entries(atlas.msiFiles, 'source'));
                const series = entries(atlas.msiSeries, 'MSI'), groups = new Map();
                for (const [key, image] of entries(atlas.images, 'image')) requireFile(dir + path(image.path), key);
                for (const [key, entry] of series) {
                    const full = requireFile(dir + path(entry.path), key);
                    const fid = entry.sourceFileId || ('legacy-source-' + groups.size);
                    if (!identifier(fid)) throw new Error('Invalid source ID');
                    if (!groups.has(fid)) groups.set(fid, []);
                    const variants = groups.get(fid);
                    let variant = null;
                    for (const candidate of variants) if (await sameFile(zip, candidate.full, full, options.signal)) { variant = candidate; break; }
                    if (!variant) { variant = {full, path: entry.path, entries: [], representative: entry}; variants.push(variant); }
                    variant.entries.push(entry);
                    record(entry, 'legacy-v1-file');
                }
                const normalizedFiles = {};
                for (const [fid, variants] of groups) {
                    for (let i = 0; i < variants.length; i++) {
                        const variant = variants[i];
                        let newId = fid;
                        if (variants.length > 1) {
                            newId = fid + '__archive_variant_' + (i + 1);
                            while (groups.has(newId) || normalizedFiles[newId]) newId += '_';
                            counts.variants++;
                        }
                        normalizedFiles[newId] = {...clone(files[fid] || {}), id: newId, path: variant.path,
                            filename: (files[fid] || {}).filename || variant.representative.filename || newId,
                            kind: (files[fid] || {}).kind || variant.representative.kind};
                        delete normalizedFiles[newId].blobId;
                        delete normalizedFiles[newId].sourceUrl;
                        for (const entry of variant.entries) {
                            entry.sourceFileId = newId; entry.path = variant.path;
                            delete entry.blobId; delete entry.sourceUrl;
                            if (variants.length > 1) {
                                entry.archiveProvenance.variant = true;
                                // Preserve each file, never pretend that a legacy per-source transform
                                // or source-specific ROI was verified for a newly separated variant.
                                entry.archiveGeometryUnconfirmed = true;
                                entry.sourceReference = JSON.stringify([newId, entry.kind || '', entry.sheet || '', entry.func || 1, entry.annotation || '', 'archive-variant']);
                            }
                        }
                    }
                }
                // File-level records with no layers still own a source if the archive names one.
                for (const [fid, rec] of Object.entries(files)) if (!groups.has(fid)) {
                    if (!rec.path) throw new Error('ZIP source has no layer or original path: ' + fid);
                    requireFile(dir + path(rec.path), fid); normalizedFiles[fid] = rec;
                }
                atlas.msiFiles = normalizedFiles;
                overrides.set(ap, JSON.stringify(atlas));
            }
        } else if (doc.format === 'desi_data_share_v2') {
            if (!Array.isArray(doc.sections)) throw new Error('Invalid ZIP sections');
            for (const section of doc.sections) {
                cancelled(options.signal); addSection(section.id);
                for (const [key, image] of entries(section.images, 'image')) requireFile(image.fullPath, key);
                const originals = Object.fromEntries(entries(section.originalSeries, 'original'));
                const raw = Object.fromEntries(entries(section.rawSeries, 'RAW')), pq = Object.fromEntries(entries(section.parquetSeries, 'Parquet'));
                const fileMeta = Object.fromEntries(entries(section.msiFilesMeta, 'source'));
                for (const [fid, rec] of Object.entries(fileMeta)) if (rec.sourcePath) requireFile(rec.sourcePath, fid);
                for (const [key, entry] of Object.entries(originals)) {
                    requireFile(entry.sourcePath, key); record(entry, 'unknown');
                    if (entry.sourceFileId) {
                        if (!identifier(entry.sourceFileId)) throw new Error('Invalid ZIP source ID');
                        const rec = fileMeta[entry.sourceFileId];
                        if (rec && rec.sourcePath && rec.sourcePath !== entry.sourcePath
                            && !await sameFile(zip, rec.sourcePath, entry.sourcePath, options.signal))
                            throw new Error('ZIP source definition conflicts with its original: ' + key);
                        if (!rec || !rec.sourcePath) fileMeta[entry.sourceFileId] = {...rec,
                            kind: entry.kind, filename: entry.filename, sourcePath: entry.sourcePath};
                    }
                }
                section.msiFilesMeta = fileMeta;
                for (const [key, entry] of [...Object.entries(raw), ...Object.entries(pq)]) {
                    if (originals[key]) continue;
                    const source = fileMeta[entry.sourceFileId];
                    if (!source || !source.sourcePath) throw new Error('ZIPに RAW/Parquet 原本がありません / ZIP source missing: ' + key);
                    requireFile(source.sourcePath, key); record(entry, 'legacy-v2-file');
                }
                const csvKeys = new Set();
                for (const group of section.data || []) {
                    requireFile(group.path, 'CSV');
                    if (group.sourceMetadataPath) requireFile(group.sourceMetadataPath, 'CSV cell metadata');
                    for (const cmp of group.compounds || []) {
                        if (!identifier(cmp.layerKey) || typeof cmp.vHeader !== 'string') throw new Error('Invalid ZIP CSV column');
                        if (csvKeys.has(cmp.layerKey)) throw new Error('Duplicate ZIP CSV layer: ' + cmp.layerKey);
                        csvKeys.add(cmp.layerKey);
                        if (!originals[cmp.layerKey] && !raw[cmp.layerKey] && !pq[cmp.layerKey]) {
                            const previous = provenance(cmp.archiveProvenance);
                            // A provenance marker on a CSV column describes its INPUT source.
                            // Without that source file, restoration uses a derived CSV instead.
                            cmp.archiveProvenance = provenance({version: 1, basis: 'legacy-derived-csv',
                                background: previous.background || group.bgRemoved || doc.bgRemoved,
                                variant: previous.variant});
                            record(cmp, 'legacy-derived-csv', group.bgRemoved || doc.bgRemoved);
                        }
                    }
                }
            }
        } else throw new Error('Unsupported ZIP format');
        if (Array.isArray(doc.sectionOrder) && (new Set(doc.sectionOrder).size !== doc.sectionOrder.length
            || doc.sectionOrder.some(id => !sectionIds.has(id)))) throw new Error('ZIP sectionOrder contains unknown or duplicate sections');
        for (const roi of doc.rois || []) for (const id of new Set([...Object.keys(roi.polysBySection || {}), ...Object.keys(roi.geometryBySection || {})]))
            if (!sectionIds.has(id)) throw new Error('ZIP ROI references an unknown section: ' + id);
        const media = doc.roiMedia || (doc.meta && doc.meta.roiMedia);
        if (media) {
            if (media.version !== 1 || !Array.isArray(media.items)) throw new Error('Unsupported ZIP ROI media');
            for (const item of media.items) {
                if (!sectionIds.has(item.sectionId)) throw new Error('ZIP ROI photo references an unknown section');
                if (!item.sourcePath || !zip.file(item.sourcePath)) throw new Error('ZIPにROI写真の原本がありません / ZIP ROI original missing: ' + (item.filename || item.id));
                requireFile(item.sourcePath, 'ROI photo');
            }
        }
        const view = {files: zip.files, file(p) { return overrides.has(p) ? {async: async () => overrides.get(p)} : zip.file(p); }};
        return {zip: view, doc, counts, requiredPaths: [...required]};
    }
    function summary(counts) {
        return 'ZIP: 原本登録 ' + counts.registered + ' / 旧保存ファイル ' + counts.legacyFiles
            + ' / 旧CSV参考値 ' + counts.legacyCsv + ' / 来歴未確認 ' + counts.unknown
            + (counts.variants ? ' / 別保存版 ' + counts.variants : '')
            + '\nLegacy CSV values are preserved without correction; original missing states cannot be recovered.';
    }
    function id() { return 'archive-' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)); }
    function locks() { return root.navigator && root.navigator.locks; }
    async function locked(jobId, callback, available) {
        if (locks()) return locks().request('desi-archive-job:' + jobId, {mode: 'exclusive', ...(available ? {ifAvailable: true} : {})}, lock => lock ? callback() : null);
        if (available && activeJobs.has(jobId)) return null;
        return callback();
    }
    async function cleanup(storage, job) {
        const cleanupBlobIds = [...new Set([...(job.cleanupBlobIds || []), ...(job.ownedBlobIds || [])])];
        await storage.putArchiveJob({...job, state: 'cleanup', ownedBlobIds: [], cleanupBlobIds, updatedAt: Date.now()});
        await storage.releaseBlobPins(job.id);
        for (const blobId of cleanupBlobIds) await storage.deleteBlob(blobId, {ownerId: job.id}); // atomic owner + project/recovery guards
        await storage.deleteArchiveJob(job.id);
    }
    async function recoverImports(storage) {
        if (!storage.getArchiveJobs) return;
        for (const job of await storage.getArchiveJobs()) {
            if (!job || !/^zip-(import|export)$/.test(job.kind) || activeJobs.has(job.id)) continue;
            // Without cross-tab Web Locks, retain uncertain live work instead of reclaiming it.
            if (!locks() && job.state !== 'cleanup' && job.state !== 'committed') continue;
            await locked(job.id, () => cleanup(storage, job), true);
        }
    }
    async function withImport(storage, work, options = {}) {
        const job = {id: id(), kind: 'zip-import', state: 'staging', ownedBlobIds: [], createdAt: Date.now()};
        return locked(job.id, async () => {
            activeJobs.add(job.id);
            try {
                cancelled(options.signal); await storage.putArchiveJob(job);
                const staged = Object.create(storage);
                staged.putBlob = async rec => {
                    cancelled(options.signal);
                    if (await storage.getBlob(rec.id)) throw new Error('Archive blob ID collision');
                    job.ownedBlobIds.push(rec.id); job.updatedAt = Date.now();
                    await storage.putArchiveJob(clone(job));
                    await storage.pinBlobs(job.id, [rec.id], {kind: job.kind});
                    await storage.putBlob({...rec, archiveOwnerId: job.id});
                    if (options.onProgress) options.onProgress(job.ownedBlobIds.length);
                    cancelled(options.signal); return rec.id;
                };
                staged.putProject = async (project, opts) => {
                    cancelled(options.signal);
                    const saved = await storage.putProject(project, {...opts, createOnly: true});
                    job.projectId = project.id; job.state = 'committed';
                    await storage.putArchiveJob(clone(job)); return saved;
                };
                const result = await work(staged);
                await cleanup(storage, job); return result;
            } catch (error) {
                try { await cleanup(storage, job); } catch (cleanupError) { error.cleanupPending = true; }
                throw error;
            } finally { activeJobs.delete(job.id); }
        });
    }
    const derived = new Set(['rawRange', 'rawMean', 'rawTrueMax', 'rawDispMax', 'statMax', 'diag', 'sourceStats', 'sourceGeometry', 'rasterW', 'rasterH', 'legacyQuantAudit', 'quantVersion', 'sourceReference', 'storageRevision', 'updatedAt']);
    function fingerprint(project) { return JSON.stringify(project, (key, value) => derived.has(key) ? undefined : value); }
    async function beginExport(project, storage, options = {}) {
        const snapshot = clone(project), signature = fingerprint(project), records = new Map(), media = new Map(), missing = [];
        const job = {id: id(), kind: 'zip-export', state: 'staging', ownedBlobIds: [], createdAt: Date.now()};
        // Hold the Web Lock until close; recovery in another tab cannot reclaim a running export.
        let release, ready;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { ready = resolve; });
        const lockTask = locked(job.id, async () => { activeJobs.add(job.id); ready(); await gate; });
        await started;
        function assertCurrent() {
            cancelled(options.signal);
            if ((options.currentProject && options.currentProject() !== project) || fingerprint(project) !== signature)
                throw new Error('ZIP 作成中にプロジェクトが変更されました。再実行してください / Project changed during ZIP export');
        }
        async function close() {
            try { await cleanup(storage, job); }
            finally { release(); await lockTask; activeJobs.delete(job.id); }
        }
        try {
            await storage.putArchiveJob(job);
            const items = [];
            for (const section of snapshot.sections || []) for (const [kind, collection] of [['image', section.images], ['MSI', section.msiSeries], ['source', section.msiFiles]])
                for (const [key, entry] of entries(collection, kind)) items.push({entry, label: (section.displayName || section.id) + ' / ' + (entry.filename || key)});
            const ids = [...new Set(items.map(item => item.entry.blobId).filter(Boolean))];
            await storage.pinBlobs(job.id, ids, {kind: job.kind, projectId: project.id});
            for (const {entry, label} of items) {
                assertCurrent();
                if (!entry.blobId) { missing.push(label); continue; }
                if (!records.has(entry.blobId)) records.set(entry.blobId, await storage.getBlob(entry.blobId));
                const rec = records.get(entry.blobId);
                if (!rec || !rec.blob) missing.push(label);
            }
            for (const item of ((snapshot.meta && snapshot.meta.roiMedia && snapshot.meta.roiMedia.items) || [])) {
                assertCurrent();
                if (item.blobId) await storage.pinBlobs(job.id, [item.blobId], {kind: job.kind});
                try { media.set(item.id, await options.readMedia(item)); }
                catch (_) { missing.push('ROI photo / ' + (item.filename || item.id)); }
            }
            if (missing.length) throw new Error('ZIP に必要な原本がありません / Required originals unavailable:\n' + [...new Set(missing)].join('\n'));
            assertCurrent();
            for (const section of snapshot.sections || []) for (const entry of Object.values(section.msiSeries || {}))
                entry.archiveProvenance = provenance(entry.archiveProvenance);
            return {project: snapshot, assertCurrent, close,
                storage: {async getBlob(blobId) { assertCurrent(); if (!records.has(blobId)) throw new Error('Source not in ZIP snapshot'); return records.get(blobId); }},
                async readMedia(item) { assertCurrent(); if (!media.has(item.id)) throw new Error('ROI original not in ZIP snapshot'); return media.get(item.id); }};
        } catch (error) { await close().catch(() => {}); throw error; }
    }
    function verifyExport(zip, manifest) {
        const present = value => { const p = path(value); if (!zip.file(p)) throw new Error('ZIP reference is not bundled: ' + p); };
        for (const section of manifest.sections || []) {
            for (const image of Object.values(section.images || {})) { present(image.fullPath); if (image.alignedPath) present(image.alignedPath); }
            for (const source of Object.values(section.msiFilesMeta || {})) present(source.sourcePath);
            for (const source of Object.values(section.originalSeries || {})) present(source.sourcePath);
            for (const group of section.data || []) { present(group.path); if (group.sourceMetadataPath) present(group.sourceMetadataPath); }
        }
        for (const item of ((manifest.roiMedia && manifest.roiMedia.items) || [])) present(item.sourcePath);
    }
    return {clone, provenance, registeredSource, qualityLabel, prepareImport, summary, withImport, recoverImports, beginExport, verifyExport};
});
