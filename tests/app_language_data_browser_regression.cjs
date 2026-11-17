'use strict';
// Real parsers, saved projects, shared-view transport and original numeric rows.
// Only the cloud endpoint is a loopback fixture; no account or live data is used.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('playwright');
const F=require('./msi_ratio_browser_regression.cjs');
async function csv(page,kind){const pending=page.waitForEvent('download');await page.locator('[data-ratio-csv="'+kind+'"]').click();return fs.readFile(await (await pending).path());}
async function verify(page,mode){
  const ratioKey=await F.createRatio(page),dialog=page.locator('#msi-ratio-dialog');
  const original=await F.sourceSnapshot(page),ratios=await F.ratioSnapshot(page,ratioKey);
  const beforeCsv=await csv(page,'summary');
  await page.evaluate(async()=>{if(!App.shareMode)await App._flushSave();});
  const before=await page.evaluate(()=>JSON.stringify(App.project));
  const savedName=await dialog.locator('[data-ratio-name]').inputValue();
  await dialog.locator('[data-ratio-name]').fill('保存 <English> 未保存');
  await page.evaluate(()=>{window.languageDraft=document.querySelector('[data-ratio-name]');languageDraft.focus();languageDraft.setSelectionRange(2,6);});
  await page.evaluate(()=>AppI18n.setLocale('en'));
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await dialog.locator('[data-ratio-name]').inputValue(),'保存 <English> 未保存');
  assert.deepEqual(await page.evaluate(()=>({same:languageDraft===document.querySelector('[data-ratio-name]'),selection:[languageDraft.selectionStart,languageDraft.selectionEnd],focused:document.activeElement===languageDraft})),{same:true,selection:[2,6],focused:true});
  assert.equal(await page.evaluate(()=>JSON.stringify(App.project)),before,'Changing language does not mutate the project');
  assert.deepEqual(await F.sourceSnapshot(page),original,'Source bytes, measured values, geometry, ROI rows and statistics are identical');
  assert.deepEqual(await F.ratioSnapshot(page,ratioKey),ratios,'Ratio results are language-independent');
  // CSV export correctly requires saved settings; restore the draft field
  // without saving before comparing the same saved ratio in the other locale.
  await dialog.locator('[data-ratio-name]').fill(savedName);
  assert.deepEqual(await csv(page,'summary'),beforeCsv,'Numeric CSV bytes do not depend on UI language');
  await dialog.locator('[data-ratio-name]').fill('保存 <English> 未保存');
  assert.equal(await page.locator('#btn-export-ppt').innerText(),'PPT report');
  assert.equal(await page.locator('#method-filter-count').innerText(),'2 items');
  await page.evaluate(()=>AppI18n.setLocale('ja'));
  assert.equal(await page.locator('#btn-export-ppt').innerText(),'PPTレポート');
  assert.equal(await dialog.locator('[data-ratio-name]').inputValue(),'保存 <English> 未保存');
  assert.equal(await page.evaluate(()=>JSON.stringify(App.project)),before);
  await page.evaluate(()=>AppI18n.setLocale('en'));await page.reload();await F.prepare(page,mode==='online');
  assert.equal(await page.evaluate(()=>AppI18n.getLocale()),'en');assert.equal(await page.locator('#btn-export-ppt').innerText(),'PPT report');
  assert.deepEqual(await F.sourceSnapshot(page),original,'Saved data survives reload in English');
  if(mode==='offline')assert.match(await page.evaluate(async()=>{try{await fetch('https://invalid.example.test/no-network');return 'unexpected success';}catch(e){return e.message;}}),/offline/i);
  assert.deepEqual(await page.evaluate(()=>AppI18n.getMissingKeys()),[]);
  console.log('Language/data '+mode+': PASS (source SHA256, ROI/ratio numbers, CSV bytes, unsaved input, reload and language preference)');
}
async function main(){let browser;const errors=[],external=[];
try{browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
 for(const mode of ['offline','online']){
  const configuredRoot=process.env[mode==='online'?'LANGUAGE_TEST_WEB_ROOT':'LANGUAGE_TEST_OFFLINE_ROOT'];
  const state=await F.startServer(F.fixture(),configuredRoot?{sourceRoot:path.resolve(configuredRoot)}:{});state.online=mode==='online';
  const context=await browser.newContext({viewport:{width:1440,height:1000}});try{
   await context.route('**/*',r=>{const u=r.request().url();if(u.startsWith(state.origin+'/')||/^(blob|data):/.test(u))return r.continue();external.push(u);return r.abort();});
   const page=await context.newPage();page.on('pageerror',e=>{errors.push(mode+': '+e.message);console.error(mode+': '+e.message);});page.on('dialog',d=>d.accept());
   if(mode==='offline'){
    await page.goto(state.origin+'/viewer/?project=language-synthetic-empty');await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await page.locator('#hidden-import-input').setInputFiles({name:'Language.zip',mimeType:'application/zip',buffer:await F.archive(F.fixture())});
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();await F.prepare(page);
   }else{
    await context.addInitScript(({slug})=>{sessionStorage.setItem('desi:share:'+slug,JSON.stringify({slug,token:'synthetic-token',role:'viewer',expiresAt:new Date(Date.now()+3600000).toISOString(),isPublic:false}));},{slug:F.slug});
    await page.goto(state.origin+'/viewer/#share='+F.slug);await F.prepare(page,true);
   }
   await verify(page,mode);assert.deepEqual(state.writes,[],'Language switching never writes to the server');
  }finally{await context.close();await state.close();}
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}finally{if(browser)await browser.close();}}
module.exports={verify};
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
