'use strict';
const assert=require('node:assert/strict');
const Safety=require('../viewer/publish-safety.js');
const fs=require('node:fs'),vm=require('node:vm');
const clone=x=>JSON.parse(JSON.stringify(x));
const original=new Blob(['immutable source'],{type:'text/plain'});
function setup(){
 const project={id:'a',displayName:'Snapshot',storageRevision:4,publishEditEpoch:2,__publishPending:true,memo:{text:'before'},
  sections:[{id:'s',displayName:'S',images:{HE:{blobId:'image',filename:'h.png'}},msiSeries:{MSI_A:{blobId:'raw',filename:'original.txt',archiveProvenance:{version:1,basis:'registered-source'},archiveGeometryUnconfirmed:true}},msiFiles:{raw:{blobId:'raw',filename:'registered-other-name.txt'},unused:{blobId:'unused'}}}],rois:[]};
 let seq=0;const logs={uploads:[],intents:[],receipts:[],pins:[],releases:[],commits:[]},records=new Map(['image','raw','unused'].map(k=>[k,{blob:original,mime:'text/plain'}]));
 const hooks={uuid:()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}`,freezeSources(){},media:()=>({items:[]}),publicPhoto:x=>clone(x),imageIdentity:()=>null,viewerOverlay:()=>false,encodeRoi:()=>[],url:slug=>'https://example.invalid/#share='+slug,
  state:async()=>({protocol:2,exists:false,receipt:null}),session:async job=>({protocol:2,token:'synthetic-ticket',object_prefix:job.slug+'/publish-v2/'+job.jobId+'/'}),
  blob:async id=>records.get(id),exists:async()=>true,remoteBlob:async()=>null,
  pin:async(...x)=>logs.pins.push(x),release:async id=>logs.releases.push(id),intent:async x=>logs.intents.push(clone(x)),
  upload:async(path,blob)=>logs.uploads.push({path,blob}),start(){},progress(){},assertActive(){},close(){},
  commit:async args=>{logs.commits.push(clone(args));return {ok:true,protocol:2,slug:args._slug,request_id:args._request_id,server_revision:args._expected_revision+1,committed_at:'2026-11-04T00:00:00Z'};},receipt:async r=>logs.receipts.push(clone(r))};
 return {project,hooks,logs,records,meta:{slug:'new_slug',isPublic:true}};
}
async function main(){
 let checks=0;
 const a=setup(),before=clone(a.project);let sessionRelease;
 const oldSession=a.hooks.session;a.hooks.session=job=>new Promise(resolve=>{sessionRelease=()=>resolve(oldSession(job));});
 const run=Safety.run(a.project,a.meta,a.hooks);
 a.project.memo.text='new edit';a.project.sections[0].msiSeries.MSI_A.blobId='replacement';a.project.publishEditEpoch++;
 sessionRelease();await run;
 assert.equal(a.logs.commits[0]._meta.memo.text,'before');assert.equal(a.logs.receipts[0].publishedEditEpoch,2);
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
 const recover=setup();const previous=a.logs.intents.at(-1);recover.project.shareInfo={slug:recover.meta.slug,pendingPublish:previous};recover.hooks.state=async()=>({exists:true,receipt:{ok:true,protocol:2,slug:previous.slug,request_id:previous.jobId,server_revision:1}});await Safety.run(recover.project,recover.meta,recover.hooks);assert.equal(recover.logs.uploads.length,0);assert.equal(recover.logs.receipts.length,1);checks+=2;
 const conflict=setup();conflict.hooks.commit=async()=>{conflict.logs.commits.push(1);throw Object.assign(new Error('conflict'),{code:'40001'});};await assert.rejects(()=>Safety.run(conflict.project,conflict.meta,conflict.hooks),{code:'40001'});assert.equal(conflict.logs.commits.length,1);assert.equal(conflict.logs.receipts.length,0);checks+=3;
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
 assert.equal(before.memo.text,'before');console.log(`Publish snapshot regression: PASS (${checks} checks)`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
