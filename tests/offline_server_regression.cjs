'use strict';
// Isolated fixtures only: never reads or changes the user's browser/project data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const vm = require('node:vm');
const {createServer, resolveStatic, parseRange, verifyPackage, CSP, PORT, BASE} = require('../offline/server.cjs');
const {renderOfflineConfig} = require('../offline/config.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'desi-offline-server-test-'));
const activeServers = new Set();
let checks = 0;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function check(value, message) { assert.ok(value, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function rejects(fn, pattern) { assert.throws(fn, pattern); checks++; }
function fixture(name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, {recursive:true});
  return root;
}
function put(root, name, contents) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, contents);
  return file;
}
async function listen(root) {
  const server = createServer(root);
  activeServers.add(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
function request(server, url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname:'127.0.0.1', port:server.address().port,
      path:url, method:options.method || 'GET',
      headers:{Host:`127.0.0.1:${PORT}`, ...(options.headers || {})}}, res => {
        const chunks = [];
        res.on('data', data => chunks.push(data));
        res.on('end', () => resolve({status:res.statusCode, headers:res.headers,
          body:Buffer.concat(chunks).toString('utf8')}));
        res.on('error', reject);
      });
    req.setTimeout(5000, () => req.destroy(new Error('Test request timed out')));
    req.on('error', reject);
    req.end();
  });
}
function writeManifest(root, files, prefix = '') {
  put(root, 'offline/manifest.json', prefix + JSON.stringify({format:1,files}));
}

async function main() {
  const root = fixture('app');
  put(root, 'index.html', '0123456789');
  put(root, 'runtime-config.js', 'ONLINE SOURCE CONFIG MUST NOT BE SERVED');
  put(root, 'app-runtime.js', '/* canonical shared runtime */');
  put(root, 'viewer/index.html', 'viewer fixture');
  put(root, 'viewer/empty.txt', '');
  put(root, 'vendor/module.mjs', 'export const answer = 42;');
  put(root, 'offline/offline.js', '/* local only */');
  put(root, 'offline/local-mrm.js', '/* local library */');
  put(root, 'USER_GUIDE.master.en.md', '# Guide');
  put(root, '.git/config', 'do not serve');
  put(root, 'runtime/node.exe', 'do not serve');
  put(root, 'connector/README.md', 'do not serve');
  put(root, 'offline/server.cjs', 'do not serve');

  equal(resolveStatic('/', root), path.join(root, 'index.html'));
  equal(resolveStatic('/viewer/', root), path.join(root, 'viewer/index.html'));
  equal(resolveStatic('/app-runtime.js', root), path.join(root, 'app-runtime.js'));
  for (const url of ['/../index.html','/%2e%2e/index.html','/viewer/%2e%2e/index.html',
    '/viewer%5cindex.html','/viewer/%00index.html','/%E0%A4%A','//index.html',
    '/.git/config','/runtime/node.exe','/connector/README.md','/offline/server.cjs',
    '/offline/manifest.json','/offline/config.cjs','/runtime-config.js',
    '/%72untime-config.js','/runtime%2dconfig.js','/tests/fixtures/browser/offline-smoke.html',
    '/vendor/a/b.js']) equal(resolveStatic(url, root), null, url);
  for (const [input, size, expected] of [
    ['bytes=2-5',10,{start:2,end:5}], ['bytes=8-',10,{start:8,end:9}],
    ['bytes=-3',10,{start:7,end:9}], ['bytes=-99',10,{start:0,end:9}],
    ['bytes=0-99',10,{start:0,end:9}], ['bytes=10-',10,null],
    ['bytes=-0',10,null], ['bytes=5-2',10,null], ['bytes=-',10,null],
    ['bytes=0-1,4-5',10,null], ['items=0-2',10,null], ['bytes=0-',0,null],
    ['bytes=9007199254740992-',10,null]
  ]) equal(parseRange(input,size), expected, input);

  rejects(() => verifyPackage(root), /manifest is missing/i);
  put(root, 'offline/manifest.json', '{');
  rejects(() => verifyPackage(root), SyntaxError);
  writeManifest(root, []);
  rejects(() => verifyPackage(root), /Invalid package manifest/);
  writeManifest(root, [{file:'../outside.txt',sha256:sha('outside')}]);
  rejects(() => verifyPackage(root), /Invalid manifest path/);
  writeManifest(root, [{file:'index.html',sha256:'bad'}]);
  rejects(() => verifyPackage(root), /Invalid manifest path\/hash/);
  writeManifest(root, [{file:'missing.js',sha256:sha('missing')}]);
  rejects(() => verifyPackage(root), /ENOENT|missing/i);
  writeManifest(root, [{file:'index.html',sha256:sha('wrong')}]);
  rejects(() => verifyPackage(root), /damaged: index\.html/);
  writeManifest(root, [{file:'index.html',sha256:sha('0123456789')}], '\uFEFF');
  equal(verifyPackage(root).files.length, 1, 'UTF-8 BOM manifest accepted');

  const server = await listen(root);
  const response = await request(server, '/');
  equal(response.status, 200);
  equal(response.body, '0123456789');
  equal(response.headers['content-type'], 'text/html; charset=utf-8');
  equal(response.headers['content-length'], '10');
  equal(response.headers['content-security-policy'], CSP);
  equal(response.headers['cache-control'], 'no-store');
  equal(response.headers['x-content-type-options'], 'nosniff');
  equal(response.headers['referrer-policy'], 'no-referrer');
  equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  check(CSP.includes("connect-src 'self' blob: data:"));
  check(CSP.includes("worker-src 'self' blob:"));
  check(CSP.includes("form-action 'none'"));
  check(!CSP.includes('https:') && !CSP.includes('http:') && !CSP.includes('*'));

  for (const host of ['localhost:'+PORT, 'evil.example:'+PORT, '127.0.0.1', '127.0.0.1:1']) {
    equal((await request(server, '/', {headers:{Host:host}})).status, 403, host);
  }
  for (const method of ['POST','PUT','DELETE','OPTIONS','PATCH']) {
    equal((await request(server, '/', {method})).status, 405, method);
  }
  equal((await request(server, '/', {headers:{Origin:'https://example.com'}})).status, 403);
  equal((await request(server, '/', {headers:{Origin:'null'}})).status, 403);
  equal((await request(server, '/', {headers:{Origin:BASE}})).status, 200);
  equal((await request(server, '/', {headers:{'Sec-Fetch-Site':'cross-site'}})).status, 403);
  equal((await request(server, '/', {headers:{'Sec-Fetch-Site':'same-origin'}})).status, 200);
  for (const url of ['/viewer/%2e%2e/index.html','/viewer%5cindex.html','/%00',
    '/%E0%A4%A','/.git/config','/runtime/node.exe','/connector/README.md',
    '/offline/server.cjs','/offline/config.cjs','/offline/manifest.json','/vendor/not-present.js',
    '/%72untime-config.js','/runtime%2dconfig.js','/tests/fixtures/browser/offline-smoke.html']) {
    equal((await request(server, url)).status, 404, url);
  }
  equal((await request(server, '/viewer/?project=fixture')).body, 'viewer fixture');
  equal((await request(server, '/USER_GUIDE.master.en.md')).body, '# Guide');
  equal((await request(server, '/vendor/module.mjs')).headers['content-type'], 'text/javascript; charset=utf-8');
  const appRuntime = await request(server, '/app-runtime.js');
  equal(appRuntime.status,200);
  equal(appRuntime.headers['content-type'],'text/javascript; charset=utf-8');
  equal(appRuntime.body,'/* canonical shared runtime */');
  equal((await request(server, '/offline/offline.js')).status,200);
  equal((await request(server, '/offline/local-mrm.js')).status,200);
  equal((await request(server, '/favicon.ico')).status, 204);
  const head = await request(server, '/', {method:'HEAD'});
  equal(head.status, 200); equal(head.body, ''); equal(head.headers['content-length'], '10');
  for (const [range, body, contentRange] of [
    ['bytes=2-5','2345','bytes 2-5/10'], ['bytes=-3','789','bytes 7-9/10'],
    ['bytes=8-','89','bytes 8-9/10'], ['bytes=0-99','0123456789','bytes 0-9/10']
  ]) {
    const part = await request(server, '/', {headers:{Range:range}});
    equal(part.status,206); equal(part.body,body); equal(part.headers['content-range'],contentRange);
    equal(Number(part.headers['content-length']), body.length);
  }
  const rangeHead = await request(server, '/', {method:'HEAD',headers:{Range:'bytes=1-3'}});
  equal(rangeHead.status,206); equal(rangeHead.body,''); equal(rangeHead.headers['content-length'],'3');
  for (const range of ['bytes=10-','bytes=-0','bytes=5-2','bytes=0-1,4-5']) {
    const bad = await request(server, '/', {headers:{Range:range}});
    equal(bad.status,416); equal(bad.headers['content-range'],'bytes */10');
  }
  equal((await request(server, '/viewer/empty.txt')).headers['content-length'],'0');
  equal((await request(server, '/viewer/empty.txt', {headers:{Range:'bytes=0-'}})).status,416);
  const config = await request(server, '/runtime-config.js');
  equal(config.status,200);
  equal(config.body,renderOfflineConfig());
  equal(config.headers['content-type'],'text/javascript; charset=utf-8');
  check(!config.body.includes('ONLINE SOURCE'),'offline config replaces source configuration');
  const context = {window:{}};
  vm.runInNewContext(config.body, context);
  equal(JSON.parse(JSON.stringify(context.window.DESI_BUILD_CONFIG)),{mode:'offline',cloud:{url:'',anonKey:''}});
  equal(Object.isFrozen(context.window.DESI_BUILD_CONFIG),true);
  const descriptor = Object.getOwnPropertyDescriptor(context.window,'DESI_BUILD_CONFIG');
  equal(descriptor.writable,false); equal(descriptor.configurable,false);
  equal(context.window.DESI_OFFLINE,undefined,'shared runtime owns the derived offline flag');
  equal((await request(server, '/runtime-config.js?cache=none')).body,config.body);
  equal((await request(server, '/runtime-config.js', {method:'HEAD'})).body,'');
  const legacy = {window:{}};
  vm.runInNewContext((await request(server, '/offline/config.js')).body,legacy);
  equal(legacy.window.DESI_OFFLINE,true);
  equal(legacy.window.DESI_BUILD_CONFIG.mode,'offline');
  equal((await request(server, '/offline/config.js', {method:'HEAD'})).body,'');
  const health = await request(server, '/__offline_health');
  equal(health.status,200); equal(JSON.parse(health.body).app,'Share_Test Offline');
  check(/^[a-f0-9]{64}$/.test(JSON.parse(health.body).instance));
  equal((await request(server, '/__offline_health', {method:'HEAD'})).body,'');

  const otherRoot = fixture('other');
  put(otherRoot,'index.html','independent root');
  const other = await listen(otherRoot);
  equal((await request(other,'/')).body,'independent root');
  equal((await request(server,'/')).body,'0123456789','handler roots stay isolated');

  // Windows junctions require no symbolic-link privilege. An allowlisted path
  // must never expose a target outside the package after filesystem resolution.
  const linkRoot = fixture('junction-app');
  const outside = fixture('outside');
  put(outside,'secret.txt','outside-package secret');
  let junctionReady = false;
  try { fs.symlinkSync(outside,path.join(linkRoot,'viewer'),process.platform === 'win32' ? 'junction' : 'dir'); junctionReady = true; }
  catch (err) {
    if (!['EPERM','EACCES','ENOTSUP'].includes(err.code)) throw err;
    console.log('SKIP junction fixture: filesystem does not permit links');
  }
  if (junctionReady) {
    const linked = await listen(linkRoot);
    const escaped = await request(linked,'/viewer/secret.txt');
    check([403,404].includes(escaped.status),'realpath confinement must reject a junction that escapes the package');
    writeManifest(linkRoot,[{file:'viewer/secret.txt',sha256:sha('outside-package secret')}]);
    rejects(() => verifyPackage(linkRoot), /manifest|path|outside|escape|package/i);
  }
  console.log(`Offline server regression: PASS (${checks} checks)`);
}

main().catch(err => { console.error(err.stack || err); process.exitCode=1; }).finally(async () => {
  await Promise.all([...activeServers].map(server => new Promise(resolve => {
    server.close(resolve);
    if (server.closeAllConnections) server.closeAllConnections();
  })));
  // Only remove the exact scratch directory made by mkdtemp above.
  const expectedParent = path.resolve(os.tmpdir());
  const resolved = path.resolve(scratch);
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith('desi-offline-server-test-')) {
    throw new Error('Refusing unexpected scratch cleanup path');
  }
  fs.rmSync(resolved,{recursive:true,force:true});
});
