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
        const data = catalogue.slice(from, from + 3);
        return respond(data, {status: 206, headers: {...headers, 'content-range': `${from}-${from + data.length - 1}/${catalogue.length}`}});
      }
      if (name === 'get_workspace_tree') return respond(tree);
      if (name === 'publish_folder_share_checked') {
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
        const slugs=[], walk=nodes=>{for(const n of nodes)n.type==='folder'?walk(n.children):slugs.push(n.slug);};
        walk(body._index_doc.children);
        publishes++; writes++; tree=clone(body._tree); savedIndex = clone(body._index_doc);
        return respond({slug:'stable-share',project_count:new Set(slugs).size,placement_count:slugs.length,project_slugs:[...new Set(slugs)].sort()});
      }
      if (name === 'get_folder_index') return respond({name: 'Parent', index_doc: savedIndex, is_public: true});
      unexpected.push('Unmocked RPC: ' + name);
      return respond({message: 'Unexpected fixture operation'}, {status: 400});
    });
    await page.goto(origin + '/index.html');
    await page.waitForFunction(() => typeof serverRowsCache !== 'undefined' && serverRowsCache?.length === 3 && !_listRendering);
    await page.locator('[data-folder-share="parent"]').click();
    await page.locator('#modal-host [data-repair="0"]').waitFor();
    assert.equal(await page.locator('#modal-host [data-repair]').count(), 4);
    assert.match(await page.locator('#modal-host [data-count]').innerText(), /7 projects \/ 11 placements\. Unresolved: 4/);
    assert.equal(await page.locator('#modal-host [name="slug"]').getAttribute('readonly'), '');
    assert.deepEqual(pageOffsets, [0, 3, 6], 'full list is fetched despite the three-row cached response');
    await page.locator('#modal-host [data-modal-ok]').click();
    assert.match(await page.locator('#modal-host [data-err]').innerText(), /Some placements are unresolved/);
    assert.equal(publishes, 0); assert.equal(writes, 0);
    await page.locator('#modal-host [name="includesub"]').uncheck();
    assert.match(await page.locator('#modal-host [data-count]').innerText(), /0 projects \/ 4 placements/);
    await page.locator('#modal-host [name="includesub"]').check();
    await page.locator('#modal-host [data-repair="0"]').selectOption('link:published-0');
    await page.evaluate(() => AppI18n.setLocale('ja'));
    assert.equal(await page.locator('#modal-host [data-repair="0"]').inputValue(), 'link:published-0');
    await page.evaluate(() => AppI18n.setLocale('en'));
    await page.locator('#modal-host [data-repair="1"]').selectOption('link:published-1');
    await page.locator('#modal-host [data-repair="2"]').selectOption('remove');
    await page.locator('#modal-host [data-repair="3"]').selectOption('link:published-6');
    assert.match(await page.locator('#modal-host [data-count]').innerText(), /Ready to share: 7 projects \/ 7 placements\. Unresolved: 0/);
    assert.doesNotMatch(await page.locator('#modal-host').innerText(), /[ぁ-んァ-ン一-龠]/);
    await page.locator('#modal-host [data-modal-ok]').click();
    await page.waitForFunction(() => !_managerActions && !_treePersisting && document.querySelector('#modal-host').children.length === 0);
    assert.equal(publishes, 1); assert.equal(writes, 1);
    assert.deepEqual(pageOffsets, [0, 3, 6, 0, 3, 6], 'submit checks the full catalogue again');
    assert.deepEqual(savedIndex.children.map(n => [n.name, n.children.length]), [['HCC', 3], ['GPX', 1], ['Clinical', 3]]);
    assert.deepEqual(tree.children[0].children.map(n => n.id), ['hcc', 'gpx', 'clinical']);
    assert.equal(tree.children[0].children[0].shareSlug, 'child-hcc');
    assert.match(alerts.at(-1), /Verified 7 projects/);
    assert.match(alerts.at(-1), /#folder=stable-share/);

    // A second-page failure during submit must leave the successful index intact.
    await page.locator('[data-folder-share="parent"]').click();
    await page.locator('#modal-host [name="slug"]').waitFor();
    assert.equal(await page.locator('#modal-host [data-repair]').count(), 0);
    const before = JSON.stringify(savedIndex);
    failOffset = 3;
    await page.locator('#modal-host [data-modal-ok]').click();
    await page.waitForFunction(() => !_managerActions && !_treePersisting);
    assert.equal(publishes, 1); assert.equal(writes, 1);
    assert.equal(JSON.stringify(savedIndex), before);
    assert.match(alerts.at(-1), /Failed to share: Synthetic network failure/);
    failOffset = null;
    for (const failure of ['conflict', 'missing-protocol']) {
      await page.locator('[data-folder-share="parent"]').click();
      await page.locator('#modal-host [name="slug"]').waitFor();
      if (failure === 'conflict') conflictOnCommit = true; else missingProtocol = true;
      await page.locator('#modal-host [data-modal-ok]').click();
      await page.waitForFunction(() => !_managerActions && !_treePersisting);
      assert.equal(publishes, 1); assert.equal(writes, 1);
      assert.equal(JSON.stringify(savedIndex), before);
      assert.match(alerts.at(-1), failure === 'conflict' ? /folder structure changed/ : /server update is required/);
    }
    assert.equal(tree.children[1].name, 'Concurrent change', 'a concurrent edit survives the failed CAS');
    assert.ok(!calls.includes('set_workspace_tree') && !calls.includes('publish_folder_share'), 'the checked share path never falls back to an unconditional write');
    assert.equal(calls.filter(name => name === 'list_projects').length, 0, 'sharing cannot fall back to a partial admin-password list');
    assert.deepEqual(await page.evaluate(() => AppI18n.getMissingKeys()), []);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log('Folder sharing browser regression: PASS (complete pagination, unresolved recovery, hierarchy, stable URL, atomic RPC, CAS conflict, safe upgrade requirement, readback, JA/EN)');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
