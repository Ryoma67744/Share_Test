'use strict';
const assert = require('node:assert/strict');
const report = require('../viewer/project-report-app.js');
const Archive = require('../viewer/project-archive.js');
const { runtime } = require('./viewer-runtime.cjs');

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
    ['output selection defaults to independent and reconciles section inventory without persistence', async () => {
        const f=fixture(), state=report.reconcileSelection(f.sections);
        assert.deepEqual(report.selectionPlan(f.sections,state).groups.map(g=>[g.kind,g.sectionIds]),[
            ['independent',['left']],['independent',['right']]]);
        state.groups=[{id:'compare-1',name:'比較 A'}];state.assignments[0].groupId='compare-1';state.assignments[1].included=false;
        const updated=report.reconcileSelection([f.sections[1],{id:'new'},f.sections[0]],state);
        assert.deepEqual(updated.assignments,[{sectionId:'right',included:false,groupId:''},
            {sectionId:'new',included:true,groupId:''},{sectionId:'left',included:true,groupId:'compare-1'}]);
        assert.deepEqual(report.selectionPlan([f.sections[1],{id:'new'},f.sections[0]],updated).groups.map(g=>[g.kind,g.sectionIds]),[
            ['compare',['left']],['independent',['new']]],'one-member comparison keeps explicit semantics');
        updated.groups[0].name='Changed';assert.equal(state.groups[0].name,'比較 A');
        const removed=report.reconcileSelection([f.sections[1]],state);assert.equal(removed.assignments.length,1);
        assert.throws(()=>report.selectionPlan([f.sections[1]],removed),{code:'REPORT_OUTPUT_PLAN_INVALID'});
        const invalidPlans=[{version:2,groups:[]},{version:1,groups:[]},
            {version:1,groups:[{id:'g',name:'G',kind:'independent',sectionIds:['left','right']}]},
            {version:1,groups:[{id:'g',name:'G',kind:'compare',sectionIds:['left','left']}]},
            {version:1,groups:[{id:'g',name:'G',kind:'compare',sectionIds:['unknown']}]}];
        for(const plan of invalidPlans)assert.throws(()=>report.normalizeOutputPlan(f.sections,plan),{code:'REPORT_OUTPUT_PLAN_INVALID'});
    }],
    ['explicit output selection skips excluded numeric, ratio and reference loads while guarding full inventory', async () => {
        const f=fixture(), plan={version:1,groups:[{id:'g',name:'比較 A',kind:'compare',sectionIds:['right']}]};
        f.sections[0].msiSeries.MSI_DA.compoundMeta.sourceFile='EXCLUDED_SOURCE.txt';
        f.sections[1].msiSeries.MSI_DA.compoundMeta.sourceFile='INCLUDED_SOURCE.txt';
        const refs=[],ratios=[];
        f.hooks.referenceImage=async section=>{refs.push(section.id);return null;};
        f.sections[1].meta.client_id='canonical-right';
        f.app.getRatioDefinitions=()=>[{id:'r',bindings:{left:{numerator:{labelHint:'EXCLUDED_RATIO_INPUT'},denominator:{labelHint:'EXCLUDED_DENOMINATOR'}},
            'canonical-right':{numerator:{labelHint:'INCLUDED_X'},denominator:{labelHint:'INCLUDED_Y'}}}}];
        f.app.resolveRatio=async section=>{ratios.push(section.id);return null;};
        const input=report.createAdapter(f.hooks,{outputPlan:plan,includeRatios:true,includeCeCv:true});
        plan.groups[0].sectionIds.push('left');plan.groups[0].name='Changed';
        assert.deepEqual(input.outputPlan.groups[0].sectionIds,['right']);assert.equal(input.outputPlan.groups[0].name,'比較 A');
        assert.deepEqual(input.sections.map(s=>s.id),['right']);
        for(const molecule of input.molecules) {
            const entries=await molecule.loadEntries();assert.deepEqual(entries.map(e=>e.sectionId),['right']);
            assert.doesNotMatch(JSON.stringify(entries),/EXCLUDED_RATIO_INPUT|EXCLUDED_DENOMINATOR/);
            if(molecule.kind==='ratio')assert.equal(entries[0].metadata.formula,'INCLUDED_X / INCLUDED_Y');
        }
        await input.loadSectionReferences();
        assert.deepEqual(f.calls,[['right','MSI_DA']]);assert.deepEqual(refs,['right']);assert.deepEqual(ratios,['right']);
        assert.doesNotMatch(JSON.stringify(input),/EXCLUDED_SOURCE|EXCLUDED_RATIO_INPUT|EXCLUDED_DENOMINATOR/);
        assert.equal(input.molecules[0].metadata.sourceFile,'INCLUDED_SOURCE.txt');
        input.assertCurrent();f.project.sections.reverse();assert.throws(input.assertCurrent,{code:'REPORT_SOURCE_CHANGED'});
    }],
    ['explicit output groups leave MRM identities and hidden condition matching unchanged', async () => {
        const f=sharedFixture(), plan={version:1,groups:[{id:'g',name:'比較 A',kind:'compare',sectionIds:['left','right']}]};
        f.sections[1].msiSeries.MSI_DA.compoundMeta.ce+=1;
        const input=report.createAdapter(f.hooks,{outputPlan:plan});
        assert.equal(input.molecules.length,2,'one changed condition remains a separate measurement, not a separate output group');
        assert.equal(input.outputPlan.groups.length,1);assert.equal(input.outputPlan.groups[0].kind,'compare');
        for(const molecule of input.molecules)assert.equal((await molecule.loadEntries()).length,1);
        assertPublicReport(input);
        const duplicate=fixture();duplicate.sections[0].msiSeries.MSI_second=duplicate.makeEntry('duplicate');
        const all=report.createAdapter(duplicate.hooks,{includeCeCv:true});
        const selected=report.createAdapter(duplicate.hooks,{includeCeCv:true,outputPlan:{version:1,groups:[
            {id:'i',name:'独立',kind:'independent',sectionIds:['right']} ]}});
        assert.equal(selected.molecules[0].key,all.molecules.find(m=>m.layerKey==='MSI_DA').key,
            'an excluded duplicate does not change scientific identity keys');
    }],
    ['explicit plans capture automatic style inputs and never expose manual ranges to preparation', async () => {
        const f=fixture();f.app.msiUserWindow={MSI_DA:{min:5,max:800}};
        f.hooks.displayStyle=()=>({mode:'same',rangePolicy:'maximum',lut:Array.from({length:256},(_,i)=>[i,i,i]),smoothing:'none'});
        const before=JSON.stringify(f.project),ranges=JSON.stringify(f.app.msiUserWindow);
        const input=report.createAdapter(f.hooks,{useDisplayStyle:true,outputPlan:report.selectionPlan(f.sections,report.reconcileSelection(f.sections))});
        for(const entry of await input.molecules[0].loadEntries()) {
            assert.equal(entry.displayAuto.max,100);assert.equal(entry.manualWindow,undefined);assert.equal(entry.displayWindow,undefined);
        }
        assert.equal(JSON.stringify(f.project),before);assert.equal(JSON.stringify(f.app.msiUserWindow),ranges);
    }],
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
        assert.deepEqual(entries.map(entry => entry.sectionId), ['left'], 'unregistered conditions do not create report entries');
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
        assert.equal(entries.length, 1, 'an absent replicate does not create an unavailable placeholder');
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
    ['shared admin voltage output is opt-in per report and preserves registered data', async () => {
        const f = sharedFixture('admin'), session = f.app.shareMode;
        const before = JSON.stringify({ project: f.project, session });
        for (const options of [{}, { includeCeCv: false }, { includeCeCv: 'true' }]) {
            const input = report.createAdapter(f.hooks, options), entries = await input.molecules[0].loadEntries();
            assert.equal(input.molecules[0].metadata.ce, undefined);
            assert.equal(input.molecules[0].metadata.cv, undefined);
            assert.equal(entries[0].metadata.dwell, 0.87654321);
            assert.equal(entries[0].metadata.sourceFile, 'private-source-file.txt');
            assert.equal(input.metadata.sections[0].acquisition.instrument, 'private-acquisition-instrument');
            assert.doesNotMatch(JSON.stringify({ input, entries }), /715\.12345|620\.98765/);
        }
        const selected = report.createAdapter(f.hooks, { includeCeCv: true });
        const entries = await selected.molecules[0].loadEntries();
        assert.equal(selected.molecules[0].metadata.ce, 715.12345);
        assert.equal(selected.molecules[0].metadata.cv, 620.98765);
        assert.equal(entries[0].metadata.cv, 620.98765);
        assert.match(selected.molecules[0].subtitle, /CE 715\.12345/);
        assert.match(selected.molecules[0].subtitle, /CV 620\.98765/);
        assert.equal(selected.metadata.sections[0].acquisition.desi.collisionEnergy, 715.12345);
        assert.equal(entries[0].metadata.dwell, 0.87654321);
        assert.equal(entries[0].metadata.sourceFile, 'private-source-file.txt');
        assert.equal(report.createAdapter(f.hooks).molecules[0].metadata.ce, undefined, 'the next report defaults to OFF');
        assert.equal(f.app.shareMode, session);
        assert.equal(JSON.stringify({ project: f.project, session }), before);
        assert.equal(JSON.stringify({ selected, entries }).includes('private-session-token'), false);
    }],
    ['ordinary shared viewers cannot enable voltages with report or obsolete authorization options', async () => {
        const f = sharedFixture();
        const secret = 'obsolete-master-secret';
        for (const options of [
            { includeCeCv: true },
            { includeCeCv: true, canIncludeCeCv: true, role: 'admin' },
            { includeCeCv: true, masterAuthorization: true },
            { includeCeCv: true, masterAuthorization: { token: secret, role: 'admin', expires_at: '2099-01-01T00:00:00Z' }, masterPassword: secret }
        ]) {
            const input = report.createAdapter(f.hooks, options), entries = await input.molecules[0].loadEntries();
            assertPublicReport({ input, entries });
            assert.equal(JSON.stringify({ input, entries }).includes(secret), false);
        }
        assert.equal(report.authorizeSharedExport, undefined, 'PPT export no longer exposes an extra master-password flow');
    }],
    ['CV and CE selection is available only for local projects or the existing shared admin role', async () => {
        const local = fixture();
        assert.equal(report.captureExportContext(local.hooks.getApp).canIncludeCeCv, true);
        const admin = sharedFixture('admin');
        assert.equal(report.captureExportContext(admin.hooks.getApp).canIncludeCeCv, true);
        delete admin.project.__share;
        assert.equal(report.captureExportContext(admin.hooks.getApp).canIncludeCeCv, true, 'shareMode admin is the existing login authority');
        for (const configure of [
            f => {},
            f => { f.app.shareMode.role = 'owner'; },
            f => { f.app.shareMode.role = 'Admin'; },
            f => { delete f.app.shareMode.role; },
            f => { f.app.shareMode = null; }
        ]) {
            const f = sharedFixture(); configure(f);
            assert.equal(report.captureExportContext(f.hooks.getApp).canIncludeCeCv, false);
            const input = report.createAdapter(f.hooks, { includeCeCv: true, canIncludeCeCv: true, masterAuthorization: {} });
            assertPublicReport({ input, entries: await input.molecules[0].loadEntries() });
        }
    }],
    ['shared admin selected output rejects project, role and session changes', async () => {
        for (const [name, change] of [
            ['project', f => { f.app.project = { ...f.project }; }],
            ['session', f => { f.app.shareMode = { ...f.app.shareMode }; }],
            ['role', f => { f.app.shareMode.role = 'viewer'; }],
            ['token', f => { f.app.shareMode.token = 'renewed-token'; }],
            ['slug', f => { f.app.shareMode.slug = 'other-project'; }],
            ['expiry', f => { f.app.shareMode.expiresAt = new Date(Date.now() + 100000).toISOString(); }],
            ['shared flag', f => { f.project.__share = false; }]
        ]) {
            const f = sharedFixture('admin'), context = report.captureExportContext(f.hooks.getApp);
            const input = report.createAdapter(f.hooks, { includeCeCv: true });
            change(f);
            assert.throws(context.assertCurrent, { code: 'REPORT_SOURCE_CHANGED' }, name);
            assert.throws(input.assertCurrent, { code: 'REPORT_SOURCE_CHANGED' }, name);
            await assert.rejects(input.molecules[0].loadEntries(), { code: 'REPORT_SOURCE_CHANGED' }, name);
            assert.equal(f.calls.length, 0, 'stale admin output is rejected before loading: ' + name);
        }
        for (const change of [
            f => { f.app.shareMode.role = 'viewer'; },
            f => { f.app.shareMode = { ...f.app.shareMode }; }
        ]) {
            const f = sharedFixture('admin'), panel = f.app.panels.get('left'), load = panel.ensureMsiLayerLoaded;
            panel.ensureMsiLayerLoaded = async function (key) { await load.call(this, key); change(f); return true; };
            const input = report.createAdapter(f.hooks, { includeCeCv: true });
            await assert.rejects(input.molecules[0].loadEntries(), { code: 'REPORT_SOURCE_CHANGED' });
            assert.equal(f.calls.length, 1, 'a role/session change during loading stops before the second section');
        }
    }],
    ['shared admin selected output checks declared session expiry before and during generation', async () => {
        const originalNow = Date.now; let now = Date.parse('2026-10-28T12:00:00Z');
        Date.now = () => now;
        try {
            const legacy = sharedFixture('admin');
            assert.equal(report.createAdapter(legacy.hooks, { includeCeCv: true }).molecules[0].metadata.ce, 715.12345,
                'legacy sessions without an expiry field retain the existing admin capability');
            for (const expiresAt of ['not-a-date', new Date(now - 1).toISOString(), new Date(now).toISOString()]) {
                const f = sharedFixture('admin'); f.app.shareMode.expiresAt = expiresAt;
                assert.throws(() => report.createAdapter(f.hooks, { includeCeCv: true }), { code: 'REPORT_SOURCE_CHANGED' });
                assert.equal(f.calls.length, 0);
            }
            const f = sharedFixture('admin'); f.app.shareMode.expiresAt = new Date(now + 60000).toISOString();
            const input = report.createAdapter(f.hooks, { includeCeCv: true });
            input.assertCurrent();
            const panel = f.app.panels.get('left'), load = panel.ensureMsiLayerLoaded;
            panel.ensureMsiLayerLoaded = async function (key) { await load.call(this, key); now += 60000; return true; };
            await assert.rejects(input.molecules[0].loadEntries(), { code: 'REPORT_SOURCE_CHANGED' });
            assert.throws(input.assertCurrent, { code: 'REPORT_SOURCE_CHANGED' });
            assert.equal(f.calls.length, 1, 'expired admin access stops before the next section loads');
        } finally { Date.now = originalNow; }
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
            const input = report.createAdapter(f.hooks, { includeCeCv: false }), entries = await input.molecules[0].loadEntries();
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
    ['physical pitch is resolved after numeric loading and missing calibration remains unknown', async () => {
        const f = fixture();
        f.hooks.pixelPitch = (section, key) => {
            assert.ok(f.app.panels.get(section.id).msiValueRasters.has(key));
            return section.id === 'left' ? { x: 25, y: 37.5, ce: 715.12345 } : null;
        };
        const entries = await report.createAdapter(f.hooks).molecules[0].loadEntries();
        assert.deepEqual(entries[0].pixelPitch, { x: 25, y: 37.5 });
        assert.deepEqual(entries[0].registeredPixelPitch, { x: 50, y: 75 }, 'The acquisition label is independent from the effective display pitch');
        assert.equal(entries[1].pixelPitch, null, 'missing or invalid registered calibration is not invented');
        assert.deepEqual(entries[1].registeredPixelPitch, { x: 50, y: 75 }, 'Registered acquisition pitch remains known when display calibration is unavailable');
    }],
    ['registered pixel labels preserve numeric source calibration without aliasing or guessing', async () => {
        const f = fixture();
        f.sections[0].meta.world_coords.msi_um_per_px = {x:'25',y:'1.2e2',ce:999};
        const input = report.createAdapter(f.hooks);
        f.sections[0].meta.world_coords.msi_um_per_px.x = '60';
        const entries = await input.molecules[0].loadEntries();
        assert.deepEqual(entries[0].registeredPixelPitch, {x:25,y:120}, 'Source labels are frozen at export start and only contain x/y');
        entries[0].registeredPixelPitch.x = 999;
        assert.equal(f.sections[0].meta.world_coords.msi_um_per_px.x, '60');
        for (const pitch of [null, {}, {x:0,y:25}, {x:-1,y:25}, {x:Infinity,y:25},
            {x:'',y:25}, {x:'0x10',y:25}, {x:true,y:25}, {x:25,y:'unknown'}]) {
            const unknown = fixture(); unknown.sections[0].meta.world_coords.msi_um_per_px = pitch;
            const output = await report.createAdapter(unknown.hooks).molecules[0].loadEntries();
            assert.equal(output[0].registeredPixelPitch, null, JSON.stringify(pitch));
        }
        const failed = fixture(); failed.app.panels.get('left').ensureMsiLayerLoaded = async () => false;
        const failedEntry = (await report.createAdapter(failed.hooks).molecules[0].loadEntries())[0];
        assert.ok(failedEntry.missingReason);
        assert.deepEqual(failedEntry.registeredPixelPitch, {x:50,y:75}, 'Read failures retain known registration');
    }],
    ['registered string pitch survives rounded TXT geometry without changing source statistics', async () => {
        const f = fixture(), sourceRows = [];
        for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) sourceRows.push({
            x: Number((-12.3456 + x * 0.030005).toPrecision(6)), y: -4.3 + y * 0.03, v: x + y * 16 });
        const geometryContext = runtime({}, ['buildMsiGrid', 'buildLegacyMsiGrid', 'msiSourceReference', 'createMsiSourceGeometry']);
        for (const section of f.sections) section.meta.world_coords.msi_um_per_px = {x:'30',y:'3e1'};
        const geometry = geometryContext.createMsiSourceGeometry(sourceRows, f.sections[0].msiSeries.MSI_DA);
        geometryContext.msiLayerSourceGeometry = section => ({...geometry,
            sourceRef: geometryContext.msiSourceReference(section.msiSeries.MSI_DA)});
        assert.equal(geometryContext.resolveMsiCoordinateCalibration(f.sections[0], 'MSI_DA').status, 'unknown',
            'The synthetic rounded coordinates reproduce the former strict-calibration rejection');
        f.hooks.pixelPitch = (section, key) => {
            assert.ok(f.app.panels.get(section.id).msiValueRasters.has(key));
            return geometryContext.msiDisplayPhysicalPitch(section, key);
        };
        const before = JSON.stringify({project:f.project,sourceRows,geometry});
        const entries = await report.createAdapter(f.hooks).molecules[0].loadEntries();
        for (const entry of entries) {
            assert.deepEqual(entry.pixelPitch, {x:30,y:30});
            assert.deepEqual(entry.registeredPixelPitch, {x:30,y:30});
            assert.deepEqual(entry.stats, {mean:140/3,max:100,n:3}, 'Calibration does not recalculate or replace source-row statistics');
        }
        assert.equal(JSON.stringify({project:f.project,sourceRows,geometry}), before,
            'Numeric-string metadata and rounded source coordinates remain unchanged');
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
            assert.equal(entries.length, 1, 'hidden conditions remain separate without unregistered-section placeholders');
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
    ['legacy quality is public, stable, and independent from voltage metadata', async () => {
        const f = sharedFixture();
        f.sections[0].msiSeries.MSI_DA.archiveProvenance = {version: 1, basis: 'legacy-derived-csv', background: 'drop'};
        const input = report.createAdapter(f.hooks), entries = await input.molecules[0].loadEntries();
        assert.equal(entries[0].archiveProvenance.basis, 'legacy-derived-csv');
        assert.match(entries[0].qualityNote, /background removal selected/);
        assert.equal(JSON.stringify(entries[0].archiveProvenance).includes('ce'), false);
        f.sections[0].msiSeries.MSI_DA.archiveProvenance = Archive.registeredSource();
        assert.throws(input.assertCurrent, {code: 'REPORT_SOURCE_CHANGED'});
    }],
    ['display style freezes all-section ranges, colour, masks and registered physical geometry', async () => {
        const previous=global.MsiDisplayGeometry;
        try {
            global.MsiDisplayGeometry=require('../viewer/msi-display-geometry.js');
            const f=sharedFixture('viewer');
            f.app.msiScaleMode='same';f.app.msiUserWindow={MSI_DA:{min:5}};
            let strength=6,linearStrength=4;
            f.app.getMsiDisplaySettings=()=>({aspectMode:'physical',rangePolicy:'maximum',smoothingStrength:strength,linearStrength});
            const lut=Array.from({length:256},(_,i)=>[i,0,0]);
            f.hooks.displayStyle=()=>({mode:f.app.msiScaleMode,rangePolicy:'maximum',lut,background:[0,0,0],smoothing:'none',otsu:true,colormap:'test-red'});
            f.hooks.sourceGeometry=()=>({legacy:{W:2,H:1}});
            f.sections.forEach(section=>{section.meta.otsu={value:17};section.msiSeries.MSI_DA.rawRange=[0,10];section.msiSeries.MSI_DA.rawDispMax=10;});
            f.sections[1].msiSeries.MSI_DA.rawTrueMax=800;
            f.hooks.keepGrid=section=>{assert.equal(section.meta.otsu.value,17);return {W:2,H:1,keep:Uint8Array.from([1,0])};};
            const right=f.app.panels.get('right');right.ensureMsiLayerLoaded=async key=>{right.msiValueRasters.set(key,{W:2,H:1,values:Float64Array.from([60,400])});return true;};
            const input=report.createAdapter(f.hooks,{useDisplayStyle:true,includeCeCv:true});
            strength=10;linearStrength=10;
            f.app.msiUserWindow.MSI_DA={max:2};f.app.msiScaleMode='individual';lut[255][0]=0;
            f.sections[0].meta.world_coords.msi_um_per_px={x:999,y:999};f.sections[0].meta.otsu.value=999;
            const entries=await input.molecules[0].loadEntries();
            assert.deepEqual(entries.map(e=>e.displayWindow),[{min:5,max:800},{min:5,max:800}],'Same includes every section and retains original-row max above duplicate-coordinate raster averages');
            assert.deepEqual(entries[0].frame.sourceBoundsUm,{x:0,y:0,width:100,height:75});
            assert.equal(entries[0].frame.aspectMode,'physical');assert.deepEqual(entries[0].pixelPitch,{x:50,y:75});
            const ticGeometry={legacy:{W:2,H:1},displayGeometry:{W:2,H:1}};
            const ticOptions={width:2,height:1,geometries:[ticGeometry,ticGeometry],registeredPitch:{x:50,y:75},orientation:f.transform,aspectMode:'physical'};
            assert.deepEqual(report.referenceFrame(ticOptions).sourceBoundsUm,{x:0,y:0,width:100,height:75});
            assert.equal(report.referenceFrame({...ticOptions,geometries:[ticGeometry,null]}),null,'TIC does not invent calibration for an unknown contributing source');
            assert.equal(report.referenceFrame({...ticOptions,geometries:[ticGeometry,{legacy:{W:3,H:1},displayGeometry:{W:2,H:1}}]}),null,'mixed source footprints cannot share a physical TIC frame');
            assert.deepEqual(input.displayStyle.lut[255],[255,0,0]);assert.equal(input.displayStyle.mode,'same');
            assert.equal(input.displayStyle.smoothingStrength,6,'PPT median strength is captured before asynchronous source loading');
            assert.equal(input.displayStyle.linearStrength,4,'PPT Linear strength is captured independently');
            assert.equal(report.createAdapter(f.hooks).displayStyle,null,'default reports do not opt into display smoothing');
            assert.deepEqual(Array.from(entries[0].keepGrid.keep),[1,0]);
            assert.equal(entries[0].stats.mean,140/3);assert.equal(entries[0].stats.max,100);
            assertPublicReport({...input,entries});
            const actual=f.app.panels.get('left').msiValueRasters.get('MSI_DA');actual.values[0]=999;
            assert.equal(entries[0].raster.values[0],20,'captured report pixels do not alias the live numeric cache');
        } finally {if(previous===undefined)delete global.MsiDisplayGeometry;else global.MsiDisplayGeometry=previous;}
    }],
    ['resampling and rotation change display geometry without relabelling acquisition pixels', async () => {
        const previous=global.MsiDisplayGeometry;
        try {
            global.MsiDisplayGeometry=require('../viewer/msi-display-geometry.js');
            const f=fixture();
            f.app.getMsiDisplaySettings=()=>({aspectMode:'physical'});
            f.hooks.sourceGeometry=()=>({legacy:{W:3,H:1},displayGeometry:{W:2,H:1}});
            const input=report.createAdapter(f.hooks),entries=await input.molecules[0].loadEntries();
            assert.deepEqual(entries[0].registeredPixelPitch,{x:50,y:75},'labels retain original X/Y even under the fixture rotation');
            assert.deepEqual(entries[0].pixelPitch,{x:100,y:75},'scale bars retain the effective pitch after 3 to 2 sample resampling');
            assert.equal(entries[0].frame.calibrated,true);
            assert.equal(entries[0].stats.mean,140/3);
            assert.equal(entries[0].stats.max,100);
        } finally {if(previous===undefined)delete global.MsiDisplayGeometry;else global.MsiDisplayGeometry=previous;}
    }],
    ['Individual display windows preserve explicit raw limits and legacy per-layer clipping', async () => {
        const f=fixture();f.app.msiUserWindow={MSI_DA:{max:75}};
        f.sections[0].msiSeries.MSI_DA.rawRange=[-2,100];f.sections[0].msiSeries.MSI_DA.rawDispMax=60;
        f.sections[1].msiSeries.MSI_DA.rawRange=[-4,100];f.sections[1].msiSeries.MSI_DA.rawDispMax=80;
        f.hooks.displayStyle=()=>({mode:'individual',rangePolicy:'legacy',lut:Array.from({length:256},(_,i)=>[i,i,i]),smoothing:'linear',otsu:false});
        const input=report.createAdapter(f.hooks,{useDisplayStyle:true}),entries=await input.molecules[0].loadEntries();
        assert.deepEqual(entries.map(e=>e.displayWindow),[{min:-2,max:75},{min:-4,max:75}]);
        assert.equal(entries[0].keepGrid,undefined);
    }],
    ['maximum display uses a unit range for all nonpositive measurements without changing negative source statistics', async () => {
        for(const mode of ['same','individual']) {
            const f=fixture();f.app.msiUserWindow={};
            f.sections.forEach(section=>{Object.assign(section.msiSeries.MSI_DA,{rawRange:[-9,-5],rawDispMax:-5,rawTrueMax:-5,rawMean:-7});});
            for(const panel of f.app.panels.values())panel.ensureMsiLayerLoaded=async key=>{panel.msiValueRasters.set(key,{W:2,H:1,values:Float64Array.from([-9,-5])});return true;};
            f.hooks.displayStyle=()=>({mode,rangePolicy:'maximum',lut:Array.from({length:256},(_,i)=>[i,i,i]),smoothing:'none',otsu:false});
            const input=report.createAdapter(f.hooks,{useDisplayStyle:true}),entries=await input.molecules[0].loadEntries();
            assert.deepEqual(entries.map(e=>e.displayWindow),[{min:0,max:1},{min:0,max:1}]);
            assert.equal(entries[0].stats.max,-5);assert.equal(entries[0].stats.mean,-7);
            f.app.msiUserWindow.MSI_DA={min:-9,max:-3};
            const manual=await report.createAdapter(f.hooks,{useDisplayStyle:true}).molecules[0].loadEntries();
            assert.deepEqual(manual[0].displayWindow,{min:-9,max:-3});
        }
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
