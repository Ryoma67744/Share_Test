// Reproduce the approved measured-brain Help example from local, read-only inputs.
// RAW/metadata are deliberately not checked in or fetched over the network.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const filename=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(filename),'..');
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
if(args.includes('--help')||!option('--source')||!option('--metadata')) {
  console.log('node tools/help-brain-example.mjs --source LOCAL_RAW_ZIP --metadata LOCAL_PROJECT_JSON [--out DIRECTORY] [--render-only]');
  if(!args.includes('--help'))process.exitCode=1;
} else await main();

async function main() {
  const req=createRequire(path.join(root,'tests/package.json'));
  const {createCanvas,loadImage}=req('@napi-rs/canvas');
  const Data=req(path.join(root,'viewer/project-report-data.js'));
  const Display=req(path.join(root,'viewer/msi-display-settings.js'));
  const Core=req(path.join(root,'viewer/msi-ratio-core.js'));
  const viewer=req(path.join(root,'tests/viewer-runtime.cjs')).runtime();
  const {rawBundleFromZip,rawDecodeFunction,rawRowsFromDecoded}=await import(pathToFileURL(path.join(root,'connector/src/raw.js')));
  const {buildMsiGrid}=await import(pathToFileURL(path.join(root,'connector/src/msi.js')));
  const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
  const sourcePath=path.resolve(option('--source')),metadataPath=path.resolve(option('--metadata'));
  const out=option('--out')?path.resolve(option('--out')):path.join(root,'docs/help/images');
  const provenancePath=option('--out')?path.join(out,'brain-example-provenance.json'):path.join(root,'docs/help/brain-example-provenance.json');
  const source=await fs.readFile(sourcePath),metadata=await fs.readFile(metadataPath);
  const sourceHash=sha(source),metadataHash=sha(metadata);
  assert.equal(sourceHash,'5e4c177c74c2cde79f6c97eb1e80e4657ad61e1af67e3b1e3116cdd405caac97','Use the original RAW ZIP approved for this Help example');
  const doc=JSON.parse(metadata.toString('utf8').replace(/^\uFEFF/,''));
  const section=doc.sections.find(s=>s.id==='3040f31a-45d2-45b1-aafc-cf2f4c4bc401');assert.ok(section,'The approved section must be present');
  const xKey='MSI_Malate-1',yKey='MSI_Glutamate',xDef=section.storage_paths.msiSeries[xKey],yDef=section.storage_paths.msiSeries[yKey];
  assert.equal(xDef.path,yDef.path);assert.equal(xDef.func,1);assert.equal(yDef.func,1);assert.equal(xDef.channel,6);assert.equal(yDef.channel,8);
  const decoded=await rawDecodeFunction(rawBundleFromZip(source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength)),1);
  const xRows=rawRowsFromDecoded(decoded,xDef),yRows=rawRowsFromDecoded(decoded,yDef),rowsHash=sha(JSON.stringify([xRows,yRows]));
  const sourceFrame=sourceHash+'|raw|function:1|native-aim-xy-mm';
  const input=rows=>({sourceFrame,positions:rows.map(r=>({x:r.x,y:r.y})),rowIds:rows.map(r=>r.rowId),values:Float64Array.from(rows,r=>r.v),sourceCells:rows.map(r=>r.sourceCells)});
  const X=input(xRows),Y=input(yRows),grid=buildMsiGrid(xRows),{W,H}=grid;
  assert.equal(W,219);assert.equal(H,166);assert.equal(X.values.length,36354);assert.equal(new Set(X.positions.map(p=>p.x+'|'+p.y)).size,36354);
  const transform=JSON.parse(JSON.stringify(viewer.sectionLayerViewLinear(section,'msi'))),pitch=section.meta.world_coords.msi_um_per_px;
  assert.deepEqual(transform,[[1,0,0],[0,1,0],[0,0,1]]);assert.deepEqual(pitch,{x:30,y:30});
  const lut=Display.hotMetalLut(),crop={x:45,y:40,width:90,height:75};
  function statistics(values) {
    const finite=Array.from(values).filter(Number.isFinite),sum=finite.reduce((a,v)=>a+v,0);
    return {n:values.length,nFinite:finite.length,nZero:finite.filter(v=>v===0).length,sum,mean:sum/finite.length,min:Math.min(...finite),max:Math.max(...finite),p99_5:Data.percentile(finite,99.5)};
  }
  const xStats=statistics(X.values),yStats=statistics(Y.values);
  assert.equal(xStats.max,1026290);assert.ok(Math.abs(xStats.p99_5-448206.855)<1e-6);assert.ok(Math.abs(yStats.p99_5-1116827.345)<1e-6);
  function raster(values,valid) {
    const v=new Float64Array(W*H).fill(NaN),count=new Uint32Array(v.length),mask=new Uint8Array(v.length);
    for(let i=0;i<values.length;i++) {
      if(!Number.isFinite(values[i])||(valid&&!valid[i]))continue;
      const p=X.positions[i],x=grid.xIndex.get(p.x),y=grid.yIndex.get(p.y);if(x==null||y==null)continue;
      const k=y*W+x;v[k]=(count[k]?v[k]:0)+values[i];count[k]++;mask[k]=1;
    }
    for(let i=0;i<v.length;i++)if(count[i])v[i]/=count[i];
    return {W,H,values:v,measuredMask:mask};
  }
  const report={format:1,synthetic:false,source:{sha256:sourceHash,metadataSha256:metadataHash,
    slug:'261030_hirabayashi_13c_brain',sectionId:section.id,section:section.display_name},
    sourceVersion:(await fs.readFile(path.join(root,'version.js'),'utf8')).match(/v\d{4}-\d{2}-\d{2}\.\d+/)?.[0],
    generatorSha256:sha(await fs.readFile(filename)),geometry:{W,H,displayGeometry:grid.displayGeometry,orientation:transform,pixelPitchUm:pitch,detailRect:crop},
    inputs:{numerator:{key:xKey,precursor:133.101,product:115,function:1,channel:6},denominator:{key:yKey,precursor:146,product:102,function:1,channel:8}},
    rawStatistics:{numerator:xStats,denominator:yStats},settings:{colormap:'hotmetal',lutAPI:'MsiDisplaySettings.hotMetalLut(256)',lutSha256:sha(JSON.stringify(lut)),
      rangeBasis:'Finite original measurements. Range only changes colour mapping; above-range values saturate without altering measurements.',
      median:'Level 3: radius 3, up to 7x7 valid raster neighbours; median of 8-bit display intensity indices, not original signals.',
      linear:'Level 10: full bilinear RGB interpolation in the report renderer; native browser Canvas can differ slightly.',
      detail:'Same source rectangle in all detail images. Median calculated over the full source raster before display crop.',
      ratio:'Original scan-row X/Y division; finite X >= 0 and finite Y > threshold. Invalid ratios excluded, never replaced by zero.',
      ratioInvalidColor:[66,76,90],noTissueMask:true,sourceRowsUnmodified:true},rois:[],ratioStatistics:[],assets:[]};
  const sourceFiles=['version.js','viewer/index.html','viewer/project-report-data.js','viewer/msi-smoothing.js','viewer/msi-display-settings.js','viewer/msi-ratio-core.js','viewer/msi-ratio-app.js','connector/src/raw.js','connector/src/msi.js','connector/src/source-cells.js','tools/help-capture.cjs'];
  report.sourceFilesSha256=Object.fromEntries(await Promise.all(sourceFiles.map(async p=>[p,sha(await fs.readFile(path.join(root,p)))])));
  await fs.mkdir(out,{recursive:true});
  async function save(id,buffer,width,height,kind,settings={}) {
    await fs.writeFile(path.join(out,id+'.png'),buffer);
    report.assets.push({id,path:'docs/help/images/'+id+'.png',sha256:sha(buffer),kind,width,height,...settings});
  }
  async function render(id,r,upper,options={}) {
    const before=sha(Buffer.concat([Buffer.from(r.values.buffer),Buffer.from(r.measuredMask.buffer)]));
    const displayStyle={lut,colormap:'hotmetal',smoothing:options.smoothing||'none',smoothingStrength:3,linearStrength:10,background:options.background||[0,0,0]};
    const result=await Data.render(r,upper,{createCanvas,maxDimension:1000,nearestUpscale:true,transform,pixelPitch:pitch,displayStyle,displayWindow:{min:0,max:upper},...(options.detail?{frame:{bounds:crop}}:{})});
    assert.equal(sha(Buffer.concat([Buffer.from(r.values.buffer),Buffer.from(r.measuredMask.buffer)])),before,'Rendering must preserve source raster/mask');
    const bytes=Buffer.from(result.data.split(',')[1],'base64');
    await save(id,bytes,result.width,result.height,'measured-render',{displayRange:[0,upper],smoothing:displayStyle.smoothing,
      ...(options.smoothing==='median'?{strength:3}:options.smoothing==='linear'?{strength:10}:{}),...(options.detail?{detailRect:crop}:{}),...(options.threshold!=null?{denominatorMin:options.threshold}:{})});
    return bytes;
  }
  const xr=raster(X.values),yr=raster(Y.values);
  const malate=await render('brain-malate',xr,xStats.p99_5);
  await render('brain-glutamate',yr,yStats.p99_5);await render('brain-range-max',xr,xStats.max);
  await render('brain-detail-none',xr,xStats.p99_5,{detail:true});
  await render('brain-detail-linear',xr,xStats.p99_5,{detail:true,smoothing:'linear'});
  await render('brain-detail-median',xr,xStats.p99_5,{detail:true,smoothing:'median'});
  const base=await loadImage(malate),scale=base.width/W;
  const locator=createCanvas(base.width,base.height),lc=locator.getContext('2d');lc.drawImage(base,0,0);lc.strokeStyle='#fff';lc.lineWidth=3;lc.setLineDash([10,6]);lc.strokeRect(crop.x*scale,crop.y*scale,crop.width*scale,crop.height*scale);
  await save('brain-detail-locator',locator.toBuffer('image/png'),base.width,base.height,'measured-render',{annotation:'White dashed rectangle marks the common detail rectangle',detailRect:crop});
  const ratios=new Map();
  for(const threshold of [0,10000]) {
    const result=Core.calculate(X,Y,{denominatorMin:threshold});assert.equal(result.status,'ready');assert.equal(result.joinMethod,'source-row-id');
    assert.equal(result.summary.nValid,threshold?23512:35267);ratios.set(threshold,result);
    report.ratioStatistics.push({denominatorMin:threshold,summary:result.summary,clippedAbove1_5:Array.from(result.values).filter(v=>v>1.5).length,
      thresholdPurpose:threshold?'Illustrative setting only; not a validated detection limit':'Exclude zero denominator'});
    await render(threshold?'brain-ratio-threshold':'brain-ratio-zero',raster(result.values,result.valid),1.5,{background:[66,76,90],threshold});
  }
  const roiDefs=[{id:'illustration-A',label:'ROI A',color:'#00edff',gridRect:{x:28,y:82,width:30,height:25}},
    {id:'illustration-B',label:'ROI B',color:'#66ff76',gridRect:{x:117,y:80,width:30,height:25}}];
  const roiCanvas=createCanvas(base.width,base.height),rc=roiCanvas.getContext('2d');rc.drawImage(base,0,0);
  for(const roi of roiDefs) {
    const r=roi.gridRect,g=grid.displayGeometry;
    const bounds={minX:g.x.origin+(r.x-0.5)*g.x.step,maxX:g.x.origin+(r.x+r.width-0.5)*g.x.step,minY:g.y.origin+(r.y-0.5)*g.y.step,maxY:g.y.origin+(r.y+r.height-0.5)*g.y.step};
    const inside=(x,y)=>x>=bounds.minX&&x<bounds.maxX&&y>=bounds.minY&&y<bounds.maxY;
    const selected=xRows.filter(row=>inside(row.x,row.y));assert.equal(selected.length,750);
    const st=statistics(selected.map(row=>row.v));assert.ok(Math.abs(st.mean-(roi.id==='illustration-A'?307293.12616666665:177911.66750911457))<0.01);
    report.rois.push({...roi,sourceBounds:bounds,numeratorStatistics:st,temporary:true,anatomicalInterpretation:false,
      ratioStatistics:[0,10000].map(t=>({denominatorMin:t,summary:Core.summarize(ratios.get(t),inside)}))});
    rc.strokeStyle=roi.color;rc.lineWidth=4;rc.strokeRect(r.x*scale,r.y*scale,r.width*scale,r.height*scale);rc.font='bold 36px Arial';rc.fillStyle=roi.color;rc.fillText(roi.label,r.x*scale,r.y*scale-10);
  }
  await save('brain-roi',roiCanvas.toBuffer('image/png'),base.width,base.height,'measured-render',{annotation:'Temporary ROI outlines and ROI A/B labels; no saved project ROI',displayRange:[0,xStats.p99_5],smoothing:'none'});
  const colorbar=createCanvas(256,12),bc=colorbar.getContext('2d');for(let i=0;i<lut.length;i++){bc.fillStyle='rgb('+lut[i].join(',')+')';bc.fillRect(i,0,1,12);}
  await save('brain-colorbar',colorbar.toBuffer('image/png'),256,12,'legend',{colormap:'hotmetal'});
  if(!args.includes('--render-only'))await capture();
  assert.equal(sha(JSON.stringify([xRows,yRows])),rowsHash);assert.equal(sha(await fs.readFile(sourcePath)),sourceHash);assert.equal(sha(await fs.readFile(metadataPath)),metadataHash);
  report.validation={sourceUnchanged:true,metadataUnchanged:true,sourceRowsUnchanged:true,sourceRasterAndMaskUnchanged:true,expectedCountsVerified:true};
  await fs.writeFile(provenancePath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({provenance:provenancePath,assets:report.assets.map(a=>({id:a.id,width:a.width,height:a.height,kind:a.kind}))}));

  async function capture() {
    const {chromium}=req('playwright'),JSZip=req(path.join(root,'vendor/jszip.min.js'));
    const {startServer,prepare}=req(path.join(root,'tools/help-capture.cjs'));
    const sourceZipPath='Source/Help-Brain-Negative.raw.zip',originalSeries={};
    for(const [key,d] of [[xKey,xDef],[yKey,yDef]]) {
      originalSeries[key]={kind:'raw',func:d.func,channel:d.channel,rasterW:d.rasterW,rasterH:d.rasterH,sourcePath:sourceZipPath,
        filename:'Help-Brain-Negative.raw.zip',sourceFileId:'help-brain-source',quantVersion:d.quantVersion,
        rawMean:d.rawMean,rawTrueMax:d.rawTrueMax,sourceStats:{n:d.sourceStats.n,mean:d.sourceStats.mean,max:d.sourceStats.max},
        compoundMeta:{base:d.compoundMeta.base,precursor:d.compoundMeta.precursor,product:d.compoundMeta.product}};
    }
    const localSection={id:'help-brain-section',ordinal:1,displayName:section.display_name,
      meta:{world_coords:{msi_um_per_px:pitch},displayTransform:{version:2,baseOrientation:'native-raster'}},images:{},data:[],originalSeries,
      msiFilesMeta:{'help-brain-source':{kind:'raw',filename:'Help-Brain-Negative.raw.zip',sourcePath:sourceZipPath}}};
    const fixture={format:'desi_data_share_v2',id:'help-brain-example-local',displayName:'Brain Help example — measured data',sourceContract:'msi-source-rows-v1',
      sectionOrder:[localSection.id],roiHidden:{},memo:{sample:'Brain / 脳',free:'Help example: isolated local copy of original measurements.'},
      meta:{colormap:'hotmetal',msiSmoothing:'none',msiDisplay:{version:2,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum',smoothingStrength:1,linearStrength:10}},
      rois:[],roiMedia:{version:1,items:[]},sections:[localSection]};
    const archive=new JSZip();archive.file(sourceZipPath,source);archive.file('HelpBrain.json',JSON.stringify(fixture));const buffer=await archive.generateAsync({type:'nodebuffer'});
    const {server,origin}=await startServer();let browser;
    try {
      browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
      const viewport={width:1600,height:1000},context=await browser.newContext({viewport,deviceScaleFactor:1}),blocked=[],errors=[];
      await context.route('**/*',route=>{const request=route.request(),url=request.url();
        if((url.startsWith(origin+'/')&&['GET','HEAD'].includes(request.method()))||/^(blob|data):/.test(url))return route.continue();
        blocked.push({external:!url.startsWith(origin+'/'),method:request.method()});return route.abort();});
      const page=await context.newPage();page.on('dialog',d=>d.accept());page.on('pageerror',e=>errors.push(e.message));
      await page.goto(origin+'/viewer/?project=help-empty');await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
      await page.locator('#hidden-import-input').setInputFiles({name:'Help-brain-example.zip',mimeType:'application/zip',buffer});
      await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();await prepare(page);
      await page.evaluate(async()=>{App.setFocusCompoundKey('MSI_Malate-1');await App.setMsiDisplayPreset('hdi');await App.setMsiOutlierClipAll(false,{preserveDisplaySettings:true});});
      await page.locator('#tb-range-min').fill('0');await page.locator('#tb-range-min').dispatchEvent('change');
      // Keep the current app's narrow number field legible in the screenshot.
      // The scientific figures above retain the full percentile precision.
      await page.locator('#tb-range-max').fill(xStats.p99_5.toFixed(2));await page.locator('#tb-range-max').dispatchEvent('change');
      await page.locator('#tb-range-max').blur();
      async function shot(id,scenario) {
        await page.waitForFunction(()=>!document.querySelector('#toast-host .toast'),{},{timeout:30000});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await save(id,await page.screenshot(),viewport.width,viewport.height,'measured-screenshot',{scenario,viewport,deviceScaleFactor:1,role:'local author',mode:'offline'});
      }
      const loaded=await page.evaluate(()=>{const p=App.panels.get(App.project.sections[0].id),r=p.msiValueRasters.get('MSI_Malate-1');return {W:r.W,H:r.H,n:[...r.values].filter(Number.isFinite).length,max:Math.max(...r.values)};});
      assert.deepEqual(loaded,{W:219,H:166,n:36354,max:1026290});
      await shot('brain-viewer','Actual current Viewer with original Malate-1/Glutamate, HotMetal, None, Malate-1 Range 0..448206.86 (rounded p99.5)');
      await page.locator('#btn-msi-ratio').click();const dialog=page.locator('#msi-ratio-dialog');await dialog.waitFor();
      await dialog.locator('[data-ratio-name]').fill('Malate-1 / Glutamate');await dialog.locator('[data-ratio-x]').selectOption(xKey);await dialog.locator('[data-ratio-y]').selectOption(yKey);
      await dialog.locator('[data-ratio-threshold]').fill('10000');await dialog.locator('[data-ratio-apply]').click();
      await dialog.locator('[data-ratio-results] tbody tr').first().waitFor();
      const calculated=await page.evaluate(async()=>{const d=App.getRatioDefinitions()[0],r=await App.resolveRatio(App.project.sections[0],'MSI_RATIO_'+d.id);return {threshold:d.denominatorMin,nValid:r.summary.nValid,nCandidate:r.summary.nCandidate};});
      assert.equal(calculated.threshold,10000);assert.equal(calculated.nValid,23512);assert.equal(calculated.nCandidate,36354);
      await dialog.getByRole('button',{name:'閉じる',exact:true}).click();
      await page.locator('#tb-range-max').fill('1.5');await page.locator('#tb-range-max').dispatchEvent('change');await page.locator('#tb-range-max').blur();
      await page.evaluate(()=>App.openRatioDialog('MSI_RATIO_'+App.getRatioDefinitions()[0].id));
      await page.locator('#msi-ratio-dialog [data-ratio-summary]').click();
      await page.locator('#msi-ratio-dialog [data-ratio-results] tbody tr').first().waitFor();
      await shot('brain-ratio-settings','Actual saved Malate-1 / Glutamate dialog, denominator > 10000, calculated from original RAW measurements');
      assert.deepEqual(errors,[],'No application page errors during capture');
      report.capture={browser:browser.version(),viewport,sourceFixtureSha256:sha(JSON.stringify(fixture)),localOnly:true,blockedRequestCount:blocked.length,
        numericalRasterVerified:loaded,ratioVerified:calculated,pageErrors:errors};
    } finally {
      if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    }
  }
}
