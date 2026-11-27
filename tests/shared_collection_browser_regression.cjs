'use strict';
// Real recipient folder UI, HTTP source downloads and ZIPs on an isolated origin.
const assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises');
const path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),JSZip=require('../vendor/jszip.min.js');
const {collaborationFixture,sources}=require('./shared_collection_regression.cjs');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'viewer/index.html'),'utf8');
function fn(name){let start=html.indexOf('function '+name+'(');assert.ok(start>=0,name);if(html.slice(start-6,start)==='async ')start-=6;return html.slice(start,html.indexOf('\n}',start)+2);}
const code=html.match(/^const SECTION_ALIGN_(?:WC|META)_KEYS = .*;$/gm).join('\n')+'\n'+[
    'msiSourceReference','alignmentImageIdentity','freezeMsiSourceReferences','decodeRoiPolygon',
    'captureSectionAlignment','applySectionAlignment','_overlayFromRow',
    'groupRoiRowsByColor','roiMediaRegistryFromDoc','ratioRegistryFromDoc','renderFolderIndex'].map(fn).join('\n');
async function setup() {
    const f=collaborationFixture(),index={name:'Matsuoka',children:[{type:'project',slug:'public',displayName:'Public project'},
        {type:'folder',name:'Nested',children:[{type:'project',slug:'private',displayName:'Private project'},
            {type:'project',slug:'public',displayName:'Public project'},{type:'project',slug:'missing',displayName:'Missing project'}]}]};
    const documents={},shared={};
    for(const slug of ['public','private','missing']) {
        const doc=JSON.parse(JSON.stringify(f.doc));doc.id='project-'+slug;doc.meta.project_slug=slug;doc.meta.display_name=slug+' project';
        for(const section of doc.sections)for(const collection of Object.values(section.storage_paths))for(const entry of Object.values(collection))entry.path=entry.path.replace(/^p\//,slug+'/');
        for(const item of doc.meta.project_meta.roiMedia.items)item.storagePath=item.storagePath.replace(/^p\//,slug+'/');
        documents[slug]=doc;
        shared[slug]=JSON.parse(JSON.stringify(f.collaboration));
        for(const rows of Object.values(shared[slug]))for(const row of rows){row.project_id=doc.id;if(row.storage_path)row.storage_path=row.storage_path.replace(/^p\//,slug+'/');}
    }
    const data={index,documents,shared,rois:[{id:'roi',section_id:'server',color_key:'ROI_1',name:'ROI',
        poly_msi:{version:'msi-roi-polygon-v1',vertices:f.rois[0].polysBySection.server,geometry:f.rois[0].geometryBySection.server}}]};
    const assets=['app-i18n.js','app-i18n-common.js','app-i18n-viewer.js','app-i18n-viewer-modules.js','viewer/source-loader.js',
        'viewer/share-refresh.js','viewer/msi-ratio-model.js','viewer/alignment-transform.js','viewer/roi-media-model.js',
        'viewer/project-archive.js','viewer/shared-collection.js','viewer/shared-collection-app.js'];
    const page='<!doctype html><meta charset="utf-8"><style>.btn{padding:6px 10px;border:1px solid #cbd5e1;border-radius:5px;background:white;cursor:pointer}.btn:disabled{opacity:.4}</style>'
        +assets.map(asset=>'<script src="/'+asset+'"></script>').join('')+'<body><script>\n'
        +'const data='+JSON.stringify(data)+';\nconst DEFAULT_ANATOMY_PALETTE={};const ensureMemoShape=value=>value||{};\n'
        +'window.calls=[];window.writes=[];window.roiReads=0;window.mutateRois=false;window.sharedReads={};window.mutateShared="";window.failShared="";window.visibleProject={id:"untouched",range:{min:10,max:20},ratio:"personal"};\n'
        +'async function sharedPage(kind,token,options){calls.push(["shared",kind,token]);if(failShared===kind)throw new Error("shared API unavailable");const slug=token.replace(/-token$/,""),rows=JSON.parse(JSON.stringify(data.shared[slug][kind]));const key=token+kind;sharedReads[key]=(sharedReads[key]||0)+1;if(sharedReads[key]>1&&mutateShared===kind)rows[0].updated_at="changed";return {rows:rows.slice(options.offset,options.offset+options.limit),count:rows.length};}\n'
        +'const SupabaseClient={\n'
        +'getFolderIndex:async()=>({name:"Matsuoka",index_doc:data.index}),\n'
        +'unlockPublicProject:async(slug,options)=>{calls.push(["public",slug]);if(slug==="private")throw {code:"28P02",message:"not_public"};return {token:slug+"-token",role:"viewer",expires_at:new Date(Date.now()+3600000).toISOString()};},\n'
        +'unlockProject:async(slug,password,options)=>{calls.push(["password",slug]);if(password!=="correct")throw {code:"28P01",message:"invalid credentials"};return {token:slug+"-token",role:"viewer",expires_at:new Date(Date.now()+3600000).toISOString()};},\n'
        +'fetchProjectDoc:async(token,options)=>{const slug=token.replace(/-token$/,"");calls.push(["doc",slug]);return JSON.parse(JSON.stringify(data.documents[slug]));},\n'
        +'listRoisPage:async(token,id,options)=>{calls.push(["rois",token,id]);const rows=JSON.parse(JSON.stringify(data.rois));if(++roiReads>1&&mutateRois)rows[0].version=2;return {rows:rows.slice(options.offset,options.offset+options.limit),count:rows.length};},\n'
        +'listShareImagesPage:(token,options)=>sharedPage("images",token,options),listShareAlignmentsPage:(token,options)=>sharedPage("alignments",token,options),listShareOverlaysPage:(token,options)=>sharedPage("overlays",token,options),\n'
        +'publicUrl:(bucket,path)=>location.origin+"/source/"+path};\n'
        +code+'\nrenderFolderIndex("folder");</script>';
    const bytes={};for(const [key,blob] of Object.entries(sources))bytes[key]=Buffer.from(await blob.arrayBuffer());
    const state={missing:true,missingShared:false,delay:false,requests:[],aborts:0};
    const server=http.createServer((req,res)=>{
        const url=new URL(req.url,'http://localhost');
        if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
        const asset=url.pathname.slice(1);
        if(assets.includes(asset)){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(root,asset)));return;}
        if(url.pathname.startsWith('/source/')) {
            const sourcePath=decodeURI(url.pathname.slice('/source/'.length));state.requests.push(sourcePath);
            if(sourcePath.startsWith('missing/')&&state.missing){res.writeHead(404);res.end();return;}
            if(sourcePath.endsWith('/shared-he.png')&&state.missingShared){res.writeHead(404);res.end();return;}
            const buffer=bytes[sourcePath.replace(/^[^/]+\//,'p/')];
            if(!buffer){res.writeHead(404);res.end();return;}
            if(state.delay) {req.on('close',()=>{state.aborts++;});return;}
            res.setHeader('Content-Length',buffer.length);res.end(buffer);return;
        }
        res.writeHead(404);res.end();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return {state,origin:'http://127.0.0.1:'+server.address().port,
        close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
async function concurrentDiskSaves(browser,origin,errors) {
    // Native OPFS handles exercise the same getFileHandle/createWritable API
    // as a selected disk folder. Synchronize two tabs after their absence
    // checks, immediately before the non-exclusive create:true operation.
    const context=await browser.newContext({viewport:{width:1100,height:1000}});
    let arrivals=0,release;
    const gate=new Promise(resolve=>{release=resolve;});
    await context.exposeFunction('collectionCreateBarrier',async()=>{if(++arrivals===2)release();await gate;});
    try {
        const pages=await Promise.all([context.newPage(),context.newPage()]);
        for(const [index,page] of pages.entries()) {
            page.on('pageerror',error=>errors.push(error.message));
            await page.addInitScript(()=>{window.showDirectoryPicker=async()=>{
                const directory=await (await navigator.storage.getDirectory()).getDirectoryHandle('concurrent-zip',{create:true});
                return {async getFileHandle(name,options){
                    if(options?.create)await window.collectionCreateBarrier();
                    return directory.getFileHandle(name,options);
                },removeEntry:name=>directory.removeEntry(name)};
            };});
            await page.goto(origin);await page.locator('[data-collection-action="selected"]').waitFor();
            await page.locator('input[data-collection-project="private"]').uncheck();
            await page.locator('input[data-collection-project="missing"]').uncheck();
            await page.evaluate(index=>{
                AppI18n.setLocale('en');data.documents.public.meta.project_meta.memo.freeNote='concurrent-'+index;
                const original=SharedCollection.run;
                SharedCollection.run=(entries,options)=>original(entries,{...options,date:new Date('2026-11-27T00:00:00Z')});
            },index);
        }
        await Promise.all(pages.map(page=>page.getByRole('button',{name:'Save ZIPs to a folder',exact:true}).click()));
        await Promise.all(pages.map(page=>page.waitForFunction(()=>/1 of 1 projects ready to save; 0 unsuccessful/.test(document.querySelector('[data-collection-status]').textContent))));
        assert.equal(arrivals,2);
        const files=await pages[0].evaluate(async()=>{
            const directory=await (await navigator.storage.getDirectory()).getDirectoryHandle('concurrent-zip'),files=[];
            for await(const [name,handle] of directory.entries())files.push({name,bytes:[...new Uint8Array(await (await handle.getFile()).arrayBuffer())]});
            return files;
        });
        assert.equal(files.length,2,'concurrent runs retain two different native files');
        const notes=[],ids=[];
        for(const file of files) {
            const outer=await JSZip.loadAsync(Uint8Array.from(file.bytes),{checkCRC32:true});
            const manifest=JSON.parse(await outer.file('manifest.json').async('string'));
            assert.match(manifest.runId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            assert.ok(file.name.includes(manifest.runId));assert.equal(manifest.filename,file.name);
            assert.equal(manifest.results[0].part,file.name);ids.push(manifest.runId);
            const inner=await JSZip.loadAsync(await outer.file(manifest.results[0].archivePath).async('uint8array'),{checkCRC32:true});
            const name=Object.keys(inner.files).find(name=>/^[^/]+\.json$/.test(name));
            notes.push(JSON.parse(await inner.file(name).async('string')).memo.freeNote);
        }
        assert.equal(new Set(ids).size,2);assert.deepEqual(notes.sort(),['concurrent-0','concurrent-1']);

        // A writer outside this run can replace the named file before opening
        // our stream fails. Failure cleanup must not remove that other content.
        const failed=await context.newPage();failed.on('pageerror',error=>errors.push(error.message));
        await failed.addInitScript(()=>{window.removeCalls=0;window.showDirectoryPicker=async()=>{
            const directory=await (await navigator.storage.getDirectory()).getDirectoryHandle('failed-save',{create:true});
            return {async getFileHandle(name,options){
                const file=await directory.getFileHandle(name,options);if(!options?.create)return file;
                window.failedFilename=name;
                return {async createWritable(){const other=await file.createWritable();await other.write('external-sentinel');await other.close();throw new Error('simulated open failure');}};
            },async removeEntry(name){removeCalls++;await directory.removeEntry(name);}};
        };});
        await failed.goto(origin);await failed.locator('[data-collection-action="selected"]').waitFor();
        await failed.locator('input[data-collection-project="private"]').uncheck();
        await failed.locator('input[data-collection-project="missing"]').uncheck();
        await failed.getByRole('button',{name:'Save ZIPs to a folder',exact:true}).click();
        await failed.waitForFunction(()=>/0 of 1 projects ready to save; 1 unsuccessful/.test(document.querySelector('[data-collection-status]').textContent));
        const retained=await failed.evaluate(async()=>{const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('failed-save');
            return {removeCalls,text:await (await (await dir.getFileHandle(failedFilename)).getFile()).text()};});
        assert.deepEqual(retained,{removeCalls:0,text:'external-sentinel'});
    } finally {release();await context.close();}
}
async function main() {
    const server=await setup(),browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
    const errors=[];
    try {
        const context=await browser.newContext({acceptDownloads:true,viewport:{width:1100,height:1000}}),page=await context.newPage();
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(server.origin);assert.deepEqual(errors,[]);await page.locator('[data-collection-action="all"]').waitFor();
        assert.equal(await page.locator('input[data-collection-project]').count(),4,'duplicate links remain visible');
        assert.match(await page.locator('[data-collection-controls]').innerText(),/共有プロジェクト 3 件 \/ 選択 3 件/);
        await page.locator('input[data-collection-project="public"]').first().uncheck();
        assert.equal(await page.locator('input[data-collection-project="public"]:checked').count(),0,'duplicate slug checkboxes synchronize');
        await page.locator('[data-collection-action="all"]').click();
        const password=page.locator('form[data-collection-password="private"] input');await password.waitFor();
        await password.fill('wrong');await page.locator('form[data-collection-password] button[type="submit"]').click();
        await page.getByText('閲覧用パスワードを確認してください。',{exact:true}).waitFor();
        await password.fill('correct');
        await page.evaluate(()=>AppI18n.setLocale('en'));
        assert.equal(await password.inputValue(),'correct','switching language must not discard the password input');
        const downloaded=page.waitForEvent('download');await page.locator('form[data-collection-password] button[type="submit"]').click();
        const file=await downloaded;await page.waitForFunction(()=>/2 of 3 projects ready to save; 1 unsuccessful/.test(document.querySelector('[data-collection-status]').textContent));
        const outer=await JSZip.loadAsync(await fsp.readFile(await file.path()),{checkCRC32:true});
        const manifest=JSON.parse(await outer.file('manifest.json').async('string'));
        assert.equal(manifest.results.filter(row=>row.status==='ready').length,2);assert.equal(manifest.results[2].status,'failed');
        assert.match(await page.locator('[data-collection-failures]').innerText(),/Missing project/);
        const before=await page.evaluate(()=>({project:visibleProject,writes,calls,missing:AppI18n.getMissingKeys(),conflicts:AppI18n.getConflicts()}));
        assert.deepEqual(before.project,{id:'untouched',range:{min:10,max:20},ratio:'personal'});assert.deepEqual(before.writes,[]);
        assert.equal(before.calls.filter(call=>call[0]==='password').length,2);assert.deepEqual(before.missing,[]);assert.deepEqual(before.conflicts,[]);
        assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('desi:share:private')).token),'private-token');
        assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('desi:share:public')).token),'public-token');
        const innerPaths=Object.keys(outer.files).filter(name=>/\.zip$/.test(name));assert.equal(innerPaths.length,2);
        for(const name of innerPaths) {
            const inner=await JSZip.loadAsync(await outer.file(name).async('uint8array'),{checkCRC32:true});
            const manifestName=Object.keys(inner.files).find(name=>/^[^/]+\.json$/.test(name));
            const project=JSON.parse(await inner.file(manifestName).async('string'));
            assert.equal(project.format,'desi_data_share_v3');assert.equal(project.sections[0].originalSeries.MSI_PQ.kind,'parquet');
            assert.equal(project.exportMode,'shared-saved-originals');assert.equal(project.offlineSettings.overlays.length,2);
            const section=project.sections[0],image=section.images.HE_STAIN_shared;
            assert.deepEqual(await inner.file(image.fullPath).async('uint8array'),new Uint8Array(await sources['p/shared-he.png'].arrayBuffer()));
            assert.equal(image.alignmentImageReference,JSON.stringify(['alignment-image-v1','shared-image','']));
            assert.ok(section.meta.__alignMaster.alignment.HE);assert.equal(section.meta.alignmentHeKey,'HE_STAIN_shared');
        }
        server.state.missing=false;
        const retried=page.waitForEvent('download');await page.locator('[data-collection-action="retry"]').click();await retried;
        await page.waitForFunction(()=>/1 of 1 projects ready to save; 0 unsuccessful/.test(document.querySelector('[data-collection-status]').textContent));
        assert.equal((await page.evaluate(()=>calls)).filter(call=>call[0]==='doc'&&call[1]==='public').length,
            before.calls.filter(call=>call[0]==='doc'&&call[1]==='public').length,'retry does not re-export successful projects');
        const diskPage=await context.newPage();diskPage.on('pageerror',error=>errors.push(error.message));
        await diskPage.addInitScript(()=>{
            window.diskSaves=[];window.originalDiskName=null;
            window.showDirectoryPicker=async()=>({
                async getFileHandle(name,options){
                    if(!options?.create){
                        if(!originalDiskName)originalDiskName=name;
                        if(name===originalDiskName||diskSaves.some(save=>save.name===name))return {};
                        throw Object.assign(new Error('absent'),{name:'NotFoundError'});
                    }
                    return {async createWritable(){const parts=[];return new WritableStream({
                        write(chunk){parts.push(chunk);},close(){const blob=new Blob(parts);diskSaves.push({name,size:blob.size,blob});}
                    });}};
                },async removeEntry(){}
            });
        });
        await diskPage.goto(server.origin);await diskPage.locator('[data-collection-action="selected"]').waitFor();
        await diskPage.locator('input[data-collection-project="private"]').uncheck();
        await diskPage.locator('input[data-collection-project="missing"]').uncheck();
        await diskPage.getByRole('button',{name:'Save ZIPs to a folder',exact:true}).click();
        await diskPage.waitForFunction(()=>/1 of 1 projects ready to save; 0 unsuccessful/.test(document.querySelector('[data-collection-status]').textContent));
        const saved=await diskPage.evaluate(async()=>Promise.all(diskSaves.map(async save=>({name:save.name,size:save.size,bytes:[...new Uint8Array(await save.blob.arrayBuffer())]}))));
        assert.equal(saved.length,1);assert.ok(saved[0].size>1000);assert.match(saved[0].name,/__2\.zip$/);
        const diskZip=await JSZip.loadAsync(Uint8Array.from(saved[0].bytes),{checkCRC32:true});
        const diskManifest=JSON.parse(await diskZip.file('manifest.json').async('string'));
        const diskResults=JSON.parse(await diskZip.file('download-results.json').async('string'));
        assert.equal(diskManifest.filename,saved[0].name);assert.equal(diskManifest.projects[0].part,saved[0].name);
        assert.equal(diskResults[0].part,saved[0].name);assert.equal(diskResults[0].partFilenameKind,'selected-destination-name');
        assert.equal(await diskPage.locator('[data-collection-downloads] a').count(),0,'disk parts are released without retaining download Blob URLs');
        await diskPage.getByRole('button',{name:'Save download report',exact:true}).click();
        const finalReport=await diskPage.locator('[data-collection-downloads] a[download$=".json"]').evaluate(async link=>(await fetch(link.href)).json());
        assert.equal(finalReport.parts[0].filename,saved[0].name);assert.equal(finalReport.results[0].part,saved[0].name);
        await concurrentDiskSaves(browser,server.origin,errors);
        // A viewer can edit ROI without changing publish_revision. Re-read
        // every ROI before marking the independent backup complete.
        const changedPage=await context.newPage();changedPage.on('pageerror',error=>errors.push(error.message));
        await changedPage.goto(server.origin);await changedPage.locator('[data-collection-action="selected"]').waitFor();
        await changedPage.locator('input[data-collection-project="private"]').uncheck();
        await changedPage.locator('input[data-collection-project="missing"]').uncheck();
        await changedPage.evaluate(()=>{mutateRois=true;});
        await changedPage.locator('[data-collection-action="selected"]').click();
        await changedPage.waitForFunction(()=>/0 of 1 projects ready to save; 1 unsuccessful/.test(document.querySelector('[data-collection-status]').textContent));
        assert.match(await changedPage.locator('[data-collection-failures]').innerText(),/ROI data changed during download/);
        assert.equal(await changedPage.locator('[data-collection-downloads] a').count(),0);
        // Shared edits have their own versions and do not bump publication.
        for(const kind of ['images','overlays','alignments','unavailable','missing-original']) {
            const sharedPage=await context.newPage();sharedPage.on('pageerror',error=>errors.push(error.message));
            await sharedPage.goto(server.origin);await sharedPage.locator('[data-collection-action="selected"]').waitFor();
            await sharedPage.locator('input[data-collection-project="private"]').uncheck();
            await sharedPage.locator('input[data-collection-project="missing"]').uncheck();
            await sharedPage.evaluate(kind=>{if(kind==='unavailable')failShared='images';else mutateShared=kind;},kind);
            if(kind==='missing-original')server.state.missingShared=true;
            await sharedPage.locator('[data-collection-action="selected"]').click();
            await sharedPage.waitForFunction(()=>/0 of 1 projects ready to save; 1 unsuccessful/.test(document.querySelector('[data-collection-status]').textContent));
            assert.match(await sharedPage.locator('[data-collection-failures]').innerText(),kind==='unavailable'?/shared API unavailable/
                :kind==='missing-original'?/404/:/Saved shared edits changed during download/);
            assert.equal(await sharedPage.locator('[data-collection-downloads] a').count(),0);
            server.state.missingShared=false;await sharedPage.close();
        }
        // Cancellation reaches a real stalled fetch, leaving no success ZIP.
        const cancelPage=await context.newPage();cancelPage.on('pageerror',error=>errors.push(error.message));
        await cancelPage.goto(server.origin);await cancelPage.locator('[data-collection-action="all"]').waitFor();
        server.state.delay=true;const requestCount=server.state.requests.length;
        await cancelPage.locator('[data-collection-action="all"]').click();
        await cancelPage.waitForFunction(()=>document.querySelector('[data-collection-action="cancel"]').hidden===false);
        for(let n=0;n<50&&server.state.requests.length===requestCount;n++)await new Promise(resolve=>setTimeout(resolve,20));
        assert.ok(server.state.requests.length>requestCount);
        await cancelPage.locator('[data-collection-action="cancel"]').click();
        await cancelPage.waitForFunction(()=>/0 of 3 projects ready to save; 3 unsuccessful/.test(document.querySelector('[data-collection-status]').textContent));
        assert.equal(await cancelPage.locator('[data-collection-downloads] a').count(),0);
        assert.ok(await cancelPage.locator('[data-collection-action="retry"]').isVisible());
        assert.deepEqual(errors,[]);
        console.log('Shared collection browser: PASS (nested/passwords/i18n, saved collaboration, mutation/missing-original detection, disk collision/report, concurrent native OPFS saves and safe failure, partial/retry, exact Parquet, cancellation, no project writes)');
    } finally {await browser.close();await server.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
