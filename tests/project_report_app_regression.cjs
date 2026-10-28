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
            _msiLoadIdentity(key) { const e = section.msiSeries[key] || {}; return JSON.stringify([e.blobId, e.sourceRevision]); },
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
        const repeated = input.molecules.find(molecule => molecule.layerKey === 'MSI_DA_2');
        const entries = await repeated.loadEntries();
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
    ['shared projects are rejected and filename is portable', async () => {
        const f = fixture(); f.app.shareMode = { role: 'viewer' };
        assert.throws(() => report.createAdapter(f.hooks), /管理画面/);
        f.app.shareMode = null; f.project.__share = true;
        assert.throws(() => report.createAdapter(f.hooks), /管理画面/);
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
