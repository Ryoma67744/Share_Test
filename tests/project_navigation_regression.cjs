'use strict';
const assert=require('node:assert/strict');
const {create}=require('../project-navigation.js');
const now=Date.now(),base='https://example.invalid/Share_Test/';
const gate={unlockedAt:now-5000,expiresAt:now+600000};
const password={pw:'synthetic-master-only',expiresAt:now+900000};
function fixture(options={}){
 const records=new Map(Object.entries(options.records||{
  'desi:masterUnlocked':JSON.stringify(gate),'desi:masterPw':JSON.stringify(password),
  'desi:share:shared':JSON.stringify({token:'synthetic-admin-token',role:'admin'}),'unrelated':'private-copy-marker'
 }));
 const events=[],alerts=[],navigated=[];let child;
 const storage=map=>({getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,String(value)),clear:()=>map.clear()});
 const win={location:{href:options.href||base+'index.html',replace:url=>navigated.push(url)},
  DesiRuntime:{baseUrl:options.base||base},DESI_OFFLINE:!!options.offline,sessionStorage:storage(records),
  showToast:text=>alerts.push(text),open:(url,target)=>{
   events.push(['open',url,target]);if(options.blocked)return null;
   const copied=new Map(records);let opener=win;
   child={copied,closed:false,sessionStorage:{getItem:key=>copied.get(key)||null,
    clear(){events.push(['clear']);if(options.clearFailure)throw new Error('blocked storage');copied.clear();},
    setItem(key,value){events.push(['seed',key]);if(options.seedFailure)throw new Error('quota');copied.set(key,value);}},
    get opener(){return opener;},set opener(value){events.push(['opener',value]);if(!options.detachFailure)opener=value;},
    close(){this.closed=true;events.push(['close']);},location:{replace(url){events.push(['navigate',url]);if(options.navigationFailure)throw new Error('failed navigation');navigated.push(url);}}};
   return child;
  }};
 return {win,api:create(win),records,events,alerts,navigated,child:()=>child};
}
{
 const f=fixture(),before=[...f.records];assert.equal(f.api.openMaster({projectId:'proj_A'}),true);
 assert.deepEqual([...f.records],before,'parent session is unchanged');assert.equal(f.win.location.href,base+'index.html');
 const child=f.child();assert.equal(child.opener,null);assert.equal(child.closed,false);
 assert.deepEqual([...child.copied.keys()],['desi:masterUnlocked','desi:masterPw']);
 assert.deepEqual(JSON.parse(child.copied.get('desi:masterUnlocked')),gate);
 assert.equal(JSON.parse(child.copied.get('desi:masterPw')).expiresAt,password.expiresAt,'handoff preserves the password lifetime');
 assert.equal(f.navigated[0],base+'viewer/index.html?project=proj_A');
 assert.deepEqual(f.events.map(e=>e[0]),['open','clear','seed','seed','opener','navigate']);
}
{
 const f=fixture();assert.equal(f.api.openMaster({importSlug:'POS_NEG'}),true);
 assert.equal(f.navigated[0],base+'viewer/index.html?import=POS_NEG');
 const uri=new URL(f.api.masterUrl({projectId:'p&import=else#fragment'}));
 assert.equal(uri.origin,'https://example.invalid');assert.equal(uri.pathname,'/Share_Test/viewer/index.html');
 assert.deepEqual([...uri.searchParams],[['project','p&import=else#fragment']]);assert.equal(uri.hash,'');
 assert.equal(new URL(f.api.shareUrl('x&role=admin')).hash,'#share=x%26role%3Dadmin');
 assert.throws(()=>f.api.masterUrl({projectId:'p',importSlug:'s'}));assert.throws(()=>f.api.masterUrl({href:'https://other.invalid'}));
 assert.throws(()=>f.api.masterUrl({projectId:'\n'}));
 assert.throws(()=>f.api.shareUrl(''));assert.throws(()=>f.api.masterUrl({projectId:'p'.repeat(1025)}));
}
{
 const f=fixture(),before=[...f.records];assert.equal(f.api.openMaster({projectId:'dirty-local'},{refreshShare:true}),true);
 assert.equal(f.navigated[0],base+'viewer/index.html?project=dirty-local&refresh=share');
 assert.deepEqual([...f.records],before);assert.equal(f.child().opener,null);
 assert.deepEqual([...f.child().copied.keys()],['desi:masterUnlocked','desi:masterPw']);
 assert.equal(f.api.masterUrl({projectId:'p'},{refreshShare:false}),base+'viewer/index.html?project=p');
 assert.throws(()=>f.api.masterUrl({importSlug:'s'},{refreshShare:true}));
 for(const options of [{refreshShare:'share'},{next:'https://other.invalid'},null,[]])assert.throws(()=>f.api.masterUrl({projectId:'p'},options));
 const loggedOut=fixture({records:{}});assert.equal(loggedOut.api.openMaster({projectId:'p'},{refreshShare:true}),true);
 assert.equal(loggedOut.navigated[0],base+'index.html?openProject=p&refresh=share');assert.equal(loggedOut.child().copied.size,0);
}
for(const records of [
 {}, {'desi:masterUnlocked':'not-json','desi:masterPw':JSON.stringify(password)},
 {'desi:masterUnlocked':JSON.stringify({expiresAt:now-1000}),'desi:masterPw':JSON.stringify(password)},
 {'desi:masterUnlocked':JSON.stringify({expiresAt:String(now+600000)})}
]){
 const f=fixture({records});assert.equal(f.api.openMaster({importSlug:'fixture'}),true);
 assert.equal(f.navigated[0],base+'index.html?importProject=fixture');assert.equal(f.child().copied.size,0,'expired or malformed credentials are not transferred');
}
{
 const f=fixture({records:{'desi:masterUnlocked':JSON.stringify(gate),'desi:masterPw':JSON.stringify({...password,expiresAt:now-1000})}});
 assert.equal(f.api.openMaster({projectId:'p'}),true);assert.deepEqual([...f.child().copied.keys()],['desi:masterUnlocked']);
}
for(const failure of ['blocked','clearFailure','seedFailure','detachFailure','navigationFailure']){
 const f=fixture({[failure]:true}),before=[...f.records];assert.equal(f.api.openMaster({projectId:'p'}),false,failure);
 assert.deepEqual([...f.records],before);assert.equal(f.win.location.href,base+'index.html');assert.equal(f.alerts.length,1);
 if(f.child())assert.equal(f.child().closed,true,'close an unusable child');
 if(failure!=='navigationFailure')assert.equal(f.navigated.length,0,'never navigate with a failed handoff');
}
{
 const f=fixture({offline:true});assert.equal(f.api.openMaster({projectId:'p'}),true);
 assert.equal(f.child().copied.size,0);assert.equal(f.navigated[0],base+'viewer/index.html?project=p');
}
{
 const f=fixture();
 assert.equal(f.api.masterLoginUrlFromViewer(base+'viewer/index.html?project=p'),base+'index.html?openProject=p');
 assert.equal(f.api.masterLoginUrlFromViewer(base+'viewer/index.html?project=p&refresh=share'),base+'index.html?openProject=p&refresh=share');
 assert.equal(f.api.masterLoginUrlFromViewer(base+'viewer/?import=s'),base+'index.html?importProject=s');
 for(const href of ['https://other.invalid/viewer/?project=p',base+'wrong?project=p',base+'viewer/?project=p&import=s',base+'viewer/?project=p&project=q',base+'viewer/?project=p&refresh=share&refresh=share',base+'viewer/?project=p&refresh=https://other.invalid',base+'viewer/?import=s&refresh=share','javascript:alert(1)']){
  assert.equal(f.api.masterLoginUrlFromViewer(href),base+'index.html');
 }
}
for(const [query,key,value]of [['openProject=p','project','p'],['importProject=s','import','s']]){
 const f=fixture({href:base+'index.html?'+query});assert.equal(f.api.resumeMasterDestination(),true);
 assert.equal(f.navigated[0],base+'viewer/index.html?'+key+'='+value);assert.equal(f.events.length,0,'login resumes in the child, not another popup');
}
for(const query of ['openProject=p&refresh=share','refresh=share&openProject=p']){
 const f=fixture({href:base+'index.html?'+query});assert.equal(f.api.resumeMasterDestination(),true);
 assert.equal(f.navigated[0],base+'viewer/index.html?project=p&refresh=share');assert.equal(f.events.length,0);
}
for(const href of [base+'?openProject=p&next=https://other.invalid',base+'?openProject=p&importProject=s',base+'?openProject=',base+'viewer/?openProject=p',base+'?openProject=p&refresh=share&next=https://other.invalid',base+'?openProject=p&refresh=share&refresh=share',base+'?openProject=p&refresh=',base+'?importProject=s&refresh=share',base+'?refresh=share']){
 const f=fixture({href});assert.equal(f.api.resumeMasterDestination(),false);assert.equal(f.navigated.length,0);
}
assert.equal(fixture({href:base+'?openProject=p',records:{}}).api.resumeMasterDestination(),false);
assert.equal(fixture({href:base+'?openProject=p&refresh=share',records:{}}).api.resumeMasterDestination(),false);
assert.equal(fixture({base:'https://other.invalid/'}).api.openMaster({projectId:'p'}),false);
console.log('Project navigation regression: PASS (isolated auth, original expiry, safe destinations, popup/storage failures, login return)');
