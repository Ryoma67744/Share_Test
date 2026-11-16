'use strict';
// Actual pages, isolated browser storage, and local synthetic data only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
async function main(){
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/runtime-config.js'){res.setHeader('Content-Type','text/javascript');res.end('window.DESI_BUILD_CONFIG=Object.freeze({mode:"offline"});');return;}
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));}catch(_){res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>route.request().url().startsWith(origin+'/')||route.request().url().startsWith('blob:')?route.continue():route.abort());
  await page.goto(origin+'/index.html');await page.waitForFunction(()=>typeof _lastListRows!=='undefined');
  await page.locator('[data-i18n-switch]').click();
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('#btn-new').innerText(),'+ New project');
  await page.locator('#btn-new').click();
  await page.waitForFunction(()=>document.activeElement===document.querySelector('#modal-host [name="name"]'));
  await page.locator('#modal-host [name="name"]').fill('編集 <b>保存</b>');
  await page.locator('#modal-host [name="sample_types"]').fill('腎臓, 脳');
  await page.evaluate(()=>AppI18n.setLocale('ja'));
  assert.equal(await page.locator('#modal-host [name="name"]').inputValue(),'編集 <b>保存</b>');
  await page.evaluate(()=>AppI18n.setLocale('en'));
  assert.equal(await page.locator('#modal-host h2').innerText(),'New project');
  assert.equal(await page.locator('#modal-host [name="sample_types"]').inputValue(),'腎臓, 脳');
  await page.locator('#modal-host [data-modal-cancel]').click();
  await page.evaluate(async()=>{await ProjectStorage.putProject({id:'data-translation-test',displayName:'保存',sections:[],memo:{sampleTypes:['編集']},createdAt:'2026-11-16T00:00:00Z'},{createOnly:true});await renderList();});
  assert.equal(await page.locator('[data-local-id="data-translation-test"] .font-semibold').innerText(),'保存');
  const projectBefore=await page.evaluate(()=>ProjectStorage.getProject('data-translation-test'));
  await page.evaluate(()=>{AppI18n.setLocale('ja');AppI18n.setLocale('en');});
  assert.deepEqual(await page.evaluate(()=>ProjectStorage.getProject('data-translation-test')),projectBefore);
  await page.locator('#local-recovery-button').click();
  assert.equal(await page.locator('#local-recovery-dialog h2').innerText(),'Recovery drafts & settings');
  await page.evaluate(()=>AppI18n.setLocale('ja'));
  assert.equal(await page.locator('#local-recovery-dialog [name="recovery-enabled"]').count(),2,'Changing language keeps the radio inputs');
  await page.evaluate(()=>AppI18n.setLocale('en'));
  await page.locator('#local-recovery-dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.goto(origin+'/mrm.html');await page.waitForFunction(()=>typeof library!=='undefined');
  assert.equal(await page.locator('h1').innerText(),'MRM management','Locale persists between pages');
  await page.evaluate(async()=>{
   await DesiLocalMrm.rpc('upsert_compound',{_name:'編集',_tags:['保存'],_polarity:'-',_check_level:'std',_shelf:'main'});
   await loadLibrary();await DesiLocalMrm.rpc('upsert_transition',{_compound_id:library[0].id,_precursor:89,_product:43,_ce:11,_cv:20,_role:'定量'});await loadLibrary();
  });
  const mrmBefore=await page.evaluate(()=>DesiLocalMrm.exportDocument());
  assert.match(await page.locator('#lib').innerText(),/編集/);assert.match(await page.locator('#lib').innerText(),/保存/);
  await page.locator('#lib details.cpd > summary').click();
  assert.match(await page.locator('#lib').innerText(),/Quantifier/);
  await page.evaluate(()=>AppI18n.setLocale('ja'));
  assert.match(await page.locator('#lib [data-action="move-shelf"]').innerText(),/アーカイブ/);
  await page.evaluate(()=>AppI18n.setLocale('en'));
  assert.match(await page.locator('#lib [data-action="move-shelf"]').innerText(),/Archive/);
  await page.evaluate(()=>{void openCompoundModal(library[0]);});
  // openModal schedules autofocus. Let it finish before fill() selects a
  // different field, or its insertText command can land in the first input.
  await page.waitForFunction(()=>document.activeElement===document.querySelector('#modal-host [name="name"]'));
  await page.locator('#modal-host [name="note"]').fill('日本語の入力を維持');
  assert.equal(await page.locator('#modal-host [name="note"]').inputValue(),'日本語の入力を維持','The draft exists before changing language');
  await page.evaluate(()=>AppI18n.setLocale('ja'));
  assert.equal(await page.locator('#modal-host [name="note"]').inputValue(),'日本語の入力を維持');
  assert.equal(await page.locator('#modal-host h2').innerText(),'化合物を編集');
  await page.evaluate(()=>AppI18n.setLocale('en'));
  assert.equal(await page.locator('#modal-host h2').innerText(),'Edit compound');
  await page.locator('#modal-host [data-modal-cancel]').click();
  await page.evaluate(()=>{void openTransitionModal(library[0].transitions[0]);});
  assert.equal(await page.locator('#modal-host [name="role"]').inputValue(),'定量');
  assert.equal(await page.locator('#modal-host [name="role"] option[value="定量"]').innerText(),'Quantifier');
  assert.equal(await page.locator('#modal-host [name="role"] option[value="確認"]').innerText(),'Qualifier');
  await page.locator('#modal-host [data-modal-cancel]').click();
  await page.locator('#btn-import-excel').click();
  // The grid is populated after openModal captures its initial focus target.
  await page.waitForFunction(()=>document.activeElement===document.querySelector('#modal-host [data-bulk-tags]'));
  await page.locator('[data-cell="name"]').first().fill('保存');
  await page.evaluate(()=>{window.bulkLanguageDraft=document.querySelector('[data-cell="name"]');});
  assert.equal(await page.locator('[data-cell="name"]').first().inputValue(),'保存','The grid draft exists before changing language');
  await page.evaluate(()=>AppI18n.setLocale('ja'));await page.evaluate(()=>AppI18n.setLocale('en'));
  assert.equal(await page.evaluate(()=>bulkLanguageDraft===document.querySelector('[data-cell="name"]')),true,'Changing language preserves the edited grid node');
  assert.equal(await page.locator('[data-cell="name"]').first().inputValue(),'保存');
  await page.locator('#modal-host [data-modal-cancel]').click();
  assert.deepEqual(await page.evaluate(()=>DesiLocalMrm.exportDocument()),mrmBefore,'Language changes never mutate library data or role values');
  await page.locator('#btn-exp-edit').click();
  await page.getByLabel('Choose .exp file',{exact:true}).setInputFiles(path.join(root,'tests/fixtures/exp/flat-mrm-synthetic.exp'));
  await page.getByLabel('Row 1: CE (collision)',{exact:true}).fill('15');
  const rowBefore=await page.locator('.exp-dialog tbody input').evaluateAll(nodes=>nodes.map(n=>[n.value,n.checked]));
  await page.evaluate(()=>AppI18n.setLocale('ja'));
  await page.getByLabel('1 行目 CE（衝突）',{exact:true}).waitFor();
  assert.match(await page.locator('.exp-warning').innerText(),/実ファイル/,'Parse warnings also follow the selected language');
  assert.deepEqual(await page.locator('.exp-dialog tbody input').evaluateAll(nodes=>nodes.map(n=>[n.value,n.checked])),rowBefore);
  await page.evaluate(()=>AppI18n.setLocale('en'));
  assert.doesNotMatch(await page.locator('.exp-warning').innerText(),/[ぁ-んァ-ン一-龠]/);
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:/^Save selected MRM to \.exp/}).click();
  const download=await pending,bytes=fs.readFileSync(await download.path());
  const expected=fs.readFileSync(path.join(root,'tests/fixtures/exp/flat-mrm-synthetic.exp'),'utf8').replace('CollisionEnergy(eV)_1,11.0000','CollisionEnergy(eV)_1,15');
  assert.equal(bytes.toString('utf8'),expected,'English export changes only the edited scientific value');
  assert.deepEqual(await page.evaluate(()=>AppI18n.getMissingKeys()),[],'Every exercised source key has an English translation');
  assert.deepEqual(errors,[]);
  console.log('Manager/MRM i18n browser regression: PASS (live forms, preserved data/roles, storage, shared locale, .exp output)');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
