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
            const photo=document.createElement('canvas');photo.width=W*2;photo.height=H*2;
            const paint=photo.getContext('2d');paint.fillStyle='#ff0000';
            for(const p of points){paint.beginPath();paint.arc(p[0]*2,p[1]*2,8,0,2*Math.PI);paint.fill();}
            await panel.addImageLayer('HE_STAIN',await new Promise(resolve=>photo.toBlob(resolve)),'image/png');
            await panel.finishBulkAdd('MSI_A');
            section.meta.displayTransform={version:2,baseOrientation:'native-raster'};
            section.meta.viewerTransform={rotHE:5,rotMSI:0,rot:0,scale:1,tx:0,ty:0};
            Object.assign(panel._ensureViewerTransform(),section.meta.viewerTransform);
            section.meta.world_coords.T_he_to_msi=[[.5,0,0],[0,.5,0],[0,0,1]];
            section.meta.world_coords.msi_um_per_px={x:30,y:30};
            // A test-only LUT isolates the two channels while retaining the
            // production MSI window, raster, colorizer and render pipeline.
            COLORMAPS.__alignment_test_green=Array.from({length:256},(_,i)=>[0,i,0]);
            setActiveColormap('__alignment_test_green');
            App.setActiveSection(section.id);App.setViewMode('compound');App.setFocusCompoundKey('MSI_A');
            await App.setOtsuBgRemove(false);panel.setupCanvasSize();await App._flushSave();
            return {id,values:Array.from(panel.msiValueRasters.get('MSI_A').values)};
        },points);
        async function ready() {
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            await page.waitForFunction(()=>['he','msi'].every(side=>{
                const img=document.querySelector('[data-'+side+'-img]');return img&&img.complete&&img.dataset.ready==='true';
            })&&!document.querySelector('[data-save]').disabled);
        }
        await page.evaluate(()=>{
            window.__alignmentDone=false;
            Wizards.openAlignmentModal(App.panels.get(App.project.sections[0].id)).then(()=>window.__alignmentDone=true);
        });
        await ready();
        await page.locator('[data-auto-fit]').check();
        async function clickLandmark(side,p) {
            await page.locator('[data-pick="'+side+'"]').click();
            await ready();
            const client=await page.evaluate(({side,p})=>{
                const section=App.project.sections[0],img=document.querySelector('[data-'+side+'-img]');
                const raw=side==='he'?p.map(v=>2*v):p;
                const T=img.dataset.tMatrix?JSON.parse(img.dataset.tMatrix):null;
                const legacy=T?applyAffinePoint(T,...raw):raw;
                const displayed=msiLegacyEdgePointToDisplay(section,'MSI_A',legacy)||legacy;
                const B=JSON.parse(img.dataset.displayMatrix),baked=applyAffinePoint(B,...displayed);
                const ss=Number(img.dataset.ss)||1,rect=img.getBoundingClientRect();
                return {x:rect.left+baked[0]*ss/img.naturalWidth*rect.width,
                    y:rect.top+baked[1]*ss/img.naturalHeight*rect.height};
            },{side,p});
            await page.mouse.click(client.x,client.y);
            await ready();
        }
        for(const p of points.slice(0,3)){await clickLandmark('he',p);await clickLandmark('msi',p);}
        assert.equal(await page.locator('[data-auto-fit]').isChecked(),true);
        const automaticScale=Number(await page.locator('[data-scale-num]').inputValue());
        assert.ok(Math.abs(automaticScale-50)<.6,'the third complete pair automatically fits the true scale');
        // A viewport zoom changes only the pointer projection. It must not
        // mutate the canonical registration matrix.
        const beforeZoom=await page.locator('[data-he-img]').getAttribute('data-t-matrix');
        await page.locator('.msi-align-pane').first().locator('.msi-align-pane-header button').nth(1).click();
        await ready();
        assert.equal(await page.locator('[data-he-img]').getAttribute('data-t-matrix'),beforeZoom);
        await page.locator('.msi-align-details summary').click();
        await page.locator('[data-scale-num]').fill('55');await page.locator('[data-scale-num]').dispatchEvent('input');
        await ready();
        assert.equal(await page.locator('[data-auto-fit]').isChecked(),false,'manual Scale opts out of automatic refitting');
        const manual=await page.locator('[data-he-img]').getAttribute('data-t-matrix');
        // The floating controls cover part of the image; finish the adjustment
        // before sending a real pointer event to the next landmark.
        await page.locator('.msi-align-details summary').click();
        await clickLandmark('he',points[3]);await clickLandmark('msi',points[3]);
        assert.equal(await page.locator('[data-he-img]').getAttribute('data-t-matrix'),manual,'adding points preserves the manual adjustment');
        await page.locator('[data-solve]').click();await ready();
        assert.equal(await page.locator('[data-auto-fit]').isChecked(),true,'Solve returns to automatic fitting');
        assert.ok(Math.abs(Number(await page.locator('[data-scale-num]').inputValue())-50)<.6);
        await page.locator('.msi-align-view-controls > button').nth(1).click();
        await page.waitForFunction(()=>document.querySelector('.msi-align-composite canvas')?.width>1);
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        async function rasterDistance(kind) {
            return page.evaluate(kind=>{
                const panel=App.panels.get(App.project.sections[0].id);
                const c=kind==='modal'?document.querySelector('.msi-align-composite canvas'):panel.dom.cdisp;
                const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                const centroids=[0,1].map(channel=>{
                    let s=0,x=0,y=0;
                    for(let j=0;j<c.height;j++)for(let i=0;i<c.width;i++){
                        const k=4*(j*c.width+i),w=d[k+channel]*d[k+3]/255;s+=w;x+=(i+.5)*w;y+=(j+.5)*w;
                    }
                    if(!s)throw new Error('Synthetic marker missing: '+kind+'/'+channel);
                    return [x/s,y/s];
                });
                const distance=Math.hypot(centroids[0][0]-centroids[1][0],centroids[0][1]-centroids[1][1]);
                return kind==='modal'?distance:distance/(panel._displayCanvasFrame.baseH/panel.getMsiRefSize().w);
            },kind);
        }
        const overlay=await rasterDistance('modal');assert.ok(overlay<1.5,'actual modal raster marker alignment: '+overlay);
        await page.locator('[data-save]').click();await page.waitForFunction(()=>window.__alignmentDone);
        const saved=await page.evaluate(async()=>{
            const section=App.project.sections[0],panel=App.panels.get(section.id);
            panel.imageSettings.MSI_A.opacity=.5;panel.renderComposite();await App._flushSave();
            const r=resolveHeMsiAlignment(section,'HE_STAIN','MSI_A',panel);
            return {contract:r.renderContract,version:r.record.frame.version,angles:section.meta.viewerTransform,
                residual:computeLandmarkResiduals(r.record.landmarks,r.T).rmse_px,
                values:Array.from(panel.msiValueRasters.get('MSI_A').values)};
        });
        assert.equal(saved.contract,'msi-shared-display-v1');assert.equal(saved.version,'msi-alignment-frame-v2');
        assert.equal(saved.angles.rotHE,5);assert.equal(saved.angles.rotMSI,0);
        assert.ok(saved.residual<.5,'actual pointer round-trip fit remains accurate');assert.deepEqual(saved.values,fixture.values);
        const mainDistance=await rasterDistance('main');assert.ok(mainDistance<.6,'saved main renderer: '+mainDistance);
        await page.reload();
        await page.waitForFunction(id=>typeof App!=='undefined'&&App.project?.id===id&&App.panels.size===1,fixture.id);
        const restored=await page.evaluate(async()=>{
            const section=App.project.sections[0],panel=App.panels.get(section.id);
            await panel.ensureMsiLayerLoaded('MSI_A');await panel.ensureImageLayerLoaded('HE_STAIN');
            COLORMAPS.__alignment_test_green=Array.from({length:256},(_,i)=>[0,i,0]);setActiveColormap('__alignment_test_green');
            App.setActiveSection(section.id);App.setViewMode('compound');App.setFocusCompoundKey('MSI_A');
            panel.imageSettings.MSI_A.opacity=.5;panel.setupCanvasSize();
            const r=resolveHeMsiAlignment(section,'HE_STAIN','MSI_A',panel);
            return {contract:r.renderContract,T:r.T,angles:section.meta.viewerTransform,
                values:Array.from(panel.msiValueRasters.get('MSI_A').values)};
        });
        assert.equal(restored.contract,'msi-shared-display-v1');assert.equal(restored.angles.rotHE,5);assert.equal(restored.angles.rotMSI,0);
        assert.deepEqual(restored.values,fixture.values);
        const reloaded=await rasterDistance('main');assert.ok(reloaded<.6,'reloaded main renderer: '+reloaded);
        assert.deepEqual(external,[]);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.deepEqual(dialogs,[]);
        console.log('PASS browser HE/MSI clicks, automatic fit, manual Scale, Solve, Overlay, Save/reload and unchanged source values');
        console.log(JSON.stringify({overlayPx:overlay,mainMsiPx:mainDistance,reloadedMsiPx:reloaded,rmseMsiPx:saved.residual}));
        await context.close();
    }finally{
        if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
