'use strict';
const assert=require('node:assert/strict');
const {harness,fixture,plain}=require('./msi_alignment_regression.js');
const Groups=require('../viewer/msi-spatial-groups.js');

function fresh(compatible=true) {
    const section=fixture();
    delete section.meta.alignmentSourceMode;delete section.meta.perSourceAlign;
    section.meta.alignment={};delete section.meta.world_coords.T_he_to_msi;
    if(compatible) {
        const g=section.msiSeries.MSI_C.sourceGeometry=plain(section.msiSeries.MSI_A.sourceGeometry);
        g.sourceRef='source-2';section.msiSeries.MSI_C.W=8;section.msiSeries.MSI_C.H=6;
    }
    return section;
}
const groupMode=section=>'__group__|'+section.meta.spatialGroups.groups[0].id;
async function aligned(section=fresh()) {
    const h=await harness({section,spatial:true});
    assert.match(h.$('[data-align-source]').value,/^__group__\|/);
    await h.input('[data-scale-num]',150);await h.click('[data-save]');
    assert.equal(h.outcome,'saved');return h;
}

(async()=>{
    const first=await aligned();
    assert.equal(Object.keys(first.section.meta.alignment.HE_STAIN.byGroup).length,1);
    assert.equal(first.panel._resolveTHeToMsi('HE_STAIN','MSI_A')[0][0],1.5);
    assert.equal(first.panel._resolveTHeToMsi('HE_STAIN','MSI_C')[0][0],1.5);
    assert.equal(Object.keys(first.section.meta.alignment.HE_STAIN.byFrame).length,0,'common alignment is one persistent group record');
    first.assertNumericUnchanged();

    const late=plain(first.section.msiSeries.MSI_C);
    late.sourceFileId='file-3';late.sourceReference='source-3';late.sourceGeometry.sourceRef='source-3';
    first.section.msiSeries.MSI_D=late;
    assert.equal(first.panel._resolveTHeToMsi('HE_STAIN','MSI_D'),null,'an unverified new measurement cannot inherit');
    Groups.ensureGroup(first.section,late,late.sourceGeometry);
    assert.equal(first.panel._resolveTHeToMsi('HE_STAIN','MSI_D')[0][0],1.5,'verified later registration inherits without another common save');

    const individual=await harness({section:first.section,spatial:true});
    await individual.change('[data-align-source]','file-2');
    await individual.input('[data-scale-num]',175);await individual.click('[data-save]');
    assert.equal(individual.panel._resolveTHeToMsi('HE_STAIN','MSI_C')[0][0],1.75);
    const common=await harness({section:individual.section,spatial:true});
    assert.equal(common.$('[data-align-source]').value,'file-2','explicit individual mode survives reopening');
    await common.change('[data-align-source]',groupMode(common.section));
    await common.input('[data-scale-num]',160);await common.click('[data-save]');
    assert.equal(common.panel._resolveTHeToMsi('HE_STAIN','MSI_A')[0][0],1.6);
    assert.equal(common.panel._resolveTHeToMsi('HE_STAIN','MSI_C')[0][0],1.75,'ordinary common edit keeps the explicit override');
    const reapplied=await harness({section:common.section,spatial:true});
    await reapplied.click('[data-apply-group]');
    assert.equal(reapplied.outcome,'saved');
    assert.equal(reapplied.panel._resolveTHeToMsi('HE_STAIN','MSI_C')[0][0],1.6,'explicit group apply clears individual correction');
    const evicted=plain(common.section),evictedGeometry=evicted.msiSeries.MSI_C.sourceGeometry;
    delete evicted.msiSeries.MSI_C.sourceGeometry;
    evicted.meta.alignmentMsiKey='MSI_A';
    const evictedSession=await harness({section:evicted,spatial:true});
    assert.match(evictedSession.$('[data-apply-group]').textContent,/3 件/,'registered unloaded members remain counted');
    await evictedSession.click('[data-apply-group]');
    evictedSession.panel.msiValueRasters.set('MSI_C',{sourceGeometry:evictedGeometry});
    assert.equal(evictedSession.panel._resolveTHeToMsi('HE_STAIN','MSI_C')[0][0],1.6,'group apply clears an unloaded member override too');

    const different=await aligned(fresh(false));
    assert.equal(different.panel._resolveTHeToMsi('HE_STAIN','MSI_C'),null,'heterogeneous grid does not receive the common transform');
    const shifted=plain(different.section);
    shifted.msiSeries.MSI_C=plain(shifted.msiSeries.MSI_A);
    shifted.msiSeries.MSI_C.sourceFileId='file-2';shifted.msiSeries.MSI_C.sourceReference='source-2';
    shifted.msiSeries.MSI_C.sourceGeometry.sourceRef='source-2';
    shifted.msiSeries.MSI_C.sourceGeometry.displayGeometry.x.origin=10;
    shifted.msiSeries.MSI_C.sourceGeometry.legacy.x=shifted.msiSeries.MSI_C.sourceGeometry.legacy.x.map(([x,i])=>[x+10,i]);
    Groups.ensureGroup(shifted,shifted.msiSeries.MSI_C,shifted.msiSeries.MSI_C.sourceGeometry);
    const shiftedPanel={...different.panel,section:shifted};
    assert.equal(shiftedPanel._resolveTHeToMsi('HE_STAIN','MSI_C'),null,'same dimensions with shifted raw origin remain separate');

    const readers=fresh();readers.msiSeries.MSI_C.sourceFileId='file-1';readers.msiSeries.MSI_C.func=2;
    const readerSession=await harness({section:readers,spatial:true});
    assert.match(readerSession.$('[data-align-source]').innerHTML,/同じ座標の測定に共通 \(2 件\)/,'same-file reader frames still expose the common action');
    await readerSession.input('[data-scale-num]',120);await readerSession.click('[data-save]');
    assert.equal(readerSession.panel._resolveTHeToMsi('HE_STAIN','MSI_C')[0][0],1.2);

    const failed=await harness({section:fresh(),spatial:true,storageFail:true});
    await failed.input('[data-scale-num]',140);await failed.click('[data-save]');
    assert.equal(failed.section.meta.spatialGroups,undefined,'failed save cannot publish the private coordinate registry');
    assert.equal(failed.closed,false);await failed.click('[data-modal-cancel]');

    let capabilityCalls=0;
    const shared=await harness({section:first.section,spatial:true,shared:true,
        ensureSpatialServerSupport:async()=>{capabilityCalls++;throw new Error('server update required');}});
    await shared.input('[data-scale-num]',180);await shared.click('[data-save]');
    assert.equal(capabilityCalls,1);assert.equal(shared.sharedSaves.length,0);assert.equal(shared.closed,false);
    await shared.click('[data-modal-cancel]');

    for(const changeSession of ['project','share-token']) {
        let releaseCapability,enteredCapability;
        const entered=new Promise(resolve=>{enteredCapability=resolve;});
        const gate=new Promise(resolve=>{releaseCapability=resolve;});
        const stale=await harness({section:first.section,spatial:true,shared:true,
            ensureSpatialServerSupport:async()=>{enteredCapability();await gate;}});
        await stale.input('[data-scale-num]',180);
        const saving=stale.click('[data-save]');await entered;
        if(changeSession==='project')stale.context.App.project={id:'another-project',sections:[]};
        else stale.context.App.shareMode={token:'another-token'};
        releaseCapability();await saving;
        assert.equal(stale.sharedSaves.length,0,changeSession+': capability completion must not send a stale alignment draft');
        assert.deepEqual(plain(stale.section),stale.initialSection,changeSession+': active section remains unchanged');
        if(!stale.closed)await stale.click('[data-modal-cancel]');
    }

    const missing=fresh();
    for(const entry of Object.values(missing.msiSeries))entry.sourceGeometry.currentConfirmed=true;
    missing.msiSeries.MSI_A.sourceGeometry.legacy.confirmed=false;
    missing.msiSeries.MSI_A.sourceGeometry.legacy.reason='legacy-render-quant-axis-mismatch';
    const current=await aligned(missing);
    const currentFrame=current.context.alignmentFrameDescriptor(current.section,'MSI_A',current.panel);
    assert.equal(currentFrame.confirmed,true);assert.equal(currentFrame.legacyConfirmed,false);
    assert.equal(currentFrame.currentCoordinatesConfirmed,true);
    assert.equal(current.panel._resolveTHeToMsi('HE_STAIN','MSI_A')[0][0],1.5);
    assert.equal(current.panel._resolveTHeToMsi('HE_STAIN','MSI_C')[0][0],1.5,'missing signal does not change new common geometry');
    const modernRecord=Object.values(current.section.meta.alignment.HE_STAIN.byGroup)[0];
    assert.equal(modernRecord.coordinateProvenance,'source-coordinate-map-v1');
    const unsafe=plain(current.section);
    delete Object.values(unsafe.meta.alignment.HE_STAIN.byGroup)[0].coordinateProvenance;
    assert.equal(({...current.panel,section:unsafe})._resolveTHeToMsi('HE_STAIN','MSI_A'),null,'unmarked old records cannot gain current-map validity');

    const old=fixture();
    old.msiSeries.MSI_A.sourceGeometry.currentConfirmed=true;
    old.msiSeries.MSI_A.sourceGeometry.legacy.confirmed=false;
    old.msiSeries.MSI_A.sourceGeometry.legacy.reason='legacy-render-quant-axis-mismatch';
    Groups.ensureGroup(old,old.msiSeries.MSI_A,old.msiSeries.MSI_A.sourceGeometry);
    const oldSession=await harness({section:old,spatial:true});
    assert.equal(oldSession.panel._resolveTHeToMsi('HE_STAIN','MSI_A'),null,'legacy world transform remains unresolved on the newly verified map');
    assert.equal(oldSession.context.alignmentLegacySeedIsCompatible(oldSession.section,
        oldSession.context.alignmentFrameDescriptor(oldSession.section,'MSI_A',oldSession.panel)),false);
    const oldBefore=plain(oldSession.section);
    await oldSession.click('[data-modal-cancel]');
    assert.deepEqual(plain(oldSession.section),oldBefore,'inspecting the new map never migrates old saved data');
    console.log('MSI spatial alignment regressions: PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
