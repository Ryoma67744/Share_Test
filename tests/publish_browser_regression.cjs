'use strict';
// Real viewer + IndexedDB; only the network boundary is synthetic. This test
// never opens a user's browser profile or sends data to an external service.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const {renderOfflineConfig}=require('../offline/config.cjs');
const root=path.resolve(__dirname,'..');
async function main(){
 let online=false;
 const server=http.createServer(async(req,res)=>{try{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(pathname==='/runtime-config.js'){res.setHeader('Content-Type','text/javascript');res.end(online
   ? 'window.DESI_BUILD_CONFIG='+JSON.stringify({mode:'online',cloud:{url:'http://'+req.headers.host,anonKey:'synthetic-only'}})+';'
   : renderOfflineConfig());return;}
  const file=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css'})[path.extname(file)]||'application/octet-stream');
  res.end(await fs.readFile(file));
 }catch{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const page=await browser.newPage(),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/')||/^(blob|data):/.test(route.request().url()))return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(origin+'/viewer/?project=synthetic-publish-empty');
  await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline&&typeof PublishSafety!=='undefined');
  const seed=await page.evaluate(async()=>{
   const id=await App.createNewProject('Synthetic seed');
   sessionStorage.setItem('desi:masterUnlocked',JSON.stringify({expiresAt:Date.now()+60000}));return id;
  });
  online=true;
  await page.goto(origin+'/viewer/?project='+encodeURIComponent(seed));
  await page.waitForFunction(()=>typeof App!=='undefined'&&!App.offline&&App.project);
  await page.evaluate(async()=>{
   // Exercise manual publishes at controlled barriers; background timers have
   // their own scheduler regression and must not consume the synthetic ticket.
   App._scheduleAutoPublish=()=>{};
   window.fixturePublish={hold:true,revisions:{},requests:[],receipts:{},release:null};
   Object.assign(SupabaseClient,{
    configured:()=>true,
    requestPublishSessionV2:async(_pw,job)=>{
     const current=fixturePublish.revisions[job.slug];
     if(job.create?current!==undefined:current!==job.baseServerRevision)throw Object.assign(new Error('publish_conflict'),{code:'40001'});
     return {protocol:2,token:'synthetic-ticket',object_prefix:job.slug+'/publish-v2/'+job.jobId+'/'};
    },
    getPublishStateV2:async(_pw,slug,id)=>({protocol:2,exists:fixturePublish.revisions[slug]!==undefined,receipt:fixturePublish.receipts[id]}),
    publishProjectDocV2:async args=>{
     fixturePublish.requests.push(structuredClone(args));
     if(fixturePublish.hold)await new Promise(resolve=>{fixturePublish.release=resolve;});
     const revision=(fixturePublish.revisions[args._slug]||0)+1;fixturePublish.revisions[args._slug]=revision;
     return fixturePublish.receipts[args._request_id]={ok:true,protocol:2,slug:args._slug,request_id:args._request_id,server_revision:revision,committed_at:new Date().toISOString()};
    }
   });
   window.startFixturePublish=()=>{
    fixturePublish.release=null;fixturePublish.failure=null;
    fixturePublish.promise=_publishCoreInner(App.project,{slug:'synthetic-a',isPublic:true},'synthetic-only',{silent:true})
      .catch(error=>{fixturePublish.failure=error.message;});
   };
   await App.createNewProject('Synthetic A');window.fixtureA=App.project.id;
   startFixturePublish();
  });
  await page.waitForFunction(()=>typeof fixturePublish.release==='function');
  const edited=await page.evaluate(async()=>{
   App.project.memo.freeNote='edited while the first publish was committing';App.queueSave(60000);await App._flushSave();
   fixturePublish.hold=false;fixturePublish.release();await fixturePublish.promise;
   return {project:await ProjectStorage.getProject(fixtureA),livePending:App.project.__publishPending,error:fixturePublish.failure,request:fixturePublish.requests[0]};
  });
  assert.equal(edited.error,null);assert.equal(edited.project.shareInfo.serverRevision,1);
  assert.equal(edited.project.memo.freeNote,'edited while the first publish was committing');
  assert.equal(edited.project.__publishPending,true);assert.equal(edited.livePending,true);
  assert.notEqual(edited.request._meta.memo.freeNote,edited.project.memo.freeNote,'first immutable snapshot excludes later edits');
  const synchronized=await page.evaluate(async()=>{startFixturePublish();await fixturePublish.promise;return {p:await ProjectStorage.getProject(fixtureA),error:fixturePublish.failure};});
  assert.equal(synchronized.error,null);assert.equal(synchronized.p.shareInfo.serverRevision,2);assert.equal(synchronized.p.__publishPending,undefined);
  await page.evaluate(async()=>{App.project.memo.freeNote='next A publish';App.queueSave(60000);await App._flushSave();fixturePublish.hold=true;startFixturePublish();});
  await page.waitForFunction(()=>typeof fixturePublish.release==='function');
  const switched=await page.evaluate(async()=>{
   await App.createNewProject('Synthetic B');window.fixtureB=App.project.id;
   App.project.shareInfo={slug:'synthetic-b',serverRevision:0,isPublic:true,url:'synthetic'};
   App.project.memo.freeNote='B pending edit';App.queueSave(60000);await App._flushSave();
   App._setSyncStatus('local-saved');fixturePublish.hold=false;fixturePublish.release();await fixturePublish.promise;
   return {active:App.project.id,dirty:App._publishDirty,status:App._syncState,b:await ProjectStorage.getProject(fixtureB),a:await ProjectStorage.getProject(fixtureA),error:fixturePublish.failure};
  });
  assert.equal(switched.error,null);assert.equal(switched.active,switched.b.id);assert.equal(switched.dirty,true);
  assert.equal(switched.status,'local-saved');assert.equal(switched.b.__publishPending,true);assert.equal(switched.b.memo.freeNote,'B pending edit');
  assert.equal(switched.a.shareInfo.serverRevision,3);assert.equal(switched.a.__publishPending,undefined);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Publish browser regression: PASS (first-publish edits, immutable snapshot, receipt save, A/B switch)');
 }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
