'use strict';
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {startServer}=require('../tools/help-capture.cjs');
async function main(){
  const {server,origin}=await startServer();let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/tests/fixtures/browser/i18n-smoke.html');
    await page.locator('#name').fill('未保存 <name>');await page.locator('#note').fill('unsaved 日本語 memo');await page.locator('#role').selectOption('定量');
    await page.evaluate(()=>{window.savedNodes={name:document.querySelector('#name'),note:document.querySelector('#note'),button:document.querySelector('#save'),icon:document.querySelector('#icon')};document.querySelector('#name').focus();document.querySelector('#name').setSelectionRange(1,3);AppI18n.setLocale('en');});
    assert.equal(await page.locator('#save').innerText(),'✓Save');assert.equal(await page.locator('#bound').innerText(),'Open compound 保存');
    assert.equal(await page.locator('#name').getAttribute('placeholder'),'Search');assert.equal(await page.locator('#name').inputValue(),'未保存 <name>');
    assert.equal(await page.locator('#note').inputValue(),'unsaved 日本語 memo');assert.equal(await page.locator('#project-name').innerText(),'保存');assert.equal(await page.locator('#editable').innerText(),'保存');
    assert.equal(await page.locator('#role').inputValue(),'定量');assert.equal(await page.locator('#role option:checked').innerText(),'Quantifier');
    assert.deepEqual(await page.evaluate(()=>({same:Object.entries(savedNodes).every(([id,node])=>document.querySelector('#'+({button:'save'}[id]||id))===node),selection:[document.querySelector('#name').selectionStart,document.querySelector('#name').selectionEnd],focused:document.activeElement===savedNodes.name})),{same:true,selection:[1,3],focused:true});
    await page.locator('#save').click();assert.equal(await page.evaluate(()=>clicks),1);
    await page.evaluate(()=>{document.querySelector('#bound').textContent='externally replaced 保存';AppI18n.setLocale('ja');AppI18n.setLocale('en');});
    assert.equal(await page.locator('#bound').innerText(),'externally replaced 保存','external text changes detach stale bindings');
    await page.evaluate(()=>{AppI18n.setText(document.querySelector('#bound'),'保存');AppI18n.clearBinding(document.querySelector('#bound'));AppI18n.setLocale('ja');});
    assert.equal(await page.locator('#bound').innerText(),'Save','explicit release stops locale updates');
    await page.evaluate(()=>{AppI18n.setText(document.querySelector('#save span'),'化合物 {name} を開く',()=>({name:AppI18n.t('保存')}));AppI18n.setLocale('en');});
    assert.equal(await page.locator('#save span').innerText(),'Open compound Save','imperative binding replaces the old declarative source');
    await page.evaluate(()=>AppI18n.setLocale('ja'));assert.equal(await page.locator('#save span').innerText(),'化合物 保存 を開く','binding parameters are reevaluated after language changes');
    await page.evaluate(()=>AppI18n.setText(document.querySelector('#save span'),'保存'));
    await page.evaluate(()=>AppI18n.setLocale('en'));
    await page.evaluate(()=>{const host=document.createElement('div');host.id='scoped';host.setAttribute('data-i18n-namespace','mrm-role');host.innerHTML='<span data-i18n="確認">確認</span><input '+AppI18n.attr('title','確認',null,'mrm-role')+'>';document.body.append(host);});
    await page.waitForFunction(()=>document.querySelector('#scoped span').textContent==='Qualifier');assert.equal(await page.locator('#scoped input').getAttribute('title'),'Qualifier');assert.equal(await page.evaluate(()=>AppI18n.t('確認')),'Confirm');
    await page.evaluate(()=>document.querySelector('#dynamic').innerHTML=AppI18n.html('化合物 {name} を開く',{name:'<img src=x onerror="throw 1">'})+'<input '+AppI18n.attr('title','化合物 {name} を開く',{name:'保存'})+'>');
    await page.waitForFunction(()=>document.querySelector('#dynamic span')?.textContent.startsWith('Open compound'));
    assert.equal(await page.locator('#dynamic img').count(),0);assert.equal(await page.locator('#dynamic input').getAttribute('title'),'Open compound 保存');
    await page.locator('[data-i18n-switch]').selectOption('ja');assert.equal(await page.locator('#save').innerText(),'✓保存');assert.match(await page.locator('#dynamic span').innerText(),/^化合物 <img/);
    assert.equal(await page.locator('#role').inputValue(),'定量');assert.equal(await page.locator('#name').inputValue(),'未保存 <name>');assert.equal(await page.locator('#note').inputValue(),'unsaved 日本語 memo');
    await page.locator('[data-i18n-switch]').selectOption('en');
    const second=await context.newPage();await second.goto(origin+'/tests/fixtures/browser/i18n-smoke.html');assert.equal(await second.locator('#save').innerText(),'✓Save');
    await second.locator('[data-i18n-switch]').selectOption('ja');await page.waitForFunction(()=>AppI18n.getLocale()==='ja');
    await page.goto(origin+'/Share_Test/help.html?lang=en&chapter=ratio');await page.locator('.gh-main h1').waitFor();assert.equal(await page.evaluate(()=>AppI18n.getLocale()),'en');
    await page.getByRole('button',{name:'日本語に切り替え',exact:true}).click();assert.equal(await page.evaluate(()=>AppI18n.getLocale()),'ja');assert.equal(await page.locator('html').getAttribute('lang'),'ja');
    await page.evaluate(()=>AppI18n.setLocale('en'));assert.match(await page.locator('.gh-main h1').innerText(),/ratio/i);
    assert.deepEqual(await page.evaluate(()=>AppI18n.getMissingKeys()),[]);assert.deepEqual(errors,[]);
    console.log('Application language browser regression: PASS (live switch, unsaved input, node identity, internal values, dynamic markup, cross-tab preference, Help)');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
