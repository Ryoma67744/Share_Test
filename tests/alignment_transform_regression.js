'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Transform = require('../viewer/alignment-transform.js');
const Session = require('../viewer/alignment-session.js');

let checks = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const near = (actual, expected, tolerance = 1e-10, message) => {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
        message || `${actual} should be within ${tolerance} of ${expected}`); checks++;
};
const rejects = (action, code) => { assert.throws(action, error => error.code === code); checks++; };
const apply = (T, p) => [T[0][0] * p[0] + T[0][1] * p[1] + T[0][2],
    T[1][0] * p[0] + T[1][1] * p[1] + T[1][2]];
const unchanged = (value, before) => equal(Session.stableKey(value), before, 'input data must remain unchanged');
const params = patch => Object.assign({flip_lr:false,flip_ud:false,scale_pct:0.15,
    rotate_deg:10,offx:0.4,offy:0.2},patch);
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const key of Object.keys(value)) freeze(value[key]);
    }
    return value;
}

// An explicit canonical matrix is authoritative, including corrupt presence.
// It must not be silently replaced by plausible old sliders or a fallback.
{
    const canonical = [[0.01,0.002,17],[-0.003,0.02,-8],[0,0,1]];
    const state = freeze(Object.assign(params(), {T_he_to_msi:canonical,
        T:[[1,0,99],[0,1,100],[0,0,1]],sourceMode:'source-A'}));
    equal(Transform.matrix(state),canonical);
    const copy = Transform.matrix(state); copy[0][0] = 99;
    equal(state.T_he_to_msi,canonical);
    for (const broken of [undefined,null,[[1,0,0],[0,0,0],[0,0,1]],
        [[1,0,0],[0,1,0],[0,0,2]],[[1,0,0],[0,1,Infinity],[0,0,1]],
        [[1,'0',0],[0,1,0],[0,0,1]]]) {
        const invalid = Object.assign(params(),{T_he_to_msi:broken,T:canonical});
        equal(Transform.valid(broken),false);
        rejects(()=>Transform.matrix(invalid),'invalid-transform');
        rejects(()=>Transform.restore(invalid,canonical),'invalid-transform');
    }
    equal(Transform.matrix({T:canonical}),canonical,'legacy T is preserved when canonical is absent');
    equal(Transform.restore(params(),canonical).T_he_to_msi,canonical,
        'a verified matrix fallback takes precedence over stale slider values');
    equal(Transform.valid([[1e-6,0,0],[0,1e-6,0],[0,0,1]]),true);
    equal(Transform.valid([[1e-7,0,0],[0,1e-7,0],[0,0,1]]),false);
    rejects(()=>Transform.fromScalars(params({scale_pct:1e-5})),'invalid-transform');
}

// A genuine affine keeps every coefficient, including signed zero and
// nonuniform scale/shear. Ordinary controls cannot project it to similarity.
{
    const T = [[1/3,0.0123456789012345,-0],[-0.0076543210987654,0.25,17.125],[0,0,1]];
    const saved = freeze(Object.assign(params(),{T_he_to_msi:T,transformModel:'similarity',
        frame:{version:'msi-alignment-frame-v1',key:'same-measurement'},
        sourceMode:'file-A',landmarks:{he:[[1,2]],msi:[[3,4]]},autoAligned:{dice:0.91}}));
    const before = Session.stableKey(saved);
    const restored = Transform.restore(saved);
    equal(restored.T_he_to_msi,T);
    equal(restored.transformModel,'affine');
    equal(restored.fitMode,'manual');
    equal([restored.scale_pct,restored.rotate_deg,restored.flip_lr,restored.flip_ud],[null,null,null,null]);
    equal(restored.offx,-0); equal(restored.offy,17.125);
    equal(restored.renderContract,undefined,'loading cannot opt an old image into new rendering');
    equal(Transform.restore(restored).T_he_to_msi,T);
    for (const key of ['scale_pct','rotate_deg','offx','offy','flip_lr','flip_ud']) {
        rejects(()=>Transform.edit(restored,key,key.startsWith('flip') ? true : 2,[5,6]),'affine-controls-unsupported');
    }
    const upgraded = Transform.upgrade(restored,'import');
    equal(upgraded.T_he_to_msi,T); equal(upgraded.transformModel,'affine');
    equal(upgraded.renderContract,'msi-shared-display-v1');
    equal(upgraded.alignmentContractVersion,2); equal(upgraded.fitMode,'manual');
    unchanged(saved,before);
    restored.T_he_to_msi[0][0] = 4; restored.landmarks.he[0][0] = 100;
    unchanged(saved,before);
}

// Similarity decomposition works for every flip parity and tiny valid
// scales, while retaining matching saved angles and scalar values exactly.
{
    for (const flip_lr of [false,true]) for (const flip_ud of [false,true]) {
        for (const scale_pct of [0.00011,0.15,100,750]) for (const rotate_deg of [-179.9,0,37.25,360]) {
            const original = params({flip_lr,flip_ud,scale_pct,rotate_deg});
            const T = Transform.fromScalars(original);
            const restored = Transform.restore(Object.assign({},original,{T_he_to_msi:T}));
            equal(restored.transformModel,'similarity'); equal(restored.T_he_to_msi,T);
            for (const key of Object.keys(original)) equal(restored[key],original[key]);
            const fromMatrix = Transform.restore({T_he_to_msi:T});
            equal(fromMatrix.transformModel,'similarity');
            const rebuilt = Transform.fromScalars(fromMatrix);
            for (const p of [[0,0],[4000,3000],[-100,250]]) {
                const expected = apply(T,p), actual = apply(rebuilt,p);
                near(actual[0],expected[0],1e-8); near(actual[1],expected[1],1e-8);
            }
        }
    }
    const trueAffine = [[0.0015,1e-9,0],[0,0.0015,0],[0,0,1]];
    equal(Transform.restore({T_he_to_msi:trueAffine}).transformModel,'affine',
        'a small real shear is not rounded away by an absolute tolerance');
    const mismatched = Object.assign(params({scale_pct:100,rotate_deg:90}),
        {T_he_to_msi:Transform.fromScalars(params())});
    const restored = Transform.restore(mismatched);
    near(restored.scale_pct,0.15); near(restored.rotate_deg,10);
}

// Editing scale/rotation/flips fixes the current MSI location of the raw HE
// anchor, rather than snapping it to the MSI landmark centroid. Translation
// edits leave all linear coefficients untouched. No input object is mutated.
{
    const source = freeze(Object.assign(params(),{
        T_he_to_msi:Transform.fromScalars(params()),fitMode:'automatic',sourceMode:'file-A',
        landmarks:{he:[[500,500],[2500,500],[3000,1800],[700,2400]],
            msi:[[1,1],[4,1],[4,4],[1,4]]},autoAligned:{dice:0.99}}));
    const before = Session.stableKey(source), anchor = [1675,1300];
    const fixed = apply(source.T_he_to_msi,anchor);
    for (const [key,value] of [['scale_pct',0.25],['rotate_deg',25],['flip_lr',true],['flip_ud',true]]) {
        const edited = Transform.edit(source,key,value,anchor);
        const p = apply(edited.T_he_to_msi,anchor);
        near(p[0],fixed[0]); near(p[1],fixed[1]);
        equal(edited[key],value); equal(edited.fitMode,'manual');
        equal(edited.sourceMode,'file-A'); equal(edited.autoAligned,null);
        equal(edited.fitProvenance.method,'manual');
        equal(edited.alignmentContractVersion,2); unchanged(source,before);
    }
    equal(Transform.edit(source,'scale_pct',0.25).T_he_to_msi,
        Transform.edit(source,'scale_pct',0.25,anchor).T_he_to_msi,
        'omitted anchors use the complete HE landmark centroid');
    for (const [key,value,row] of [['offx',12,0],['offy',-5,1]]) {
        const edited = Transform.edit(source,key,value);
        for (let r=0;r<2;r++) for (let c=0;c<2;c++) equal(edited.T_he_to_msi[r][c],source.T_he_to_msi[r][c]);
        equal(edited.T_he_to_msi[row][2],value);
        equal(edited.T_he_to_msi[1-row][2],source.T_he_to_msi[1-row][2]);
    }
    const noPoints = Object.assign(params(),{landmarks:{he:[],msi:[]}});
    rejects(()=>Transform.edit(noPoints,'scale_pct',0.3),'anchor-required');
    const imageCenter = [2000,1500];
    const centered = Transform.edit(noPoints,'scale_pct',0.3,imageCenter);
    const oldCenter = apply(Transform.matrix(noPoints),imageCenter), newCenter = apply(centered.T_he_to_msi,imageCenter);
    near(oldCenter[0],newCenter[0]); near(oldCenter[1],newCenter[1]);
    rejects(()=>Transform.edit(source,'scale_pct',0,anchor),'invalid-scale');
    rejects(()=>Transform.edit(source,'scale_pct',-1,anchor),'invalid-scale');
    rejects(()=>Transform.edit(source,'offx',NaN),'invalid-parameter');
    rejects(()=>Transform.edit(source,'rotate_deg',Infinity,anchor),'invalid-parameter');
    rejects(()=>Transform.edit(source,'flip_lr','false',anchor),'invalid-parameter');
    rejects(()=>Transform.edit(source,'scale_pct',0.25,[NaN,2]),'invalid-anchor');
    rejects(()=>Transform.edit(source,'scale_pct',1e-5,anchor),'invalid-transform');
    unchanged(source,before);
}

// A no-op is exact and does not mark an old record corrected or discard its
// saved silhouette score. Matrix coefficients are never roundtripped through
// sliders merely because the modal has been opened or a value synchronized.
{
    const state = Object.assign(params({rotate_deg:360}),{fitMode:'automatic',autoAligned:{dice:0.98}});
    state.T_he_to_msi = Transform.fromScalars(state);
    const before = Session.stableKey(state);
    for (const key of ['flip_lr','flip_ud','scale_pct','rotate_deg','offx','offy']) {
        const result = Transform.edit(state,key,state[key]);
        equal(result.T_he_to_msi,state.T_he_to_msi);
        equal(result.autoAligned,state.autoAligned); equal(result.fitMode,'automatic');
        equal(result.renderContract,undefined); equal(result.fitProvenance,undefined);
    }
    unchanged(state,before);
}

// Fit is independent of starting scale and offsets, solves actual nonidentity
// geometry, respects all explicit reflection choices, and preserves flags'
// unrelated source state. It returns a canonical matrix ready to apply.
{
    const he = [[500,500],[2500,500],[3000,1800],[700,2400]];
    for (const flip_lr of [false,true]) for (const flip_ud of [false,true]) {
        const truth = Transform.fromScalars(params({flip_lr,flip_ud}));
        const landmarks = freeze({he:he.map(p=>p.slice()),msi:he.map(p=>apply(truth,p))});
        const before = Session.stableKey(landmarks);
        let priorFit = null;
        for (const priorScale of [0.12,0.18,250]) {
            const flags = freeze(params({flip_lr,flip_ud,scale_pct:priorScale,offx:999,offy:-99,
                sourceMode:'measurement-A',fitMode:'manual',autoAligned:{dice:0.97}}));
            const flagsBefore = Session.stableKey(flags);
            const fitted = Transform.fit(landmarks,flags);
            near(fitted.scale_pct,0.15); near(fitted.rotate_deg,10);
            near(fitted.offx,0.4); near(fitted.offy,0.2);
            equal(fitted.fitMode,'automatic'); equal(fitted.transformModel,'similarity');
            equal(fitted.sourceMode,'measurement-A'); equal(fitted.autoAligned,null);
            equal(fitted.fitProvenance.pointCount,4); equal(fitted.fitProvenance.method,'landmarks');
            if (priorFit) equal(fitted.T_he_to_msi,priorFit.T_he_to_msi);
            for (let i=0;i<he.length;i++) {
                const p = apply(fitted.T_he_to_msi,he[i]);
                near(p[0],landmarks.msi[i][0]); near(p[1],landmarks.msi[i][1]);
            }
            priorFit = fitted; unchanged(flags,flagsBefore); unchanged(landmarks,before);
        }
    }
    const two = Transform.fit({he:[[0,0],[1000,250]],msi:[[2,3],[5,-2]]});
    for (let i=0;i<2;i++) {
        const p = apply(two.T_he_to_msi,two.landmarks.he[i]);
        near(p[0],two.landmarks.msi[i][0]); near(p[1],two.landmarks.msi[i][1]);
    }
    equal(two.fitProvenance.pointCount,2,'two-point fits remain available for explicit provisional Solve');
    const initial = freeze(params({fitMode:'manual',sourceMode:'saved-source'}));
    const before = Session.stableKey(initial);
    rejects(()=>Transform.fit({he:[[1,2]],msi:[[3,4]]},initial),'landmark-pairs-required');
    rejects(()=>Transform.fit({he:[[1,2],[3,4]],msi:[[3,4]]},initial),'landmark-pairs-required');
    rejects(()=>Transform.fit({he:[[1,2],[1,2]],msi:[[3,4],[5,6]]},initial),'degenerate-landmarks');
    rejects(()=>Transform.fit({he:[[0,0],[100,0]],msi:[[3,4],[3,4]]},initial),'invalid-transform');
    rejects(()=>Transform.fit({he:[[0,0],[100,NaN]],msi:[[3,4],[5,6]]},initial),'invalid-landmarks');
    unchanged(initial,before);
}

// Upgrading is explicit. Silhouette application retains its own current score
// but stays manual; a later manual edit invalidates that score.
{
    const old = Object.assign(params(),{autoAligned:{dice:0.93},fitMode:'automatic'});
    const silhouette = Transform.upgrade(old,'silhouette');
    equal(silhouette.fitMode,'manual'); equal(silhouette.autoAligned,{dice:0.93});
    equal(silhouette.fitProvenance.method,'silhouette');
    equal(Transform.edit(silhouette,'offx',8).autoAligned,null);
    equal(old.renderContract,undefined);
    const bad = Object.assign(params(),{T_he_to_msi:[[0,0,0],[0,0,0],[0,0,1]]});
    rejects(()=>Transform.upgrade(bad,'manual'),'invalid-transform');
}

// UMD browser loading is independent of DOM/canvas/project globals.
{
    const sandbox = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../viewer/alignment-transform.js'),'utf8'),sandbox);
    equal(typeof sandbox.MsiAlignmentTransform.fit,'function');
    equal(sandbox.MsiAlignmentTransform.valid([[1,0,0],[0,1,0],[0,0,1]]),true);
}
console.log(`Alignment transform regression tests passed (${checks} checks).`);
