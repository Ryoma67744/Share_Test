'use strict';
// Online UI with a mocked Supabase endpoint. Never connects to an actual account.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
async function assertLanguageHasNoDataWrites(page){
 await page.evaluate(()=>{
  window.languageStorageWrites=[];window.languageDatabaseWrites=[];
  window.originalStorageSet=Storage.prototype.setItem;window.originalDatabaseTransaction=IDBDatabase.prototype.transaction;
  Storage.prototype.setItem=function(key,value){languageStorageWrites.push(key);return originalStorageSet.call(this,key,value);};
  IDBDatabase.prototype.transaction=function(stores,mode,...rest){if(mode==='readwrite')languageDatabaseWrites.push(Array.from(typeof stores==='string'?[stores]:stores));return originalDatabaseTransaction.call(this,stores,mode,...rest);};
  AppI18n.setLocale('ja');AppI18n.setLocale('en');
 });
 await page.waitForTimeout(80);
 const writes=await page.evaluate(()=>{
  Storage.prototype.setItem=originalStorageSet;IDBDatabase.prototype.transaction=originalDatabaseTransaction;
  return {storage:languageStorageWrites,database:languageDatabaseWrites};
 });
 assert.deepEqual(writes.database,[],'Changing language never writes project or MRM IndexedDB data');
 assert.ok(writes.storage.length>0);
 assert.ok(writes.storage.every(key=>['desi:ui:lang','desi:help:lang','desi:helpLang'].includes(key)),'Only language preference keys may be written');
}
async function main(){
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));}catch(_){res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],rpcCalls=[],unexpected=[];
  let auth='network',library='error';
  page.on('pageerror',error=>errors.push(error.message));
  await context.addInitScript(()=>localStorage.setItem('desi:ui:lang','en'));
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.href===origin+'/runtime-config.js')return route.fulfill({contentType:'text/javascript',body:'window.DESI_BUILD_CONFIG=Object.freeze({mode:"online",cloud:{url:"https://i18n-fixture.invalid",anonKey:"fixture-only-key"}});'});
   if(url.origin===origin||url.protocol==='data:'||url.protocol==='blob:')return route.continue();
   if(url.origin!=='https://i18n-fixture.invalid'){unexpected.push(url.href);return route.abort();}
   const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'POST,GET,OPTIONS'};
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
   const name=url.pathname.split('/').pop();rpcCalls.push(name);
   if(name==='verify_master_pw'){
    if(auth==='network')return route.abort('connectionfailed');
    return route.fulfill({contentType:'application/json',headers,body:JSON.stringify(auth==='valid')});
   }
   if(name==='list_mrm_library'&&library==='error')return route.fulfill({status:503,contentType:'application/json',headers,body:JSON.stringify({code:'FIXTURE_UNAVAILABLE',message:'Fixture library unavailable'})});
   if(['get_workspace_tree','list_projects','list_projects_v2','list_mrm_library','list_mrm_sets'].includes(name))return route.fulfill({contentType:'application/json',headers,body:JSON.stringify(name==='get_workspace_tree'?{version:1,children:[]}:[])});
   unexpected.push('Unmocked RPC: '+name);return route.fulfill({status:400,contentType:'application/json',headers,body:'{"message":"Unexpected fixture operation"}'});
  });
  await page.goto(origin+'/index.html');await page.locator('#modal-host [name="pw"]').waitFor();
  assert.equal(await page.locator('#modal-host h2').innerText(),'Enter your password.');
  assert.doesNotMatch(await page.locator('#modal-host').innerText(),/[ぁ-んァ-ン一-龠]/);
  await page.locator('#modal-host [name="pw"]').fill('fixture-password');
  await page.locator('#modal-host [data-modal-ok]').click();
  await page.waitForFunction(()=>document.querySelector('#modal-host [data-err]').textContent.includes('Cannot connect'));
  assert.equal(await page.evaluate(()=>DESI_OFFLINE),false,'Network failure never bypasses online authentication');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('desi:masterUnlocked')),null);
  auth='bad';await page.locator('#modal-host [data-modal-ok]').click();
  await page.waitForFunction(()=>document.querySelector('#modal-host [data-err]').textContent==='Incorrect password.');
  await assertLanguageHasNoDataWrites(page);
  assert.equal(await page.locator('#modal-host [name="pw"]').inputValue(),'fixture-password');
  assert.equal(await page.locator('#modal-host [data-err]').innerText(),'Incorrect password.');
  auth='valid';await page.locator('#modal-host [data-modal-ok]').click();
  await page.waitForFunction(()=>document.querySelector('#modal-host').children.length===0&&typeof _lastListRows!=='undefined');
  await page.locator('#btn-change-master-pw').click();
  await page.waitForFunction(()=>document.activeElement===document.querySelector('#modal-host [name="cur"]'));
  await page.locator('#modal-host [name="cur"]').fill('fixture-password');
  await page.locator('#modal-host [name="next"]').fill('new-fixture-password');
  await page.locator('#modal-host [name="next2"]').fill('different-fixture-password');
  await page.locator('#modal-host [data-modal-ok]').click();
  assert.equal(await page.locator('#modal-host [data-err]').innerText(),'The new passwords do not match.');
  await assertLanguageHasNoDataWrites(page);
  assert.doesNotMatch(await page.locator('#modal-host').innerText(),/[ぁ-んァ-ン一-龠]/);
  assert.equal(await page.locator('#modal-host [name="next"]').inputValue(),'new-fixture-password');
  await page.locator('#modal-host [data-modal-cancel]').click();
  await page.evaluate(async()=>{await ProjectStorage.putProject({id:'online-i18n-data',displayName:'保存',sections:[],memo:{freeNote:'変更する',sampleTypes:['腎臓']},createdAt:'2026-11-16T00:00:00Z'},{createOnly:true});await renderList();});
  const before=await page.evaluate(()=>ProjectStorage.getProject('online-i18n-data'));
  await assertLanguageHasNoDataWrites(page);
  assert.deepEqual(await page.evaluate(()=>ProjectStorage.getProject('online-i18n-data')),before);
  assert.equal(await page.locator('[data-local-id="online-i18n-data"] .font-semibold').innerText(),'保存');
  await page.evaluate(()=>sessionStorage.clear());auth='network';
  await page.goto(origin+'/mrm.html');await page.locator('#modal-host [name="pw"]').fill('fixture-password');
  await page.locator('#modal-host [data-modal-ok]').click();
  await page.waitForFunction(()=>document.querySelector('#modal-host [data-err]').textContent.includes('Cannot connect'));
  assert.equal(await page.evaluate(()=>DESI_OFFLINE),false);
  await assertLanguageHasNoDataWrites(page);
  assert.doesNotMatch(await page.locator('#modal-host').innerText(),/[ぁ-んァ-ン一-龠]/);
  auth='valid';await page.locator('#modal-host [data-modal-ok]').click();
  await page.waitForFunction(()=>document.getElementById('lib').textContent.includes('Fixture library unavailable'));
  assert.doesNotMatch(await page.locator('#lib').innerText(),/[ぁ-んァ-ン一-龠]/);
  library='ok';await page.locator('#btn-reload').click();
  await page.waitForFunction(()=>document.getElementById('lib').textContent.includes('No compounds registered'));
  await page.locator('#btn-add-compound').click();
  await page.waitForFunction(()=>document.activeElement===document.querySelector('#modal-host [name="name"]'));
  await page.locator('#modal-host [name="name"]').fill('編集');
  await page.locator('#modal-host [name="note"]').fill('保存');
  assert.equal(await page.locator('#modal-host [name="note"]').inputValue(),'保存','The draft exists before changing language');
  await assertLanguageHasNoDataWrites(page);
  assert.equal(await page.locator('#modal-host [name="name"]').inputValue(),'編集');
  assert.equal(await page.locator('#modal-host [name="note"]').inputValue(),'保存');
  assert.doesNotMatch(await page.locator('#modal-host h2').innerText(),/[ぁ-んァ-ン一-龠]/);
  await page.locator('#modal-host [data-modal-cancel]').click();
  assert.deepEqual(await page.evaluate(()=>AppI18n.getMissingKeys()),[]);
  assert.deepEqual(unexpected,[],'No unmocked network or write operation was attempted');
  assert.ok(rpcCalls.includes('verify_master_pw')&&rpcCalls.includes('list_mrm_library'));
  assert.ok(rpcCalls.every(name=>['verify_master_pw','get_workspace_tree','list_projects','list_projects_v2','list_mrm_library','list_mrm_sets'].includes(name)));
  assert.deepEqual(errors,[]);
  console.log('Online manager/MRM i18n browser regression: PASS (mock authentication/network/errors, preserved inputs, no data writes)');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
