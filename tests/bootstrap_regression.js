'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const equal=(value,expected,message)=>{assert.deepEqual(value,expected,message);checks++;};
function tags(html,tag){return [...html.matchAll(new RegExp('<'+tag+'\\b([^>]*?)>','gi'))].map(match=>({attrs:match[1],offset:match.index}));}
function attr(tag,name){const match=tag.attrs.match(new RegExp('\\b'+name+'\\s*=\\s*(["\'])(.*?)\\1','i'));return match&&match[2];}

for(const file of ['index.html','mrm.html','viewer/index.html']){
  const html=fs.readFileSync(path.join(root,file),'utf8');
  const scripts=tags(html,'script');
  const relative=file.startsWith('viewer/')?'../':'';
  equal(scripts.slice(0,3).map(tag=>attr(tag,'src')),
    ['runtime-config.js','app-runtime.js','offline/offline.js'].map(src=>relative+src),file+' bootstrap order');
  for(const tag of scripts.slice(0,3))check(!/\b(?:async|defer)\b/i.test(tag.attrs),file+' bootstrap must execute synchronously');
  for(const tag of scripts){
    const src=attr(tag,'src');if(!src)continue;
    check(!/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(src),file+' external/root-absolute script '+src);
    const resolved=path.resolve(root,path.dirname(file),src);
    check(resolved.startsWith(root+path.sep),file+' script escapes root '+src);
    check(fs.existsSync(resolved),file+' missing script '+src);
    const webUrl=new URL(src,'https://example.github.io/Share_Test/'+file);
    check(webUrl.href.startsWith('https://example.github.io/Share_Test/'),file+' script escapes Pages subpath');
  }
  for(const tag of tags(html,'link')){
    if(attr(tag,'rel')!=='stylesheet')continue;
    const href=attr(tag,'href');check(!!href,file+' empty stylesheet');
    check(!/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(href),file+' non-relative stylesheet');
    check(fs.existsSync(path.resolve(root,path.dirname(file),href)),file+' missing stylesheet');
  }
  check(!/window\.(?:SUPABASE_URL|SUPABASE_ANON_KEY)\s*=/.test(html),file+' must not override shared cloud globals');
  check(!/\/offline\/config\.js/.test(html),file+' must use canonical runtime config');
}

// Evaluate the real viewer worker/lazy asset declarations at both application
// roots. This catches relative URLs that work locally but break under /Share_Test/.
const viewer=fs.readFileSync(path.join(root,'viewer/index.html'),'utf8');
for(const base of ['http://127.0.0.1:8765/','https://example.github.io/Share_Test/']){
  const sandbox={URL,location:new URL(base+'viewer/index.html'),window:{},
    DesiRuntime:{asset:name=>new URL('vendor/'+name,base).href}};
  const context=vm.createContext(sandbox);
  for(const name of ['PARSE_WORKER_LIBS','PARQUET_LIBS']){
    const start=viewer.indexOf('const '+name+' = ');check(start>=0,'missing '+name);
    const end=viewer.indexOf(';',start);check(end>start,'missing declaration end '+name);
    vm.runInContext(viewer.slice(start,end+1)+'\nthis.result='+name+';',context);
    const urls=Array.isArray(context.result)?Array.from(context.result):Object.values(context.result);
    for(const url of urls)check(String(url).startsWith(base+'vendor/'),name+' wrong app base '+url);
  }
  const lazy=viewer.match(/window\.LAZY_LIBS\s*=\s*(\{[\s\S]*?\});/);
  check(!!lazy,'missing lazy libraries');vm.runInContext('this.lazy='+lazy[1]+';',context);
  for(const value of Object.values(context.lazy))check(new URL(value,sandbox.location).href.startsWith(base+'vendor/'),'lazy library escapes app base');
}
console.log('Canonical three-page bootstrap regression: PASS ('+checks+' checks)');
