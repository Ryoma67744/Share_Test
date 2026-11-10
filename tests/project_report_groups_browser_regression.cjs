'use strict';

// Real import, options dialog, numeric report preparation and PowerPoint ZIP.
// All measurements are synthetic; this browser may contact localhost only.
const assert=require('node:assert/strict'),fs=require('node:fs/promises');
const {chromium}=require('playwright'),JSZip=require('../vendor/jszip.min.js');
const {fixture,archive,startServer,sourceSnapshot,ratioSnapshot}=require('./msi_ratio_browser_regression.cjs');

function groupFixture(){
  const data=fixture(),sectionTemplate=data.doc.sections[0],roiTemplate=data.rois[0];
  const source=data.sources['synthetic/ratio-0.csv'];
  data.sources={};data.doc.sections=[];data.rois=[];
  for(let index=0;index<6;index++){
    const factor=index+1,section=structuredClone(sectionTemplate),sourcePath='synthetic/ratio-'+index+'.csv';
    section.id='groups-server-'+index;section.meta.client_id='groups-section-'+index;section.ordinal=index+1;
    section.display_name=index===5?'Excluded sample':'Group sample '+factor;
    data.sources[sourcePath]=source.trimEnd().split('\n').map((line,row)=>{
      if(!row)return line+',X_OTHER';const cells=line.split(',');if(cells[2]!=='')cells[2]=String(Number(cells[2])*factor);return [...cells,cells[2]].join(',');
    }).join('\n')+'\n';
    for(const [key,entry] of Object.entries(section.storage_paths.msiSeries)){
      Object.assign(entry,{path:sourcePath,filename:'ratio-'+index+'.csv',sourceFileId:'ratio-file-'+index,
        sourceReference:'ratio-source-'+index,compoundMeta:{base:key==='MSI_X'?'Molecule X':'Molecule Y',
          precursor:key==='MSI_X'?101:102,product:50,ce:10,cv:20,polarity:'+'}});
    }
    // Same name and source pixels, different measured transition. Grouping must
    // not turn this registration into the matching X entry of other sections.
    if(index===1)section.storage_paths.msiSeries.MSI_X_OTHER={...structuredClone(section.storage_paths.msiSeries.MSI_X),v:'X_OTHER',
      compoundMeta:{...section.storage_paths.msiSeries.MSI_X.compoundMeta,product:51}};
    data.doc.sections.push(section);
    const roi=structuredClone(roiTemplate);roi.id='groups-roi-'+index;roi.section_id=section.id;
    roi.poly_msi.geometry.sourceRef='ratio-source-'+index;data.rois.push(roi);
  }
  return data;
}
async function openOptions(page){
  await page.waitForFunction(()=>!document.getElementById('btn-export-ppt').disabled);
  await page.locator('#btn-export-ppt').click();await page.locator('[data-report-create]').waitFor();
}
async function dialogState(page){
  return page.locator('.project-report-options').evaluate(dialog=>({
    groups:[...dialog.querySelectorAll('[data-report-group-id]')].map(row=>({
      id:row.dataset.reportGroupId,name:row.querySelector('[data-report-group-name]').value})),
    rows:[...dialog.querySelectorAll('[data-report-section-id]')].map(row=>({
      id:row.dataset.reportSectionId,output:row.querySelector('[data-report-output]').checked,
      group:row.querySelector('[data-report-group]').value}))
  }));
}
async function addGroup(page,name){
  await page.locator('[data-report-add-group]').click();
  const row=page.locator('[data-report-group-id]').last(),id=await row.getAttribute('data-report-group-id');
  await row.locator('[data-report-group-name]').fill(name);
  await row.locator('[data-report-group-name]').dispatchEvent('change');return id;
}
async function createDeck(page,displayStyle){
  await page.locator('#project-report-use-display-style').setChecked(displayStyle);
  await page.locator('#project-report-include-ratios').check();
  const download=page.waitForEvent('download',{timeout:120000});await page.locator('[data-report-create]').click();
  const zip=await JSZip.loadAsync(await fs.readFile(await (await download).path()));
  const parts=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a,b)=>Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1]));
  const slides=await Promise.all(parts.map(name=>zip.file(name).async('string')));
  const xml=(await Promise.all(Object.keys(zip.files).filter(name=>/\.(xml|rels)$/.test(name))
    .map(name=>zip.file(name).async('string')))).join('\n');
  const text=slides.map(s=>[...s.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(m=>m[1]).join(' ')).join('\n');
  await page.waitForFunction(()=>!document.getElementById('btn-export-ppt').disabled);
  return {slides,xml,text,report:await page.evaluate(()=>window.groupPrepared)};
}
function assertWindows(report,ids,groupMaxima){
  const measuredX=report.molecules.filter(m=>m.kind!=='ratio'&&m.name==='Molecule X');
  assert.equal(measuredX.length,2,'Identical names with different product ions remain separate molecular entries');
  const ordinary=measuredX.find(m=>m.sections.length===ids.length),variant=measuredX.find(m=>m.sections.length===1);
  assert.ok(ordinary&&variant);assert.notEqual(ordinary.key,variant.key);
  assert.deepEqual(variant.sections.map(s=>s.sectionId),[ids[1]],'The different MRM appears only where registered');
  assert.deepEqual(ordinary.sections.map(s=>s.displayWindow),groupMaxima.map(max=>({min:0,max:max})),
    'Measured windows use the chosen group scope and ignore manual Viewer ranges');
  const ratio=report.molecules.find(m=>m.kind==='ratio');assert.ok(ratio);
  assert.deepEqual(ratio.sections.map(s=>s.displayWindow),groupMaxima.map(max=>({min:0,max:max*10/12})),
    'Ratio groups derive automatic windows from valid ratios, ignoring stored manual ratio ranges');
  ratio.sections.forEach((entry,index)=>{
    const stats=entry.ratioRois[0].statistics;
    assert.equal(stats.nCandidate,8);assert.equal(stats.nValid,4);
    assert.equal(stats.totalRatio,2*(index+1));assert.equal(stats.mean,3.75*(index+1));
  });
  assert.equal(report.molecules.length,4,'Output grouping does not create or merge scientific MRM identities');
}
async function main(){
  const data=groupFixture(),server=await startServer(data),browser=await chromium.launch({headless:true,
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  try{
    const context=await browser.newContext({viewport:{width:1700,height:1100},acceptDownloads:true}),page=await context.newPage();
    const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
    await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(server.origin+'/')||/^(blob|data):/.test(url))return route.continue();external.push(url);return route.abort();});
    await page.goto(server.origin+'/viewer/?project=report-groups-empty');await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await page.locator('#hidden-import-input').setInputFiles({name:'SyntheticReportGroups.zip',mimeType:'application/zip',buffer:await archive(data)});
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();
    await page.waitForFunction(()=>App.project?.sections.length===6&&App.panels.size===6);
    await page.evaluate(async()=>{
      for(const section of App.project.sections)for(const key of Object.keys(section.msiSeries))
        if(!await App.panels.get(section.id).ensureMsiLayerLoaded(key))throw new Error('Synthetic source unavailable');
      App.setActiveSection(App.project.sections[0].id);App.setViewMode('compound');App.setFocusCompoundKey('MSI_X');
      await App.setOtsuBgRemove(false);App.activeRoiId=App.project.rois[0].id;
    });
    await page.locator('#btn-msi-ratio').click();
    const ratioDialog=page.locator('#msi-ratio-dialog');await ratioDialog.locator('[data-ratio-name]').fill('Output X / Y');
    for(let index=0;index<6;index++){
      await ratioDialog.locator('[data-ratio-x]').nth(index).selectOption('MSI_X');
      await ratioDialog.locator('[data-ratio-y]').nth(index).selectOption('MSI_Y');
    }
    await ratioDialog.locator('[data-ratio-apply]').click();
    await page.waitForFunction(()=>App.getRatioDefinitions().length===1&&App.project.sections.every(s=>{
      const panel=App.panels.get(s.id);return panel.activeMsiKey?.startsWith('MSI_RATIO_')&&panel.isMsiLayerReady(panel.activeMsiKey);
    })).catch(async error=>{console.error(await page.evaluate(()=>({message:document.querySelector('[data-ratio-status]')?.textContent,
      panels:[...App.panels.values()].map(p=>({id:p.section.id,active:p.activeMsiKey,errors:[...p._msiLoadErrors].map(([key,value])=>[key,value.error?.message])}))})));throw error;});
    await ratioDialog.evaluate(el=>el.close());
    const setup=await page.evaluate(async()=>{
      const key=MsiRatioModel.displayKey(App.getRatioDefinitions()[0].id),ids=App.project.sections.map(s=>s.id);
      const individual=Object.fromEntries(App.project.sections.map(s=>[MsiRatioModel.canonicalSectionId(s),{min:777,max:888}]));
      MsiRatioRuntime.saveStyle(key,{scaleMode:'individual',interpolation:'none',rangePolicy:'maximum',
        ranges:{version:1,whole:{same:{min:777,max:888},...individual},roi:{same:{min:555,max:666},...individual}}});
      App.msiUserWindow.MSI_X={min:901,max:9999};App.msiUserWindow.MSI_Y={min:902,max:9998};
      // Report membership must be independent of the main Viewer selection.
      App.sectionVisibility().change(ids.slice(1),false);
      await App._flushSave();
      for(const name of ['jszip','pptxgen','projectReportData','projectReportDeck'])await loadScript(LAZY_LIBS[name]);
      const original=ProjectReportData;
      window.ProjectReportData={...original,async prepare(...args){
        const report=await original.prepare(...args);window.groupPrepared={outputPlan:report.outputPlan,
          sections:report.sections,metadata:report.metadata,molecules:report.molecules.map(m=>({key:m.key,name:m.name,
            kind:m.kind,sections:m.sections.map(s=>({sectionId:s.sectionId,name:s.name,displayWindow:s.displayWindow,
              outputGroupId:s.outputGroupId,ratioRois:s.ratioRois,max:s.max,mean:s.mean,n:s.n}))}))};return report;
      }};
      return {key,ids};
    });
    const before={sources:await sourceSnapshot(page),ratios:await ratioSnapshot(page,setup.key),
      project:await page.evaluate(()=>JSON.stringify(App.project)),windows:await page.evaluate(()=>JSON.stringify(App.msiUserWindow))};
    await openOptions(page);
    const initial=await dialogState(page),independent=initial.rows[0].group;
    assert.equal(initial.rows.length,6);assert.equal(initial.groups.length,0);
    assert.ok(initial.rows.every(row=>row.output&&row.group===independent),'Every section starts included and independent, including hidden Viewer sections');
    const groupA=await addGroup(page,'Control vs Treatment');
    for(const box of await page.locator('[data-report-select]').all())await box.uncheck();
    await page.locator('[data-report-select]').nth(0).check();await page.locator('[data-report-select]').nth(1).check();
    await page.locator('[data-report-bulk-group]').selectOption(groupA);await page.locator('[data-report-apply-group]').click();
    const groupB=await addGroup(page,'Second comparison');
    await page.locator('[data-report-group]').nth(3).selectOption(groupB);await page.locator('[data-report-group]').nth(4).selectOption(groupB);
    const temporary=await addGroup(page,'Delete this group');
    await page.locator('[data-report-group]').nth(2).selectOption(temporary);
    await page.locator('[data-report-group-id="'+temporary+'"] [data-report-delete-group]').click();
    assert.equal(await page.locator('[data-report-group]').nth(2).inputValue(),independent,'Deleting a comparison group returns its members to independent output');
    await page.locator('[data-report-output]').nth(5).uncheck();
    const chosen=await dialogState(page);
    assert.deepEqual(chosen.rows.map(row=>row.group),[groupA,groupA,independent,groupB,groupB,independent]);
    assert.ok((await page.locator('[data-report-summary]').innerText()).trim(),'The dialog presents an output summary');
    const grouped=await createDeck(page,true),included=setup.ids.slice(0,5);
    assert.deepEqual(grouped.report.sections.map(s=>s.sectionId||s.id),included);
    assert.equal(grouped.report.outputPlan.version,1);assert.equal(grouped.report.outputPlan.groups.length,3);
    assert.deepEqual(grouped.report.outputPlan.groups.filter(g=>g.kind==='compare').map(g=>g.sectionIds),[included.slice(0,2),included.slice(3)]);
    assertWindows(grouped.report,included,[24,24,36,60,60]);
    for(const label of ['Control vs Treatment','Second comparison','共通自動Range','独立・この切片の自動Range','Total signal ratio','Mean point ratio'])assert.ok(grouped.text.includes(label),label+' appears in the generated PowerPoint');
    for(const maximum of [24,36,60,20,30,50])assert.match(grouped.text,new RegExp('Range\\s*0\\s*[–-]\\s*'+maximum+'\\b'),'PowerPoint labels raw automatic ranges');
    assert.doesNotMatch(grouped.xml,/Excluded sample|Delete this group/);assert.match(grouped.text,/101 → 50/);assert.match(grouped.text,/101 → 51/);
    assert.match(grouped.text,/4 \/ 8/,'Paired original ROI counts survive grouped output');
    assert.doesNotMatch(grouped.text,/Colour level|Colour Level|Color level/,'Explicit groups do not present normalized percentage legends');
    await openOptions(page);assert.deepEqual(await dialogState(page),chosen,'Confirmed groups and exclusions are retained for the same loaded project');
    await page.locator('[data-report-group-id="'+groupA+'"] [data-report-group-name]').fill('Cancelled rename');
    await page.locator('[data-report-output]').nth(5).check();
    await page.locator('[data-report-cancel]').click();
    await openOptions(page);assert.deepEqual(await dialogState(page),chosen,'Cancel discards changes to the remembered output plan');
    await page.locator('[data-report-all-independent]').click();await page.locator('[data-report-output]').nth(5).check();
    assert.ok((await dialogState(page)).rows.every(row=>row.group===independent));
    const separate=await createDeck(page,false);
    assert.equal(separate.report.outputPlan.groups.length,6);assert.ok(separate.report.outputPlan.groups.every(g=>g.kind==='independent'&&g.sectionIds.length===1));
    assertWindows(separate.report,setup.ids,[12,24,36,48,60,72]);
    assert.doesNotMatch(separate.text,/共通自動Range/);assert.match(separate.text,/独立・この切片の自動Range/);assert.match(separate.text,/Excluded sample/);
    assert.deepEqual(await sourceSnapshot(page),before.sources,'Grouping and repeated exports preserve original bytes, numeric rasters, ROI values and geometry');
    assert.deepEqual(await ratioSnapshot(page,setup.key),before.ratios,'Grouping does not change ratio or ROI statistics');
    assert.equal(await page.evaluate(()=>JSON.stringify(App.project)),before.project,'Output plans do not mutate project metadata or saved ratio settings');
    assert.equal(await page.evaluate(()=>JSON.stringify(App.msiUserWindow)),before.windows,'Ignored manual Viewer ranges remain intact');
    assert.deepEqual(server.writes,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    await context.close();
    console.log('Project report groups browser: UI assignment/rename/delete/cancel, independent default, exclusion, grouped raw ranges, ratio ROI, strict MRM and source preservation PASS');
  }finally{await browser.close();await server.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
