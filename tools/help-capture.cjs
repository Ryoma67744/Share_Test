'use strict';
// Developer-only reproducible screenshots. Uses an isolated browser profile,
// synthetic source data and a loopback server; all external requests are blocked.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createServer}=require('node:http'),{createRequire}=require('node:module');
const req=createRequire(path.resolve(__dirname,'../tests/package.json'));
const {chromium}=req('playwright'),JSZip=require('../vendor/jszip.min.js');
const {renderOfflineConfig}=require('../offline/config.cjs');
const root=path.resolve(__dirname,'..'),viewport={width:1600,height:1000};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(){
  const source=await fs.readFile(path.join(root,'tests/fixtures/browser/offline-smoke-project.zip'));
  const archive=await JSZip.loadAsync(source),doc=JSON.parse(await archive.file('OfflineSmoke.json').async('string'));
  doc.id='help-synthetic-project';doc.displayName='Help sample — synthetic data';doc.memo={sample:'Synthetic demonstration only',free:'No patient or experimental data. Two source molecules X and Y.'};
  const section=doc.sections[0];section.displayName='Sample section';section.meta={world_coords:{msi_um_per_px:{x:50,y:50}}};
  const rows=['x,y,signal,reference'];for(let y=0;y<32;y++)for(let x=0;x<48;x++){
    const d=((x-24)/21)**2+((y-16)/13)**2;
    rows.push([x,y,d<1?Math.round(25+650*Math.exp(-((x-17)**2+(y-14)**2)/150)+(x*17+y*31)%61):0,d<1?Math.round(60+450*Math.exp(-((x-30)**2+(y-17)**2)/180)):0].join(','));
  }
  archive.file('Source/smoke.csv',rows.join('\n')+'\n');
  section.originalSeries.MSI_SIGNAL.compoundMeta={base:'Molecule X',precursor:300,product:150};
  section.originalSeries.MSI_REFERENCE={...section.originalSeries.MSI_SIGNAL,v:'reference',compoundMeta:{base:'Molecule Y',precursor:302,product:152}};
  doc.rois[0].name='Region 1';doc.rois[0].polysBySection['smoke-section']=[[10,7],[25,7],[25,24],[10,24]];
  archive.file('OfflineSmoke.json',JSON.stringify(doc));
  return {buffer:await archive.generateAsync({type:'nodebuffer'}),sourceHash:sha(source),dataHash:sha(rows.join('\n')),photo:await archive.file('HE_IF/smoke.png').async('nodebuffer')};
}
async function startServer(){
  const server=createServer(async(req,res)=>{try{let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(pathname.startsWith('/Share_Test/'))pathname=pathname.slice('/Share_Test'.length);
    if(pathname==='/runtime-config.js'){res.setHeader('Content-Type','text/javascript');res.end(renderOfflineConfig());return;}
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    const filename=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''));if(!filename.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.md':'text/plain; charset=utf-8'})[path.extname(filename)]||'application/octet-stream');res.end(await fs.readFile(filename));
  }catch{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,origin:'http://127.0.0.1:'+server.address().port};
}
async function prepare(page){
  await page.waitForFunction(()=>typeof App!=='undefined'&&App.project&&App.project.sections.length&&App.project.sections.every(s=>{const p=App.panels.get(s.id);return p&&p.activeMsiKey&&Object.keys(s.msiSeries||{}).every(k=>p.isMsiLayerReady(k));}));
  await page.evaluate(async()=>{for(const s of App.project.sections)for(const key of Object.keys(s.msiSeries||{}))await App.panels.get(s.id).ensureMsiLayerLoaded(key);const s=App.project.sections[0];App.setActiveSection(s.id);App.setViewMode('compound');App.setFocusCompoundKey(Object.keys(s.msiSeries)[0]);App.recomputeMsiAbsScale();});
}
async function main(){
  const {server,origin}=await startServer(),data=await fixture();let browser;const captures=[],errors=[];
  const onlyRatio=process.argv.includes('--ratio-only'),onlyKmd=process.argv.includes('--kmd-only');
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
    const context=await browser.newContext({viewport,deviceScaleFactor:1});
    await context.route('**/*',route=>route.request().url().startsWith(origin+'/')||/^(blob|data):/.test(route.request().url())?route.continue():route.abort());
    const page=await context.newPage();page.on('dialog',d=>d.accept());page.on('pageerror',e=>errors.push(e.message));
    const output=path.join(root,'docs/help/images');await fs.mkdir(output,{recursive:true});
    async function shot(id,scenario){await page.waitForFunction(()=>!document.querySelector('#toast-host .toast'),{},{timeout:30000});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const bytes=await page.screenshot({path:path.join(output,id+'.png'),fullPage:false});captures.push({id,path:'docs/help/images/'+id+'.png',sha256:sha(bytes),scenario,role:'local author',uiLanguage:'ja / en (application labels)',viewport,deviceScaleFactor:1});console.log('Captured '+id);}
    await page.goto(origin+'/viewer/?project=help-empty');await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await page.locator('#hidden-import-input').setInputFiles({name:'Help-synthetic.zip',mimeType:'application/zip',buffer:data.buffer});
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).waitFor();if(!onlyRatio&&!onlyKmd)await shot('import','ZIP import confirmation with original numerical sources');
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();await prepare(page);
    const projectUrl=page.url();
    if(!onlyRatio&&!onlyKmd){
      await shot('viewer','Compound view with X/Y numerical sources and an existing ROI');await shot('save','Main toolbar exposes Export ZIP, Memo and project saving');
      await page.locator('#tb-smoothing').selectOption('median');await page.locator('#tb-smoothing-strength').fill('6');await page.locator('#tb-smoothing-strength').dispatchEvent('change');
      await page.waitForFunction(()=>App.msiSmoothing==='median'&&App.msiSmoothingStrength===6);await shot('display','Display-only Median at strength 6 of 10');
      await page.evaluate(()=>App.setRoiOnlyMode(true));await shot('roi','ROI-only display with automatic ROI Range');await page.evaluate(()=>App.setRoiOnlyMode(false));
      await page.evaluate(()=>{void Wizards.openAlignmentModal(App.panels.get(App.project.sections[0].id));});await page.locator('.alignment-card').waitFor();await page.waitForFunction(()=>document.querySelector('[data-he-img]')?.dataset.ready==='true');await shot('align','Actual Align workspace');
      await page.locator('.alignment-card [data-modal-cancel]').click();
      await page.evaluate(()=>{RoiMediaApp.open(App.project,App.project.rois[0]);});await page.locator('.roi-media-window').waitFor();await page.locator('.roi-media-window input[type=file]').first().setInputFiles({name:'Synthetic microscopy.png',mimeType:'image/png',buffer:data.photo});await page.waitForFunction(()=>document.querySelector('.roi-media-thumbnails')?.children.length>0);await shot('microscope','Actual ROI microscopy workspace');await page.keyboard.press('Escape');
      await page.goto(projectUrl);await prepare(page);await page.locator('#btn-share-preview').click();await page.locator('[data-preview-close]').waitFor();await shot('preview','Actual Preview image grid');await page.locator('[data-preview-close]').click();
      await page.locator('#btn-export-ppt').click();await page.getByRole('dialog').waitFor();await shot('report','Actual PPT export options');await page.keyboard.press('Escape');
    }
    if(process.argv.includes('--skip-ratio')||onlyKmd)console.log('Ratio capture deferred; run --ratio-only after UI is ready.');
    else{
      const ratioFixture=require('../tests/msi_ratio_browser_regression.cjs'), ratioData=ratioFixture.fixture();
      const ratioArchive=await ratioFixture.archive(ratioData);
      await page.goto(projectUrl);await prepare(page);
      await page.locator('#hidden-import-input').setInputFiles({name:'Synthetic-ratio.zip',mimeType:'application/zip',buffer:ratioArchive});
      await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();await ratioFixture.prepare(page);
      await ratioFixture.createRatio(page);await shot('ratio','Saved X/Y ratio with actual ROI summary and validity counts');
      captures.at(-1).fixture='tests/msi_ratio_browser_regression.cjs:fixture/archive';captures.at(-1).numericalSourceSha256=sha(JSON.stringify(ratioData.sources));
      await page.locator('#msi-ratio-dialog').getByRole('button',{name:'閉じる',exact:true}).click();
      await shot('ratio-image','Actual ratio MSI image after saving the definition');
      captures.at(-1).fixture='tests/msi_ratio_browser_regression.cjs:fixture/archive';captures.at(-1).numericalSourceSha256=sha(JSON.stringify(ratioData.sources));
      if(process.env.HELP_REVIEW_SCREENSHOT){await page.evaluate(()=>GuidedHelp.open({role:'master',lang:'ja',mode:'offline',chapter:'ratio'}));await page.locator('.gh-main img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));await fs.mkdir(path.dirname(path.resolve(process.env.HELP_REVIEW_SCREENSHOT)),{recursive:true});await page.screenshot({path:process.env.HELP_REVIEW_SCREENSHOT,fullPage:false});await page.evaluate(()=>GuidedHelp.close());}
    }
    if(!onlyRatio){
      const kmdArchive=await JSZip.loadAsync(data.buffer),kmdDoc=JSON.parse(await kmdArchive.file('OfflineSmoke.json').async('string'));
      kmdDoc.id='help-synthetic-kmd';kmdDoc.displayName='Synthetic non-target KMD';
      const section=kmdDoc.sections[0],source=section.originalSeries.MSI_SIGNAL;
      section.meta.kind='nontarget';section.originalSeries={};
      for(let family=0;family<2;family++)for(let index=0;index<6;index++){
        const key='MSI_KMD_'+family+'_'+index;
        section.originalSeries[key]={...source,v:family?'reference':'signal',compoundMeta:{base:'Synthetic '+String.fromCharCode(65+family)+(index+1),mz:(family?650.34:500.1)+index*14.015650,adduct:'[M+H]+',lipidClass:'Synthetic series '+(family+1)}};
      }
      kmdArchive.file('OfflineSmoke.json',JSON.stringify(kmdDoc));
      await page.goto(projectUrl);await prepare(page);await page.locator('#hidden-import-input').setInputFiles({name:'Synthetic-KMD.zip',mimeType:'application/zip',buffer:await kmdArchive.generateAsync({type:'nodebuffer'})});
      await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();await prepare(page);
      await page.locator('#analysis-mode').selectOption('kmd');await page.waitForFunction(()=>document.querySelector('#graph-container')?._lastKmd?.points.length===12&&document.querySelectorAll('.kmd-series-row').length>=2);
      await page.locator('#kmd-unit').selectOption('CH2');await shot('kmd','Actual non-target Method table and KMD panel with 12 synthetic masses in two CH2 series');
      captures.at(-1).fixture='offline-smoke ZIP with synthetic non-target metadata';captures.at(-1).compoundMetadataSha256=sha(JSON.stringify(section.originalSeries));
    }
    if(!onlyRatio&&!onlyKmd){
      await page.goto(origin+'/');await page.locator('#btn-help').waitFor();await shot('projects','Actual local project manager with imported synthetic project');
      await page.evaluate(()=>localStorage.setItem('desi:offlineMrm:v1',JSON.stringify({format:'desi-offline-mrm',version:1,sets:[],template:null,ignored:[],compounds:[{id:'help-compound',name:'Synthetic lactate',polarity:'-',shelf:'main',check_level:'std',tags:['Help sample'],note:'Synthetic demonstration data',transitions:[{id:'help-transition',compound_id:'help-compound',precursor:89,product:43,ce:11,cv:20,usages:[]}]}]})));await page.goto(origin+'/mrm.html');await page.locator('#btn-exp-edit').waitFor();await page.waitForFunction(()=>!document.getElementById('lib').textContent.includes('読み込み中'));await shot('mrm','Actual local MRM management');
      await page.locator('#btn-exp-edit').click();await page.getByLabel('.exp ファイルを選択',{exact:true}).setInputFiles(path.join(root,'tests/fixtures/exp/flat-mrm-selection-synthetic.exp'));await page.getByLabel('1 行目 CE（衝突）',{exact:true}).waitFor();await shot('exp','Actual exp editor with the synthetic supported MRM fixture');
    }
    let previous={captures:[]};try{previous=JSON.parse(await fs.readFile(path.join(root,'docs/help/capture-manifest.json'),'utf8'));}catch{}
    const ids=new Set(captures.map(c=>c.id));const sourceVersion=(await fs.readFile(path.join(root,'version.js'),'utf8')).match(/v\d{4}-\d{2}-\d{2}\.\d+/)?.[0];
    const sourceFiles=['index.html','mrm.html','app-runtime.js','version.js',...(await fs.readdir(path.join(root,'viewer'))).filter(name=>/\.(?:html|js|css)$/.test(name)).map(name=>'viewer/'+name),...(await fs.readdir(path.join(root,'mrm'))).filter(name=>/\.(?:mjs|css)$/.test(name)).map(name=>'mrm/'+name)];
    const sourceFilesSha256=Object.fromEntries(await Promise.all(sourceFiles.sort().map(async file=>[file,sha(await fs.readFile(path.join(root,file)))])));
    const help=JSON.parse(await fs.readFile(path.join(root,'docs/help/manifest.json'),'utf8'));for(const item of captures){item.mode='offline';item.chapterIds=help.chapters.filter(chapter=>chapter.screenshots.includes(item.id)).map(chapter=>chapter.id);}
    const meta={format:1,sourceFilesSha256,captureToolSha256:sha(await fs.readFile(__filename)),generatedBy:'node tools/help-capture.cjs',sourceVersion,browser:browser.version(),fixture:'tests/fixtures/browser/offline-smoke-project.zip with deterministic X/Y source extension',fixtureSha256:data.sourceHash,numericalSourceSha256:data.dataHash,synthetic:true,captures:[...previous.captures.filter(c=>!ids.has(c.id)),...captures].sort((a,b)=>a.id.localeCompare(b.id))};
    await fs.writeFile(path.join(root,'docs/help/capture-manifest.json'),JSON.stringify(meta,null,2)+'\n');
    if(errors.length)throw new Error('Application page errors: '+JSON.stringify(errors));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture,startServer,prepare};
