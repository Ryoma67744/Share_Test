'use strict';
// Opt-in browser QA. Stage an isolated test copy, then use the production
// handler unchanged. Production server routing never exposes tests/fixtures.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createServer, ROOT, PORT, BASE} = require('../offline/server.cjs');
const tempPrefix = 'desi-browser-smoke-';

function stageBrowserSmoke(sourceRoot = ROOT) {
  sourceRoot = path.resolve(sourceRoot);
  const target = fs.mkdtempSync(path.join(os.tmpdir(),tempPrefix));
  const realRoot = fs.realpathSync(sourceRoot);
  function copy(relative, destRelative = relative) {
    const source = path.join(sourceRoot,relative);
    if (!fs.realpathSync(source).startsWith(realRoot+path.sep)) throw new Error('Test input resolves outside the source tree: '+relative);
    const dest = path.join(target,destRelative);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.copyFileSync(source,dest);
  }
  try {
    for (const name of ['index.html','mrm.html','version.js','runtime-config.js','app-runtime.js',
      'offline/offline.js','offline/local-mrm.js']) copy(name);
    for (const item of fs.readdirSync(sourceRoot,{withFileTypes:true})) {
      if (item.isFile() && /^(?:OFFLINE_GUIDE|USER_GUIDE(?:\.[a-z]+)*)\.md$/.test(item.name)) copy(item.name);
    }
    for (const dir of ['viewer','vendor']) {
      for (const item of fs.readdirSync(path.join(sourceRoot,dir),{withFileTypes:true})) {
        if (item.isFile() && !item.name.startsWith('offline-smoke')) copy(path.join(dir,item.name));
      }
    }
    for (const name of ['offline-smoke.html','offline-smoke-data.xlsx','offline-smoke-deflate.tif',
      'offline-smoke-snappy.parquet','offline-smoke-zstd.parquet','offline-smoke-project.zip']) {
      copy(path.join('tests/fixtures/browser',name),path.join('viewer',name));
    }
    return target;
  } catch (err) { removeStage(target); throw err; }
}

function removeStage(target) {
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(tempPrefix)) {
    throw new Error('Refusing unexpected test staging cleanup path');
  }
  fs.rmSync(resolved,{recursive:true,force:true});
}

async function main() {
  const stage = stageBrowserSmoke();
  const server = createServer(stage);
  let cleaned = false;
  const clean = () => { if (!cleaned) { cleaned = true; removeStage(stage); } };
  process.on('exit',clean);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => {
    server.close(() => { clean(); process.exit(0); });
    server.closeAllConnections?.();
  });
  server.on('error',err => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is busy. Stop the running portable app before this opt-in smoke test.` : err.message);
    clean(); process.exitCode = 1;
  });
  server.listen(PORT,'127.0.0.1',() => {
    console.log(`Browser smoke QA: ${BASE}/viewer/offline-smoke.html\nTest files are staged outside the repository and are not release outputs.\nPress Ctrl+C to stop and remove the temporary copy.`);
  });
}

if (require.main === module) main().catch(err=>{console.error(err.stack||err);process.exitCode=1;});
module.exports = {stageBrowserSmoke,removeStage};
