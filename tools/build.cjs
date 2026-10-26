'use strict';
// Copy the shared app without HTML/worker rewrites. Only runtime-config.js is
// generated differently for offline mode; vendor bytes are checked before use.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { renderOfflineConfig } = require('../offline/config.cjs');
const { createManifest } = require('../offline/make-manifest.cjs');
const ROOT = path.resolve(__dirname, '..');
const OWNER_FILE = '.share-test-build.json';
const GENERATOR = 'Share_Test distribution builder';
const VIEWER_FILES = [
  'alignment-session.js', 'alignment-workspace.css', 'alignment-workspace.js',
  'fixed-colors.js', 'index.html', 'roi-cursor.svg', 'roi-media-app.js',
  'roi-media-model.js', 'roi-media-msi.js', 'roi-media-service.js',
  'roi-media-viewer.css', 'roi-media-viewer.js', 'section-visibility.js',
].map(file => 'viewer/' + file);
const MRM_FILES = ['exp-core.mjs', 'exp-editor.mjs', 'exp-editor.css', 'exp-library-import.mjs']
  .map(file => 'mrm/' + file);
const COMMON_FILES = ['.nojekyll', 'index.html', 'mrm.html', 'version.js', 'runtime-config.js',
  'app-runtime.js', 'offline/offline.js', 'offline/local-mrm.js', 'vendor/SOURCES.json', 'docs/EXP_EDITOR.md', ...VIEWER_FILES, ...MRM_FILES];
const OFFLINE_FILES = ['offline/server.cjs', 'offline/config.cjs', 'offline/make-manifest.cjs',
  'START_HERE.txt', 'DISTRIBUTION_NOTE.txt', 'OFFLINE_GUIDE.md'];
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function inside(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function readFile(root, rel) {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).some(part => part === '..' || part === '')) throw new Error('Invalid source path: ' + rel);
  const absolute = path.resolve(root, rel), stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(fs.realpathSync(root), fs.realpathSync(absolute))) {
    throw new Error('Source must be a regular file inside the repository: ' + rel);
  }
  return fs.readFileSync(absolute);
}
function readLock(root) {
  const lock = JSON.parse(readFile(root, 'assets.lock.json'));
  if (lock.format !== 1 || !Array.isArray(lock.vendor) || !lock.vendor.length || !lock.runtime) throw new Error('Invalid assets.lock.json');
  const seen = new Set();
  for (const entry of lock.vendor) {
    if (!/^vendor\/[\w.-]+$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.file)) throw new Error('Invalid or duplicate vendor lock entry');
    seen.add(entry.file);
  }
  if (!/^[a-f0-9]{64}$/.test(lock.runtime.sha256) || !/^[a-f0-9]{64}$/.test(lock.runtime.licenseSha256)) throw new Error('Invalid runtime checksums');
  return lock;
}
function commonFiles(root, lock) {
  const guides = fs.readdirSync(root).filter(file => /^USER_GUIDE(?:\.[a-z]+)*\.(?:md|pdf)$/.test(file));
  const optional = ['OFFLINE_GUIDE.md', 'VALIDATION.txt', 'REGRESSION_RESULTS.txt'].filter(file => fs.existsSync(path.join(root, file)));
  return [...new Set([...COMMON_FILES, ...guides, ...optional, ...lock.vendor.map(entry => entry.file)])].sort();
}
function writeFile(root, rel, value) {
  const absolute = path.join(root, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, value);
}
function walkFiles(root, directory = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const rel = directory ? directory + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Distribution cannot contain symbolic links: ' + rel);
    if (entry.isDirectory()) files.push(...walkFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
    else throw new Error('Unsupported distribution entry: ' + rel);
  }
  return files.sort();
}
function ownerOf(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const marker = JSON.parse(readFile(directory, OWNER_FILE));
    return marker.format === 1 && marker.generator === GENERATOR && ['web', 'offline'].includes(marker.mode) ? marker : null;
  } catch { return null; }
}
function rejectSymlinkPath(target) {
  let cursor = path.resolve(target);
  while (true) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Output path cannot contain symbolic links');
    const parent = path.dirname(cursor); if (parent === cursor) return; cursor = parent;
  }
}
function safeDestination(root, out) {
  const dest = path.resolve(out);
  if (inside(dest, fs.realpathSync(root))) throw new Error('Output cannot be the source directory or one of its ancestors');
  rejectSymlinkPath(dest);
  if (fs.existsSync(dest) && !ownerOf(dest)) throw new Error('Refusing to replace an existing directory without a build ownership marker: ' + dest);
  return dest;
}
function removeGeneratedSibling(parent, candidate, prefix) {
  const absolute = path.resolve(candidate);
  // Only remove the generated sibling after resolving and checking its target.
  if (path.dirname(absolute) !== path.resolve(parent) || !path.basename(absolute).startsWith(prefix)
      || fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Unsafe generated-directory cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
}
function resolveCommit(root, provided) {
  if (provided != null) {
    if (!/^[a-f0-9]{40}$/i.test(provided)) throw new Error('Invalid source commit');
    return provided.toLowerCase();
  }
  try {
    const value = execFileSync('git', ['-c', 'safe.directory=' + root, 'rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^[a-f0-9]{40}$/.test(value)) return value;
  } catch {}
  if (/^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA || '')) return process.env.GITHUB_SHA.toLowerCase();
  throw new Error('Cannot identify source commit. Build from a Git checkout or set GITHUB_SHA.');
}
function renderBat(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid runtime hash for BAT');
  return [
    '@echo off', 'setlocal DisableDelayedExpansion', 'title Share_Test Offline',
    'set "DESI_ROOT=%~dp0"', 'cd /d "%DESI_ROOT%"',
    'if not exist "%DESI_ROOT%runtime\\node.exe" goto missing',
    'powershell.exe -NoProfile -Command "$ErrorActionPreference=\'Stop\'; $p=[IO.Path]::Combine($env:DESI_ROOT,\'runtime\\node.exe\'); $s=[IO.File]::OpenRead($p); $h=[Security.Cryptography.SHA256]::Create(); try { $v=[BitConverter]::ToString($h.ComputeHash($s)).Replace(\'-\',\'\').ToLowerInvariant() } finally { $s.Dispose(); $h.Dispose() }; if($v -ne \'' + hash + '\'){throw \'Runtime checksum mismatch. Extract a fresh package.\'}"',
    'if errorlevel 1 goto failed', 'if /i "%~1"=="--verify-only" goto verify',
    '"%DESI_ROOT%runtime\\node.exe" "%DESI_ROOT%offline\\server.cjs"',
    'if errorlevel 1 goto failed', 'exit /b 0', ':verify',
    '"%DESI_ROOT%runtime\\node.exe" "%DESI_ROOT%offline\\server.cjs" --verify-only',
    'exit /b %errorlevel%', ':missing',
    'echo Extract the complete Share_Test_Offline ZIP before running this BAT.', ':failed',
    'echo Startup failed. See the message above. Your browser data was not changed.', 'pause', 'exit /b 1', '',
  ].join('\r\n');
}
async function build(options = {}) {
  const root = fs.realpathSync(path.resolve(options.root || ROOT)), mode = options.mode;
  if (!['web', 'offline'].includes(mode)) throw new Error('--mode must be web or offline');
  if (!options.out) throw new Error('--out is required');
  if (mode !== 'offline' && options.zipPath) throw new Error('--zip is only available for offline builds');
  const out = safeDestination(root, options.out), parent = path.dirname(out);
  const zipPath = options.zipPath ? path.resolve(options.zipPath) : null;
  if (zipPath && (inside(out, zipPath) || inside(zipPath, root))) throw new Error('ZIP must be outside the output directory and source ancestors');
  if (zipPath) {
    rejectSymlinkPath(zipPath);
    rejectSymlinkPath(zipPath + '.sha256');
    if (fs.existsSync(zipPath) || fs.existsSync(zipPath + '.sha256')) {
      const sidecar = fs.existsSync(zipPath + '.sha256') ? fs.readFileSync(zipPath + '.sha256', 'utf8').trim() : '';
      if (!ownerOf(out) || !fs.existsSync(zipPath) || sidecar !== sha256(fs.readFileSync(zipPath)) + '  ' + path.basename(zipPath)) throw new Error('Refusing to overwrite an unverified existing ZIP or checksum');
    }
  }
  const lock = readLock(root), files = commonFiles(root, lock);
  const contents = new Map(files.map(rel => [rel, readFile(root, rel)]));
  for (const entry of lock.vendor) if (sha256(contents.get(entry.file)) !== entry.sha256) throw new Error('Vendor checksum mismatch: ' + entry.file);
  const provenance = JSON.parse(contents.get('vendor/SOURCES.json'));
  if (!Array.isArray(provenance.assets)) throw new Error('Invalid vendor provenance');
  for (const entry of lock.vendor) {
    const matches = provenance.assets.filter(asset => asset.file === entry.file);
    if (matches.length !== 1 || matches[0].source !== entry.source || matches[0].source_sha256 !== entry.sourceSha256
        || matches[0].packaged_sha256 !== entry.sha256) throw new Error('Vendor provenance mismatch: ' + entry.file);
  }
  const version = contents.get('version.js').toString('utf8').match(/window\.APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!version) throw new Error('Cannot read app version from version.js');
  const buildInfo = { format: 1, app: 'Share_Test', mode, version: version[1], sourceCommit: resolveCommit(root, options.sourceCommit) };
  if (mode === 'offline') {
    for (const rel of OFFLINE_FILES) contents.set(rel, readFile(root, rel));
    const runtimeDir = fs.realpathSync(path.resolve(options.runtimeDir || path.join(root, 'runtime')));
    for (const [file, hash] of [['node.exe', lock.runtime.sha256], ['LICENSE.txt', lock.runtime.licenseSha256]]) {
      const value = readFile(runtimeDir, file);
      if (sha256(value) !== hash) throw new Error('Runtime checksum mismatch: ' + file);
      contents.set('runtime/' + file, value);
    }
    contents.set('runtime-config.js', Buffer.from(renderOfflineConfig() + '\n'));
    contents.set('START_OFFLINE.bat', Buffer.from(renderBat(lock.runtime.sha256)));
    const { renderGuide } = require('./docs.cjs');
    contents.set('HOW_TO_USE.html', Buffer.from(renderGuide(root)));
    buildInfo.runtimeVersion = lock.runtime.version; buildInfo.runtimeSha256 = lock.runtime.sha256;
  }
  contents.set('build-info.json', Buffer.from(JSON.stringify(buildInfo, null, 2) + '\n'));
  contents.set(OWNER_FILE, Buffer.from(JSON.stringify({ format: 1, generator: GENERATOR, mode }, null, 2) + '\n'));
  fs.mkdirSync(parent, { recursive: true });
  const prefix = '.' + path.basename(out) + '.share-test-stage-', stage = fs.mkdtempSync(path.join(parent, prefix));
  let backup = null, zipTemp = null, checksumTemp = null;
  try {
    for (const [rel, value] of [...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) writeFile(stage, rel, value);
    if (mode === 'offline') createManifest(stage);
    let archiveHash = null;
    if (zipPath) {
      const JSZip = require(path.join(root, 'vendor/jszip.min.js')), zip = new JSZip();
      for (const rel of walkFiles(stage)) zip.file('Share_Test_Offline/' + rel, fs.readFileSync(path.join(stage, rel)),
        { date: new Date('2000-01-01T00:00:00.000Z'), createFolders: false, unixPermissions: 0o100644 });
      const archive = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true });
      archiveHash = sha256(archive);
      fs.mkdirSync(path.dirname(zipPath), { recursive: true });
      zipTemp = zipPath + '.tmp-' + crypto.randomUUID(); checksumTemp = zipTemp + '.sha256';
      fs.writeFileSync(zipTemp, archive, { flag: 'wx' });
      fs.writeFileSync(checksumTemp, archiveHash + '  ' + path.basename(zipPath) + '\n', { flag: 'wx' });
    }
    if (fs.existsSync(out)) {
      if (!ownerOf(out)) throw new Error('Output ownership changed during build');
      backup = path.join(parent, '.' + path.basename(out) + '.share-test-backup-' + crypto.randomUUID());
      fs.renameSync(out, backup);
    }
    try { fs.renameSync(stage, out); } catch (error) { if (backup) { fs.renameSync(backup, out); backup = null; } throw error; }
    if (zipPath) {
      fs.renameSync(zipTemp, zipPath); zipTemp = null;
      fs.renameSync(checksumTemp, zipPath + '.sha256'); checksumTemp = null;
    }
    if (backup) { removeGeneratedSibling(parent, backup, '.' + path.basename(out) + '.share-test-backup-'); backup = null; }
    return { out, mode, files: walkFiles(out), buildInfo, zipPath, sha256: archiveHash };
  } finally {
    if (fs.existsSync(stage)) removeGeneratedSibling(parent, stage, prefix);
    if (zipTemp && fs.existsSync(zipTemp)) fs.unlinkSync(zipTemp);
    if (checksumTemp && fs.existsSync(checksumTemp)) fs.unlinkSync(checksumTemp);
    // A previous output retained after a publication error stays recoverable.
  }
}
function parseArgs(argv) {
  const options = {}, keys = { '--mode': 'mode', '--out': 'out', '--runtime-dir': 'runtimeDir', '--zip': 'zipPath' };
  for (let i = 0; i < argv.length; i++) {
    const key = keys[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Usage: node tools/build.cjs --mode web|offline --out DIR [--runtime-dir DIR] [--zip FILE]');
    if (options[key]) throw new Error('Duplicate option: ' + argv[i]); options[key] = argv[++i];
  }
  return options;
}
if (require.main === module) Promise.resolve().then(() => build(parseArgs(process.argv.slice(2)))).then(result => {
  console.log(`Built ${result.mode}: ${result.files.length} files -> ${result.out}`);
  if (result.zipPath) console.log(`ZIP: ${result.zipPath}\nSHA256: ${result.sha256}`);
}).catch(error => { console.error('Build failed: ' + error.message); process.exitCode = 1; });
module.exports = { build, commonFiles, readLock, sha256, walkFiles, OWNER_FILE, GENERATOR, VIEWER_FILES, renderBat };
