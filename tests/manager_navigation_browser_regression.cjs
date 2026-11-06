'use strict';
// Actual manager UI and IndexedDB in Chromium. The navigation interface is a
// narrow test double; project-navigation's authentication behavior has its own tests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
async function main(){
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/Share_Test/project-navigation.js'){res.setHeader('Content-Type','text/javascript');res.end('/* Navigation boundary stub is installed by the isolated test context. */');return;}
  if(pathname==='/Share_Test/viewer/index.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Navigation target</title><p>Isolated child tab</p>');return;}
  const rel=pathname.replace(/^\/Share_Test\//,'')||'index.html',file=path.resolve(root,rel);
  if(!file.startsWith(root+path.sep)){res.writeHead(404);res.end();return;}
  try{res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.md':'text/plain'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));}catch(_){res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
  const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>{if(route.request().url().startsWith(origin+'/')||route.request().url().startsWith('data:'))return route.continue();external.push(route.request().url());return route.abort();});
  await context.addInitScript(()=>{
   if(location.pathname==='/Share_Test/index.html')sessionStorage.setItem('desi:masterUnlocked',JSON.stringify({expiresAt:Date.now()+3600000}));
   window.navigationCalls=[];
   window.ProjectNavigation={resumeMasterDestination:()=>false,shareUrl:slug=>new URL('viewer/index.html#share='+encodeURIComponent(slug),location.href).href,
    openMaster:(destination,options={})=>{window.navigationCalls.push({destination,options});if(window.blockNavigation)return false;const key=destination.projectId?'project':'import',value=destination.projectId||destination.importSlug;return !!window.open(new URL('viewer/index.html?'+key+'='+encodeURIComponent(value)+(options.refreshShare?'&refresh=share':''),location.href),'_blank');}};
  });
  await page.goto(origin+'/Share_Test/index.html');await page.waitForFunction(()=>typeof _lastListRows!=='undefined'&&_lastListRows==='[]');
  await page.evaluate(async()=>{
   await ProjectStorage.putProject({id:'local-copy',displayName:'Local project',sections:[],createdAt:'2026-11-01T00:00:00Z'},{createOnly:true});
   await ProjectStorage.putProject({id:'shared-local-copy',displayName:'Shared local edits',sections:[{id:'local-section'}],shareInfo:{slug:'linked-share'},__publishPending:true,createdAt:'2026-11-02T00:00:00Z'},{createOnly:true});
   for(let i=0;i<18;i++)await ProjectStorage.putProject({id:'filler-'+i,displayName:'Shared sample '+i,sections:[],createdAt:'2026-10-01T00:00:00Z'},{createOnly:true});
   serverRowsCache=[{slug:'server-one',display_name:'Shared one'},{slug:'server-two',display_name:'Shared two'}];
   workspaceTree={version:1,children:[{type:'folder',id:'folder-a',name:'Expanded folder',children:[{type:'project',localId:'local-copy'}]}]};_openFolders.add('folder-a');
   window.serverCalls=[];SupabaseClient.setWorkspaceTree=async()=>{serverCalls.push('write');};SupabaseClient.getWorkspaceTree=async()=>{serverCalls.push('read');return workspaceTree;};
   await renderList();
  });
  const parentUrl=page.url();
  assert.match(await page.locator('#sharing-description').textContent(),/同じ Google アカウントでも他のPCへ自動同期されません/);
  assert.match(await page.locator('[data-local-id="local-copy"] .badge.local').textContent(),/このPCのみ／未公開/);
  assert.equal(await page.locator('[data-local-id="local-copy"] [data-action="refresh-share"]').count(),0);
  assert.equal(await page.locator('[data-slug="server-one"] [data-action="refresh-share"]').count(),0);
  let childPromise=context.waitForEvent('page');await page.locator('[data-local-id="local-copy"] [data-action="open-local"]').click();let child=await childPromise;await child.waitForLoadState();
  assert.equal(child.url(),origin+'/Share_Test/viewer/index.html?project=local-copy');assert.equal(page.url(),parentUrl);assert.equal(await page.locator('[data-folder-body="folder-a"]').isVisible(),true);await child.close();await page.bringToFront();
  // A shared local copy can check for changes even while it has unpublished
  // edits, and even when the current server listing does not contain its slug.
  const beforeRefresh=await page.evaluate(()=>ProjectStorage.getProject('shared-local-copy'));
  childPromise=context.waitForEvent('page');await page.locator('[data-local-id="shared-local-copy"] [data-action="refresh-share"]').click();child=await childPromise;await child.waitForLoadState();
  assert.equal(child.url(),origin+'/Share_Test/viewer/index.html?project=shared-local-copy&refresh=share');assert.equal(page.url(),parentUrl);
  assert.deepEqual(await page.evaluate(()=>ProjectStorage.getProject('shared-local-copy')),beforeRefresh,'checking never overwrites local edits in the manager');
  assert.deepEqual(await page.evaluate(()=>navigationCalls.at(-1)),{destination:{projectId:'shared-local-copy'},options:{refreshShare:true}});
  await child.close();await page.bringToFront();
  await page.evaluate(async()=>{await ProjectStorage.patchProject('shared-local-copy',project=>{project.__publishPending=false;});await renderList();});
  assert.equal(await page.locator('[data-local-id="shared-local-copy"] [data-action="refresh-share"]').count(),1,'checking is also available without pending edits');
  const share=page.locator('[data-slug="server-one"] [data-action="open-share"]');assert.equal(await share.getAttribute('target'),'_blank');assert.equal(await share.getAttribute('rel'),'noopener');
  await page.evaluate(()=>sessionStorage.setItem('desi:test-share-admin','parent-only'));
  childPromise=context.waitForEvent('page');await share.click();child=await childPromise;await child.waitForLoadState();assert.equal(child.url(),origin+'/Share_Test/viewer/index.html#share=server-one');assert.equal(page.url(),parentUrl);
  assert.equal(await child.evaluate(()=>window.opener===null),true);assert.equal(await child.evaluate(()=>sessionStorage.getItem('desi:test-share-admin')),null);await child.close();await page.bringToFront();
  childPromise=context.waitForEvent('page');await page.locator('[data-slug="server-one"] [data-action="open-server"]').click();child=await childPromise;await child.waitForLoadState();assert.equal(child.url(),origin+'/Share_Test/viewer/index.html?import=server-one');assert.equal(page.url(),parentUrl);
  // Child import: real same-origin IndexedDB, independent tab. Parent must
  // see the new local copy on return without fetching or publishing the tree.
  await child.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('desi-projects',6);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(['projects','project_index'],'readwrite');const p={id:'imported-copy',displayName:'Shared imported',storageRevision:1,sections:[],shareInfo:{slug:'server-one'},createdAt:'2026-11-04T00:00:00Z'};tx.objectStore('projects').add(p);tx.objectStore('project_index').put({...p,__summary:true,sectionCount:0});tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};}));
  await page.evaluate(()=>workspaceTree.children.push({type:'project',localId:'imported-copy'}));
  await page.bringToFront();await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
  await page.locator('[data-local-id="imported-copy"] [data-action="open-local"]').waitFor();assert.equal(await page.locator('[data-slug="server-one"] [data-action="open-server"]').count(),0);assert.equal(await page.locator('[data-folder-body="folder-a"]').isVisible(),true);assert.deepEqual(await page.evaluate(()=>serverCalls),[]);assert.equal(await page.evaluate(()=>workspaceTree.children.find(n=>n.localId==='imported-copy').slug),undefined,'focus refresh does not heal or publish the saved tree');await page.evaluate(()=>{workspaceTree.children=workspaceTree.children.filter(n=>n.localId!=='imported-copy');});await child.close();
  // Server-only rename's alternate navigation uses the same new-tab boundary.
  page.once('dialog',dialog=>dialog.accept());childPromise=context.waitForEvent('page');await page.locator('[data-slug="server-two"] [data-action="rename"]').click();child=await childPromise;await child.waitForLoadState();assert.equal(child.url(),origin+'/Share_Test/viewer/index.html?import=server-two');assert.equal(page.url(),parentUrl);await child.close();await page.bringToFront();
  // Blocking the helper does not navigate or destroy the parent.
  await page.evaluate(()=>{blockNavigation=true;});await page.locator('[data-local-id="local-copy"] [data-action="open-local"]').click();assert.equal(page.url(),parentUrl);assert.equal(context.pages().length,1);await page.evaluate(()=>{blockNavigation=false;});
  // Focus + visible are coalesced; an unchanged list preserves its DOM node.
  await page.waitForFunction(()=>!_managerReturnPending&&!_managerReturnTimer&&!_listRendering);
  await page.evaluate(()=>{window.readCount=0;window.realSummaries=ProjectStorage.listSummaries;ProjectStorage.listSummaries=async()=>{readCount++;return realSummaries();};document.querySelector('.proj-row').__marker='retained';window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>readCount===1&&!_managerReturnTimer);await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>readCount),1);assert.equal(await page.evaluate(()=>document.querySelector('.proj-row').__marker),'retained');
  // Search, sort and scroll survive a changed local-summary refresh.
  await page.locator('#proj-search').fill('Shared');await page.locator('#proj-sort').selectOption('name');await page.waitForFunction(()=>document.getElementById('list').textContent.includes('検索'));
  await page.evaluate(async()=>{window.scrollTo(0,600);window.originalScroll=scrollY;const p=await ProjectStorage.getProject('imported-copy');p.displayName='Shared changed';await ProjectStorage.putProject(p);window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>document.querySelector('[data-local-id="imported-copy"]').textContent.includes('Shared changed'));
  assert.equal(await page.locator('#proj-search').inputValue(),'Shared');assert.equal(await page.locator('#proj-sort').inputValue(),'name');await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>scrollY),await page.evaluate(()=>originalScroll));assert.equal(await page.evaluate(()=>_openFolders.has('folder-a')),true);
  // Focus refresh waits for an open editing modal and a pending async action.
  await page.evaluate(async()=>{window.readCount=0;openModal('<h2>Keep modal</h2><input value="draft"><button data-modal-cancel>Close fixture</button>');const p=await ProjectStorage.getProject('imported-copy');p.displayName='Shared after modal';await ProjectStorage.putProject(p);window.dispatchEvent(new Event('focus'));});
  await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>readCount),0);assert.equal(await page.locator('#modal-host input').inputValue(),'draft');await page.getByText('Close fixture',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-local-id="imported-copy"]').textContent.includes('Shared after modal'));
  await page.evaluate(async()=>{window.readCount=0;window.heldAction=runManagerAction(()=>new Promise(resolve=>{window.releaseAction=resolve;}));const p=await ProjectStorage.getProject('imported-copy');p.displayName='Shared after write';await ProjectStorage.putProject(p);window.dispatchEvent(new Event('focus'));});await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>readCount),0);await page.evaluate(()=>releaseAction());await page.waitForFunction(()=>document.querySelector('[data-local-id="imported-copy"]').textContent.includes('Shared after write'));
  // A slower obsolete read cannot overwrite a later rendering result.
  await page.evaluate(async()=>{window.realBuildRows=buildRows;window.pendingRows=[];buildRows=()=>new Promise(resolve=>pendingRows.push(resolve));window.oldRender=renderList();window.newRender=renderList();pendingRows[1]([{kind:'local-only',local:{id:'new-row',displayName:'Shared Newest',storageRevision:1}}]);await newRender;pendingRows[0]([{kind:'local-only',local:{id:'old-row',displayName:'Shared Obsolete',storageRevision:1}}]);await oldRender;buildRows=realBuildRows;});
  assert.equal(await page.locator('[data-local-id="new-row"]').count(),1);assert.equal(await page.locator('[data-local-id="old-row"]').count(),0);assert.deepEqual(await page.evaluate(()=>serverCalls),[]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Manager new-tab browser regression: PASS (navigation, isolated share tab, import return, local-only refresh, UI preservation, async deferral, stale reads)');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

