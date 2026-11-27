/* Read-only collections of published project backups. No App/IDB mutations. */
(function(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.SharedCollection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
    'use strict';
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const fail = (code, message) => Object.assign(new Error(message), {code});
    const t = (source, params) => root.AppI18n ? root.AppI18n.t(source, params)
        : source.replace(/\{(\w+)\}/g, (_, key) => params?.[key] ?? '');
    const archive = () => typeof module === 'object' && module.exports ? require('./project-archive.js') : root.ProjectArchive;
    const loader = () => typeof module === 'object' && module.exports ? require('./source-loader.js') : root.SourceLoader;
    const ratios = () => typeof module === 'object' && module.exports ? require('./msi-ratio-model.js') : root.MsiRatioModel;
    function check(signal) {
        if (signal?.aborted) throw Object.assign(fail('COLLECTION_CANCELLED', t('一括ZIPを中止しました。')), {name:'AbortError'});
    }
    function safeName(value) {
        const name = String(value || '').normalize('NFC').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_')
            .replace(/^\.+|[. ]+$/g, '').trim().slice(0, 120);
        return name || 'project';
    }
    function collect(index) {
        const map = new Map();
        function visit(nodes, parents, depth) {
            if (depth > 64) throw fail('COLLECTION_DEPTH', t('共有フォルダの階層が深すぎます。'));
            for (const node of Array.isArray(nodes) ? nodes : []) {
                if (node?.type === 'folder') visit(node.children, parents.concat(String(node.name || 'Folder')), depth + 1);
                else if (node?.type === 'project' && typeof node.slug === 'string' && node.slug) {
                    let entry = map.get(node.slug);
                    if (!entry) { entry = {slug:node.slug, name:String(node.displayName || node.slug), folders:[]};map.set(node.slug, entry); }
                    if (!entry.folders.some(path => JSON.stringify(path) === JSON.stringify(parents))) entry.folders.push(parents.slice());
                }
            }
        }
        visit(index?.children, [], 0);
        return [...map.values()];
    }

    // Token/password ownership is per slug. Folder authorization never grants
    // access to its child projects. Passwords are neither cached nor returned.
    function createSessions({api, storage, askPassword, now = Date.now}) {
        const sessions = new Map(), key = slug => 'desi:share:' + slug;
        const expired = error => error?.code === '28000' || /invalid or expired token/i.test(error?.message || '');
        const credentials = error => ['28P01','28P02','42501'].includes(error?.code)
            || /invalid credentials|not[_ ]public|private project|password/i.test(error?.message || '');
        function invalidate(slug) { sessions.delete(slug);try { storage?.removeItem(key(slug)); } catch (_) {} }
        function saved(slug) {
            let value = sessions.get(slug);
            if (!value) { try { value = JSON.parse(storage?.getItem(key(slug)) || 'null'); } catch (_) {} }
            if (value?.slug === slug && value.token && ['viewer','admin'].includes(value.role)
                && new Date(value.expiresAt).getTime() > now() + 5000) return value;
            return null;
        }
        function remember(slug, raw, isPublic) {
            const row = Array.isArray(raw) ? raw[0] : raw;
            if (!row?.token || row.role !== 'viewer')
                throw fail('COLLECTION_VIEWER_PASSWORD', t('このプロジェクトの閲覧用パスワードを入力してください。'));
            const value = {slug, token:row.token, role:row.role, expiresAt:row.expires_at, isPublic};
            sessions.set(slug, value);
            try { storage?.setItem(key(slug), JSON.stringify(value)); } catch (_) {}
            return value;
        }
        async function get(entry, {signal} = {}) {
            check(signal);
            const previous = saved(entry.slug);
            if (previous) return previous;
            try { return remember(entry.slug, await api.unlockPublicProject(entry.slug, {signal}), true); }
            catch (error) {
                check(signal);
                if (!credentials(error) && error?.code !== 'COLLECTION_VIEWER_PASSWORD') throw error;
            }
            let error = null;
            for (;;) {
                check(signal);
                const password = await askPassword(entry, {signal, error});
                check(signal);
                if (password == null) throw fail('COLLECTION_SKIPPED', t('パスワード入力をスキップしました。'));
                try { return remember(entry.slug, await api.unlockProject(entry.slug, password, {signal}), false); }
                catch (next) {
                    check(signal);
                    if (!credentials(next) && next?.code !== 'COLLECTION_VIEWER_PASSWORD') throw next;
                    error = t('閲覧用パスワードを確認してください。');
                }
            }
        }
        async function run(entry, operation, options = {}) {
            let session = await get(entry, options);
            try { return await operation(session); }
            catch (error) {
                check(options.signal);
                if (!expired(error)) throw error;
                invalidate(entry.slug);
                session = await get(entry, options);
                return operation(session);
            }
        }
        return {get, run, invalidate};
    }

    async function readRois(api, token, sections, options = {}) {
        const signal=options.signal,output=[];
        async function sectionRows(section) {
            const rows=[],seen=new Set(),colors=new Set();let expected=null;
            for(;;) {
                check(signal);
                const page=await api.listRoisPage(token,section.id,{...options,offset:rows.length,limit:500});
                check(signal);
                if(!Array.isArray(page?.rows) || !Number.isSafeInteger(page.count) || page.count<0)
                    throw fail('COLLECTION_ROI_COUNT',t('ROIの総件数を確認できません。完全なZIPを作成できません。'));
                if(expected===null)expected=page.count;
                if(page.count!==expected)throw fail('COLLECTION_ROI_CHANGED',t('取得中にROIが変更されました。再試行してください。'));
                for(const row of page.rows) {
                    if(!row?.id || row.section_id!==section.id || seen.has(row.id))
                        throw fail('COLLECTION_ROI_CHANGED',t('ROIを重複なく取得できません。再試行してください。'));
                    // The existing portable ROI model groups by color and
                    // section. Do not silently overwrite a second server row
                    // that cannot be represented by that model.
                    const color=String(row.color_key || 'default');
                    if(colors.has(color))throw fail('COLLECTION_ROI_DUPLICATE',t('同じ切片・色のROIが重複しています。公開元で確認してください。'));
                    colors.add(color);
                    seen.add(row.id);rows.push(row);
                }
                if(rows.length===expected)return rows;
                if(!page.rows.length || rows.length>expected)
                    throw fail('COLLECTION_ROI_COUNT',t('ROIの全件を取得できません。再試行してください。'));
            }
        }
        // Bound section fan-out while serializing pages for each section.
        for(let start=0;start<sections.length;start+=3) {
            const batches=await Promise.all(sections.slice(start,start+3).map(sectionRows));
            for(const batch of batches)output.push(...batch);
        }
        return output;
    }
    function roiSignature(rows) {
        const canonical=value=>value && typeof value==='object'
            ? Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
        return JSON.stringify(rows.slice().sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(canonical));
    }

    function projectFromDoc(doc, slug, options = {}) {
        if (!doc || !Array.isArray(doc.sections)) throw fail('COLLECTION_DOCUMENT', t('共有プロジェクトの定義を読み取れません。'));
        if (doc.meta?.project_slug && doc.meta.project_slug !== slug)
            throw fail('COLLECTION_TARGET', t('共有プロジェクトが取得対象と一致しません。'));
        const meta = clone(doc.meta?.project_meta || {});
        if (options.roiMedia !== undefined) meta.roiMedia = clone(options.roiMedia);
        if (options.ratios !== undefined) meta.msiRatios = clone(options.ratios);
        const project = {id:doc.id || 'proj_share_' + slug,
            displayName:doc.meta?.display_name || doc.display_name || doc.displayName || slug,
            anatomyPalette:clone(doc.anatomy_palette || doc.anatomyPalette || {}),
            meta, memo:clone(options.memo || meta.memo || doc.memo || {}),
            rois:clone(options.rois || []), roiHidden:clone(meta.roiHidden || {}),
            overlays:clone(doc.sections.find(s => Array.isArray(s.meta?.overlays) && s.meta.overlays.length)?.meta.overlays || []),
            sections:[]};
        for (const remote of doc.sections) {
            const section = {id:remote.id || remote.client_id, ordinal:remote.ordinal,
                displayName:remote.display_name || remote.displayName || 'Section ' + remote.ordinal,
                meta:clone(remote.meta || {}), images:Object.create(null), msiSeries:Object.create(null), msiFiles:Object.create(null)};
            if(!section.meta.client_id && remote.client_id)section.meta.client_id=remote.client_id;
            const paths = remote.storage_paths || remote.storagePaths || {};
            for (const kind of ['images','msiSeries','msiFiles']) for (const [key, value] of Object.entries(paths[kind] || {})) {
                if (['__proto__','constructor','prototype'].includes(key)) throw fail('COLLECTION_DOCUMENT',t('共有プロジェクトの定義を読み取れません。'));
                if (!value?.path) throw fail('COLLECTION_SOURCE', t('公開された原本参照がありません: {0}', [section.displayName + ' / ' + key]));
                section[kind][key] = {...clone(value), blobId:null, storagePath:value.path};
            }
            project.sections.push(section);
        }
        return project;
    }

    // STORE ZIPs use Blob slices and a small CRC buffer. Do not feed all inner
    // ZIPs back into JSZip, which materializes another collection-sized array.
    // Archives stay ZIP32-compatible with the existing importer. Oversized
    // collections split at project boundaries; a >4GiB project fails clearly.
    const MAX_ZIP = 0xffffffff, DEFAULT_PART_BYTES = 256 * 1024 * 1024;
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let value = n;
        for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        crcTable[n] = value >>> 0;
    }
    async function crc32(blob, {signal, onProgress} = {}) {
        let crc = 0xffffffff;
        for (let offset = 0; offset < blob.size; offset += 512 * 1024) {
            check(signal);
            const bytes = new Uint8Array(await blob.slice(offset, offset + 512 * 1024).arrayBuffer());
            for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
            onProgress?.(Math.min(offset + bytes.length, blob.size), blob.size);
            if ((offset / (512 * 1024)) % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
        }
        check(signal);
        return (crc ^ 0xffffffff) >>> 0;
    }
    function zipPath(value) {
        if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
            || /^[a-z]+:/i.test(value) || value.split('/').some(part => !part || part === '.' || part === '..'))
            throw fail('COLLECTION_PATH', t('ZIPの保存先名が不正です。'));
        return value;
    }
    async function storedZip(files, options = {}) {
        const parts = [], directory = [], names = new Set(), encoder = new TextEncoder();
        let offset = 0, total = files.reduce((n, file) => n + (file.blob?.size || 0), 0), completed = 0;
        const date = options.date || new Date();
        const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
        const dosDate = ((Math.max(1980, Math.min(2107, date.getFullYear())) - 1980) << 9)
            | ((date.getMonth() + 1) << 5) | date.getDate();
        if (files.length >= 65535) throw fail('COLLECTION_TOO_LARGE', t('ZIPのファイル数が上限を超えています。プロジェクトを分けてください。'));
        for (const file of files) {
            check(options.signal);
            const path = zipPath(file.path), name = encoder.encode(path), blob = file.blob;
            if (names.has(path)) throw fail('COLLECTION_PATH', t('ZIP内の名前が重複しています: {0}', [path]));
            names.add(path);
            if (!blob || typeof blob.slice !== 'function') throw new TypeError('ZIP source Blob is required');
            if (name.length > 65535 || blob.size >= MAX_ZIP || offset + blob.size + name.length * 2 + 100 >= MAX_ZIP)
                throw fail('COLLECTION_TOO_LARGE', t('1プロジェクトのZIPが4 GiB上限を超えます。プロジェクトを分けてください。'));
            const crc = await crc32(blob, {signal:options.signal,
                onProgress:(loaded) => options.onProgress?.(completed + loaded, total)});
            const local = new Uint8Array(30 + name.length), head = new DataView(local.buffer);
            head.setUint32(0, 0x04034b50, true);head.setUint16(4, 20, true);head.setUint16(6, 0x800, true);
            head.setUint16(10, dosTime, true);head.setUint16(12, dosDate, true);head.setUint32(14, crc, true);
            head.setUint32(18, blob.size, true);head.setUint32(22, blob.size, true);head.setUint16(26, name.length, true);
            local.set(name, 30);parts.push(local, blob);
            const central = new Uint8Array(46 + name.length), item = new DataView(central.buffer);
            item.setUint32(0, 0x02014b50, true);item.setUint16(4, 20, true);item.setUint16(6, 20, true);
            item.setUint16(8, 0x800, true);item.setUint16(12, dosTime, true);item.setUint16(14, dosDate, true);
            item.setUint32(16, crc, true);item.setUint32(20, blob.size, true);item.setUint32(24, blob.size, true);
            item.setUint16(28, name.length, true);item.setUint32(42, offset, true);central.set(name, 46);
            directory.push(central);offset += local.length + blob.size;completed += blob.size;
        }
        const centralSize = directory.reduce((sum, item) => sum + item.length, 0);
        if (offset + centralSize + 22 >= MAX_ZIP) throw fail('COLLECTION_TOO_LARGE', t('ZIPが4 GiB上限を超えています。'));
        const end = new Uint8Array(22), view = new DataView(end.buffer);
        view.setUint32(0, 0x06054b50, true);view.setUint16(8, files.length, true);view.setUint16(10, files.length, true);
        view.setUint32(12, centralSize, true);view.setUint32(16, offset, true);
        check(options.signal);
        return new Blob([...parts, ...directory, end], {type:'application/zip'});
    }

    const sensitive = new Set(['roiMedia','shareInfo','__share','__publishPending','viewerPassword','adminPassword','masterPw']);
    const portableMeta = value => JSON.parse(JSON.stringify(value || {}, (key, item) => sensitive.has(key) ? undefined : item));
    function portableSource(entry, sourcePath) {
        const result = {...clone(entry), sourcePath};
        for (const field of ['blobId','sourceUrl','storagePath','path']) delete result[field];
        return result;
    }
    async function projectZip(input, options = {}) {
        const project = clone(input), Archive = archive(), signal = options.signal;
        check(signal);
        options.freezeReferences?.(project);
        Archive.validateAlignmentContracts(project);
        const sectionIds=new Set();
        for(const section of project.sections || []) {
            if(typeof section.id!=='string' || !section.id || sectionIds.has(section.id)
                || ['__proto__','constructor','prototype'].includes(section.id))
                throw fail('COLLECTION_DOCUMENT',t('共有プロジェクトの定義を読み取れません。'));
            sectionIds.add(section.id);
        }
        if (project.meta?.msiRatios != null) {
            const validation = ratios().validateProjectReferences(project);
            if (!validation.valid) throw fail('COLLECTION_RATIOS', t('公開された比の入力参照を確認してください: {0}', [validation.errors.join('; ')]));
        }
        const reader = loader().createArchiveReader({resolveSource:options.resolveSource, fetchBlob:options.fetchBlob});
        const files = [], bundled = new Map();
        const manifest = {format:Archive.formatForProject(project), sourceContract:'msi-source-rows-v1', bgRemoved:null,
            archiveContract:{version:1, completeness:'registered-snapshot', provenanceVersion:1},
            exportMode:'published-originals', derivatives:{numericCsv:'not-generated', alignedPng:'rebuild-from-original-and-alignment'},
            id:project.id, displayName:project.displayName, anatomyPalette:project.anatomyPalette || {},
            sectionOrder:(project.sections || []).map(s => s.id), rois:clone(project.rois || []),
            roiHidden:clone(project.roiHidden || {}), memo:clone(project.memo || {}),
            offlineSettings:{version:1, meta:portableMeta(project.meta), overlays:clone(project.overlays || [])},
            roiMedia:{version:1,items:[]}, sections:[]};
        let sourceCount = 0, done = 0;
        for (const section of project.sections || []) for (const kind of ['images','msiFiles','msiSeries']) {
            for (const entry of Object.values(section[kind] || {})) { reader.prepare(entry);sourceCount++; }
        }
        sourceCount += project.meta?.roiMedia?.items?.length || 0;
        const addOriginal = async (entry, folder, fallback) => {
            check(signal);
            const handle = reader.prepare(entry);
            if (!handle) throw fail('COLLECTION_SOURCE', t('公開された原本参照がありません: {0}', [entry.filename || fallback]));
            if (!bundled.has(handle.id)) {
                const record = await reader.ensure(entry, {signal,
                    onProgress:(loaded,total) => options.onProgress?.({stage:'source',file:entry.filename || fallback,loaded,total,done,sourceCount})});
                if (!record?.blob) throw fail('COLLECTION_SOURCE', t('原本を取得できません: {0}', [entry.filename || fallback]));
                const path = folder + '/' + String(bundled.size + 1).padStart(4, '0') + '__' + safeName(entry.filename || fallback);
                files.push({path,blob:record.blob});bundled.set(handle.id, path);
            }
            options.onProgress?.({stage:'source',file:entry.filename || fallback,done:++done,sourceCount});
            return bundled.get(handle.id);
        };
        try {
            for (const section of project.sections || []) {
                const out = {id:section.id, ordinal:section.ordinal, displayName:section.displayName, meta:clone(section.meta || {}),
                    images:{}, msiFilesMeta:{}, originalSeries:{}, data:[]};
                for (const [key, entry] of Object.entries(section.images || {})) {
                    const fullPath = await addOriginal(entry, 'HE_IF', key + '.bin');
                    out.images[key] = {mime:entry.mime,filename:entry.filename,fullPath,
                        alignmentImageReference:entry.alignmentImageReference || options.imageIdentity?.(entry)};
                }
                for (const [fid, entry] of Object.entries(section.msiFiles || {})) {
                    const sourcePath = await addOriginal(entry, 'Source', fid);
                    out.msiFilesMeta[fid] = portableSource(entry, sourcePath);
                }
                for (const [key, entry] of Object.entries(section.msiSeries || {})) {
                    const sourcePath = await addOriginal(entry, 'Source', key);
                    out.originalSeries[key] = {...portableSource(entry, sourcePath), archiveProvenance:Archive.provenance(entry.archiveProvenance)};
                    const fid = entry.sourceFileId || 'source-' + entry.blobId;
                    if (out.msiFilesMeta[fid] && out.msiFilesMeta[fid].sourcePath !== sourcePath)
                        throw fail('COLLECTION_SOURCE_CONFLICT', t('公開された原本とレイヤーの参照が一致しません: {0}', [fid]));
                    if (!out.msiFilesMeta[fid]) out.msiFilesMeta[fid] = portableSource(entry, sourcePath);
                }
                manifest.sections.push(out);
            }
            for (const item of project.meta?.roiMedia?.items || []) {
                const section = project.sections.find(s => String(s.id) === String(item.sectionId)
                    || String(s.meta?.client_id) === String(item.sectionId));
                const roi = project.rois.find(r => r.colorKey === item.roiKey && Array.isArray(r.polysBySection?.[section?.id]));
                if (!section || !roi) throw fail('COLLECTION_MEDIA', t('ROI写真の対応先が見つかりません: {0}', [item.filename || item.id]));
                const sourcePath = await addOriginal(item, 'ROI_Media', item.id + '.bin');
                manifest.roiMedia.items.push({...portableSource(item, sourcePath),sectionId:section.id});
            }
            // Existing Import ZIP restores every originalSeries selector and
            // re-derives HE/IF overlays from originals + alignment metadata.
            Archive.verifyExport({file:path => files.some(file => file.path === path)}, manifest);
            files.push({path:safeName(project.displayName) + '.json',blob:new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'})});
            const blob = await storedZip(files, {signal, onProgress:(loaded,total) => options.onProgress?.({stage:'archive',loaded,total})});
            return {blob,manifest,originalCount:bundled.size};
        } finally { reader.dispose(); }
    }

    async function run(entries, options) {
        const signal = options.signal, results = entries.map(entry => ({slug:entry.slug,name:entry.name,
            folders:clone(entry.folders),status:'pending'}));
        const parts = [], stamp = (options.date || new Date()).toISOString().replace(/[:.]/g,'-').slice(0,19);
        const base = safeName(options.name || 'Shared projects') + '_' + stamp;
        const partLimit = Math.min(options.partBytes || DEFAULT_PART_BYTES, MAX_ZIP - 1024 * 1024);
        let pending = [], bytes = 0, cancelled = false;
        const emit = extra => options.onProgress?.({...extra,results:clone(results),total:entries.length});
        async function flush(final) {
            if (!pending.length) return;
            const number = parts.length + 1;
            const filename = base + (final && !parts.length ? '' : '__part-' + String(number).padStart(3,'0')) + '.zip';
            for (const item of pending) { item.result.status = 'ready';item.result.part = filename; }
            const manifest = {format:'desi_shared_collection_v1',name:options.name || 'Shared projects',createdAt:new Date().toISOString(),
                part:number,finalPart:final,partLimitBytes:partLimit,projectCount:entries.length,
                content:'published originals, saved definitions, ROI and alignment; derived CSV/PNG are not generated',
                restore:'Extract this collection, then Import ZIP each project archive.',
                projects:results.map(row => ({slug:row.slug,name:row.name,folders:row.folders,archivePath:row.archivePath,part:row.part})),
                results:clone(results),complete:final && results.every(row => row.status === 'ready')};
            try {
                emit({stage:'collection',part:number});
                const blob = await storedZip(pending.map(item => ({path:item.result.archivePath,blob:item.blob})).concat([
                    {path:'manifest.json',blob:new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'})},
                    {path:'download-results.json',blob:new Blob([JSON.stringify(results,null,2)],{type:'application/json'})},
                    {path:'README.txt',blob:new Blob(['Extract this ZIP, then use Import ZIP for each project ZIP.\n'
                        + '原本と保存定義を含みます。外側のZIPを展開して、各プロジェクトZIPをImport ZIPで読み込んでください。\n'
                        + 'Aligned PNGs and numeric CSVs are derivatives: open an imported project and use Export ZIP when needed.\n'
                        + '派生CSV・位置合わせ済みPNGが必要な場合は、復元後のプロジェクトでExport ZIPを実行してください。\n'
                        + 'For completed split exports, the last part contains the final download report.\n'
                        + '分割出力が最後まで完了した場合、最後のZIPのdownload-results.jsonに全件の結果を記録します。\n'])}
                ]), {signal,onProgress:(loaded,total) => emit({stage:'collection',part:number,loaded,bytesTotal:total})});
                const part = {filename,blob,number,count:pending.length};
                // The UI may immediately stream/save each part and release its
                // Blob. Core keeps only small metadata about completed parts.
                await options.onPart(part);
                parts.push({filename,number,count:pending.length,bytes:blob.size});
                pending = [];bytes = 0;
            } catch (error) {
                for (const item of pending) { item.result.status=signal?.aborted?'cancelled':'failed';item.result.error=error.message;delete item.result.part; }
                pending=[];bytes=0;
                throw error;
            }
        }
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index], result = results[index];
            try {
                check(signal);result.status='loading';emit({stage:'project',index,entry});
                const loaded = await options.loadProject(entry,{signal});
                check(signal);
                const built = await projectZip(loaded.project,{...options,signal,
                    onProgress:progress=>emit({...progress,index,entry})});
                if (loaded.validate) await loaded.validate();
                check(signal);
                if (pending.length && bytes + built.blob.size > partLimit) await flush(false);
                result.status='prepared';result.revision=loaded.revision ?? null;result.publishedAt=loaded.publishedAt || null;
                result.originalCount=built.originalCount;result.bytes=built.blob.size;
                result.archivePath='projects/' + String(index + 1).padStart(3,'0') + '__' + safeName(entry.name) + '__' + safeName(entry.slug) + '.zip';
                pending.push({blob:built.blob,result});bytes+=built.blob.size;
            } catch (error) {
                result.status=signal?.aborted || error?.name==='AbortError' ? 'cancelled' : 'failed';
                result.error=String(error?.message || error);result.code=error?.code || null;
                if (result.status==='cancelled') { cancelled=true;break; }
            }
            emit({stage:'project-done',index,entry});
        }
        if (!cancelled) {
            try { await flush(true); }
            catch (error) { cancelled=!!signal?.aborted;emit({stage:'error',error:String(error.message || error)}); }
        }
        for (const row of results) if (['pending','loading','prepared'].includes(row.status)) {
            row.status=cancelled?'cancelled':'failed';row.error=t(cancelled?'一括ZIPを中止しました。':'ZIPを保存できませんでした。');
        }
        emit({stage:'done',cancelled});
        return {results,parts,cancelled};
    }
    return {collect,createSessions,readRois,roiSignature,projectFromDoc,projectZip,storedZip,crc32,run,safeName,DEFAULT_PART_BYTES};
});
