'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const {chromium}=require('playwright');const {startServer}=require('../tools/help-capture.cjs');
async function main(){
  const {server,origin}=await startServer();let browser;const errors=[],failed=[];
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.route('**/*',r=>r.request().url().startsWith(origin+'/')||/^(data|blob):/.test(r.request().url())?r.continue():r.abort());
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push(r.url());});
    for(const prefix of ['/','/Share_Test/']){
      await page.goto(origin+prefix+'help.html?chapter=ratio&role=master&lang=ja#keep-project-hash');
      await page.locator('.gh-main h1').waitFor();assert.equal(await page.locator('[data-help-chapter]').count(),13);
      assert.match(await page.locator('.gh-main h1').innerText(),/比/);assert.equal(new URL(page.url()).hash,'#keep-project-hash');
      await page.locator('.gh-main img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
      assert.ok(await page.locator('.gh-main img').evaluateAll(images=>images.every(image=>image.naturalWidth>0)));
      assert.ok((await page.locator('.gh-main img').first().getAttribute('src')).startsWith(origin+prefix+'docs/help/'));
      await page.getByRole('tab',{name:'集計への影響',exact:true}).click();assert.match(await page.locator('[role=tabpanel]').innerText(),/ROI総信号比/);assert.match(await page.locator('[role=tabpanel]').innerText(),/10 \/ 3/);
      await page.getByRole('tab',{name:'保存と共有',exact:true}).click();assert.match(await page.locator('[role=tabpanel]').innerText(),/個人用/);
      await page.getByRole('button',{name:'Switch to English',exact:true}).click();assert.match(await page.locator('.gh-main h1').innerText(),/ratio/);
      assert.match(await page.getByRole('link',{name:'Read the detailed guide',exact:true}).getAttribute('href'),/USER_GUIDE\.master\.en\.md$/);
      await page.getByRole('searchbox').fill('median');assert.ok(await page.locator('[data-help-chapter]').count()<13);await page.locator('[data-help-chapter=display]').click();
      await page.getByRole('tab',{name:'Steps',exact:true}).click();assert.match(await page.locator('.gh-steps').innerText(),/1.*10/);
      assert.equal(new URL(page.url()).hash,'#keep-project-hash');
      await page.getByRole('searchbox').fill('');
      await page.getByRole('link',{name:'Read the detailed guide',exact:true}).click();await page.locator('.gh-detailed').waitFor();assert.match(await page.locator('.gh-detailed').innerText(),/Median/);assert.deepEqual(await page.locator('.gh-detailed').evaluate(body=>{const ids=new Set([...body.querySelectorAll('[id]')].map(e=>e.id));return [...body.querySelectorAll('a[href^="#"]')].map(a=>decodeURIComponent(a.getAttribute('href').slice(1))).filter(id=>!ids.has(id));}),[],'detailed guide anchors resolve');await page.locator('.gh-detailed a[href^="#"]').first().click();assert.equal(new URL(page.url()).hash,'#keep-project-hash');await page.getByRole('button',{name:'Back to guide',exact:true}).click();
      for(const id of await page.locator('[data-help-chapter]').evaluateAll(items=>items.map(i=>i.dataset.helpChapter))){await page.locator('[data-help-chapter='+id+']').click();await page.locator('.gh-main img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));}
      const safe=await page.evaluate(()=>['docs/help/../private.png','https://other.invalid/a.png','docs/help/images/a%2fb.png','docs/help//manifest.json'].map(s=>{try{GuidedHelp.asset(s);return false;}catch{return true;}}));assert.ok(safe.every(Boolean));
      for(const role of ['viewer','admin']){
        await page.goto(origin+prefix+'help.html?chapter=ratio&role='+role+'&lang=ja&mode=online');await page.locator('.gh-main h1').waitFor();assert.equal(await page.locator('[data-help-chapter]').count(),10);
        assert.equal(await page.locator('.gh-top select').isDisabled(),true);assert.equal(await page.locator('[data-help-chapter=projects]').count(),0);assert.match(await page.locator('.gh-notice').innerText(),/個人|自分用/);
      }
      await page.goto(origin+prefix+'help.html?chapter=save&role=master&lang=en&mode=offline');await page.locator('.gh-main h1').waitFor();assert.match(await page.locator('.gh-notice').innerText(),/unavailable/);
    }
    // Real manager and MRM hooks, closing restores focus without navigation.
    for(const [target,chapter] of [['','projects'],['mrm.html','mrm']]){
      await page.goto(origin+'/'+target);const button=page.locator('#btn-help');await button.waitFor();await button.click();await page.locator('[data-help-chapter='+chapter+'][aria-current=page]').waitFor();
      await page.keyboard.press('Escape');assert.equal(await page.locator('.guided-help').count(),0);assert.equal(await button.evaluate(e=>e===document.activeElement),true);
    }
    // Real viewer calls the shared helper and leaves its project hash intact.
    await page.goto(origin+'/viewer/?project=help-browser-empty');await page.waitForFunction(()=>typeof App!=='undefined'&&window.GuidedHelp);await page.evaluate(()=>GuidedHelp.open({role:'master',lang:'ja',chapter:'ratio'}));await page.locator('.gh-main h1').waitFor();
    const hash=await page.evaluate(()=>location.hash);await page.locator('[data-help-chapter=roi]').click();assert.equal(await page.evaluate(()=>location.hash),hash);
    if(process.env.HELP_SCREENSHOT_DIR){await fs.mkdir(process.env.HELP_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.HELP_SCREENSHOT_DIR,'guided-help.png')});}
    const offlinePage=await context.newPage();await offlinePage.setContent(require('../tools/docs.cjs').renderGuide(path.resolve(__dirname,'..')));await offlinePage.locator('article img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
    assert.ok(await offlinePage.locator('article img').evaluateAll(images=>images.every(image=>image.src.startsWith('data:')&&image.naturalWidth>0)));
    assert.ok(await offlinePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'standalone guide images fit the page');
    await offlinePage.setViewportSize({width:600,height:900});assert.ok(await offlinePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'standalone guide is responsive');await offlinePage.close();
    assert.deepEqual(failed,[],'Help assets must not return errors');assert.deepEqual(errors,[],'no browser exceptions');
    console.log('Guided Help browser regression: PASS (root / Pages base, 13 chapters, JP/EN, roles, offline, images, hooks, focus, hash, paths)');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
