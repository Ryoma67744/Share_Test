'use strict';
const assert = require('node:assert/strict');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const {runtime} = require('./viewer-runtime.cjs');
const Smoothing = require('../viewer/msi-smoothing.js');
const identity = [[1,0,0],[0,1,0],[0,0,1]];
const key = 'MSI_signal';
const pixelBytes = canvas => Buffer.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);

function fixture({invalid = false} = {}) {
    const W=9,H=3,source=createCanvas(W,H),sourceContext=source.getContext('2d');
    // Deliberately opaque, bright legacy PNG data is inconsistent with the
    // numerical missingness. It must not become a smoothing neighbour merely
    // because PNG alpha is nonzero.
    sourceContext.fillStyle='#ffffff';sourceContext.fillRect(0,0,W,H);
    Object.assign(source,{complete:true,naturalWidth:W,naturalHeight:H});
    const values=new Float64Array(W*H).fill(10),measuredMask=new Uint8Array(W*H).fill(1),keep=new Uint8Array(W*H).fill(1);
    const missing=W+3,unmeasured=W+4,hidden=W+5;
    if(invalid) {
        values[missing]=NaN;
        values[unmeasured]=1e9;measuredMask[unmeasured]=0;
        values[hidden]=1e9;keep[hidden]=0;
    } else values[unmeasured]=255;
    const raster={W,H,values,measuredMask},keepGrid={W,H,keep};
    const section={id:'section',meta:{displayTransform:{version:2,baseOrientation:'native-raster'}},
        msiSeries:{[key]:{rawRange:[0,255],rawDispMax:255,rawTrueMax:255}}};
    const project={id:'project',sections:[section],rois:[{id:'roi',polysBySection:{section:[[0,0],[8,0],[8,2]]}}]};
    const app={project,viewMode:'free',roiOnlyMode:false,activeOverlay:null,msiSmoothing:'linear',msiSmoothingStrength:0,
        otsuBgRemove:invalid,getMsiWindow:()=>({min:0,max:255}),getMsiDisplaySettings:()=>({aspectMode:'legacy'})};
    let smoothingCalls=0,stamp=0;const stamps=new WeakMap();
    const context=runtime({App:app,
        MsiSmoothing:{...Smoothing,smoothRgba(...args){smoothingCalls++;return Smoothing.smoothRgba(...args);}},
        document:{createElement:()=>createCanvas(1,1)},
        get2dContext:canvas=>{const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;return ctx;},
        getActiveColormap:()=>Array.from({length:256},(_,i)=>[i,i,i]),getColormapBackground:()=>[0,0,0],
        otsuKeepGridForLayer:()=>app.otsuBgRemove?keepGrid:null,
        identStamp:value=>{if(!value)return 'none';if(!stamps.has(value))stamps.set(value,++stamp);return stamps.get(value);},
        _activeColormapName:'test-grayscale',MSI_LUT_CACHE_MAX:4,
    },['msiValueEval','msiWindowEval','msiRawFallbackMax']);
    const canvas=createCanvas(W,H);canvas.classList={toggle(){}};
    const thumb={style:{},src:''};
    const panel=Object.create(context.Panel.prototype);
    Object.assign(panel,{section,project,dom:{cdisp:canvas},displayCtx:canvas.getContext('2d'),
        imageSources:{[key]:source},imageSettings:{[key]:{opacity:1}},visibleLayers:new Set([key]),
        msiValueRasters:new Map([[key,raster]]),msiThumbRefs:new Map([[key,thumb]]),
        _maybeWarnRasterDimMismatch(){},_ensureViewerTransform(){},_ensureDrawableLoaded(){},
        _showMsiLoadStatus(){},_showAlignmentUnavailable(){},updateScaleBar(){},
        registeredMsiKeys:()=>[key],isMsiLayerReady:()=>true,getMsiRefSize:()=>({w:W,h:H}),_msiCanvasMatrix:()=>identity,
    });
    const science=()=>({values:Buffer.from(values.buffer).toString('hex'),measured:Buffer.from(measuredMask).toString('hex'),
        keep:Buffer.from(keep).toString('hex'),source:pixelBytes(source).toString('hex'),project:JSON.stringify(project)});
    return {app,panel,thumb,W,H,missing,unmeasured,hidden,science,calls:()=>smoothingCalls,
        async thumbnailPixels(){
            panel.renderMsiThumbnail(key);
            const decoded=await loadImage(thumb.src),out=createCanvas(decoded.width,decoded.height);
            out.getContext('2d').drawImage(decoded,0,0);
            assert.equal(out.width,W);assert.equal(out.height,H);
            return pixelBytes(out);
        },render(){panel.renderComposite();return pixelBytes(canvas);}};
}

async function main() {
    const legacy=fixture({invalid:true}),before=legacy.science(),baseline=legacy.render();
    assert.equal(baseline[legacy.missing*4],255,'The opaque PNG fallback makes the deliberately invalid source conspicuously bright');
    assert.equal(baseline[legacy.unmeasured*4],255,'An unmeasured large value is visible in the preserved legacy baseline');
    assert.equal(baseline[legacy.hidden*4],0,'Otsu-hidden pixels use the display background');
    legacy.app.msiSmoothingStrength=100;
    const filtered=legacy.render();
    assert.equal(legacy.calls(),1,'The production main renderer invokes the Gaussian filter');
    assert.deepEqual(filtered,baseline,
        'NaN fallback, measuredMask=0 high values and Otsu background neither contaminate uniform valid pixels nor get filled');
    for(let p=0;p<legacy.W*legacy.H;p++) {
        if([legacy.missing,legacy.unmeasured,legacy.hidden].includes(p))continue;
        assert.equal(filtered[p*4],10,'Every actual measured pixel retains its uniform colour');
    }
    assert.deepEqual(await legacy.thumbnailPixels(),filtered,'The independently baked thumbnail uses the same validity mask');
    assert.equal(legacy.calls(),2,'The production thumbnail renderer also invokes the Gaussian filter');
    assert.deepEqual(legacy.science(),before,'Rendering preserves original NaN bits, measured values, masks, PNG and ROI/project data');

    const peak=fixture(),peakBefore=peak.science(),zero=peak.render(),zeroCache=peak.panel._msiLutCache.get(key);
    assert.equal(zero[peak.unmeasured*4],255);
    assert.deepEqual(await peak.thumbnailPixels(),zero,'Strength-zero thumbnail matches the unmodified main colour raster');
    peak.app.msiSmoothingStrength=100;
    const strong=peak.render(),strongCache=peak.panel._msiLutCache.get(key);
    assert.notEqual(strongCache.sig,zeroCache.sig,'Changing strength invalidates the main LUT cache');
    assert.notEqual(strongCache.canvas,zeroCache.canvas);
    assert.notDeepEqual(strong,zero,'A measured peak really changes when the Gaussian is enabled');
    assert.ok(strong[peak.unmeasured*4]<255 && strong[(peak.unmeasured-1)*4]>10);
    const calls=peak.calls();
    assert.deepEqual(peak.render(),strong);assert.equal(peak.calls(),calls,'Repeating the same strength reuses the cached colour raster');
    assert.deepEqual(await peak.thumbnailPixels(),strong,'Main and thumbnail apply the filter once at the same raster scale');
    peak.app.msiSmoothingStrength=0;
    assert.deepEqual(peak.render(),zero,'A 0 → 100 → 0 cache cycle returns exactly to the original display bytes');
    assert.deepEqual(await peak.thumbnailPixels(),zero,'Thumbnail also returns exactly to strength zero');
    peak.app.msiSmoothingStrength=100;peak.app.msiSmoothing='none';
    const noneCalls=peak.calls();
    assert.deepEqual(peak.render(),zero);assert.equal(peak.calls(),noneCalls,'None mode disables the stored nonzero strength');
    assert.deepEqual(await peak.thumbnailPixels(),zero,'None mode also bypasses thumbnail smoothing');
    assert.deepEqual(peak.science(),peakBefore,'Repeated cache/mode changes do not mutate measurement or project state');
    console.log('MSI smoothing display: real main/thumbnail pixels, opaque legacy missingness, cache restoration and source invariance PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
