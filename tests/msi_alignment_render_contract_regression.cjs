'use strict';

// Real canvas geometry through the production Solve/Save handlers, thumbnail
// bake helpers, Overlay renderer, main renderer and native-coordinate export.
// Only intensity colourization and unrelated UI/storage surfaces are faked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const {harness} = require('./msi_alignment_regression.js');
const Archive = require('../viewer/project-archive.js');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
const points = [[50,100],[80,350],[70,600],[45,500]];
const plain = value => JSON.parse(JSON.stringify(value));
const contract = 'msi-shared-display-v1';
function method(name) {
    const start = html.indexOf('    '+name+'(');
    assert.ok(start >= 0, name);
    return html.slice(start,html.indexOf('\n    }',start)+6).trim();
}
function fn(name) {
    const start = html.indexOf('function '+name+'(');
    assert.ok(start >= 0, name);
    return html.slice(start,html.indexOf('\n}',start)+2);
}
function closure(name, end) {
    const start = html.indexOf('        const '+name+' = ');
    assert.ok(start >= 0, name);
    return html.slice(start,html.indexOf(end,start)).replace('const '+name+' =','globalThis.'+name+' =');
}
function canvas(w=1,h=1) {
    const c=createCanvas(w,h);
    c.style={}; c.classList={toggle(){}};
    c.toBlob=callback=>callback({type:'image/png',bytes:c.toBuffer('image/png')});
    return c;
}
async function marker(w,h,p,color,radius) {
    const c=canvas(w,h),ctx=c.getContext('2d');
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(...p,radius,0,2*Math.PI);ctx.fill();
    return loadImage(c.toBuffer('image/png'));
}
function centroid(c,channel) {
    const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let weight=0,x=0,y=0;
    for(let j=0;j<c.height;j++)for(let i=0;i<c.width;i++) {
        const k=4*(j*c.width+i),w=d[k+channel]*d[k+3]/255;
        weight+=w;x+=(i+.5)*w;y+=(j+.5)*w;
    }
    assert.ok(weight>0,'marker was rendered');
    return [x/weight,y/weight];
}
function separation(c) {
    const a=centroid(c,0),b=centroid(c,1);
    return Math.hypot(a[0]-b[0],a[1]-b[1]);
}
function assertClose(a,b,message,tolerance=1e-8) {
    assert.equal(a.length,b.length);
    a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<tolerance,`${message}: ${a} != ${b}`));
}
// Exercise the previously clipped HE margins through the actual compositor.
// Solid corner patches remain countable after rotation and piecewise resampling.
async function checkOverlayExtents(c, nonlinear) {
    const W=120,H=80,displayW=nonlinear?185:W,viewW=600,viewH=400;
    const geometry={legacy:{W,H,confirmed:true,
        x:nonlinear?[[0,0],[5,0],[9,4],[40,25],[120,70],[180,119],[184,119]]:[[0,0],[W-1,W-1]],
        y:[[0,0],[H-1,H-1]]},displayGeometry:{W:displayW,H,x:{origin:0,step:1},y:{origin:0,step:1}}};
    const sec={msiSeries:{MSI_A:{sourceGeometry:geometry}}};
    const he=canvas(240,160),hc=he.getContext('2d');
    hc.fillStyle='#ebc1cf';hc.fillRect(0,0,240,160);
    const corners=[[237,30,30],[222,142,10],[12,162,109],[117,60,204]];
    for(const [i,rgb] of corners.entries()) {
        hc.fillStyle='rgb('+rgb.join(',')+')';
        hc.fillRect(i%2?222:0,i>1?142:0,18,18);
    }
    const raw=await loadImage(he.toBuffer('image/png'));
    const msi=canvas(displayW,H),mc=msi.getContext('2d');
    mc.fillStyle='#025387';mc.fillRect(0,0,displayW,H);
    mc.fillStyle='#a7d8ed';mc.fillRect(3,3,displayW-6,H-6);
    const layer=nonlinear?c.displayAffineMultiply(c.displayRotation(33),[[-1.3,0,0],[0,.85,0],[0,0,1]]):c.displayRotation(0);
    const b=c.bakeImageWithSectionTransform(msi,layer),msiImg=await loadImage(b.toBuffer('image/png'));
    msiImg.dataset={ready:'true',ss:'1',rawW:String(displayW),rawH:String(H)};
    let T=nonlinear?[[-.8,-.21,154],[-.17,1.1,-22],[0,0,1]]:[[1,0,-60],[0,1,-40],[0,0,1]];
    Object.assign(c,{heImg:{dataset:{ready:'true'}},msiImg,imagesReady:true,overlayWarpCache:null,sec,state:{layerKey:'HE_STAIN'},
        panel:{imageSources:{HE_STAIN:raw}},currentMatrix:()=>T,alignmentMsiKey:()=>'MSI_A',sectionTransform:()=>({matrix:layer})});
    const overlay=canvas(viewW,viewH);
    const draw=opacity=>c.renderCompositePreview({canvas:overlay,width:viewW,height:viewH,opacity});
    draw(.55);
    const pixels=overlay.getContext('2d').getImageData(0,0,viewW,viewH).data;
    for(const rgb of corners) {
        let count=0;
        for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]===255&&rgb.every((v,j)=>pixels[i+j]===v))count++;
        assert.ok(count>20,'all four original HE corners survive the union fit, including off-grid warped corners');
    }
    if(nonlinear) {
        const axis=c.alignmentWarpAxis(geometry.legacy.x,geometry.displayGeometry.x,displayW);
        // The first and last rows each share a legacy index. Crossing the
        // acquired edge remains continuous and uses the nearest positive slope.
        assertClose([axis.toLegacy(-1),axis.toLegacy(0),axis.toLegacy(185),axis.toLegacy(186)],
            [-.5,.5,119.5,119.5+49/60],'flat terminal cells have an invertible off-grid extension');
        assertClose([axis.displayBound(-.5,false),axis.displayBound(119.5+49/60,true)],[-1,186],'off-grid HE fits both tails');
        const allocated=[],doc=c.document;
        c.document={createElement(){const out=canvas();allocated.push(out);return out;}};
        try {
            for(const scale of [.00001,1e6]) {
                T=[[scale,0,1e8],[0,scale,-1e9],[0,0,1]];
                draw(.4);
                assert.ok(allocated.length>0&&allocated.every(a=>a.width<=viewW+viewH&&a.height<=viewW+viewH),
                    'off-grid registration matrices allocate only screen-sized intermediate rasters');
            }
        } finally { c.document=doc; }
    }
    return overlay;
}
async function run({legacy=false,heAngle=5,msiAngle=0,physical=false,nonlinear=false}={}) {
    const h=await harness({physical,prepare(sec) {
        sec.meta.displayTransform={version:2,baseOrientation:'native-raster'};
        sec.meta.viewerTransform={rotHE:heAngle,rotMSI:msiAngle,rot:0,scale:1,tx:0,ty:0};
        for(const ent of Object.values(sec.msiSeries)) {
            const W=200,H=800,displayW=nonlinear?300:W;
            ent.W=displayW;ent.H=H;
            ent.sourceGeometry.displayGeometry={version:'msi-proportional-v1',W:displayW,H,
                x:{origin:0,step:nonlinear?298/299:1},y:{origin:0,step:1}};
            ent.sourceGeometry.legacy={W,H,confirmed:true,
                x:Array.from({length:W},(_,i)=>[i+(nonlinear?Math.max(0,i-100):0),i]),
                y:Array.from({length:H},(_,i)=>[i,i])};
        }
        sec.meta.alignment.HE_STAIN.bySource['file-1'].landmarks={
            he:points.map(p=>p.map(v=>2*v)),msi:plain(points)};
    },images(images) {
        for(const key of ['HE_STAIN','IF_STAIN'])Object.assign(images[key],{naturalWidth:400,naturalHeight:1600});
    }});
    const originalAngles=plain(h.section.meta.viewerTransform);
    await h.click('[data-solve]');
    await h.click('[data-save]');
    assert.equal(h.saves.length,1,'actual Save committed one draft: '+JSON.stringify({legacy,heAngle,msiAngle,physical,nonlinear,alerts:h.alerts}));
    const c=h.context,sec=h.section;
    const saved=c.resolveHeMsiAlignment(sec,'HE_STAIN','MSI_A',h.panel);
    assert.equal(saved.renderContract,contract,'Solve adopted the shared display contract');
    assert.equal(saved.record.alignmentContractVersion,2);
    assert.equal(saved.record.frame.version,'msi-alignment-frame-v2');
    assert.equal(saved.frame.version,'msi-alignment-frame-v1','runtime coordinate identity is unchanged');
    assert.deepEqual(plain(sec.meta.viewerTransform),originalAngles,'Solve/Save never reset section angles');
    assert.equal(c.computeLandmarkResiduals({he:points.map(p=>p.map(v=>2*v)),msi:points},saved.T).rmse_px,0);
    if(legacy) {
        // Preserve the old renderer's independent angles for unchanged v1
        // records. This is also the positive control for the original bug.
        const layer=sec.meta.alignment.HE_STAIN;
        for(const records of [layer.byFrame,layer.bySource,layer.sharedByCoordinate,layer.byGroup])
            for(const r of Object.values(records||{})) {
                delete r.renderContract;delete r.alignmentContractVersion;
                if(r.frame)r.frame.version='msi-alignment-frame-v1';
            }
        delete layer.renderContract;delete layer.alignmentContractVersion;
    }
    const resolved=c.resolveHeMsiAlignment(sec,'HE_STAIN','MSI_A',h.panel),T=resolved.T;
    assert.equal(resolved.effectiveDisplayKind,legacy?'he':'msi');
    for(const name of ['msiAxisInterpolate','msiLegacyRasterSize','msiLegacyRasterPointToDisplay','msiDisplayRasterPointToLegacy'])
        vm.runInContext(fn(name),c);
    c.document={createElement(tag){assert.equal(tag,'canvas');return canvas();}};
    c.get2dContext=x=>x.getContext('2d');c._activeColormapName='synthetic';
    c.HE_ON_MSI_CANVAS_LONG_EDGE_MAX=4096;
    vm.runInContext(closure('stampThumbDataset','\n        const alignmentMsiKey = '),c);
    vm.runInContext(closure('renderCompositePreview','\n        try {'),c);
    for(const name of ['renderComposite','_msiCanvasMatrix','setupCanvasSize','independentRotationBlocked','applyRotation'])
        c[name]=vm.runInContext('({'+method(name)+'}).'+name,c);
    const ref={w:sec.msiSeries.MSI_A.W,h:sec.msiSeries.MSI_A.H};
    const mapped=c.msiLegacyEdgePointToDisplay(sec,'MSI_A',points[0]);
    const heRaw=await marker(400,1600,[100,200],'#ff0000',14);
    const msiRaw=await marker(ref.w,ref.h,mapped,'#00ff00',7);
    const transform=kind=>{
        const matrix=c.sectionLayerViewLinear(sec,kind);
        const frame=c.sectionMsiPhysicalFrame(sec,'MSI_A',ref.w,ref.h,matrix);
        return {matrix:frame?frame.matrix:matrix,frame};
    };
    const mt=transform('msi');
    const msiBaked=mt.frame?c.bakeMsiImageWithFrame(msiRaw,mt.frame,1,false):c.bakeImageWithSectionTransform(msiRaw,mt.matrix,false,false,false);
    const msiImg=await loadImage(msiBaked.toBuffer('image/png'));
    msiImg.dataset={ready:'true'};
    c.stampThumbDataset(msiImg,ref.w,ref.h,mt,1);
    heRaw.dataset={ready:'true',coordinateSpace:'he-original',ss:'1',rawW:'400',rawH:'1600',
        displayMatrix:'[[1,0,0],[0,1,0],[0,0,1]]',tMatrix:JSON.stringify(T)};
    Object.assign(c,{heImg:heRaw,msiImg,imagesReady:true,overlayWarpCache:null,sec,state:{layerKey:'HE_STAIN'},
        panel:{imageSources:{HE_STAIN:heRaw}},currentMatrix:()=>T,alignmentMsiKey:()=>'MSI_A',
        sectionTransform:kind=>transform(kind==='he'?resolved.effectiveDisplayKind:kind)});
    const overlay=canvas(900,800);c.renderCompositePreview({canvas:overlay,width:900,height:800,opacity:.5});
    for(const [img,isHe] of [[heRaw,true],[msiImg,false]]) {
        const B=JSON.parse(img.dataset.displayMatrix),ss=Number(img.dataset.ss);
        const p=isHe?points[0].map(v=>2*v):c.applyAffinePoint(B,...mapped);
        img.getBoundingClientRect=()=>({left:20,top:30,width:img.naturalWidth/ss,height:img.naturalHeight/ss});
        assertClose(c.alignmentThumbClickPoint({clientX:20+p[0],clientY:30+p[1]},img,sec,'MSI_A'),
            isHe?points[0].map(v=>2*v):points[0],'actual displayed marker clicks invert to saved raw coordinates');
    }
    const main=canvas(),roi=canvas();
    const panel={section:sec,project:{rois:[]},dom:{cdisp:main,croi:roi,host:{clientWidth:900,clientHeight:800},rot:{style:{}}},
        displayCtx:main.getContext('2d'),imageSources:{HE_STAIN:heRaw,MSI_A:msiRaw},
        imageSettings:{HE_STAIN:{opacity:1},MSI_A:{opacity:.5}},visibleLayers:new Set(['HE_STAIN','MSI_A']),
        _maybeWarnRasterDimMismatch(){},_ensureViewerTransform(){return sec.meta.viewerTransform;},
        _ensureDrawableLoaded(){},_showMsiLoadStatus(){},updateScaleBar(){},applyViewerTransform(){},drawAllRois(){},
        registeredMsiKeys:()=>['MSI_A'],getMsiRefSize:()=>ref,_pickRefMsiKey:()=> 'MSI_A',msiRasterSize:()=>ref,
        _sourceHasGenuineAlignment:()=>true,isMsiLayerReady:()=>true,_msiCanvasMatrix:c._msiCanvasMatrix,
        renderComposite:c.renderComposite,_msiColorCanvas:()=>msiRaw,
        _newDisplayCache:()=>Object.assign(new Map(),{displayBudgetManaged:true})};
    c.setupCanvasSize.call(panel);
    const rotated=c.bakeImageWithSectionTransform(main,-90),mainDisplay=canvas(900,800),mc=mainDisplay.getContext('2d');
    const fit=Math.min(900/rotated.width,800/rotated.height);
    mc.drawImage(rotated,(900-rotated.width*fit)/2,(800-rotated.height*fit)/2,rotated.width*fit,rotated.height*fit);
    assert.equal(c.independentRotationBlocked.call(panel,'he'),!legacy);
    assert.equal(c.independentRotationBlocked.call(panel,'msi'),!legacy);
    assert.equal(c.independentRotationBlocked.call(panel,'both'),false);
    // Export must deliberately stay in the legacy frame even when the current
    // proportional bitmap is 300px wide and the registration frame is 200px.
    c._ensureHeImage=async()=>heRaw;
    vm.runInContext('async '+fn('bakeAlignedHeToMsiPng'),c);
    const exported=await c.bakeAlignedHeToMsiPng(panel,sec,'HE_STAIN');
    assert.equal(exported.w,200);assert.equal(exported.h,800);
    assert.equal(exported.alignedFrame.basis,'legacy-msi-pixel-edges-v1');
    const exportImage=await loadImage(exported.blob.bytes),exportCanvas=canvas(exported.w,exported.h);
    exportCanvas.getContext('2d').drawImage(exportImage,0,0);
    assertClose(centroid(exportCanvas,0),points[0],'native export excludes display warp/rotation',.1);
    const distances={legacy,heAngle,msiAngle,physical,nonlinear,modal:separation(overlay),main:separation(mainDisplay)};
    if(legacy&&heAngle!==msiAngle)assert.ok(distances.modal>20&&distances.main>20,'legacy positive control retains original displacement');
    else assert.ok(distances.modal<.5&&distances.main<.5,JSON.stringify(distances));
    // Rehydration keeps the v2 rendering policy, with no read-time migration.
    const reloaded=plain(sec),before=JSON.stringify(reloaded);
    assert.equal(c.resolveHeMsiAlignment(reloaded,'HE_STAIN','MSI_A',panel).renderContract,resolved.renderContract);
    assert.equal(JSON.stringify(reloaded),before);
    if(!legacy) {
        // Unmarked empty frame metadata is legacy in the ZIP and SQL
        // contracts, including when another layer makes the section managed.
        // Reading those records must retain the already saved matrix.
        for(const savedFrame of [undefined,null,{}, {version:null},{version:'msi-alignment-frame-v1'}]) {
            const historical=plain(sec),record={T_he_to_msi:plain(T)};
            if(savedFrame!==undefined)record.frame=plain(savedFrame);
            historical.meta.alignment={HE_STAIN:record};
            historical.meta.world_coords.T_he_to_msi=plain(T);
            assert.equal(Archive.requiresAlignmentV2(historical),false);
            for(const managed of [false,true]) {
                if(managed)historical.meta.alignment.IF_STAIN={byFrame:{unrelated:{}}};
                const before=JSON.stringify(historical);
                const restored=c.resolveHeMsiAlignment(historical,'HE_STAIN','MSI_A',h.panel);
                assert.deepEqual(plain(restored.T),plain(T),'legacy empty frame preserves T in '+(managed?'managed':'unmanaged')+' section');
                assert.equal(restored.renderContract,'legacy-independent-display-v1');
                assert.equal(JSON.stringify(historical),before,'resolver does not migrate legacy metadata');
            }
        }
        const bad=plain(sec),f=c.alignmentFrameDescriptor(bad,'MSI_A',panel);
        bad.meta.alignment.HE_STAIN.byFrame[f.key].renderContract='future-display-v9';
        assert.equal(c.resolveHeMsiAlignment(bad,'HE_STAIN','MSI_A',panel).T,null,'unknown newest contract cannot use legacy fallback');
        const wrongVersion=plain(sec);
        wrongVersion.meta.alignment.HE_STAIN.byFrame[f.key].frame.version='msi-alignment-frame-v1';
        assert.equal(c.resolveHeMsiAlignment(wrongVersion,'HE_STAIN','MSI_A',panel).T,null,'a partially upgraded record fails closed');
        const sourceOnly=plain(sec),layer=sourceOnly.meta.alignment.HE_STAIN;
        const explicit=plain(layer.byFrame[f.key]);
        delete explicit.landmarks;delete explicit.autoAligned;
        explicit.T_he_to_msi=[[.75,0,11],[0,.75,12],[0,0,1]];
        for(const field of ['byFrame','byGroup','sharedByCoordinate'])delete layer[field];
        layer.bySource={'file-1':explicit};
        const sourcePanel={...h.panel,section:sourceOnly};
        assert.equal(sourcePanel._sourceHasGenuineAlignment('file-1'),true,'explicit canonical manual T is genuine without Auto or landmarks');
        assert.deepEqual(plain(c.resolveHeMsiAlignment(sourceOnly,'HE_STAIN','MSI_A',sourcePanel).T),explicit.T_he_to_msi,
            'bySource-only canonical T is authoritative over legacy global scalars');
        explicit.renderContract='future-display-v9';
        assert.equal(c.resolveHeMsiAlignment(sourceOnly,'HE_STAIN','MSI_A',sourcePanel).T,null,
            'unknown bySource-only contract cannot be hidden by a valid global T');
        const malformedContracts=[
            r=>{r.renderContract=null;r.alignmentContractVersion=null;},
            r=>{r.alignmentContractVersion=null;},
            r=>{delete r.renderContract;delete r.alignmentContractVersion;},
            r=>{delete r.renderContract;delete r.alignmentContractVersion;r.frame.version='msi-alignment-frame-v99';},
            r=>{r.frame.version=null;},
        ];
        for(const corrupt of malformedContracts) {
            const invalid=plain(sec),invalidLayer=invalid.meta.alignment.HE_STAIN;
            const invalidRecord=invalidLayer.byFrame[f.key];corrupt(invalidRecord);
            assert.equal(c.resolveHeMsiAlignment(invalid,'HE_STAIN','MSI_A',panel).T,null,
                'null/partial/unknown declarations fail closed in managed records');
            for(const field of ['byFrame','byGroup','sharedByCoordinate'])delete invalidLayer[field];
            invalidLayer.bySource={'file-1':invalidRecord};
            const invalidPanel={...h.panel,section:invalid};
            assert.equal(c.resolveHeMsiAlignment(invalid,'HE_STAIN','MSI_A',invalidPanel).T,null,
                'null markers or stripped v2 flags cannot downgrade to global legacy T');
            assert.equal(invalidPanel._sourceHasGenuineAlignment('file-1'),false,
                'old landmarks/Auto cannot bypass an invalid declared contract');
        }
        const mixed=plain(sec),cf=c.alignmentFrameDescriptor(mixed,'MSI_C',panel);
        const other=plain(mixed.meta.alignment.HE_STAIN.byFrame[f.key]);other.frame=plain(cf);
        delete other.renderContract;delete other.alignmentContractVersion;
        mixed.meta.alignment.HE_STAIN.byFrame[cf.key]=other;
        c.window.MsiRatioRuntime={definitions:()=>[{id:'registration-test'}],
            inputs:()=>({x:{key:'MSI_A'},y:{key:'MSI_C'}})};
        assert.equal(c.resolveHeMsiAlignment(mixed,'HE_STAIN','MSI_RATIO_registration-test',panel).reason,'ratio-transform-mismatch',
            'equal T with different display contracts is not a matching ratio registration');
        other.frame.version='msi-alignment-frame-v2';other.renderContract=contract;other.alignmentContractVersion=2;
        assert.equal(c.resolveHeMsiAlignment(mixed,'HE_STAIN','MSI_RATIO_registration-test',panel).status,'ready');
    }
    if(!legacy&&heAngle===5&&msiAngle===0&&physical) await checkOverlayExtents(c,nonlinear);
    if(!legacy&&!physical) {
        const capped={dataset:{}};
        c.stampThumbDataset(capped,12000,128,{matrix:c.displayRotation(0)},1);
        assert.equal(Number(capped.dataset.ss),6144/12000,'MSI thumb metadata uses the actual backing resolution');
    }
    h.assertNumericUnchanged();
    return distances;
}

(async()=>{
    const results=[];
    for(const options of [{legacy:true},{},{heAngle:5,msiAngle:5},{physical:true},{physical:true,nonlinear:true}])
        results.push(await run(options));
    console.log('PASS real-canvas HE/MSI registration contracts, clicks, Save/reload, native export and physical/nonlinear display, four HE corners and bounded off-grid rendering');
    console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
