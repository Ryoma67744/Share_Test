'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const adapter = fs.readFileSync(path.join(root, 'offline/local-mrm.js'), 'utf8');
function storage() {
    const data = new Map();
    return { getItem: k => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}
function context(localStorage, offline = true) {
    const c = vm.createContext({ console, crypto, localStorage, sessionStorage: storage(), navigator: {},
        document: { addEventListener() {} }, DESI_OFFLINE: offline,
        supabase: { createClient() { throw new Error('Unexpected cloud client'); } },
        setTimeout, clearTimeout, Map, Set, URL, Blob });
    c.window = c;
    vm.runInContext(adapter, c); return c;
}
function appScript(file) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    for (const code of scripts) new vm.Script(code, { filename: file });
    return scripts.find(code => code.trim().startsWith("'use strict';"));
}
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function gateDocument() {
    const ui = { closed: false, submitHandler: null, error: { textContent: '' }, submit: {}, input: { value: 'test-password', focus() {}, select() {} } };
    const form = { addEventListener(event, handler) { if (event === 'submit') ui.submitHandler = handler; } };
    const nodes = { '[data-err]': ui.error, '[data-modal-ok]': ui.submit, '[name="pw"]': ui.input, form };
    const element = () => ({ appendChild() {}, addEventListener() {}, remove() { ui.closed = true; }, querySelector: selector => nodes[selector] });
    ui.document = { addEventListener() {}, getElementById: element, createElement: element };
    ui.send = async () => { assert.equal(typeof ui.submitHandler, 'function'); ui.submitHandler({ preventDefault() {} }); await flush(); };
    return ui;
}
async function verifyOnlineGateAndRouting(file) {
    const c = context(storage(), false), ui = gateDocument(), calls = [];
    let response = 'network-error';
    c.document = ui.document;
    c.console = { ...console, warn() {} };
    c.SUPABASE_URL = 'https://unit-test.invalid'; c.SUPABASE_ANON_KEY = 'test-anon';
    c.DesiLocalMrm = { rpc() { throw new Error('Online request reached the local backend'); } };
    c.supabase = { createClient(url, key, options) {
        assert.equal(url, c.SUPABASE_URL); assert.equal(key, 'test-anon'); assert.equal(options.auth.persistSession, false);
        return { async rpc(name, args) {
            calls.push([name, plain(args)]);
            if (response === 'network-error') throw new Error('offline network');
            if (name === 'verify_master_pw') return { data: response === 'valid', error: null };
            return { data: [{ id: 'cloud-row' }], error: null };
        } };
    } };
    vm.runInContext(appScript(file), c);
    assert.equal(vm.runInContext('SupabaseClient.configured()', c), true);
    if (file === 'mrm.html') assert.equal(vm.runInContext('SupabaseClient.libraryAvailable()', c), true);
    let unlocked = false;
    const gate = vm.runInContext('requireMasterUnlock()', c).then(result => { unlocked = result; });
    await ui.send();
    assert.equal(unlocked, false, file + ': a network failure must leave the real gate pending');
    assert.equal(ui.closed, false); assert.match(ui.error.textContent, /接続できません/);
    assert.equal(c.sessionStorage.getItem('desi:masterUnlocked'), null);
    assert.equal(c.sessionStorage.getItem('desi:masterPw'), null);
    assert.equal(c.DESI_OFFLINE, false, 'network errors must not change runtime mode');
    response = 'denied'; await ui.send();
    assert.equal(unlocked, false); assert.equal(ui.closed, false); assert.match(ui.error.textContent, /違います/);
    assert.equal(c.sessionStorage.getItem('desi:masterUnlocked'), null);
    response = 'valid'; await ui.send(); await gate;
    assert.equal(unlocked, true); assert.equal(ui.closed, true);
    assert.equal(JSON.parse(c.sessionStorage.getItem('desi:masterPw')).pw, 'test-password');
    assert.equal(await vm.runInContext('requireMasterUnlock()', c), true, 'online session keeps its established TTL behavior');
    assert.deepEqual(calls.slice(0, 3), Array(3).fill(['verify_master_pw', { _pw: 'test-password' }]));
    if (file === 'mrm.html') {
        const rows = await vm.runInContext('SupabaseClient.listMrmLibrary("real-master")', c);
        assert.equal(rows[0].id, 'cloud-row');
        assert.deepEqual(calls.at(-1), ['list_mrm_library', { _master_pw: 'real-master' }]);
        vm.runInContext('renderLibrary = () => {}; loadLibrary = async () => {}; var expServices = expEditorServices()', c);
        assert.deepEqual(Object.keys(vm.runInContext('expServices', c)).sort(), [
            'getDocument', 'getLibrary', 'getPassword', 'library', 'listDocuments', 'refreshLibrary', 'registerRows', 'saveDocument',
        ]);
        await vm.runInContext('expServices.refreshLibrary()', c);
        assert.equal(vm.runInContext('expServices.getLibrary()[0].id', c), 'cloud-row');
        await vm.runInContext('expServices.registerRows([{row_id:"channel-1"}])', c);
        assert.deepEqual(calls.at(-1), ['register_from_exp_batch', { _master_pw: 'test-password', _rows: [{row_id:'channel-1'}] }]);
        await vm.runInContext('expServices.saveDocument({name:"Method",payload:{version:1},id:"doc-1",expected_revision:2})', c);
        assert.deepEqual(calls.at(-1), ['save_mrm_exp_document', {
            _master_pw: 'test-password', _name: 'Method', _payload: {version:1}, _id: 'doc-1', _expected_revision: 2,
        }]);
        await vm.runInContext('expServices.listDocuments()', c);
        assert.deepEqual(calls.at(-1), ['list_mrm_exp_documents', { _master_pw: 'test-password' }]);
        await vm.runInContext('expServices.getDocument("doc-1")', c);
        assert.deepEqual(calls.at(-1), ['get_mrm_exp_document', { _master_pw: 'test-password', _id: 'doc-1' }]);
    } else {
        await vm.runInContext('SupabaseClient.listProjectsV2("real-master")', c);
        assert.deepEqual(calls.at(-1), ['list_projects_v2', { _master_pw: 'real-master' }]);
    }
    assert.equal(c.localStorage.getItem('desi:offlineMrm:v1'), null, 'online requests must not create an offline library');
    c.sessionStorage.setItem('desi:masterUnlocked', JSON.stringify({ expiresAt: Date.now() - 1 }));
    c.sessionStorage.setItem('desi:masterPw', JSON.stringify({ pw: 'expired', expiresAt: Date.now() - 1 }));
    assert.equal(vm.runInContext('isMasterUnlocked()', c), false);
    assert.equal(vm.runInContext(file === 'mrm.html' ? '_readCachedMasterPw()' : 'readCachedMasterPw()', c), '');

    const unconfigured = context(storage(), false);
    vm.runInContext(appScript(file), unconfigured);
    assert.deepEqual(plain(await vm.runInContext('tryServerUnlock("anything")', unconfigured)), { ok: false, transient: true });
    assert.equal(unconfigured.sessionStorage.getItem('desi:masterUnlocked'), null);
}
async function main() {
    // Relative assets support repository-subpath hosting as well as loopback.
    for (const file of ['index.html', 'mrm.html']) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        const sources = [...source.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
        assert.deepEqual(sources.slice(0, 3), ['runtime-config.js', 'app-runtime.js', 'offline/offline.js']);
        assert.ok(sources.includes('vendor/supabase.min.js'));
        for (const src of sources) assert.ok(new URL(src, 'https://example.invalid/Share_Test/' + file).pathname.startsWith('/Share_Test/'), src + ' escapes the app subpath');
        assert.doesNotMatch(source, /window\.SUPABASE_(?:URL|ANON_KEY)\s*=/, 'runtime config must remain authoritative');
        await verifyOnlineGateAndRouting(file);
    }
    const ls = storage(); let c = context(ls); let api = c.DesiLocalMrm;
    assert.equal(context(storage(), false).DesiLocalMrm, undefined, 'offline adapter must never install in online mode');
    const rpc = (name, args) => api.rpc(name, args);
    const cid = await rpc('upsert_compound', { _name: 'Alanine', _tags: ['amino'], _shelf: 'archive', _check_level: 'lit' });
    const tid = await rpc('upsert_transition', { _compound_id: cid, _precursor: 90.1, _product: 44.1, _ce: 10, _cv: 20, _is_recommended: true });
    assert.equal(await rpc('upsert_transition', { _compound_id: cid, _precursor: '90.1', _product: 44.1, _ce: 10, _cv: 20 }), tid);
    await rpc('record_usage', { _transition_id: tid, _project_slug: 'old-cloud-slug', _project_local_id: 'local-project', _project_name: 'Sample 1', _sample_types: ['肝臓'] });
    await rpc('register_measured_compound', { _name: 'Alanine', _tags: ['new'], _shelf: 'main', _precursor: 90.1, _product: 44.1, _ce: 10, _cv: 20 });
    let rows = await rpc('list_mrm_library');
    assert.equal(rows[0].shelf, 'archive', 're-import must preserve existing shelf');
    assert.deepEqual(plain(rows[0].tags), ['amino', 'new']);
    assert.equal(rows[0].transitions[0].usages[0].project_slug, null, 'cloud routes are not retained for new usages');
    assert.equal(rows[0].transitions[0].usages[0].project_local_id, 'local-project');
    assert.equal((await rpc('search_projects_by_compound_master', { _query: 'Alanine' }))[0].slug, 'local-project');
    const batch = await rpc('register_from_result_batch', { _rows: [
        { name: 'Glycine', precursor: 76, product: 30, project_local_id: 'local-2', sample_types: ['脳'] },
        { name: 'Invalid row', precursor: 'not-a-number' },
        { name: 'Serine', precursor: 106, product: 60 },
    ] });
    assert.equal(batch.ok_count, 2); assert.equal(batch.failed, 1);
    assert.equal((await rpc('list_mrm_library')).some(x => x.name === 'Invalid row'), false, 'failed batch row must roll back');
    await rpc('update_compound', { _id: cid, _name: 'L-Alanine', _tags: ['edited'], _shelf: 'main', _check_level: 'std' });
    await rpc('update_transition', { _id: tid, _precursor: 90.1, _product: 44.2, _ce: 11, _cv: 21, _is_recommended: true });
    await rpc('set_exp_template', { _content: 'A local .exp template' });
    const sid = await rpc('upsert_mrm_set', { _name: 'Local Method', _items: [{ name: 'L-Alanine', transition_id: tid, precursor: 90.1, product: 44.2, ce: 11, cv: 21 }] });
    const backup = api.exportDocument();
    // A new page/session reads persisted values, independently of its in-memory objects.
    c = context(ls); api = c.DesiLocalMrm;
    rows = await rpc('list_mrm_library');
    assert.equal(rows[0].name, 'L-Alanine'); assert.equal(rows[0].transitions[0].product, 44.2);
    assert.equal(await rpc('get_exp_template'), 'A local .exp template');
    assert.equal((await rpc('list_mrm_sets'))[0].items[0].position, 1);
    const before = JSON.stringify(api.exportDocument());
    await assert.rejects(api.importDocument({ format: 'wrong' }));
    assert.equal(JSON.stringify(api.exportDocument()), before, 'invalid import must leave all persisted data intact');
    await rpc('delete_transition', { _id: tid }); assert.equal((await rpc('list_mrm_library'))[0].transitions.length, 0);
    await rpc('delete_compound', { _id: cid }); await rpc('delete_mrm_set', { _id: sid });
    assert.equal((await rpc('list_mrm_sets')).length, 0);
    await api.importDocument(backup); assert.equal((await rpc('list_mrm_library'))[0].transitions[0].usages.length, 1);
    const quota = ls.setItem; ls.setItem = () => { throw new Error('QuotaExceededError'); };
    await assert.rejects(rpc('delete_compound', { _id: cid }), /QuotaExceeded/);
    ls.setItem = quota; assert.equal((await rpc('list_mrm_library')).some(x => x.id === cid), true);

    const manager = context(storage());
    vm.runInContext(appScript('index.html'), manager);
    assert.equal(await vm.runInContext('requireMasterUnlock()', manager), true);
    vm.runInContext('markMasterUnlocked("offline-local"); saveCachedOwnerPw("offline-local")', manager);
    assert.equal(manager.sessionStorage.getItem('desi:masterUnlocked'), null);
    assert.equal(manager.sessionStorage.getItem('desi:masterPw'), null);
    assert.equal(manager.sessionStorage.getItem('desi:ownerPw'), null);
    assert.equal(vm.runInContext('SupabaseClient.configured()', manager), false);
    await vm.runInContext('loadWorkspaceTree()', manager);
    await vm.runInContext(`workspaceTree.children.push({type:'folder',id:'folder-1',name:'実験',children:[{type:'project',localId:'local-project'}]}); renderList = async () => {}; _persistTreeAndRender()`, manager);
    await vm.runInContext('workspaceTree = null; loadWorkspaceTree()', manager);
    assert.equal(vm.runInContext('workspaceTree.children[0].name', manager), '実験');
    await vm.runInContext('ProjectStorage.listSummaries = async () => [{id:"local-project",displayName:"Offline",shareInfo:{slug:"stale",url:"https://example.com"}}]; serverRowsCache=[{slug:"cloud-only"}]', manager);
    const localRows = await vm.runInContext('buildRows()', manager);
    assert.equal(localRows.length, 1); assert.equal(localRows[0].local.shareInfo, null);
    manager.TEST_ROW = localRows[0];
    const html = vm.runInContext('rowHtml(TEST_ROW)', manager);
    assert.match(html, /open-local/); assert.doesNotMatch(html, /change-pw|copy-url|open-server|open-share|delete-server/);
    const mrm = context(storage()); vm.runInContext(appScript('mrm.html'), mrm);
    assert.equal(await vm.runInContext('requireMasterUnlock()', mrm), true);
    assert.equal(vm.runInContext('SupabaseClient.configured()', mrm), false);
    assert.equal(vm.runInContext('SupabaseClient.libraryAvailable()', mrm), true);
    assert.equal((await vm.runInContext('SupabaseClient.listMrmLibrary("")', mrm)).length, 0);
    const localCompoundId = await mrm.DesiLocalMrm.rpc('upsert_compound', { _name: 'Offline lactate', _polarity: '-' });
    await mrm.DesiLocalMrm.rpc('upsert_transition', { _compound_id: localCompoundId, _precursor: 89, _product: 43, _ce: 11, _cv: 20 });
    vm.runInContext('var originalRenderLibrary = renderLibrary; renderLibrary = () => {}; var localExpServices = expEditorServices()', mrm);
    const localExpServices = vm.runInContext('localExpServices', mrm);
    assert.equal(localExpServices.getPassword(), 'offline-local');
    for (const key of ['registerRows', 'saveDocument', 'listDocuments', 'getDocument']) {
        assert.equal(localExpServices[key], undefined, 'offline .exp must not expose unsupported RPC: ' + key);
    }
    await localExpServices.refreshLibrary();
    const { libraryChoices } = await import('../mrm/exp-editor.mjs');
    const replacement = libraryChoices(localExpServices.getLibrary())[0];
    assert.equal(replacement.name, 'Offline lactate'); assert.equal(replacement.polarity, '-');
    assert.equal(replacement.precursor, 89); assert.equal(replacement.ce, 11);
    await mrm.DesiLocalMrm.rpc('upsert_compound', { _name: 'Later local row', _polarity: '+' });
    await localExpServices.refreshLibrary();
    assert.equal(localExpServices.getLibrary().length, 2, 'the editor reads the current persisted local library');
    assert.equal(mrm.sessionStorage.getItem('desi:masterPw'), null);
    // Restore the initial empty library for the existing empty-state regression below.
    await mrm.DesiLocalMrm.importDocument({format:'desi-offline-mrm',version:1,compounds:[],sets:[],template:null,ignored:[]});
    await localExpServices.refreshLibrary();
    vm.runInContext('renderLibrary = originalRenderLibrary', mrm);
    vm.runInContext('markMasterUnlocked(_readCachedMasterPw())', mrm);
    assert.equal(mrm.sessionStorage.getItem('desi:masterUnlocked'), null);
    assert.equal(mrm.sessionStorage.getItem('desi:masterPw'), null);
    const lib = { innerHTML: '' }; mrm.document.getElementById = () => lib;
    vm.runInContext('renderShelfTabs=()=>{}; renderFilterBar=()=>{}; renderSelectedPanel=()=>{}; currentShelf="archive"; renderLibrary()', mrm);
    assert.match(lib.innerHTML, /一括登録/); assert.doesNotMatch(lib.innerHTML, /実測棚卸し/);
    vm.runInContext('window.DesiLocalMrm = undefined', mrm);
    assert.equal(vm.runInContext('SupabaseClient.libraryAvailable()', mrm), false);
    await vm.runInContext('loadLibrary()', mrm);
    assert.match(lib.innerHTML, /ローカルMRMの部品/);
    console.log('online/offline manager + MRM regression tests: PASS');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
