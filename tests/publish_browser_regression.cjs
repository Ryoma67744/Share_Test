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
  const page=await browser.newPage(),errors=[],external=[],dialogs=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>{
   dialogs.push({type:dialog.type(),message:dialog.message()});
   // Opening a downloaded master copy may offer the existing, optional
   // collaborator-ROI Admin login. It is unrelated to the master publish cache.
   if(dialog.type()==='prompt'&&/共同研究者ROI/.test(dialog.message()))return dialog.dismiss();
   return dialog.accept();
  });
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
   // Project preparation can finish while the following publish modal starts.
   // Keep its completion/result in the page, rather than relying on CDP to
   // retain the short-lived evaluate promise during that UI transition.
   window.publishBrowserTasks=Object.create(null);
   window.startPublishBrowserTask=(name,action)=>{
    const state=publishBrowserTasks[name]={done:false,value:null,error:null};
    state.promise=Promise.resolve().then(action).then(value=>{state.value=value;state.done=true;},
     error=>{state.error={message:String(error.message||error),stack:String(error.stack||'')};state.done=true;});
   };
   // Exercise manual publishes at controlled barriers; background timers have
   // their own scheduler regression and must not consume the synthetic ticket.
    window.fixtureRealScheduleAutoPublish=App._scheduleAutoPublish;
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
  async function completedBrowserTask(name){
   await page.waitForFunction(name=>window.publishBrowserTasks[name]?.done,name,{timeout:15000});
   const state=await page.evaluate(name=>{
    const {value,error}=publishBrowserTasks[name];delete publishBrowserTasks[name];return {value,error};
   },name);
   if(state.error)throw new Error(state.error.stack||state.error.message);
   return state.value;
  }
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

  // Explicit same-slug replacement starts from an old local copy with no
  // trustworthy baseline. Comparisons and imports remain read-only remotely.
  // SQL is represented only at the network boundary: both ticket creation and
  // commit enforce the expected revision, and only commit changes remote data.
  const dialogStart=dialogs.length;
  await page.evaluate(()=>{
   sessionStorage.setItem('desi:masterPw',JSON.stringify({pw:'cached-overwrite-master',expiresAt:Date.now()+3600000}));
    window.overwriteFixture={revisions:{},docs:{},tokens:{},sessions:[],requests:[],committed:[],unlocks:[],states:[],uploads:[],hold:false,release:null,conflictCode:'PT409'};
   const f=overwriteFixture;
    const conflict=()=>Object.assign(new Error('publish_conflict'),{code:f.conflictCode});
   Object.assign(SupabaseClient,{
    unlockProjectMaster:async(slug,pw)=>{
     f.unlocks.push({slug,pw});if(pw!=='cached-overwrite-master')throw new Error('Unexpected master credential');
     const token='read-'+slug;f.tokens[token]=slug;
     return {token,role:'viewer',expires_at:new Date(Date.now()+3600000).toISOString()};
    },
    fetchProjectDoc:async token=>{
     const slug=f.tokens[token];if(!f.docs[slug])throw new Error('Unexpected read token');
     return {...structuredClone(f.docs[slug]),publish_revision:f.revisions[slug]};
    },
    listRois:async(token,sectionId)=>{
     const slug=f.tokens[token];if(!f.docs[slug])throw new Error('Unexpected ROI read token');
     return structuredClone((f.docs[slug].rois||[]).filter(roi=>!sectionId||roi.section_id===sectionId));
    },
    listShareOverlays:async()=>[],listShareAlignments:async()=>[],listShareImages:async()=>[],
    requestPublishSessionV2:async(pw,job)=>{
     if(pw!=='cached-overwrite-master')throw new Error('Unexpected publish credential');
     f.sessions.push(structuredClone(job));const current=f.revisions[job.slug];
     if(job.create?current!==undefined:current!==job.baseServerRevision)throw conflict();
     return {protocol:2,token:'write-'+job.jobId,object_prefix:job.slug+'/publish-v2/'+job.jobId+'/'};
    },
     getPublishStateV2:async(_pw,slug)=>{f.states.push(slug);return {protocol:2,exists:f.revisions[slug]!==undefined,server_revision:f.revisions[slug],receipt:null};},
    publishProjectDocV2:async args=>{
     f.requests.push(structuredClone(args));
     if(f.hold)await new Promise(resolve=>{f.release=resolve;});
     const current=f.revisions[args._slug];
     if(args._create_only?current!==undefined:current!==args._expected_revision)throw conflict();
     const revision=(current||0)+1;f.revisions[args._slug]=revision;
     const remote=f.docs[args._slug];
     remote.meta.project_meta=structuredClone(args._meta);
     remote.rois=args._rois.map((roi,index)=>({...roi,id:'published-'+index,section_id:remote.sections[0].id}));
     f.committed.push(structuredClone(args));
     return {ok:true,protocol:2,slug:args._slug,request_id:args._request_id,server_revision:revision,committed_at:new Date().toISOString()};
    },
    uploadBlob:async(...args)=>{f.uploads.push(args[1]);throw new Error('The no-original fixture must not upload storage objects');}
   });
   f.prepare=async(slug,revision)=>{
    await App.createNewProject('Local '+slug);const project=App.project,sectionId='local-section-'+slug;
    project.sections=[{id:sectionId,ordinal:1,displayName:'Local section',meta:{},images:{},msiSeries:{},msiFiles:{}}];
    project.rois=[0,1].map(index=>({id:'roi-'+slug+'-'+index,name:'Local ROI '+(index+1),colorKey:'default',
     polysBySection:{[sectionId]:[[index,0],[index+1,0],[index+1,1]]},version:1}));
    project.memo.freeNote='Local unsynchronized memo';
    project.shareInfo={slug,isPublic:true,url:location.origin+'/viewer/index.html#share='+slug};
    App.queueSave(60000);await App._flushSave();
    f.revisions[slug]=revision;
    f.docs[slug]={id:'remote-'+slug,slug,is_public:true,publish_revision:revision,
     meta:{display_name:'Remote '+slug,project_meta:{memo:{freeNote:'Remote memo'}}},anatomy_palette:{},rois:[],
     sections:[{id:'server-section-'+slug,ordinal:1,display_name:'Remote section',meta:{client_id:sectionId},storage_paths:{images:{},msiSeries:{},msiFiles:{}}}]};
    f.projectId=project.id;f.slug=slug;f.done=false;f.error=null;f.hold=false;f.release=null;
    return project.id;
   };
   f.compare=()=>{
    f.done=false;f.error=null;
    f.promise=_comparePublishedProject(App.project,f.slug,_readCachedMasterPw(),{meta:{slug:f.slug,isPublic:true}})
     .catch(error=>{f.error={code:error.code,message:error.message};}).finally(()=>{f.done=true;});
   };
  });
  async function prepareComparison(slug,revision){
   await page.evaluate(({slug,revision})=>{
    startPublishBrowserTask('prepare-comparison',async()=>{
     const id=await overwriteFixture.prepare(slug,revision);overwriteFixture.compare();return id;
    });
   },{slug,revision});
   const id=await completedBrowserTask('prepare-comparison');
   await page.locator('[data-publish-overwrite]').waitFor({state:'visible'});
   assert.equal(await page.locator('[data-publish-overwrite]').isEnabled(),true);
   const roiRow=page.locator('#modal-host tr').filter({has:page.locator('th',{hasText:'ROI'})});
   assert.deepEqual(await roiRow.locator('td').allTextContents(),['2','0']);
   if(slug==='overwrite-success'&&process.env.PUBLISH_COMPARE_SCREENSHOT)
    await page.locator('#modal-host .modal-card').screenshot({path:process.env.PUBLISH_COMPARE_SCREENSHOT});
   return id;
  }
  async function closeSuccess(){
   await page.locator('#modal-host [data-share-url]').waitFor({state:'visible'});
   await page.locator('#modal-host [data-modal-cancel]').click();
   await page.waitForFunction(()=>overwriteFixture.done);
  }
   async function assertConflictPaused(){
    const result=await page.evaluate(async()=>{
     const f=overwriteFixture,counts=()=>[f.sessions.length,f.requests.length,f.states.length,f.unlocks.length];
     const before=counts(),stub=App._scheduleAutoPublish;
     App._scheduleAutoPublish=fixtureRealScheduleAutoPublish;
     try{
      App.project.memo.freeNote+=' / edit after conflict';App.queueSave(60000);await App._flushSave();
      App._scheduleAutoPublish();await App.autoPublishProject();
      const ctx=_publishContext(App.project);
      return {before,after:counts(),state:App._syncState,paused:ctx.paused,timer:ctx.timer};
     }finally{App._scheduleAutoPublish=stub;}
    });
    assert.deepEqual(result.after,result.before,'A later edit cannot retry or fetch a receipt after a conflict');
    assert.equal(result.state,'conflict');assert.equal(result.paused,true);assert.equal(result.timer,0);
   }

  // Enter through the real Publish button flow once to exercise the cached
  // password and initial unknown-baseline guard, before explicit permission.
  await page.evaluate(()=>{
   startPublishBrowserTask('prepare-cancel',async()=>{
    const id=await overwriteFixture.prepare('overwrite-cancel',4);
    overwriteFixture.promise=publishProjectToShare().catch(error=>{overwriteFixture.error={code:error.code,message:error.message};})
     .finally(()=>{overwriteFixture.done=true;});return id;
   });
  });
  const cancelledId=await completedBrowserTask('prepare-cancel');
  await page.locator('#modal-host [name="slug"]').waitFor({state:'visible'});
  await page.locator('#modal-host [data-modal-ok]').click();
  await page.locator('[data-publish-overwrite]').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>overwriteFixture.sessions.length),0,'Reading a comparison does not silently adopt a remote revision');
  await page.locator('#modal-host [data-modal-cancel]').click();
  await page.waitForFunction(()=>overwriteFixture.done);
  const cancelled=await page.evaluate(async id=>({project:await ProjectStorage.getProject(id),sessions:overwriteFixture.sessions.length,
   requests:overwriteFixture.requests.length,revision:overwriteFixture.revisions['overwrite-cancel']}),cancelledId);
  assert.equal(cancelled.sessions,0);assert.equal(cancelled.requests,0);assert.equal(cancelled.revision,4);
  assert.equal(cancelled.project.shareInfo.serverRevision,undefined);assert.equal(cancelled.project.rois.length,2);

  const importId=await prepareComparison('overwrite-import',6);
  const importCounts=await page.evaluate(()=>({sessions:overwriteFixture.sessions.length,requests:overwriteFixture.requests.length}));
  await page.locator('#modal-host [data-modal-ok]').click();
  await page.waitForFunction(()=>overwriteFixture.done);
  const imported=await page.evaluate(async id=>({active:App.project.id,copy:await ProjectStorage.getProject(App.project.id),old:await ProjectStorage.getProject(id),
   sessions:overwriteFixture.sessions.length,requests:overwriteFixture.requests.length,revision:overwriteFixture.revisions['overwrite-import'],error:overwriteFixture.error}),importId);
  assert.equal(imported.error,null);assert.notEqual(imported.active,importId);assert.equal(imported.copy.shareInfo.serverRevision,6);
  assert.equal(imported.copy.rois.length,0);assert.equal(imported.old.rois.length,2);assert.equal(imported.old.shareInfo.serverRevision,undefined);
  assert.equal(imported.sessions,importCounts.sessions);assert.equal(imported.requests,importCounts.requests);assert.equal(imported.revision,6);

  const successId=await prepareComparison('overwrite-success',9);
  const beforeSuccess=await page.evaluate(async()=>({project:await ProjectStorage.getProject(overwriteFixture.projectId),requests:overwriteFixture.requests.length}));
  assert.equal(beforeSuccess.project.shareInfo.serverRevision,undefined);
  await page.locator('[data-publish-overwrite]').click();await closeSuccess();
  const replaced=await page.evaluate(async id=>({project:await ProjectStorage.getProject(id),request:overwriteFixture.requests.at(-1),
   remote:overwriteFixture.docs['overwrite-success'],revision:overwriteFixture.revisions['overwrite-success'],error:overwriteFixture.error}),successId);
  assert.equal(replaced.error,null);assert.equal(replaced.revision,10);assert.equal(replaced.project.shareInfo.serverRevision,10);
  assert.equal(replaced.request._slug,'overwrite-success');assert.equal(replaced.request._create_only,false);assert.equal(replaced.request._expected_revision,9);
  assert.equal(replaced.request._rois.length,2);assert.equal(replaced.remote.rois.length,2);assert.equal(replaced.project.rois.length,2);
  assert.equal(replaced.project.memo.freeNote,'Local unsynchronized memo');

  const staleId=await prepareComparison('overwrite-stale',12);
  const beforeStale=await page.evaluate(()=>{overwriteFixture.revisions['overwrite-stale']=13;return overwriteFixture.requests.length;});
  await page.locator('[data-publish-overwrite]').click();await page.waitForFunction(()=>overwriteFixture.done);
  const stale=await page.evaluate(async id=>({project:await ProjectStorage.getProject(id),requests:overwriteFixture.requests.length,
   revision:overwriteFixture.revisions['overwrite-stale'],remote:overwriteFixture.docs['overwrite-stale'],status:App._syncState}),staleId);
  assert.equal(stale.requests,beforeStale);assert.equal(stale.revision,13);assert.equal(stale.remote.rois.length,0);
  assert.equal(stale.project.shareInfo.serverRevision,undefined);assert.equal(stale.project.rois.length,2);assert.equal(stale.status,'conflict');
   await assertConflictPaused();

  // Recheck the server revision at commit, after the comparison and ticket.
  const commitRaceId=await prepareComparison('overwrite-commit-race',15);
  await page.evaluate(()=>{overwriteFixture.hold=true;});
  await page.locator('[data-publish-overwrite]').click();
  await page.waitForFunction(()=>typeof overwriteFixture.release==='function');
  await page.evaluate(()=>{overwriteFixture.revisions['overwrite-commit-race']=16;overwriteFixture.hold=false;overwriteFixture.release();});
  await page.waitForFunction(()=>overwriteFixture.done);
  const commitRace=await page.evaluate(async id=>({project:await ProjectStorage.getProject(id),revision:overwriteFixture.revisions['overwrite-commit-race'],
    remote:overwriteFixture.docs['overwrite-commit-race'],requests:overwriteFixture.requests.filter(request=>request._slug==='overwrite-commit-race'),
    stateReads:overwriteFixture.states.filter(slug=>slug==='overwrite-commit-race'),committed:overwriteFixture.committed.filter(request=>request._slug==='overwrite-commit-race')}),commitRaceId);
  assert.equal(commitRace.revision,16);assert.equal(commitRace.remote.rois.length,0);assert.equal(commitRace.committed.length,0);
  assert.equal(commitRace.project.shareInfo.serverRevision,undefined);assert.equal(commitRace.project.rois.length,2);
   assert.equal(commitRace.requests.length,1);assert.equal(commitRace.stateReads.length,0);
   await assertConflictPaused();
   await prepareComparison('overwrite-legacy-conflict',17);
   await page.evaluate(()=>{overwriteFixture.conflictCode='40001';overwriteFixture.revisions['overwrite-legacy-conflict']=18;});
   await page.locator('[data-publish-overwrite]').click();await page.waitForFunction(()=>overwriteFixture.done);
   await assertConflictPaused();
   await page.evaluate(()=>{overwriteFixture.conflictCode='PT409';});

  // The comparison is bound to the local state that was shown to the user.
  const changedId=await prepareComparison('overwrite-local-changed',20);
  const beforeChanged=await page.evaluate(async()=>{App.project.memo.freeNote='Changed while comparing';App.queueSave(60000);await App._flushSave();return overwriteFixture.sessions.length;});
  await page.locator('[data-publish-overwrite]').click();await page.waitForFunction(()=>overwriteFixture.done);
  const changed=await page.evaluate(async id=>({project:await ProjectStorage.getProject(id),sessions:overwriteFixture.sessions.length,revision:overwriteFixture.revisions['overwrite-local-changed']}),changedId);
  assert.equal(changed.sessions,beforeChanged);assert.equal(changed.revision,20);assert.equal(changed.project.shareInfo.serverRevision,undefined);
  assert.equal(changed.project.memo.freeNote,'Changed while comparing');

  // A queued publication must revalidate after the global gate opens, before
  // obtaining a ticket or taking a snapshot of edits not shown in comparison.
  const gateId=await prepareComparison('overwrite-gate-edit',22);
  const beforeGate=await page.evaluate(()=>{
   document.getElementById('toast-host').replaceChildren();
   let release;
   const deferred=new Promise(resolve=>{release=resolve;});
   overwriteFixture.gateWaitEntered=false;
   _publishGate={then(resolve,reject){overwriteFixture.gateWaitEntered=true;return deferred.then(resolve,reject);}};
   overwriteFixture.releaseGate=()=>{_publishGate=null;release();};
   return {epoch:App.project.publishEditEpoch,sessions:overwriteFixture.sessions.length,
    requests:overwriteFixture.requests.length,committed:overwriteFixture.committed.length};
  });
  await page.locator('[data-publish-overwrite]').click();
  await page.waitForFunction(()=>overwriteFixture.gateWaitEntered);
  const gateEpoch=await page.evaluate(async()=>{
   App.project.memo.freeNote='Changed while publication was queued';App.queueSave(60000);await App._flushSave();
   const epoch=App.project.publishEditEpoch;overwriteFixture.releaseGate();return epoch;
  });
  assert.ok(gateEpoch>beforeGate.epoch,'The local edit happens after the comparison entered the publication gate');
  await page.waitForFunction(()=>overwriteFixture.done);
  const gated=await page.evaluate(async id=>({project:await ProjectStorage.getProject(id),sessions:overwriteFixture.sessions.length,
   requests:overwriteFixture.requests.length,committed:overwriteFixture.committed.length,
   revision:overwriteFixture.revisions['overwrite-gate-edit'],remote:overwriteFixture.docs['overwrite-gate-edit'],status:App._syncState,
   toasts:Array.from(document.querySelectorAll('#toast-host .toast'),el=>el.textContent)}),gateId);
  assert.equal(gated.sessions,beforeGate.sessions);assert.equal(gated.requests,beforeGate.requests);assert.equal(gated.committed,beforeGate.committed);
  assert.equal(gated.revision,22);assert.equal(gated.remote.rois.length,0);assert.equal(gated.project.shareInfo.serverRevision,undefined);
  assert.equal(gated.project.memo.freeNote,'Changed while publication was queued');assert.equal(gated.project.rois.length,2);
  assert.equal(gated.status,'conflict');
  assert.ok(gated.toasts.includes('比較後にローカル版が変わりました。もう一度比較してください。'),'PUBLISH_LOCAL_CHANGED asks for a fresh comparison');

  // Edits after the accepted snapshot are saved locally and remain pending;
  // the successful receipt must never erase or mislabel them as published.
  const laterId=await prepareComparison('overwrite-later-edit',24);
  await page.evaluate(()=>{overwriteFixture.hold=true;});
  await page.locator('[data-publish-overwrite]').click();
  await page.waitForFunction(()=>typeof overwriteFixture.release==='function');
  await page.evaluate(async()=>{
   App.project.memo.freeNote='New local edit during overwrite';App.queueSave(60000);await App._flushSave();
   overwriteFixture.hold=false;overwriteFixture.release();
  });
  await closeSuccess();
  const later=await page.evaluate(async id=>({project:await ProjectStorage.getProject(id),live:App.project.memo.freeNote,pending:App.project.__publishPending,
   request:overwriteFixture.requests.at(-1),revision:overwriteFixture.revisions['overwrite-later-edit'],error:overwriteFixture.error}),laterId);
  assert.equal(later.error,null);assert.equal(later.revision,25);assert.equal(later.project.shareInfo.serverRevision,25);
  assert.equal(later.request._meta.memo.freeNote,'Local unsynchronized memo');assert.equal(later.project.memo.freeNote,'New local edit during overwrite');
  assert.equal(later.live,later.project.memo.freeNote);assert.equal(later.project.__publishPending,true);assert.equal(later.pending,true);
  assert.equal(await page.evaluate(()=>overwriteFixture.uploads.length),0);
  assert.ok((await page.evaluate(()=>overwriteFixture.unlocks)).every(read=>read.pw==='cached-overwrite-master'));
  assert.deepEqual(dialogs.slice(dialogStart).filter(dialog=>dialog.type==='prompt'&&!/共同研究者ROI/.test(dialog.message)),[],
   'Cached master credentials are reused without another password prompt');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Publish browser regression: PASS (immutable snapshots, A/B switch, explicit overwrite, cancel/import, server and local conflicts, queued-publication edit guard, cached authentication, pending edits)');
 }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
