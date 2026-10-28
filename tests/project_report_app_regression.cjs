'use strict';
const assert = require('node:assert/strict');
const report = require('../viewer/project-report-app.js');

function fixture() {
    const makeEntry = (id, meta = {}) => ({ blobId: id, kind: 'txt', compoundMeta: { base: 'Dopamine',
        precursor: 154.1, product: 137.1, ce: 15, cv: 20, polarity: '+', ...meta },
        quantVersion: 'msi-source-rows-v1', rawMean: 140 / 3, rawTrueMax: 100, sourceStats: { n: 3 } });
    const sections = ['left', 'right'].map((id, index) => ({ id, ordinal: index + 1, displayName: '切片 ' + (index + 1),
        meta: { raw: { instrument: 'Registered instrument', desi: { solvent: 'registered' } },
            world_coords: { msi_um_per_px: { x: 50, y: 75 } } },
        msiSeries: { MSI_DA: makeEntry(id) }, images: {} }));
    const project = { id: 'p', displayName: '測定プロジェクト', sections,
        memo: { sample: '試料', sampleTypes: ['脳'], experimentDate: '2026-10-28', machine: 'DESI',
            freeNote: '解析メモ', matrix: '', derivatization: 'registered derivatization', googleKeep: 'private link' },
        shareInfo: { viewerPassword: 'secret' }, rois: [] };
    const calls = [];
    const app = { project, panels: new Map(), shareMode: null, methodFilter: 'hidden',
        focusCompoundKey: 'MSI_other', msiScaleMode: 'relative', selectedSectionIds: ['left'] };
    for (const section of sections) {
        const panel = { section, project, visibleLayers: new Set(), msiValueRasters: new Map(),
            _msiLoadIdentity(key) { const e = section.msiSeries[key] || {}; return JSON.stringify([e.blobId, e.sourceUrl, e.sourceRevision]); },
            async ensureMsiLayerLoaded(key) {
                calls.push([section.id, key]);
                this.msiValueRasters.set(key, { W: 2, H: 1, values: new Float64Array([20, 100]) });
                return true;
            } };
        app.panels.set(section.id, panel);
    }
    const transform = [[0, -1, 0], [-1, 0, 0], [0, 0, 1]];
    const hooks = { getApp: () => app, transform: () => transform,
        mean: entry => entry.quantVersion === 'msi-source-rows-v1' ? entry.rawMean : null,
        max: entry => ({ value: entry.quantVersion === 'msi-source-rows-v1' ? entry.rawTrueMax : null }) };
    return { app, project, sections, calls, hooks, transform, makeEntry };
}

function sharedFixture(role = 'viewer') {
    const f = fixture();
    f.project.__share = true;
    f.app.shareMode = { role, slug: 'shared-project', token: 'private-session-token', isPublic: role !== 'admin' };
    for (const section of f.sections) {
        Object.assign(section.meta.raw, { instrument: 'private-acquisition-instrument',
            desi: { coneVoltage: 620.98765, collisionEnergy: 715.12345, nested: { note: 'private-acquisition-note' } } });
        Object.assign(section.msiSeries.MSI_DA.compoundMeta, {
            base: 'Dopamine', name: 'Dopamine_715.12345_620.98765', ce: 715.12345, cv: 620.98765,
            dwell: 0.87654321, sourceFile: 'private-source-file.txt', instrument: 'private-layer-instrument',
            acquiredAt: 'private-acquisition-date', msMethod: 'private-method-file', tuneMethod: 'private-tune-file',
            calibrationFile: 'private-calibration-file', mz: 154.0868, adduct: '[M+H]+', formula: 'C8H11NO2'
        });
    }
    return f;
}

function assertPublicReport(snapshot) {
    const text = JSON.stringify(snapshot);
    for (const privateText of ['715.12345', '620.98765', '0.87654321', 'private-source-file',
        'private-acquisition', 'private-layer-instrument', 'private-method-file', 'private-tune-file',
        'private-calibration-file', 'private-session-token']) {
        assert.equal(text.includes(privateText), false, privateText + ' must not leave the viewer adapter');
    }
    assert.doesNotMatch(text, /"(?:ce|cv|dwell|sourceFile|msMethod|tuneMethod|calibrationFile|acquiredAt)"\s*:/,
        'private condition fields must not survive in any serializable export metadata');
}

const tests = [
    ['all registered sections load lazily and retain source-row statistics', async () => {
        const f = fixture(), before = JSON.stringify(f.project), input = report.createAdapter(f.hooks);
        assert.equal(input.molecules.length, 1);
        assert.deepEqual(f.calls, [], 'snapshot must not eagerly load every molecule');
        const entries = await input.molecules[0].loadEntries();
        assert.deepEqual(f.calls, [['left', 'MSI_DA'], ['right', 'MSI_DA']]);
        assert.equal(entries.length, 2, 'display section and molecule filters do not limit report scope');
        assert.equal(entries[0].stats.mean, 140 / 3, 'source-row mean must not become raster mean 60');
        assert.deepEqual(entries[0].stats, { mean: 140 / 3, max: 100, n: 3 });
        assert.deepEqual(entries[0].transform, f.transform);
        assert.notEqual(entries[0].transform, f.transform, 'orientation snapshot must be detached');
        assert.deepEqual(entries[0].pixelPitch, { x: 50, y: 75 });
        assert.equal(JSON.stringify(f.project), before);
        assert.equal(f.app.focusCompoundKey, 'MSI_other');
        for (const panel of f.app.panels.values()) assert.equal(panel.visibleLayers.size, 0);
    }],
    ['registered names and metadata survive without sharing credentials', async () => {
        const f = fixture(), input = report.createAdapter(f.hooks);
        assert.equal(input.projectName, '測定プロジェクト');
        assert.equal(input.molecules[0].name, 'Dopamine');
        assert.match(input.molecules[0].subtitle, /154\.1 → 137\.1/);
        assert.equal(input.metadata.freeNote, '解析メモ');
        assert.deepEqual(input.metadata.sampleTypes, ['脳']);
        assert.equal(input.metadata.sections[0].acquisition.instrument, 'Registered instrument');
        assert.equal(input.sections[1].name, '切片 2');
        assert.equal(JSON.stringify(input).includes('secret'), false);
        assert.equal(JSON.stringify(input).includes('private link'), false);
        input.metadata.sampleTypes.push('detached');
        assert.deepEqual(f.project.memo.sampleTypes, ['脳']);
    }],
    ['different transitions and acquisition conditions remain separate', async () => {
        const f = fixture();
        f.sections[1].msiSeries.MSI_DA.compoundMeta.ce = 25;
        f.sections[1].msiSeries.MSI_DA2 = f.makeEntry('other', { dwell: 0.02 });
        const input = report.createAdapter(f.hooks);
        assert.equal(input.molecules.length, 3);
        const entries = await input.molecules[0].loadEntries();
        assert.equal(entries.length, 2);
        assert.ok(entries[1].missingReason, 'unregistered conditions remain visible as unavailable');
        assert.notEqual(report.moleculeIdentity('MSI_DA', { base: 'Dopamine' }),
            report.moleculeIdentity('MSI_DA', { base: 'Dopamine', precursor: 154.1 }));
        assert.equal(report.moleculeIdentity('MSI_DA', { base: 'Dopamine', ce: '15' }),
            report.moleculeIdentity('MSI_DA', { base: 'Dopamine', ce: 15 }));
    }],
    ['same named transition compares across source keys and method indexes', async () => {
        const f = fixture(), entry = f.sections[1].msiSeries.MSI_DA;
        entry.compoundMeta.functionIndex = 4; entry.compoundMeta.channelIndex = 7;
        entry.compoundMeta.msMethod = 'different method file';
        f.sections[1].msiSeries.MSI_DA_POS_2 = entry;
        delete f.sections[1].msiSeries.MSI_DA;
        const input = report.createAdapter(f.hooks);
        assert.equal(input.molecules.length, 1);
        const entries = await input.molecules[0].loadEntries();
        assert.ok(entries.every(item => item.raster));
        assert.deepEqual(f.calls, [['left', 'MSI_DA'], ['right', 'MSI_DA_POS_2']]);
    }],
    ['repeated transitions in a section retain separate registered measurements', async () => {
        const f = fixture(); f.sections[0].msiSeries.MSI_DA_2 = f.makeEntry('replicate');
        const input = report.createAdapter(f.hooks);
        assert.equal(input.molecules.length, 2);
        const measurements = await Promise.all(input.molecules.map(molecule => molecule.loadEntries()));
        const entries = measurements.find(items => items.filter(entry => entry.raster).length === 1);
        assert.ok(entries[0].raster);
        assert.ok(entries[1].missingReason);
    }],
    ['missing local metadata uses the same registered fallback as the app', async () => {
        const f = fixture(); delete f.sections[0].msiSeries.MSI_DA.compoundMeta;
        f.sections[0].msiSeries.MSI_DA.filename = 'left.txt';
        Object.assign(f.sections[1].msiSeries.MSI_DA.compoundMeta, { sourceFile: 'right.txt', acquiredAt: 'other section date' });
        f.hooks.findCompoundMeta = (project, key) => {
            for (const section of project.sections) if (section.msiSeries[key]?.compoundMeta) return section.msiSeries[key].compoundMeta;
            return null;
        };
        f.hooks.formatDisplayName = key => 'Display ' + key.replace(/^MSI_/i, '');
        const input = report.createAdapter(f.hooks);
        assert.equal(input.molecules.length, 1);
        assert.equal(input.molecules[0].name, 'Dopamine');
        const entries = await input.molecules[0].loadEntries();
        assert.equal(entries[0].metadata.precursor, 154.1);
        assert.equal(entries[0].metadata.sourceFile, 'left.txt');
        assert.equal(entries[0].metadata.acquiredAt, undefined, 'cross-section name fallback is not source provenance');
    }],
    ['image-only and absent numeric sources are unavailable, never grayscale', async () => {
        const f = fixture();
        delete f.sections[0].msiSeries.MSI_DA;
        f.sections[0].images.MSI_legacy = { blobId: 'png-only' };
        f.sections[1].msiSeries.MSI_DA.blobId = null;
        const input = report.createAdapter(f.hooks);
        for (const molecule of input.molecules) {
            const entries = await molecule.loadEntries();
            for (const entry of entries) {
                assert.ok(entry.missingReason);
                assert.equal(entry.raster, undefined);
                assert.deepEqual(entry.stats, { mean: null, max: null, n: null });
            }
        }
        assert.deepEqual(f.calls, []);
    }],
    ['successful image decode without numeric raster stays unavailable', async () => {
        const f = fixture();
        f.app.panels.get('left').ensureMsiLayerLoaded = async () => true;
        const entries = await report.createAdapter(f.hooks).molecules[0].loadEntries();
        assert.ok(entries[0].missingReason);
        assert.equal(entries[0].raster, undefined);
        assert.ok(entries[1].raster);
    }],
    ['legacy statistics remain unknown', async () => {
        const f = fixture(); delete f.sections[0].msiSeries.MSI_DA.quantVersion;
        const entry = (await report.createAdapter(f.hooks).molecules[0].loadEntries())[0];
        assert.deepEqual(entry.stats, { mean: null, max: null, n: null });
    }],
    ['source revision changes during decode abort', async () => {
        const f = fixture(), panel = f.app.panels.get('left');
        const original = panel.ensureMsiLayerLoaded;
        panel.ensureMsiLayerLoaded = async function (key) {
            await original.call(this, key);
            f.sections[0].msiSeries.MSI_DA.sourceRevision = 'new';
            return true;
        };
        const input = report.createAdapter(f.hooks);
        await assert.rejects(input.molecules[0].loadEntries(), { code: 'REPORT_SOURCE_CHANGED' });
    }],
    ['project switch, destroyed panels, changed metadata and changed inventory abort', async () => {
        for (const change of [f => { f.app.project = { ...f.project }; },
            f => { f.app.panels.get('left')._destroyed = true; },
            f => { f.sections[1].msiSeries.MSI_DA.compoundMeta.product = 200; },
            f => { f.sections[1].msiSeries.MSI_added = f.makeEntry('new'); }]) {
            const f = fixture(), input = report.createAdapter(f.hooks); change(f);
            assert.throws(input.assertCurrent, { code: 'REPORT_SOURCE_CHANGED' });
        }
    }],
    ['cancellation interrupts loads and source failures remain explicit', async () => {
        const f = fixture(), controller = new AbortController();
        const input = report.createAdapter(f.hooks, { signal: controller.signal, onProgress: () => controller.abort() });
        await assert.rejects(input.molecules[0].loadEntries(), { name: 'AbortError' });
        assert.equal(f.calls.length, 1);
        const failed = fixture(); failed.app.panels.get('left').ensureMsiLayerLoaded = async () => { throw new Error('missing'); };
        assert.ok((await report.createAdapter(failed.hooks).molecules[0].loadEntries())[0].missingReason);
    }],
    ['shared viewers export public names, transitions, Memo, pitch and numeric statistics', async () => {
        const f = sharedFixture(), before = JSON.stringify(f.project), input = report.createAdapter(f.hooks);
        assert.equal(input.projectName, '測定プロジェクト');
        assert.equal(input.molecules.length, 1);
        const molecule = input.molecules[0];
        assert.equal(molecule.name, 'Dopamine');
        assert.equal(molecule.metadata.base, 'Dopamine');
        assert.equal(molecule.metadata.name, 'Dopamine', 'exported aliases must use the registered public base name');
        assert.equal(molecule.metadata.precursor, 154.1);
        assert.equal(molecule.metadata.product, 137.1);
        assert.equal(molecule.metadata.polarity, '+');
        assert.equal(molecule.metadata.mz, 154.0868);
        assert.equal(molecule.metadata.adduct, '[M+H]+');
        assert.equal(molecule.metadata.formula, 'C8H11NO2');
        assert.match(molecule.subtitle, /154\.1 → 137\.1/);
        assert.doesNotMatch(molecule.subtitle, /\b(?:CE|CV|Dwell)\b/);
        assert.equal(input.metadata.sample, '試料');
        assert.deepEqual(input.metadata.sampleTypes, ['脳']);
        assert.equal(input.metadata.experimentDate, '2026-10-28');
        assert.equal(input.metadata.machine, 'DESI');
        assert.equal(input.metadata.freeNote, '解析メモ');
        assert.equal(input.metadata.derivatization, 'registered derivatization');
        assert.deepEqual(input.metadata.sections[0].pixelPitch, { x: 50, y: 75 });
        const entries = await molecule.loadEntries();
        assert.deepEqual(entries[0].pixelPitch, { x: 50, y: 75 });
        assert.deepEqual(entries[0].stats, { mean: 140 / 3, max: 100, n: 3 });
        assert.ok(entries.every(entry => entry.raster));
        assertPublicReport({ input, entries });
        assert.equal(JSON.stringify(f.project), before, 'redaction must not change the shared project');
    }],
    ['share admins omit voltages even when requested and retain other acquisition information', async () => {
        const f = sharedFixture('admin'), input = report.createAdapter(f.hooks, { includeCeCv: true });
        const molecule = input.molecules[0], entries = await molecule.loadEntries();
        assert.equal(molecule.metadata.ce, undefined);
        assert.equal(molecule.metadata.cv, undefined);
        assert.equal(molecule.metadata.dwell, 0.87654321);
        assert.equal(entries[0].metadata.sourceFile, 'private-source-file.txt');
        assert.equal(input.metadata.sections[0].acquisition.instrument, 'private-acquisition-instrument');
        assert.doesNotMatch(molecule.subtitle, /\b(?:CE|CV)\b/);
        assert.doesNotMatch(JSON.stringify({ input, entries }), /715\.12345|620\.98765/);
        assert.equal(JSON.stringify({ input, entries }).includes('private-session-token'), false,
            'admin export includes acquisition metadata, never authentication credentials');
    }],
    ['master voltage output is opt-in for each report and keeps source data unchanged', async () => {
        const f = sharedFixture('admin'); f.app.shareMode = null; delete f.project.__share;
        const before = JSON.stringify(f.project);
        const defaultReport = report.createAdapter(f.hooks);
        const defaultEntries = await defaultReport.molecules[0].loadEntries();
        assert.equal(defaultReport.molecules[0].metadata.ce, undefined);
        assert.equal(defaultReport.molecules[0].metadata.cv, undefined);
        assert.equal(defaultReport.molecules[0].metadata.dwell, 0.87654321);
        assert.equal(defaultReport.molecules[0].metadata.instrument, 'private-layer-instrument');
        assert.equal(defaultEntries[0].metadata.sourceFile, 'private-source-file.txt');
        assert.equal(defaultReport.metadata.sections[0].acquisition.instrument, 'private-acquisition-instrument');
        assert.doesNotMatch(JSON.stringify({ defaultReport, defaultEntries }), /715\.12345|620\.98765/);

        const optedIn = report.createAdapter(f.hooks, { includeCeCv: true });
        const optedEntries = await optedIn.molecules[0].loadEntries();
        assert.equal(optedIn.molecules[0].metadata.ce, 715.12345);
        assert.equal(optedIn.molecules[0].metadata.cv, 620.98765);
        assert.equal(optedEntries[0].metadata.cv, 620.98765);
        assert.equal(optedIn.metadata.sections[0].acquisition.desi.collisionEnergy, 715.12345);
        assert.match(optedIn.molecules[0].subtitle, /CE 715\.12345/);
        assert.match(optedIn.molecules[0].subtitle, /CV 620\.98765/);
        assert.equal(report.createAdapter(f.hooks).molecules[0].metadata.ce, undefined, 'opt-in is not remembered');
        assert.equal(report.createAdapter(f.hooks, { includeCeCv: 'true' }).molecules[0].metadata.ce, undefined,
            'only explicit boolean true opts into private conditions');
        assert.equal(JSON.stringify(f.project), before);
    }],
    ['master OFF and shared admin remove nested voltage aliases while retaining other method data', async () => {
        for (const shared of [false, true]) {
            const f = sharedFixture('admin');
            if (!shared) { f.app.shareMode = null; delete f.project.__share; }
            f.project.displayName = 'Study (Cone)620.98765,(Collision)715.12345';
            f.project.memo.freeNote = 'Public note\nCE=715.12345, CV=620.98765 V\nOther analysis note';
            for (const section of f.sections) {
                section.displayName += ' CE=715.12345 CV=620.98765';
                Object.assign(section.msiSeries.MSI_DA.compoundMeta, {
                    base: 'Dopamine (Cone)620.98765,(Collision)715.12345',
                    sourceFile: 'sample_715.12345_620.98765.raw.zip',
                    msMethod: 'Method A; CE=715.12345, CV:620.98765 V'
                });
                Object.assign(section.meta.raw, {
                    'Cone (V)': 620.98765, collision_energy_eV: 715.12345,
                    coneGasFlow: 50, sourceTemperature: 300,
                    source: { capillaryKv: '3.00', coneV: '620.98765', sourceTempC: '150.00', msCe: '715.12345', msmsCe: '915.4321' },
                    records: [{ label: 'CV', value: 620.98765 }, { Parameter: 'Collision Energy (eV)', Value: 715.12345 },
                        { name: 'Cone (V)', value: 620.98765 }, { label: 'MS Mode Collision Energy', value: 715.12345 },
                        { label: 'MSMS Mode Collision Energy', value: 915.4321 }, { label: 'Gas flow', value: 50 }],
                    rows: [['Cone Voltage', 620.98765], ['Collision Energy', 715.12345], ['MS Mode Collision Energy', 715.12345],
                        ['MSMS Mode Collision Energy', 915.4321], ['Source temperature', 300]],
                    details: { fields: { CE: 715.12345, cv: 620.98765, pressure: 4 },
                        note: 'Mixed condition CE and CV: 715.12345 / 620.98765' }
                });
            }
            const before = JSON.stringify(f.project);
            const input = report.createAdapter(f.hooks, { includeCeCv: shared }), entries = await input.molecules[0].loadEntries();
            assert.doesNotMatch(JSON.stringify({ input, entries }), /715\.12345|620\.98765|915\.4321/);
            assert.equal(input.projectName, 'Study');
            assert.equal(input.molecules[0].name, 'Dopamine');
            assert.equal(entries[0].metadata.sourceFile, 'sample.raw.zip');
            assert.match(entries[0].metadata.msMethod, /Method A/);
            assert.equal(input.metadata.freeNote, 'Public note\nOther analysis note');
            const raw = input.metadata.sections[0].acquisition;
            assert.equal(raw.coneGasFlow, 50);
            assert.equal(raw.sourceTemperature, 300);
            assert.deepEqual(raw.source, { capillaryKv: '3.00', sourceTempC: '150.00' }, 'actual RAW source schema strips both collision-energy modes');
            assert.deepEqual(raw.records, [{ label: 'Gas flow', value: 50 }]);
            assert.deepEqual(raw.rows, [['Source temperature', 300]]);
            assert.equal(raw.details.fields.pressure, 4);
            assert.equal(JSON.stringify(f.project), before);
        }
    }],
    ['registered cholesteryl-ester names survive voltage omission in every role', async () => {
        for (const role of ['master', 'viewer', 'admin']) for (const name of ['CE 18:1', 'CE(18:1)', 'CE']) {
            const f = sharedFixture(role === 'master' ? 'admin' : role);
            if (role === 'master') { f.app.shareMode = null; delete f.project.__share; }
            for (const section of f.sections) Object.assign(section.msiSeries.MSI_DA.compoundMeta, {
                base: name, name, precursor: 651.57, product: 369.35, formula: 'C45H78O2'
            });
            const before = JSON.stringify(f.project);
            const input = report.createAdapter(f.hooks), entries = await input.molecules[0].loadEntries();
            assert.equal(input.molecules[0].name, name);
            assert.equal(entries[0].metadata.name, name);
            assert.equal(entries[0].metadata.base, name);
            assert.equal(entries[0].metadata.precursor, 651.57);
            assert.equal(entries[0].metadata.formula, 'C45H78O2');
            assert.doesNotMatch(JSON.stringify({ input, entries }), /715\.12345|620\.98765/);
            assert.equal(JSON.stringify(f.project), before);
            if (name !== 'CE') {
                for (const section of f.sections) section.msiSeries.MSI_DA.compoundMeta.base += ' CE=715.12345 CV=620.98765';
                assert.equal(report.createAdapter(f.hooks).molecules[0].name, name, 'explicit conditions still disappear beside a lipid name');
            }
        }
    }],
    ['OFF reports keep voltage-distinct measurements separate with safe identifiers in every role', async () => {
        for (const role of ['master', 'viewer', 'admin']) {
            const f = sharedFixture(role === 'master' ? 'admin' : role);
            if (role === 'master') { f.app.shareMode = null; delete f.project.__share; }
            f.sections[1].msiSeries.MSI_DA.compoundMeta.ce = 915.4321;
            const input = report.createAdapter(f.hooks), entries = await Promise.all(input.molecules.map(molecule => molecule.loadEntries()));
            assert.equal(input.molecules.length, 2, role);
            assert.equal(new Set(input.molecules.map(molecule => molecule.key)).size, 2);
            assert.equal(new Set(input.molecules.map(molecule => molecule.subtitle)).size, 2);
            assert.ok(input.molecules.every(molecule => /測定 \d+/.test(molecule.subtitle)));
            assert.doesNotMatch(JSON.stringify({ input, entries }), /715\.12345|620\.98765|915\.4321|MSI_DA/);
            assert.ok(entries.every(items => items.filter(entry => entry.raster).length === 1));
        }
    }],
    ['settings selection context cannot be reused after a project or session switch', async () => {
        for (const change of [
            f => { f.app.project = { ...f.project }; },
            f => { f.app.shareMode = { role: 'viewer', token: 'new' }; },
            f => { f.project.__share = true; }
        ]) {
            const f = fixture(), pending = report.captureExportContext(f.hooks.getApp);
            assert.equal(pending.shared, false);
            pending.assertCurrent(); change(f);
            assert.throws(pending.assertCurrent, { code: 'REPORT_SOURCE_CHANGED' });
        }
        const f = sharedFixture('admin'), pending = report.captureExportContext(f.hooks.getApp);
        assert.equal(pending.shared, true);
        f.app.shareMode.token = 'renewed';
        assert.throws(pending.assertCurrent, { code: 'REPORT_SOURCE_CHANGED' });
    }],
    ['physical pitch is resolved after numeric loading and unknown geometry remains unknown', async () => {
        const f = fixture();
        f.hooks.pixelPitch = (section, key) => {
            assert.ok(f.app.panels.get(section.id).msiValueRasters.has(key));
            return section.id === 'left' ? { x: 25, y: 37.5, ce: 715.12345 } : null;
        };
        const entries = await report.createAdapter(f.hooks).molecules[0].loadEntries();
        assert.deepEqual(entries[0].pixelPitch, { x: 25, y: 37.5 });
        assert.equal(entries[1].pixelPitch, null, 'unconfirmed/nonuniform geometry cannot use an old pitch');
    }],
    ['reference image loading uses snapshot sections and rejects async project changes', async () => {
        const f = fixture(), calls = [];
        f.hooks.referenceImage = async (section, panel) => {
            assert.equal(panel, f.app.panels.get(section.id));
            calls.push(section.id);
            return { referenceImage: { data: 'data:image/png;base64,fixture', width: 5, height: 3 },
                referenceLabel: section.id === 'left' ? 'Optical' : 'TIC' };
        };
        const input = report.createAdapter(f.hooks), references = await input.loadSectionReferences();
        assert.deepEqual(calls, ['left', 'right']);
        assert.deepEqual(references.map(reference => [reference.id, reference.name, reference.referenceLabel]),
            [['left', '切片 1', 'Optical'], ['right', '切片 2', 'TIC']]);
        const absent = fixture(); assert.deepEqual(await report.createAdapter(absent.hooks).loadSectionReferences(), []);
        f.hooks.referenceImage = async () => { f.app.project = { ...f.project }; return { referenceImage: { data: 'ignored' } }; };
        const stale = report.createAdapter(f.hooks);
        await assert.rejects(stale.loadSectionReferences(), { code: 'REPORT_SOURCE_CHANGED' });
    }],
    ['project-only shared flags and unknown roles use viewer output', async () => {
        for (const configure of [
            f => { f.app.shareMode = null; },
            f => { delete f.project.__share; },
            f => { f.app.shareMode.role = 'owner'; },
            f => { delete f.app.shareMode.role; }
        ]) {
            const f = sharedFixture(); configure(f);
            const input = report.createAdapter(f.hooks, { includeCeCv: true });
            const entries = await input.molecules[0].loadEntries();
            assert.equal(entries.length, 2);
            assertPublicReport({ input, entries });
        }
    }],
    ['hidden CE and CV still distinguish viewer groups without leaking identity values', async () => {
        const f = sharedFixture();
        f.sections[1].msiSeries.MSI_DA.compoundMeta.ce = 915.4321;
        f.sections[0].msiSeries.MSI_secret_key_CV_920_987 = f.makeEntry('private-replicate', {
            ...f.sections[0].msiSeries.MSI_DA.compoundMeta, cv: 920.7654 });
        const input = report.createAdapter(f.hooks);
        assert.equal(input.molecules.length, 3, 'redaction cannot merge distinct acquired conditions');
        const allEntries = [];
        for (const molecule of input.molecules) {
            const entries = await molecule.loadEntries();
            assert.equal(entries.filter(entry => entry.raster).length, 1);
            assert.equal(entries.filter(entry => entry.missingReason).length, 1);
            allEntries.push(entries);
        }
        assert.equal(new Set(input.molecules.map(molecule => molecule.key)).size, 3);
        assert.equal(new Set(input.molecules.map(molecule => molecule.subtitle)).size, 3,
            'publicly identical transitions need distinguishable safe measurement labels');
        assert.deepEqual(input.molecules.map(molecule => molecule.subtitle.match(/測定 (\d+)/)?.[1]), ['1', '2', '3']);
        const exported = JSON.stringify({ input, allEntries });
        assertPublicReport({ input, allEntries });
        for (const privateText of ['915.4321', '920.7654', 'secret_key_CV_920_987', 'MSI_DA']) {
            assert.equal(exported.includes(privateText), false, 'internal grouping/key data must not reveal ' + privateText);
        }
    }],
    ['viewer repeated transitions use safe labels instead of raw source keys', async () => {
        const f = sharedFixture();
        f.sections[0].msiSeries.MSI_private_duplicate_key_715_620 = f.makeEntry('duplicate',
            { ...f.sections[0].msiSeries.MSI_DA.compoundMeta });
        const input = report.createAdapter(f.hooks);
        assert.equal(input.molecules.length, 2);
        const entries = await Promise.all(input.molecules.map(molecule => molecule.loadEntries()));
        assert.equal(entries.flat().filter(entry => entry.raster).length, 3, 'all acquired measurements survive');
        assertPublicReport({ input, entries });
        assert.equal(JSON.stringify({ input, entries }).includes('private_duplicate_key_715_620'), false);
    }],
    ['viewer raw-key fallbacks strip parameter suffixes before serialization', async () => {
        for (const withFormatter of [false, true]) {
            const f = sharedFixture();
            if (withFormatter) f.hooks.formatDisplayName = key => key.replace(/^MSI_/i, '');
            for (const section of f.sections) {
                const entry = section.msiSeries.MSI_DA;
                delete entry.compoundMeta;
                section.msiSeries = { MSI_Dopamine_15_20: entry };
            }
            const input = report.createAdapter(f.hooks), entries = await input.molecules[0].loadEntries();
            assert.equal(input.molecules.length, 1);
            assert.equal(input.molecules[0].name, 'Dopamine');
            assert.equal(JSON.stringify({ input, entries }).includes('Dopamine_15_20'), false);
            assertPublicReport({ input, entries });
            assert.deepEqual(f.calls, [['left', 'MSI_Dopamine_15_20'], ['right', 'MSI_Dopamine_15_20']],
                'public names must not rewrite the actual source lookup key');
        }
    }],
    ['viewer fallback names remove signed decimal and exponent condition suffixes', async () => {
        for (const suffix of ['15.5_-20.25', '+1.5e1_-2.0E+1', '.5_-.25', '-15._+20.']) {
            for (const useNameMetadata of [false, true]) {
                const f = sharedFixture(), key = 'MSI_Dopamine_' + suffix;
                f.hooks.formatDisplayName = rawKey => rawKey.replace(/^MSI_/i, '');
                for (const section of f.sections) {
                    const entry = section.msiSeries.MSI_DA;
                    entry.compoundMeta = useNameMetadata ? { name: 'Dopamine_' + suffix,
                        precursor: 154.1, product: 137.1, ce: 15.5, cv: -20.25 } : null;
                    section.msiSeries = { [key]: entry };
                }
                const input = report.createAdapter(f.hooks), entries = await input.molecules[0].loadEntries();
                assert.equal(input.molecules.length, 1);
                assert.equal(input.molecules[0].name, 'Dopamine', suffix);
                assert.equal(input.molecules[0].metadata.name, 'Dopamine', suffix);
                assert.equal(input.molecules[0].metadata.base, 'Dopamine', suffix);
                assert.equal(JSON.stringify({ input, entries }).includes('Dopamine_' + suffix), false,
                    'suffix must not survive in report names, metadata, keys or subtitles: ' + suffix);
                assertPublicReport({ input, entries });
                assert.deepEqual(f.calls, [['left', key], ['right', key]]);
            }
        }
        const explicit = sharedFixture();
        for (const section of explicit.sections) section.msiSeries.MSI_DA.compoundMeta.base = 'Registered_name_34_1';
        const input = report.createAdapter(explicit.hooks);
        assert.equal(input.molecules[0].name, 'Registered_name_34_1', 'an explicit public base is not a guessed CE/CV suffix');
    }],
    ['public metadata rejects nested method containers and nonfinite scalar values', async () => {
        const f = sharedFixture();
        for (const section of f.sections) Object.assign(section.msiSeries.MSI_DA.compoundMeta, {
            precursor: 0, product: ['nested-private-product', { ce: 715.12345 }],
            polarity: true, mz: Infinity,
            adduct: { value: '[M+H]+', sourceFile: 'nested-private-source-file' },
            formula: { value: 'C8H11NO2', method: { cv: 620.98765, note: 'nested-private-method-note' } }
        });
        const input = report.createAdapter(f.hooks), entries = await input.molecules[0].loadEntries();
        for (const metadata of [input.molecules[0].metadata, ...entries.map(entry => entry.metadata)]) {
            assert.equal(metadata.precursor, 0, 'finite scalar zero is public data, not missing');
            assert.equal(metadata.base, 'Dopamine');
            for (const field of ['product', 'polarity', 'mz', 'adduct', 'formula']) {
                assert.equal(Object.hasOwn(metadata, field), false, field + ' must be a string or finite number');
            }
        }
        const text = JSON.stringify({ input, entries });
        assert.equal(text.includes('nested-private'), false, 'recursive deck metadata cannot reach private nested containers');
        assert.equal(text.includes('[object Object]'), false);
        assertPublicReport({ input, entries });

        const malformedName = sharedFixture();
        for (const section of malformedName.sections) Object.assign(section.msiSeries.MSI_DA.compoundMeta, {
            base: { label: 'nested-private-base', method: { ce: 715.12345 } },
            name: ['nested-private-name', { cv: 620.98765 }]
        });
        const safe = report.createAdapter(malformedName.hooks), safeEntries = await safe.molecules[0].loadEntries();
        assert.equal(safe.molecules[0].name, 'DA', 'non-scalar aliases fall back to the public layer name');
        assert.equal(JSON.stringify({ safe, safeEntries }).includes('nested-private'), false);
        assertPublicReport({ safe, safeEntries });
    }],
    ['share role, token, slug, session identity and shared flag changes invalidate exports', async () => {
        const changes = [
            ['role', f => { f.app.shareMode.role = 'admin'; }],
            ['token', f => { f.app.shareMode.token = 'new-token'; }],
            ['slug', f => { f.app.shareMode.slug = 'other-project'; }],
            ['session', f => { f.app.shareMode = { ...f.app.shareMode }; }],
            ['exit share', f => { f.app.shareMode = null; }],
            ['shared flag', f => { f.project.__share = false; }]
        ];
        for (const [name, change] of changes) {
            const f = sharedFixture(), input = report.createAdapter(f.hooks);
            change(f);
            assert.throws(input.assertCurrent, { code: 'REPORT_SOURCE_CHANGED' }, name);
            await assert.rejects(input.molecules[0].loadEntries(), { code: 'REPORT_SOURCE_CHANGED' }, name);
            assert.equal(f.calls.length, 0, 'stale access is rejected before source loading: ' + name);
        }
    }],
    ['access changes during source loading abort before output is returned', async () => {
        const f = sharedFixture('admin'), panel = f.app.panels.get('left'), load = panel.ensureMsiLayerLoaded;
        panel.ensureMsiLayerLoaded = async function (key) {
            await load.call(this, key);
            f.app.shareMode.role = 'viewer';
            return true;
        };
        const input = report.createAdapter(f.hooks);
        await assert.rejects(input.molecules[0].loadEntries(), { code: 'REPORT_SOURCE_CHANGED' });
        assert.equal(f.calls.length, 1, 'the second section is not loaded after admin access changes');
    }],
    ['sourceUrl-only shared layers use numeric loading and detect URL replacement', async () => {
        const f = sharedFixture();
        for (const section of f.sections) Object.assign(section.msiSeries.MSI_DA,
            { blobId: null, kind: 'parquet', sourceUrl: 'https://storage.example/' + section.id + '.parquet' });
        const input = report.createAdapter(f.hooks), entries = await input.molecules[0].loadEntries();
        assert.deepEqual(f.calls, [['left', 'MSI_DA'], ['right', 'MSI_DA']]);
        assert.ok(entries.every(entry => entry.raster && !entry.missingReason));
        assert.deepEqual(entries[0].stats, { mean: 140 / 3, max: 100, n: 3 });
        assert.equal(JSON.stringify({ input, entries }).includes('https://storage.example/'), false);
        f.sections[0].msiSeries.MSI_DA.sourceUrl = 'https://storage.example/replaced.parquet';
        assert.throws(input.assertCurrent, { code: 'REPORT_SOURCE_CHANGED' });
    }],
    ['report filename is portable', async () => {
        assert.equal(report.safeFileName('../測定:<project>?'), '.._測定__project___report.pptx');
        assert.equal(report.safeFileName('CON'), '_CON_report.pptx');
        assert.equal(report.safeFileName('...'), 'Project_report.pptx');
        assert.equal(/[<>:"/\\|?*]/.test(report.safeFileName('a'.repeat(300))), false);
        assert.ok(report.safeFileName('a'.repeat(300)).length < 150);
    }]
];
(async () => {
    for (const [name, test] of tests) { await test(); console.log('PASS ' + name); }
    console.log('Project report adapter regressions passed (' + tests.length + ').');
})().catch(error => { console.error(error); process.exitCode = 1; });
