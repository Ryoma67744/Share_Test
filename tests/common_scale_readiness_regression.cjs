'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {html} = require('./viewer-runtime.cjs');
const start = html.indexOf('    getCommonScaleStatus(key) {');
assert.ok(start > 0);
const method = html.slice(start, html.indexOf('\n    },', start) + 7);
const getCommonScaleStatus = vm.runInNewContext('({' + method + '}).getCommonScaleStatus', {
    setTimeout, Promise, displayMsiEntry:(s,k)=>s.msiSeries[k],
});
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
function fixture() {
    const calls = [], waits = [];
    const app = {project:{id:'p'},msiScaleMode:'same',panels:new Map(),repaints:0,
        getCommonScaleStatus,getMsiUserWindows:()=>({}),getMsiDisplaySettings:()=>({rangePolicy:'maximum'}),
        _organInScope:section=>section.selected!==false,repaintAllMsi(){this.repaints++;}};
    for (const [id,max] of [['visible',10],['offscreen',100]]) {
        const ent={blobId:id,rawTrueMax:max,rawRange:[0,max]};
        const panel={section:{id,msiSeries:{MSI_A:ent}},ready:false,
            isMsiLayerReady(){return this.ready;},_msiLoadIdentity:()=>ent.blobId,
            ensureMsiLayerLoaded(key){calls.push([id,key]);return new Promise(resolve=>waits.push(ok=>{
                panel.ready=ok;if(ok)ent.rawTrueMax=max;resolve(ok);
            }));}};
        app.panels.set(id,panel);
    }
    return {app,calls,waits};
}
(async()=>{
    let f=fixture();
    assert.equal(f.app.getCommonScaleStatus('MSI_A'),'ready');
    assert.equal(f.calls.length,0,'saved summaries require no original reads');
    delete f.app.panels.get('offscreen').section.msiSeries.MSI_A.rawTrueMax;
    assert.equal(f.app.getCommonScaleStatus('MSI_A'),'pending');
    assert.equal(f.app.getCommonScaleStatus('MSI_A'),'pending');
    await flush();assert.deepEqual(f.calls,[['offscreen','MSI_A']],'offscreen selected section remains in numerical scope; deduplicated');
    f.waits[0](true);await flush();
    assert.equal(f.app.getCommonScaleStatus('MSI_A'),'ready');assert.equal(f.app.repaints,1);
    f=fixture();delete f.app.panels.get('offscreen').section.msiSeries.MSI_A.rawTrueMax;
    f.app.panels.get('offscreen').section.selected=false;
    assert.equal(f.app.getCommonScaleStatus('MSI_A'),'ready');assert.equal(f.calls.length,0);
    f.app.panels.get('offscreen').section.selected=true;
    f.app.getMsiUserWindows=()=>({MSI_A:{max:50}});
    assert.equal(f.app.getCommonScaleStatus('MSI_A'),'ready','manual upper limit needs no automatic common scale');
    f=fixture();delete f.app.panels.get('offscreen').section.msiSeries.MSI_A.rawTrueMax;
    f.app.msiScaleMode='individual';assert.equal(f.app.getCommonScaleStatus('MSI_A'),'ready');assert.equal(f.calls.length,0);
    f.app.msiScaleMode='same';assert.equal(f.app.getCommonScaleStatus('MSI_A'),'pending');await flush();
    f.waits[0](false);await flush();assert.equal(f.app.getCommonScaleStatus('MSI_A'),'failed');
    await flush();assert.equal(f.calls.length,1,'failed input is not retried every paint');
    f.app.panels.get('offscreen').section.msiSeries.MSI_A.blobId='replacement';
    assert.equal(f.app.getCommonScaleStatus('MSI_A'),'pending');await flush();assert.equal(f.calls.length,2);
    const repaints=f.app.repaints;f.app.project={id:'new'};f.waits[1](true);await flush();
    assert.equal(f.app.repaints,repaints,'old project completion cannot repaint the current project');
    f=fixture();f.app.roiOnlyMode=true;
    f.app.getRoiDisplayRange=s=>({status:s.id==='offscreen'?'pending':'ready',source:{status:s.id==='offscreen'?'pending':'ready'}});
    assert.equal(f.app.getCommonScaleStatus('MSI_A'),'pending','ROI Same waits for full selected scope too');
    f.app.getRoiDisplayRange=()=>({status:'no-roi'});assert.equal(f.app.getCommonScaleStatus('MSI_A'),'ready');
    console.log('PASS common-scale readiness: scope, deduplication, manual ranges, failure, stale jobs and ROI.');
})().catch(error=>{console.error(error);process.exitCode=1;});
