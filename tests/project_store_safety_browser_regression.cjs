'use strict';
// Real IndexedDB, separate tabs, production manager/viewer storage wrappers.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const moduleCode=fs.readFileSync(path.join(root,'project-store-safety.js'),'utf8');
function wrapper(file){const html=fs.readFileSync(path.join(root,file),'utf8'),start=html.indexOf('const ProjectStorage = (() => {');return html.slice(start,html.indexOf('\n})();',start)+6);}
const harness=kind=>`<!doctype html><meta charset="utf-8"><body><script src="/safety.js"></script><script>
const uid=prefix=>prefix+'_'+crypto.randomUUID();
${wrapper(kind==='manager'?'index.html':'viewer/index.html')}
window.storage=ProjectStorage;
window.recoveryUi=ProjectStoreSafety.mountRecoveryUi(storage);
window.addEventListener('project-storage-conflict',()=>recoveryUi.notify());
</script>`;

async function openRecovery(page) {
 await page.locator('#local-recovery-button').waitFor({state:'visible'});
 await page.locator('#local-recovery-button').click();
 await page.locator('#local-recovery-dialog').waitFor({state:'visible'});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('input[name="recovery-enabled"]')).some(input=>!input.disabled));
}
async function closeRecovery(page) {
 await page.locator('#local-recovery-dialog').getByRole('button',{name:'閉じる',exact:true}).click();
}
async function setRecoveryThroughUi(page,enabled) {
 await openRecovery(page);
 await page.getByRole('radio',{name:enabled?'自動作成する':'自動作成しない',exact:true}).check();
 await page.waitForFunction(async value=>(await storage.getRecoveryEnabled())===value,enabled);
 await page.waitForFunction(value=>document.querySelector('input[name="recovery-enabled"][value="'+value+'"]:checked:not(:disabled)'),String(enabled));
 assert.equal(await page.getByRole('radio',{name:enabled?'自動作成する':'自動作成しない',exact:true}).isChecked(),true);
 await closeRecovery(page);
}
async function pinRows(page,projectId) {
 return page.evaluate(async id=>{
  const db=await storage.open();
  return new Promise((resolve,reject)=>{const request=db.transaction('blob_pins','readonly').objectStore('blob_pins').getAll();
   request.onsuccess=()=>resolve(request.result.filter(row=>row.kind==='editing-session'&&row.projectId===id));request.onerror=()=>reject(request.error);});
 },projectId);
}
async function storageDiagnostics(page) {
 return page.evaluate(async()=>{
  const db=await storage.open(),names=['projects','project_recovery','blob_pins','archive_jobs'];
  const references=await new Promise((resolve,reject)=>{
   const tx=db.transaction(names,'readonly'),rows={};
   for(const name of names){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{rows[name]=r.result;};}
   tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error);
  });
  return {references,locks:await navigator.locks.query()};
 });
}

async function optionalRecoveryScenario(browser,origin,errors) {
 const context=await browser.newContext();
 context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
 try {
  const manager=await context.newPage(),viewer=await context.newPage();
  await manager.goto(origin+'/manager');await viewer.goto(origin+'/viewer');
  assert.equal(await manager.evaluate(()=>storage.getRecoveryEnabled()),true);
  await openRecovery(manager);
  assert.equal(await manager.getByRole('radio',{name:'自動作成する',exact:true}).isChecked(),true);
  assert.deepEqual(await manager.evaluate(()=>storage.listRecoveries()),[],'The settings entry remains available with no drafts');
  assert.match(await manager.locator('#local-recovery-button').textContent(),/\(0\)/);
  if(process.env.RECOVERY_SETTINGS_SCREENSHOT){await manager.setViewportSize({width:1366,height:900});await manager.screenshot({path:process.env.RECOVERY_SETTINGS_SCREENSHOT});}
  if(process.env.RECOVERY_SETTINGS_MOBILE_SCREENSHOT){await manager.setViewportSize({width:375,height:812});await manager.screenshot({path:process.env.RECOVERY_SETTINGS_MOBILE_SCREENSHOT});await manager.setViewportSize({width:1366,height:900});}
  // A failed preference write must display the persisted value, not an
  // optimistic OFF selection that would misrepresent the next conflict save.
  await manager.evaluate(()=>{window.savedSetRecoveryEnabled=storage.setRecoveryEnabled;storage.setRecoveryEnabled=async()=>{throw new DOMException('Synthetic quota failure','QuotaExceededError');};});
  // The failed write may restore ON before Playwright verifies a check() action.
  // Click initiates the attempted change; the assertions below require rollback.
  await manager.getByRole('radio',{name:'自動作成しない',exact:true}).click();
  await manager.waitForFunction(()=>document.querySelector('input[name="recovery-enabled"][value="true"]:checked:not(:disabled)'));
  assert.match(await manager.locator('#local-recovery-dialog [role="status"]').textContent(),/設定を保存できませんでした.*Synthetic quota failure/);
  assert.equal(await manager.evaluate(()=>storage.getRecoveryEnabled()),true);
  await manager.evaluate(()=>{storage.setRecoveryEnabled=window.savedSetRecoveryEnabled;delete window.savedSetRecoveryEnabled;});
  await closeRecovery(manager);

  // A draft created before opting out remains available and owns its originals.
  await viewer.evaluate(async()=>{
   await storage.putBlob({id:'retained-original',blob:new Blob(['retained draft bytes'])});
   const project={id:'retained',displayName:'Retained',sections:[{images:{HE:{blobId:'retained-original'}}}]};
   await storage.putProject(project,{createOnly:true});window.stale=await storage.getProject(project.id);
  });
  await manager.evaluate(async()=>{const project=await storage.getProject('retained');project.displayName='Saved elsewhere';await storage.putProject(project);});
  assert.deepEqual(await viewer.evaluate(async()=>{stale.displayName='Existing recovery';try{await storage.putProject(stale);}catch(error){return {code:error.code,recovered:error.recovered};}}),
   {code:'LOCAL_PROJECT_CONFLICT',recovered:true});
  const existingDrafts=await manager.evaluate(()=>storage.listRecoveries());assert.equal(existingDrafts.length,1);

  // The setting is shared across tabs, updates an already-open dialog on focus,
  // and survives navigation/reload without using a per-tab cached default.
  await openRecovery(viewer);
  await setRecoveryThroughUi(manager,false);
  await viewer.bringToFront();await viewer.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await viewer.waitForFunction(()=>Array.from(document.querySelectorAll('input[name="recovery-enabled"]')).some(input=>input.checked&&input.closest('label')?.textContent.includes('自動作成しない')));
  assert.equal(await viewer.evaluate(()=>storage.getRecoveryEnabled()),false);
  await closeRecovery(viewer);await viewer.reload();
  assert.equal(await viewer.evaluate(()=>storage.getRecoveryEnabled()),false);
  await openRecovery(viewer);assert.equal(await viewer.getByRole('radio',{name:'自動作成しない',exact:true}).isChecked(),true);await closeRecovery(viewer);

  const active=await context.newPage();await active.goto(origin+'/viewer');
  await active.evaluate(async()=>{
   await storage.putBlob({id:'off-original',blob:new Blob(['active original'])});
   const project={id:'off-project',displayName:'OFF project',sections:[{images:{HE:{blobId:'off-original'}}}]};
   await storage.putProject(project,{createOnly:true});window.edit=await storage.getProject(project.id,{activate:true});
   await storage.putBlob({id:'off-added',blob:new Blob(['new original before save'])});
   edit.sections.push({msiFiles:{source:{blobId:'off-added'}}});
  });
  let pins=await pinRows(manager,'off-project');assert.equal(pins.length,1);
  assert.equal(Object.hasOwn(pins[0],'project'),false,'OFF editing sessions never persist project snapshots');
  assert.deepEqual([...pins[0].blobIds].sort(),['off-added','off-original']);
  assert.equal(await viewer.evaluate(()=>storage.deleteBlob('off-added')),false,'New unsaved originals are pinned even without a recovery snapshot');
  await manager.evaluate(async()=>{const project=await storage.getProject('off-project');project.displayName='Concurrent winner';await storage.putProject(project);});
  const conflict=await active.evaluate(async()=>{edit.displayName='OFF stale edit';try{await storage.putProject(edit);}catch(error){return {code:error.code,recovered:error.recovered};}});
  assert.deepEqual(conflict,{code:'LOCAL_PROJECT_CONFLICT',recovered:false});
  assert.equal(await manager.evaluate(async()=>(await storage.getProject('off-project')).displayName),'Concurrent winner');
  assert.deepEqual((await manager.evaluate(()=>storage.listRecoveries())).map(row=>row.id),existingDrafts.map(row=>row.id),'OFF conflicts do not add drafts');
  pins=await pinRows(manager,'off-project');assert.equal(Object.hasOwn(pins[0],'project'),false);
  await manager.evaluate(()=>storage.deleteProject('off-project',{expectedRevision:2}));
  assert.equal(await viewer.evaluate(()=>storage.deleteBlob('off-original')),false,'Deleting the project respects the other tab active pin');
  assert.equal(await active.evaluate(async()=>(await storage.getBlob('off-added')).blob.text()),'new original before save');
  const pinsBeforeClose=await pinRows(manager,'off-project');
  await active.close();
  await manager.waitForFunction(async()=>{await storage.listRecoveries();const db=await storage.open();return new Promise((resolve,reject)=>{
   const r=db.transaction('blob_pins','readonly').objectStore('blob_pins').getAll();r.onsuccess=()=>resolve(!r.result.some(row=>row.kind==='editing-session'&&row.projectId==='off-project'));r.onerror=()=>reject(r.error);
  });});
  assert.deepEqual((await manager.evaluate(()=>storage.listRecoveries())).map(row=>row.id),existingDrafts.map(row=>row.id),'Closing an OFF tab creates no phantom recovery');
  const originalsAfterCleanup=await viewer.evaluate(()=>Promise.all(['off-original','off-added'].map(id=>storage.getBlob(id))));
  // Pin removal and blob reclamation commit in one transaction. Preserve the
  // first observation on failure; retrying collection could conceal an orphan.
  const cleanupDiagnostics=originalsAfterCleanup.some(Boolean)
   ? {pinsBeforeClose,...await storageDiagnostics(viewer)} : null;
  assert.deepEqual(originalsAfterCleanup,[null,null],
   'Closed OFF sessions reclaim both unreferenced originals'+(cleanupDiagnostics?'\n'+JSON.stringify(cleanupDiagnostics):''));

  await openRecovery(manager);await manager.getByRole('button',{name:'別コピーとして復元',exact:true}).click();
  await manager.waitForFunction(async()=>(await storage.listRecoveries()).length===0);await closeRecovery(manager);
  const restored=await manager.evaluate(async()=>(await storage.listProjects()).find(project=>project.id!=='retained'));
  assert.equal(restored.displayName,'Existing recovery (recovered)');
  assert.equal(await viewer.evaluate(async()=>(await storage.getBlob('retained-original')).blob.text()),'retained draft bytes');
  assert.equal(await manager.evaluate(()=>storage.getRecoveryEnabled()),false,'Restoring an old draft does not change the preference');

  await setRecoveryThroughUi(manager,true);
  assert.equal(await viewer.evaluate(()=>storage.getRecoveryEnabled()),true);
  await viewer.evaluate(async()=>{window.stale=await storage.getProject('retained');});
  await manager.evaluate(async()=>{const project=await storage.getProject('retained');project.displayName='New winner';await storage.putProject(project);});
  assert.deepEqual(await viewer.evaluate(async()=>{stale.displayName='Recovered after re-enable';try{await storage.putProject(stale);}catch(error){return {code:error.code,recovered:error.recovered};}}),
   {code:'LOCAL_PROJECT_CONFLICT',recovered:true});
  const beforeNormalClose=await manager.evaluate(()=>storage.listRecoveries());assert.equal(beforeNormalClose.length,1);

  // A successful save updates the session revision. Closing its tab must not
  // offer that identical already-saved snapshot as a new recovery project.
  const normal=await context.newPage();await normal.goto(origin+'/viewer');
  await normal.evaluate(async()=>{
   await storage.putBlob({id:'normal-original',blob:new Blob(['normal original'])});
   await storage.putProject({id:'normal',displayName:'Normal',sections:[{images:{HE:{blobId:'normal-original'}}}]},{createOnly:true});
   const project=await storage.getProject('normal',{activate:true});project.displayName='Saved normally';await storage.putProject(project);
  });
  await normal.close();
  await manager.waitForFunction(async()=>{await storage.listRecoveries();const db=await storage.open();return new Promise((resolve,reject)=>{
   const r=db.transaction('blob_pins','readonly').objectStore('blob_pins').getAll();r.onsuccess=()=>resolve(!r.result.some(row=>row.kind==='editing-session'&&row.projectId==='normal'));r.onerror=()=>reject(r.error);
  });});
  assert.deepEqual((await manager.evaluate(()=>storage.listRecoveries())).map(row=>row.id),beforeNormalClose.map(row=>row.id),'Normally saved closed tabs do not add recovery drafts');
  assert.equal(await viewer.evaluate(async()=>(await storage.getBlob('normal-original')).blob.text()),'normal original');
 } finally {await context.close();}
}

async function db5MigrationScenario(browser,origin,errors) {
 const context=await browser.newContext();context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
 try {
  const legacy=await context.newPage();await legacy.goto(origin+'/seed');
  await legacy.evaluate(()=>new Promise((resolve,reject)=>{
   const request=indexedDB.open('desi-projects',5);
   request.onupgradeneeded=()=>{for(const name of ['projects','project_index','blobs','pq_index','project_recovery','blob_pins','archive_jobs'])request.result.createObjectStore(name,{keyPath:'id'});};
   request.onerror=()=>reject(request.error);
   request.onsuccess=()=>{
    const db=request.result;window.legacyDb=db;window.upgradeClosed=false;db.onversionchange=()=>{db.close();window.upgradeClosed=true;};
    const tx=db.transaction(Array.from(db.objectStoreNames),'readwrite');
    const project={id:'db5-project',displayName:'DB5 saved project',storageRevision:7,sections:[{images:{HE:{blobId:'db5-original'}}}],memo:{freeNote:'saved memo'}};
    const draft={id:'recovery:db5-writer:db5-project',projectId:project.id,project:{...project,displayName:'DB5 draft'},expectedRevision:6,actualRevision:7,createdAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z'};
    const pin={id:'db5-job',kind:'zip-export',blobIds:['db5-original'],updatedAt:'2026-11-04T00:00:00Z'};
    const job={id:'db5-archive',kind:'zip-import',state:'staging',ownedBlobIds:['db5-staged']};
    const index={id:project.id,__summary:true,storageRevision:7,displayName:project.displayName,sectionCount:1};
    const pq={id:'db5-index',rows:[{x:1,y:2,value:3}]};window.expected={project,draft,pin,job,index,pq};
    tx.objectStore('projects').put(project);tx.objectStore('project_index').put(index);tx.objectStore('project_recovery').put(draft);
    tx.objectStore('blob_pins').put(pin);tx.objectStore('archive_jobs').put(job);tx.objectStore('pq_index').put(pq);
    tx.objectStore('blobs').put({id:'db5-original',blob:new Blob(['DB5 original bytes'])});tx.objectStore('blobs').put({id:'db5-staged',blob:new Blob(['DB5 staged bytes'])});
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
   };
  }));
  const expected=await legacy.evaluate(()=>expected),manager=await context.newPage();await manager.goto(origin+'/manager');
  const upgraded=await manager.evaluate(async()=>{
   const db=await storage.open(),names=['projects','project_index','project_recovery','blob_pins','archive_jobs','pq_index','blobs'];
   const records=await new Promise((resolve,reject)=>{const tx=db.transaction(names,'readonly'),out={};for(const name of names){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{out[name]=r.result;};}tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error);});
   const bytes={};for(const record of records.blobs)bytes[record.id]=await record.blob.text();delete records.blobs;
   return {version:db.version,enabled:await storage.getRecoveryEnabled(),records,bytes};
  });
  assert.equal(upgraded.version,6);assert.equal(upgraded.enabled,true);assert.equal(await legacy.evaluate(()=>upgradeClosed),true);
  for(const [store,key] of [['projects','project'],['project_index','index'],['project_recovery','draft'],['blob_pins','pin'],['archive_jobs','job'],['pq_index','pq']])assert.deepEqual(upgraded.records[store],[expected[key]],store+' is preserved by DB5 migration');
  assert.deepEqual(upgraded.bytes,{'db5-original':'DB5 original bytes','db5-staged':'DB5 staged bytes'});
  assert.equal(await legacy.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('desi-projects',5);r.onerror=()=>resolve(r.error.name);r.onsuccess=()=>{r.result.close();resolve('opened');};})),'VersionError','DB5 writers cannot bypass the DB6 preference contract');
  await openRecovery(manager);assert.equal(await manager.getByRole('button',{name:'別コピーとして復元',exact:true}).count(),1);await closeRecovery(manager);
 } finally {await context.close();}
}

async function main(){
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/safety.js'?'text/javascript':'text/html; charset=utf-8');res.end(req.url==='/safety.js'?moduleCode:req.url==='/seed'?'<!doctype html><title>legacy</title>':harness(req.url==='/manager'?'manager':'viewer'));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage(),errors=[];
  for(const p of [a,b])p.on('pageerror',e=>errors.push(e.message));
  // Seed DB4 before the real wrappers first open their connection.
  await a.route('**/seed',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>legacy</title>'}));await a.goto(origin+'/seed');
  await a.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('desi-projects',4);r.onupgradeneeded=()=>{for(const n of ['projects','project_index','blobs','pq_index'])r.result.createObjectStore(n,{keyPath:'id'});};r.onsuccess=()=>{const db=r.result,t=db.transaction(['projects','blobs'],'readwrite');t.objectStore('projects').put({id:'legacy',displayName:'Legacy project',sections:[{id:'s',images:{HE:{blobId:'original'}}}],rois:[]});t.objectStore('blobs').put({id:'original',blob:new Blob(['original bytes'])});t.oncomplete=()=>{db.close();resolve();};};r.onerror=()=>reject(r.error);}));
  await a.goto(origin+'/manager');await b.goto(origin+'/viewer');
  const initial=await a.evaluate(async()=>{window.edit=await storage.getProject('legacy');return {revision:edit.storageRevision,version:(await storage.open()).version};});
  assert.deepEqual(initial,{revision:0,version:6});
  assert.equal(await b.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('desi-projects',4);r.onerror=()=>resolve(r.error.name);r.onsuccess=()=>{r.result.close();resolve('opened');};})),'VersionError','old fixed-version writers fenced');
  await b.evaluate(async()=>{window.edit=await storage.getProject('legacy');edit.displayName='B with NEG';edit.sections.push({id:'neg',msiFiles:{N:{blobId:'negative'}}});await storage.putBlob({id:'negative',blob:new Blob(['negative bytes'])});});
  await a.evaluate(async()=>{edit.displayName='A POS';await storage.putProject(edit);});
  const conflict=await b.evaluate(async()=>{try{await storage.putProject(edit);return null;}catch(e){return {code:e.code,recovered:e.recovered};}});assert.deepEqual(conflict,{code:'LOCAL_PROJECT_CONFLICT',recovered:true});
  assert.equal(await a.evaluate(async()=>(await storage.getProject('legacy')).displayName),'A POS');
  assert.equal(await b.evaluate(()=>storage.deleteBlob('negative')),false);
  // Closing a conflicted tab does not discard the editing branch or its sources.
  await b.close();const c=await context.newPage();await c.goto(origin+'/viewer');await c.locator('#local-recovery-button').waitFor({state:'visible'});await c.locator('#local-recovery-button').click();
  await c.getByRole('button',{name:'別コピーとして復元'}).click();await c.getByRole('button',{name:'閉じる',exact:true}).click();
  const copies=await c.evaluate(()=>storage.listProjects());assert.equal(copies.length,2);const recovered=copies.find(p=>p.id!=='legacy');
  assert.equal(await c.evaluate(async id=>(await storage.getProject(id)).sections.length,recovered.id),2);assert.equal(await c.evaluate(async()=>(await storage.getBlob('negative')).blob.text()),'negative bytes');
  // A deleted project cannot be recreated by another open tab.
  await a.evaluate(async()=>{window.stale=await storage.getProject('legacy');});await c.evaluate(()=>storage.deleteProject('legacy',{expectedRevision:1}));
  assert.equal(await a.evaluate(async()=>{try{await storage.putProject(stale);}catch(e){return e.code;}}),'LOCAL_PROJECT_CONFLICT');assert.equal(await c.evaluate(()=>storage.getProject('legacy')),null);
  // Live job pins remain until explicit release, including across a fresh tab.
  await c.evaluate(async()=>{await storage.putBlob({id:'job-only',blob:new Blob(['pinned'])});await storage.pinBlobs('export-job',['job-only'],{kind:'zip-export'});await storage.pruneShareOrphans();});
  assert.equal(await c.evaluate(async()=>(await storage.getBlob('job-only')).blob.text()),'pinned');
  await c.evaluate(()=>storage.releaseBlobPins('export-job'));assert.equal(await c.evaluate(()=>storage.deleteBlob('job-only')),true);
  // One tab deletes a project while another still edits it: originals remain
  // pinned before the stale save has had a chance to create a recovery draft.
  await c.evaluate(async()=>{await storage.putBlob({id:'active-original',blob:new Blob(['only original'])});await storage.putProject({id:'active-project',displayName:'Active',sections:[{images:{HE:{blobId:'active-original'}}}]},{createOnly:true});});
  await a.evaluate(async()=>{window.active=await storage.getProject('active-project',{activate:true});});
  await c.evaluate(()=>storage.deleteProject('active-project',{expectedRevision:1}));
  assert.equal(await c.evaluate(async()=>(await storage.getBlob('active-original')).blob.text()),'only original');
  assert.equal(await c.evaluate(async()=>(await storage.listRecoveries()).filter(r=>r.kind==='editing-session').length),0,'live editing locks hide sessions from recovery/discard UI');
  await a.evaluate(async()=>{active.displayName='Stale edit survives';try{await storage.putProject(active);}catch(e){if(e.code!=='LOCAL_PROJECT_CONFLICT')throw e;}});
  const draft=await c.evaluate(async()=>(await storage.listRecoveries()).find(r=>r.projectId==='active-project'));
  const restored=await c.evaluate(id=>storage.restoreRecovery(id),draft.id);assert.equal(restored.displayName,'Stale edit survives (recovered)');
  assert.equal(await c.evaluate(async()=>(await storage.getBlob('active-original')).blob.text()),'only original');
  // No timer releases a crashed tab's pin. A new tab can explicitly recover or discard it.
  await a.close();await c.waitForFunction(async()=> (await storage.listRecoveries()).some(r=>r.kind==='editing-session'));const sessions=await c.evaluate(()=>storage.listRecoveries());const session=sessions.find(r=>r.kind==='editing-session');assert.ok(session);
  await c.evaluate(id=>storage.discardRecovery(id),session.id);assert.equal(await c.evaluate(async()=>(await storage.getBlob('active-original')).blob.text()),'only original','discard retains the restored copy original');
  await context.close();
  await optionalRecoveryScenario(browser,origin,errors);
  await db5MigrationScenario(browser,origin,errors);
  assert.deepEqual(errors,[]);
  console.log('Project store safety browser regression: PASS (DB4/5 to DB6, fenced old tabs, shared recovery preference, OFF conflicts and pins, durable recovery UI, normal-close deduplication)');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
