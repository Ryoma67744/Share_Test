'use strict';
// Production offline Viewer/IndexedDB/source parser. Synthetic files only;
// every network request must stay on this temporary localhost server.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const {renderOfflineConfig}=require('../offline/config.cjs');
const root=path.resolve(__dirname,'..');

async function main() {
    const external=[],writes=[],errors=[];
    const server=http.createServer(async(req,res)=>{
        try {
            const pathname=decodeURIComponent(new URL(req.url,'http://fixture').pathname);
            if(!['GET','HEAD'].includes(req.method)){writes.push(pathname);res.writeHead(405);res.end();return;}
            if(pathname==='/runtime-config.js') {res.setHeader('Content-Type','text/javascript');res.end(renderOfflineConfig());return;}
            const file=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''));
            if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
            res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css'})[path.extname(file)]||'application/octet-stream');
            res.end(await fs.readFile(file));
        }catch{res.writeHead(404);res.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    let browser;
    try {
        browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
        const context=await browser.newContext({viewport:{width:1600,height:1100}});
        await context.route('**/*',route=>{
            const url=route.request().url();
            if(url.startsWith(origin+'/')||/^(blob|data):/.test(url))return route.continue();
            external.push(url);return route.abort();
        });
        const page=await context.newPage();page.setDefaultTimeout(30000);
        page.on('pageerror',error=>errors.push(error.message));
        page.on('dialog',dialog=>dialog.accept(dialog.type()==='prompt'?'Synthetic shared ROI':undefined));
        await page.goto(origin+'/viewer/?project=synthetic-spatial-seed');
        await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline&&typeof MsiSpatialGroups!=='undefined');
        const projectId=await page.evaluate(async()=>{
            const id=await App.createNewProject('Synthetic same-section geometry');await App.addSection();
            const section=App.project.sections[0],panel=App.panels.get(section.id);
            section.displayName='Same section: A / B / shifted';section.meta.world_coords.msi_um_per_px={x:30,y:30};
            for(const [key,factor,offset] of [['MSI_A',1,0],['MSI_B',10,0],['MSI_SHIFTED',100,20],['MSI_MISSING',1000,0]]) {
                const rows=['x,y,signal'];
                for(let y=0;y<8;y++)for(let x=0;x<8;x++)rows.push([x+offset,y,key==='MSI_MISSING'&&x===7?'NA':(1+x+8*y)*factor].join(','));
                await panel.addMsiLayer(key,new File([rows.join('\n')+'\n'],key+'.csv',{type:'text/csv'}),
                    {kind:'txt',x:'x',y:'y',v:'signal',sep:',',bakeMode:'full'},
                    {sourceFileId:'synthetic-'+key,deferBulkRefresh:true});
            }
            const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
            const ctx=canvas.getContext('2d');ctx.fillStyle='#f9dde7';ctx.fillRect(0,0,8,8);
            ctx.fillStyle='#93325b';ctx.fillRect(1,1,3,5);ctx.fillStyle='#dbc5eb';ctx.fillRect(4,3,3,3);
            await panel.addImageLayer('HE_STAIN',await new Promise(resolve=>canvas.toBlob(resolve)),'image/png');
            await panel.finishBulkAdd('MSI_A');
            App.setActiveSection(section.id);App.setViewMode('compound');App.setFocusCompoundKey('MSI_A');
            await App.setOtsuBgRemove(false);await App._flushSave();
            return id;
        });
        const groups=await page.evaluate(()=>App.project.sections[0].meta.spatialGroups.groups.map(group=>group.members.length).sort());
        assert.deepEqual(groups,[1,3],'real registration groups matching coordinates despite a whole missing-signal column');
        const missing=await page.evaluate(()=>{
            const section=App.project.sections[0],geometry=App.panels.get(section.id).msiValueRasters.get('MSI_MISSING').sourceGeometry;
            return {current:geometry.currentConfirmed,legacy:geometry.legacy.confirmed,reason:geometry.legacy.reason};
        });
        assert.equal(missing.current,true);assert.equal(missing.legacy,false);assert.equal(missing.reason,'legacy-render-quant-axis-mismatch');
        await page.evaluate(()=>{window.__alignmentDone=false;Wizards.openAlignmentModal(App.panels.get(App.project.sections[0].id)).then(()=>window.__alignmentDone=true);});
        await page.locator('.msi-align-details summary').click();
        await page.locator('[data-scale-num]').waitFor();
        await page.waitForFunction(()=>!document.querySelector('[data-save]').disabled);
        assert.match(await page.locator('[data-align-source]').inputValue(),/^__group__\|/);
        assert.match(await page.locator('[data-align-source] option:checked').innerText(),/3 件/);
        await page.locator('[data-scale-num]').fill('125');await page.locator('[data-scale-num]').dispatchEvent('input');
        await page.screenshot({path:path.resolve(root,'..','spatial-alignment.png'),fullPage:true});
        await page.locator('[data-save]').click();await page.waitForFunction(()=>window.__alignmentDone);
        const transforms=await page.evaluate(()=>{
            const panel=App.panels.get(App.project.sections[0].id);
            return ['MSI_A','MSI_B','MSI_SHIFTED','MSI_MISSING'].map(key=>panel._resolveTHeToMsi('HE_STAIN',key));
        });
        assert.deepEqual(transforms[0],transforms[1]);assert.equal(transforms[0][0][0],1.25);assert.equal(transforms[2],null);
        assert.deepEqual(transforms[0],transforms[3],'verified current map receives new HE group alignment despite legacy missing-axis uncertainty');

        // Real drawing lifecycle, with deterministic polygon vertices in native
        // measurement-centre coordinates (the pointer projection has its own suite).
        await page.locator('#roi-create-scope').selectOption('group');
        await page.evaluate(async()=>{
            await App.startDrawing();
            if(!App.drawing.mode)throw new Error('ROI drawing did not start');
            App.drawing.vertices=[[-.5,-.5],[3.5,-.5],[3.5,3.5],[-.5,3.5]];
            await App.finalizeDrawing();await App._flushSave();
        });
        const common=await page.evaluate(async()=>{
            const section=App.project.sections[0],panel=App.panels.get(section.id),roi=App.project.rois[0],poly=roi.polysBySection[section.id];
            const results=[];
            for(const key of ['MSI_A','MSI_B','MSI_SHIFTED']) {
                App.setFocusCompoundKey(key);await panel.ensureMsiLayerLoaded(key);panel.drawAllRois();
                const values=await extractRoiRawFromSection(panel,key,poly,roi);
                results.push({outline:panel.dom.roiSaved.children.length,values:values.values,status:values.unresolvedReason||values.reason||null});
            }
            return {meta:roi.geometryBySection[section.id],results};
        });
        assert.equal(common.meta.version,'msi-group-v1');
        assert.deepEqual(common.results.map(row=>row.outline),[1,1,0]);
        assert.equal(common.results[0].values.length,16);assert.equal(common.results[1].values.length,16);
        assert.deepEqual(common.results[1].values,common.results[0].values.map(value=>value*10),'same ROI retains source-specific intensities');
        assert.ok(common.results[2].status,'shifted geometry has an explicit unresolved status');

        await page.evaluate(async()=>{App.setFocusCompoundKey('MSI_B');App.redrawAllRois();await App._flushSave();});
        for(const width of [1280,900]) {
            await page.setViewportSize({width,height:1100});
            if(width<=900)await page.locator('#m-tabbar [data-mpanel="roi"]').click();
            const controls=await page.evaluate(async()=>{
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                const panel=document.querySelector('#panel-roi').getBoundingClientRect();
                const select=document.querySelector('#roi-create-scope'),row=select.parentElement;
                return {panel:{left:panel.left,right:panel.right},rowHeight:row.getBoundingClientRect().height,
                    headerHeight:row.previousElementSibling.getBoundingClientRect().height,
                    items:[...row.children].map(element=>{const rect=element.getBoundingClientRect();
                        return {left:rect.left,right:rect.right,width:rect.width,height:rect.height};})};
            });
            assert.ok(controls.rowHeight<=70&&controls.headerHeight<=40,`ROI controls remain compact at ${width}px`);
            assert.ok(controls.items.every(item=>item.height<=50&&item.width>=60
                &&item.left>=Math.max(controls.panel.left-1,0)&&item.right<=Math.min(controls.panel.right+1,width)),`ROI controls stay readable inside their panel at ${width}px`);
            await page.screenshot({path:path.resolve(root,'..',`spatial-roi-${width}.png`),fullPage:true});
        }
        await page.setViewportSize({width:1600,height:1100});
        await page.screenshot({path:path.resolve(root,'..','spatial-roi.png'),fullPage:true});
        await page.reload();
        await page.waitForFunction(id=>typeof App!=='undefined'&&App.project?.id===id&&App.panels.size===1,projectId);
        const restored=await page.evaluate(async()=>{
            const section=App.project.sections[0],panel=App.panels.get(section.id),roi=App.project.rois[0];
            for(const key of ['MSI_A','MSI_B','MSI_SHIFTED'])await panel.ensureMsiLayerLoaded(key);
            App.setActiveSection(section.id);App.setViewMode('compound');App.setFocusCompoundKey('MSI_B');panel.drawAllRois();
            return {roi:roi.geometryBySection[section.id].version,outline:panel.dom.roiSaved.children.length,
                a:panel._resolveTHeToMsi('HE_STAIN','MSI_A'),b:panel._resolveTHeToMsi('HE_STAIN','MSI_B')};
        });
        assert.equal(restored.roi,'msi-group-v1');assert.equal(restored.outline,1);assert.deepEqual(restored.a,restored.b);
        await page.locator('#roi-create-scope').selectOption('source');
        await page.evaluate(async()=>{
            App.setFocusCompoundKey('MSI_A');await App.startDrawing();
            App.drawing.vertices=[[4.5,4.5],[7.5,4.5],[7.5,7.5],[4.5,7.5]];
            await App.finalizeDrawing();await App._flushSave();
        });
        const individual=await page.evaluate(()=>{
            const section=App.project.sections[0],panel=App.panels.get(section.id),roi=App.project.rois.at(-1);
            const visible=[];for(const key of ['MSI_A','MSI_B']){App.setFocusCompoundKey(key);panel.drawAllRois();visible.push(panel.dom.roiSaved.children.length);}
            return {version:roi.geometryBySection[section.id].version,visible};
        });
        assert.equal(individual.version,'msi-source-v1');assert.deepEqual(individual.visible,[2,1]);
        assert.deepEqual(writes,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
        console.log('MSI spatial browser: real registration, HE group save, shared/source ROI, distinct quantification, shifted-grid exclusion and reload PASS');
        await context.close();
    } finally {
        if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
