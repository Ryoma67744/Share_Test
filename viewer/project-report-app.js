/* Project PowerPoint export: adapt registered data without changing display state. */
(function (root, factory) {
    const api = factory(root, typeof module === 'object' && module.exports ? require('./msi-smoothing.js') : root.MsiSmoothing);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ProjectReportApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, MsiSmoothing) {
    'use strict';
    // Keep these three report modules and their viewer URLs on one revision.
    const REPORT_REVISION = 'ppt-20261110-1';
    function assertReportModules(data, deck) {
        if (!data || !deck || data.REPORT_REVISION !== REPORT_REVISION || deck.REPORT_REVISION !== REPORT_REVISION) {
            const error = new Error('レポート機能が更新されました。ページを再読み込みしてから作成し直してください。');
            error.code = 'REPORT_VERSION_MISMATCH';
            throw error;
        }
    }
    const identity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const pitchValue = pitch => pitch && finite(pitch.x) > 0 && finite(pitch.y) > 0 ? { x: pitch.x, y: pitch.y } : null;
    function registeredPitchValue(pitch) {
        // The acquisition label uses the registered source pitch, independently
        // of the effective display pitch used by resampling and scale bars.
        const numeric = value => typeof value === 'string'
            && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : value;
        return pitchValue(pitch && {x: numeric(pitch.x), y: numeric(pitch.y)});
    }
    const label = (key, meta) => String(meta.base || meta.name || key.replace(/^MSI_/i, ''));
    const metadataFields = ['name', 'base', 'precursor', 'product', 'ce', 'cv', 'polarity', 'mz', 'adduct',
        'formula', 'dwell', 'functionIndex', 'channelIndex', 'rtStart', 'rtEnd', 'instrument', 'acquiredAt',
        'msMethod', 'tuneMethod', 'calibrationFile', 'sourceFile'];
    const numericConditions = new Set(['precursor', 'product', 'ce', 'cv', 'mz', 'dwell', 'functionIndex',
        'channelIndex', 'rtStart', 'rtEnd']);
    // Names alone do not identify an MRM transition or its acquisition conditions.
    const conditionFields = ['precursor', 'product', 'ce', 'cv', 'polarity', 'mz', 'adduct', 'formula', 'dwell'];
    const scalar = value => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value);
    const numericText = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
    const numericSuffix = new RegExp('_(' + numericText + ')_(' + numericText + ')(\\.[a-z][a-z0-9.]{0,12})?$', 'i');
    // CE is also the cholesteryl-ester lipid class. Its registered carbon:
    // double-bond notation is a molecule name, not a collision-energy label.
    const ceVoltageLabel = 'CE(?!\\s*\\(?\\s*\\d{1,3}:\\d{1,2}\\b)';
    const voltageLabel = '(?:collision[ _-]*(?:energy|voltage|potential)|cone[ _-]*(?:voltage|potential)|collision|cone|' + ceVoltageLabel + '|CV|コーン電圧|衝突エネルギー)';
    const voltageValue = new RegExp('(^|[^a-z0-9])\\(?' + voltageLabel + '\\)?(?:\\s*\\((?:eV|V)\\))?[ _:=／/\\-]*(' + numericText + ')(?:\\s*(?:eV|volts?|V))?', 'gi');
    const voltageMarker = new RegExp('(^|[^a-z0-9])' + voltageLabel + '(?=$|[^a-z])', 'i');
    function voltageField(key) {
        const k = String(key).toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]/g, '');
        return /^(?:ce|cv)(?:value|voltage|energy|setting|settings|ev|v|volts)?$/.test(k)
            || /^(?:msce|msmsce)$/.test(k)
            || /^(?:cone|collision)(?:ev|v|volts?)?$/.test(k)
            || /^(?:(?:ms|msms)(?:mode)?)?(?:cone(?:voltage|potential)|collision(?:energy|voltage|potential))/.test(k)
            || /^(?:コーン電圧|衝突エネルギー)/.test(k);
    }
    function voltageFreeText(value, pairs, stripUnknownSuffix = false) {
        const lines = String(value).split(/\r?\n/).map(line => {
            let text = line.replace(voltageValue, '$1');
            // An unparsed labelled method expression must not leave its value
            // behind. Other note lines still remain useful in the report.
            if (voltageMarker.test(text)) return '';
            text = text.replace(numericSuffix, (whole, ce, cv, extension) =>
                stripUnknownSuffix || pairs.some(pair => Number(ce) === pair[0] && Number(cv) === pair[1]) ? (extension || '') : whole);
            return text.replace(/^[\s,;|_]+|[\s,;|_]+$/g, '').replace(/[ \t]{2,}/g, ' ').trim();
        });
        return lines.filter(Boolean).join('\n');
    }
    function withoutVoltages(value, pairs, field) {
        if (typeof value === 'string') return voltageFreeText(value, pairs, /^(?:sourceFile|fileName|filename)$/i.test(field || ''));
        if (value == null || typeof value !== 'object') return value;
        if (Array.isArray(value)) {
            if (typeof value[0] === 'string' && voltageField(value[0])) return undefined;
            return value.map(item => withoutVoltages(item, pairs)).filter(item => item !== undefined);
        }
        // Label/value method records need to disappear as a unit; removing
        // only their label would expose an unlabeled voltage in the deck.
        const hasRecordValue = Object.keys(value).some(key => /^(?:value|values|setting|settings|voltage|energy|amount)$/i.test(key));
        if (Object.entries(value).some(([key, item]) => /^(?:label|parameter|param|name|key|field|displayname)$/i.test(key)
            && (!/^name$/i.test(key) || hasRecordValue)
            && typeof item === 'string' && voltageField(item))) return undefined;
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (voltageField(key) || voltageMarker.test(key)) continue;
            const clean = withoutVoltages(item, pairs, key);
            if (clean !== undefined && clean !== '') out[key] = clean;
        }
        return out;
    }
    function voltageFreeMeta(key, meta, registeredBase, pairs) {
        const out = withoutVoltages(meta, pairs) || {};
        const explicitBase = scalar(registeredBase) && registeredBase !== '';
        const registeredName = explicitBase ? registeredBase : meta.name;
        const name = scalar(registeredName) && /^CE$/i.test(String(registeredName).trim()) ? String(registeredName)
            : voltageFreeText(explicitBase ? registeredBase : label(key, out), pairs, !explicitBase) || 'Molecule';
        out.name = out.base = name;
        return out;
    }
    // Share documents contain the full method. Match the recipient-facing UI
    // at the report boundary; keep full conditions privately for grouping.
    const viewerMetadataFields = new Set(['name', 'base', 'precursor', 'product', 'polarity', 'mz', 'adduct', 'formula']);
    function viewerMeta(key, meta, registeredBase) {
        // A public field is a scalar, never a container for arbitrary method
        // metadata (the deck's metadata writer recursively expands objects).
        const out = Object.fromEntries(Object.entries(meta).filter(([field, value]) => viewerMetadataFields.has(field) && scalar(value)));
        // Legacy source labels end in _CE_CV. A registered base is already the
        // display name; never export a second, untrimmed name alongside it.
        const name = registeredBase && scalar(registeredBase) ? registeredBase : label(key, out).replace(numericSuffix, '');
        out.name = out.base = String(name);
        return out;
    }
    function shareSignature(app, project) {
        const session = app.shareMode || {};
        return JSON.stringify([!!project.__share, !!app.shareMode, session.role, session.slug, session.token, session.expiresAt]);
    }
    function captureExportContext(getApp) {
        const app = getApp(), project = app && app.project;
        if (!project) throw new Error('プロジェクトを開いてから PPT レポートを作成してください。');
        const session = app.shareMode, signature = shareSignature(app, project);
        const shared = !!(session || project.__share);
        return { shared, canIncludeCeCv: !shared || !!(session && session.role === 'admin'), assertCurrent() {
            const current = getApp();
            if (current !== app || current.project !== project || current.shareMode !== session
                || shareSignature(current, project) !== signature) throw staleError();
        } };
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
    function referenceFrame(options) {
        if(!root.MsiDisplayGeometry || !options || !options.geometries || !options.geometries.length)return null;
        const {width,height,geometries}=options;
        if(geometries.some(g=>!g || !g.legacy || !g.displayGeometry || g.displayGeometry.W!==width || g.displayGeometry.H!==height))return null;
        const sizes=new Set(geometries.map(g=>JSON.stringify([g.legacy.W,g.legacy.H])));
        if(sizes.size!==1)return null; // A synthetic TIC has no authoritative single source when grids disagree.
        const frame=root.MsiDisplayGeometry.createFrame({...options,sourceWidth:geometries[0].legacy.W,sourceHeight:geometries[0].legacy.H});
        return frame.calibrated?frame:null;
    }
    function normalizeOutputPlan(sections, plan) {
        const invalid = () => {
            const error = new Error('PPT の出力対象・比較グループを確認してください。');
            error.code = 'REPORT_OUTPUT_PLAN_INVALID';
            throw error;
        };
        const ids = new Set(sections.map(section => section.id)), used = new Set(), groupIds = new Set();
        if (ids.size !== sections.length || !plan || plan.version !== 1 || !Array.isArray(plan.groups)) invalid();
        const groups = plan.groups.map(group => {
            if (!group || typeof group.id !== 'string' || !group.id.trim() || groupIds.has(group.id)
                || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 120
                || !['compare', 'independent'].includes(group.kind) || !Array.isArray(group.sectionIds)
                || !group.sectionIds.length || group.kind === 'independent' && group.sectionIds.length !== 1) invalid();
            groupIds.add(group.id);
            const sectionIds = group.sectionIds.map(id => {
                if (!ids.has(id) || used.has(id)) invalid();
                used.add(id); return id;
            });
            return Object.freeze({ id: group.id, name: group.name.trim(), kind: group.kind,
                sectionIds: Object.freeze(sectionIds) });
        });
        if (!used.size) invalid();
        return Object.freeze({ version: 1, groups: Object.freeze([
            ...groups.filter(group => group.kind === 'compare'), ...groups.filter(group => group.kind === 'independent')]) });
    }
    function createAdapter(hooks, options = {}) {
        const app = hooks.getApp(), project = app && app.project;
        if (!project) throw new Error('プロジェクトを開いてから PPT レポートを作成してください。');
        const session = app.shareMode, shareState = shareSignature(app, project);
        const shared = !!(session || project.__share);
        const viewer = shared && (!session || session.role !== 'admin');
        // Use the existing shared Admin login. Ordinary shared viewers cannot
        // opt in, even if a caller passes includeCeCv or old auth options.
        const includeCeCv = !viewer && options.includeCeCv === true;
        const displaySettings = copy(app.getMsiDisplaySettings ? app.getMsiDisplaySettings()
            : root.MsiDisplaySettings ? root.MsiDisplaySettings.resolve(project) : {aspectMode:'legacy'});
        const displayStyle = options.useDisplayStyle ? copy(hooks.displayStyle ? hooks.displayStyle() : null) : null;
        if(displayStyle) {
            displayStyle.smoothingStrength=MsiSmoothing.normalizeLevel(displaySettings.smoothingStrength);
            displayStyle.linearStrength=MsiSmoothing.normalizeLevel(displaySettings.linearStrength,10);
        }
        if (options.useDisplayStyle && (!displayStyle || !Array.isArray(displayStyle.lut) || displayStyle.lut.length !== 256))
            throw new Error('表示スタイルを取得できません。');
        const manualWindows = copy(app.msiUserWindow || {});
        // The source guard covers the complete inventory even when export omits
        // sections. Selection must not change scientific MRM identity resolution.
        const inventory = (project.sections || []).slice();
        const outputPlan = options.outputPlan == null ? null : normalizeOutputPlan(inventory, options.outputPlan);
        const selectedIds = outputPlan && new Set(outputPlan.groups.flatMap(group => group.sectionIds));
        const sections = selectedIds ? inventory.filter(section => selectedIds.has(section.id)) : inventory;
        const ratioDefinitions = options.includeRatios && typeof app.getRatioDefinitions === 'function'
            ? copy(app.getRatioDefinitions()) : [];
        const ratioDefinitionSignature = JSON.stringify(ratioDefinitions);
        const ratioRoiSignature = ratioDefinitions.length ? JSON.stringify(project.rois || []) : null;
        const ratioGuards = [];
        const ratioInputs = ratioDefinitions.map(definition => ({definition, key:'MSI_RATIO_'+definition.id,
            style:options.useDisplayStyle?copy(typeof app.getRatioDisplayStyle==='function'
                ?app.getRatioDisplayStyle('MSI_RATIO_'+definition.id):displayStyle):null,
            signatures:new Map(sections.map(section => [section.id, typeof app.ratioSignature === 'function'
                ? app.ratioSignature(section,'MSI_RATIO_'+definition.id) : null]))}));
        const ratioManualWindow = (style,section,key) => {
            if(!style || !style.ranges)return manualWindows[key];
            const model=root.MsiRatioModel || (typeof module==='object'&&module.exports?require('./msi-ratio-model.js'):null);
            const scope=style.mode==='individual' && model?model.canonicalSectionId(section):'same';
            // Report tiles cover the whole frame. Cropping a photo/ROI does
            // not opt the export into the viewer's separate ROI-only range.
            return style.ranges.whole && style.ranges.whole[scope];
        };
        const sectionStates = inventory.map(section => ({ section, panel: app.panels.get(section.id), keys: msiKeys(section),
            ratioTransform:copy(hooks.transform ? hooks.transform(section) : identity()),
            calibration: copy(section.meta && section.meta.world_coords), otsu:copy(section.meta && section.meta.otsu),
            referenceTransforms:hooks.referenceTransforms ? {...copy(hooks.referenceTransforms(section)),
                registeredPitch:copy(section.meta && section.meta.world_coords && section.meta.world_coords.msi_um_per_px),
                aspectMode:displaySettings.aspectMode,geometries:{}} : null }));
        const jobs = [], groups = new Map(), voltagePairs = [];
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
                if (meta.ce != null && meta.cv != null && Number.isFinite(Number(meta.ce)) && Number.isFinite(Number(meta.cv)))
                    voltagePairs.push([Number(meta.ce), Number(meta.cv)]);
                const job = { state, key, entry, archiveProvenance: copy(entry && entry.archiveProvenance), image: (section.images || {})[key], scientificId,
                    registeredBase: sourceMeta(entry, key).base,
                    source: sourceSignature(state.panel, key, entry), meta: viewer ? viewerMeta(key, meta, sourceMeta(entry, key).base) : meta,
                    transform: copy(hooks.transform ? hooks.transform(section) : identity()),
                    pixelPitch: copy(section.meta && section.meta.world_coords && section.meta.world_coords.msi_um_per_px),
                    rawRange:copy(entry && entry.rawRange), rawDispMax:finite(entry && entry.rawDispMax),
                    rawTrueMax:entry && entry.quantVersion==='msi-source-rows-v1'?finite(entry.rawTrueMax):null,
                    window:outputPlan ? null : copy(manualWindows[key]) };
                jobs.push(job);
            }
        }
        if (!jobs.length) throw new Error('このプロジェクトには MSI レイヤーが登録されていません。');
        if (!includeCeCv) for (const job of jobs) job.meta = voltageFreeMeta(job.key, job.meta, job.registeredBase, voltagePairs);
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
                subtitle: transitionSubtitle(job.meta) + (repeat && includeCeCv ? '  |  測定: ' + job.key.replace(/^MSI_/i, '') : ''),
                metadata: job.meta, jobs: [] });
            groups.get(groupId).jobs.push(job);
        }
        // Build the same scientific identities as before, then restrict output.
        // An excluded duplicate transition must not alter matching of others.
        if (selectedIds) for (const [key, group] of groups) {
            group.jobs = group.jobs.filter(job => selectedIds.has(job.state.section.id));
            if (!group.jobs.length) groups.delete(key);
            else {
                const first = group.jobs[0], repeat = ambiguous.has(first.scientificId);
                group.layerKey = first.key; group.metadata = first.meta; group.name = label(first.key, first.meta);
                group.subtitle = transitionSubtitle(first.meta)
                    + (repeat && includeCeCv ? '  |  測定: ' + first.key.replace(/^MSI_/i, '') : '');
            }
        }
        const selectedStates = sectionStates.filter(state => !selectedIds || selectedIds.has(state.section.id));
        const selectedJobCount = Array.from(groups.values()).reduce((count, group) => count + group.jobs.length, 0);
        if (!selectedJobCount) throw new Error('出力対象の切片には MSI レイヤーが登録されていません。');
        if (!includeCeCv) {
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
            if (shared && includeCeCv && session.expiresAt != null) {
                const expiresAt = Date.parse(session.expiresAt);
                if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw staleError();
            }
            const current = hooks.getApp();
            if (current !== app || current.project !== project || current.shareMode !== session
                || shareSignature(current, project) !== shareState
                || (project.sections || []).length !== inventory.length) throw staleError();
            if (ratioDefinitions.length && (JSON.stringify(app.getRatioDefinitions()) !== ratioDefinitionSignature
                || JSON.stringify(project.rois || []) !== ratioRoiSignature)) throw staleError();
            for (const input of ratioInputs) for (const section of sections) {
                if (typeof app.ratioSignature === 'function' && app.ratioSignature(section,input.key) !== input.signatures.get(section.id))
                    throw staleError();
                if(input.style && input.style.otsu && JSON.stringify(section.meta && section.meta.otsu)!==
                    JSON.stringify(sectionStates.find(state=>state.section===section).otsu))throw staleError();
            }
            for (const guard of ratioGuards) guard();
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
                    || JSON.stringify(job.entry && job.entry.archiveProvenance) !== JSON.stringify(job.archiveProvenance)
                    || moleculeIdentity(job.key, liveMeta(job.entry, job.key)) !== job.scientificId) throw staleError();
            }
        }
        async function loadJob(job) {
            assertCurrent();
            const { section, panel } = job.state;
            const result = { sectionId: section.id, name: sectionName(section),
                transform: copy(job.transform), pixelPitch: copy(job.pixelPitch), metadata: copy(job.meta),
                registeredPixelPitch: registeredPitchValue(job.pixelPitch),
                stats: { mean: null, max: null, n: null },
                archiveProvenance: root.ProjectArchive ? root.ProjectArchive.provenance(job.archiveProvenance) : null,
                qualityNote: root.ProjectArchive ? root.ProjectArchive.qualityLabel(job.archiveProvenance) : '' };
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
                    result.raster = { W: raster.W, H: raster.H, values: raster.values.slice() };
                    if (raster.measuredMask) result.raster.measuredMask = raster.measuredMask.slice();
                    const snapshotSection = {...section,meta:{...section.meta,world_coords:copy(job.state.calibration),otsu:copy(job.state.otsu)}};
                    result.pixelPitch = pitchValue(hooks.pixelPitch ? hooks.pixelPitch(snapshotSection, job.key) : job.pixelPitch);
                    if (root.MsiDisplayGeometry) {
                        const geometry = hooks.sourceGeometry ? hooks.sourceGeometry(section, job.key) : job.entry.sourceGeometry;
                        if(job.state.referenceTransforms && geometry)job.state.referenceTransforms.geometries[job.key]={
                            legacy:geometry.legacy && {W:geometry.legacy.W,H:geometry.legacy.H},
                            displayGeometry:geometry.displayGeometry && {W:geometry.displayGeometry.W,H:geometry.displayGeometry.H}};
                        result.frame = root.MsiDisplayGeometry.createFrame({width:raster.W,height:raster.H,
                            sourceWidth:geometry && geometry.legacy && geometry.legacy.W,
                            sourceHeight:geometry && geometry.legacy && geometry.legacy.H,
                            registeredPitch:job.pixelPitch,orientation:job.transform,aspectMode:displaySettings.aspectMode});
                        result.transform = result.frame.matrix;
                        result.pixelPitch = result.frame.calibrated ? result.frame.displayPitch : null;
                    }
                    if (displayStyle) {
                        const candidate = Array.isArray(job.rawRange) ? job.rawRange : job.entry.rawRange;
                        const rr = Array.isArray(candidate) && candidate.length===2 && candidate.every(Number.isFinite) ? candidate : null;
                        result.displayAuto = {rawRange:rr,max:displayStyle.rangePolicy === 'maximum'
                            ? (job.rawTrueMax ?? finite(job.entry.rawTrueMax)) : (job.rawDispMax ?? finite(job.entry.rawDispMax) ?? (rr && rr[1]))};
                        // Match the main viewer's original-measurement maximum.
                        // Only legacy records without that statistic fall back
                        // to the finite value raster, never clipped PNG values.
                        if(result.displayAuto.max==null) {
                            let maximum = -Infinity;const captured=result.raster;
                            for (let i=0;i<captured.values.length;i++) {
                                if(i%262144===0){assertCurrent();if(hooks.yieldControl)await hooks.yieldControl();}
                                if ((!captured.measuredMask || captured.measuredMask[i]) && Number.isFinite(captured.values[i])) maximum=Math.max(maximum,captured.values[i]);
                            }
                            result.displayAuto.max = Number.isFinite(maximum)?maximum:rr?rr[1]:255;
                        }
                        if (!outputPlan) result.manualWindow = copy(job.window);
                        const keep = displayStyle.otsu && hooks.keepGrid ? hooks.keepGrid(snapshotSection,job.key) : null;
                        if (keep && keep.W===raster.W && keep.H===raster.H && keep.keep.length===raster.W*raster.H)
                            result.keepGrid = {W:keep.W,H:keep.H,keep:keep.keep.slice()};
                    }
                    const maximum = hooks.max ? hooks.max(job.entry) : null;
                    result.stats = { mean: finite(hooks.mean ? hooks.mean(job.entry) : null),
                        max: finite(maximum && typeof maximum === 'object' ? maximum.value : maximum),
                        n: job.entry.quantVersion === 'msi-source-rows-v1' ? finite(job.entry.sourceStats && job.entry.sourceStats.n) : null };
                }
            }
            completed++;
            if (options.onProgress) options.onProgress({ phase: 'load', index: completed, total: selectedJobCount+ratioInputs.length*sections.length,
                moleculeName: label(job.key, job.meta), sectionName: result.name });
            if (hooks.yieldControl) await hooks.yieldControl();
            assertCurrent();
            return result;
        }
        const memo = project.memo || {};
        const metadata = {};
        const cleanOutput = value => includeCeCv ? copy(value) : withoutVoltages(value, voltagePairs);
        function sectionName(section) {
            return cleanOutput(section.displayName || ('Section ' + (section.ordinal || ''))) || 'Section ' + (section.ordinal || '');
        }
        for (const key of ['sample', 'sampleTypes', 'experimentDate', 'machine', 'freeNote', 'matrix', 'derivatization']) {
            if (memo[key] != null && memo[key] !== '') metadata[key] = cleanOutput(memo[key]);
        }
        metadata.sections = sections.map(section => ({ sectionId: section.id,
            name: sectionName(section),
            acquisition: viewer ? {} : cleanOutput(section.meta && section.meta.raw || {}),
            pixelPitch: pitchValue(section.meta && section.meta.world_coords && section.meta.world_coords.msi_um_per_px) }));
        const input = { projectName: cleanOutput(project.displayName || 'Project') || 'Project', generatedAt: options.generatedAt || new Date().toISOString(),
            metadata, displayStyle, ...(outputPlan ? {outputPlan} : {}),
            sections: metadata.sections.map(section => ({ id: section.sectionId, name: section.name })),
            molecules: Array.from(groups.values(), group => ({ key: group.key, layerKey: group.layerKey, name: group.name,
                subtitle: group.subtitle, metadata: copy(group.metadata), async loadEntries() {
                    assertCurrent();
                    const entries = [];
                    for (const section of sections) {
                        const job = group.jobs.find(item => item.state.section === section);
                        if (job) entries.push(await loadJob(job));
                    }
                    if (displayStyle && !outputPlan) {
                        const maximum = Math.max(0,...entries.filter(e=>e.displayAuto).map(e=>e.displayAuto.max));
                        for (const entry of entries) if (entry.displayAuto) {
                            const auto=entry.displayAuto,u=entry.manualWindow||{};
                            const individual=displayStyle.mode==='individual',rr=auto.rawRange,isMaximum=displayStyle.rangePolicy==='maximum';
                            const defMin=isMaximum?0:individual ? (rr?rr[0]:0) : maximum>0?0:rr?rr[0]:0;
                            const autoMax=individual?auto.max:maximum;
                            const defMax=isMaximum?(autoMax>0?autoMax:1):individual ? auto.max : maximum>0?maximum:rr?rr[1]:255;
                            const min=finite(u.min) ?? defMin;
                            let max=finite(u.max) ?? defMax;
                            if (!(max>min)) max=min+(Math.abs(defMax-defMin)||1);
                            entry.displayWindow={min,max};
                        }
                    }
                    return entries;
                } })), assertCurrent, async loadSectionReferences() {
                    const references = [];
                    if (!hooks.referenceImage) return references;
                    for (const state of selectedStates) {
                        assertCurrent();
                        const result = await hooks.referenceImage(state.section, state.panel, state.referenceTransforms);
                        assertCurrent();
                        if (result && result.referenceImage) references.push({ id: state.section.id, name: sectionName(state.section),
                            referenceImage: result.referenceImage, referenceLabel: result.referenceLabel === 'Optical' ? 'Optical' : 'TIC' });
                    }
                    return references;
                } };
        const cleanRatioText = value => includeCeCv ? String(value || '') : String(value || '').split(/\s+\/\s+/)
            .map(part => voltageFreeText(part,voltagePairs,true)).join(' / ');
        for (const ratioInput of ratioInputs) {
            const definition=ratioInput.definition, ratioStyle=ratioInput.style;
            const model=root.MsiRatioModel || (typeof module==='object'&&module.exports?require('./msi-ratio-model.js'):null);
            const bindingFor = section => {
                const bindings=definition.bindings || {};
                return bindings[model ? model.canonicalSectionId(section) : section.id] || bindings[section.id];
            };
            const bindingFormula = binding => cleanRatioText(binding && binding.numerator && binding.numerator.labelHint || 'X')+' / '
                +cleanRatioText(binding && binding.denominator && binding.denominator.labelHint || 'Y');
            const first=outputPlan ? sections.map(bindingFor).find(Boolean) : Object.values(definition.bindings || {})[0];
            const formula=bindingFormula(first);
            const ratio={id:definition.id,formula,denominatorMin:definition.denominatorMin || 0,
                calculationVersion:definition.calculationVersion || 'msi-ratio-v1'};
            input.molecules.push({kind:'ratio',key:ratioInput.key,layerKey:ratioInput.key,
                displayStyle:ratioStyle,
                name:cleanRatioText(definition.name || formula) || 'Ratio',
                subtitle:formula+'  |  Y > '+ratio.denominatorMin,ratio,metadata:{formula,denominatorMin:ratio.denominatorMin,
                    calculationVersion:ratio.calculationVersion},async loadEntries() {
                    assertCurrent();
                    const entries=[];
                    for (const state of selectedStates) {
                        const section=state.section, entry={sectionId:section.id,name:sectionName(section),
                            stats:{mean:null,max:null,n:null},ratioStatistics:null,ratioRois:[],metadata:{formula},
                            registeredPixelPitch:registeredPitchValue(state.calibration && state.calibration.msi_um_per_px),
                            transform:copy(state.ratioTransform)};
                        if (outputPlan) entry.metadata.formula=bindingFormula(bindingFor(section));
                        if (typeof app.resolveRatio !== 'function') entry.missingReason='比の数値データを読み込めません。';
                        else {
                            let resolved;
                            try { resolved=await app.resolveRatio(section,ratioInput.key,{signal:options.signal}); }
                            catch(error) {
                                assertCurrent();
                                if(error && error.name==='AbortError')throw error;
                                entry.missingReason='この切片の比の元データを読み込めませんでした。';
                            }
                            assertCurrent();
                            if (resolved && typeof resolved.assertCurrent === 'function') {
                                resolved.assertCurrent();ratioGuards.push(resolved.assertCurrent);
                            }
                            if(resolved && resolved.formula)entry.metadata.formula=cleanRatioText(resolved.formula);
                            const raster=resolved && resolved.raster;
                            if (!raster || !(raster.W>0 && raster.H>0) || !raster.values || raster.values.length!==raster.W*raster.H)
                                entry.missingReason=entry.missingReason || cleanRatioText(resolved && resolved.reason || 'この切片で比を利用できません。');
                            else {
                                entry.raster={W:raster.W,H:raster.H,values:raster.values.slice()};
                                const mask=raster.measuredMask || raster.validMask;
                                if(mask)entry.raster.measuredMask=mask.slice();
                                entry.ratioStatistics=copy(resolved.statistics || resolved.summary || null);
                                entry.ratioRois=(resolved.roiStats || []).map(row=>({roiId:row.roiId || row.id,
                                    name:cleanRatioText(row.name || 'ROI'),status:row.status || 'ready',
                                    reason:cleanRatioText(row.reason || ''),statistics:copy(row.statistics || row.summary || null)}));
                                const geometry=raster.sourceGeometry || resolved.sourceGeometry;
                                const calibration=state.calibration || {};
                                if(root.MsiDisplayGeometry) {
                                    entry.frame=root.MsiDisplayGeometry.createFrame({width:raster.W,height:raster.H,
                                        sourceWidth:geometry && geometry.legacy && geometry.legacy.W,
                                        sourceHeight:geometry && geometry.legacy && geometry.legacy.H,
                                        registeredPitch:calibration.msi_um_per_px,orientation:entry.transform,
                                        aspectMode:ratioStyle && ratioStyle.aspectMode || displaySettings.aspectMode});
                                    entry.transform=entry.frame.matrix;
                                    entry.pixelPitch=entry.frame.calibrated?entry.frame.displayPitch:null;
                                }
                                if(ratioStyle) {
                                    let maximum=0;
                                    for(let i=0;i<raster.values.length;i++) {
                                        if(i%262144===0){assertCurrent();if(hooks.yieldControl)await hooks.yieldControl();}
                                        if((!mask || mask[i]) && Number.isFinite(raster.values[i]))maximum=Math.max(maximum,raster.values[i]);
                                    }
                                    const auto=resolved.displayAuto;
                                    const rawMaximum=resolved.statistics && resolved.statistics.max;
                                    const upper=ratioStyle.outlierClip && finite(resolved.robustMax)!=null?resolved.robustMax:
                                        auto && finite(auto.max) != null?auto.max:
                                        ratioStyle.rangePolicy==='maximum' && finite(rawMaximum)!=null?rawMaximum:maximum;
                                    entry.displayAuto={max:upper,rawRange:auto && copy(auto.rawRange) || [0,upper]};
                                    if (!outputPlan) entry.manualWindow=copy(ratioManualWindow(ratioStyle,section,ratioInput.key));
                                    const keep=resolved.keepGrid;
                                    if(ratioStyle.otsu && keep && keep.W===raster.W && keep.H===raster.H)
                                        entry.keepGrid={W:keep.W,H:keep.H,keep:keep.keep.slice()};
                                }
                            }
                        }
                        entries.push(entry);
                        if(options.onProgress)options.onProgress({phase:'load',index:++completed,
                            total:selectedJobCount+ratioInputs.length*sections.length,moleculeName:cleanRatioText(definition.name || formula),sectionName:entry.name});
                        if(hooks.yieldControl)await hooks.yieldControl();
                        assertCurrent();
                    }
                    if(ratioStyle && !outputPlan) {
                        const sharedMaximum=Math.max(0,...entries.filter(e=>e.displayAuto).map(e=>e.displayAuto.max));
                        for(const entry of entries)if(entry.displayAuto) {
                            const automatic=ratioStyle.mode==='individual'?entry.displayAuto.max:sharedMaximum;
                            const manual=entry.manualWindow || {},min=finite(manual.min) ?? 0;
                            let max=finite(manual.max) ?? (automatic>0?automatic:1);
                            if(!(max>min))max=min+1;
                            entry.displayWindow={min,max};
                        }
                    }
                    return entries;
                }});
        }
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
    // Deliberately tab-local: no project, IndexedDB, or shared-project writes.
    const selectionHistory = new WeakMap();
    function reconcileSelection(sections, previous) {
        const groups = previous ? copy(previous.groups) : [];
        const groupIds = new Set(groups.map(group => group.id));
        const previousAssignments = new Map((previous && previous.assignments || []).map(row => [row.sectionId, row]));
        return { groups, assignments: sections.map(section => {
            const row = previousAssignments.get(section.id);
            return { sectionId: section.id, included: row ? row.included !== false : true,
                groupId: row && groupIds.has(row.groupId) ? row.groupId : '' };
        }) };
    }
    function selectionPlan(sections, state) {
        return normalizeOutputPlan(sections, { version: 1, groups: [
            ...state.groups.map(group => ({...group, kind:'compare', sectionIds: state.assignments
                .filter(row => row.included && row.groupId === group.id).map(row => row.sectionId)}))
                .filter(group => group.sectionIds.length),
            ...state.assignments.filter(row => row.included && !row.groupId).map((row, index) => ({
                id:'independent-' + (index + 1), name:'独立', kind:'independent', sectionIds:[row.sectionId] }))
        ] });
    }
    function selectionControls(doc, sections, state, create) {
        const container = doc.createElement('div');
        const el = (tag, label) => { const node = doc.createElement(tag); if (label != null) node.textContent = label; return node; };
        const button = (label, attribute) => { const node = el('button', label); node.type='button'; node.className='btn'; node.setAttribute(attribute, ''); return node; };
        const toolbar = el('div'); toolbar.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin:12px 0';
        const add = button('比較グループを追加', 'data-report-add-group');
        const allIndependent = button('すべて独立にする', 'data-report-all-independent');
        toolbar.append(add, allIndependent);
        const manager = el('div');
        const bulk = el('div'); bulk.style.cssText=toolbar.style.cssText;
        const bulkGroup = el('select'); bulkGroup.setAttribute('data-report-bulk-group',''); bulkGroup.setAttribute('aria-label','選択した切片の比較グループ');
        const apply = button('選択した切片に適用', 'data-report-apply-group');
        bulk.append(bulkGroup, apply);
        const scroll = el('div'); scroll.style.cssText='max-height:32vh;overflow:auto;border:1px solid #cbd5e1;border-radius:6px';
        const table = el('table'); table.style.cssText='border-collapse:collapse;width:100%;font-size:13px';
        const head = el('thead'), heading = el('tr');
        const selectHead = el('th'), selectAll = el('input'); selectAll.type='checkbox';
        selectAll.setAttribute('aria-label','一括変更する切片をすべて選択'); selectAll.setAttribute('data-report-select-all','');
        selectHead.append(selectAll); heading.append(selectHead);
        for (const title of ['出力','切片','比較・独立','適用するRange']) heading.append(el('th',title));
        head.append(heading); const body=el('tbody'); table.append(head,body); scroll.append(table);
        const summary = el('p'); summary.setAttribute('data-report-summary',''); summary.setAttribute('role','status');
        summary.style.cssText='font-size:13px;line-height:1.6;white-space:pre-line';
        const rows = sections.map((section, index) => {
            const assignment = state.assignments[index], tr=el('tr'); tr.setAttribute('data-report-section-id',String(section.id));
            const checked=el('input'); checked.type='checkbox'; checked.setAttribute('data-report-select',''); checked.setAttribute('aria-label','一括変更: '+(section.displayName || '切片 '+(index+1)));
            const included=el('input'); included.type='checkbox'; included.checked=assignment.included; included.setAttribute('data-report-output',''); included.setAttribute('aria-label','出力: '+(section.displayName || '切片 '+(index+1)));
            const group=el('select'); group.setAttribute('data-report-group',''); group.setAttribute('aria-label','比較・独立: '+(section.displayName || '切片 '+(index+1)));
            const range=el('span');
            for (const value of [checked,included,el('span',section.displayName || '切片 '+(index+1)),group,range]) {
                const cell=el('td');cell.style.cssText='padding:8px;border-top:1px solid #e2e8f0;overflow-wrap:anywhere';cell.append(value);tr.append(cell);
            }
            body.append(tr);
            included.addEventListener('change',()=>{assignment.included=included.checked;refreshSummary();});
            group.addEventListener('change',()=>{assignment.groupId=group.value;refreshSummary();});
            checked.addEventListener('change',refreshSummary);
            return {assignment,checked,included,group,range};
        });
        const fillSelect = (select, value) => {
            select.replaceChildren(); const independent=el('option','独立'); independent.value=''; select.append(independent);
            for (const group of state.groups) {const option=el('option',group.name || '名称未入力');option.value=group.id;select.append(option);}
            select.value=value;
        };
        function refreshSummary() {
            const selected=rows.filter(row=>row.checked.checked).length;
            selectAll.checked=rows.length>0 && selected===rows.length;
            selectAll.indeterminate=selected>0 && selected<rows.length;
            apply.disabled=!selected;
            const included=state.assignments.filter(row=>row.included);
            const comparisons=state.groups.map(group=>({group,count:included.filter(row=>row.groupId===group.id).length}));
            const independent=included.filter(row=>!row.groupId).length;
            summary.textContent='出力 '+included.length+' 切片／独立 '+independent+' 切片／除外 '+(rows.length-included.length)+' 切片'
                + comparisons.filter(item=>item.count).map(({group,count})=>'\n'+group.name+'：'+count+' 切片'+(count===1?'（1切片のみ）':'')+'・共通自動Range').join('');
            create.disabled=!included.length || comparisons.some(({group,count})=>count>0 && !group.name.trim());
            for (const row of rows) {
                row.group.disabled=!row.assignment.included;
                row.range.textContent=!row.assignment.included?'出力しない':row.assignment.groupId?'グループ共通・自動':'この切片のみ・自動';
            }
        }
        function refreshGroups() {
            const bulkValue=bulkGroup.value;
            fillSelect(bulkGroup,state.groups.some(group=>group.id===bulkValue)?bulkValue:'');
            for (const row of rows) fillSelect(row.group,row.assignment.groupId);
            manager.replaceChildren();
            for (const group of state.groups) {
                const line=el('div');line.setAttribute('data-report-group-id',group.id);line.style.cssText=toolbar.style.cssText;
                const name=el('input'); name.type='text';name.value=group.name;name.maxLength=120;name.required=true;
                name.style.cssText='border:1px solid #cbd5e1;border-radius:4px;padding:6px 8px;background:white;max-width:100%';name.title='比較グループ名';name.placeholder='比較グループ名';
                name.setAttribute('data-report-group-name','');name.setAttribute('aria-label','比較グループ名');
                const remove=button('削除','data-report-delete-group'); remove.setAttribute('aria-label',group.name+'を削除');
                name.addEventListener('input',()=>{
                    group.name=name.value;for(const row of rows)fillSelect(row.group,row.assignment.groupId);
                    const current=bulkGroup.value;fillSelect(bulkGroup,current);refreshSummary();
                });
                remove.addEventListener('click',()=>{
                    state.groups=state.groups.filter(item=>item!==group);
                    for(const row of state.assignments)if(row.groupId===group.id)row.groupId='';
                    refreshGroups();add.focus();
                });
                line.append(name,remove);manager.append(line);
            }
            refreshSummary();
        }
        add.addEventListener('click',()=>{
            let index=1;while(state.groups.some(group=>group.id==='compare-'+index))index++;
            const group={id:'compare-'+index,name:'比較グループ '+(index<=26?String.fromCharCode(64+index):index)};
            state.groups.push(group);refreshGroups();bulkGroup.value=group.id;
            manager.lastElementChild.querySelector('input').focus();
        });
        allIndependent.addEventListener('click',()=>{state.assignments.forEach(row=>{row.groupId='';});refreshGroups();});
        apply.addEventListener('click',()=>{for(const row of rows)if(row.checked.checked)row.assignment.groupId=bulkGroup.value;refreshGroups();});
        selectAll.addEventListener('change',()=>{for(const row of rows)row.checked.checked=selectAll.checked;refreshSummary();});
        container.append(toolbar,manager,bulk,scroll,summary);refreshGroups();
        return container;
    }
    function selectReportOptions(doc, canIncludeCeCv, hasRatios = false, project) {
        return new Promise(resolve => {
            const focused = doc.activeElement;
            const overlay = doc.createElement('div');
            overlay.className = 'project-report-options';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:12000;background:#0008;display:flex;align-items:center;justify-content:center;padding:20px';
            const dialog = doc.createElement('div');
            dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-label', 'PPT レポートの設定');
            dialog.setAttribute('aria-describedby', 'project-report-options-help');
            dialog.style.cssText = 'background:white;color:#1e293b;border-radius:10px;padding:24px;width:min(900px,100%);max-height:90vh;overflow:auto;box-shadow:0 12px 40px #0005';
            const title = doc.createElement('h2'); title.textContent = 'PPT レポートの設定';
            title.style.cssText = 'font-size:18px;font-weight:600;margin:0 0 16px';
            const label = doc.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:600';
            const checkbox = doc.createElement('input'); checkbox.type = 'checkbox';
            checkbox.id = 'project-report-include-ce-cv'; checkbox.checked = false;
            label.append(checkbox, doc.createTextNode('CV・CEを含める'));
            const styleLabel = doc.createElement('label');
            styleLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:600;margin:14px 0';
            const style = doc.createElement('input'); style.type='checkbox';style.id='project-report-use-display-style';style.checked=false;
            styleLabel.append(style,doc.createTextNode('表示スタイルを使う（配色・補間・Otsu）'));
            const ratioLabel=doc.createElement('label');ratioLabel.style.cssText=styleLabel.style.cssText;
            const ratios=doc.createElement('input');ratios.type='checkbox';ratios.id='project-report-include-ratios';ratios.checked=hasRatios;
            ratioLabel.append(ratios,doc.createTextNode('比の画像・ROI集計を含める（このタブの比を含む）'));
            const help = doc.createElement('p'); help.id = 'project-report-options-help';
            help.textContent = '初期設定は全切片を独立で出力します。同じ比較グループは分子ごとに共通の自動Range、独立切片はそれぞれの自動Rangeを使います。手動Range・画面のSame/Individual設定は使いません。標準はp99.8、表示スタイルを使う場合は画面の自動上限方式を使います。全分子のうち各切片に登録のあるものを掲載し、比の利用不可表示は残します。設定はこのタブで同じプロジェクトを開いている間だけ保持します。';
            help.style.cssText = 'font-size:13px;line-height:1.6;margin:12px 0 20px';
            const actions = doc.createElement('div'); actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
            const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.className = 'btn';
            cancel.setAttribute('data-report-cancel', ''); cancel.textContent = 'キャンセル';
            const create = doc.createElement('button'); create.type = 'button'; create.className = 'btn';
            create.setAttribute('data-report-create', ''); create.textContent = '作成';
            const sections = project ? (project.sections || []).slice() : [];
            const selection = reconcileSelection(sections, project && selectionHistory.get(project));
            const controls = project ? selectionControls(doc,sections,selection,create) : null;
            const close = result => {
                overlay.remove();
                if (focused && typeof focused.focus === 'function') focused.focus();
                resolve(result);
            };
            cancel.addEventListener('click', () => close(null));
            create.addEventListener('click', () => {
                const outputPlan = project ? selectionPlan(sections,selection) : null;
                if (project) selectionHistory.set(project,copy(selection));
                close({ includeCeCv: canIncludeCeCv && checkbox.checked,useDisplayStyle:style.checked,
                    includeRatios:hasRatios && ratios.checked, ...(outputPlan ? {outputPlan, sectionInventory:sections} : {}) });
            });
            overlay.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); close(null); }
                if (event.key === 'Tab') {
                    const focusable = [...dialog.querySelectorAll('input,select,button')].filter(node=>!node.disabled), index = focusable.indexOf(doc.activeElement);
                    event.preventDefault(); focusable[(index + (event.shiftKey ? focusable.length-1 : 1)) % focusable.length].focus();
                }
            });
            actions.append(cancel, create); dialog.append(title);
            if(canIncludeCeCv)dialog.append(label);
            if(hasRatios)dialog.append(ratioLabel);
            dialog.append(styleLabel, help); if(controls)dialog.append(controls); dialog.append(actions); overlay.appendChild(dialog);
            doc.body.appendChild(overlay); (canIncludeCeCv?checkbox:style).focus();
        });
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
                const getApp = () => typeof App !== 'undefined' ? App : root.App;
                const context = captureExportContext(getApp);
                const selected = await selectReportOptions(doc,context.canIncludeCeCv,
                    typeof getApp().getRatioDefinitions==='function' && getApp().getRatioDefinitions().length>0, getApp().project);
                if (!selected) return null;
                const includeCeCv = selected.includeCeCv === true;
                context.assertCurrent();
                if (selected.sectionInventory && (getApp().project.sections.length !== selected.sectionInventory.length
                    || selected.sectionInventory.some((section,index)=>getApp().project.sections[index]!==section))) throw staleError();
                const input = createAdapter({ getApp,
                    transform: section => sectionLayerViewLinear(section, 'msi'),
                    pixelPitch: (section, key) => msiDisplayPhysicalPitch(section, key),
                    sourceGeometry:(section,key)=>msiLayerSourceGeometry(section,key),
                    displayStyle:()=>({mode:getApp().msiScaleMode==='individual'?'individual':'same',
                        rangePolicy:getApp().getMsiDisplaySettings ? getApp().getMsiDisplaySettings().rangePolicy
                            : root.MsiDisplaySettings ? root.MsiDisplaySettings.resolve(getApp().project).rangePolicy : 'legacy',
                        lut:getActiveColormap().map(c=>c.slice()),background:getColormapBackground().slice(),
                        colormap:typeof _activeColormapName==='string'?_activeColormapName:'',
                        smoothing:['linear','median'].includes(getApp().msiSmoothing)?getApp().msiSmoothing:'none',otsu:!!getApp().otsuBgRemove}),
                    keepGrid:(section,key)=>_otsuKeepGridRaw(section,key),
                    referenceTransforms:section=>({msi:sectionLayerViewLinear(section,'msi'),he:sectionLayerViewLinear(section,'he')}),
                    referenceImage: async (section, panel, transforms) => {
                        if (!panel || !panel.imageSources) return null;
                        const loaded = image => image && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
                        const registered = Object.keys(section.images || {}).filter(key => /^HE_STAIN/i.test(key)
                            && key !== 'HE_STAIN_TIC');
                        for (const key of registered) {
                            if (!loaded(panel.imageSources[key]) && panel.ensureImageLayerLoaded)
                                await panel.ensureImageLayerLoaded(key, {priority:0});
                            context.assertCurrent();
                            if (loaded(panel.imageSources[key])) break;
                        }
                        const opticalKey = registered.find(key => loaded(panel.imageSources[key]));
                        if (!opticalKey && panel.ensureTicBackdrop) {
                            await panel.ensureTicBackdrop({explicit:true});
                            context.assertCurrent();
                        }
                        const source = opticalKey ? panel.imageSources[opticalKey] : panel.imageSources.HE_STAIN_TIC;
                        if (!loaded(source)) return null;
                        try {
                            const frame=opticalKey?null:referenceFrame({width:source.naturalWidth,height:source.naturalHeight,
                                geometries:Object.keys(section.msiSeries||{}).filter(key=>loaded(panel.imageSources[key])
                                    && panel.imageSources[key].naturalWidth===source.naturalWidth
                                    && panel.imageSources[key].naturalHeight===source.naturalHeight)
                                    .map(key=>transforms.geometries[key]),
                                registeredPitch:transforms.registeredPitch,orientation:transforms.msi,aspectMode:transforms.aspectMode});
                            const referenceImage = await root.ProjectReportData.renderReference(source,
                                frame?frame.matrix:transforms[opticalKey ? 'he' : 'msi'],
                                { createCanvas: () => doc.createElement('canvas'),frame,
                                    drawingRects:frame?root.MsiDisplayGeometry.drawingRects(frame):null });
                            return { referenceImage, referenceLabel: opticalKey ? 'Optical' : 'TIC' };
                        } catch (_) { return null; }
                    },
                    mean: entry => msiQuantMean(entry), max: entry => msiMaxIntensity(entry),
                    findCompoundMeta: (project, key) => findCompoundMeta(project, key),
                    formatDisplayName: key => formatDisplayName(key),
                    yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)) },
                { includeCeCv, includeRatios:selected.includeRatios,useDisplayStyle:selected.useDisplayStyle,outputPlan:selected.outputPlan,
                    signal: controller.signal, onProgress: event => progress && progress.update(event) });
                progress = openProgress(doc, () => controller.abort());
                if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
                const libs = root.LAZY_LIBS || {};
                await root.loadScript(libs.jszip || '../vendor/jszip.min.js'); input.assertCurrent();
                await root.loadScript(libs.pptxgen || '../vendor/pptxgen.min.js'); input.assertCurrent();
                await root.loadScript(libs.projectReportData || 'project-report-data.js?v=' + REPORT_REVISION); input.assertCurrent();
                await root.loadScript(libs.projectReportDeck || 'project-report-deck.js?v=' + REPORT_REVISION); input.assertCurrent();
                assertReportModules(root.ProjectReportData, root.ProjectReportDeck);
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
    return { REPORT_REVISION, assertReportModules, createAdapter, captureExportContext, moleculeIdentity, safeFileName, exportCurrent,referenceFrame,
        normalizeOutputPlan, reconcileSelection, selectionPlan };
});
