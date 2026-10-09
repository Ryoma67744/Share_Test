'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {renderOfflineConfig} = require('../offline/config.cjs');
const root = path.resolve(__dirname,'..');
const runtimeSource = fs.readFileSync(path.join(root,'app-runtime.js'),'utf8');
const onlineSource = fs.readFileSync(path.join(root,'runtime-config.js'),'utf8');
const guardSource = fs.readFileSync(path.join(root,'offline/offline.js'),'utf8');
const BASE = 'http://127.0.0.1:8765';
let checks=0;
const failures=[];
function equal(a,b,note) { assert.deepEqual(a,b,note);checks++; }
function ok(value,note) { assert.ok(value,note);checks++; }
function throws(fn,pattern) { assert.throws(fn,pattern);checks++; }
const plain=value=>JSON.parse(JSON.stringify(value));
async function test(name,fn) {try{await fn();console.log('PASS '+name);}catch(error){failures.push({name,error});console.error('FAIL '+name+': '+error.message);}}

function harness(options={}) {
  const calls={fetch:[],xhr:[],beacon:[],alerts:[],persist:0};
  const windowEvents=new Map(),documentEvents=new Map();
  const location=new URL(options.pageUrl||BASE+'/viewer/index.html?mode=online');
  class XMLHttpRequest {
    open(method,url,...rest) {calls.xhr.push({receiver:this,method,url,rest});return 'opened';}
  }
  const fetch=function(...args){calls.fetch.push(args);return Promise.resolve({ok:true,args});};
  const beacon=function(...args){calls.beacon.push(args);return true;};
  const navigator={onLine:options.onLine===undefined?true:options.onLine,
    storage:{persist(){calls.persist++;return Promise.resolve(true);}}};
  if(options.beacon!==false)navigator.sendBeacon=beacon;
  const document={currentScript:options.currentScript===undefined
    ?{src:options.scriptUrl||BASE+'/app-runtime.js'}:options.currentScript,
    title:'DESI Data Share — Test',addEventListener(name,fn,capture){documentEvents.set(name,{fn,capture});}};
  const sandbox={URL,Request,Promise,console,location,navigator,document,XMLHttpRequest,fetch,
    alert(message){calls.alerts.push(message);},
    addEventListener(name,fn){windowEvents.set(name,fn);}};
  sandbox.window=sandbox;
  return {context:vm.createContext(sandbox),calls,windowEvents,documentEvents,
    originals:{fetch,open:XMLHttpRequest.prototype.open,beacon}};
}
function evaluate(h,source,name){return vm.runInContext(source,h.context,{filename:name});}
function boot(options={}) {
  const h=harness(options);
  if(options.configSource!==null)evaluate(h,options.configSource||onlineSource,'runtime-config.js');
  evaluate(h,runtimeSource,'app-runtime.js');
  return h;
}
function config(value){return 'window.DESI_BUILD_CONFIG = '+JSON.stringify(value)+';';}
function guard(h){evaluate(h,guardSource,'offline/offline.js');return h;}

async function main(){
  await test('Actual online source configuration and frozen runtime',()=>{
    const h=boot();const c=h.context;
    equal(c.DESI_OFFLINE,false);equal(c.DesiRuntime.mode,'online');
    equal(c.SUPABASE_URL,c.DESI_BUILD_CONFIG.cloud.url);
    equal(c.SUPABASE_ANON_KEY,c.DESI_BUILD_CONFIG.cloud.anonKey);
    ok(c.SUPABASE_URL.startsWith('https://'));ok(c.SUPABASE_ANON_KEY.length>0);
    equal(plain(c.DesiRuntime.capabilities),{cloud:true,localMrm:false});
    for(const value of [c.DesiRuntime,c.DesiRuntime.cloud,c.DesiRuntime.capabilities])ok(Object.isFrozen(value));
    for(const name of ['DESI_OFFLINE','DesiRuntime','SUPABASE_URL','SUPABASE_ANON_KEY']){
      const d=Object.getOwnPropertyDescriptor(c,name);equal(d.writable,false);equal(d.configurable,false);
      throws(()=>evaluate(h,'"use strict"; window.'+name+' = null;','mutation'),/read.only|Cannot assign/i);
      throws(()=>evaluate(h,'Object.defineProperty(window,'+JSON.stringify(name)+',{value:null});','redefine'),/redefine/i);
    }
    throws(()=>evaluate(h,'"use strict"; DesiRuntime.capabilities.cloud=false;','mutation'),/read.only|Cannot assign/i);
    throws(()=>evaluate(h,'"use strict"; DesiRuntime.cloud.url="https://different.invalid";','mutation'),/read.only|Cannot assign/i);
    const oldUrl=c.SUPABASE_URL;
    evaluate(h,'DESI_BUILD_CONFIG.cloud.url="https://different.invalid";','config-copy');
    equal(c.SUPABASE_URL,oldUrl,'later mutation of source cloud cannot change runtime');
    equal(c.DesiRuntime.cloud.url,oldUrl);
  });
  await test('Actual offline server config and ignored cloud credentials',()=>{
    const h=boot({configSource:renderOfflineConfig()});
    equal(h.context.DESI_OFFLINE,true);equal(h.context.DesiRuntime.mode,'offline');
    equal(plain(h.context.DesiRuntime.cloud),{url:'',anonKey:''});
    equal(plain(h.context.DesiRuntime.capabilities),{cloud:false,localMrm:true});
    const hostile=boot({configSource:config({mode:'offline',cloud:{url:'https://unused.invalid',anonKey:'unused'}})});
    equal(hostile.context.SUPABASE_URL,'');equal(hostile.context.SUPABASE_ANON_KEY,'');
    equal(plain(hostile.context.DesiRuntime.cloud),{url:'',anonKey:''});
    ok(Object.isFrozen(hostile.context.DesiRuntime.cloud));
  });
  await test('Missing/invalid mode and unresolved script URL fail without an offline fallback',()=>{
    const sources=[null,config(null),config({}),config({mode:'OFFLINE'}),config({mode:'local'}),config({mode:true}),config('offline')];
    for(const source of sources){
      const h=harness();if(source)evaluate(h,source,'invalid-config');
      throws(()=>evaluate(h,runtimeSource,'app-runtime.js'),/Invalid runtime configuration/);
      for(const name of ['DESI_OFFLINE','DesiRuntime','SUPABASE_URL','SUPABASE_ANON_KEY'])equal(h.context[name],undefined);
    }
    for(const currentScript of [null,{}, {src:''}]){
      const h=harness({currentScript});evaluate(h,onlineSource,'runtime-config.js');
      throws(()=>evaluate(h,runtimeSource,'app-runtime.js'),/base URL/);equal(h.context.DESI_OFFLINE,undefined);
    }
    const unconfigured=boot({configSource:config({mode:'online',cloud:{}})});
    equal(unconfigured.context.DESI_OFFLINE,false,'empty online settings must never activate local privileges');
    equal(unconfigured.context.SUPABASE_URL,'');
  });
  await test('URL query/hash and navigator.onLine cannot select or change runtime mode',()=>{
    for(const mode of ['online','offline'])for(const onLine of [true,false]){
      const opposite=mode==='online'?'offline':'online';
      const h=boot({configSource:config({mode,cloud:{url:'https://cloud.invalid',anonKey:'public'}}),onLine,
        pageUrl:BASE+'/viewer/?mode='+opposite+'&offline=1#mode='+opposite});
      equal(h.context.DesiRuntime.mode,mode);equal(h.context.DESI_OFFLINE,mode==='offline');
      h.context.navigator.onLine=!onLine;h.context.location.search='?mode='+opposite;
      equal(h.context.DesiRuntime.mode,mode);equal(h.context.DESI_OFFLINE,mode==='offline');
    }
  });
  await test('Asset resolution uses runtime script location at root and GitHub Pages subpath',()=>{
    for(const [scriptUrl,pageUrl,base] of [
      [BASE+'/app-runtime.js',BASE+'/viewer/index.html',BASE+'/'],
      ['https://example.github.io/Share_Test/app-runtime.js','https://example.github.io/Share_Test/viewer/index.html','https://example.github.io/Share_Test/'],
      ['https://example.github.io/Share_Test/app-runtime.js?v=2','https://example.github.io/Share_Test/mrm.html','https://example.github.io/Share_Test/']]){
      const h=boot({scriptUrl,pageUrl});equal(h.context.DesiRuntime.baseUrl,base);
      for(const file of ['xlsx.full.min.js','UTIF.js','hyparquet.mjs','LICENSE-hysnappy.txt'])
        equal(h.context.DesiRuntime.asset(file),base+'vendor/'+file);
    }
  });
  await test('Online guard leaves fetch, XHR and beacon unchanged even when navigator is offline',async()=>{
    const h=guard(boot({onLine:false,pageUrl:BASE+'/?offline=1'}));
    equal(h.context.fetch,h.originals.fetch);equal(h.context.XMLHttpRequest.prototype.open,h.originals.open);
    equal(h.context.navigator.sendBeacon,h.originals.beacon);
    equal(h.windowEvents.size,0);equal(h.documentEvents.size,0);equal(h.calls.persist,0);
    await h.context.fetch('https://permitted-online.invalid');equal(h.calls.fetch.length,1);
  });
  await test('Offline fetch accepts local/data/blob input and blocks all external inputs before dispatch',async()=>{
    const h=guard(boot({configSource:renderOfflineConfig(),onLine:true}));
    ok(h.context.fetch!==h.originals.fetch);
    const options={method:'GET',headers:{'X-Test':'fixture'}};
    for(const input of ['../USER_GUIDE.md',BASE+'/viewer/file',new URL(BASE+'/asset'),new Request(BASE+'/request'),
      'blob:'+BASE+'/synthetic-id','data:text/plain,local']){
      const before=h.calls.fetch.length;await h.context.fetch(input,options);equal(h.calls.fetch.length,before+1);
      equal(h.calls.fetch[before][0],input);equal(h.calls.fetch[before][1],options);
    }
    for(const input of ['https://external.invalid/path','//external.invalid/path','http://127.0.0.1:8766/path',
      'http://localhost:8765/path','javascript:alert(1)','file:///private.txt','http://[',new Request('https://external.invalid/request')]){
      const before=h.calls.fetch.length;
      await assert.rejects(h.context.fetch(input),/オフライン版/);checks++;
      equal(h.calls.fetch.length,before,'blocked request must not reach native fetch');
    }
  });
  await test('Offline XHR and beacon preserve local calls and reject external calls',()=>{
    const h=guard(boot({configSource:renderOfflineConfig()}));
    const xhr=new h.context.XMLHttpRequest();
    equal(xhr.open('GET','../USER_GUIDE.md',true,'user','pass'),'opened');
    equal(h.calls.xhr[0].receiver,xhr);equal(h.calls.xhr[0].rest,[true,'user','pass']);
    throws(()=>xhr.open('GET','https://external.invalid',true),/オフライン版/);equal(h.calls.xhr.length,1);
    equal(h.context.navigator.sendBeacon('/local','payload'),true);equal(h.calls.beacon[0],['/local','payload']);
    equal(h.context.navigator.sendBeacon('https://external.invalid','payload'),false);equal(h.calls.beacon.length,1);
    guard(boot({configSource:renderOfflineConfig(),beacon:false}));checks++;
  });
  await test('Offline external links are stopped; local links and persistence hook remain usable',async()=>{
    const h=guard(boot({configSource:renderOfflineConfig()}));
    const click=h.documentEvents.get('click');equal(click.capture,true);
    let prevented=0;
    const event=href=>({target:{closest(selector){equal(selector,'a[href]');return{href};}},preventDefault(){prevented++;}});
    click.fn(event('https://external.invalid'));equal(prevented,1);equal(h.calls.alerts.length,1);
    click.fn(event(BASE+'/viewer/'));equal(prevented,1);equal(h.calls.alerts.length,1);
    click.fn({target:{},preventDefault(){prevented++;}});equal(prevented,1);
    h.windowEvents.get('DOMContentLoaded')();await Promise.resolve();
    equal(h.context.document.title,'DESI Offline — Test');equal(h.calls.persist,1);
  });
  await test('Invalid asset names cannot escape the vendor directory or be coerced',()=>{
    const h=boot();
    for(const name of ['', '.', '..','../secret.js','a/b.js','a\\b.js','https://external.invalid/x.js',
      '//external.invalid/x.js','x.js?x=1','x.js#part','x%2f.js','x y.js',null,undefined,0,{},['x.js']])
      throws(()=>h.context.DesiRuntime.asset(name),/Invalid asset filename/);
  });
  if(failures.length)throw new Error(failures.map(x=>x.name+': '+x.error.message).join('\n'));
  console.log('Runtime configuration and offline transport regression: PASS ('+checks+' checks)');
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
