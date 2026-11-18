'use strict';

// Full offline application, real pointer events, real image/CSV decoding,
// IndexedDB Save/reload and browser canvas pixels. Synthetic fixtures only.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const {renderOfflineConfig}=require('../offline/config.cjs');
const root=path.resolve(__dirname,'..');
const points=[[20.5,35.5],[55.5,45.5],[28.5,85.5],[53.5,95.5]];

async function main() {
    const external=[],writes=[],errors=[],dialogs=[];
    const server=http.createServer(async(req,res)=>{
        try {
            const pathname=decodeURIComponent(new URL(req.url,'http://fixture').pathname);
            if(!['GET','HEAD'].includes(req.method)){writes.push(pathname);res.writeHead(405);res.end();return;}
            if(pathname==='/runtime-config.js'){res.setHeader('Content-Type','text/javascript');res.end(renderOfflineConfig());return;}
            const file=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''));
            if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
            res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css'})[path.extname(file)]||'application/octet-stream');
            res.end(await fs.readFile(file));
        }catch{res.writeHead(404);res.end();}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin='http://127.0.0.1:'+server.address().port;
    let browser;
    try {
        browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
        const context=await browser.newContext({viewport:{width:1500,height:1050}});
        await context.route('**/*',route=>{
            const url=route.request().url();
            if(url.startsWith(origin+'/')||/^(blob|data):/.test(url))return route.continue();
            external.push(url);return route.abort();
        });
        const page=await context.newPage();page.setDefaultTimeout(30000);
        page.on('pageerror',error=>errors.push(error.message));
        page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.accept();});
        await page.goto(origin+'/viewer/?project=synthetic-registration-seed');
        await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline&&typeof MsiAlignmentTransform!=='undefined');
        const fixture=await page.evaluate(async points=>{
            const id=await App.createNewProject('Synthetic HE MSI registration');await App.addSection();
            const section=App.project.sections[0],panel=App.panels.get(section.id),W=80,H=240;
            const rows=['x,y,signal'];
            for(let y=0;y<H;y++)for(let x=0;x<W;x++) {
                const signal=points.some(p=>(x+.5-p[0])**2+(y+.5-p[1])**2<=16)?100:0;
                rows.push([x,y,signal].join(','));
            }
            await panel.addMsiLayer('MSI_A',new File([rows.join('\n')+'\n'],'synthetic.csv',{type:'text/csv'}),
                {kind:'txt',x:'x',y:'y',v:'signal',sep:',',bakeMode:'full'},
                {sourceFileId:'synthetic-alignment-source',deferBulkRefresh:true});
            // The scan covers only the middle of this larger photograph. The four
            // blue corner labels lie outside the true registered MSI footprint.
            const photo=document.createElement('canvas');photo.width=W*2+80;photo.height=H*2+80;
            const paint=photo.getContext('2d');paint.fillStyle='#ff0000';
            for(const p of points){paint.beginPath();paint.arc(p[0]*2+40,p[1]*2+40,8,0,2*Math.PI);paint.fill();}
            const corners=['#2020ff','#e020ff','#20e0ff','#e0e0ff'];
            for(let index=0;index<corners.length;index++) {
                paint.fillStyle=corners[index];
                paint.fillRect(index%2?photo.width-12:2,index>1?photo.height-12:2,10,10);
            }
            await panel.addImageLayer('HE_STAIN',await new Promise(resolve=>photo.toBlob(resolve)),'image/png');
            await panel.finishBulkAdd('MSI_A');
            section.meta.displayTransform={version:2,baseOrientation:'native-raster'};
            section.meta.viewerTransform={rotHE:5,rotMSI:0,rot:0,scale:1,tx:0,ty:0};
            Object.assign(panel._ensureViewerTransform(),section.meta.viewerTransform);
            delete section.meta.world_coords.T_he_to_msi;
            section.meta.world_coords.msi_um_per_px={x:30,y:30};
            App.setActiveSection(section.id);App.setViewMode('compound');App.setFocusCompoundKey('MSI_A');
            await App.setOtsuBgRemove(false);panel.setupCanvasSize();await App._flushSave();
            return {id,values:Array.from(panel.msiValueRasters.get('MSI_A').values)};
        },points);
        async function installSyntheticPalette() {
            const endpoints=await page.evaluate(()=>{
                // Toolbar refresh, Cancel and reload restore the project's saved
                // colormap name. Give that supported name its isolated test LUT
                // within this page so those normal UI actions retain both channels.
                const name=App.getMsiDisplaySettings().colormap;
                COLORMAPS[name]=Array.from({length:256},(_,i)=>[0,i,0]);
                App.refreshMsiDisplayControls();
                const panel=App.panels.get(App.project.sections[0].id);
                // Colorized canvases cache the palette name, not the test LUT.
                panel._msiLutCache?.clear();panel.renderComposite();
                return [getActiveColormap()[0],getActiveColormap()[255]];
            });
            assert.deepEqual(endpoints,[[0,0,0],[0,255,0]],'synthetic MSI palette');
        }
        await installSyntheticPalette();
        async function ready() {
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            await page.waitForFunction(()=>['he','msi'].every(side=>{
                const img=document.querySelector('[data-'+side+'-img]');return img&&img.complete&&img.dataset.ready==='true';
            })&&!document.querySelector('[data-save]').disabled);
        }
        async function openAlignment() {
            await page.evaluate(()=>{
                window.__alignmentDone=false;
                Wizards.openAlignmentModal(App.panels.get(App.project.sections[0].id)).then(()=>window.__alignmentDone=true);
            });
            await ready();
        }
        async function cancelAlignment() {
            await page.locator('[data-modal-cancel]').click();
            await page.waitForFunction(()=>window.__alignmentDone);
        }
        async function registrationAndOriginal() {
            return page.evaluate(async()=>{
                const section=App.project.sections[0];
                const stored=await ProjectStorage.getProject(App.project.id);
                const original=await ProjectStorage.getBlob(section.images.HE_STAIN.blobId);
                const digest=await crypto.subtle.digest('SHA-256',await original.blob.arrayBuffer());
                return {active:captureSectionAlignment(section),stored:captureSectionAlignment(stored.sections[0]),
                    hash:Array.from(new Uint8Array(digest))};
            });
        }
        async function expectEntirePhotograph() {
            const view=await page.locator('[data-he-img]').evaluate(img=>{
                const image=img.getBoundingClientRect();
                const viewport=img.closest('[data-thumb-wrap="he"]').getBoundingClientRect();
                const canvas=document.createElement('canvas');
                canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
                const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
                const colors=Array.from({length:4},(_,i)=>Array.from(ctx.getImageData(
                    i%2?canvas.width-7:7,i>1?canvas.height-7:7,1,1).data));
                return {size:[canvas.width,canvas.height],colors,margins:[image.left-viewport.left,
                    image.top-viewport.top,viewport.right-image.right,viewport.bottom-image.bottom]};
            });
            assert.deepEqual(view.size,[240,560],'the left pane uses the complete original HE extent');
            assert.deepEqual(view.colors,[[32,32,255,255],[224,32,255,255],[32,224,255,255],[224,224,255,255]]);
            assert.ok(view.margins.every(v=>v>=-1),'all four original edges fit on opening: '+view.margins);
        }
        async function showOverlayWithAllCorners() {
            await page.locator('.msi-align-view-controls > button').nth(1).click();
            await page.waitForFunction(()=>{
                const canvas=document.querySelector('.msi-align-composite canvas');
                if(!canvas||canvas.clientWidth===0||canvas.width<2)return false;
                const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
                const counts=[0,0,0,0];
                for(let i=0;i<pixels.length;i+=4) {
                    const blue=pixels[i+2];
                    if(blue<45||pixels[i+3]<100)continue;
                    const label=Number(pixels[i]>0.5*blue)+2*Number(pixels[i+1]>0.5*blue);
                    counts[label]++;
                }
                return counts.every(n=>n>=9);
            },undefined,{timeout:10000});
        }
        const initial=await registrationAndOriginal();
        await openAlignment();
        await expectEntirePhotograph();
        assert.equal(await page.locator('[data-solve]').isDisabled(),true,'a fresh registration has no fit pairs');
        await showOverlayWithAllCorners();
        await cancelAlignment();
        assert.deepEqual(await registrationAndOriginal(),initial,'opening and viewing cannot create a registration');
        await openAlignment();
        await page.locator('[data-auto-fit]').check();
        const hePoint = p => p.map(v=>2*v+40);
        async function clickLandmark(side,raw) {
            await page.locator('[data-pick="'+side+'"]').click();
            await ready();
            const client=await page.evaluate(({side,raw})=>{
                const section=App.project.sections[0],img=document.querySelector('[data-'+side+'-img]');
                // Independently target the known original photo pixel. The
                // registration matrix must not enter this pointer projection.
                let baked=raw;
                if(side==='msi') {
                    const displayed=msiLegacyEdgePointToDisplay(section,'MSI_A',raw)||raw;
                    baked=applyAffinePoint(JSON.parse(img.dataset.displayMatrix),...displayed);
                }
                const ss=Number(img.dataset.ss)||1,rect=img.getBoundingClientRect();
                return {x:rect.left+baked[0]*ss/img.naturalWidth*rect.width,
                    y:rect.top+baked[1]*ss/img.naturalHeight*rect.height};
            },{side,raw});
            await page.mouse.click(client.x,client.y);
            await ready();
            return client;
        }
        for(const p of points.slice(0,3)){await clickLandmark('he',hePoint(p));await clickLandmark('msi',p);}
        assert.equal(await page.locator('[data-auto-fit]').isChecked(),true);
        const automaticScale=Number(await page.locator('[data-scale-num]').inputValue());
        assert.ok(Math.abs(automaticScale-50)<.6,'the third complete pair automatically fits the true scale');
        // A viewport zoom changes only the pointer projection. It must not
        // mutate the canonical registration matrix.
        const beforeZoom=await page.locator('[data-he-img]').getAttribute('data-t-matrix');
        const heZoom=page.locator('.msi-align-pane').first().locator('.msi-align-pane-header button');
        const width=async()=>(await page.locator('[data-he-img]').boundingBox()).width;
        const initialWidth=await width();
        await heZoom.nth(1).click();await ready();
        assert.ok((await width())>1.2*initialWidth,'zoom actually enlarges the HE pane');
        await heZoom.nth(0).click();await ready();
        assert.ok(Math.abs(await width()-initialWidth)<1,'zoom out returns to the fitted original view');
        // Click the fourth pair under magnification, then use a fresh fit on reopen.
        await heZoom.nth(1).click();await ready();
        assert.equal(await page.locator('[data-he-img]').getAttribute('data-t-matrix'),beforeZoom);
        await page.locator('.msi-align-details summary').click();
        await page.locator('[data-scale-num]').fill('55');await page.locator('[data-scale-num]').dispatchEvent('input');
        await ready();
        assert.equal(await page.locator('[data-auto-fit]').isChecked(),false,'manual Scale opts out of automatic refitting');
        const manual=await page.locator('[data-he-img]').getAttribute('data-t-matrix');
        assert.notEqual(manual,beforeZoom,'the manual scale actually changes the registration');
        // The floating controls cover part of the image; finish the adjustment
        // before sending a real pointer event to the next landmark.
        await page.locator('.msi-align-details summary').click();
        await clickLandmark('he',hePoint(points[3]));await clickLandmark('msi',points[3]);
        assert.equal(await page.locator('[data-he-img]').getAttribute('data-t-matrix'),manual,'adding points preserves the manual adjustment');
        await page.locator('[data-solve]').click();await ready();
        assert.equal(await page.locator('[data-auto-fit]').isChecked(),true,'Solve returns to automatic fitting');
        assert.ok(Math.abs(Number(await page.locator('[data-scale-num]').inputValue())-50)<.6);
        await showOverlayWithAllCorners();
        async function rasterDistance(kind) {
            return page.evaluate(kind=>{
                const panel=App.panels.get(App.project.sections[0].id);
                const c=kind==='modal'?document.querySelector('.msi-align-composite canvas'):panel.dom.cdisp;
                const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                // The four deliberately asymmetric green markers form two rows and
                // columns in either raster orientation. Individually compare each
                // red/green pair so opposite offsets cannot cancel in the mean.
                let xmin=c.width,ymin=c.height,xmax=0,ymax=0;
                for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++) {
                    const k=4*(y*c.width+x);
                    if(d[k+2]||d[k+1]*d[k+3]/255<10)continue;
                    xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);
                    ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);
                }
                const xmid=(xmin+xmax)/2,ymid=(ymin+ymax)/2;
                const sums=Array.from({length:5},()=>[0,1].map(()=>({w:0,x:0,y:0})));
                for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++) {
                    const k=4*(y*c.width+x);
                    if(d[k+2]||(!d[k]&&!d[k+1]))continue;
                    const region=Number(x>xmid)+2*Number(y>ymid);
                    for(const slot of [region,4])for(const channel of [0,1]) {
                        const w=d[k+channel]*d[k+3]/255,acc=sums[slot][channel];
                        acc.w+=w;acc.x+=(x+.5)*w;acc.y+=(y+.5)*w;
                    }
                }
                const scale=kind==='modal'?1:panel._displayCanvasFrame.baseH/panel.getMsiRefSize().w;
                const distances=sums.map(([red,green],i)=>{
                    if(!red.w||!green.w)throw new Error('Missing synthetic marker: '+JSON.stringify({
                        kind,region:i,canvas:[c.width,c.height],greenBounds:[xmin,ymin,xmax,ymax],
                        channelWeights:sums.map(pair=>pair.map(acc=>Math.round(acc.w))),
                        palette:_activeColormapName,highColor:getActiveColormap()[255],
                        opacity:document.querySelector('.msi-align-opacity input')?.value||panel.imageSettings.MSI_A.opacity
                    }));
                    return Math.hypot(red.x/red.w-green.x/green.w,red.y/red.w-green.y/green.w)/scale;
                });
                return {total:distances.pop(),perMarker:distances};
            },kind);
        }
        const overlay=await rasterDistance('modal');
        assert.ok(overlay.total<1.5&&overlay.perMarker.every(v=>v<3),'modal raster alignment: '+JSON.stringify(overlay));
        await page.locator('[data-save]').click();await page.waitForFunction(()=>window.__alignmentDone);
        const saved=await page.evaluate(async()=>{
            const section=App.project.sections[0],panel=App.panels.get(section.id);
            panel.imageSettings.MSI_A.opacity=.5;panel.renderComposite();await App._flushSave();
            const r=resolveHeMsiAlignment(section,'HE_STAIN','MSI_A',panel);
            return {contract:r.renderContract,version:r.record.frame.version,angles:section.meta.viewerTransform,T:r.T,landmarks:r.record.landmarks,
                residual:computeLandmarkResiduals(r.record.landmarks,r.T).rmse_px,
                values:Array.from(panel.msiValueRasters.get('MSI_A').values)};
        });
        assert.equal(saved.contract,'msi-shared-display-v1');assert.equal(saved.version,'msi-alignment-frame-v2');
        for(let i=0;i<points.length;i++) {
            const he=hePoint(points[i]);
            assert.ok(Math.hypot(...saved.landmarks.he[i].map((v,d)=>v-he[d]))<1.8,'raw HE click '+i);
            assert.ok(Math.hypot(...saved.landmarks.msi[i].map((v,d)=>v-points[i][d]))<1,'raw MSI click '+i);
        }
        assert.equal(saved.angles.rotHE,5);assert.equal(saved.angles.rotMSI,0);
        assert.ok(saved.residual<.5,'actual pointer round-trip fit remains accurate');assert.deepEqual(saved.values,fixture.values);
        const mainDistance=await rasterDistance('main');assert.ok(mainDistance.total<.6&&mainDistance.perMarker.every(v=>v<1.25),
            'saved main renderer: '+JSON.stringify(mainDistance));
        await page.reload();
        await page.waitForFunction(id=>typeof App!=='undefined'&&App.project?.id===id&&App.panels.size===1,fixture.id);
        const restored=await page.evaluate(async()=>{
            const section=App.project.sections[0],panel=App.panels.get(section.id);
            await panel.ensureMsiLayerLoaded('MSI_A');await panel.ensureImageLayerLoaded('HE_STAIN');
            App.setActiveSection(section.id);App.setViewMode('compound');App.setFocusCompoundKey('MSI_A');
            panel.imageSettings.MSI_A.opacity=.5;panel.setupCanvasSize();
            const r=resolveHeMsiAlignment(section,'HE_STAIN','MSI_A',panel);
            return {contract:r.renderContract,T:r.T,angles:section.meta.viewerTransform,
                values:Array.from(panel.msiValueRasters.get('MSI_A').values)};
        });
        assert.equal(restored.contract,'msi-shared-display-v1');assert.equal(restored.angles.rotHE,5);assert.equal(restored.angles.rotMSI,0);
        assert.deepEqual(restored.values,fixture.values);assert.deepEqual(restored.T,saved.T);
        await installSyntheticPalette();
        const reloaded=await rasterDistance('main');assert.ok(reloaded.total<.6&&reloaded.perMarker.every(v=>v<1.25),
            'reloaded main renderer: '+JSON.stringify(reloaded));
        const persisted=await registrationAndOriginal();assert.deepEqual(persisted.hash,initial.hash);
        await openAlignment();await expectEntirePhotograph();await showOverlayWithAllCorners();
        await page.locator('.msi-align-view-controls > button').first().click();await ready();
        const corner=await clickLandmark('he',[233,553]);  // outside the measured area in both axes
        const dots=page.locator('[data-he-svg] circle');
        assert.equal(await dots.count(),points.length+1,'a photo corner outside the scan accepts a landmark');
        const dot=await dots.last().boundingBox();
        assert.ok(dot&&Math.hypot(dot.x+dot.width/2-corner.x,dot.y+dot.height/2-corner.y)<2,
            'a landmark outside the scan stays at the original HE pixel clicked');
        await cancelAlignment();
        assert.deepEqual(await registrationAndOriginal(),persisted,'viewing a saved transform and cancelling a draft keeps the matrix and source intact');
        assert.deepEqual(external,[]);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.deepEqual(dialogs,[]);
        console.log('PASS full HE corners in initial and registered views, pointer coordinates, zoom, Solve, Save/reload and unchanged source values');
        console.log(JSON.stringify({overlayPx:overlay,mainMsiPx:mainDistance,reloadedMsiPx:reloaded,rmseMsiPx:saved.residual}));
        await context.close();
    }finally{
        if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
