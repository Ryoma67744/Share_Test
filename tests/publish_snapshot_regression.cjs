'use strict';
const assert=require('node:assert/strict');
const Safety=require('../viewer/publish-safety.js');
const fs=require('node:fs'),vm=require('node:vm');
const clone=x=>JSON.parse(JSON.stringify(x));
const original=new Blob(['immutable source'],{type:'text/plain'});
function setup(){
 const project={id:'a',displayName:'Snapshot',storageRevision:4,publishEditEpoch:2,__publishPending:true,memo:{text:'before'},
  meta:{msiDisplay:{version:2,preset:'custom',aspectMode:'physical',rangePolicy:'maximum',smoothingStrength:6,linearStrength:4},colormap:'hotmetal',msiSmoothing:'median'},
  sections:[{id:'s',displayName:'S',images:{HE:{blobId:'image',filename:'h.png'}},msiSeries:{MSI_A:{blobId:'raw',filename:'original.txt',archiveProvenance:{version:1,basis:'registered-source'},archiveGeometryUnconfirmed:true}},msiFiles:{raw:{blobId:'raw',filename:'registered-other-name.txt'},unused:{blobId:'unused'}}}],rois:[]};
 let seq=0;const logs={uploads:[],intents:[],receipts:[],pins:[],releases:[],commits:[],sessions:[],states:[]},records=new Map(['image','raw','unused'].map(k=>[k,{blob:original,mime:'text/plain'}]));
 const hooks={uuid:()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}`,freezeSources(){},media:()=>({items:[]}),publicPhoto:x=>clone(x),imageIdentity:()=>null,viewerOverlay:()=>false,encodeRoi:()=>[],url:slug=>'https://example.invalid/#share='+slug,
  state:async(...args)=>{logs.states.push(args);return {protocol:2,exists:false,receipt:null};},session:async job=>{logs.sessions.push(clone(job));return {protocol:2,token:'synthetic-ticket',object_prefix:job.slug+'/publish-v2/'+job.jobId+'/'};},
  blob:async id=>records.get(id),exists:async()=>true,remoteBlob:async()=>null,
  pin:async(...x)=>logs.pins.push(x),release:async id=>logs.releases.push(id),intent:async x=>logs.intents.push(clone(x)),
  upload:async(path,blob)=>logs.uploads.push({path,blob}),start(){},progress(){},assertActive(){},close(){},
  commit:async args=>{logs.commits.push(clone(args));return {ok:true,protocol:2,slug:args._slug,request_id:args._request_id,server_revision:args._expected_revision+1,committed_at:'2026-11-04T00:00:00Z'};},receipt:async r=>logs.receipts.push(clone(r))};
 return {project,hooks,logs,records,meta:{slug:'new_slug',isPublic:true}};
}
async function overwriteChecks(previous){
 let checks=0;
 const fixture=()=>{const f=setup();f.project.shareInfo={slug:f.meta.slug};return f;};
 const approval=(f,serverRevision=5)=>({confirmedOverwrite:{slug:f.meta.slug,serverRevision}});
 const quiet=f=>{for(const key of ['uploads','intents','receipts','pins','releases','commits','sessions','states'])assert.equal(f.logs[key].length,0,key+' must have no side effect');};
 const approved=fixture();approved.project.rois=[{name:'local ROI',polysBySection:{s:[[1,2],[3,4],[5,6]]}},
  {name:'collaborator ROI',_collab:true,polysBySection:{s:[[2,3],[4,5],[6,7]]}}];
 const before=clone(approved.project),originalReceipt=approved.hooks.receipt;
 approved.hooks.receipt=async receipt=>{assert.equal(approved.project.shareInfo.serverRevision,undefined,'Only a receipt may advance the local baseline');return originalReceipt(receipt);};
 const receipt=await Safety.run(approved.project,approved.meta,approved.hooks,approval(approved));
 assert.equal(receipt.serverRevision,6);assert.equal(receipt.baseServerRevision,5);
 assert.equal(approved.logs.sessions[0].create,false);assert.equal(approved.logs.commits[0]._create_only,false);
 assert.equal(approved.logs.commits[0]._expected_revision,5);assert.equal(approved.logs.commits[0]._rois.length,1);
 assert.equal(approved.logs.commits[0]._rois[0].name,'local ROI');assert.deepEqual(approved.project,before);
 assert.ok(approved.logs.uploads.every(item=>item.blob===original),'Original immutable Blobs are retained');
 await assert.rejects(()=>Safety.run(approved.project,approved.meta,approved.hooks),{code:'PUBLISH_BASELINE_UNKNOWN'});
 assert.equal(approved.logs.commits.length,1,'An approval is not remembered by a subsequent ordinary run');checks+=11;
 const ordinary=fixture();ordinary.project.shareInfo.serverRevision=2;
 await Safety.run(ordinary.project,ordinary.meta,ordinary.hooks,{confirmedOverwrite:undefined});
 assert.equal(ordinary.logs.commits[0]._expected_revision,2,'An optional undefined approval keeps ordinary baseline validation');checks++;

 for(const bad of [null,[],{},false,{slug:'different',serverRevision:5},...['5',null,false,-1,NaN,Infinity].map(serverRevision=>({slug:'new_slug',serverRevision}))]){
  const f=fixture(),before=clone(f.project);let frozen=0;f.hooks.freezeSources=()=>{frozen++;};
  await assert.rejects(()=>Safety.run(f.project,f.meta,f.hooks,{confirmedOverwrite:bad}),{code:'PUBLISH_OVERWRITE_INVALID'});
  quiet(f);assert.equal(frozen,0);assert.deepEqual(f.project,before);checks+=4;
 }
 for(const slug of [null,'different']){
  const f=fixture();f.project.shareInfo=slug?{slug}:{};
  await assert.rejects(()=>Safety.run(f.project,f.meta,f.hooks,approval(f)),{code:'PUBLISH_OVERWRITE_INVALID'});quiet(f);checks+=2;
 }
 const incomplete=fixture();incomplete.project.__importFailures=2;const incompleteBefore=clone(incomplete.project);
 await assert.rejects(()=>Safety.run(incomplete.project,incomplete.meta,incomplete.hooks,approval(incomplete)),{code:'PUBLISH_SOURCE_MISSING'});
 quiet(incomplete);assert.deepEqual(incomplete.project,incompleteBefore);checks+=3;
 const newer=fixture();newer.project.shareInfo.serverRevision=6;
 await assert.rejects(()=>Safety.run(newer.project,newer.meta,newer.hooks,approval(newer,5)),{code:'PT409'});quiet(newer);checks+=2;
 const missing=fixture();missing.records.delete('unused');
 await assert.rejects(()=>Safety.run(missing.project,missing.meta,missing.hooks,approval(missing)),{code:'PUBLISH_SOURCE_MISSING'});
 assert.equal(missing.logs.uploads.length,0);assert.equal(missing.logs.commits.length,0);assert.equal(missing.project.shareInfo.serverRevision,undefined);checks+=4;
 const sessionConflict=fixture();sessionConflict.hooks.session=async()=>{throw Object.assign(new Error('new remote version'),{code:'40001'});};
 await assert.rejects(()=>Safety.run(sessionConflict.project,sessionConflict.meta,sessionConflict.hooks,approval(sessionConflict)),{code:'40001'});
 quiet(sessionConflict);checks+=2;
 const commitConflict=fixture();commitConflict.project.shareInfo.serverRevision=1;commitConflict.hooks.commit=async args=>{
  commitConflict.logs.commits.push(clone(args));throw Object.assign(new Error('another publisher won'),{code:'40001'});};
 await assert.rejects(()=>Safety.run(commitConflict.project,commitConflict.meta,commitConflict.hooks,approval(commitConflict)),{code:'40001'});
 assert.equal(commitConflict.logs.commits.length,1);assert.equal(commitConflict.logs.receipts.length,0);
 assert.equal(commitConflict.project.shareInfo.serverRevision,1,'A failed override cannot promote the old baseline');checks+=4;

 const pending=(state)=>{const f=fixture();let id=700;f.hooks.uuid=()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`;
  f.project.shareInfo.pendingPublish=clone(previous);f.hooks.state=async()=>state;return f;};
 const priorReceipt={ok:true,protocol:2,slug:previous.slug,request_id:previous.jobId,server_revision:1};
 const uncommitted=pending({protocol:2,exists:true,server_revision:5,receipt:null});
 await Safety.run(uncommitted.project,uncommitted.meta,uncommitted.hooks,approval(uncommitted));
 assert.equal(uncommitted.logs.commits.length,1);assert.equal(uncommitted.logs.commits[0]._expected_revision,5);
 assert.notEqual(uncommitted.logs.commits[0]._request_id,previous.jobId,'Superseding a stale intent uses a new immutable request');
 assert.equal(uncommitted.logs.intents[0].replacesJobId,previous.jobId);
 assert.ok(!uncommitted.logs.releases.includes(previous.jobId),'An uncommitted old job is not assumed dead and unpinned');checks+=5;
 const lost=pending({protocol:2,exists:true,server_revision:5,receipt:priorReceipt});
 await Safety.run(lost.project,lost.meta,lost.hooks,approval(lost));
 assert.deepEqual(lost.logs.receipts.map(r=>r.serverRevision),[1,6]);
 assert.equal(lost.logs.commits.length,1);assert.equal(lost.logs.commits[0]._expected_revision,5);
 assert.ok(lost.logs.releases.includes(previous.jobId),'A verified completed old job may release its pin');checks+=4;
 const done=pending({protocol:2,exists:true,server_revision:1,receipt:priorReceipt});
 const doneReceipt=await Safety.run(done.project,done.meta,done.hooks,approval(done,1));
 assert.equal(doneReceipt.serverRevision,1);assert.equal(done.logs.commits.length,0);assert.equal(done.logs.sessions.length,0);
 assert.equal(done.logs.receipts.length,1,'The same already-published snapshot is reconciled without a second write');checks+=4;
 const edited=pending({protocol:2,exists:true,server_revision:1,receipt:priorReceipt});edited.project.publishEditEpoch++;edited.project.memo.text='newer local edit';
 await Safety.run(edited.project,edited.meta,edited.hooks,approval(edited,1));
 assert.equal(edited.logs.commits[0]._expected_revision,1);assert.equal(edited.logs.commits[0]._meta.memo.text,'newer local edit');checks+=2;
 for(const state of [{protocol:2,exists:true,server_revision:6,receipt:null},{protocol:2,exists:false,server_revision:null,receipt:null}]){
  const f=pending(state);await assert.rejects(()=>Safety.run(f.project,f.meta,f.hooks,approval(f)),{code:'PT409'});
  assert.equal(f.logs.commits.length,0);assert.equal(f.logs.sessions.length,0);checks+=3;
 }
 const oldApproval=pending({protocol:2,exists:true,server_revision:1,receipt:priorReceipt});
 await assert.rejects(()=>Safety.run(oldApproval.project,oldApproval.meta,oldApproval.hooks,approval(oldApproval,0)),{code:'PT409'});
 assert.equal(oldApproval.logs.commits.length,0);assert.equal(oldApproval.logs.receipts.length,1,'A genuine old receipt is recovered even when the overwrite approval has expired');checks+=3;
 const different=fixture();different.project.shareInfo.pendingPublish={...clone(previous),slug:'different-target'};
 await assert.rejects(()=>Safety.run(different.project,different.meta,different.hooks,approval(different)),{code:'PUBLISH_PENDING_CONFLICT'});quiet(different);checks+=2;
 const network=fixture();let attempts=0;network.hooks.commit=async args=>{network.logs.commits.push(clone(args));
  if(++attempts===1)throw new Error('response lost');return {ok:true,protocol:2,slug:args._slug,request_id:args._request_id,server_revision:6};};
 await Safety.run(network.project,network.meta,network.hooks,approval(network));
 assert.equal(attempts,2);assert.deepEqual(network.logs.commits[0],network.logs.commits[1]);assert.equal(network.logs.receipts.length,1);checks+=3;
 return checks;
}
async function main(){
 let checks=0;
 const a=setup(),before=clone(a.project);let sessionRelease;
 const oldSession=a.hooks.session;a.hooks.session=job=>new Promise(resolve=>{sessionRelease=()=>resolve(oldSession(job));});
 const run=Safety.run(a.project,a.meta,a.hooks);
 a.project.memo.text='new edit';a.project.sections[0].msiSeries.MSI_A.blobId='replacement';a.project.publishEditEpoch++;
 a.project.meta.msiDisplay.aspectMode='legacy';a.project.meta.colormap='plasma';
 a.project.meta.msiDisplay.smoothingStrength=2;a.project.meta.msiDisplay.linearStrength=9;a.project.meta.msiSmoothing='linear';
 sessionRelease();await run;
 assert.equal(a.logs.commits[0]._meta.memo.text,'before');assert.equal(a.logs.receipts[0].publishedEditEpoch,2);
 assert.deepEqual(a.logs.commits[0]._meta.msiDisplay,before.meta.msiDisplay,'Publication snapshots display settings before asynchronous uploads');
 assert.equal(a.logs.commits[0]._meta.colormap,'hotmetal');
 assert.equal(a.logs.commits[0]._meta.msiSmoothing,'median','Median mode survives publication with the captured independent levels');checks+=3;
 assert.equal(a.logs.uploads.length,3);assert.ok(a.logs.uploads.every(x=>x.path.startsWith('new_slug/publish-v2/')&&x.blob===original));
 assert.equal(a.logs.commits[0]._sections[0].storagePaths.msiFiles.raw.path,a.logs.commits[0]._sections[0].storagePaths.msiSeries.MSI_A.path);
 assert.equal(a.logs.commits[0]._sections[0].storagePaths.msiFiles.raw.filename,'registered-other-name.txt');
 assert.equal(a.logs.commits[0]._sections[0].storagePaths.msiSeries.MSI_A.archiveProvenance.basis,'registered-source');assert.equal(a.logs.commits[0]._sections[0].storagePaths.msiSeries.MSI_A.archiveGeometryUnconfirmed,true);
 assert.deepEqual(a.logs.pins[0][1].sort(),['image','raw','unused']);assert.equal(a.logs.releases.length,1);checks+=9;
 const missing=setup();missing.records.delete('unused');await assert.rejects(()=>Safety.run(missing.project,missing.meta,missing.hooks),{code:'PUBLISH_SOURCE_MISSING'});
 assert.equal(missing.logs.uploads.length,0);assert.equal(missing.logs.commits.length,0);assert.equal(missing.logs.releases.length,1);checks+=4;
 const unknown=setup();unknown.project.shareInfo={slug:unknown.meta.slug};await assert.rejects(()=>Safety.run(unknown.project,unknown.meta,unknown.hooks),{code:'PUBLISH_BASELINE_UNKNOWN'});assert.equal(unknown.logs.intents.length,0);checks+=2;
 for(const rev of [null,'0',false,-1,NaN])assert.throws(()=>Safety.baseline({shareInfo:{slug:'s',serverRevision:rev}},'s'));checks+=5;
 const reuse=setup();reuse.project.shareInfo={slug:reuse.meta.slug,serverRevision:3,blobPaths:{raw:{path:'new_slug/old-original'}}};reuse.records.delete('raw');await Safety.run(reuse.project,reuse.meta,reuse.hooks);assert.equal(reuse.logs.uploads.length,2);assert.equal(reuse.logs.commits[0]._expected_revision,3);checks+=2;
 const failed=setup();let seen=0;failed.hooks.commit=async args=>{failed.logs.commits.push(clone(args));if(++seen===1)throw new Error('response lost');return {ok:true,protocol:2,slug:args._slug,request_id:args._request_id,server_revision:1};};await Safety.run(failed.project,failed.meta,failed.hooks);assert.deepEqual(failed.logs.commits[0],failed.logs.commits[1]);checks++;
 const recover=setup();const previous=a.logs.intents.at(-1);recover.project.shareInfo={slug:recover.meta.slug,pendingPublish:previous};recover.hooks.state=async()=>({exists:true,receipt:{ok:true,protocol:2,slug:previous.slug,request_id:previous.jobId,server_revision:1}});await Safety.run(recover.project,recover.meta,recover.hooks);assert.equal(recover.logs.uploads.length,0);assert.equal(recover.logs.receipts.length,1);assert.deepEqual(recover.logs.releases,[previous.jobId]);checks+=3;
 const followed=setup();followed.project.publishEditEpoch=3;followed.project.shareInfo={slug:'previous-slug',serverRevision:4,pendingPublish:previous};
 followed.hooks.state=recover.hooks.state;followed.hooks.receipt=async r=>{followed.project.shareInfo={slug:r.slug,serverRevision:r.serverRevision};};
 followed.hooks.intent=async intent=>{assert.equal(intent.sourceSlug,followed.project.shareInfo.slug);assert.equal(intent.previousSlug,intent.sourceSlug);followed.logs.intents.push(clone(intent));};
 await Safety.run(followed.project,followed.meta,followed.hooks);assert.equal(followed.logs.commits[0]._expected_revision,1);assert.equal(followed.logs.commits[0]._create_only,false);checks+=4;
 const conflict=setup();conflict.hooks.commit=async()=>{conflict.logs.commits.push(1);throw Object.assign(new Error('conflict'),{code:'40001'});};await assert.rejects(()=>Safety.run(conflict.project,conflict.meta,conflict.hooks),{code:'40001'});assert.equal(conflict.logs.commits.length,1);assert.equal(conflict.logs.receipts.length,0);checks+=3;
 checks+=await overwriteChecks(previous);
 // Both protocol generations stop at the first session/commit conflict. A
 // saved intent may be read once before resuming, never after a conflict.
 for(const code of ['PT409','40001'])for(const stage of ['session','commit'])for(const resume of [false,true]){
  const f=setup(),before=clone(f.project);
  if(resume)f.project.shareInfo={slug:f.meta.slug,pendingPublish:clone(previous)};
  f.hooks[stage]=async args=>{f.logs[stage==='session'?'sessions':'commits'].push(clone(args));throw Object.assign(new Error('publish_conflict'),{code});};
  await assert.rejects(()=>Safety.run(f.project,f.meta,f.hooks),{code});
  assert.equal(f.logs.sessions.length,1);assert.equal(f.logs.commits.length,stage==='commit'?1:0);
  assert.equal(f.logs.states.length,resume?1:0,'No receipt lookup follows a conflict');
  assert.equal(f.logs.receipts.length,0);assert.equal(f.project.storageRevision,before.storageRevision);
  assert.equal(f.project.shareInfo?.serverRevision,undefined);checks+=7;
 }
 // Execute production receipt adoption: never advance a stale live storage token.
 const html=fs.readFileSync(require.resolve('../viewer/index.html'),'utf8');const start=html.indexOf('function _adoptPublishPatch('),end=html.indexOf('\n}',start)+2;
 const live={storageRevision:4,shareInfo:{slug:'s'},memo:{text:'new unsaved edit'}};const ctx=vm.createContext({App:{project:live}});vm.runInContext(html.slice(start,end),ctx);
 assert.equal(ctx._adoptPublishPatch(live,{applied:true,project:{shareInfo:{slug:'s',serverRevision:9}},previousStorageRevision:3,storageRevision:5}),false);assert.equal(live.storageRevision,4);
 assert.equal(ctx._adoptPublishPatch(live,{applied:true,project:{shareInfo:{slug:'s',serverRevision:9},__publishPending:true},previousStorageRevision:4,storageRevision:5}),true);assert.equal(live.memo.text,'new unsaved edit');assert.equal(ctx.App._publishDirty,true);checks+=5;
 // Refreshing the button must not label old/dirty/conflicted copies as synced.
 const fn=name=>{const at=html.indexOf('function '+name+'(');return html.slice(at,html.indexOf('\n}',at)+2);};
 const method=name=>{const at=html.indexOf('    '+name+'(');return html.slice(at,html.indexOf('\n    },',at)+6);};
 const ui=vm.createContext({Map,PublishSafety:Safety,document:{getElementById:()=>({style:{}})}});
 vm.runInContext('const _publishContexts=new Map();'+fn('_publishContext')+';globalThis.ui={'+method('refreshShareInfoButton')+'};',ui);
 ui.ui._setSyncStatus=s=>{ui.state=s;};ui.ui.project={id:'old',shareInfo:{slug:'s',url:'u'}};ui.ui.refreshShareInfoButton();assert.equal(ui.state,'needs-baseline');
 ui.ui.project.shareInfo.serverRevision=0;ui.ui.refreshShareInfoButton();assert.equal(ui.state,'synced');
 ui.ui.project.__publishPending=true;ui.ui.refreshShareInfoButton();assert.equal(ui.state,'local-saved');
 ui._publishContext(ui.ui.project).state='conflict';ui.ui.refreshShareInfoButton();assert.equal(ui.state,'conflict');checks+=4;
 live.publishEditEpoch=8;ctx._adoptPublishPatch(live,{applied:true,project:{publishEditEpoch:7,shareInfo:{}},previousStorageRevision:5,storageRevision:6});assert.equal(live.__publishPending,true);checks++;
 // Each project's timer survives another project's publish completion.
 const timers=new Map();let timerId=0;ui.setTimeout=cb=>{timers.set(++timerId,cb);return timerId;};ui.clearTimeout=id=>timers.delete(id);ui.console=console;
 vm.runInContext(fn('_publishStatus')+';ui._scheduleAutoPublish=({'+method('_scheduleAutoPublish')+'})._scheduleAutoPublish;',ui);
 ui.App=ui.ui;const pa={id:'A',__publishPending:true,shareInfo:{slug:'a',serverRevision:1}},pb={id:'B',__publishPending:true,shareInfo:{slug:'b',serverRevision:1}};
 let autos=0;ui.ui.autoPublishProject=async()=>{autos++;};ui.ui.project=pa;ui.ui._scheduleAutoPublish();const ta=ui._publishContext(pa).timer;
 ui.ui.project=pb;ui.ui._scheduleAutoPublish();const tb=ui._publishContext(pb).timer;assert.notEqual(ta,tb);
 ui.state='B-local';ui._publishStatus(pa,'a','synced');assert.equal(ui.state,'B-local');timers.get(ta)();assert.equal(autos,0);assert.ok(timers.has(tb));timers.get(tb)();assert.equal(autos,1);checks+=5;
 // A conflict cancels queued work and later local edits cannot re-arm it.
 ui.ui.project=pb;ui.ui._scheduleAutoPublish();const pendingTimer=ui._publishContext(pb).timer;
 ui._publishStatus(pb,'b','conflict');assert.equal(ui._publishContext(pb).paused,true);
 assert.equal(timers.has(pendingTimer),false);assert.equal(ui._publishContext(pb).timer,0);
 ui.state='local-saved';ui.ui._scheduleAutoPublish();assert.equal(ui.state,'conflict');
 assert.equal(ui._publishContext(pb).timer,0);checks+=5;
 // Refreshing a cancelled publish's local-saved badge must not resume it.
 const cancelled={id:'cancelled',__publishPending:true,shareInfo:{slug:'cancelled',serverRevision:1}};
 ui.ui.project=cancelled;const cancelledContext=ui._publishContext(cancelled);
 cancelledContext.paused=true;cancelledContext.state='local-saved';
 for(let edit=0;edit<2;edit++){
  ui.state='other';ui.ui._scheduleAutoPublish();
  assert.equal(ui.state,'local-saved');assert.equal(cancelledContext.paused,true);assert.equal(cancelledContext.timer,0);checks+=3;
 }
 // Run both UI entry points: no automatic comparison RPC or publish retry
 // follows either error code. Successful explicit publication resumes sync.
 const autoAt=html.indexOf('    async autoPublishProject(');
 const autoSource=html.slice(autoAt,html.indexOf('\n    },',autoAt)+6);
 const manualAt=html.indexOf('async function publishProjectToShare(');
 const manualSource=html.slice(manualAt,html.indexOf('\n}',manualAt)+2);
 for(const code of ['PT409','40001','PUBLISH_RECEIPT_LOCAL_CONFLICT'])for(const entry of ['manual','auto']){
  const p={id:entry+code,__publishPending:true,shareInfo:{slug:'s',serverRevision:1,isPublic:true}};
  let publishes=0;ui.ui.project=p;ui.ui._flushSave=async()=>true;
  ui.SupabaseClient={configured:()=>true};ui._readCachedMasterPw=()=> 'synthetic';
  ui.openPublishMetaModal=async()=>({slug:'s',isPublic:true});ui.showToast=()=>{};
  ui._comparePublishedProject=()=>assert.fail('A conflict must wait for an explicit comparison');
  ui._publishCore=async()=>{publishes++;throw Object.assign(new Error('publish_conflict'),{code});};
  vm.runInContext(manualSource+';ui.autoPublishProject=({'+autoSource+'}).autoPublishProject;',ui);
  if(entry==='manual')await ui.publishProjectToShare();else await ui.ui.autoPublishProject();
  assert.equal(publishes,1);assert.equal(ui.state,'conflict');assert.equal(ui._publishContext(p).paused,true);
  ui.state='local-saved';ui.ui._scheduleAutoPublish();await ui.ui.autoPublishProject();
  assert.equal(publishes,1);assert.equal(ui.state,'conflict');assert.equal(ui._publishContext(p).timer,0);checks+=6;
  ui._publishStatus(p,'s','synced');assert.equal(ui._publishContext(p).paused,false);checks++;
 }
 // A create/fork collision has no same-URL comparison to offer. It must not
 // queue publication back to the previous URL while reporting the failure.
 for(const code of ['PT409','40001'])for(const fork of [false,true]){
  const p={id:'collision-'+code+'-'+fork,__publishPending:true,
    ...(fork?{shareInfo:{slug:'previous',serverRevision:1,isPublic:true}}:{})};
  const notices=[];let publishes=0;ui.ui.project=p;
  ui.openPublishMetaModal=async()=>({slug:'taken',isPublic:true});ui.showToast=message=>notices.push(message);
  ui._publishCore=async()=>{publishes++;throw Object.assign(new Error('publish_conflict'),{code});};
  await ui.publishProjectToShare();
  assert.equal(publishes,1);assert.equal(ui._publishContext(p,'taken').paused,true);
  assert.equal(ui._publishContext(p).timer,0);assert.match(notices.at(-1),/別のURL/);
  assert.doesNotMatch(notices.at(-1),/公開版の比較が必要/);checks+=5;
 }
 // Comparison counts polygons per section on both grouped local and server rows.
 assert.equal(Safety.summary({rois:[{polysBySection:{s1:[],s2:[]}}]}).rois,2);
 assert.equal(Safety.summary({rois:[{section_id:'s1'},{section_id:'s2'}]}).rois,2);
 const calls=[],comparisonProject={id:'comparison',sections:[],rois:[],shareInfo:{slug:'s'}},comparisonContext={inflight:false};
 const cmp=vm.createContext({PublishSafety:Safety,App:{project:comparisonProject},_publishContext:()=>comparisonContext,showToast:()=>assert.fail('Unchanged comparison cannot be rejected'),
  SupabaseClient:{unlockProjectMaster:async()=>({token:'read'}),fetchProjectDoc:async()=>({publish_revision:1,sections:[{id:'s1'},{id:'s2'}]}),listRois:async(token,id)=>{calls.push(id);return [{section_id:id}];}},openModal:()=>Promise.resolve(false)});
 cmp.openModal._card={querySelector:()=>({addEventListener(){}})};const compareAt=html.indexOf('async function _comparePublishedProject(');vm.runInContext(html.slice(compareAt,html.indexOf('\n}',compareAt)+2),cmp);
 await cmp._comparePublishedProject(comparisonProject,'s','synthetic');assert.deepEqual(calls,['s1','s2']);assert.equal(comparisonContext.inflight,false);checks+=4;
 assert.equal(before.memo.text,'before');console.log(`Publish snapshot regression: PASS (${checks} checks)`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
