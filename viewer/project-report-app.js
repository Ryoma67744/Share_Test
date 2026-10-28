/* Project PowerPoint export: adapt registered data without changing display state. */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ProjectReportApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';
    const identity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const label = (key, meta) => String(meta.base || meta.name || key.replace(/^MSI_/i, ''));
    const metadataFields = ['name', 'base', 'precursor', 'product', 'ce', 'cv', 'polarity', 'mz', 'adduct',
        'formula', 'dwell', 'functionIndex', 'channelIndex', 'rtStart', 'rtEnd', 'instrument', 'acquiredAt',
        'msMethod', 'tuneMethod', 'calibrationFile', 'sourceFile'];
    const numericConditions = new Set(['precursor', 'product', 'ce', 'cv', 'mz', 'dwell', 'functionIndex',
        'channelIndex', 'rtStart', 'rtEnd']);
    // Names alone do not identify an MRM transition or its acquisition conditions.
    const conditionFields = ['precursor', 'product', 'ce', 'cv', 'polarity', 'mz', 'adduct', 'formula', 'dwell'];
    // Share documents contain the full method. Match the recipient-facing UI
    // at the report boundary; keep full conditions privately for grouping.
    const viewerMetadataFields = new Set(['name', 'base', 'precursor', 'product', 'polarity', 'mz', 'adduct', 'formula']);
    function viewerMeta(key, meta, registeredBase) {
        // A public field is a scalar, never a container for arbitrary method
        // metadata (the deck's metadata writer recursively expands objects).
        const scalar = value => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value);
        const out = Object.fromEntries(Object.entries(meta).filter(([field, value]) => viewerMetadataFields.has(field) && scalar(value)));
        // Legacy source labels end in _CE_CV. A registered base is already the
        // display name; never export a second, untrimmed name alongside it.
        const numericSuffix = /_[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?_[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
        const name = registeredBase && scalar(registeredBase) ? registeredBase : label(key, out).replace(numericSuffix, '');
        out.name = out.base = String(name);
        return out;
    }
    function shareSignature(app, project) {
        const session = app.shareMode || {};
        return JSON.stringify([!!project.__share, !!app.shareMode, session.role, session.slug, session.token, session.expiresAt]);
    }
    function registeredMeta(entry, fallback) {
        const source = entry && entry.compoundMeta || fallback || {}, out = {};
        for (const key of metadataFields) if (source[key] != null && source[key] !== '') out[key] = copy(source[key]);
        return out;
    }
    function conditionValue(key, value) {
        if (value == null || value === '') return null;
        // JSON snapshots turn non-finite numbers into null. Treat them as
        // missing consistently when comparing the live source with a snapshot.
        if (typeof value === 'number' && !Number.isFinite(value)) return null;
        if (numericConditions.has(key) && Number.isFinite(Number(value))) return Number(value);
        return String(value);
    }
    function moleculeIdentity(key, meta) {
        return JSON.stringify([label(key, meta), ...conditionFields.map(field => conditionValue(field, meta[field]))]);
    }
    function transitionSubtitle(meta) {
        const parts = [];
        if (meta.precursor != null || meta.product != null) parts.push(String(meta.precursor ?? '—') + ' → ' + String(meta.product ?? '—'));
        else if (meta.mz != null) parts.push('m/z ' + meta.mz);
        for (const [field, title, unit] of [['ce', 'CE', ''], ['cv', 'CV', ''], ['polarity', 'Polarity', ''], ['dwell', 'Dwell', ' s']]) {
            if (meta[field] != null) parts.push(title + ' ' + meta[field] + unit);
        }
        if (meta.adduct) parts.push(String(meta.adduct));
        if (meta.formula) parts.push(String(meta.formula));
        return parts.join('  |  ');
    }
    function cancelledError() {
        const error = new Error('PPT レポートの作成を中止しました。');
        error.name = 'AbortError';
        return error;
    }
    function staleError() {
        const error = new Error('作成中にプロジェクトまたは測定データが変更されました。現在のプロジェクトから作成し直してください。');
        error.code = 'REPORT_SOURCE_CHANGED';
        return error;
    }
    function sourceSignature(panel, key, entry) {
        if (panel && typeof panel._msiLoadIdentity === 'function') return panel._msiLoadIdentity(key);
        const e = entry || {};
        return JSON.stringify([e.blobId, e.sourceUrl, e.sourceFileId, e.sourceRevision, e.sourceHash, e.kind,
            e.sheet, e.func, e.col_x, e.col_y, e.x, e.y, e.col_v, e.v, e.colIdx, e.channel,
            e.compound_index, e.v_index, e.annotation, e.data_start_row, e.dataStartLine, e.range, e.bakeMode]);
    }
    function msiKeys(section) {
        return Array.from(new Set([...Object.keys(section.msiSeries || {}), ...Object.keys(section.images || {})]))
            .filter(key => /^MSI_/i.test(key)).sort();
    }
    function createAdapter(hooks, options = {}) {
        const app = hooks.getApp(), project = app && app.project;
        if (!project) throw new Error('プロジェクトを開いてから PPT レポートを作成してください。');
        const session = app.shareMode, shareState = shareSignature(app, project);
        const viewer = !!(session || project.__share) && (!session || session.role !== 'admin');
        const sections = (project.sections || []).slice();
        const sectionStates = sections.map(section => ({ section, panel: app.panels.get(section.id), keys: msiKeys(section) }));
        const jobs = [], groups = new Map();
        const sourceMeta = (entry, key) => entry && entry.compoundMeta || (hooks.findCompoundMeta && hooks.findCompoundMeta(project, key)) || {};
        const liveMeta = (entry, key) => {
            const meta = sourceMeta(entry, key);
            return !meta.base && !meta.name && hooks.formatDisplayName ? { ...meta, base: hooks.formatDisplayName(key) } : meta;
        };
        for (const state of sectionStates) {
            const section = state.section;
            for (const key of state.keys) {
                const entry = (section.msiSeries || {})[key];
                let meta = registeredMeta(null, liveMeta(entry, key));
                if (!(entry && entry.compoundMeta)) {
                    // The shared name/transition registry is a valid fallback;
                    // another section's acquisition filename/date is not.
                    meta = Object.fromEntries(Object.entries(meta).filter(([field]) =>
                        field === 'name' || field === 'base' || conditionFields.includes(field)));
                }
                const sourceFile = entry && ((section.msiFiles || {})[entry.sourceFileId] || {}).filename || entry && entry.filename;
                if (sourceFile && !meta.sourceFile) meta.sourceFile = sourceFile;
                const scientificId = moleculeIdentity(key, meta);
                const job = { state, key, entry, image: (section.images || {})[key], scientificId,
                    source: sourceSignature(state.panel, key, entry), meta: viewer ? viewerMeta(key, meta, sourceMeta(entry, key).base) : meta,
                    transform: copy(hooks.transform ? hooks.transform(section) : identity()),
                    pixelPitch: copy(section.meta && section.meta.world_coords && section.meta.world_coords.msi_um_per_px) };
                jobs.push(job);
            }
        }
        if (!jobs.length) throw new Error('このプロジェクトには MSI レイヤーが登録されていません。');
        const counts = new Map(), ambiguous = new Set();
        for (const job of jobs) {
            const key = JSON.stringify([job.scientificId, job.state.section.id]);
            const count = (counts.get(key) || 0) + 1;
            counts.set(key, count);
            if (count > 1) ambiguous.add(job.scientificId);
        }
        for (const job of jobs) {
            // A repeated transition within a section cannot be assigned to a
            // cross-section replicate by guessing. Keep its registered key.
            const repeat = ambiguous.has(job.scientificId);
            const groupId = repeat ? JSON.stringify([job.scientificId, job.key]) : job.scientificId;
            if (!groups.has(groupId)) groups.set(groupId, { key: groupId, layerKey: job.key, name: label(job.key, job.meta),
                subtitle: transitionSubtitle(job.meta) + (repeat && !viewer ? '  |  測定: ' + job.key.replace(/^MSI_/i, '') : ''),
                metadata: job.meta, jobs: [] });
            groups.get(groupId).jobs.push(job);
        }
        if (viewer) {
            const visibleCounts = new Map(), visibleIndexes = new Map();
            for (const group of groups.values()) {
                const visibleId = moleculeIdentity('', group.metadata);
                visibleCounts.set(visibleId, (visibleCounts.get(visibleId) || 0) + 1);
            }
            let index = 0;
            for (const group of groups.values()) {
                // The scientific key embeds hidden conditions and the layer
                // key can embed filenames. Neither belongs in the report.
                group.key = group.layerKey = 'molecule-' + (++index);
                const visibleId = moleculeIdentity('', group.metadata);
                if (visibleCounts.get(visibleId) > 1) {
                    const measurement = (visibleIndexes.get(visibleId) || 0) + 1;
                    visibleIndexes.set(visibleId, measurement);
                    group.subtitle += (group.subtitle ? '  |  ' : '') + '測定 ' + measurement;
                }
            }
        }
        let completed = 0;
        function assertCurrent() {
            if (options.signal && options.signal.aborted) throw cancelledError();
            const current = hooks.getApp();
            if (current !== app || current.project !== project || current.shareMode !== session
                || shareSignature(current, project) !== shareState
                || (project.sections || []).length !== sections.length) throw staleError();
            for (let i = 0; i < sectionStates.length; i++) {
                const state = sectionStates[i];
                if (project.sections[i] !== state.section || current.panels.get(state.section.id) !== state.panel
                    || state.panel && (state.panel._destroyed || state.panel.section !== state.section || state.panel.project !== project)
                    || JSON.stringify(msiKeys(state.section)) !== JSON.stringify(state.keys)) throw staleError();
            }
            for (const job of jobs) {
                const section = job.state.section;
                if ((section.msiSeries || {})[job.key] !== job.entry || (section.images || {})[job.key] !== job.image
                    || sourceSignature(job.state.panel, job.key, job.entry) !== job.source
                    || moleculeIdentity(job.key, liveMeta(job.entry, job.key)) !== job.scientificId) throw staleError();
            }
        }
        async function loadJob(job) {
            assertCurrent();
            const { section, panel } = job.state;
            const result = { sectionId: section.id, name: section.displayName || ('Section ' + (section.ordinal || '')),
                transform: copy(job.transform), pixelPitch: copy(job.pixelPitch), metadata: copy(job.meta),
                stats: { mean: null, max: null, n: null } };
            if (!job.entry || (!job.entry.blobId && !job.entry.sourceUrl)) {
                result.missingReason = '元の数値データが登録されていません。';
            } else if (!panel || typeof panel.ensureMsiLayerLoaded !== 'function') {
                result.missingReason = '切片の読み込みが完了していません。';
            } else {
                let ok = false;
                try { ok = await panel.ensureMsiLayerLoaded(job.key); }
                catch (error) {
                    assertCurrent();
                    if (error && error.name === 'AbortError') throw error;
                }
                assertCurrent();
                const raster = panel.msiValueRasters && panel.msiValueRasters.get(job.key);
                if (!ok || !raster || !(raster.W > 0 && raster.H > 0) || !raster.values
                    || raster.values.length !== raster.W * raster.H) {
                    result.missingReason = '元の数値データを読み込めませんでした。';
                } else {
                    result.raster = { W: raster.W, H: raster.H, values: raster.values };
                    const maximum = hooks.max ? hooks.max(job.entry) : null;
                    result.stats = { mean: finite(hooks.mean ? hooks.mean(job.entry) : null),
                        max: finite(maximum && typeof maximum === 'object' ? maximum.value : maximum),
                        n: job.entry.quantVersion === 'msi-source-rows-v1' ? finite(job.entry.sourceStats && job.entry.sourceStats.n) : null };
                }
            }
            completed++;
            if (options.onProgress) options.onProgress({ phase: 'load', index: completed, total: jobs.length,
                moleculeName: label(job.key, job.meta), sectionName: result.name });
            if (hooks.yieldControl) await hooks.yieldControl();
            assertCurrent();
            return result;
        }
        const memo = project.memo || {};
        const metadata = {};
        for (const key of ['sample', 'sampleTypes', 'experimentDate', 'machine', 'freeNote', 'matrix', 'derivatization']) {
            if (memo[key] != null && memo[key] !== '') metadata[key] = copy(memo[key]);
        }
        metadata.sections = sections.map(section => ({ sectionId: section.id,
            name: section.displayName || ('Section ' + (section.ordinal || '')),
            acquisition: viewer ? {} : copy(section.meta && section.meta.raw || {}),
            pixelPitch: copy(section.meta && section.meta.world_coords && section.meta.world_coords.msi_um_per_px || null) }));
        const input = { projectName: project.displayName || 'Project', generatedAt: options.generatedAt || new Date().toISOString(),
            metadata, sections: metadata.sections.map(section => ({ id: section.sectionId, name: section.name })),
            molecules: Array.from(groups.values(), group => ({ key: group.key, layerKey: group.layerKey, name: group.name,
                subtitle: group.subtitle, metadata: copy(group.metadata), async loadEntries() {
                    assertCurrent();
                    const entries = [];
                    for (const section of sections) {
                        const job = group.jobs.find(item => item.state.section === section);
                        if (job) entries.push(await loadJob(job));
                        else entries.push({ sectionId: section.id, name: section.displayName || ('Section ' + (section.ordinal || '')),
                            stats: { mean: null, max: null, n: null }, missingReason: 'この分子・測定条件は切片に登録されていません。' });
                    }
                    return entries;
                } })), assertCurrent };
        assertCurrent();
        return input;
    }
    function safeFileName(name) {
        let clean = String(name || 'Project').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
            .replace(/[. ]+$/g, '').trim().slice(0, 110).replace(/[. ]+$/g, '');
        if (!clean) clean = 'Project';
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = '_' + clean;
        return clean + '_report.pptx';
    }
    function openProgress(doc, cancel) {
        const overlay = doc.createElement('div');
        overlay.className = 'project-report-progress';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:12000;background:#0008;display:flex;align-items:center;justify-content:center;padding:20px';
        const dialog = doc.createElement('div');
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', 'PPT レポートを作成');
        dialog.style.cssText = 'background:white;color:#1e293b;border-radius:10px;padding:24px;width:min(480px,100%);box-shadow:0 12px 40px #0005';
        const title = doc.createElement('strong'); title.textContent = 'PPT レポートを作成しています';
        const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        status.style.cssText = 'margin:14px 0;overflow-wrap:anywhere'; status.textContent = 'レポートの準備中…';
        const bar = doc.createElement('progress'); bar.style.cssText = 'width:100%;height:12px;margin-bottom:16px';
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = '中止';
        button.addEventListener('click', () => { cancel(); button.disabled = true; status.textContent = '中止しています…'; });
        dialog.append(title, status, bar, button); overlay.appendChild(dialog); doc.body.appendChild(overlay);
        const focused = doc.activeElement;
        button.focus();
        const keydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); button.click(); }
            if (event.key === 'Tab') { event.preventDefault(); button.focus(); }
        };
        overlay.addEventListener('keydown', keydown);
        return {
            update(event) {
                if (button.disabled) return;
                if (event.phase === 'load') {
                    status.textContent = '数値データを読み込み中 ' + event.index + ' / ' + event.total + '：' + event.moleculeName + ' / ' + event.sectionName;
                    bar.max = event.total; bar.value = event.index;
                } else if (event.phase === 'render') {
                    status.textContent = '画像を作成中：' + (event.moleculeName || '') + ' (' + event.index + ' / ' + event.total + ')';
                    bar.removeAttribute('value');
                } else { status.textContent = event.message || 'PowerPoint をまとめています…'; bar.removeAttribute('value'); }
            },
            close() { overlay.remove(); if (focused && typeof focused.focus === 'function') focused.focus(); }
        };
    }
    let activeExport = null;
    async function exportCurrent() {
        if (activeExport) return activeExport;
        const run = async () => {
            const doc = root.document, controller = new AbortController();
            const button = doc.getElementById('btn-export-ppt');
            let progress = null;
            try {
                const input = createAdapter({ getApp: () => typeof App !== 'undefined' ? App : root.App,
                    transform: section => sectionLayerViewLinear(section, 'msi'),
                    mean: entry => msiQuantMean(entry), max: entry => msiMaxIntensity(entry),
                    findCompoundMeta: (project, key) => findCompoundMeta(project, key),
                    formatDisplayName: key => formatDisplayName(key),
                    yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)) },
                { signal: controller.signal, onProgress: event => progress && progress.update(event) });
                progress = openProgress(doc, () => controller.abort());
                if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
                const libs = root.LAZY_LIBS || {};
                await root.loadScript(libs.jszip || '../vendor/jszip.min.js'); input.assertCurrent();
                await root.loadScript(libs.pptxgen || '../vendor/pptxgen.min.js'); input.assertCurrent();
                await root.loadScript(libs.projectReportData || 'project-report-data.js'); input.assertCurrent();
                await root.loadScript(libs.projectReportDeck || 'project-report-deck.js'); input.assertCurrent();
                const report = await root.ProjectReportData.prepare(input, { createCanvas: () => doc.createElement('canvas'),
                    signal: controller.signal, onProgress: event => progress.update(event) });
                input.assertCurrent();
                progress.update({ phase: 'write' });
                const blob = await root.ProjectReportDeck.create(report, { type: 'blob', signal: controller.signal,
                    assertCurrent: input.assertCurrent, onProgress: event => progress.update(event) });
                input.assertCurrent();
                if (!blob || !(blob.size > 0)) throw new Error('PowerPoint ファイルを作成できませんでした。');
                downloadAsFile(blob, safeFileName(input.projectName));
                if (typeof showToast === 'function') showToast('PPT レポートを保存しました。');
                return blob;
            } catch (error) {
                const message = error && error.name === 'AbortError' ? 'PPT レポートの作成を中止しました。'
                    : 'PPT レポートを作成できませんでした：' + (error && error.message || String(error));
                if (typeof showToast === 'function') showToast(message, 8000);
                else if (root.alert) root.alert(message);
                return null;
            } finally {
                if (progress) progress.close();
                if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
            }
        };
        activeExport = run();
        try { return await activeExport; } finally { activeExport = null; }
    }
    return { createAdapter, moleculeIdentity, safeFileName, exportCurrent };
});
