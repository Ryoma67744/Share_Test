'use strict';
// Real manager UI and Supabase client against synthetic HTTP fixtures only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));

async function main() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      res.setHeader('Content-Type', ({'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css'})[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined});
    const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
    const page = await context.newPage();
    const errors = [], unexpected = [], pageOffsets = [], alerts = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.accept(); });
    const catalogue = Array.from({length: 7}, (_, i) => ({slug: `published-${i}`, display_name: `Published ${i}`}));
    catalogue[4] = {slug:'261027_clinical_hcc_liver',display_name:'261027_Clinical_HCC_Liver'};
    const project = i => ({type: 'project', slug: catalogue[i].slug});
    let tree = {version: 1, children: [{type: 'folder', id: 'parent', name: 'Parent', shareSlug: 'stable-share', shareIsPublic: true, children: [
      ...Array.from({length: 4}, (_, i) => ({type: 'project', localId: `unknown-${i}`})),
      {type: 'folder', id: 'hcc', name: 'HCC', shareSlug: 'child-hcc', children: [0, 1, 2].map(project)},
      {type: 'folder', id: 'gpx', name: 'GPX', children: [3].map(project)},
      {type: 'folder', id: 'clinical', name: 'Clinical', children: [4, 5, 6].map(project)},
    ]}]};
    let savedIndex = {name: 'Previous share', children: [{type: 'project', slug: 'published-0'}]};
    let failOffset = null, writes = 0, publishes = 0, conflictOnCommit = false, missingProtocol = false;
    await context.addInitScript(() => {
      localStorage.setItem('desi:ui:lang', 'en');
      sessionStorage.setItem('desi:masterUnlocked', JSON.stringify({expiresAt: Date.now() + 3600000}));
      sessionStorage.setItem('desi:masterPw', JSON.stringify({pw: 'fixture-password', expiresAt: Date.now() + 3600000}));
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.href === origin + '/runtime-config.js') return route.fulfill({contentType: 'text/javascript', body: 'window.DESI_BUILD_CONFIG=Object.freeze({mode:"online",cloud:{url:"https://folder-fixture.invalid",anonKey:"fixture-only-key"}});'});
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (url.origin !== 'https://folder-fixture.invalid') { unexpected.push(url.href); return route.abort(); }
      const headers = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,GET,OPTIONS', 'access-control-expose-headers': 'content-range'};
      if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
      const name = url.pathname.split('/').pop(), body = request.postDataJSON() || {};
      calls.push(name);
      const respond = (data, more = {}) => route.fulfill({contentType: 'application/json', headers, body: JSON.stringify(data), ...more});
      if (name === 'list_projects_v2') {
        if (!request.headers().prefer?.includes('count=exact')) return respond(catalogue.slice(0, 3));
        assert.equal(url.searchParams.get('order'), 'slug.asc');
        assert.equal(url.searchParams.get('limit'), '200');
        const from = Number(url.searchParams.get('offset') || 0);
        pageOffsets.push(from);
        if (from === failOffset) return respond({message: 'Synthetic network failure'}, {status: 503});
        const data = catalogue.slice().sort((a,b)=>a.slug.localeCompare(b.slug)).slice(from, from + 3);
        return respond(data, {status: 206, headers: {...headers, 'content-range': `${from}-${from + data.length - 1}/${catalogue.length}`}});
      }
      if (name === 'get_workspace_tree') return respond(tree);
      if (name === 'publish_folder_share_selected_checked') {
        if (missingProtocol) return respond({code:'PGRST202',message:'Could not find the function'}, {status:404});
        if (conflictOnCommit) {
          conflictOnCommit = false;
          tree.children.push({type:'folder',id:'concurrent',name:'Concurrent change',children:[]});
          return respond({code:'PT409',message:'folder_tree_changed'}, {status:409});
        }
        assert.deepEqual(body._expected_tree, tree);
        assert.equal(body._folder_id, 'parent');
        assert.equal(body._tree.children[0].shareSlug, 'stable-share');
        assert.equal(body._tree.children[0].shareIsPublic, true);
        assert.match(body._tree.children[0].shareRevision,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.notEqual(body._tree.children[0].shareRevision,body._expected_tree.children[0].shareRevision);
        const slugs=[], walk=nodes=>{for(const n of nodes)n.type==='folder'?walk(n.children):slugs.push(n.slug);};
        walk(body._index_doc.children);
        assert.deepEqual(body._selected_project_slugs.slice().sort(), [...new Set(slugs)].sort());
        let placements=0;
        const count=nodes=>{for(const n of nodes){if(n.type==='folder'&&body._tree.children[0].shareIncludeSubfolders)count(n.children);else if(n.type==='project')placements++;}};
        count(body._tree.children[0].children);
        publishes++; writes++; tree=clone(body._tree); savedIndex = clone(body._index_doc);
        return respond({slug:'stable-share',project_count:new Set(slugs).size,placement_count:slugs.length,
          excluded_placement_count:placements-slugs.length,project_slugs:[...new Set(slugs)].sort()});
      }
      if (name === 'get_folder_index') return respond({name: 'Parent', index_doc: savedIndex, is_public: true});
      unexpected.push('Unmocked RPC: ' + name);
      return respond({message: 'Unexpected fixture operation'}, {status: 400});
    });
    await page.goto(origin + '/index.html');
    await page.waitForFunction(() => typeof serverRowsCache !== 'undefined' && serverRowsCache?.length === 3 && !_listRendering);
    const openShare = async () => {
      await page.locator('[data-folder-share="parent"]').click();
      await page.locator('#modal-host [data-share-targets]').waitFor();
    };
    const completed = () => page.waitForFunction(() => !_managerActions && !_treePersisting && document.querySelector('#modal-host').children.length === 0);
    const originalUnknown = clone(tree.children[0].children.slice(0,4));
    await openShare();
    assert.equal(await page.locator('#modal-host [data-repair]').count(), 4);
    assert.match(await page.locator('#modal-host [data-count]').innerText(), /Sharing: 7 projects/);
    assert.match(await page.locator('#modal-host [data-excluded-note]').innerText(), /4 excluded placements unchanged/);
    assert.equal(await page.locator('#modal-host [data-share-project]').count(),7);
    assert.equal(await page.locator('#modal-host [data-share-project="261027_clinical_hcc_liver"] a').getAttribute('href'),origin+'/viewer/index.html#share=261027_clinical_hcc_liver');
    assert.match(await page.locator('#modal-host [data-share-project="261027_clinical_hcc_liver"]').innerText(), /261027_Clinical_HCC_Liver/);
    assert.equal(await page.locator('#modal-host [data-folder-share-url]').getAttribute('href'),origin+'/viewer/index.html#folder=stable-share');
    assert.equal(await page.locator('#modal-host [data-recovery-details]').getAttribute('open'),null);
    assert.equal(await page.locator('#modal-host [data-share-url-details]').getAttribute('open'),null);
    assert.doesNotMatch(await page.locator('#modal-host').innerText(),/unknown-/,'raw placement IDs stay in optional details');
    assert.equal(await page.locator('#modal-host [name="slug"]').getAttribute('readonly'), '');
    assert.deepEqual(pageOffsets, [0, 3, 6], 'full list is fetched despite the three-row cached response');
    await page.locator('#modal-host [name="includesub"]').uncheck();
    assert.match(await page.locator('#modal-host [data-count]').innerText(), /Sharing: 0 projects/);
    assert.equal(await page.locator('#modal-host [data-modal-ok]').isDisabled(),true,'zero confirmed projects cannot be shared');
    assert.equal(publishes, 0); assert.equal(writes, 0);
    await page.locator('#modal-host [name="includesub"]').check();
    if(process.env.SHARE_UI_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.SHARE_UI_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.SHARE_UI_SCREENSHOT_DIR,'folder-share-confirmed-en.png')});
    }
    await page.evaluate(() => AppI18n.setLocale('ja'));
    assert.match(await page.locator('#modal-host [data-count]').innerText(), /共有対象: 7 プロジェクト/);
    if(process.env.SHARE_UI_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.SHARE_UI_SCREENSHOT_DIR,'folder-share-confirmed-ja.png')});
    await page.setViewportSize({width:640,height:868});
    const narrow = await page.locator('#modal-host .modal-card').evaluate(card=>({
      left:card.getBoundingClientRect().left,right:card.getBoundingClientRect().right,
      width:card.clientWidth,content:card.scrollWidth,viewport:innerWidth,
      checkboxWidth:card.querySelector('[name="includesub"]').getBoundingClientRect().width
    }));
    assert.ok(narrow.left>=0 && narrow.right<=narrow.viewport && narrow.content<=narrow.width+1,'the sharing dialog has no horizontal overflow at 640 px');
    assert.ok(narrow.checkboxWidth<24,'the checkbox remains beside its label');
    await page.locator('#modal-host [data-share-project="261027_clinical_hcc_liver"] a').scrollIntoViewIfNeeded();
    await page.locator('#modal-host [data-modal-ok]').scrollIntoViewIfNeeded();
    const submitBounds=await page.locator('#modal-host [data-modal-ok]').boundingBox();
    assert.ok(submitBounds.x>=0 && submitBounds.x+submitBounds.width<=640 && submitBounds.y>=0 && submitBounds.y+submitBounds.height<=868,'the share action remains reachable');
    if(process.env.SHARE_UI_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.SHARE_UI_SCREENSHOT_DIR,'folder-share-confirmed-ja-640.png')});
    await page.setViewportSize({width:1400,height:1000});
    await page.evaluate(() => AppI18n.setLocale('en'));
    assert.doesNotMatch(await page.locator('#modal-host').innerText(), /[ぁ-んァ-ン一-龠]/);
    await page.locator('#modal-host [data-modal-ok]').click();
    await completed();
    assert.equal(publishes, 1); assert.equal(writes, 1);
    assert.deepEqual(pageOffsets, [0, 3, 6, 0, 3, 6], 'submit checks the full catalogue again');
    assert.deepEqual(savedIndex.children.map(n => [n.name, n.children.length]), [['HCC', 3], ['GPX', 1], ['Clinical', 3]]);
    assert.deepEqual(tree.children[0].children.slice(0,4),originalUnknown,'sharing seven confirmed projects keeps every unknown placement unchanged');
    assert.equal(tree.children[0].children[4].shareSlug, 'child-hcc');
    assert.match(alerts.at(-1), /Verified 7 projects/);
    assert.match(alerts.at(-1), /#folder=stable-share/);

    // A local copy discovered in another tab must not turn Cancel into a
    // placement repair: the canonical HCC placement and unknown alias both stay.
    const beforeCancel=clone(tree), callsBeforeCancel=calls.length;
    await openShare();
    await page.evaluate(() => {
      window.__folderSummaryReader=ProjectStorage.listSummaries;
      ProjectStorage.listSummaries=async()=>[{id:'unknown-0',displayName:'New local copy',shareInfo:{slug:'published-0'}}];
    });
    await page.locator('#modal-host [data-modal-cancel]').click();await completed();
    assert.equal(publishes,1);assert.equal(writes,1);
    assert.deepEqual(tree,beforeCancel,'cancelling leaves the saved placements unchanged');
    assert.deepEqual(await page.evaluate(()=>workspaceTree),beforeCancel,'cancelling also preserves the in-memory canonical placement and unresolved alias');
    assert.ok(!calls.slice(callsBeforeCancel).includes('set_workspace_tree'),'Cancel never starts an implicit workspace write');
    await page.evaluate(() => {ProjectStorage.listSummaries=window.__folderSummaryReader;delete window.__folderSummaryReader;});

    // A different local copy becomes identifiable after the target list was
    // reviewed. It must remain excluded from this commit and stay unchanged.
    catalogue.push({slug:'published-later',display_name:'Newly identifiable project'});
    await openShare();
    assert.equal(await page.locator('#modal-host [data-share-project]').count(),7);
    await page.evaluate(() => {
      window.__folderSummaryReader=ProjectStorage.listSummaries;
      ProjectStorage.listSummaries=async()=>[{id:'unknown-0',displayName:'New local copy',shareInfo:{slug:'published-later'}}];
    });
    const firstIndex=clone(savedIndex);
    await page.locator('#modal-host [data-modal-ok]').click();await completed();
    assert.equal(publishes,2);assert.equal(writes,2);
    assert.deepEqual(savedIndex,firstIndex,'unreviewed projects are not added during submit');
    assert.deepEqual(tree.children[0].children.slice(0,4),originalUnknown,'there is no implicit second tree repair after committing');
    await page.evaluate(() => {ProjectStorage.listSummaries=window.__folderSummaryReader;delete window.__folderSummaryReader;});

    // Recovery remains optional: choose an existing target, remove one
    // placement, add a recognized published target, and leave the fourth alone.
    await openShare();
    await page.locator('#modal-host [data-recovery-details] > summary').click();
    await page.locator('#modal-host [data-repair="0"]').selectOption('link:published-0');
    await page.locator('#modal-host [data-repair="1"]').selectOption('remove');
    await page.locator('#modal-host [data-repair="2"]').selectOption('link:published-later');
    assert.equal(await page.locator('#modal-host [data-repair="3"]').inputValue(),'');
    assert.equal(await page.locator('#modal-host [data-share-project]').count(),8);
    await page.evaluate(() => AppI18n.setLocale('ja'));
    assert.equal(await page.locator('#modal-host [data-repair="2"]').inputValue(),'link:published-later');
    await page.evaluate(() => AppI18n.setLocale('en'));
    assert.doesNotMatch(await page.locator('#modal-host').innerText(), /[ぁ-んァ-ン一-龠]/);
    await page.locator('#modal-host [data-modal-ok]').click();await completed();
    assert.equal(publishes,3);assert.equal(writes,3);
    assert.deepEqual(tree.children[0].children[0],{type:'project',slug:'published-later'});
    assert.deepEqual(tree.children[0].children[1],originalUnknown[3]);
    assert.equal(tree.children[0].children[2].shareSlug,'child-hcc');

    // A second-page failure during submit must leave the successful index intact.
    await openShare();
    assert.equal(await page.locator('#modal-host [data-repair]').count(), 1);
    const before = JSON.stringify(savedIndex);
    failOffset = 3;
    await page.locator('#modal-host [data-modal-ok]').click();
    await completed();
    assert.equal(publishes, 3); assert.equal(writes, 3);
    assert.equal(JSON.stringify(savedIndex), before);
    assert.match(alerts.at(-1), /Failed to share: Synthetic network failure/);
    failOffset = null;

    await openShare();
    const removed=catalogue.splice(catalogue.findIndex(row=>row.slug==='261027_clinical_hcc_liver'),1)[0];
    await page.locator('#modal-host [data-modal-ok]').click();await completed();
    assert.equal(publishes,3);assert.equal(writes,3);assert.equal(JSON.stringify(savedIndex),before);
    assert.match(alerts.at(-1),/reviewed share targets changed/,'a reviewed target disappearing cannot shrink the share silently');
    catalogue.push(removed);
    for (const failure of ['conflict', 'missing-protocol']) {
      await openShare();
      if (failure === 'conflict') conflictOnCommit = true; else missingProtocol = true;
      await page.locator('#modal-host [data-modal-ok]').click();
      await completed();
      assert.equal(publishes, 3); assert.equal(writes, 3);
      assert.equal(JSON.stringify(savedIndex), before);
      assert.match(alerts.at(-1), failure === 'conflict' ? /folder structure changed/ : /server update is required/);
    }
    assert.equal(tree.children[1].name, 'Concurrent change', 'a concurrent edit survives the failed CAS');
    assert.ok(!calls.includes('set_workspace_tree') && !calls.includes('publish_folder_share') && !calls.includes('publish_folder_share_checked'), 'the selected share path never falls back or issues a second write');
    assert.equal(calls.filter(name => name === 'list_projects').length, 0, 'sharing cannot fall back to a partial admin-password list');
    assert.deepEqual(await page.evaluate(() => AppI18n.getMissingKeys()), []);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log('Folder sharing browser regression: PASS (confirmed names/URLs, 7 shared + 4 unchanged unknown placements, safe cancellation, frozen selection, optional recovery, zero/deleted targets, complete pagination, atomic CAS, no fallback, JA/EN)');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
