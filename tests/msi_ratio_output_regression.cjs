'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createCanvas}=require('@napi-rs/canvas');
const Core=require('../viewer/msi-ratio-core.js');
const Model=require('../viewer/msi-ratio-model.js');
const Report=require('../viewer/project-report-app.js');
const Data=require('../viewer/project-report-data.js');
const Msi=require('../viewer/roi-media-msi.js');
const JSZip=require('../vendor/jszip.min.js');
const clone=value=>JSON.parse(JSON.stringify(value));

function fixture() {
    const source={positions:[{x:0,y:0},{x:0,y:0},{x:1,y:0}],rowIds:[0,1,2],sourceFrame:'frame'};
    const x={...source,values:Float64Array.from([10,10,0])},y={...source,values:Float64Array.from([1,10,0])};
    const calculated=Core.calculate(x,y),raster={W:2,H:1,values:Float64Array.from([5.5,NaN]),measuredMask:Uint8Array.from([1,0])};
    const section={id:'s',displayName:'Section',meta:{},images:{},msiSeries:{
        MSI_X:{blobId:'original',sourceReference:'frame',sourceRevision:1,kind:'txt',v:'X',compoundMeta:{base:'X',ce:715.12345,cv:620.98765}},
        MSI_Y:{blobId:'original',sourceReference:'frame',sourceRevision:1,kind:'txt',v:'Y',compoundMeta:{base:'Y',ce:715.12345,cv:620.98765}}}};
    const definition={id:'ratio-one',name:'X_715.12345_620.98765 / Y_715.12345_620.98765',revision:1,
        operation:'divide',calculationVersion:'msi-ratio-v1',denominatorMin:0,numeratorPolicy:'nonnegative',invalidPolicy:'exclude',
        bindings:{s:{numerator:Model.makeInputRef(section.msiSeries.MSI_X,'MSI_X'),denominator:Model.makeInputRef(section.msiSeries.MSI_Y,'MSI_Y'),
            coordinateConfirmed:false,coordinateEvidence:''}}};
    definition.bindings.s.numerator.labelHint='X_715.12345_620.98765';
    definition.bindings.s.denominator.labelHint='Y_715.12345_620.98765';
    const project={id:'p',displayName:'Project',meta:{msiRatios:{schemaVersion:1,definitions:[definition]}},sections:[section],rois:[{id:'roi',name:'ROI'}]};
    const lut=Array.from({length:256},(_,i)=>[i,0,0]);
    const style={mode:'same',rangePolicy:'maximum',lut,background:[9,10,11],colormap:'test',smoothing:'median',smoothingStrength:10,linearStrength:10,otsu:false};
    const app={project,panels:new Map(),msiUserWindow:{},getRatioDefinitions:()=>[definition],getRatioDisplayStyle:()=>style,
        getMsiDisplaySettings:()=>({aspectMode:'legacy',smoothingStrength:1,linearStrength:10}),
        ratioSignature:()=>JSON.stringify([definition,section.msiSeries.MSI_X.sourceRevision,section.msiSeries.MSI_Y.sourceRevision]),
        async resolveRatio(){return {kind:'ratio',raster,statistics:calculated.summary,roiStats:[{roiId:'roi',name:'ROI',statistics:calculated.summary},
            {roiId:'foreign',name:'Foreign ROI',status:'unavailable',reason:'roi-source-mismatch',statistics:null}],
            displayAuto:{rawRange:[0,10],max:10},sourceKey:'MSI_X',frameSourceKey:'MSI_X'};}};
    const panel={project,section,msiValueRasters:new Map(),ensureMsiLayerLoaded:async()=>false};app.panels.set('s',panel);
    return {app,project,section,definition,calculated,raster,style,hooks:{getApp:()=>app,displayStyle:()=>style}};
}

(async()=>{
    const f=fixture(),before=clone(f.project),rowBefore=Array.from(f.calculated.values);
    const input=Report.createAdapter(f.hooks,{includeRatios:true,useDisplayStyle:true});
    const ratio=input.molecules.find(item=>item.kind==='ratio');assert.ok(ratio);
    const entries=await ratio.loadEntries();
    assert.equal(entries[0].ratioStatistics.totalRatio,20/11);
    assert.equal(entries[0].ratioStatistics.mean,5.5);
    assert.equal(entries[0].ratioStatistics.nValid,2);
    assert.equal(entries[0].stats.mean,null,'Ratio statistics must not pretend to be original intensities');
    assert.deepEqual(entries[0].displayWindow,{min:0,max:10},'Original row ratio maximum, not averaged raster maximum');
    assert.notEqual(entries[0].raster.values,f.raster.values,'Export owns its numerical snapshot');
    assert.doesNotMatch(JSON.stringify({ratio,entries}),/715\.12345|620\.98765|sourceReference|blobId/);
    const prepared=await Data.prepare({...input,molecules:[ratio]},{createCanvas,nearestUpscale:false});
    assert.equal(prepared.molecules[0].kind,'ratio');
    assert.equal(prepared.molecules[0].intensityScale.statisticsBasis,'valid-paired-original-rows');
    assert.equal(prepared.molecules[0].sections[0].ratioRois[0].statistics.totalRatio,20/11);
    assert.equal(prepared.molecules[0].sections[0].ratioRois[1].statistics,null);
    assert.deepEqual(f.project,before);assert.deepEqual(Array.from(f.calculated.values),rowBefore);

    const sandbox={JSZip,console,setTimeout,clearTimeout,Blob,Buffer,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,atob,btoa};
    vm.createContext(sandbox);
    for(const file of ['vendor/pptxgen.min.js','viewer/project-report-deck.js'])
        vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),sandbox,{filename:file});
    const zip=await JSZip.loadAsync(await sandbox.ProjectReportDeck.create(prepared,{type:'nodebuffer'}));
    const slideFiles=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name));
    const xml=(await Promise.all(slideFiles.map(name=>zip.file(name).async('string')))).join('\n');
    assert.match(xml,/Total signal ratio/);assert.match(xml,/Mean point ratio/);assert.match(xml,/Median point ratio/);
    assert.match(xml,/— ROI/);assert.match(xml,/1\.8181818181818181/);
    assert.match(xml,/Unavailable: roi-source-mismatch/);
    assert.doesNotMatch(xml,/Max Intensity|Mean Intensity|715\.12345|620\.98765/);

    const stale=fixture(),snapshot=Report.createAdapter(stale.hooks,{includeRatios:true});
    stale.definition.bindings.s.denominator.source.reference='replacement';
    assert.throws(snapshot.assertCurrent,error=>error.code==='REPORT_SOURCE_CHANGED');
    const asynchronous=fixture(),original=asynchronous.app.resolveRatio;
    asynchronous.app.resolveRatio=async()=>{const value=await original();asynchronous.section.msiSeries.MSI_Y.sourceRevision++;return value;};
    const pending=Report.createAdapter(asynchronous.hooks,{includeRatios:true}).molecules.find(item=>item.kind==='ratio');
    await assert.rejects(pending.loadEntries(),error=>error.code==='REPORT_SOURCE_CHANGED');

    const publicFixture=fixture();publicFixture.project.__share=true;publicFixture.app.shareMode={role:'viewer',slug:'s',token:'private-token'};
    const publicInput=Report.createAdapter(publicFixture.hooks,{includeRatios:true,includeCeCv:true});
    const publicRatio=publicInput.molecules.find(item=>item.kind==='ratio');
    assert.doesNotMatch(JSON.stringify({publicRatio,entries:await publicRatio.loadEntries()}),/715\.12345|620\.98765|private-token/);

    const canvas=Msi.colorize(null,{numericOnly:true,valueRaster:{W:3,H:1,values:Float64Array.from([0,NaN,5]),measuredMask:Uint8Array.from([1,0,1])},
        createCanvas,lut:f.style.lut,background:[9,10,11],window:{min:0,max:10},smoothing:'median',smoothingStrength:10,
        evaluateValue:value=>({n:value/10}),evaluateLuminance:()=>assert.fail('Ratio cannot fall back to RGB intensity')});
    const pixels=canvas.getContext('2d').getImageData(0,0,3,1).data;
    assert.deepEqual(Array.from(pixels.slice(4,8)),[9,10,11,255],'Invalid ratio stays background through smoothing');
    assert.equal(pixels[0],0,'Measured ratio zero remains a real zero');
    console.log('Ratio output regression: PASS (row statistics, PPT labels/ROI tables, snapshot guards, viewer privacy, numeric photo rendering)');
})().catch(error=>{console.error(error);process.exitCode=1;});
