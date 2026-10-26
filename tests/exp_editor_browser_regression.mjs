import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseExp } from '../mrm/exp-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolve(root, 'tests/fixtures/exp/flat-mrm-synthetic.exp');
const selectionFixture = resolve(root, 'tests/fixtures/exp/flat-mrm-selection-synthetic.exp');
// UI tests use injected in-memory services. No Supabase or real account is used.
const harness = `<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/mrm/exp-editor.css"><title>MRM editor test fixture</title>
<button id="open">.exp 編集を開く</button>
<script type="module">
import { openExpEditor } from '/mrm/exp-editor.mjs';
const library = [{id:'11111111-1111-4111-8111-111111111111',name:'Lactate-NEG',polarity:'-',shelf:'main',check_level:'std',tags:['keep'],updated_at:'2026-10-26T00:00:00Z',transitions:[{id:'22222222-2222-4222-8222-222222222222',precursor:89,product:43,ce:11,cv:20,role:'keep',is_recommended:true}]}];
let cached = structuredClone(library);
const documents = new Map();
window.fixtureState = {library,calls:[],documents};
document.getElementById('open').onclick = () => openExpEditor({
 library:cached,getLibrary:()=>cached,refreshLibrary:async()=>{cached=structuredClone(library);return cached;},getPassword:()=> 'fixture-password',
 registerRows:async rows=>{
   for(const row of rows) if(row.expected && row.expected.updated_at!==library[0].updated_at) throw new Error('Library changed; refresh preview');
   window.fixtureState.calls.push({type:'register',rows:structuredClone(rows)});
   return {ok_count:rows.length,results:rows.map(row=>({row_id:row.row_id,action:'created'}))};
 },
 saveDocument:async doc=>{
   const old=doc.id && documents.get(doc.id);
   if(doc.id && (!old || old.revision!==doc.expected_revision)) throw new Error('Document changed; reload');
   const original=Uint8Array.from(atob(doc.payload.originalBase64),character=>character.charCodeAt(0));
   const source_sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',original)),byte=>byte.toString(16).padStart(2,'0')).join('');
   const saved={id:doc.id || 'doc-'+(documents.size+1),name:doc.name,payload:structuredClone(doc.payload),source_sha256,revision:(old?.revision||0)+1,updated_at:'2026-10-26T00:00:00Z'};
   documents.set(saved.id,saved);window.fixtureState.calls.push({type:'save',doc:structuredClone(doc)});return saved;
 },
 listDocuments:async()=>[...documents.values()].map(({payload,...metadata})=>metadata),
 getDocument:async id=>structuredClone(documents.get(id)),
});
window.fixtureReady=true;
</script></html>`;

export async function startFixtureServer() {
    const server = createServer(async (req, res) => {
        try {
            const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
            if (pathname === '/__exp_fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(harness); return; }
            const path = resolve(root, '.' + pathname);
            if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
            const content = await readFile(path);
            res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] || 'application/octet-stream');
            res.end(content);
        } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/__exp_fixture` };
}

async function downloadBytes(page, action) {
    const pending = page.waitForEvent('download');
    await action();
    const download = await pending;
    return { bytes: await readFile(await download.path()), name: download.suggestedFilename() };
}

async function run() {
    const { server, url } = await startFixtureServer();
    if (process.argv.includes('--serve')) { console.log(url); return; }
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(url); await page.waitForFunction(() => window.fixtureReady);
        await page.getByRole('button', { name: '.exp 編集を開く', exact: true }).click();
        await page.getByLabel('.exp ファイルを選択', { exact: true }).setInputFiles(fixture);
        await page.getByLabel('1 行目 CE（衝突）', { exact: true }).waitFor();
        const source = await readFile(fixture);
        const exportButton = page.getByRole('button', { name: /^選択したMRMを \.exp 保存/ });
        let output = await downloadBytes(page, () => exportButton.click());
        assert.deepEqual(output.bytes, source, 'Untouched browser download equals source bytes');
        await page.getByLabel('2 行目を選択', { exact: true }).uncheck();
        assert.equal(await exportButton.isDisabled(), true, 'Unsupported structure blocks partial export instead of including unchecked rows');
        await page.getByLabel('2 行目を選択', { exact: true }).check();
        const ce = page.getByLabel('1 行目 CE（衝突）', { exact: true });
        await ce.fill('15');
        output = await downloadBytes(page, () => exportButton.click());
        assert.equal(output.bytes.toString(), source.toString().replace('CollisionEnergy(eV)_1,11.0000', 'CollisionEnergy(eV)_1,15'));
        assert.equal(await page.evaluate(() => window.fixtureState.calls.length), 0, 'Editing and download do not write library or methods');
        await ce.fill('Infinity');
        assert.equal(await exportButton.isDisabled(), true);
        assert.equal(await ce.getAttribute('aria-invalid'), 'true');
        await ce.fill('15');
        const q1 = page.getByLabel('1 行目 Precursor', { exact: true });
        await q1.fill('90');
        output = await downloadBytes(page, () => exportButton.click());
        assert.match(output.bytes.toString(), /SIRMass1,90\n/);
        assert.match(output.bytes.toString(), /Mass\(amu\)_1,90\n/);
        await q1.fill('89');

        const draft = await downloadBytes(page, () => page.getByRole('button', { name: '作業ファイルを保存', exact: true }).click());
        await ce.fill('17');
        await page.locator('input[type=file][accept=".json"]').setInputFiles({ name: draft.name, mimeType: 'application/json', buffer: draft.bytes });
        await page.waitForFunction(() => document.querySelector('[aria-label="1 行目 CE（衝突）"]').value === '15');
        // Invalid replacement must keep the document the user is editing.
        await page.getByLabel('.exp ファイルを選択', { exact: true }).setInputFiles({name:'broken.exp',mimeType:'text/plain',buffer:Buffer.from('not an exp')});
        await page.getByRole('status').filter({hasText:'必須項目'}).waitFor();
        assert.equal(await ce.inputValue(), '15');

        await page.getByRole('button', { name: '選択したMRMをライブラリへ登録', exact: true }).click();
        const commit = page.getByRole('button', { name: 'この内容を登録する', exact: true });
        assert.equal(await commit.isDisabled(), true, 'New compound destination and new condition acknowledgement are required');
        assert.equal(await page.getByRole('combobox', { name: '極性', exact: true }).isDisabled(), true);
        await page.getByRole('combobox', { name: '新規化合物の登録先', exact: true }).selectOption('archive');
        await page.getByRole('checkbox', { name: /既存化合物へ条件を追加します/ }).check();
        // Server changes after preview: reject stale payload, then explicitly refresh.
        await page.evaluate(() => { window.fixtureState.library[0].updated_at='2026-10-26T01:00:00Z'; });
        await commit.click();
        await page.getByRole('status').filter({hasText:'Library changed'}).waitFor();
        await page.getByRole('button', { name: '再照合する', exact: true }).click();
        await page.getByRole('checkbox', { name: /既存化合物へ条件を追加します/ }).check();
        await commit.click();
        await page.getByRole('status').filter({hasText:'2 行の登録処理が完了'}).waitFor();
        const sent = await page.evaluate(() => window.fixtureState.calls.find(call => call.type==='register').rows);
        assert.equal(sent[0].ce, '15'); assert.equal(sent[0].allow_new_condition, true);
        assert.equal(sent[1].shelf, 'archive');
        assert.equal(await page.evaluate(() => window.fixtureState.library[0].transitions[0].ce), 11);

        await page.getByRole('button', { name: 'メソッドとして保存', exact: true }).click();
        await page.getByLabel('メソッド名', { exact: true }).fill('試験メソッド');
        await page.getByRole('button', { name: '新規保存', exact: true }).click();
        await page.getByRole('status').filter({hasText:'版 1'}).waitFor();
        await ce.fill('18');
        await page.getByRole('button', { name: '保存したメソッドを開く', exact: true }).click();
        await page.getByRole('button', { name: '開く', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[aria-label="1 行目 CE（衝突）"]').value === '15');

        // On a supported fixed-dwell layout, the download contains checked rows only.
        await page.getByLabel('.exp ファイルを選択', { exact: true }).setInputFiles({
            name: 'flat-mrm-selection-synthetic.exp', mimeType: 'application/octet-stream',
            buffer: Buffer.concat([Buffer.from('GENERAL INFORMATION\r\n'), await readFile(selectionFixture)]),
        });
        await page.getByText(/flat-mrm-selection-synthetic\.exp/).waitFor();
        await page.getByLabel('1 行目を選択', { exact: true }).uncheck();
        await ce.fill('Infinity'); // An unchecked invalid value is not exported.
        await page.getByLabel('2 行目 CE（衝突）', { exact: true }).fill('17');
        assert.equal(await exportButton.isDisabled(), false);
        assert.match(await exportButton.innerText(), /1件/);
        output = await downloadBytes(page, () => exportButton.click());
        const selected = parseExp(output.bytes);
        assert.equal(selected.rows.length, 1);
        assert.equal(selected.rows[0].name, 'NEG_13C-Lactate-NEG');
        assert.equal(selected.rows[0].ce, '17');
        assert.equal(selected.rows[0].details.dwell, '0.0200');
        assert.equal(selected.rows[0].details.delay, '0.0042');
        assert.match(output.bytes.toString(), /FunctionScanTime\(sec\),0\.0242/);
        assert.ok(output.bytes.toString().startsWith('GENERAL INFORMATION\r\n'), 'Section header is retained in the actual download');
        assert.equal(await page.getByRole('textbox', { name: /^\d+ 行目 化合物名$/ }).count(), 2, 'Export does not delete rows from the working document');
        await page.getByText(/未保存/).waitFor();
        await page.getByLabel('2 行目を選択', { exact: true }).uncheck();
        assert.equal(await exportButton.isDisabled(), true, 'Zero selected rows cannot be downloaded');
        await page.getByLabel('2 行目を選択', { exact: true }).check();
        await ce.fill('19');
        const selectedDraft = await downloadBytes(page, () => page.getByRole('button', { name: '作業ファイルを保存', exact: true }).click());
        await page.getByLabel('1 行目を選択', { exact: true }).check();
        await page.locator('input[type=file][accept=".json"]').setInputFiles({ name: selectedDraft.name, mimeType: 'application/json', buffer: selectedDraft.bytes });
        await page.waitForFunction(() => !document.querySelector('[aria-label="1 行目を選択"]').checked);
        assert.equal(await page.getByLabel('2 行目を選択', { exact: true }).isChecked(), true);
        await page.getByRole('button', { name: 'メソッドとして保存', exact: true }).click();
        await page.getByLabel('メソッド名', { exact: true }).fill('選択保存メソッド');
        await page.getByRole('button', { name: '新規保存', exact: true }).click();
        await page.getByRole('status').filter({hasText:'版 1'}).waitFor();
        await page.getByLabel('1 行目を選択', { exact: true }).check();
        await page.getByRole('button', { name: '保存したメソッドを開く', exact: true }).click();
        await page.getByRole('combobox', { name: '保存したメソッド', exact: true }).selectOption('doc-2');
        await page.getByRole('button', { name: '開く', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('[aria-label="1 行目を選択"]').checked);
        assert.equal(await page.getByLabel('2 行目を選択', { exact: true }).isChecked(), true);
        await page.setViewportSize({width:800,height:900});
        assert.equal(await exportButton.isVisible(), true);
        assert.deepEqual(errors, [], 'No browser runtime errors');
        console.log('exp browser regression: all workflows passed');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    run().catch(error => { console.error(error); process.exitCode = 1; });
}
