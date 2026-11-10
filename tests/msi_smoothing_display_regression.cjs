'use strict';
const assert = require('node:assert/strict');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const {runtime} = require('./viewer-runtime.cjs');
const Smoothing = require('../viewer/msi-smoothing.js');
const identity = [[1,0,0],[0,1,0],[0,0,1]];
const key = 'MSI_signal';
const pixelBytes = canvas => Buffer.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);

function fixture({invalid = false, nonlinearPalette = false, mixedAlpha = false} = {}) {
    const W=9,H=3,source=createCanvas(W,H),sourceContext=source.getContext('2d');
    // Deliberately opaque, bright legacy PNG data is inconsistent with the
    // numerical missingness. It must not become a smoothing neighbour merely
    // because PNG alpha is nonzero.
    sourceContext.fillStyle='#ffffff';sourceContext.fillRect(0,0,W,H);
    if(mixedAlpha){
        const data=sourceContext.getImageData(0,0,W,H);data.data[3]=0;data.data[7]=128;data.data[11]=128;
        sourceContext.putImageData(data,0,0);
    }
    Object.assign(source,{complete:true,naturalWidth:W,naturalHeight:H});
    const values=new Float64Array(W*H).fill(10),measuredMask=new Uint8Array(W*H).fill(1),keep=new Uint8Array(W*H).fill(1);
    const missing=W+3,unmeasured=W+4,hidden=W+5;
    if(invalid) {
        values[missing]=NaN;
        values[unmeasured]=1e9;measuredMask[unmeasured]=0;
        values[hidden]=1e9;keep[hidden]=0;
    } else if(!mixedAlpha) values[unmeasured]=255;
    if(mixedAlpha)keep[2]=0;
    const raster={W,H,values,measuredMask},keepGrid={W,H,keep};
    const section={id:'section',meta:{displayTransform:{version:2,baseOrientation:'native-raster'}},
        msiSeries:{[key]:{rawRange:[0,255],rawDispMax:255,rawTrueMax:255}}};
    const project={id:'project',sections:[section],rois:[{id:'roi',polysBySection:{section:[[0,0],[8,0],[8,2]]}}]};
    const app={project,viewMode:'free',roiOnlyMode:false,activeOverlay:null,msiSmoothing:'linear',msiSmoothingStrength:1,msiLinearStrength:10,
        otsuBgRemove:invalid||mixedAlpha,getMsiWindow:()=>({min:0,max:255}),getMsiDisplaySettings:()=>({aspectMode:'legacy'})};
    let smoothingCalls=0,stamp=0;const stamps=new WeakMap();
    const context=runtime({App:app,
        MsiSmoothing:{...Smoothing,medianIndices(...args){smoothingCalls++;return Smoothing.medianIndices(...args);}},
        document:{createElement:()=>createCanvas(1,1)},
        get2dContext:canvas=>{const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;return ctx;},
        getActiveColormap:()=>Array.from({length:256},(_,i)=>nonlinearPalette?[i,(i*31)%256,(255-i)*17%256]:[i,i,i]),getColormapBackground:()=>[0,0,0],
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
    return {app,panel,thumb,W,H,values,missing,unmeasured,hidden,science,context,source,keepGrid,calls:()=>smoothingCalls,
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
    legacy.app.msiSmoothing='median';legacy.app.msiSmoothingStrength=10;
    const filtered=legacy.render();
    assert.equal(legacy.calls(),1,'The production main renderer invokes the Median filter');
    assert.deepEqual(filtered,baseline,
        'NaN fallback, measuredMask=0 high values and Otsu background neither contaminate uniform valid pixels nor get filled');
    for(let p=0;p<legacy.W*legacy.H;p++) {
        if([legacy.missing,legacy.unmeasured,legacy.hidden].includes(p))continue;
        assert.equal(filtered[p*4],10,'Every actual measured pixel retains its uniform colour');
    }
    assert.deepEqual(await legacy.thumbnailPixels(),filtered,'The independently baked thumbnail uses the same validity mask');
    assert.equal(legacy.calls(),1,'The thumbnail reuses the exact original-scale Median result');
    assert.deepEqual(legacy.science(),before,'Rendering preserves original NaN bits, measured values, masks, PNG and ROI/project data');

    const peak=fixture(),peakBefore=peak.science(),zero=peak.render(),zeroCache=peak.panel._msiLutCache.get(key);
    assert.equal(zero[peak.unmeasured*4],255);
    assert.deepEqual(await peak.thumbnailPixels(),zero,'Linear-10 thumbnail matches the unmodified main colour raster');
    peak.app.msiSmoothing='median';peak.app.msiSmoothingStrength=10;
    const strong=peak.render(),strongCache=peak.panel._msiLutCache.get(key);
    assert.notEqual(strongCache.sig,zeroCache.sig,'Changing strength invalidates the main LUT cache');
    assert.notEqual(strongCache.canvas,zeroCache.canvas);
    assert.notDeepEqual(strong,zero,'A measured impulse really changes when Median is enabled');
    assert.equal(strong[peak.unmeasured*4],10,'Median removes a single-pixel spike');
    assert.equal(strong[(peak.unmeasured-1)*4],10,'Median does not spread that spike into its neighbours');
    const calls=peak.calls();
    assert.deepEqual(peak.render(),strong);assert.equal(peak.calls(),calls,'Repeating the same strength reuses the cached colour raster');
    assert.deepEqual(await peak.thumbnailPixels(),strong,'Main and thumbnail apply the filter once at the same raster scale');
    peak.app.msiSmoothing='linear';
    assert.deepEqual(peak.render(),zero,'A Linear → Median → Linear cache cycle returns exactly to the original display bytes');
    assert.deepEqual(await peak.thumbnailPixels(),zero,'Thumbnail also returns exactly to Linear-10');
    peak.app.msiSmoothingStrength=10;peak.app.msiSmoothing='none';
    const noneCalls=peak.calls();
    assert.deepEqual(peak.render(),zero);assert.equal(peak.calls(),noneCalls,'None mode disables the stored nonzero strength');
    assert.deepEqual(await peak.thumbnailPixels(),zero,'None mode also bypasses thumbnail smoothing');
    assert.deepEqual(peak.science(),peakBefore,'Repeated cache/mode changes do not mutate measurement or project state');
    const palette=fixture({nonlinearPalette:true});
    // A deliberately non-monotone colour map distinguishes filtering the scalar
    // palette index from filtering R/G/B independently or sorting by luminance.
    for(let i=0;i<palette.values.length;i++)palette.values[i]=(i*47+19)%256;
    const paletteBefore=palette.science();
    palette.app.msiSmoothing='median';
    for(let level=1;level<=10;level++) {
        palette.app.msiSmoothingStrength=level;
        const pixels=palette.render();
        for(let y=0;y<palette.H;y++)for(let x=0;x<palette.W;x++) {
            const neighbours=[];
            for(let ny=Math.max(0,y-level);ny<=Math.min(palette.H-1,y+level);ny++)
                for(let nx=Math.max(0,x-level);nx<=Math.min(palette.W-1,x+level);nx++)neighbours.push(palette.values[ny*palette.W+nx]);
            neighbours.sort((a,b)=>a-b);
            // The masked median uses the lower middle element for even-sized
            // clipped neighbourhoods, preserving an actual palette sample.
            const index=neighbours[Math.floor((neighbours.length-1)/2)],p=(y*palette.W+x)*4;
            assert.deepEqual([...pixels.subarray(p,p+3)],[index,(index*31)%256,(255-index)*17%256],
                'Level '+level+' applies the scalar median before a nonlinear colour lookup');
        }
        assert.deepEqual(await palette.thumbnailPixels(),pixels,'Main/thumbnail median parity at level '+level);
    }
    assert.deepEqual(palette.science(),paletteBefore,'All ten Median levels preserve sources, masks, geometry and ROIs');
    // Main's opaque no-data backdrop and thumbnail's source alpha are separate
    // output policies, even though their scalar/Median result is shared.
    const mixed=fixture({mixedAlpha:true}),mixedBefore=mixed.science();
    mixed.app.msiSmoothing='median';mixed.app.msiSmoothingStrength=3;
    const mainPixels=mixed.render(),thumbPixels=await mixed.thumbnailPixels();
    assert.deepEqual([...mainPixels.subarray(0,12)],[0,0,0,255,10,10,10,255,0,0,0,255]);
    assert.deepEqual([...thumbPixels.subarray(0,12)],[0,0,0,0,10,10,10,128,0,0,0,128]);
    assert.equal(mixed.calls(),1,'Different alpha policies still share one Median calculation');
    const paletteInput=Array.from({length:256},(_,i)=>[i,0,0]);
    const canvasFor=name=>mixed.panel._msiColorCanvas(key,mixed.source,[0,255],{min:0,max:255},mixed.keepGrid,paletteInput,[0,0,0],name);
    const red=canvasFor('overlay-red');
    assert.deepEqual([...pixelBytes(red).subarray(4,8)],[10,0,0,255],'Overlay palette remains independent of thumbnail palette');
    assert.deepEqual(await mixed.thumbnailPixels(),thumbPixels,'An overlay colour derivative never replaces the normal thumbnail');
    assert.equal(mixed.calls(),1,'Palette-only changes do not recompute Median');
    for(let i=0;i<7;i++)canvasFor('palette-'+i);
    const record=mixed.panel._msiLutCache.get(key);
    assert.equal(record.variants.size,4);
    assert.ok(!record.canvas||[...record.variants.values()].includes(record.canvas),'Legacy canvas reference never retains an unbudgeted evicted variant');
    assert.equal(record._bytes,mixed.W*mixed.H*(3+4*record.variants.size));
    mixed.panel._msiLutCache.delete(key);
    assert.equal(mixed.context.Panel._displayCacheBudget.bytes,0,'Deleting a layer releases all of its retained display bytes');
    assert.deepEqual(mixed.render(),mainPixels,'Eviction changes only recomputation, never display pixels');
    assert.deepEqual(mixed.science(),mixedBefore,'Shared derivatives never mutate original alpha, masks or scientific values');
    // Force cross-cache pressure: a retained HE derivative must evict an older
    // MSI derivative rather than growing an independent per-panel allowance.
    const bounded=fixture(),boundedPixels=bounded.render(),pool=bounded.context.Panel._displayCacheBudget;
    pool.maxBytes=bounded.W*bounded.H*7;
    bounded.panel._heGrayscaleCanvas('HE_STAIN',bounded.source);
    assert.ok(pool.bytes<=pool.maxBytes);assert.equal(bounded.panel._msiLutCache.size,0);
    assert.deepEqual(bounded.render(),boundedPixels);
    bounded.panel._msiLutCache.clear();bounded.panel._heGrayscaleCache.clear();
    assert.equal(pool.bytes,0,'Map.clear releases byte accounting from both derivative types');
    pool.maxBytes=1;
    assert.deepEqual(bounded.render(),boundedPixels,'An item over budget is rendered without retention');
    assert.equal(pool.bytes,0);assert.equal(bounded.panel._msiLutCache.size,0);
    console.log('MSI smoothing display: real main/thumbnail pixels, opaque legacy missingness, cache restoration and source invariance PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
