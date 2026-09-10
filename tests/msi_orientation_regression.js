'use strict';
// Scientific display-coordinate regression: non-square asymmetric landmarks,
// actual main renderer/ROI paths, inverse clicks, all turns/flips, physical pitch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
const helpers = html.slice(html.indexOf('function displayAffineMultiply('), html.indexOf('// ---- HE↔MSI registration math'));
const classStart = html.indexOf('class SectionPanel {');
const classEnd = html.indexOf('\n}\n', classStart) + 2;
const identity = () => [[1,0,0],[0,1,0],[0,0,1]];
const mul = (a,b) => a.map((r,i) => r.map((_,j) => a[i][0]*b[0][j]+a[i][1]*b[1][j]+a[i][2]*b[2][j]));
const point = (t,p) => [t[0][0]*p[0]+t[0][1]*p[1]+t[0][2], t[1][0]*p[0]+t[1][1]*p[1]+t[1][2]];
const turn = (p,deg) => { const r=deg*Math.PI/180; return [Math.cos(r)*p[0]-Math.sin(r)*p[1],Math.sin(r)*p[0]+Math.cos(r)*p[1]]; };
const close = (a,b,msg='') => { assert.equal(a.length,b.length); a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-9,`${msg}: ${a} != ${b}`)); };
class Context2D {
  constructor(canvas){this.canvas=canvas;this.matrix=identity();this.stack=[];this.draws=[];this.paths=[];}
  save(){this.stack.push(this.matrix.map(r=>r.slice()));} restore(){this.matrix=this.stack.pop();}
  transform(a,b,c,d,x,y){this.matrix=mul(this.matrix,[[a,c,x],[b,d,y],[0,0,1]]);}
  setTransform(a,b,c,d,x,y){this.matrix=[[a,c,x],[b,d,y],[0,0,1]];}
  translate(x,y){this.transform(1,0,0,1,x,y);} rotate(r){this.transform(Math.cos(r),Math.sin(r),-Math.sin(r),Math.cos(r),0,0);}
  scale(x,y){this.transform(x,0,0,y,0,0);}
  drawImage(src,...args){this.draws.push({matrix:this.matrix.map(r=>r.slice()),src,args});}
  getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4)};} putImageData(){} clearRect(){} fillRect(){}
  beginPath(){this.path=[];} moveTo(x,y){this.path.push(point(this.matrix,[x,y]));} lineTo(x,y){this.path.push(point(this.matrix,[x,y]));}
  closePath(){} stroke(){this.paths.push(this.path);} setLineDash(){} arc(){} fill(){} clip(p){this.clipped=p;}
}
function canvas(w=0,h=0){const c={width:w,height:h,style:{},classList:{toggle(){}},toDataURL(){return 'mock';}};c.ctx=new Context2D(c);return c;}
const context=vm.createContext({console,Math,Number,Map,Set,JSON,Uint8ClampedArray,
  document:{createElement:()=>canvas(),getElementById:()=>null},get2dContext:c=>c.ctx,
  App:{viewMode:'free',roiOnlyMode:false,msiSmoothing:'none',drawing:{mode:false},getMsiWindow:()=>({min:0,max:1})},
  getActiveColormap:()=>Array.from({length:256},()=>[0,0,0]),getColormapBackground:()=>[0,0,0],
  otsuKeepGridForLayer:()=>null,identStamp:()=>'',_activeColormapName:'test',MSI_LUT_CACHE_MAX:4,msiRawFallbackMax:()=>1,
  Path2D:class {constructor(){this.points=[];}moveTo(x,y){this.points.push([x,y]);}lineTo(x,y){this.points.push([x,y]);}closePath(){}},
});
vm.runInContext(helpers+'\n'+html.slice(classStart,classEnd)+'\nglobalThis.Panel=SectionPanel;',context);
const {sectionCanvasFrame,sectionMsiCanvasMatrix,sectionLayerViewLinear,displayBakeGeometry,
  bakeSectionTransformPoint,unbakeSectionTransformPoint,toggleSectionScreenFlip,sectionCanvasMirror,
  displayHorizontalUmPerPixel,displayAffineMultiply,displayRotation,previewMsiUmPerCanvasPixel}=context;
function panelFor(sec,W=7,H=3,includeHe=false){
  const panel=Object.create(context.Panel.prototype);
  const frame=sectionCanvasFrame(sec,H*2,W*2,includeHe);
  Object.assign(panel,{section:sec,project:{rois:[]},_displayCanvasFrame:frame,
    dom:{cdisp:canvas(frame.width,frame.height),croi:canvas(frame.width,frame.height)},
    imageSources:{MSI_a:{complete:true,naturalWidth:W,naturalHeight:H}},imageSettings:{MSI_a:{opacity:1}},
    visibleLayers:new Set(['MSI_a']),msiValueRasters:new Map(),
    _maybeWarnRasterDimMismatch(){},_ensureDrawableLoaded(){},_resolveTHeToMsi(){return null;},
    registeredMsiKeys(){return ['MSI_a'];},getMsiRefSize(){return {w:W,h:H};},_pickRefMsiKey(){return 'MSI_a';},updateScaleBar(){},
  });
  panel.displayCtx=panel.dom.cdisp.ctx;panel.roiCtx=panel.dom.croi.ctx;
  return panel;
}
const landmarks=[[0,0],[7,0],[0,3],[7,3],[.4,.8],[6.1,2.6],[2.2,1.1]];
let cases=0;
for(const rot of [0,90,180,270,37])for(const msi of [0,90,180,270,-23])for(const lr of [false,true])for(const ud of [false,true]){
  const sec={id:'s',meta:{viewerTransform:{rot,rotMSI:msi,rotHE:-41,scale:1},flip:{lr,ud}},msiSeries:{MSI_a:{}}};
  const p=panelFor(sec); p.renderComposite();
  const actual=p.displayCtx.draws.at(-1).matrix;
  const expectedCanvas=sectionMsiCanvasMatrix(sec,7,3,p._displayCanvasFrame,'msi');
  for(const raw of landmarks){
    close(point(actual,raw),point(expectedCanvas,raw),'renderer shared matrix');
    close(p.canvasToMsi(...point(actual,[raw[0]+0.5,raw[1]+0.5])),raw,'ROI sample-centre inverse');
    let expected=turn([raw[0]-3.5,raw[1]-1.5],-90);
    expected=turn(expected,msi);expected=[lr?-expected[0]:expected[0],ud?-expected[1]:expected[1]];expected=turn(expected,rot-90);
    const L=sectionLayerViewLinear(sec,'msi');close(point(L,[raw[0]-3.5,raw[1]-1.5]),expected,'legacy chain retained');
    const baked=bakeSectionTransformPoint(...raw,7,3,L);
    close(unbakeSectionTransformPoint(...baked,7,3,L),raw,'thumbnail/Align inverse');
    const thumb=displayBakeGeometry(7,3,L);close([baked[0]-thumb.width/2,baked[1]-thumb.height/2],expected,'thumbnail landmarks');
    const main=point(actual,raw), centered=[(main[0]-p.dom.cdisp.width/2)/2,(main[1]-p.dom.cdisp.height/2)/2];
    close(turn(centered,rot-90),expected,'main = thumbnail = Align = unsaved Preview');
    assert.ok(main[0]>=-1e-9&&main[0]<=p.dom.cdisp.width+1e-9&&main[1]>=-1e-9&&main[1]<=p.dom.cdisp.height+1e-9,'all corners fit backing canvas');
  }
  p.project.rois=[{id:'r',polysBySection:{s:landmarks.slice(4)}}];p.drawAllRois();
  p.roiCtx.paths[0].forEach((pt,i)=>close(pt,point(actual,landmarks[i+4].map(v=>v+0.5)),'ROI outlines follow rotMSI'));
  context.App.roiOnlyMode=true;p.renderComposite();context.App.roiOnlyMode=false;
  p.displayCtx.clipped.points.forEach((pt,i)=>close(pt,point(actual,landmarks[i+4].map(v=>v+0.5)),'ROI-only clip follows actual image'));
  cases++;
}
// Buttons are screen-axis actions even after mixed arbitrary rotations. A
// serialized/reloaded v2 transform is idempotent; old ROI/T/flip remain intact.
for(const rot of [0,90,180,270,37])for(const axis of ['lr','ud']){
  const sec={id:'s',meta:{flip:{lr:true,ud:false},viewerTransform:{rot,rotMSI:23,rotHE:49},shareDefaultRotation:72,
    world_coords:{T_he_to_msi:[[1,.2,3],[.1,1,-2],[0,0,1]]}},rois:[{vertices:[[0,0],[1,2]]}]};
  const before=JSON.stringify({flip:sec.meta.flip,T:sec.meta.world_coords,rois:sec.rois});
  const L=sectionLayerViewLinear(sec,'msi');toggleSectionScreenFlip(sec,axis);
  assert.equal(sec.meta.displayTransform.version,2);
  const flipped=sectionLayerViewLinear(sec,'msi');
  for(const raw of [[1,2],[-3,.5]]){const old=point(L,raw),next=point(flipped,raw);close(next,axis==='lr'?[-old[0],old[1]]:[old[0],-old[1]],'current screen axis');}
  const reloaded=JSON.parse(JSON.stringify(sec));close(sectionCanvasMirror(reloaded).flat(),sectionCanvasMirror(sec).flat(),'reload');
  toggleSectionScreenFlip(sec,axis);close(sectionLayerViewLinear(sec,'msi').flat(),L.flat(),'same flip twice');
  assert.equal(JSON.stringify({flip:sec.meta.flip,T:sec.meta.world_coords,rois:sec.rois}),before);
  assert.equal(sec.meta.shareDefaultRotation,72);
}
// Full-view and HE-only rotations never mutate saved registration or MSI.
{
  const T=[[1.2,.1,2],[-.3,.9,1],[0,0,1]];
  const sec={id:'s',meta:{viewerTransform:{rot:37,rotMSI:90,rotHE:-23},flip:{lr:true}},msiSeries:{MSI_a:{}}};
  const p=panelFor(sec,7,3,true);p.imageSources.HE_STAIN={complete:true,naturalWidth:9,naturalHeight:4};p.imageSettings.HE_STAIN={opacity:1};p.visibleLayers.add('HE_STAIN');p._resolveTHeToMsi=()=>T;
  p.renderComposite();const he=p.displayCtx.draws[0].matrix;
  const expected=mul(sectionMsiCanvasMatrix(sec,7,3,p._displayCanvasFrame,'he'),T);
  close(he.flat(),expected.flat(),'HE registration then its own rotation');
  const msiBefore=sectionLayerViewLinear(sec,'msi');sec.meta.viewerTransform.rotHE=17;close(msiBefore.flat(),sectionLayerViewLinear(sec,'msi').flat(),'HE-only leaves MSI');
  assert.deepEqual(T,[[1.2,.1,2],[-.3,.9,1],[0,0,1]]);
}
// Horizontal physical length uses the inverse direction, not average pitch.
for(const rot of [0,90,180,270,37]){
  const sec={id:'s',meta:{viewerTransform:{rot,rotMSI:0},world_coords:{msi_um_per_px:{x:10,y:30}}},msiSeries:{MSI_a:{}}};
  const p=panelFor(sec), um=previewMsiUmPerCanvasPixel(p,rot);
  const r=(rot-180)*Math.PI/180;
  const expected=Math.hypot(Math.cos(r)*10,Math.sin(r)*30)/2;
  assert.ok(Math.abs(um-expected)<1e-10,`non-square pitch at ${rot}`);
  assert.equal(displayHorizontalUmPerPixel(identity(),{x:0,y:30}),null);
}
// Deliberately saved Preview angle is an absolute outer view angle. It is
// applied once to cdisp, independently of the current main view angle.
{
  const sec={meta:{viewerTransform:{rot:37,rotMSI:90},flip:{ud:true},shareDefaultRotation:125}};
  const expected=displayAffineMultiply(displayRotation(125-90),displayAffineMultiply(context.sectionLayerCanvasLinear(sec,'msi'),displayRotation(-90)));
  close(sectionLayerViewLinear(sec,'msi',sec.meta.shareDefaultRotation).flat(),expected.flat());
}
// Resizing columns and reconstructing a panel preserve image-centred view
// without changing server-bound metadata or issuing a save/publish request.
{
  const storage=new Map();context.sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  context.Toolbar={refreshRotation(){}};
  const sec={id:'viewport',meta:{viewerTransform:{tx:19,ty:-7,scale:2,rot:0}},msiSeries:{MSI_a:{}}};
  const before=JSON.stringify(sec);
  const setup=p=>{p.dom.host={clientWidth:240,clientHeight:160};p.dom.rot={style:{setProperty(){}}};p.msiRasterSize=()=>({w:7,h:3});};
  const p=panelFor(sec);setup(p);p.setupCanvasSize();
  const t=p._ensureViewerTransform(), magnification=t.scale*p._viewerFit.nativeFit;
  p.dom.host.clientWidth=110;p.dom.host.clientHeight=320;p.setupCanvasSize();
  assert.ok(Math.abs(t.scale*p._viewerFit.nativeFit-magnification)<1e-10);
  close([t.tx,t.ty],[19,-7]);assert.equal(JSON.stringify(sec),before,'session perspective never enters project JSON');
  const p2=panelFor(JSON.parse(JSON.stringify(sec)));setup(p2);p2.setupCanvasSize();
  assert.ok(Math.abs(p2._ensureViewerTransform().scale*p2._viewerFit.nativeFit-magnification)<1e-10,'reload viewport');
}
// Linear smoothing changes backing supersampling while columns resize. It
// must not change the native-image magnification or pan after compensation.
{
  const sec={id:'linear',meta:{viewerTransform:{tx:13,ty:4,scale:1,rot:0}},msiSeries:{MSI_a:{}}};
  const p=panelFor(sec,600,300);p.dom.host={clientWidth:800,clientHeight:500};p.dom.rot={style:{setProperty(){}}};p.msiRasterSize=()=>({w:600,h:300});
  context.App.msiSmoothing='linear';p.setupCanvasSize();const initial=p._ensureViewerTransform().scale*p._viewerFit.nativeFit;
  const backing=p.dom.cdisp.width;p.dom.host.clientWidth=400;p.setupCanvasSize();
  assert.notEqual(p.dom.cdisp.width,backing,'fixture crosses supersampling boundary');
  assert.ok(Math.abs(p._ensureViewerTransform().scale*p._viewerFit.nativeFit-initial)<1e-10,'Linear absolute zoom retained');
  close([p._ensureViewerTransform().tx,p._ensureViewerTransform().ty],[13,4]);context.App.msiSmoothing='none';
}
// HE-only and ancillary image frames also accommodate arbitrary rotations.
{
  const sec={meta:{viewerTransform:{rotHE:90}}};
  const f=context.sectionCanvasFrame(sec,7,3,false,'he');assert.equal(f.width,3);assert.equal(f.height,7);
}
// Pending ROI vertices are tied to their initial source geometry. A molecule
// switch in that source is safe; another source/grid cannot append or paint.
{
  const geometry={sourceRef:'source-A',displayGeometry:{W:7,H:3,x:{origin:0,step:1},y:{origin:0,step:1}}};
  const sec={id:'drawing',meta:{},msiSeries:{MSI_a:{}}},p=panelFor(sec);
  context.App.drawing={mode:true,sectionId:'drawing',vertices:[[0,0],[1,1]],sourceGeometry:JSON.parse(JSON.stringify(geometry))};
  context.msiLayerSourceGeometry=()=>geometry;
  assert.equal(p._drawingMatchesMsiSource(false),true);p.drawDrawingPreview();assert.equal(p.roiCtx.paths.length,1);
  geometry.sourceRef='source-B';assert.equal(p._drawingMatchesMsiSource(false),false);p.drawDrawingPreview();assert.equal(p.roiCtx.paths.length,1);
  geometry.sourceRef='source-A';geometry.displayGeometry.W=8;assert.equal(p._drawingMatchesMsiSource(false),false);
  assert.deepEqual(context.App.drawing.vertices,[[0,0],[1,1]],'source mismatch retains unfinished vertices');
  context.App.drawing={mode:false};
}
// Legacy HE image coordinates are edge-based; geometry bridges use sample
// centres. A separable warp must preserve 0.5-centred landmarks at grid knots.
{
  const g={legacy:{W:3,H:2,x:[[0,0],[1,1],[8,2]],y:[[0,0],[1,1]]},displayGeometry:{W:9,H:2,x:{origin:0,step:1},y:{origin:0,step:1}}};
  context.msiLayerSourceGeometry=()=>g;context.msiLegacyRasterSize=()=>({w:3,h:2});
  context.msiLegacyRasterPointToDisplay=(s,k,p)=>[p[0]<=1?p[0]:1+7*(p[0]-1),p[1]];
  context.msiDisplayRasterPointToLegacy=(s,k,p)=>[p[0]<=1?p[0]:1+(p[0]-1)/7,p[1]];
  for(const p of [[.5,.5],[1.5,1.5],[2.5,.5],[1.8,.9]]){
    const q=context.msiLegacyEdgePointToDisplay({},'a',p);
    close(context.msiDisplayEdgePointToLegacy({},'a',q),p,'legacy HE landmark roundtrip');
  }
  close(context.msiLegacyEdgePointToDisplay({},'a',[2.5,.5]),[8.5,.5]);
  const warped=context.heMsiDisplayWarp(canvas(3,2),identity(),{},'a',1);
  assert.equal(warped.width,9);assert.equal(warped.height,2);
  const xPass=warped.ctx.draws[0].src;
  close(xPass.ctx.draws.map(d=>d.args[4]),[0,.5,1.5,8.5],'warp destination knots');
  close(xPass.ctx.draws.map(d=>d.args[6]),[.5,1,7,3.5],'warp segment widths');
  assert.equal(context.msiDisplayPhysicalPitch({meta:{world_coords:{msi_um_per_px:{x:10,y:30}}}},'a'),null,'ambiguous old ordinal pitch is not a physical scale');
  const img={naturalWidth:9,naturalHeight:2,dataset:{ss:'1',rawW:'9',rawH:'2',displayMatrix:JSON.stringify(identity())},getBoundingClientRect:()=>({left:100,top:200,width:90,height:20})};
  close(context.alignmentThumbClickPoint({clientX:185,clientY:215},img,{},'a'),[2.5,1.5],'last sample-centre click is not clamped to index');
  const displayMask={mask:new Uint8Array([1,0,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0]),w:9,h:2,sx:1,sy:1};
  const oldMask=context.msiMaskInLegacyRaster(displayMask,{},'a',384);
  assert.equal(oldMask.w,3);assert.equal(oldMask.h,2);assert.deepEqual(Array.from(oldMask.mask),[1,0,1,0,1,0],'automatic solver uses legacy grid exactly once');

}
console.log(`MSI orientation regression tests: PASS (${cases} combinations, actual renderer/ROI, screen flips, physical pitch)`);
