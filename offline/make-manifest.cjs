'use strict';
// Developer-only regeneration for an owned OFFLINE build. The BAT never runs
// this script; it only verifies the already supplied manifest.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function createManifest(directory = path.resolve(__dirname, '..')) {
  const root = fs.realpathSync(directory);
  const info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
  const owner = JSON.parse(fs.readFileSync(path.join(root, '.share-test-build.json'), 'utf8'));
  if (info.format !== 1 || info.app !== 'Share_Test' || info.mode !== 'offline'
      || owner.format !== 1 || owner.generator !== 'Share_Test distribution builder' || owner.mode !== 'offline') {
    throw new Error('Manifest regeneration requires an owned offline distribution, never a source checkout');
  }
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? dir + '/' + entry.name : entry.name;
      if (rel === 'offline/manifest.json') continue;
      if (entry.isSymbolicLink()) throw new Error('Manifest cannot include a symbolic link: ' + rel);
      if (entry.isDirectory()) visit(rel);
      else if (entry.isFile()) {
        const absolute = path.join(root, rel);
        if (!fs.realpathSync(absolute).startsWith(root + path.sep)) throw new Error('Manifest path escaped distribution');
        files.push({ file: rel, sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') });
      } else throw new Error('Unsupported manifest entry: ' + rel);
    }
  }
  visit('');
  files.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const manifest = { format: 1, app: 'Share_Test Offline', files };
  fs.writeFileSync(path.join(root, 'offline', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (require.main === module) {
  try { console.log(`Manifest: ${createManifest().files.length} files.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createManifest };
