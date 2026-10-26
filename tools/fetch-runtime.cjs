'use strict';
// Maintainer preparation only. End users receive the verified runtime in the
// offline ZIP; START_OFFLINE.bat performs no download or global installation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const ROOT = path.resolve(__dirname, '..');
function fileHash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function runtimeLock(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'assets.lock.json'), 'utf8')).runtime;
  if (!lock || !/^v\d+\.\d+\.\d+$/.test(lock.version)
      || lock.url !== `https://nodejs.org/dist/${lock.version}/win-x64/node.exe`
      || lock.licenseUrl !== `https://raw.githubusercontent.com/nodejs/node/${lock.version}/LICENSE`
      || !/^[a-f0-9]{64}$/.test(lock.sha256) || !/^[a-f0-9]{64}$/.test(lock.licenseSha256)) {
    throw new Error('Runtime lock must name a pinned official Windows x64 Node.js release and license');
  }
  return lock;
}
async function fetchRuntime(options = {}) {
  const root = fs.realpathSync(options.root || ROOT), lock = runtimeLock(root);
  const destination = path.join(root, 'runtime');
  if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || !fs.lstatSync(destination).isDirectory())) {
    throw new Error('runtime must be a normal repository directory');
  }
  fs.mkdirSync(destination, { recursive: true });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Use Node.js 22 or newer to fetch the pinned runtime');
  const files = [
    { name: 'node.exe', url: lock.url, sha256: lock.sha256, limit: 256 * 1024 * 1024 },
    { name: 'LICENSE.txt', url: lock.licenseUrl, sha256: lock.licenseSha256, limit: 2 * 1024 * 1024 },
  ];
  const staged = [];
  try {
    for (const entry of files) {
      const target = path.join(destination, entry.name);
      if (fs.existsSync(target)) {
        if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new Error('Runtime target is not a regular file: ' + entry.name);
        if (fileHash(target) === entry.sha256) continue;
      }
      const temp = path.join(destination, '.' + entry.name + '.download-' + crypto.randomUUID());
      staged.push({ target, temp });
      const response = await fetchImpl(entry.url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw new Error(`Runtime download failed (HTTP ${response.status}): ${entry.url}`);
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const checked = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > entry.limit) return callback(new Error('Runtime download exceeds expected size limit'));
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), checked, fs.createWriteStream(temp, { flags: 'wx' }));
      if (hash.digest('hex') !== entry.sha256) throw new Error('Runtime checksum mismatch: ' + entry.name + '. No downloaded files were installed.');
    }
    // Validate BOTH downloads before replacing either pinned file.
    for (const item of staged) fs.renameSync(item.temp, item.target);
    return { version: lock.version, directory: destination, downloaded: staged.length,
      files: files.map(entry => ({ file: entry.name, sha256: entry.sha256 })) };
  } finally {
    for (const item of staged) if (fs.existsSync(item.temp)) fs.unlinkSync(item.temp);
  }
}
if (require.main === module) Promise.resolve().then(() => {
  if (process.argv.length > 2) throw new Error('Usage: node tools/fetch-runtime.cjs');
  return fetchRuntime();
}).then(result => console.log(`Verified ${result.version} Windows x64 runtime (${result.downloaded} downloaded files): ${result.directory}`))
  .catch(error => { console.error('Runtime preparation failed: ' + error.message); process.exitCode = 1; });
module.exports = { fetchRuntime, runtimeLock };
