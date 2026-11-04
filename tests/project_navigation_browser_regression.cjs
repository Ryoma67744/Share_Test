'use strict';

// Real navigation, sessionStorage, manager login and viewer bootstrap on a new
// localhost origin. The fixture accepts only synthetic authentication/read RPCs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const prefix = '/application/';
const slug = 'navigation-synthetic-shared';
const password = 'navigation-synthetic-master';
const projectId = 'navigation-synthetic-local';
const unlockKey = 'desi:masterUnlocked', passwordKey = 'desi:masterPw';

function credentials(expired = false) {
  const expiresAt = Date.now() + (expired ? -1000 : 3600000);
  return {
    [unlockKey]: JSON.stringify({unlockedAt:expiresAt - 3600000, expiresAt}),
    // Publishing may refresh only the password cache. Preserve distinct TTLs;
    // an expired gate must not transfer even this still-valid password.
    [passwordKey]: JSON.stringify({pw:password, expiresAt:expiresAt + 30000}),
    ['desi:share:' + slug]: JSON.stringify({slug, role:'admin', token:'PARENT_ADMIN_MUST_NOT_LEAVE',
      expiresAt:new Date(Date.now() + 3600000).toISOString()}),
    'desi:share:other-project':'OTHER_ADMIN_MUST_NOT_LEAVE',
    'desi:ownerPw':'OWNER_MUST_NOT_LEAVE',
    'unrelated-parent-cache':'parent-only'
  };
}
const localProject = id => ({id, storageRevision:1, displayName:'Navigation local ' + id,
  createdAt:'2026-11-01T00:00:00Z', updatedAt:'2026-11-01T00:00:00Z', sections:[], rois:[],
  anatomyPalette:{}, meta:{}, memo:{freeNote:'synthetic navigation fixture'}});
const doc = {id:'navigation-server-id', slug, is_public:true, publish_revision:1,
  meta:{display_name:'Navigation imported copy', project_meta:{}}, sections:[], anatomy_palette:{}};
const harness = `<!doctype html><meta charset="utf-8"><script src="runtime-config.js"></script>
<script src="app-runtime.js"></script><script src="project-store-safety.js"></script>
<script src="project-navigation.js"></script><button id="master">Open master</button>
<a id="share" target="_blank" rel="noopener">Share view</a><p id="messages" role="status"></p>
<script>window.showToast=message=>document.getElementById('messages').textContent=message;
document.getElementById('master').onclick=()=>{window.openResult=ProjectNavigation.openMaster(window.testTarget);};
document.getElementById('share').href=ProjectNavigation.shareUrl(${JSON.stringify(slug)});</script>`;

async function seed(page, auth, projects = [localProject(projectId)]) {
  await page.evaluate(async ({auth,projects}) => {
    sessionStorage.clear();
    for (const [key,value] of Object.entries(auth)) sessionStorage.setItem(key,value);
    const db = await new Promise((resolve,reject) => {
      const request = indexedDB.open('desi-projects',6);
      request.onupgradeneeded = () => ProjectStoreSafety.upgrade(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve,reject) => {
      const tx = db.transaction(['projects','project_index'],'readwrite');
      for (const project of projects) {
        tx.objectStore('projects').put(project);
        tx.objectStore('project_index').put({__summary:true,id:project.id,storageRevision:1,
          displayName:project.displayName,updatedAt:project.updatedAt,createdAt:project.createdAt,
          memo:project.memo,shareInfo:null,sectionCount:0});
      }
      tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error);
    });
    db.close();
  }, {auth,projects});
}
async function storage(page) { return page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))); }
async function masterReady(page, id) {
  await page.waitForFunction(expected => typeof App !== 'undefined' && App.project
    && App.project.id === expected && !App.shareMode && !App.project.__share, id);
}
async function popup(context, action, expected) {
  const opened = context.waitForEvent('page');
  await action();
  const page = await opened;
  // The initial about:blank may already be loaded; wait for the destination.
  await page.waitForURL(expected);
  return page;
}

async function main() {
  const traffic = [], forbidden = [], errors = [], external = [], dialogs = [];
  const allowedReads = new Set(['get_project_doc','list_rois','list_share_overlays',
    'list_share_alignments','list_share_images','get_workspace_tree','list_projects_v2']);
  const server = http.createServer(async (request,response) => {
    try {
      const url = new URL(request.url,'http://localhost'), pathname = decodeURIComponent(url.pathname);
      if (pathname === prefix + 'runtime-config.js') {
        response.setHeader('Content-Type','text/javascript');
        response.end("Object.defineProperty(window,'DESI_BUILD_CONFIG',{value:{mode:'online',cloud:{url:"
          + JSON.stringify('http://' + request.headers.host) + ",anonKey:'synthetic-anon-key'}}});"); return;
      }
      if (request.method === 'POST' && pathname.startsWith('/rest/v1/rpc/')) {
        const chunks=[]; for await (const chunk of request) chunks.push(chunk);
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8')), rpc=pathname.split('/').pop();
        traffic.push({rpc,body});
        response.setHeader('Content-Type','application/json');
        let result;
        if (rpc === 'verify_master_pw') result = body._pw === password;
        else if (rpc === 'unlock_public_project' && body._slug === slug) {
          result=[{token:'synthetic-public-viewer-token',role:'viewer',expires_at:new Date(Date.now()+3600000).toISOString()}];
        } else if (rpc === 'unlock_project_master' && body._slug === slug && body._master_pw === password) {
          result=[{token:'synthetic-master-reader-token',role:'viewer',expires_at:new Date(Date.now()+3600000).toISOString()}];
        } else if (allowedReads.has(rpc)) {
          if (rpc === 'get_project_doc') {
            assert.ok(['synthetic-public-viewer-token','synthetic-master-reader-token'].includes(body.p_token));
            result=doc;
          } else if (rpc === 'get_workspace_tree') result={version:1,children:[]};
          else if (rpc === 'list_projects_v2') result=[{slug,display_name:'Navigation imported copy',is_public:true,updated_at:'2026-11-01T00:00:00Z'}];
          else result=[];
        } else {
          forbidden.push({method:request.method,path:pathname,body});
          response.writeHead(403); response.end(JSON.stringify({message:'Forbidden fixture RPC'})); return;
        }
        response.end(JSON.stringify(result)); return;
      }
      if (!['GET','HEAD'].includes(request.method)) {
        forbidden.push({method:request.method,path:pathname}); response.writeHead(405); response.end(); return;
      }
      if (pathname === prefix + 'navigation-harness.html') {
        response.setHeader('Content-Type','text/html; charset=utf-8'); response.end(harness); return;
      }
      if (!pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
      const relative = pathname.slice(prefix.length) + (pathname.endsWith('/') ? 'index.html' : '');
      const file = path.resolve(root,relative);
      if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
      response.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[path.extname(file)] || 'application/octet-stream');
      response.end(await fs.readFile(file));
    } catch (error) {
      errors.push('Fixture server: ' + error.message); response.writeHead(404); response.end();
    }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, base = origin + prefix;
  let browser, stage = 'launch';
  async function context() {
    const ctx = await browser.newContext({viewport:{width:1280,height:800}});
    await ctx.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/') || /^(data|blob):/.test(route.request().url())) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await ctx.addInitScript(() => {
      // Fresh context about:blank has no origin. Capture credentials only once
      // the synthetic same-origin destination exists, before production scripts.
      try { window.__initialSession = Object.fromEntries(Object.entries(sessionStorage)); } catch (_) {}
    });
    ctx.on('page', page => {
      page.on('pageerror',error=>errors.push(error.message));
      page.on('dialog',dialog=>{dialogs.push(dialog.message());dialog.dismiss();});
    });
    return ctx;
  }
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined});
    const ctx=await context(), parent=await ctx.newPage();
    await parent.goto(base+'navigation-harness.html');
    const auth=credentials(); await seed(parent,auth);
    await parent.evaluate(id=>{window.testTarget={projectId:id};},projectId);
    const originalUrl=parent.url(), beforeRpc=traffic.length;
    stage='cached master popup';
    const child=await popup(ctx,()=>parent.locator('#master').click(),base+'viewer/index.html?project='+projectId);
    await masterReady(child,projectId);
    const copied=await child.evaluate(()=>window.__initialSession);
    assert.deepEqual(copied,{[unlockKey]:auth[unlockKey],[passwordKey]:auth[passwordKey]},'Only the two master keys are seeded, with unchanged expiries');
    assert.equal(await child.evaluate(()=>window.opener),null);
    assert.deepEqual(await storage(parent),auth,'Clearing the new tab never clears parent credentials');
    assert.equal(parent.url(),originalUrl);
    assert.ok(!traffic.slice(beforeRpc).some(item=>['verify_master_pw','unlock_project','unlock_project_master'].includes(item.rpc)),'Cached local master opens without reauthentication');
    assert.deepEqual(dialogs,[],'A valid local master does not ask for a password');
    await child.close();

    stage='shared viewer popup';
    const shared=await popup(ctx,()=>parent.locator('#share').click(),base+'viewer/index.html#share='+slug);
    await shared.waitForFunction(() => typeof App !== 'undefined' && App.project && App.project.__share && App.shareMode?.role === 'viewer');
    assert.deepEqual(await shared.evaluate(()=>window.__initialSession),{},'Native noopener starts with no parent credentials');
    assert.equal(await shared.evaluate(()=>window.opener),null);
    assert.equal(await shared.locator('body').evaluate(el=>el.classList.contains('share-admin')),false);
    assert.equal((await shared.evaluate(slug=>JSON.parse(sessionStorage.getItem('desi:share:'+slug)).role,slug)),'viewer');
    assert.ok(traffic.some(item=>item.rpc==='unlock_public_project'),'Production shared bootstrap minted a viewer session');
    assert.deepEqual(await storage(parent),auth);
    await shared.close();

    await parent.evaluate(()=>{window.originalOpen=window.open;window.open=()=>null;});
    await parent.locator('#master').click();
    assert.equal(await parent.evaluate(()=>window.openResult),false);
    await parent.getByRole('status').filter({hasText:'ポップアップ設定'}).waitFor();
    assert.equal(parent.url(),originalUrl); assert.deepEqual(await storage(parent),auth);
    await parent.evaluate(()=>{window.open=window.originalOpen;});
    await ctx.close();

    stage='expired master login return';
    const expiredContext=await context(), expiredParent=await expiredContext.newPage();
    await expiredParent.goto(base+'navigation-harness.html');
    const expired=credentials(true); await seed(expiredParent,expired);
    await expiredParent.evaluate(id=>{window.testTarget={projectId:id};},projectId);
    const gated=await popup(expiredContext,()=>expiredParent.locator('#master').click(),base+'index.html?openProject='+projectId);
    assert.deepEqual(await gated.evaluate(()=>window.__initialSession),{},'Expired gate transfers no cached credentials');
    await gated.locator('input[name="pw"]').fill(password);
    await gated.locator('[data-modal-ok]').click();
    await gated.waitForURL(base+'viewer/index.html?project='+projectId);
    await masterReady(gated,projectId);
    assert.equal(await gated.evaluate(()=>window.opener),null);
    assert.deepEqual(await storage(expiredParent),expired);
    assert.ok(traffic.some(item=>item.rpc==='verify_master_pw' && item.body._pw===password));
    await gated.close();
    await expiredParent.evaluate(slug=>{window.testTarget={importSlug:slug};},slug);
    const importGate=await popup(expiredContext,()=>expiredParent.locator('#master').click(),base+'index.html?importProject='+slug);
    await importGate.locator('input[name="pw"]').fill(password);
    await importGate.locator('[data-modal-ok]').click();
    await importGate.waitForFunction(slug=>typeof App !== 'undefined' && App.project
      && !App.shareMode && App.project.shareInfo?.slug === slug,slug);
    assert.ok(new URL(importGate.url()).searchParams.has('project'),'Server destination survives login and becomes a local copy');
    assert.deepEqual(await storage(expiredParent),expired);
    await expiredContext.close();

    stage='invalid return routes';
    const invalidContext=await context(), invalid=await invalidContext.newPage();
    await invalid.goto(base+'navigation-harness.html'); await seed(invalid,credentials());
    const fallback=base+'index.html';
    assert.deepEqual(await invalid.evaluate(({base,origin})=>[
      ProjectNavigation.masterLoginUrlFromViewer('https://foreign.invalid/viewer/?project=secret'),
      ProjectNavigation.masterLoginUrlFromViewer(origin+'/other/viewer/?project=secret'),
      ProjectNavigation.masterLoginUrlFromViewer(base+'viewer/?project=a&import=b'),
      ProjectNavigation.masterLoginUrlFromViewer(base+'viewer/?project=a&project=b')
    ],{base,origin}),[fallback,fallback,fallback,fallback]);
    for (const query of ['?returnUrl=https%3A%2F%2Fforeign.invalid%2F','?openProject=a&importProject=b','?openProject=']) {
      await invalid.goto(base+'index.html'+query);
      await invalid.locator('#proj-search').waitFor();
      assert.equal(await invalid.evaluate(()=>ProjectNavigation.resumeMasterDestination()),false);
      assert.equal(invalid.url(),base+'index.html'+query,'Invalid return parameters never navigate');
    }
    await invalidContext.close();

    stage='actual manager cards and return refresh';
    const managerContext=await context(), manager=await managerContext.newPage();
    await manager.goto(base+'navigation-harness.html');
    const managerAuth=credentials(), projects=Array.from({length:30},(_,i)=>localProject('navigation-local-'+String(i).padStart(2,'0')));
    await seed(manager,managerAuth,projects);
    await manager.goto(base+'index.html');
    await manager.locator('[data-action="open-server"]').waitFor();
    await manager.locator('#proj-search').fill('Navigation');
    await manager.locator('#proj-sort').selectOption('name');
    await manager.waitForFunction(()=>document.querySelectorAll('.proj-row').length===31
      && typeof _listRendering !== 'undefined' && !_listRendering);
    const card=manager.locator('.proj-row[data-local-id="navigation-local-20"] [data-action="open-local"]');
    await card.scrollIntoViewIfNeeded();
    const managerUrl=manager.url(), scroll=await manager.evaluate(()=>window.scrollY);
    assert.ok(scroll>0,'Fixture exercises a scrolled project list');
    const localChild=await popup(managerContext,()=>card.click(),base+'viewer/index.html?project=navigation-local-20');
    await masterReady(localChild,'navigation-local-20');
    assert.equal(manager.url(),managerUrl);
    assert.equal(await manager.locator('#proj-search').inputValue(),'Navigation');
    assert.equal(await manager.locator('#proj-sort').inputValue(),'name');
    assert.ok(Math.abs(await manager.evaluate(()=>window.scrollY)-scroll)<=1,'Opening a card preserves parent scroll');
    assert.deepEqual(await storage(manager),managerAuth);
    await localChild.close();

    const shareCard=manager.locator('.proj-row[data-slug="'+slug+'"] a[data-action="open-share"]');
    assert.equal(await shareCard.getAttribute('target'),'_blank');
    assert.ok((await shareCard.getAttribute('rel')).split(/\s+/).includes('noopener'));
    const sharedCard=await popup(managerContext,()=>shareCard.click(),base+'viewer/index.html#share='+slug);
    await sharedCard.waitForFunction(()=>typeof App !== 'undefined' && App.project?.__share && App.shareMode?.role==='viewer');
    assert.deepEqual(await sharedCard.evaluate(()=>window.__initialSession),{});
    assert.equal(manager.url(),managerUrl);
    assert.deepEqual(await storage(manager),managerAuth);
    await sharedCard.close();

    const serverCard=manager.locator('.proj-row[data-slug="'+slug+'"] [data-action="open-server"]');
    await serverCard.scrollIntoViewIfNeeded();
    const importScroll=await manager.evaluate(()=>window.scrollY);
    const imported=await popup(managerContext,()=>serverCard.click(),url=>url.pathname===prefix+'viewer/index.html' && url.searchParams.has('project'));
    await imported.waitForFunction(slug=>typeof App !== 'undefined' && App.project?.shareInfo?.slug===slug && !App.shareMode,slug);
    const importedId=await imported.evaluate(()=>App.project.id);
    assert.ok(!projects.some(project=>project.id===importedId),'Server import creates a distinct local copy');
    assert.equal(manager.url(),managerUrl);
    assert.deepEqual(await storage(manager),managerAuth);
    const readCountBeforeFocus=traffic.length;
    await manager.bringToFront();
    // Headless window activation is platform-dependent. Dispatch the browser's
    // focus event as well; the production debounce must combine both signals.
    await manager.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await manager.locator('.proj-row[data-local-id="'+importedId+'"] [data-action="open-local"]').waitFor();
    await manager.waitForFunction(()=>!_managerReturnPending && !_managerReturnTimer && !_listRendering);
    assert.equal(await manager.locator('[data-action="open-server"]').count(),0);
    assert.equal(await manager.locator('#proj-search').inputValue(),'Navigation');
    assert.equal(await manager.locator('#proj-sort').inputValue(),'name');
    assert.ok(Math.abs(await manager.evaluate(()=>window.scrollY)-importScroll)<=1,'Return refresh preserves list scroll');
    assert.equal(traffic.length,readCountBeforeFocus,'Return refresh reads local summaries without cloud traffic');
    assert.equal(await manager.evaluate(async()=>{const db=await ProjectStorage.open();return new Promise(resolve=>{const r=db.transaction('projects').objectStore('projects').count();r.onsuccess=()=>resolve(r.result);});}),31,'Opening and returning retains all existing local projects');
    await managerContext.close();

    assert.deepEqual(forbidden,[],'No remote writes or unexpected RPCs');
    assert.deepEqual(external,[],'No external network');
    // Existing optional collaborator-ROI polling separately requests a project
    // Admin password after server import. Dismiss that prompt; no Admin auth or
    // write RPC is allowed by this fixture. It is unrelated to master entry.
    const optionalRoiPrompt='"'+slug+'" の共同研究者ROIを取得します。\nこのプロジェクトの admin password（サーバ一覧取得用）を入力してください。\n(キャンセルすると今回は取り込みません)';
    assert.deepEqual(dialogs.filter(message=>message!==optionalRoiPrompt),[],'No unexpected alerts or password prompts');
    assert.deepEqual(errors,[],'No browser or fixture errors');
    assert.ok(!JSON.stringify(traffic).includes('MUST_NOT_LEAVE'),'Parent Admin/owner credentials never reach an API');
    console.log('project_navigation_browser_regression: PASS (real master/share tabs, isolated credentials, expiry login return, invalid routes, blocked popup, manager cards and local refresh)');
  } catch (error) {
    console.error({stage,errors,forbidden,dialogs,external});
    throw error;
  } finally {
    if(browser)await browser.close(); await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
