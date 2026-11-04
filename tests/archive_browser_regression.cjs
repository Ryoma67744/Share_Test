'use strict';
// Isolated localhost origin: real Chromium, JSZip, IndexedDB and Web Locks.
// Production import/export functions and storage wrappers; rendering is outside
// this test (covered by the report/preview browser suites).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(process.env.ARCHIVE_TEST_ROOT||path.join(__dirname,'..'));
const html=fs.readFileSync(path.join(root,'viewer/index.html'),'utf8');
function fn(name){let start=html.indexOf('function '+name+'(');assert.ok(start>=0,name);if(html.slice(start-6,start)==='async ')start-=6;return html.slice(start,html.indexOf('\n}',start)+2);}
const storageStart=html.indexOf('const ProjectStorage = (() => {');
const storageCode=html.slice(storageStart,html.indexOf('\n})();',storageStart)+6);
const names=['detachOfflineProject','sanitizeStorageKeySegment','guessMimeFromPath','remapRoiGeometry',
 'roiMediaForTransport','roiMediaReadOriginal','roiMediaPublicItem','exportProjectAsZip','importZipFile'];
const harness=`<!doctype html><meta charset="utf-8"><script src="/store.js"></script><script src="/archive.js"></script>
<script src="/zip.js"></script><script src="/media.js"></script><script>
const uid=prefix=>prefix+'_'+crypto.randomUUID(),nowIso=()=>new Date().toISOString();
const ensureMemoShape=value=>value||{},safeName=value=>value,DEFAULT_ANATOMY_PALETTE={};
const LAZY_LIBS={jszip:'/zip.js'},loadScript=async()=>{},freezeMsiSourceReferences=()=>{};
const alignmentImageIdentity=image=>image.blobId,blobContentSig=async()=>null,bakeAlignedHeToMsiPng=async()=>null;
const buildSampleCsvGroups=async()=>[],_yieldUi=async()=>{};
const openPublishProgressModal=()=>({update(){},close(){},setCancelHandler(){}}),showToast=()=>{};
const App={project:null,panels:new Map(),openProject:async id=>{App.project=await ProjectStorage.getProject(id);}};
let _exportInProgress=false;window.alerts=[];window.alert=message=>alerts.push(String(message));
const downloadAsFile=blob=>{window.exported=blob;};
${storageCode}
${names.map(fn).join('\n')}
window.storage=ProjectStorage;window.application=App;
window.readStore=async name=>{const db=await storage.open();return new Promise((resolve,reject)=>{const r=db.transaction([name],'readonly').objectStore(name).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});};
window.legacyArchive=async()=>{
 const z=new JSZip(),data='x,y,v\\n0,0,0\\n1,0,10\\n';
 z.file('project.json',JSON.stringify({format:'desi_data_share_v1',id:'archive-project',displayName:'Legacy browser',sectionOrder:['s'],rois:[]}));
 z.file('sections/s/atlas.json',JSON.stringify({id:'s',displayName:'Section',images:{HE:{path:'data/he.png',filename:'he.png',mime:'image/png'}},
  msiSeries:{MSI_A:{kind:'txt',path:'data/msi_MSI_A__source.csv',filename:'source.csv',sourceFileId:'f',x:'x',y:'y',v:'v'},
   MSI_B:{kind:'txt',path:'data/msi_MSI_B__source.csv',filename:'source.csv',sourceFileId:'f',x:'x',y:'y',v:'v'}},
  msiFiles:{f:{id:'f',kind:'txt',filename:'source.csv'}}}));
 z.file('sections/s/data/he.png','synthetic image bytes');
 z.file('sections/s/data/msi_MSI_A__source.csv',data);z.file('sections/s/data/msi_MSI_B__source.csv',data);
 return z.generateAsync({type:'blob'});
};
</script>`;
async function main(){
 const assets={'/store.js':'project-store-safety.js','/archive.js':'viewer/project-archive.js','/zip.js':'vendor/jszip.min.js','/media.js':'viewer/roi-media-model.js'};
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(harness);return;}
  if(assets[req.url]){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(root,assets[req.url])));return;}res.writeHead(404);res.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const context=await browser.newContext(),errors=[],external=[];
  await context.route('**/*',route=>{if(!route.request().url().startsWith(origin+'/')){external.push(route.request().url());return route.abort();}return route.continue();});
  const page=async()=>{const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(origin);return p;};
  const a=await page(),b=await page();
  const imported=await a.evaluate(async()=>{
   await importZipFile(await legacyArchive(),{review:()=>true});const p=application.project,s=p.sections[0];
   return {id:p.id,revision:p.storageRevision,source:s.msiSeries.MSI_A.blobId,duplicate:s.msiSeries.MSI_B.blobId,file:s.msiFiles.f.blobId,
    value:await(await storage.getBlob(s.msiSeries.MSI_A.blobId)).blob.text(),jobs:(await readStore('archive_jobs')).length,pins:(await readStore('blob_pins')).length};
  });
  assert.equal(imported.revision,1);assert.equal(imported.source,imported.duplicate);assert.equal(imported.source,imported.file);
  assert.equal(imported.value,'x,y,v\n0,0,0\n1,0,10\n');assert.equal(imported.jobs,0);assert.equal(imported.pins,0);
  const roundtrip=await a.evaluate(async()=>{
   await exportProjectAsZip();if(alerts.length)throw new Error(alerts.join('\n'));
   const archive=exported;window.DESI_OFFLINE=true;await importZipFile(archive,{review:()=>true});
   return {count:(await storage.listProjects()).length,id:application.project.id,basis:application.project.sections[0].msiSeries.MSI_A.archiveProvenance.basis};
  });
  assert.equal(roundtrip.count,2);assert.notEqual(roundtrip.id,imported.id);assert.equal(roundtrip.basis,'legacy-v1-file');
  const failed=await a.evaluate(async()=>{
   exported=null;alerts.length=0;application.project.sections[0].images.HE.blobId='unavailable';await exportProjectAsZip();
   return {download:!!exported,error:alerts[0],jobs:(await readStore('archive_jobs')).length,pins:(await readStore('blob_pins')).length};
  });
  assert.equal(failed.download,false);assert.match(failed.error,/he.png/);assert.equal(failed.jobs,0);assert.equal(failed.pins,0);

  // An active import holds a Web Lock. Another tab's startup cleanup skips it.
  await a.evaluate(()=>{
   window.running=ProjectArchive.withImport(storage,async stage=>{await stage.putBlob({id:'uncommitted',blob:new Blob(['staged'])});window.stageReady=true;await new Promise(()=>{});}).catch(()=>{});
  });
  await a.waitForFunction(()=>window.stageReady===true);
  assert.equal(await b.evaluate(async()=>{await ProjectArchive.recoverImports(storage);return !!await storage.getBlob('uncommitted');}),true);
  await a.close();
  await b.waitForFunction(async()=>!(await navigator.locks.query()).held.some(lock=>lock.name.startsWith('desi-archive-job:')));
  await b.evaluate(()=>ProjectArchive.recoverImports(storage));
  assert.equal(await b.evaluate(()=>storage.getBlob('uncommitted')),null);
  assert.equal(await b.evaluate(async id=>(await storage.getBlob(id)).blob.text(),imported.source),imported.value,'existing imported source survives abandoned-import cleanup');

  // Crash after project commit but before the journal can acknowledge it.
  const c=await page();
  await c.evaluate(()=>{
   const delayed=Object.create(storage);delayed.putProject=async(p,opts)=>{await storage.putProject(p,opts);window.didCommit=true;await new Promise(()=>{});};
   window.running=ProjectArchive.withImport(delayed,async stage=>{
    await stage.putBlob({id:'committed-original',blob:new Blob(['committed bytes'])});
    await stage.putProject({id:'committed-project',displayName:'Committed',sections:[{id:'x',images:{HE:{blobId:'committed-original'}}}]},{createOnly:true});
   }).catch(()=>{});
  });
  await c.waitForFunction(()=>window.didCommit===true);await c.close();
  await b.waitForFunction(async()=>!(await navigator.locks.query()).held.some(lock=>lock.name.startsWith('desi-archive-job:')));
  await b.evaluate(()=>ProjectArchive.recoverImports(storage));
  assert.equal(await b.evaluate(async()=>(await storage.getBlob('committed-original')).blob.text()),'committed bytes');
  assert.equal(await b.evaluate(async()=>(await storage.getArchiveJobs()).length),0);

  // A different writer wins between staged.getBlob and create-only putBlob.
  const raced=await b.evaluate(async()=>{
   const competing=Object.create(storage);let first=true;
   competing.putBlob=async rec=>{
    if(first){first=false;await storage.putBlob({id:rec.id,archiveOwnerId:'other-writer',blob:new Blob(['other writer bytes'])});}
    return storage.putBlob(rec);
   };
   let code;try{await ProjectArchive.withImport(competing,stage=>stage.putBlob({id:'collision',blob:new Blob(['archive bytes'])}));}catch(e){code=e.code;}
   return {code,value:await(await storage.getBlob('collision')).blob.text(),jobs:(await storage.getArchiveJobs()).length,pins:(await readStore('blob_pins')).length};
  });
  assert.equal(raced.code,'BLOB_ID_EXISTS');assert.equal(raced.value,'other writer bytes');assert.equal(raced.jobs,0);assert.equal(raced.pins,0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Archive browser regression: PASS (real ZIP/IDB, v1 recovery, missing originals, live locks, crash boundaries, owner race)');
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
