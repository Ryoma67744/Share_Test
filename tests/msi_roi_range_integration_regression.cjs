'use strict';
const {displayContext}=require('./viewer-runtime.cjs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {html, standalone} = require('./viewer-runtime.cjs');
const MsiRoiRange = require('../viewer/msi-roi-range.js');
const KEY = 'MSI_same';
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}
function appMethod(name) {
    const appStart = html.indexOf('const App = {');
    let start = html.indexOf('    ' + name + '(', appStart);
    if (start < 0) start = html.indexOf('    async ' + name + '(', appStart);
    assert.ok(start >= appStart, 'missing App method: ' + name);
    const end = html.indexOf('\n    },', start);
    assert.ok(end > start, 'unterminated App method: ' + name);
    return html.slice(start, end + 7);
}
function project(id, samples = [[10, 20]]) {
    return {id, meta:{}, roiHidden:{}, sections:samples.map((values, index) => ({
        id:'section-' + index, meta:{}, values,
        msiSeries:{[KEY]:{kind:'txt', sourceReference:'source-' + index, blobId:id + '-blob-' + index,
            rawRange:[0, 900], rawDispMax:900, rawTrueMax:999, bakeMode:'full'}}
    })), rois:[{id:'roi', polysBySection:Object.fromEntries(samples.map((_, i) => ['section-' + i,
        [[-0.5,-0.5],[1.5,-0.5],[1.5,0.5],[-0.5,0.5]]]))}]};
}
function geometry(section) {
    return {sourceRef:section.msiSeries[KEY].sourceReference,
        legacy:{confirmed:true, x:[[0,0],[1,1]], y:[[0,0]]},
        displayGeometry:{version:'msi-proportional-v1', W:2, H:1,
            x:{origin:0,step:1}, y:{origin:0,step:1}}};
}
function valueRaster(section, values = section.values) {
    return {W:2, H:1, values:Float64Array.from(values), sourceGeometry:geometry(section)};
}
function grid(section, values = section.values) {
    return {sourceGeometry:geometry(section), rows:values.map((v, x) => ({x,y:0,v,rowId:x}))};
}
function panel(section, values = section.values) {
    return {section, msiValueRasters:new Map(values ? [[KEY,valueRaster(section,values)]] : []),
        ensureMsiLayerLoaded:async () => false};
}
function fixture(initial = project('A')) {
    let stamp = 0;
    const stamps = new WeakMap();
    const environment = {readGrid:section => Promise.resolve(grid(section)), repaints:0};
    const context = displayContext({console, MsiRoiRange, MSI_DEFAULT_DISPLAY_PERCENTILE:0.999,
        document:{getElementById:() => null},
        identStamp(value) { if (!value) return 0; if (!stamps.has(value)) stamps.set(value,++stamp); return stamps.get(value); },
        _ensureRoiRawGrid:(section,key) => environment.readGrid(section,key),
        roiPolygonForDisplay:(roi,section,key,poly) => poly});
    const helpers = ['msiSourceReference','msiDisplayContextKey','msiDisplayMeasurementSignature','ensureMsiDisplayContext',
        '_roiGridKey','msiRoiGeometryMeta','msiValidRoiGeometry','msiAxisInterpolate','pointInPolygon','roiContainsSourcePoint'];
    const methods = ['getMsiUserWindows','_roiDisplayRangeRequest','getRoiDisplayRange','ensureRoiDisplayRange',
        'roiDisplayCeiling','roiRangeStatusText','_organInScope','getMsiWindow','getMsiAbsMax',
        'refreshRoiDisplayRanges','recomputeMsiAbsScale','setRoiOnlyMode'];
    vm.runInContext(helpers.map(standalone).join('\n') + '\nglobalThis.app = {\n' + methods.map(appMethod).join('\n') + '\n};', context);
    const app = context.app;
    Object.assign(app,{project:initial, panels:new Map(), roiOnlyMode:true, msiScaleMode:'same', rangePolicy:'legacy',
        viewMode:'compound', focusCompoundKey:KEY,
        msiUserWindow:{}, getMsiDisplaySettings() { return {rangePolicy:this.rangePolicy}; },
        scheduleRoiRangeRepaint() { environment.repaints++; },
        repaintRoiRangeViews() { environment.repaints++; }});
    function open(next) {
        app.project = next;
        app.panels = new Map(next.sections.map(section => [section.id,panel(section)]));
        context.ensureMsiDisplayContext(app,KEY);
    }
    open(initial);
    return {app,context,environment,open};
}
async function prepare(app) {
    await Promise.all(app.project.sections.map(section => app.ensureRoiDisplayRange(section,KEY)));
}
function windowFor(app, section = app.project.sections[0]) {
    const ent = section.msiSeries[KEY];
    return plain(app.getMsiWindow(KEY,ent.rawRange,ent.rawDispMax,ent.rawTrueMax,section));
}

async function rebuiltPanelDoesNotReusePending(newFinishesFirst) {
    const {app,environment} = fixture(), section = app.project.sections[0];
    const first = deferred(), second = deferred(), enteredFirst = deferred(), enteredSecond = deferred();
    let reads = 0;
    environment.readGrid = () => { reads++; if (reads === 1) { enteredFirst.resolve(); return first.promise; } enteredSecond.resolve(); return second.promise; };
    const oldJob = app.ensureRoiDisplayRange(section,KEY);
    await enteredFirst.promise;
    assert.equal(app.ensureRoiDisplayRange(section,KEY), oldJob, 'same panel should reuse its pending work');
    const oldEntry = app._roiDisplayRanges.get(JSON.stringify([section.id,KEY]));
    app.panels.set(section.id,panel(section,[30,40]));
    const newJob = app.ensureRoiDisplayRange(section,KEY);
    await enteredSecond.promise;
    const newEntry = app._roiDisplayRanges.get(JSON.stringify([section.id,KEY]));
    assert.notEqual(newJob,oldJob,'a recreated panel must start a new request');
    assert.notEqual(newEntry,oldEntry);
    if (newFinishesFirst) { second.resolve(grid(section,[30,40])); assert.equal((await newJob).raster.max,40); }
    first.resolve(grid(section,[10,20]));
    assert.equal((await oldJob).status,'stale');
    assert.equal(app._roiDisplayRanges.get(JSON.stringify([section.id,KEY])),newEntry,'old completion must preserve replacement entry');
    if (!newFinishesFirst) { second.resolve(grid(section,[30,40])); assert.equal((await newJob).raster.max,40); }
    assert.equal(app.getRoiDisplayRange(section,KEY).raster.max,40);
    assert.equal(reads,2);
}

async function rasterArrivalAndReplacement() {
    const {app,environment} = fixture(), section = app.project.sections[0];
    const currentPanel = panel(section,null);
    app.panels.set(section.id,currentPanel);
    assert.equal((await app.ensureRoiDisplayRange(section,KEY)).status,'unavailable');
    currentPanel.msiValueRasters.set(KEY,valueRaster(section,[30,40]));
    environment.readGrid = () => Promise.resolve(grid(section,[30,40]));
    assert.equal(app.getRoiDisplayRange(section,KEY).status,'pending','a newly available raster invalidates unavailable result');
    assert.equal((await app.ensureRoiDisplayRange(section,KEY)).raster.max,40);

    const oldGrid = deferred(), entered = deferred();
    environment.readGrid = () => { entered.resolve(); return oldGrid.promise; };
    currentPanel.msiValueRasters.set(KEY,valueRaster(section,[50,60]));
    const job = app.ensureRoiDisplayRange(section,KEY);
    await entered.promise;
    currentPanel.msiValueRasters.set(KEY,valueRaster(section,[70,80]));
    oldGrid.resolve(grid(section,[50,60]));
    assert.equal((await job).status,'stale','replaced raster cannot accept an older asynchronous summary');
    environment.readGrid = () => Promise.resolve(grid(section,[70,80]));
    assert.equal((await app.ensureRoiDisplayRange(section,KEY)).source.max,80);
    assert.equal(windowFor(app).max,80);
}

async function changedProjectDropsPending() {
    const f = fixture(), oldSection = f.app.project.sections[0], pending = deferred(), entered = deferred();
    f.environment.readGrid = () => { entered.resolve(); return pending.promise; };
    const oldJob = f.app.ensureRoiDisplayRange(oldSection,KEY);
    await entered.promise;
    f.open(project('B',[[70,80]]));
    f.environment.readGrid = section => Promise.resolve(grid(section));
    await prepare(f.app);
    const newCache = f.app._roiDisplayRanges;
    pending.resolve(grid(oldSection));
    assert.equal((await oldJob).status,'stale');
    assert.equal(f.app._roiDisplayRanges,newCache);
    assert.equal(windowFor(f.app).max,80);
}

async function rasterLruRetainsStableLoadSummaries() {
    const {app,environment} = fixture(), section = app.project.sections[0];
    const currentPanel = app.panels.get(section.id);
    let identity = 'load-1', reads = 0;
    currentPanel._msiLoadIdentity = () => identity;
    environment.readGrid = () => { reads++; return Promise.resolve(grid(section)); };
    await prepare(app);
    const original = app.getRoiDisplayRange(section,KEY);
    currentPanel.msiValueRasters.delete(KEY);
    assert.equal(app.getRoiDisplayRange(section,KEY),original,'raster LRU eviction must preserve its completed summary');
    assert.equal(await app.ensureRoiDisplayRange(section,KEY),original);
    currentPanel.msiValueRasters.set(KEY,valueRaster(section));
    assert.equal(app.getRoiDisplayRange(section,KEY),original,'same source/readers reloaded into a new raster may reuse the summary');
    assert.equal(await app.ensureRoiDisplayRange(section,KEY),original);
    assert.equal(reads,1);
    // A load generation can change before its old raster is replaced. The
    // identity check must take precedence over equality of the raster object.
    identity = 'load-2';
    assert.equal(app.getRoiDisplayRange(section,KEY).status,'pending');
    const updated = await app.ensureRoiDisplayRange(section,KEY);
    assert.equal(updated.status,'ready');
    assert.notEqual(updated,original);
    assert.equal(reads,2,'changed load identity must recompute even while the old raster object remains');
    identity = 'load-3';
    assert.equal(app.getRoiDisplayRange(section,KEY).status,'pending','a changed load generation invalidates even the exact cached raster');
    await app.ensureRoiDisplayRange(section,KEY);
    assert.equal(reads,3);
    identity = 'load-4';
    currentPanel.msiValueRasters.set(KEY,valueRaster(section,[30,40]));
    environment.readGrid = () => { reads++; return Promise.resolve(grid(section,[30,40])); };
    assert.equal((await app.ensureRoiDisplayRange(section,KEY)).raster.max,40);
    assert.equal(reads,4,'changed load identity and raster must recompute');
    const pending = deferred(), entered = deferred();
    identity = 'load-5';
    currentPanel.msiValueRasters.set(KEY,valueRaster(section,[50,60]));
    environment.readGrid = () => { entered.resolve(); return pending.promise; };
    const job = app.ensureRoiDisplayRange(section,KEY);
    await entered.promise;
    identity = 'load-6';
    pending.resolve(grid(section,[50,60]));
    assert.equal((await job).status,'stale','a load generation changed during source read must discard the result');
}

async function negativeRanges() {
    const {app} = fixture(project('negative',[[-9,-5],[-3,-1]]));
    await prepare(app);
    for (const section of app.project.sections) assert.deepEqual(windowFor(app,section),{min:-9,max:-1},'legacy Same must use one shared negative window');
    app.activeSectionScope = new Set(['section-0']);
    assert.deepEqual(windowFor(app),{min:-9,max:-5},'Same excludes sections outside active scope');
    app.activeSectionScope = null;
    app.msiScaleMode = 'individual';
    assert.deepEqual(windowFor(app),{min:-9,max:-5});
    app.rangePolicy = 'maximum';
    for (const mode of ['same','individual']) {
        app.msiScaleMode = mode;
        for (const section of app.project.sections) assert.deepEqual(windowFor(app,section),{min:0,max:1});
    }
}

async function largeVisibleGridKeepsItsSummaries() {
    const {app,environment} = fixture(project('large',Array.from({length:257}, (_, i) => [i + 1,i + 2])));
    let reads = 0;
    environment.readGrid = section => { reads++; return Promise.resolve(grid(section)); };
    await app.refreshRoiDisplayRanges();
    assert.equal(reads,257);
    assert.equal(app._roiDisplayRanges.size,257,'soft cache limit must retain all active Same participants');
    const repaints = environment.repaints;
    for (let i = 0; i < 4; i++) {
        assert.equal(app.getMsiAbsMax(KEY),258);
        for (const section of app.project.sections) assert.equal(app.getRoiDisplayRange(section,KEY).status,'ready');
    }
    await Promise.resolve();
    assert.equal(reads,257,'checking common Range must not restart evicted active work');
    assert.equal(environment.repaints,repaints,'completed large-grid summaries must not trigger a repaint loop');
    await app.refreshRoiDisplayRanges();
    assert.equal(reads,257,'explicit refresh also reuses every ready active summary');
}

async function explicitRetryRecoversSourceFailure() {
    const {app,environment} = fixture();
    let available = false, reads = 0;
    environment.readGrid = section => { reads++; return Promise.resolve(available ? grid(section) : null); };
    app.rangePolicy = 'maximum';
    await prepare(app);
    const section = app.project.sections[0];
    const failed = app.getRoiDisplayRange(section,KEY);
    assert.equal(failed.status,'ready');
    assert.equal(failed.raster.status,'ready');
    assert.equal(failed.source.status,'unavailable');
    assert.deepEqual(windowFor(app),{min:0,max:1});
    await prepare(app);
    assert.equal(reads,1,'a failed source must not be retried on every repaint');
    available = true;
    await app.setRoiOnlyMode(true);
    assert.equal(reads,2,'explicit ROI-only retry invalidates nested source failure');
    assert.equal(app.getRoiDisplayRange(section,KEY).source.max,20);
    assert.deepEqual(windowFor(app),{min:0,max:20});
}

async function settingsPaintSkipsCachedRangePass() {
    const {app,environment} = fixture();
    await prepare(app);
    const before = windowFor(app), refresh = app.refreshRoiDisplayRanges;
    let refreshing;
    app.refreshRoiDisplayRanges = function(...args) { return refreshing = refresh.apply(this,args); };
    environment.repaints = 0;
    app.recomputeMsiAbsScale({paint:false});
    await refreshing;
    assert.equal(environment.repaints,0,'settings that already paint must not repaint again for cached ROI ranges');
    assert.deepEqual(windowFor(app),before,'paint suppression does not change a cached ROI window');
    app.recomputeMsiAbsScale();
    await refreshing;
    assert.equal(environment.repaints,1,'ordinary explicit ROI refresh keeps its repaint behavior');
}

async function deferredRangeStillSchedulesCompletionPaint() {
    const {app,context,environment} = fixture(), section = app.project.sections[0];
    const pending = deferred(), entered = deferred(), callbacks = [];
    environment.readGrid = () => { entered.resolve(); return pending.promise; };
    context.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
    app.scheduleRoiRangeRepaint = vm.runInContext('({' + appMethod('scheduleRoiRangeRepaint') + '}).scheduleRoiRangeRepaint',context);
    const refresh = app.refreshRoiDisplayRanges;
    let refreshing;
    app.refreshRoiDisplayRanges = function(...args) { return refreshing = refresh.apply(this,args); };
    app.recomputeMsiAbsScale({paint:false});
    await entered.promise;
    assert.equal(environment.repaints,0);
    assert.equal(callbacks.length,0,'a pending source read cannot publish its range yet');
    pending.resolve(grid(section));
    await refreshing;
    assert.equal(environment.repaints,0,'the deferred refresh itself does not add a second repaint');
    assert.equal(callbacks.length,1,'a new ROI result still schedules the existing completion repaint');
    callbacks[0]();
    assert.equal(environment.repaints,1,'the completion scheduler publishes the newly calculated range');
    assert.equal(windowFor(app).max,20);
}

async function separateManualContexts() {
    const A = project('A'), B = project('B',[[30,40]]), f = fixture(A), {app} = f;
    const unchanged = JSON.stringify(A);
    function set(mode,max) { app.roiOnlyMode = mode; windowFor(app); app.getMsiUserWindows()[KEY] = {max}; }
    function check(normal,roi) {
        app.roiOnlyMode = false; assert.equal(windowFor(app).max,normal);
        app.roiOnlyMode = true; assert.equal(windowFor(app).max,roi);
    }
    await prepare(app);
    set(false,400); set(true,12); check(400,12);
    f.open(B); await prepare(app);
    check(900,40); set(false,500); set(true,32);
    f.open(A); await prepare(app); check(400,12);
    app.shareMode = {slug:'shared',role:'viewer',token:'first'};
    await prepare(app); check(900,20); set(false,600); set(true,13);
    app.shareMode.role = 'admin'; await prepare(app); check(900,20); set(false,700); set(true,14);
    app.shareMode.role = 'viewer'; await prepare(app); check(600,13);
    app.shareMode.token = 'refreshed'; check(600,13);
    app.shareMode = null; await prepare(app); check(400,12);
    assert.equal(JSON.stringify(A),unchanged,'display overrides must remain session-only');
    // A changed measurement invalidates both mode overrides together, even if
    // only one display mode is active when its signature is checked.
    A.sections[0].msiSeries[KEY].sourceRevision = 'new-source';
    app.roiOnlyMode = false; windowFor(app);
    assert.equal(app.msiUserWindow[KEY],undefined);
    assert.equal(app.msiRoiUserWindow[KEY],undefined);
    await prepare(app); check(900,20);
}

async function main() {
    await rebuiltPanelDoesNotReusePending(false);
    await rebuiltPanelDoesNotReusePending(true);
    await rasterArrivalAndReplacement();
    await changedProjectDropsPending();
    await rasterLruRetainsStableLoadSummaries();
    await negativeRanges();
    await largeVisibleGridKeepsItsSummaries();
    await explicitRetryRecoversSourceFailure();
    await settingsPaintSkipsCachedRangePass();
    await deferredRangeStillSchedulesCompletionPaint();
    await separateManualContexts();
    console.log('MSI ROI range lifecycle, negative values and display contexts: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
