'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { build, commonFiles, readLock, sha256, walkFiles, OWNER_FILE } = require('../tools/build.cjs');
const { fetchRuntime } = require('../tools/fetch-runtime.cjs');
const { createManifest } = require('../offline/make-manifest.cjs');
const { verifyPackage } = require('../offline/server.cjs');
const JSZip = require('../vendor/jszip.min.js');
const root = path.resolve(__dirname, '..');
const commit = '1234567890abcdef1234567890abcdef12345678';
function put(dir, rel, data) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), data);
}
function snapshot(dir, files = walkFiles(dir)) {
  return Object.fromEntries(files.map(file => [file, sha256(fs.readFileSync(path.join(dir, file)))]));
}
function appConfiguration(dir) {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(dir, 'runtime-config.js'), 'utf8'), ctx);
  return JSON.parse(JSON.stringify(ctx.window.DESI_BUILD_CONFIG));
}
function assertProjectBaseResources(dir) {
  const base = 'https://example.invalid/Share_Test/';
  for (const page of ['index.html', 'mrm.html', 'viewer/index.html']) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]);
    assert.ok(refs.length > 0, page + ' resources');
    for (const ref of refs) {
      const resolved = new URL(ref, base + page);
      assert.ok(resolved.href.startsWith(base), page + ': resource must remain under /Share_Test/: ' + ref);
      assert.ok(fs.existsSync(path.join(dir, decodeURIComponent(resolved.pathname.slice('/Share_Test/'.length)))), page + ': missing resource ' + ref);
    }
  }
}
async function testRuntimeDownload(temp) {
  const target = path.join(temp, 'fetch-source');
  const bytes = { runtime: Buffer.from('small pinned runtime fixture'), license: Buffer.from('small pinned license fixture') };
  const runtime = { version: 'v24.21.0', url: 'https://nodejs.org/dist/v24.21.0/win-x64/node.exe',
    licenseUrl: 'https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE',
    sha256: sha256(bytes.runtime), licenseSha256: sha256(bytes.license) };
  put(target, 'assets.lock.json', JSON.stringify({ runtime }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(url === runtime.url ? bytes.runtime : bytes.license);
  };
  assert.equal((await fetchRuntime({ root: target, fetchImpl })).downloaded, 2);
  assert.deepEqual(calls, [runtime.url, runtime.licenseUrl]);
  assert.equal((await fetchRuntime({ root: target, fetchImpl: () => assert.fail('verified files must be reused') })).downloaded, 0);
  const oldRuntime = Buffer.from('previous runtime left intact on failed download');
  put(target, 'runtime/node.exe', oldRuntime);
  put(target, 'runtime/LICENSE.txt', 'previous license');
  await assert.rejects(() => fetchRuntime({ root: target, fetchImpl: async url => new Response(url === runtime.url ? bytes.runtime : 'corrupt license') }), /checksum mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(target, 'runtime/node.exe')), oldRuntime, 'all downloaded files must validate before replacement');
  assert.equal(fs.readFileSync(path.join(target, 'runtime/LICENSE.txt'), 'utf8'), 'previous license');
  assert.ok(!fs.readdirSync(path.join(target, 'runtime')).some(name => name.includes('.download-')));
  put(target, 'assets.lock.json', JSON.stringify({ runtime: { ...runtime, url: 'https://untrusted.invalid/node.exe' } }));
  await assert.rejects(() => fetchRuntime({ root: target, fetchImpl: () => assert.fail('invalid URL must not be fetched') }), /pinned official/);
}
async function main() {
  // Place test artifacts outside the source checkout; cleanup is constrained to
  // the freshly created, verified work-directory child.
  const parent = path.resolve(root, '..');
  const temp = fs.mkdtempSync(path.join(parent, 'distribution-test-'));
  try {
    const lock = readLock(root), sourceFiles = commonFiles(root, lock);
    const before = snapshot(root, sourceFiles);
    const web = await build({ root, mode: 'web', out: path.join(temp, 'web'), sourceCommit: commit });
    assert.equal(web.buildInfo.sourceCommit, commit);
    assert.match(web.buildInfo.version, /^v\d{4}-\d{2}-\d{2}\.\d+$/);
    assert.equal(appConfiguration(web.out).mode, 'online');
    assertProjectBaseResources(web.out);
    for (const rel of sourceFiles) assert.deepEqual(fs.readFileSync(path.join(web.out, rel)), fs.readFileSync(path.join(root, rel)), 'web copies source bytes: ' + rel);
    assert.ok(web.files.includes('.nojekyll') && web.files.includes('vendor/SOURCES.json'));
    assert.ok(!web.files.some(file => /^(?:runtime|tests|tools|docs|connector)\//.test(file) || /offline-smoke|\.exe$|\.bat$|\.xlsx$|\.parquet$|\.zip$/.test(file)), 'web has no development fixtures or executable runtime');
    assert.ok(!web.files.includes('offline/server.cjs'));
    const webSnapshot = snapshot(web.out);
    put(web.out, 'stale-generated.txt', 'stale');
    await build({ root, mode: 'web', out: web.out, sourceCommit: commit });
    assert.deepEqual(snapshot(web.out), webSnapshot, 'owned output can be rebuilt without retaining stale files');
    assert.deepEqual(snapshot(root, sourceFiles), before, 'web build must not mutate sources');

    // Fixture source has the real app/vendor, but a tiny locked runtime avoids
    // copying the 90 MB executable repeatedly in the regression suite.
    const fixture = path.join(temp, 'fixture-source');
    const fixtureFiles = [...new Set([...sourceFiles, 'assets.lock.json', 'offline/server.cjs', 'offline/config.cjs',
      'offline/make-manifest.cjs', 'START_HERE.txt', 'DISTRIBUTION_NOTE.txt', 'OFFLINE_GUIDE.md',
      'docs/guide-template.html', 'docs/offline-preview.jpg'])];
    for (const rel of fixtureFiles) put(fixture, rel, fs.readFileSync(path.join(root, rel)));
    const fakeRuntime = Buffer.from('locked Windows executable fixture'), fakeLicense = Buffer.from('Node license fixture');
    const fixtureLock = JSON.parse(JSON.stringify(lock));
    fixtureLock.runtime.sha256 = sha256(fakeRuntime); fixtureLock.runtime.licenseSha256 = sha256(fakeLicense);
    put(fixture, 'assets.lock.json', JSON.stringify(fixtureLock));
    put(fixture, 'runtime/node.exe', fakeRuntime); put(fixture, 'runtime/LICENSE.txt', fakeLicense);
    put(fixture, 'viewer/offline-smoke-secret.xlsx', 'must never be distributed');
    put(fixture, 'tests/developer-only.js', 'must never be distributed');
    const fixtureBefore = snapshot(fixture);
    const options = { root: fixture, mode: 'offline', runtimeDir: path.join(fixture, 'runtime'), sourceCommit: commit };
    const offline = await build({ ...options, out: path.join(temp, 'offline-a'), zipPath: path.join(temp, 'first.zip') });
    const second = await build({ ...options, out: path.join(temp, 'offline-b'), zipPath: path.join(temp, 'second.zip') });
    assert.equal(appConfiguration(offline.out).mode, 'offline');
    assert.deepEqual(appConfiguration(offline.out).cloud, { url: '', anonKey: '' });
    assertProjectBaseResources(offline.out);
    for (const rel of sourceFiles.filter(file => file !== 'runtime-config.js')) {
      assert.deepEqual(fs.readFileSync(path.join(offline.out, rel)), fs.readFileSync(path.join(web.out, rel)), 'shared app/vendor bytes: ' + rel);
    }
    assert.ok(!offline.files.some(file => /offline-smoke|^tests\/|^tools\/|^docs\//.test(file)));
    assert.deepEqual(fs.readFileSync(path.join(offline.out, 'runtime/node.exe')), fakeRuntime);
    const bat = fs.readFileSync(path.join(offline.out, 'START_OFFLINE.bat'), 'utf8');
    assert.ok(bat.includes(fixtureLock.runtime.sha256));
    assert.match(bat, /--verify-only/); assert.match(bat, /DisableDelayedExpansion/);
    assert.ok(bat.indexOf('ComputeHash') < bat.indexOf('"%DESI_ROOT%runtime\\node.exe" "%DESI_ROOT%offline\\server.cjs"'));
    assert.doesNotMatch(bat, /npm|winget|https?:|make-manifest/);
    const manifest = verifyPackage(offline.out);
    assert.deepEqual(manifest.files.map(file => file.file).sort(), offline.files.filter(file => file !== 'offline/manifest.json').sort(), 'manifest covers every actual output file');
    assert.ok(manifest.files.some(entry => entry.file === 'app-runtime.js'));
    assert.ok(manifest.files.some(entry => entry.file === 'runtime-config.js'));
    const guide = fs.readFileSync(path.join(offline.out, 'HOW_TO_USE.html'), 'utf8');
    assert.doesNotMatch(guide, /\{\{GUIDE_(?:CONTENT|TOC)\}\}|\{\{PREVIEW_IMAGE\}\}/);
    assert.equal(offline.sha256, second.sha256, 'identical inputs produce identical ZIP bytes regardless of output name');
    assert.deepEqual(fs.readFileSync(offline.zipPath), fs.readFileSync(second.zipPath));
    assert.equal(fs.readFileSync(offline.zipPath + '.sha256', 'utf8'), offline.sha256 + '  first.zip\n');
    const archive = await JSZip.loadAsync(fs.readFileSync(offline.zipPath));
    assert.deepEqual(Object.keys(archive.files).sort(), offline.files.map(file => 'Share_Test_Offline/' + file).sort());
    assert.deepEqual(Buffer.from(await archive.file('Share_Test_Offline/runtime/node.exe').async('nodebuffer')), fakeRuntime);
    assert.deepEqual(snapshot(fixture), fixtureBefore, 'offline build must not mutate fixture sources');
    const offlineSnapshot = snapshot(offline.out);
    await build({ ...options, out: offline.out, zipPath: offline.zipPath });
    assert.deepEqual(snapshot(offline.out), offlineSnapshot, 'repeated offline build remains deterministic');

    const arbitrary = path.join(temp, 'existing-user-folder'); put(arbitrary, 'valuable.txt', 'retain me');
    await assert.rejects(() => build({ root, mode: 'web', out: arbitrary, sourceCommit: commit }), /ownership marker/);
    assert.equal(fs.readFileSync(path.join(arbitrary, 'valuable.txt'), 'utf8'), 'retain me');
    await assert.rejects(() => build({ root, mode: 'web', out: root, sourceCommit: commit }), /source directory/);
    await assert.rejects(() => build({ root, mode: 'web', out: parent, sourceCommit: commit }), /source directory/);
    assert.throws(() => createManifest(fixture), /ENOENT|owned offline/, 'manifest tool refuses an ordinary source checkout');

    put(fixture, 'runtime/node.exe', 'damaged');
    await assert.rejects(() => build({ ...options, out: offline.out, zipPath: offline.zipPath }), /Runtime checksum mismatch/);
    assert.deepEqual(snapshot(offline.out), offlineSnapshot, 'bad runtime cannot damage the previous output');
    put(fixture, 'runtime/node.exe', fakeRuntime);
    const vendorPath = fixtureLock.vendor[0].file, vendorOriginal = fs.readFileSync(path.join(fixture, vendorPath));
    put(fixture, vendorPath, 'damaged');
    await assert.rejects(() => build({ root: fixture, mode: 'web', out: web.out, sourceCommit: commit }), /Vendor checksum mismatch/);
    assert.deepEqual(snapshot(web.out), webSnapshot, 'bad vendor cannot damage the previous output');
    put(fixture, vendorPath, vendorOriginal);
    put(offline.out, 'app-runtime.js', 'damaged');
    assert.throws(() => verifyPackage(offline.out), /damaged: app-runtime\.js/);
    assert.ok(!fs.readdirSync(temp).some(name => /share-test-(?:stage|backup)/.test(name)), 'successful builds leave no staging directories');
    await testRuntimeDownload(temp);
    console.log('Distribution regression: PASS (web/offline outputs, paths, manifests, safe replacement, reproducible ZIP, pinned downloads)');
  } finally {
    const absolute = path.resolve(temp);
    assert.equal(path.dirname(absolute), parent);
    assert.ok(path.basename(absolute).startsWith('distribution-test-'));
    assert.ok(!fs.lstatSync(absolute).isSymbolicLink());
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
