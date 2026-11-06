'use strict';
// Real Viewer, IndexedDB, and HTTP originals. Only cloud read methods are
// synthetic; requests outside this isolated localhost server are rejected.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const {renderOfflineConfig}=require('../offline/config.cjs');
const root=path.resolve(__dirname,'..');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=','base64');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function main(){
 let online=false,gate=null,failPath='',requests=[];
 const viewer=await fs.readFile(path.join(root,'viewer/index.html'),'utf8');
 const at=viewer.indexOf('const ProjectStorage = (() => {');
 const storage=viewer.slice(at,viewer.indexOf('\n})();',at)+6);
 const storagePage='<!doctype html><meta charset="utf-8"><script src="/project-store-safety.js"></script><script>const uid=p=>p+crypto.randomUUID(),nowIso=()=>new Date().toISOString();'+storage+';window.ready=true;</script>';
 const server=http.createServer(async(req,res)=>{try{
  const pathname=decodeURIComponent(new URL(req.url,'http://fixture').pathname);
  if(pathname==='/runtime-config.js'){
   res.setHeader('Content-Type','text/javascript');res.end(online?'window.DESI_BUILD_CONFIG='+JSON.stringify({mode:'online',cloud:{url:'http://'+req.headers.host,anonKey:'synthetic-only'}})+';':renderOfflineConfig());return;
  }
  if(pathname==='/storage-fixture'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(storagePage);return;}
  if(pathname.startsWith('/fixture/')){
   requests.push({path:pathname,method:req.method});
   if(gate&&pathname.includes(gate.needle)){const current=gate;current.hit.resolve();await current.release.promise;}
   if(failPath&&pathname.includes(failPath)){res.writeHead(503);res.end('Synthetic original unavailable');return;}
   res.setHeader('Content-Type','image/png');res.setHeader('Content-Length',png.length);res.end(png);return;
  }
  const file=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));
 }catch{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const context=await browser.newContext({viewport:{width:1920,height:1080}}),page=await context.newPage(),other=await context.newPage(),errors=[],external=[],dialogs=[];
  await context.route('**/*',route=>{if(route.request().url().startsWith(origin+'/')||/^(blob|data):/.test(route.request().url()))return route.continue();external.push(route.request().url());return route.abort();});
  for(const p of [page,other])p.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>{dialogs.push(dialog.message());return dialog.type()==='prompt'?dialog.dismiss():dialog.accept();});
  await other.goto(origin+'/storage-fixture');await other.waitForFunction(()=>window.ready);
  await page.goto(origin+'/viewer/?project=synthetic-refresh-seed');
  await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
  const seed=await page.evaluate(async()=>{const id=await App.createNewProject('Synthetic seed');sessionStorage.setItem('desi:masterUnlocked',JSON.stringify({expiresAt:Date.now()+3600000}));return id;});
  online=true;await page.goto(origin+'/viewer/?project='+encodeURIComponent(seed));
  await page.waitForFunction(()=>typeof App!=='undefined'&&!App.offline&&App.project&&typeof ShareRefresh!=='undefined');
  await page.evaluate(({png,origin})=>{
   sessionStorage.setItem('desi:masterPw',JSON.stringify({pw:'synthetic-only',expiresAt:Date.now()+3600000}));
   // Collaborator polling and auto publication are separate workflows. Keep
   // them from consuming controlled read barriers in this manual-refresh test.
   const realSchedule=App._scheduleAutoPublish;
   App._scheduleAutoPublish=()=>{};App._refreshMasterCollabRois=async()=>{};App._startMasterCollabPoll=()=>{};
   window.refreshFixture={doc:null,reads:0,unlocks:0,done:true,error:null,realSchedule,publishCalls:0};const f=refreshFixture;
   Object.assign(SupabaseClient,{
    configured:()=>true,unlockProjectMaster:async()=>{f.unlocks++;return {token:'synthetic-read',role:'viewer'};},
    fetchProjectDoc:async()=>{f.reads++;return structuredClone(f.doc);},
    listRois:async(_token,section)=>{if(f.roiFailure)throw new Error('Synthetic ROI read failed');return structuredClone((f.rois||[]).filter(row=>row.section_id===section));},
    publicUrl:(_bucket,p)=>origin+'/fixture/'+p,
    listShareOverlays:async()=>[],listShareAlignments:async()=>[],listShareImages:async()=>[],
    requestPublishSessionV2:async()=>{f.publishCalls++;throw new Error('Unexpected publication after download');},
    getPublishStateV2:async()=>{f.publishCalls++;throw new Error('Unexpected publication after download');},
    publishProjectDocV2:async()=>{f.publishCalls++;throw new Error('Unexpected publication after download');},
   });
   const refresh=App.refreshFromShare;
   App.refreshFromShare=function(...args){f.done=false;f.error=null;return refresh.apply(this,args).catch(e=>{f.error=e.message;throw e;}).finally(()=>{f.done=true;});};
   const replace=ProjectStorage.replaceProjectFromServer;
   ProjectStorage.replaceProjectFromServer=async(...args)=>{
    f.cancelDisabledAtCommit=document.querySelector('[data-progress-cancel]')?.disabled;
    if(f.editDuringCommit){
     const guard=args[2].assertCurrent;let checks=0;
     args[2].assertCurrent=()=>{if(++checks===2){App.project.memo.freeNote='Edit during replacement transaction';App.queueSave(60000);}return guard();};
    }
    return replace(...args);
   };
   f.prepare=async(name,dirty=false)=>{
    await App.createNewProject('Synthetic local '+name);const project=App.project,slug='synthetic-'+name;
    const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));project.sections=[];
    project.shareInfo={slug,url:origin+'/viewer/index.html#share='+slug,isPublic:true,serverRevision:1,blobPaths:{}};
    for(let i=0;i<2;i++){
     const id=slug+'-original-'+i,storagePath=slug+'/publish-v2/one/section-'+i+'.png';
     await ProjectStorage.putBlob({id,blob:new Blob([bytes],{type:'image/png'}),mime:'image/png'});
     project.shareInfo.blobPaths[id]={path:storagePath,mime:'image/png',size:bytes.length};
     project.sections.push({id:slug+'-section-'+i,ordinal:i+1,displayName:'Synthetic section '+(i+1),meta:{},
      images:{HE:{blobId:id,mime:'image/png',filename:'original.png',storagePath}},msiSeries:{},msiFiles:{}});
    }
    project.memo.freeNote='Protected local note '+name;project.rois=[];
    App.queueSave(60000);await App.rebuildSectionPanels();await App._flushSave();
    if(!dirty)delete project.__publishPending;
    await ProjectStorage.putProject(project);App.refreshShareInfoButton();
    f.doc={id:'remote-'+slug,slug,is_public:true,publish_revision:2,updated_at:'2026-11-06T00:00:00Z',
     meta:{display_name:'Synthetic remote '+name,project_meta:{memo:{freeNote:'Remote note '+name},smoothing:{mode:'median',level:4}}},anatomy_palette:{},
     sections:Array.from({length:6},(_,i)=>({id:'server-'+slug+'-'+i,ordinal:i+1,display_name:'Synthetic section '+(i+1),meta:{client_id:slug+'-section-'+i},
      storage_paths:{images:{HE:{path:slug+'/publish-v2/'+(i<2?'one':'two')+'/section-'+i+'.png',mime:'image/png',filename:'original.png'}},msiSeries:{},msiFiles:{}}}))};
    f.rois=f.doc.sections.flatMap(section=>[
     {id:'owned-'+section.id,section_id:section.id,created_by:'master',color_key:'default',name:'Synthetic owned ROI',poly_msi:[[0,0],[0.7,0],[0,0.7]],version:1},
     {id:'collaborator-'+section.id,section_id:section.id,created_by:'viewer',color_key:'default',name:'Synthetic collaborator ROI',poly_msi:[[0.1,0.1],[0.2,0.1],[0.1,0.2]],version:1},
    ]);
    f.id=project.id;f.slug=slug;f.reads=0;f.done=true;f.error=null;f.roiFailure=false;f.editDuringCommit=false;f.cancelDisabledAtCommit=null;
    return {id:project.id,project:await ProjectStorage.getProject(project.id),ids:(await ProjectStorage.listProjects()).map(p=>p.id)};
   };
   f.snapshot=async()=>({active:App.project.id,project:await ProjectStorage.getProject(f.id),projects:await ProjectStorage.listProjects(),
    contextRefreshing:_publishContext({id:f.id},f.slug).refreshing,operation:!!App._shareRefreshOperation,error:f.error});
   f.rows=async()=>{const db=await ProjectStorage.open();return new Promise((resolve,reject)=>{const tx=db.transaction(['blobs','blob_pins'],'readonly'),out={};
    for(const name of ['blobs','blob_pins']){const r=tx.objectStore(name).getAll();r.onsuccess=()=>out[name]=r.result.map(row=>({id:row.id,kind:row.kind}));}
    tx.oncomplete=()=>resolve(out);tx.onerror=()=>reject(tx.error);});};
  },{png:png.toString('base64'),origin});
  async function prepare(name,dirty=false){failPath='';gate=null;requests=[];return page.evaluate(({name,dirty})=>refreshFixture.prepare(name,dirty),{name,dirty});}
  async function compare(){await page.locator('#btn-refresh-share').click();await page.locator('[data-refresh-copy]').waitFor({state:'visible'});}
  async function complete(){await page.waitForFunction(()=>refreshFixture.done,{},{timeout:15000});const value=await page.evaluate(()=>refreshFixture.snapshot());assert.equal(value.error,null);assert.equal(value.operation,false);assert.equal(value.contextRefreshing,false);assert.equal(await page.locator('#btn-refresh-share').isEnabled(),true);return value;}
  async function unchanged(before){const result=await complete();assert.deepEqual(result.project,before.project);assert.deepEqual(result.projects.map(p=>p.id).sort(),before.ids.sort());assert.equal(result.active,before.id);return result;}
  function hold(name){gate={needle:'synthetic-'+name+'/publish-v2/two/section-2.png',hit:deferred(),release:deferred()};return gate;}
  async function noImportLeases(){const rows=await page.evaluate(()=>refreshFixture.rows());assert.equal(rows.blob_pins.some(row=>row.kind==='cloud-import'),false);return rows;}

  const before=await prepare('success');await page.evaluate(()=>{App._scheduleAutoPublish=refreshFixture.realSchedule;});await compare();
  const countRow=page.locator('#modal-host tr').filter({has:page.locator('th',{hasText:'切片数'})});assert.deepEqual(await countRow.locator('td').allTextContents(),['2','6']);
  if(process.env.SHARE_REFRESH_SCREENSHOT_DIR){await fs.mkdir(process.env.SHARE_REFRESH_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.SHARE_REFRESH_SCREENSHOT_DIR,'cloud-refresh-compare.png'),fullPage:true});}
  await page.locator('#modal-host [data-modal-ok]').click();const updated=await complete();
  assert.equal(updated.active,before.id);assert.equal(updated.project.id,before.id);assert.equal(updated.project.sections.length,6);assert.equal(updated.project.shareInfo.serverRevision,2);
  assert.equal(await page.evaluate(()=>refreshFixture.cancelDisabledAtCommit),true,'cancellation stops before the atomic save begins');
  const backupId=updated.projects.find(p=>!before.ids.includes(p.id)).id;
  const backup=await page.evaluate(id=>ProjectStorage.getProject(id),backupId);
  assert.deepEqual(backup.sections,before.project.sections);assert.equal(backup.memo.freeNote,before.project.memo.freeNote);assert.equal(backup.shareInfo,undefined);
  assert.equal(updated.project.sections[0].images.HE.blobId,before.project.sections[0].images.HE.blobId,'unchanged immutable original is reused');
  assert.equal(updated.project.rois.length,1);assert.equal(updated.project.rois[0].name,'Synthetic owned ROI');
  assert.ok(Object.values(updated.project.rois[0].serverIdsBySection).every(row=>row.id.startsWith('owned-')),'collaborator rows never become persistent owned ROIs');
  assert.deepEqual(updated.project.rois[0].polysBySection[updated.project.sections[0].id],[[0,0],[0.7,0],[0,0.7]]);
  assert.equal(requests.filter(r=>r.path.includes('/publish-v2/two/')).length,4);assert.equal(requests.some(r=>r.path.includes('/publish-v2/one/')),false);
  assert.equal(await page.evaluate(()=>App.panels.size),6);await noImportLeases();
  const clean=await page.evaluate(async()=>{await App._flushSave();App._scheduleAutoPublish();const p=await ProjectStorage.getProject(refreshFixture.id),ctx=_publishContext(App.project);
   App._scheduleAutoPublish=()=>{};return {pending:!!App.project.__publishPending,storedPending:!!p.__publishPending,state:App._syncState,revision:p.shareInfo.serverRevision,timer:ctx.timer,publishes:refreshFixture.publishCalls};});
  assert.deepEqual(clean,{pending:false,storedPending:false,state:'synced',revision:2,timer:0,publishes:0},'read-only hydration must not republish the downloaded project');
  if(process.env.SHARE_REFRESH_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SHARE_REFRESH_SCREENSHOT_DIR,'cloud-refresh-complete.png'),fullPage:true});
  const header=await page.evaluate(()=>({width:innerWidth,controls:[...document.querySelector('body > div > header').querySelectorAll('button,select,input,#sync-status,#app-title')]
   .map(el=>{const r=el.getBoundingClientRect();return {id:el.id||el.dataset.mode||el.textContent.trim(),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}).filter(r=>r.width>0&&r.height>0)}));
  for(const control of header.controls)assert.ok(control.x>=0&&control.right<=header.width,'header control stays in viewport: '+JSON.stringify(control));
  for(let i=0;i<header.controls.length;i++)for(let j=i+1;j<header.controls.length;j++){
   const a=header.controls[i],b=header.controls[j],width=Math.min(a.right,b.right)-Math.max(a.x,b.x),height=Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y);
   assert.ok(width<=1||height<=1,'header controls must not overlap: '+JSON.stringify([a,b]));
  }
  // Keep the hydration marker set while dispatching a real user click: only
  // the explicit initial-layer calls may use derived saves, never all edits.
  const priorEpoch=await page.evaluate(()=>{App._hydratingServerProjectId=App.project.id;return App.project.publishEditEpoch||0;});
  await page.locator('.layer-chip[title="HE"]').first().click({modifiers:['Shift'],position:{x:20,y:10}});
  const userEdit=await page.evaluate(async()=>{await App._flushSave();const p=await ProjectStorage.getProject(refreshFixture.id);App._hydratingServerProjectId=null;
   return {pending:!!p.__publishPending,epoch:p.publishEditEpoch,visible:p.sections[0].meta.visibleLayers,state:App._syncState};});
  assert.equal(userEdit.pending,true);assert.ok(userEdit.epoch>priorEpoch);assert.equal(userEdit.visible.includes('HE'),false);assert.equal(userEdit.state,'local-saved');

  const failed=await prepare('missing'),beforeFailureRows=await noImportLeases();failPath='synthetic-missing/publish-v2/two/section-3.png';await compare();await page.locator('#modal-host [data-modal-ok]').click();await unchanged(failed);
  assert.match(dialogs.at(-1),/HTTP 503/);const failedRows=await noImportLeases();assert.deepEqual(failedRows.blobs,beforeFailureRows.blobs,'failed download adds no surviving originals');

  const roiFailed=await prepare('roi-failure');await page.evaluate(()=>{refreshFixture.roiFailure=true;});await compare();await page.locator('#modal-host [data-modal-ok]').click();await unchanged(roiFailed);assert.match(dialogs.at(-1),/Synthetic ROI read failed/);await noImportLeases();

  const parquetFailed=await prepare('parquet-missing');failPath='synthetic-parquet-missing/missing.parquet';
  await page.evaluate(()=>{refreshFixture.doc.sections[0].storage_paths.msiFiles.raw={kind:'parquet',filename:'Synthetic missing.parquet',path:refreshFixture.slug+'/missing.parquet'};});
  await compare();await page.locator('#modal-host [data-modal-ok]').click();await unchanged(parquetFailed);assert.match(dialogs.at(-1),/HTTP 503/);assert.ok(requests.some(r=>r.method==='HEAD'&&r.path.includes('missing.parquet')));await noImportLeases();

  const dirty=await prepare('dirty',true);await compare();assert.equal(await page.locator('#modal-host [data-modal-ok]').isDisabled(),true);assert.equal(await page.locator('[data-refresh-copy]').isEnabled(),true);
  await page.locator('[data-refresh-copy]').click();const copied=await complete();
  assert.deepEqual(copied.project,dirty.project);assert.notEqual(copied.active,dirty.id);
  const copy=await page.evaluate(id=>ProjectStorage.getProject(id),copied.active);assert.equal(copy.sections.length,6);assert.equal(copy.shareInfo.serverRevision,2);assert.equal(copied.projects.length,dirty.ids.length+1);await noImportLeases();

  const raced=await prepare('cas'),raceGate=hold('cas');await compare();await page.locator('#modal-host [data-modal-ok]').click();await raceGate.hit.promise;
  const edited=await other.evaluate(async id=>{const p=await ProjectStorage.getProject(id);p.memo.freeNote='Edit committed by another tab';p.__publishPending=true;await ProjectStorage.putProject(p);return ProjectStorage.getProject(id);},raced.id);
  raceGate.release.resolve();const refused=await complete();assert.deepEqual(refused.project,edited);assert.deepEqual(refused.projects.map(p=>p.id).sort(),raced.ids.sort());assert.equal(refused.project.sections.length,2);assert.match(dialogs.at(-1),/別のタブ|更新/);await noImportLeases();
  // Resolve the stale in-memory project through the application's normal open
  // before beginning the next independent scenario.
  await page.evaluate(()=>App.openProject(refreshFixture.id));

  const lateEdit=await prepare('late-edit');await page.evaluate(()=>{refreshFixture.editDuringCommit=true;});await compare();await page.locator('#modal-host [data-modal-ok]').click();await unchanged(lateEdit);
  assert.equal(await page.evaluate(()=>App.project.memo.freeNote),'Edit during replacement transaction');assert.equal(await page.evaluate(()=>App.project.__publishPending),true);
  assert.match(dialogs.at(-1),/このPCの内容が変わりました/);await noImportLeases();await page.evaluate(()=>App._flushSave());

  const moved=await prepare('remote-moved'),moveGate=hold('remote-moved');await compare();await page.locator('#modal-host [data-modal-ok]').click();await moveGate.hit.promise;
  await page.evaluate(()=>{refreshFixture.doc.publish_revision=3;});moveGate.release.resolve();await unchanged(moved);assert.match(dialogs.at(-1),/取得中に共有版が更新/);await noImportLeases();

  const cancelled=await prepare('cancel'),cancelGate=hold('cancel');await compare();await page.locator('#modal-host [data-modal-ok]').click();await cancelGate.hit.promise;
  await page.mouse.click(10,300);assert.equal(await page.locator('[data-progress-cancel]').isVisible(),true);assert.equal(await page.evaluate(()=>refreshFixture.done),false,'backdrop cannot hide an active download');
  await page.locator('[data-progress-cancel]').click();await unchanged(cancelled);cancelGate.release.resolve();await noImportLeases();

  const closed=await prepare('close');await compare();await page.locator('#modal-host [data-modal-cancel]').click();await unchanged(closed);assert.equal(requests.length,0);

  const deadlines=await page.evaluate(async()=>{
   let timedSignal,abortSignal;const controller=new AbortController();
   const timeout=await ShareRefresh.withDeadline(signal=>{timedSignal=signal;return new Promise(()=>{});},{timeoutMs:15}).catch(e=>e.code);
   const pending=ShareRefresh.withDeadline(signal=>{abortSignal=signal;return new Promise(()=>{});},{signal:controller.signal,timeoutMs:1000});
   await Promise.resolve();controller.abort();const cancelled=await pending.catch(e=>e.code);
   const complete=await ShareRefresh.withDeadline(()=>Promise.resolve('completed'),{timeoutMs:1000});
   return {timeout,timedAborted:timedSignal.aborted,cancelled,abortAborted:abortSignal.aborted,complete};
  });
  assert.deepEqual(deadlines,{timeout:'SHARE_REFRESH_TIMEOUT',timedAborted:true,cancelled:'SHARE_REFRESH_CANCELLED',abortAborted:true,complete:'completed'});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Share refresh browser regression: PASS (2 to 6 sections, same ID, independent backup, owned/collaborator ROI boundary, no hydration republish, real user edits stay pending, immutable original reuse, missing image/parquet/ROI rollback, dirty copy, two-tab CAS, late edit guard, moving remote revision, progress backdrop, cancellation, deadlines)');
 }finally{gate?.release.resolve();await browser?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
