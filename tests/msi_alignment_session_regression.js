'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Session = require('../viewer/alignment-session.js');

const rawState = () => ({layerKey:'HE', msiKey:'MSI_A', sourceMode:'file-1',
    flip_lr:false, flip_ud:false, scale_pct:100, rotate_deg:0, offx:0, offy:0,
    landmarks:{he:[[10.25,20.5]],msi:[[2.5,3.5]]}, autoAligned:null,
    msi_um_x:50,msi_um_y:50,pickMode:'none'});
const frame = (patch) => Object.assign({sourceRef:JSON.stringify(['file-1','xlsx','scan',1,'A','rev-1']),
    reader:{kind:'xlsx',sheet:'scan',xColumn:'X',yColumn:'Y',vColumn:'A'},
    coordinateSignature:{x:[[0,0],[10,1]],y:[[0,0],[20,1]]},confirmed:true},patch);
const context = (patch) => Object.assign({layerKey:'HE',imageIdentity:'he-image-original',scope:'source',frame:frame()},patch);
const stamp = input => Session.stableKey(input);

// A -> B -> TIC -> A uses one state. Editing points on B adds to the same
// paired sequence, including unsolved (different-length) pending point lists.
{
    const initial = {HE:rawState()};
    const initialBytes = stamp(initial);
    const store = Session.create({sectionId:'section-1',initialAlignment:initial});
    const a = store.activate(context(), initial.HE);
    a.state.landmarks.he.push([40,50]);
    a.state.landmarks.msi.push([4.5,5.5]);
    a.state.scale_pct = 155;
    a.state.offx = -8.75;
    store.updateView({he:{scale:2,tx:13,ty:-4},msi:{scale:3,tx:21,ty:9}});
    const moleculeB = frame({sourceRef:JSON.stringify(['file-1','xlsx','scan',1,'B','rev-1']),
        reader:{kind:'xlsx',sheet:'scan',xColumn:'X',yColumn:'Y',vColumn:'B'}});
    const b = store.activate(context({frame:moleculeB}), rawState());
    assert.equal(a,b,'a saved seed must never overwrite an existing in-progress draft');
    assert.equal(b.state.scale_pct,155);
    assert.equal(b.state.offx,-8.75);
    assert.deepEqual(b.view.msi,{scale:3,tx:21,ty:9});
    b.state.landmarks.he.push([70.5,90.5]);
    const tic = store.activate(context({frame:frame({annotation:'TIC',msiKey:'__TIC__'})}),rawState());
    assert.equal(tic,a);
    assert.equal(tic.state.landmarks.he.length,3);
    assert.equal(tic.state.landmarks.msi.length,2);
    assert.equal(stamp(initial),initialBytes,'drafts never mutate persisted alignment');
    assert.equal(store.entries().length,1);
    assert.equal(store.isDirty(),true);
}

// Same source file ID cannot join different sheets, acquisition functions,
// coordinates or file revisions. Image dimensions alone do not prove identity.
{
    const baseline = Session.frameKey(frame());
    for (const variant of [
        frame({reader:{sheet:'scan 2',xColumn:'X',yColumn:'Y'}}),
        frame({reader:{sheet:'scan',func:2,xColumn:'X',yColumn:'Y'}}),
        frame({reader:{sheet:'scan',xColumn:'Y',yColumn:'X'}}),
        frame({sourceRevision:'rev-2'}),
        frame({coordinateSignature:{x:[[0,0],[100,1]],y:[[0,0],[20,1]]}}),
        frame({sourceRef:JSON.stringify(['file-2','xlsx','scan',1,'A','rev-1'])})
    ]) assert.notEqual(Session.frameKey(variant),baseline);
    assert.equal(Session.frameKey(frame({displayGeometry:{W:600,H:400}})),baseline,
        'display-only raster resolution is not a measurement coordinate change');
    assert.equal(Session.frameKey(frame({molecule:'B',intensityColumn:7,msiKey:'MSI_B'})),baseline);
}

// Accept the persistence resolver's authoritative key, including its reader
// definition and legacy edge-coordinate layout. Do not recompute a second key.
{
    const a = {version:'msi-alignment-frame-v1',key:'verified-measurement-a',measurementKey:'a',
        coordinateKey:'verified-xy-layout',confirmed:true,geometry:{legacy:{W:20,H:40}}};
    const b = Object.assign({},a,{key:'verified-measurement-b',measurementKey:'b'});
    assert.equal(Session.frameKey(a),'verified-measurement-a');
    assert.notEqual(Session.frameKey(a),Session.frameKey(b));
    assert.equal(Session.sharedFrameKey(a),Session.sharedFrameKey(b));
    assert.notEqual(Session.sharedFrameKey(Object.assign({},a,{confirmed:false})),
        Session.sharedFrameKey(Object.assign({},b,{confirmed:false})));
    assert.notEqual(Session.sharedFrameKey(a),Session.sharedFrameKey(Object.assign({},b,{coordinateKey:'different-xy-layout'})));
}

// Source and HE image switches retain independent deep copies, including an
// image replacement under the same HE layer label. Returning restores work.
{
    const seed = rawState();
    const store = Session.create({sectionId:'s'});
    const a = store.activate(context(),seed);
    a.state.landmarks.msi[0][0]=99;
    a.state.rotate_deg=31.2;
    const fileB = context({frame:frame({sourceId:'file-2',sourceRef:'file-2'})});
    const b = store.activate(fileB,seed);
    assert.equal(b.state.landmarks.msi[0][0],2.5);
    b.state.landmarks.he.push([900,300]);
    const heB = store.activate(context({layerKey:'IF',imageIdentity:'if-image'}),seed);
    heB.state.rotate_deg=75;
    const replacedHE = store.activate(context({imageIdentity:'replacement-he'}),seed);
    assert.equal(replacedHE.state.rotate_deg,0);
    assert.equal(store.activate(context(),rawState()),a);
    assert.equal(store.current().state.rotate_deg,31.2);
    assert.equal(store.activate(fileB,rawState()),b);
    assert.equal(store.current().state.landmarks.he.length,2);
    assert.equal(store.entries().length,4);
    assert.equal(seed.landmarks.msi[0][0],2.5);
    assert.equal(seed.landmarks.he.length,1);
}

// Shared work is distinct from each source draft; switching the shown source
// inside a confirmed shared coordinate scope never imports its saved override.
{
    const store = Session.create({sectionId:'s'});
    const individual = store.activate(context(),rawState());
    individual.state.offx=17;
    const shared = store.activate(context({scope:'shared',sharedId:'all-measurements'}),rawState());
    shared.state.offx=43;
    shared.state.landmarks.msi.push([12.5,13.5]);
    const secondSource = context({scope:'shared',sharedId:'all-measurements',
        frame:frame({sourceRef:JSON.stringify(['file-2','xlsx','scan',1,'B','rev-1'])})});
    assert.equal(store.activate(secondSource,Object.assign(rawState(),{offx:99})),shared);
    assert.equal(store.current().state.offx,43);
    assert.equal(store.current().state.landmarks.msi.length,2);
    assert.equal(store.activate(context(),rawState()).state.offx,17);
    const serialized = store.serialize();
    assert.equal(serialized.entries.length,2);
    assert.deepEqual(serialized.entries.map(r=>r.context.scope),['source','shared']);
    assert.equal(serialized.entries[1].state.landmarks.msi.length,2);
}

// Show-only changes do not mark alignment dirty and never serialize source
// values, physical pitch, zoom, pick mode, or the selected intensity column.
{
    const store=Session.create({sectionId:'s'});
    const active=store.activate(context(),rawState());
    store.update({msiKey:'MSI_B',pickMode:'msi',msi_um_x:987});
    store.updateView({msi:{scale:100,tx:2,ty:3}});
    assert.equal(store.isDirty(),false);
    assert.deepEqual(store.serialize().entries,[]);
    store.update(state=>{state.landmarks.msi.push([1.125,-0.5]);});
    const exported=store.serialize();
    const state=exported.entries[0].state;
    for(const key of ['msiKey','pickMode','msi_um_x','msi_um_y','view','sourceRows'])assert.equal(key in state,false);
    exported.entries[0].state.landmarks.msi[0][0]=999;
    exported.entries[0].context.frame.reader.sheet='corrupted-copy';
    assert.equal(active.state.landmarks.msi[0][0],2.5);
    assert.equal(active.context.frame.reader.sheet,'scan');
    const captured=rawState();
    captured.scale_pct=80;
    store.capture(captured,{he:{scale:2}});
    captured.landmarks.he[0][0]=700;
    assert.equal(store.current().state.landmarks.he[0][0],10.25);
    assert.equal(store.current().state.scale_pct,80);
    assert.deepEqual(store.current().view,{he:{scale:2}});
}

// Existing coordinates retain their edge-frame values exactly. Legacy bySource
// lookup is rejected until the caller verifies the mapping; unknown versions
// are retained as unresolved, rather than guessed to be legacy coordinates.
{
    const old=rawState();
    old.landmarks.msi=[[0.5,0.5],[123.125,77.75],[-0,NaN]];
    const layer={bySource:{'file-1':old}};
    const before=stamp(layer);
    assert.equal(Session.loadLegacy(layer,{sourceId:'file-1'}).state,null);
    const loaded=Session.loadLegacy(layer,{sourceId:'file-1',allowSource:true,frame:frame()});
    assert.deepEqual(loaded.state.landmarks,old.landmarks);
    loaded.state.landmarks.msi[0][0]=200;
    assert.equal(stamp(layer),before);
    const unknown=Object.assign(rawState(),{alignment_raster_basis:'future-msi-v99'});
    const refused=Session.loadLegacy(unknown,{scope:'shared',allowShared:true});
    assert.equal(refused.unresolvedReason,'unsupported-alignment-coordinate-basis');
    assert.deepEqual(refused.preserved,unknown);
    const wrong={bySource:{'file-1':Object.assign(rawState(),{frame:frame({sourceRevision:'new'})})}};
    assert.equal(Session.loadLegacy(wrong,{sourceId:'file-1',allowSource:true,frame:frame()}).unresolvedReason,
        'alignment-source-frame-mismatch');
}

// An intentionally shared edit and a later individual adjustment may both
// affect one source. Persist in edit order, never draft creation order, so the
// user's last explicit action wins when the caller constructs that payload.
{
    const store=Session.create({sectionId:'s'});
    const source=store.activate(context(),rawState());
    store.update({offx:10});
    const sharedContext=context({scope:'shared',sharedId:'all'});
    const shared=store.activate(sharedContext,rawState());
    store.update({offx:20});
    store.activate(context(),rawState());
    store.update({offx:30});
    const persisted=store.serialize().entries;
    assert.deepEqual(persisted.map(row=>row.context.scope),['shared','source']);
    assert.deepEqual(persisted.map(row=>row.state.offx),[20,30]);
    assert.ok(persisted[0].editRevision<persisted[1].editRevision);
    const priorRevision=source.editRevision;
    store.capture(Object.assign({},source.state,{msiKey:'MSI_C',pickMode:'he'}),{he:{scale:9}});
    assert.equal(source.editRevision,priorRevision,'view and molecule switches do not reorder alignment edits');
    // Nested arrays can alias the caller's state. A capture must still notice
    // a point change by comparing its previous independently stored signature.
    shared.state.landmarks.msi.push([40.5,41.5]);
    store.activate(sharedContext,rawState());
    store.capture(shared.state);
    assert.ok(shared.editRevision>source.editRevision);
    assert.deepEqual(store.serialize().entries.map(row=>row.context.scope),['source','shared']);
}

// Apply-to-all is an explicit commit even if the common draft equals its
// baseline. A subsequent molecule switch/capture must preserve that intent.
{
    const store=Session.create({sectionId:'s'});
    assert.throws(()=>store.forceCommit(),/Activate/);
    const sharedContext=context({scope:'shared',sharedId:'all'});
    const shared=store.activate(sharedContext,rawState());
    assert.equal(store.isDirty(),false);
    store.forceCommit();
    assert.equal(store.isDirty(),true);
    const revision=shared.editRevision;
    store.capture(Object.assign({},shared.state,{msiKey:'MSI_B'}));
    assert.equal(shared.editRevision,revision);
    const serialized=store.serialize().entries;
    assert.equal(serialized.length,1);
    assert.equal(serialized[0].context.scope,'shared');
    assert.equal(serialized[0].editRevision,revision);
    store.forceCommit();
    assert.ok(shared.editRevision>revision);
    store.close();
    assert.throws(()=>store.forceCommit(),/closed/);
}

// Cancel cannot alter the input or let late image/worker callbacks update the
// closed session. Clone preserves numeric details instead of JSON coercion.
{
    const initial={HE:rawState(),audit:{value:NaN,zero:-0,missing:undefined,precision:new Float64Array([1/3,1e30])}};
    const before=stamp(initial);
    const store=Session.create({sectionId:'s',initialAlignment:initial});
    const active=store.activate(context(),initial.HE);
    active.state.landmarks.he[0][0]=999;
    const cancelled=store.cancel();
    assert.deepEqual(cancelled,initial);
    cancelled.HE.landmarks.he.push([500,600]);
    cancelled.audit.precision[0]=0;
    active.state.landmarks.he.push([700,800]);
    assert.equal(stamp(initial),before);
    assert.equal(stamp(store.original()),before);
    assert.equal(store.current(),null);
    assert.equal(store.isDirty(),false);
    assert.throws(()=>store.capture(rawState()),/closed/);
    assert.throws(()=>store.activate(context(),rawState()),/closed/);
    assert.throws(()=>store.update({offx:10}),/closed/);
    assert.throws(()=>store.serialize(),/closed/);
}

// Browser global is available without a module loader; the pure module itself
// does not require browser APIs, IndexedDB, project state or network access.
{
    const sandbox={};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../viewer/alignment-session.js'),'utf8'),sandbox);
    assert.equal(typeof sandbox.MsiAlignmentSession.create,'function');
    assert.equal(sandbox.MsiAlignmentSession.create({sectionId:'s'}).entries().length,0);
}
console.log('MSI alignment session regression tests passed.');
