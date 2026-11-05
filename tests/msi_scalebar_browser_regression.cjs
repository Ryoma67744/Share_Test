'use strict';

// The real SectionPanel DOM/sizing/scale bars and SharePreview renderer run in
// Chromium. A synthetic pixel canvas is painted using the real display matrix
// and frame painter; parsing and persistence use an anonymous in-memory fixture.
// No project, source file or network is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'viewer/index.html'), 'utf8');
function standalone(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Production helper exists: ' + name);
  return html.slice(start, html.indexOf('\n}', start) + 2);
}
function block(startText, endText) {
  const start = html.indexOf(startText);
  assert.ok(start >= 0, startText);
  const end = html.indexOf(endText, start);
  assert.ok(end > start, 'End of ' + startText);
  return html.slice(start, end + endText.length);
}
const helperStart = html.indexOf('function displayAffineMultiply(');
const helpers = html.slice(helperStart, html.indexOf('// ---- HE↔MSI registration math', helperStart));
const preview = block('const SharePreview = {', '\n};');
assert.ok(preview.includes('_syncCellScalebar('), 'Preview updates calibration without rebuilding every cell');
const source = [fs.readFileSync(path.join(root,'viewer/msi-ratio-model.js'),'utf8'),helpers, ...['isRatioDisplayKey','displayMsiEntry','displayMsiKeys','formatPixelPitchLabel', 'pickPreviewScalebarLength', 'msiSourceReference',
  'msiLayerSourceGeometry', 'openModal'].map(standalone),
  block('class SectionPanel {', '\n}'), preview,
  'const TestAppMethods = {' + block('    setFocusCompoundKey(', '\n    },') + '};',
  'const Wizards = {' + block('    async openMsiUmPxModal(', '\n    },') + '};',
  'Object.assign(window, {SectionPanel, SharePreview, Wizards});'].join('\n');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

async function main() {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1800, height:1000}});
    const errors = [], network = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:/, route => { network.push(route.request().url()); return route.abort(); });
    await page.setContent('<!doctype html><style>' + css + '</style>'
      + '<span id="tb-msi-um-group"><button id="tb-msi-um">Pitch</button></span>'
      + '<div id="sections-grid" style="width:1680px;height:660px"></div>'
      + '<div id="share-preview-overlay" style="position:relative;inset:auto;display:block;width:1680px;height:300px">'
      + '<div data-image-grid style="display:grid;height:260px;gap:18px"></div></div><div id="modal-host"></div>');
    await page.addScriptTag({content:fs.readFileSync(path.join(root, 'viewer/section-visibility.js'), 'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root, 'viewer/msi-display-geometry.js'), 'utf8')});
    await page.addScriptTag({content:source});
    await page.evaluate(() => {
      const key = 'MSI_synthetic', W = 80, H = 50;
      const rows = Array.from({length:W*H}, (_,i) => ({
        x:Math.round((i % W) * 0.027 * 100) / 100,
        y:Math.round(Math.floor(i / W) * 0.031 * 100) / 100,
        v:1 + (i * 7) % 83
      }));
      const geometry = {
        legacy:{W,H,confirmed:true,
          x:Array.from({length:W},(_,i)=>[Math.round(i*0.027*100)/100,i]),
          y:Array.from({length:H},(_,i)=>[Math.round(i*0.031*100)/100,i])},
        displayGeometry:{W,H,x:{step:0.027},y:{step:0.031}}
      };
      const sections = Array.from({length:6}, (_,i) => ({id:'synthetic-'+i,displayName:'Section '+(i+1),
        images:{},meta:{world_coords:{msi_um_per_px:{x:30,y:30}},viewerTransform:{rot:0,rotMSI:0,rotHE:0}},
        msiSeries:{[key]:{kind:'txt',blobId:'synthetic-source-'+i,rasterW:W,rasterH:H}},
        sourceRows:structuredClone(rows),rois:[{points:[[1,1],[5,1],[5,5]]}]
      }));
      const project = {id:'scalebar-synthetic-project',sections};
      const selected = new Set(sections.map(section=>section.id));
      window.App = {project,panels:new Map(),viewMode:'compound',focusCompoundKey:key,activeOverlay:null,
        thumbHeight:220,msiSmoothing:'none',activeSectionId:null,saveCount:0,
        getMsiDisplaySettings:()=>({aspectMode:window.physicalDisplay?'physical':'legacy'}),
        queueSave(){this.saveCount++;},sectionVisibility:()=>({ensure:()=>selected,save(){}}),setActiveSection(){}};
      App.setFocusCompoundKey=TestAppMethods.setFocusCompoundKey;
      window._refreshMethodRowState=()=>{};
      window.Toolbar = {refreshRotation(){},refreshAll(){}};
      window.get2dContext = (canvas,options) => canvas.getContext('2d',options);
      window.showToast = () => {};
      for (const section of sections) {
        const panel = Object.create(SectionPanel.prototype);
        Object.assign(panel,{section,project,imageSources:{[key]:{naturalWidth:W,naturalHeight:H,complete:true}},
          imageSettings:{},imageDataUrls:{},visibleLayers:new Set([key]),
          msiValueRasters:new Map([[key,{W,H,values:Float32Array.from(rows,row=>row.v),sourceGeometry:structuredClone(geometry)}]]),
          _scheduleRoiRedraw(){},_wireViewerHostInteractions(){},drawAllRois(){},
          renderComposite(){
            if(!this._testPixels) {
              this._testPixels=document.createElement('canvas');this._testPixels.width=W;this._testPixels.height=H;
              const ctx=this._testPixels.getContext('2d'),data=ctx.createImageData(W,H);
              for(let y=0;y<H;y++)for(let x=0;x<W;x++) {
                const n=4*(y*W+x),inside=Math.pow((x-39)/33,2)+Math.pow((y-24)/20,2)<1;
                if(inside)data.data.set([Math.round(255*x/W),Math.round(210*(1-x/W)),Math.round(100+120*y/H),255],n);
              }
              ctx.putImageData(data,0,0);
            }
            const ctx=this.dom.cdisp.getContext('2d');ctx.clearRect(0,0,this.dom.cdisp.width,this.dom.cdisp.height);
            const T=this._msiCanvasMatrix();ctx.save();ctx.transform(T[0][0],T[1][0],T[0][1],T[1][1],T[0][2],T[1][2]);ctx.imageSmoothingEnabled=false;
            if(this._displayCanvasFrame.msiDisplay)drawMsiFrameSource(ctx,this._testPixels,this._displayCanvasFrame.msiDisplay);
            else ctx.drawImage(this._testPixels,0,0);
            ctx.restore();
            this.updateScaleBar();
          }});
        App.panels.set(section.id,panel);
        panel.root=panel.buildDom();document.getElementById('sections-grid').appendChild(panel.root);
        panel.setupCanvasSize();
      }
      // All six columns now exist. Establish a shared initial fit instead of
      // preserving the temporary width of the first partially assembled grid.
      for (const panel of App.panels.values()) {
        panel._viewerFit=null;panel._ensureViewerTransform().scale=1;panel.setupCanvasSize();
      }
      SharePreview.overlay=document.getElementById('share-preview-overlay');
      SharePreview._cellTransforms={};SharePreview._sectionRotations={};
      SharePreview._renderImageGrid(project,key);
      window.fixture={key,W,H,rows,geometry,project,
        before:JSON.stringify(sections.map(section=>({rows:section.sourceRows,rois:section.rois,source:section.msiSeries}))),
        geometryBefore:JSON.stringify([...App.panels.values()].map(panel=>panel.msiValueRasters.get(key).sourceGeometry)),
        valuesBefore:JSON.stringify([...App.panels.values()].map(panel=>Array.from(panel.msiValueRasters.get(key).values)))};
      window.measureBars = () => {
        const number = label => Number.parseFloat(label) * (/\bmm\b/.test(label) ? 1000 : 1);
        const rect = el => {const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        return project.sections.map((section,index)=>{
          const panel=App.panels.get(section.id),bar=panel.dom.scalebar;
          const wrap=SharePreview.overlay.querySelector('[data-cell-idx="'+index+'"]');
          const previewBar=wrap.querySelector('[data-cell-scalebar]');
          const read=el=>el?{display:getComputedStyle(el).display,length:number(el.querySelector('.label').textContent),
            line:rect(el.querySelector('.bar')),box:rect(el)}:null;
          return {id:section.id,pitch:panel.dom.label.textContent,main:read(bar),preview:read(previewBar),
            cell:rect(panel.dom.canvasCell),host:rect(panel.dom.host),wrap:rect(wrap)};
        });
      };
    });
    await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const initial = await page.evaluate(() => measureBars());
    assert.equal(initial.length,6);
    for (const section of initial) {
      assert.match(section.pitch,/30×30 μm\/px/);
      for (const bar of [section.main,section.preview]) {
        assert.ok(bar && bar.display !== 'none' && bar.line.width > 0 && bar.length > 0,section.id);
      }
    }

    // Reproduce the old 240px cell / 320px host mismatch using real CSS and
    // ResizeObserver sizing. The entire ink and label must remain in its cell.
    for (const height of [520,460,400]) {
      await page.evaluate(height => {document.getElementById('sections-grid').style.height=height+'px';},height);
      await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      for (const row of await page.evaluate(() => measureBars())) {
        assert.ok(row.main.box.y>=row.cell.y-0.5 && row.main.box.bottom<=row.cell.bottom+0.5,
          'Main bar is not clipped at grid height '+height+': '+JSON.stringify(row));
      }
      if (height===460 && process.env.MSI_SCALEBAR_SCREENSHOT) {
        await page.screenshot({path:process.env.MSI_SCALEBAR_SCREENSHOT,fullPage:true});
      }
    }
    await page.evaluate(() => {document.getElementById('sections-grid').style.height='660px';});
    await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

    // Independent physical check: for a horizontal screen segment under a
    // rotation theta, source X/Y distances are cos(theta)/fit and sin(theta)/fit.
    for (const rotation of [0,90,37]) for (const zoom of [0.5,2]) {
      const actual = await page.evaluate(({rotation,zoom})=>{
        const section=fixture.project.sections[0],panel=App.panels.get(section.id);
        section.meta.world_coords.msi_um_per_px={x:30,y:60};
        const view=panel._ensureViewerTransform();view.rot=rotation;view.rotMSI=0;view.scale=1;
        panel.setupCanvasSize();view.scale=zoom;panel.applyViewerTransform();
        SharePreview._sectionRotations[section.id]=rotation;
        SharePreview._renderImageGrid(App.project,fixture.key);
        const t=SharePreview._cellTransforms[section.id];t.scale=zoom;t.tx=0;t.ty=0;delete t.viewport;
        SharePreview._applyCellTransform(0);
        const row=measureBars()[0],wrap=SharePreview.overlay.querySelector('[data-cell-idx="0"]'),img=wrap.querySelector('[data-cell-img]');
        const fit=Math.min(wrap.clientWidth/Number(img.dataset.natW),wrap.clientHeight/Number(img.dataset.natH));
        return {row,mainFit:parseFloat(panel.dom.cdisp.style.width)/panel.dom.cdisp.width,previewFit:fit};
      },{rotation,zoom});
      const angle=rotation*Math.PI/180,umPerSourcePixel=Math.hypot(Math.cos(angle)*30,Math.sin(angle)*60);
      for (const [bar,fit,label] of [[actual.row.main,actual.mainFit,'main'],[actual.row.preview,actual.previewFit,'Preview']]) {
        const expectedPixels=bar.length*fit*zoom/umPerSourcePixel;
        assert.ok(Math.abs(bar.line.width-expectedPixels)<0.15,
          `${label} ${rotation}deg zoom${zoom}: ${bar.line.width} != ${expectedPixels}`);
      }
    }

    // A cell created before calibration/loading must gain its bar without a
    // complete Preview rebuild. The DOM node stays the same across updates.
    const transitions = await page.evaluate(() => {
      const section=fixture.project.sections[5],panel=App.panels.get(section.id);
      panel.msiValueRasters.delete(fixture.key);delete panel.imageSources[fixture.key];
      SharePreview._loadingFocusKey=fixture.key;
      SharePreview._focusLoadStatus=new Map([[section.id,'loading']]);
      panel.updateScaleBar();SharePreview._renderImageGrid(App.project,fixture.key);
      const wrap=SharePreview.overlay.querySelector('[data-cell-idx="5"]'),bar=wrap.querySelector('[data-cell-scalebar]');
      const before={main:measureBars()[5].main.display,preview:bar&&getComputedStyle(bar).display,
        calibration:panel.dom.scalebar.dataset.calibrationStatus,
        mainMessage:panel.dom.scaleStatus.textContent,previewMessage:wrap.querySelector('[data-cell-scale-status]').textContent};
      panel.imageSources[fixture.key]={naturalWidth:fixture.W,naturalHeight:fixture.H,complete:true};
      panel.msiValueRasters.set(fixture.key,{W:fixture.W,H:fixture.H,values:Float32Array.from(fixture.rows,r=>r.v),sourceGeometry:structuredClone(fixture.geometry)});
      panel.setupCanvasSize();panel.refreshSectionLabel();
      SharePreview._focusLoadStatus.set(section.id,'ready');
      SharePreview._showLoadedPreviewCell(App.project,fixture.key,section.id);
      SharePreview._loadingFocusKey=null;SharePreview._focusLoadStatus=null;
      return {before,after:measureBars()[5],sameNode:bar===wrap.querySelector('[data-cell-scalebar]'),
        statusHidden:panel.dom.scaleStatus.hidden&&wrap.querySelector('[data-cell-scale-status]').hidden};
    });
    assert.equal(transitions.before.main,'none');assert.equal(transitions.before.preview,'none');
    assert.equal(transitions.before.calibration,'pending');
    assert.ok(transitions.before.mainMessage && transitions.before.previewMessage);
    assert.ok(transitions.sameNode);assert.notEqual(transitions.after.main.display,'none');assert.notEqual(transitions.after.preview.display,'none');
    assert.ok(transitions.statusHidden);

    const missing = await page.evaluate(() => {
      const section=fixture.project.sections[4],panel=App.panels.get(section.id);
      delete section.meta.world_coords.msi_um_per_px;
      panel.updateScaleBar();SharePreview._applyCellTransform(4);
      const wrap=SharePreview.overlay.querySelector('[data-cell-idx="4"]');
      const result={main:measureBars()[4].main.display,preview:measureBars()[4].preview.display,
        status:panel.dom.scalebar.dataset.calibrationStatus,
        mainMessage:panel.dom.scaleStatus.textContent,previewMessage:wrap.querySelector('[data-cell-scale-status]').textContent};
      section.meta.world_coords.msi_um_per_px={x:30,y:30};panel.updateScaleBar();SharePreview._applyCellTransform(4);
      return result;
    });
    assert.equal(missing.main,'none');assert.equal(missing.preview,'none');assert.equal(missing.status,'unknown');
    assert.ok(missing.mainMessage && missing.previewMessage,'Missing calibration is explained without inventing a scale');

    // Exercise the actual quick editor and modal click path, including the
    // Preview refresh and label update, without saving to a real database.
    const earlyFocus = await page.evaluate(async () => {
      window.editorPromise=Wizards.openMsiUmPxModal(App.panels.get(fixture.project.sections[0].id));
      document.querySelector('#modal-host [name="y"]').focus();
      await new Promise(resolve=>setTimeout(resolve,60));
      return document.activeElement.name;
    });
    assert.equal(earlyFocus,'y','Delayed initial focus must not steal a field already selected by the user');
    await page.locator('#modal-host [name="x"]').fill('45');
    await page.locator('#modal-host [name="y"]').fill('75');
    await page.locator('#modal-host [data-modal-ok]').click();
    const edited = await page.evaluate(async () => {
      await editorPromise;
      const section=fixture.project.sections[0],panel=App.panels.get(section.id),view=panel._ensureViewerTransform();
      const wrap=SharePreview.overlay.querySelector('[data-cell-idx="0"]'),img=wrap.querySelector('[data-cell-img]');
      return {pitch:section.meta.world_coords.msi_um_per_px,label:panel.dom.label.textContent,
        previewLabel:SharePreview.overlay.querySelector('.cell-title').textContent,bars:measureBars()[0],saved:App.saveCount,
        mainFit:parseFloat(panel.dom.cdisp.style.width)/panel.dom.cdisp.width,mainZoom:view.scale,mainAngle:view.rot,
        previewFit:Math.min(wrap.clientWidth/Number(img.dataset.natW),wrap.clientHeight/Number(img.dataset.natH)),
        previewZoom:SharePreview._cellTransforms[section.id].scale,previewAngle:SharePreview._sectionRotations[section.id]};
    });
    assert.deepEqual(edited.pitch,{x:45,y:75});assert.equal(edited.saved,1);
    assert.match(edited.label,/45×75 μm\/px/);assert.match(edited.previewLabel,/45×75 μm\/px/);
    assert.notEqual(edited.bars.main.display,'none');assert.notEqual(edited.bars.preview.display,'none');
    for (const [bar,fit,zoom,rotation] of [
      [edited.bars.main,edited.mainFit,edited.mainZoom,edited.mainAngle],
      [edited.bars.preview,edited.previewFit,edited.previewZoom,edited.previewAngle]]) {
      const angle=rotation*Math.PI/180,umPerPixel=Math.hypot(Math.cos(angle)*45,Math.sin(angle)*75);
      assert.ok(Math.abs(bar.line.width-bar.length*fit*zoom/umPerPixel)<0.15,'Saved pitch immediately changes the physical scale');
    }

    // Physical mode changes image geometry once, before rotation. Main/Preview
    // and the ROI inverse share that frame; legacy mode above stays unchanged.
    await page.evaluate(()=>{window.physicalDisplay=true;});
    for(const rotation of [0,90,37])for(const zoom of [0.5,2]) {
      const actual=await page.evaluate(({rotation,zoom})=>{
        const section=fixture.project.sections[0],panel=App.panels.get(section.id);
        section.meta.world_coords.msi_um_per_px={x:30,y:60};
        const view=panel._ensureViewerTransform();view.rot=rotation;view.rotMSI=0;view.scale=1;
        panel._viewerFit=null;panel.setupCanvasSize();view.scale=zoom;panel.applyViewerTransform();
        SharePreview._sectionRotations[section.id]=rotation;SharePreview._renderImageGrid(App.project,fixture.key);
        const viewport=SharePreview._cellTransforms[section.id];viewport.scale=zoom;viewport.tx=0;viewport.ty=0;delete viewport.viewport;
        SharePreview._applyCellTransform(0);
        const wrap=SharePreview.overlay.querySelector('[data-cell-idx="0"]'),img=wrap.querySelector('[data-cell-img]');
        const native=[12.25,23.75],canvas=applyAffinePoint(panel._msiRoiCanvasMatrix(),...native);
        const client=panel.canvasToClient(...canvas),backCanvas=panel.clientToCanvas(...client),back=panel.canvasToMsi(...backCanvas);
        return {row:measureBars()[0],physical:panel._displayCanvasFrame.msiDisplay.sourceBoundsUm,
          native,back,canvasWidth:panel.dom.cdisp.width,canvasHeight:panel.dom.cdisp.height,
          backing:panel._displayCanvasFrame.backingScale,
          mainFit:parseFloat(panel.dom.cdisp.style.width)/panel.dom.cdisp.width,
          previewFit:Math.min(wrap.clientWidth/Number(img.dataset.natW),wrap.clientHeight/Number(img.dataset.natH)),
          previewWidth:Number(img.dataset.natW),previewHeight:Number(img.dataset.natH)};
      },{rotation,zoom});
      assert.deepEqual(actual.physical,{x:0,y:0,width:2400,height:3000});
      actual.native.forEach((value,i)=>assert.ok(Math.abs(actual.back[i]-value)<1e-8,'Physical ROI client inverse preserves sample centres'));
      if(rotation===0){assert.equal(actual.previewWidth,80);assert.equal(actual.previewHeight,100);}
      for(const [bar,fit] of [[actual.row.main,actual.mainFit],[actual.row.preview,actual.previewFit]]) {
        const expected=bar.length*fit*zoom*actual.backing/30;
        assert.ok(Math.abs(bar.line.width-expected)<0.15,`Physical bar ${rotation} degrees: ${bar.line.width} != ${expected}`);
      }
    }
    const switched=await page.evaluate(()=>{
      const section=fixture.project.sections[0],panel=App.panels.get(section.id),key='MSI_other_source';
      section.msiSeries[key]={kind:'txt',blobId:'other-source',rasterW:24,rasterH:7};
      App.setFocusCompoundKey(key);
      const before={key:panel._pickRefMsiKey(),physical:!!panel._displayCanvasFrame.msiDisplay,
        calibration:resolveMsiPhysicalCalibration(section,key).status};
      panel.imageSources[key]={naturalWidth:24,naturalHeight:7,complete:true};
      panel.msiValueRasters.set(key,{W:24,H:7,values:new Float32Array(24*7),sourceGeometry:{legacy:{W:12,H:7},displayGeometry:{W:24,H:7}}});
      App.setFocusCompoundKey(key);
      const frame=panel._displayCanvasFrame.msiDisplay;
      const after={key:panel._pickRefMsiKey(),bounds:frame.sourceBoundsUm,pitch:frame.displayPitch};
      App.setFocusCompoundKey(fixture.key);
      const restored=panel._displayCanvasFrame.msiDisplay.sourceBoundsUm;
      delete section.msiSeries[key];delete panel.imageSources[key];panel.msiValueRasters.delete(key);
      return {before,after,restored};
    });
    assert.deepEqual(switched.before,{key:'MSI_other_source',physical:false,calibration:'pending'});
    assert.deepEqual(switched.after.bounds,{x:0,y:0,width:360,height:420});
    assert.equal(switched.after.key,'MSI_other_source');assert.ok(Math.abs(switched.after.pitch.x-30*11/23)<1e-12);
    assert.deepEqual(switched.restored,{x:0,y:0,width:2400,height:3000},'Actual focus selection updates and restores the acquisition frame');
    if(process.env.MSI_PHYSICAL_SCREENSHOT) {
      await page.evaluate(()=>{
        for(const section of fixture.project.sections) {
          section.meta.world_coords.msi_um_per_px={x:30,y:60};
          const p=App.panels.get(section.id),v=p._ensureViewerTransform();v.rot=0;v.rotMSI=0;v.scale=1;v.tx=0;v.ty=0;p._viewerFit=null;p.setupCanvasSize();p.refreshSectionLabel();
          SharePreview._sectionRotations[section.id]=0;SharePreview._cellTransforms[section.id]={tx:0,ty:0,scale:1};
        }
        SharePreview._renderImageGrid(App.project,fixture.key);
        fixture.project.sections.forEach((section,i)=>{SharePreview._cellTransforms[section.id]={tx:0,ty:0,scale:1};SharePreview._applyCellTransform(i);});
      });
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.screenshot({path:process.env.MSI_PHYSICAL_SCREENSHOT,fullPage:true});
    }
    // Physical layout is recomputed after a real pitch edit, not just its bar.
    await page.evaluate(()=>{window.editorPromise=Wizards.openMsiUmPxModal(App.panels.get(fixture.project.sections[0].id));});
    await page.locator('#modal-host [name="x"]').fill('60');await page.locator('#modal-host [name="y"]').fill('30');
    await page.locator('#modal-host [data-modal-ok]').click();
    const physicalEdit=await page.evaluate(async()=>{await editorPromise;const p=App.panels.get(fixture.project.sections[0].id);
      return {bounds:p._displayCanvasFrame.msiDisplay.sourceBoundsUm,matrix:p._displayCanvasFrame.msiDisplay.rasterToFrame};});
    assert.deepEqual(physicalEdit.bounds,{x:0,y:0,width:4800,height:1500});
    assert.deepEqual(physicalEdit.matrix,[[2,0,0],[0,1,0],[0,0,1]]);
    await page.evaluate(() => {document.body.classList.add('share-mode');});
    assert.equal(await page.locator('#tb-msi-um-group').isVisible(),false,'Shared pitch editing remains hidden');
    for (const row of await page.evaluate(() => measureBars())) {
      assert.notEqual(row.main.display,'none');assert.notEqual(row.preview.display,'none');
    }
    const unchanged = await page.evaluate(() => ({
      rows:fixture.before===JSON.stringify(fixture.project.sections.map(section=>({rows:section.sourceRows,rois:section.rois,source:section.msiSeries}))),
      geometry:fixture.geometryBefore===JSON.stringify([...App.panels.values()].map(panel=>panel.msiValueRasters.get(fixture.key).sourceGeometry)),
      values:fixture.valuesBefore===JSON.stringify([...App.panels.values()].map(panel=>Array.from(panel.msiValueRasters.get(fixture.key).values)))
    }));
    assert.deepEqual(unchanged,{rows:true,geometry:true,values:true});
    assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
    console.log('MSI scale bar browser regression: PASS (six sections, rounded coordinates, small hosts, physical/legacy bounds, ROI client inverse, late calibration, quick editor, source preservation)');
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
