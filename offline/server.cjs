'use strict';
// Portable, dependency-free, loopback-only server. No project data is sent
// anywhere: edits stay in browser IndexedDB, backups are explicit ZIP/JSON files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { renderOfflineConfig } = require('./config.cjs');
const ROOT = path.resolve(__dirname, '..');
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;
const INSTANCE = crypto.createHash('sha256').update(ROOT.toLowerCase()).digest('hex');
const CSP = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' blob: data:",
  "font-src 'self' data:", "connect-src 'self' blob: data:",
  "worker-src 'self' blob:", "frame-src 'self' blob:",
  "media-src 'self' blob: data:", "object-src 'none'", "base-uri 'self'",
  "form-action 'none'", "frame-ancestors 'self'"
].join('; ');
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.md':'text/plain; charset=utf-8',
  '.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png',
  '.ico':'image/x-icon','.wasm':'application/wasm'};

function verifyPackage(root = ROOT) {
  const manifestPath = path.join(root, 'offline', 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Package manifest is missing. Extract the complete ZIP first.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid package manifest.');
  for (const item of manifest.files) {
    const file = path.resolve(root, item.file);
    if (!file.startsWith(root + path.sep) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid manifest path/hash.');
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error('Manifest file resolves outside the package.');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (hash !== item.sha256) throw new Error(`Package file is damaged: ${item.file}. Extract a fresh copy; keep your exported backups.`);
  }
  return manifest;
}
function headers(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}
function text(res, status, body) {
  res.writeHead(status, {'Content-Type':'text/plain; charset=utf-8'}); res.end(body);
}
function resolveStatic(urlPath, root = ROOT) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  // runtime-config.js is deliberately absent: its dynamic offline response
  // must never be bypassed with an encoded path to the online source file.
  const allowed = /^\/(?:index\.html|mrm\.html|version\.js|app-runtime\.js|OFFLINE_GUIDE\.md|USER_GUIDE(?:\.[a-z]+)*\.md|viewer\/[\w.-]+|vendor\/[\w.-]+|offline\/(?:offline|local-mrm)\.js)$/;
  if (!allowed.test(decoded)) return null;
  const file = path.resolve(root, '.' + decoded);
  if (!file.startsWith(root + path.sep)) return null;
  return file;
}
function parseRange(value, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(value || '');
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] ? (m[2] ? Number(m[2]) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size || (!m[1] && Number(m[2]) === 0)) return null;
  return {start, end: Math.min(end, size - 1)};
}
function createServer(root = ROOT) {
  return http.createServer((req, res) => {
    headers(res);
    if (req.headers.host !== `127.0.0.1:${PORT}`) return text(res, 403, 'Loopback Host required.');
    if (!['GET','HEAD'].includes(req.method)) return text(res, 405, 'Read-only server.');
    if (req.headers.origin && req.headers.origin !== BASE) return text(res, 403, 'Cross-origin request rejected.');
    if (req.headers['sec-fetch-site'] === 'cross-site') return text(res, 403, 'Cross-site request rejected.');
    const rawPath = (req.url || '/').split('?')[0];
    if (rawPath === '/__offline_health') {
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(req.method === 'HEAD' ? '' : JSON.stringify({app:'Share_Test Offline',version:1,instance:INSTANCE}));
    }
    if (rawPath === '/runtime-config.js') {
      res.writeHead(200, {'Content-Type':TYPES['.js']});
      return res.end(req.method === 'HEAD' ? '' : renderOfflineConfig());
    }
    if (rawPath === '/offline/config.js') {
      res.writeHead(200, {'Content-Type':TYPES['.js']});
      // Compatibility for previously generated portable pages only. Canonical
      // pages load runtime-config.js and app-runtime.js instead.
      return res.end(req.method === 'HEAD' ? '' : renderOfflineConfig()
        + '\nObject.defineProperty(window,"DESI_OFFLINE",{value:true,writable:false,configurable:false});');
    }
    if (rawPath === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const file = resolveStatic(rawPath, root);
    if (!file) return text(res, 404, 'Not found.');
    let stat;
    try {
      if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error();
      stat = fs.statSync(file); if (!stat.isFile()) throw new Error();
    }
    catch { return text(res, 404, 'Not found.'); }
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    let range = null;
    if (req.headers.range) {
      range = parseRange(req.headers.range, stat.size);
      if (!range) { res.writeHead(416, {'Content-Range':`bytes */${stat.size}`}); return res.end(); }
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    }
    res.setHeader('Content-Length', range ? range.end-range.start+1 : stat.size);
    res.writeHead(range ? 206 : 200);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, range || {});
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}
function openBrowser() {
  if (process.env.DESI_NO_BROWSER === '1') return;
  if (process.platform === 'win32') {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', BASE + '/'], {detached:true,stdio:'ignore',windowsHide:true});
    child.on('error', () => console.log(`Open ${BASE}/ in Edge or Chrome.`));
    child.unref();
  }
}
async function main() {
  const manifest = verifyPackage();
  if (process.argv.includes('--verify-only')) { console.log(`Verified ${manifest.files.length} package files.`); return; }
  const server = createServer();
  server.on('error', err => {
    if (err.code !== 'EADDRINUSE') { console.error(err.message); process.exitCode=1; return; }
    const request = http.get(BASE + '/__offline_health', {timeout:1500}, res => {
      let body=''; res.on('data', b => {if(body.length < 4096) body+=b;});
      res.on('end', () => {
        try {
          const value=JSON.parse(body);
          if (value.app === 'Share_Test Offline' && value.instance === INSTANCE) { console.log('Already running. Opening the existing app.'); openBrowser(); return; }
        } catch {}
        console.error(`Port ${PORT} is used by another app/copy. Close it first. The port is kept fixed to preserve browser data.`);
        process.exitCode=1;
      });
    });
    request.on('timeout', () => request.destroy(new Error('Port probe timed out.')));
    request.on('error', () => { console.error(`Port ${PORT} is unavailable. Close the other app first.`); process.exitCode=1; });
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Share_Test Offline\n${BASE}/\nNo Internet, account, Python, npm or administrator access required.\nKeep this window open. Press Ctrl+C to stop.\nUse the same browser profile; export ZIP backups for each project.`);
    openBrowser();
  });
  process.on('SIGINT', () => { server.close(); process.exit(0); });
}
if (require.main === module) main().catch(err => {console.error(err.message); process.exitCode=1;});
module.exports = {createServer, resolveStatic, parseRange, verifyPackage, CSP, ROOT, PORT, BASE};
