'use strict';
// Exercise the real publish entry points and badge rendering. Network and
// receipt completion are controlled so every assertion is independent of time.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const Safety=require('../viewer/publish-safety.js');
const html=fs.readFileSync(require.resolve('../viewer/index.html'),'utf8');
function standalone(name){
 const at=html.indexOf('function '+name+'(');assert.ok(at>=0,name);
 const start=html.slice(at-6,at)==='async '?at-6:at;
 return html.slice(start,html.indexOf('\n}',at)+2);
}
function method(name){
 const at=html.search(new RegExp('    (?:async )?'+name+'\\('));assert.ok(at>=0,name);
 return html.slice(at,html.indexOf('\n    },',at)+6);
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
 const nodes=new Map(),states=[],notices=[],scheduled=[],started=deferred(),completion=deferred();
 const project={id:'A',storageRevision:4,publishEditEpoch:2,__publishPending:true,sections:[],rois:[],memo:{text:'original'},
  shareInfo:{slug:'same-url',url:'https://example.invalid/#share=same-url',isPublic:true,serverRevision:1}};
 const context=vm.createContext({Map,console,PublishSafety:Safety,
  document:{getElementById(id){if(!nodes.has(id))nodes.set(id,{style:{},dataset:{},classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){}});return nodes.get(id);}},
  SupabaseClient:{configured:()=>true,unlockProjectMaster:async()=>({token:'synthetic-read'}),
   fetchProjectDoc:async()=>({publish_revision:1,sections:[],meta:{project_meta:{memo:{text:'original'}}}}),listRois:async()=>[]},
  ProjectStorage:{putProject:async()=>{}},clearTimeout(){},_readCachedMasterPw:()=> 'synthetic',_saveCachedMasterPw(){},
  showToast:message=>notices.push(message),alert:message=>notices.push(message),
  openPublishMetaModal:async()=>({slug:project.shareInfo.slug,isPublic:true}),openShareInfoModal:async()=>{},
  openModal:Object.assign(async()=> 'overwrite',{_card:{querySelector:()=>({addEventListener(){}})}})});
 vm.runInContext('const _publishContexts=new Map();'+['_publishContext','_publishStatus','_adoptPublishPatch','_comparePublishedProject','publishProjectToShare'].map(standalone).join('\n')
  +';globalThis.App={'+['refreshShareInfoButton','_setSyncStatus','autoPublishProject','_doSave'].map(method).join(',')+'};',context);
 const app=context.App,render=app._setSyncStatus;
 Object.assign(app,{project,_flushSave:async()=>true,_scheduleAutoPublish(){scheduled.push(this.project.id);}});
 app._setSyncStatus=function(...args){render.apply(this,args);states.push({state:this._syncState,title:nodes.get('sync-status')?.title});};
 let commits=0;
 context._publishCore=async current=>{
  commits++;const snapshot=structuredClone(current);
  app.refreshShareInfoButton();started.resolve();
  const outcome=await completion.promise;
  if(outcome==='cancel'){
   context._publishContext(current).paused=true;
   throw Object.assign(new Error('cancelled'),{cancelled:true});
  }
  if(outcome instanceof Error)throw outcome;
  delete snapshot.__publishPending;snapshot.shareInfo.serverRevision=2;
  const adopted=context._adoptPublishPatch(current,{applied:true,project:snapshot,previousStorageRevision:4,storageRevision:5});
  context._publishStatus(current,current.shareInfo.slug,adopted?(current.__publishPending?'local-saved':'synced'):'conflict');
  return {serverRevision:2};
 };
 function run(entry){
  if(entry==='manual')return context.publishProjectToShare();
  if(entry==='auto')return app.autoPublishProject();
  return context._comparePublishedProject(project,project.shareInfo.slug,'synthetic',{meta:{slug:project.shareInfo.slug,isPublic:true}});
 }
 app.refreshShareInfoButton();
 return {context,app,project,nodes,states,notices,scheduled,started,completion,run,commits:()=>commits};
}
async function main(){
 let checks=0;
 for(const entry of ['manual','compare','auto']){
  const f=fixture(),task=f.run(entry);await f.started.promise;
  assert.equal(f.app._syncState,'uploading');assert.equal(f.context._publishContext(f.project).inflight,true);checks+=2;
  f.completion.resolve('success');await task;
  assert.equal(f.app._syncState,'synced',entry+': completed publication must leave uploading');
  assert.equal(f.context._publishContext(f.project).inflight,false);
  assert.equal(f.context._publishContext(f.project).state,'synced');
  assert.equal(!!f.project.__publishPending,false);assert.equal(f.project.shareInfo.serverRevision,2);
  assert.equal(f.nodes.get('sync-status').className,'sync-status sync-synced');checks+=6;
 }
 for(const entry of ['manual','compare','auto'])for(const failure of [new Error('synthetic offline'),Object.assign(new Error('synthetic conflict'),{code:'PT409'}),Object.assign(new Error('legacy conflict'),{code:'40001'})]){
  const f=fixture(),task=f.run(entry);await f.started.promise;
  f.completion.resolve(failure);await task;
  const expected=Safety.isConflict(failure)?'conflict':'error';
  assert.equal(f.app._syncState,expected);assert.equal(f.context._publishContext(f.project).inflight,false);
  assert.equal(f.project.shareInfo.serverRevision,1);assert.equal(f.project.__publishPending,true);
  if(expected==='error')assert.equal(f.nodes.get('sync-status').title,failure.message,'Completion keeps the failure explanation');
  assert.equal(f.states.some(item=>item.state==='synced'),false);checks+=expected==='error'?6:5;
 }
 for(const entry of ['manual','compare']){
  const f=fixture(),task=f.run(entry);await f.started.promise;f.completion.resolve('cancel');await task;
  assert.equal(f.app._syncState,'local-saved');assert.equal(f.context._publishContext(f.project).paused,true);
  assert.equal(f.project.__publishPending,true);assert.equal(f.project.shareInfo.serverRevision,1);
  assert.equal(f.states.some(item=>item.state==='synced'),false);checks+=5;
 }
 for(const entry of ['manual','compare','auto']){
  const f=fixture(),task=f.run(entry);await f.started.promise;
  f.project.memo.text='new edit during publication';f.project.publishEditEpoch++;
  f.completion.resolve('success');await task;
  assert.equal(f.app._syncState,'local-saved');assert.equal(f.project.__publishPending,true);
  assert.equal(f.project.memo.text,'new edit during publication');assert.equal(f.project.shareInfo.serverRevision,2);
  assert.equal(f.context._publishContext(f.project).inflight,false);assert.equal(f.states.some(item=>item.state==='synced'),false);checks+=6;
 }
 for(const entry of ['manual','compare','auto']){
  const f=fixture(),task=f.run(entry);await f.started.promise;
  const other={id:'B',__publishPending:true,shareInfo:{slug:'different-url',url:'u',serverRevision:7}};
  f.app.project=other;f.app.refreshShareInfoButton();const mark=f.states.length;
  f.completion.resolve('success');await task;
  assert.equal(f.app.project,other);assert.equal(f.app._syncState,'local-saved');assert.equal(f.states.length,mark);
  assert.equal(other.shareInfo.serverRevision,7);assert.equal(f.context._publishContext(f.project).inflight,false);checks+=5;
 }
 for(const entry of ['manual','compare','auto']){
  const f=fixture(),task=f.run(entry);await f.started.promise;
  // Reopening the same local ID creates another object. Its still-pending
  // metadata must not be treated as the old object's verified receipt.
  const reopened=structuredClone(f.project);f.app.project=reopened;f.app.refreshShareInfoButton();
  assert.equal(f.app._syncState,'uploading');f.completion.resolve('success');await task;
  assert.equal(f.app.project,reopened);assert.equal(f.app._syncState,'local-saved');
  assert.equal(reopened.__publishPending,true);assert.equal(reopened.shareInfo.serverRevision,1);checks+=5;
 }
 // The manual entry must not race the explicit fetch/refresh owned by the UI.
 const refreshing=fixture();refreshing.context._publishContext(refreshing.project).refreshing=true;
 await refreshing.run('manual');assert.equal(refreshing.commits(),0);
 assert.equal(refreshing.context._publishContext(refreshing.project).inflight,false);
 assert.equal(refreshing.project.shareInfo.serverRevision,1);assert.match(refreshing.notices.at(-1),/確認・取得が終わってから/);checks+=4;
 const unpublished=fixture();delete unpublished.project.shareInfo;delete unpublished.project.__publishPending;
 unpublished.app._publishDirty=true;unpublished.app._saveRevision=1;unpublished.app._savedRevision=0;
 assert.equal(await unpublished.app._doSave(),true);
 assert.equal(unpublished.app._syncState,'local-only');
 assert.equal(unpublished.nodes.get('sync-status').textContent,'このPCのみ・未公開');checks+=3;
 console.log(`Publish status regression: PASS (${checks} checks)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
