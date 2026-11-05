'use strict';
const assert=require('node:assert/strict');
const Model=require('../viewer/msi-ratio-model.js');
const Publish=require('../viewer/publish-safety.js');
const Archive=require('../viewer/project-archive.js');
const copy=value=>JSON.parse(JSON.stringify(value));
const original=new Blob(['x,y,X,Y\n0,0,10,2'],{type:'text/csv'});
function fixture() {
    const section={id:'s',displayName:'S',images:{},msiFiles:{file:{blobId:'raw'}},msiSeries:{
        MSI_X:{blobId:'raw',sourceReference:'frame',sourceRevision:1,kind:'txt',x:'x',y:'y',v:'X'},
        MSI_Y:{blobId:'raw',sourceReference:'frame',sourceRevision:1,kind:'txt',x:'x',y:'y',v:'Y'}}};
    const definition={id:'r',name:'X / Y',revision:1,operation:'divide',calculationVersion:'msi-ratio-v1',
        denominatorMin:0,numeratorPolicy:'nonnegative',invalidPolicy:'exclude',
        bindings:{s:{numerator:Model.makeInputRef(section.msiSeries.MSI_X,'MSI_X'),
            denominator:Model.makeInputRef(section.msiSeries.MSI_Y,'MSI_Y'),coordinateConfirmed:false,coordinateEvidence:''}}};
    const project={id:'p',displayName:'Project',sections:[section],rois:[],meta:{msiRatios:{schemaVersion:1,definitions:[definition]}}};
    const logs={sessions:[],uploads:[],commits:[],pins:[],jobs:new Map()},records=new Map([['raw',{blob:original}]]);
    const storage={getBlob:async id=>records.get(id),putArchiveJob:async job=>logs.jobs.set(job.id,copy(job)),
        pinBlobs:async(id,ids)=>logs.pins.push(ids.slice()),releaseBlobPins:async()=>{},deleteArchiveJob:async id=>logs.jobs.delete(id),
        deleteBlob:async()=>assert.fail('Export does not own or delete original blobs')};
    let id=0;
    const hooks={uuid:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`,freezeSources(){},
        media:()=>({items:[]}),publicPhoto:copy,imageIdentity:()=>null,viewerOverlay:()=>false,encodeRoi:()=>[],url:()=>'',
        session:async job=>{logs.sessions.push(copy(job));return {protocol:2,token:'ticket',object_prefix:job.slug+'/publish-v2/'+job.jobId+'/'};},
        blob:storage.getBlob,exists:async()=>true,remoteBlob:async()=>null,pin:async(_job,ids)=>logs.pins.push(ids.slice()),
        release:async()=>{},intent:async()=>{},upload:async(path,blob)=>logs.uploads.push({path,blob}),
        start(){},progress(){},assertActive(){},close(){},receipt:async()=>{},
        commit:async args=>{logs.commits.push(copy(args));return {ok:true,protocol:2,slug:args._slug,request_id:args._request_id,server_revision:1};}};
    return {project,section,definition,logs,storage,hooks};
}
(async()=>{
    const f=fixture(),before=copy(f.project),session=f.hooks.session;
    f.hooks.session=async job=>{f.definition.denominatorMin=5;return session(job);};
    await Publish.run(f.project,{slug:'ratio',isPublic:true},f.hooks);
    assert.deepEqual(f.logs.commits[0]._meta.msiRatios,before.meta.msiRatios,'Metadata is frozen before the first asynchronous operation');
    assert.deepEqual(Object.keys(f.logs.commits[0]._sections[0].storagePaths.msiSeries),['MSI_X','MSI_Y']);
    assert.equal(f.logs.uploads.length,1,'Both ratio inputs retain one original shared source blob');
    assert.equal(f.logs.uploads[0].blob,original);

    const missing=fixture();delete missing.section.msiSeries.MSI_Y;
    await assert.rejects(()=>Publish.run(missing.project,{slug:'ratio'},missing.hooks),{code:'PUBLISH_RATIO_SOURCE_MISSING'});
    assert.equal(missing.logs.sessions.length,0);assert.equal(missing.logs.uploads.length,0);
    await assert.rejects(()=>Archive.beginExport(missing.project,missing.storage),/比の入力参照/);
    assert.equal(missing.logs.jobs.size,0,'Invalid dependencies fail before creating a journal or pin');
    const changed=fixture();changed.section.msiSeries.MSI_Y.sourceRevision=2;
    await assert.rejects(()=>Publish.run(changed.project,{slug:'ratio'},changed.hooks),{code:'PUBLISH_RATIO_SOURCE_MISSING'});

    const archive=fixture();archive.definition.provenance={sourceReference:'before'};
    const archivedBefore=copy(archive.project);
    const task=await Archive.beginExport(archive.project,archive.storage,{currentProject:()=>archive.project});
    assert.deepEqual(archive.project,archivedBefore);assert.deepEqual(archive.logs.pins,[['raw']]);
    archive.definition.provenance.sourceReference='after';
    assert.throws(task.assertCurrent,/Project changed/,'Nested ratio sourceReference is not excluded as a derived measured statistic');
    assert.equal(task.project.meta.msiRatios.definitions[0].provenance.sourceReference,'before');
    await task.close();assert.equal(archive.logs.jobs.size,0);

    const future=fixture();future.project.meta.msiRatios={schemaVersion:9,future:{sourceReference:'keep',opaque:[1,2]}};
    await Publish.run(future.project,{slug:'ratio'},future.hooks);
    assert.deepEqual(future.logs.commits[0]._meta.msiRatios,future.project.meta.msiRatios,'Unknown schemas remain opaque and intact');
    const unknown=await Archive.beginExport(future.project,future.storage);await unknown.close();
    const personal=fixture(),saved=copy(personal.project),effective=copy(personal.project.meta.msiRatios);
    effective.definitions[0].name='Personal ratio';effective.definitions[0].denominatorMin=3;
    const personalTask=await Archive.beginExport(personal.project,personal.storage,
        {ratioRegistry:effective,currentRatioRegistry:()=>effective});
    assert.deepEqual(personal.project,saved,'Personal ZIP overrides never modify the shared project');
    assert.equal(personalTask.project.meta.msiRatios.definitions[0].name,'Personal ratio');
    effective.definitions[0].denominatorMin=4;
    assert.throws(personalTask.assertCurrent,/Ratios changed/);await personalTask.close();
    const emptyZip={files:{},file:()=>null};
    const manifest={format:'desi_data_share_v2',sections:[],offlineSettings:{version:1,meta:{msiRatios:copy(saved.meta.msiRatios)}}};
    const prepared=await Archive.prepareImport(emptyZip,manifest);
    assert.deepEqual(prepared.doc.offlineSettings.meta.msiRatios,saved.meta.msiRatios,'References are retained before section reconstruction');
    manifest.offlineSettings.meta.msiRatios.definitions[0].denominatorMin=-1;
    await assert.rejects(()=>Archive.prepareImport(emptyZip,manifest),/Invalid ratio registry/);
    manifest.offlineSettings.meta.msiRatios=copy(future.project.meta.msiRatios);
    assert.deepEqual((await Archive.prepareImport(emptyZip,manifest)).doc.offlineSettings.meta.msiRatios,future.project.meta.msiRatios);
    console.log('Ratio transport regression: PASS (immutable publication, original blob sharing, missing/stale dependencies, complete archive fingerprint, future schema preservation)');
})().catch(error=>{console.error(error);process.exitCode=1;});
