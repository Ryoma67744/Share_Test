'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createCanvas} = require('@napi-rs/canvas');
const {standalone, runtime} = require('./viewer-runtime.cjs');
const Msi = require('../viewer/roi-media-msi.js');

// Real production intensity evaluators and real canvas pixels. A low display
// range must retain distinctions that have disappeared in the 8-bit raster.
const evals = vm.runInNewContext(standalone('msiValueEval')+'\n'+standalone('msiWindowEval')+
  '\n({evaluateValue:msiValueEval,evaluateLuminance:msiWindowEval})');
const lut = Array.from({length:256},(_,i)=>[i,255-i,Math.floor(i/2)]);
const src = createCanvas(4,2), srcCtx=src.getContext('2d');
const image = srcCtx.createImageData(4,2);
for(let i=0;i<8;i++) image.data.set([0,0,0,i===7?0:255],4*i);
srcCtx.putImageData(image,0,0);
const values = Float64Array.from([1,2,3,4,5,6,7,8]);
const keep = Uint8Array.from([1,1,1,1,1,0,1,1]);
const options={createCanvas,...evals,lut,background:[9,10,11],rawRange:[0,10000],fallbackMax:10000,
  window:{min:0,max:8},valueRaster:{W:4,H:2,values},keepGrid:{W:4,H:2,keep}};
const beforeSource=Buffer.from(srcCtx.getImageData(0,0,4,2).data);
const colored=Msi.colorize(src,options);
const colorAt=(canvas,x,y)=>[...canvas.getContext('2d').getImageData(Math.floor(x),Math.floor(y),1,1).data];
for(let i=0;i<8;i++) {
  const expected=i===5 || i===7 ? [9,10,11] : lut[Math.round(values[i]/8*255)];
  assert.deepEqual(colorAt(colored,i%4,Math.floor(i/4)),[...expected,255]);
}
assert.deepEqual(Buffer.from(srcCtx.getImageData(0,0,4,2).data),beforeSource,'source raster remains unchanged');
assert.deepEqual([...values],[1,2,3,4,5,6,7,8]);
assert.deepEqual(options.window,{min:0,max:8});
const legacy=Msi.colorize(src,{...options,valueRaster:{W:9,H:9,values},keepGrid:null});
assert.deepEqual(colorAt(legacy,0,0),[...lut[0],255],'mismatched native-value dimensions use production luminance evaluator');
assert.throws(()=>Msi.colorize(src,{...options,evaluateValue:null}),/配色/);

const raster=createCanvas(16,12), ctx=raster.getContext('2d'), pixels=ctx.createImageData(16,12);
for(let y=0;y<12;y++)for(let x=0;x<16;x++)pixels.data.set([10*x,12*y,100+x+y,255],4*(y*16+x));
ctx.putImageData(pixels,0,0);
const polygon=[[6,4],[8,4],[8,6],[6,6]], identity=[[1,0,0],[0,1,0],[0,0,1]];
const frame={canvas:raster,polygon,transform:identity,roiColor:'#ff0000',background:'#000000'};
const snapshot=JSON.stringify({polygon,transform:identity});
const g=Msi.geometry(frame,4);
assert.deepEqual(g.polygon,[[6.5,4.5],[8.5,4.5],[8.5,6.5],[6.5,6.5]],'measurement centres shift exactly half a native pixel');
assert.deepEqual(g.crop,{x:2,y:0,width:11,height:11});
assert.deepEqual(Msi.geometry({...frame,polygon:[[-.5,-.5],[.5,-.5],[.5,.5]]},16).crop,{x:0,y:0,width:16,height:12});
assert.equal(Msi.geometry({...frame,polygon:[[15,11],[15,11],[15,11]]},2).crop.width,3,'degenerate ROI has positive clamped crop');
assert.throws(()=>Msi.geometry({...frame,polygon:[[20,0],[21,0],[21,1]]}),/範囲外/);
assert.throws(()=>Msi.geometry({...frame,polygon:[[NaN,0],[1,0],[1,1]]}),/ROI座標/);
assert.throws(()=>Msi.geometry({...frame,transform:[[0,0,0],[0,0,0],[0,0,1]]}),/表示座標/);

const orientation=runtime();
let renderCases=0;
for(const deg of [0,90,180,270,37]) for(const flip of [false,true]) for(const dpr of [1,2]) {
  const section={meta:{displayTransform:{version:2,baseOrientation:'native-raster',mirror:[flip?-1:1,0,0,1]},viewerTransform:{rot:deg}}};
  const view=orientation.sectionLayerViewLinear(section,'msi');
  // The anisotropic display and both polygon/image use one affine transform.
  const T=orientation.displayAffineMultiply(view,[[2,0,0],[0,1,0],[0,0,1]]);
  const f={...frame,transform:Array.from(T,row=>Array.from(row))};
  for(const mode of ['whole','crop']) {
    const out=createCanvas(1,1), result=Msi.draw(out,f,{width:400,height:350,dpr,mode,margin:4,outline:false,scaleBar:false});
    for(const [x,y] of [[6,4],[7,5],[8,6]]) {
      const A=result.imageMatrix;
      const px=(A[0][0]*(x+.5)+A[0][1]*(y+.5)+A[0][2])*dpr;
      const py=(A[1][0]*(x+.5)+A[1][1]*(y+.5)+A[1][2])*dpr;
      assert.deepEqual(colorAt(out,px,py),colorAt(raster,x,y),`native pixel unchanged: ${mode}, angle ${deg}, mirror ${flip}, dpr ${dpr}`);
    }
    const A=result.imageMatrix, expected=[A[0][0]*6.5+A[0][1]*4.5+A[0][2],A[1][0]*6.5+A[1][1]*4.5+A[1][2]];
    expected.forEach((v,i)=>assert.ok(Math.abs(v-result.screenPolygon[0][i])<1e-8,'ROI point and pixel centre share transform'));
    renderCases++;
  }
}
assert.equal(JSON.stringify({polygon,transform:identity}),snapshot,'render preserves saved ROI and transforms');

// Fixed CSS-pixel outlines at very different zoom and DPR; no ROI fill.
const black=createCanvas(200,200);black.getContext('2d').fillRect(0,0,200,200);
const outlineFrame={canvas:black,polygon:[[89.5,89.5],[109.5,89.5],[109.5,109.5],[89.5,109.5]],roiColor:'#ff0000'};
for(const zoom of [1,4,8]) for(const dpr of [1,2]) {
  const out=createCanvas(1,1), result=Msi.draw(out,outlineFrame,{width:200,height:200,dpr,mode:'whole',zoom});
  const sx=result.screenPolygon[0][0], sy=result.screenPolygon[0][1];
  const row=out.getContext('2d').getImageData(Math.floor((sx-4)*dpr),100*dpr,8*dpr,1).data;
  let count=0;for(let i=0;i<row.length;i+=4)if(row[i]>20 && row[i+1]<10)count++;
  assert.ok(count>=1 && count<=3*dpr,`outline width bounded at zoom ${zoom}, dpr ${dpr}: ${count}`);
  assert.deepEqual(colorAt(out,100*dpr,100*dpr),[0,0,0,255],'ROI interior is not filled');
  assert.ok(sy>=0);
}

// Pixel pitch is calibrated in native axes. Rotation and physical-aspect
// correction must not change the meaning of a horizontal physical scale bar.
for(const angle of [0,37,90]) {
  const r=angle*Math.PI/180, T=[[2*Math.cos(r),-Math.sin(r),0],[2*Math.sin(r),Math.cos(r),0],[0,0,1]];
  const bar=Msi.scaleBar(T,{x:40,y:20},400);
  assert.ok(Math.abs(bar.umPerPixel-20)<1e-9);
  assert.ok(Math.abs(bar.pixels*bar.umPerPixel-bar.length)<1e-9);
}
assert.equal(Msi.scaleBar(identity,null,400),null,'uncalibrated data has no invented scale bar');

// The real canvas viewport remains independent of the application's viewer.
const handlers=new Map();let removed=false,disconnected=false;
const canvas=createCanvas(1,1);
Object.assign(canvas,{style:{},setAttribute(){},addEventListener(name,fn){handlers.set(name,fn);},removeEventListener(name){handlers.delete(name);},
  getBoundingClientRect:()=>({left:0,top:0,width:200,height:200}),setPointerCapture(){},releasePointerCapture(){},remove(){removed=true;}});
const host={ownerDocument:{createElement:()=>canvas,defaultView:{devicePixelRatio:1,ResizeObserver:class{observe(){} disconnect(){disconnected=true;}}}},
  appendChild(c){assert.equal(c,canvas);},getBoundingClientRect:()=>({width:200,height:200})};
let state;
const viewport=Msi.createViewport(host,{onStatus:(message,result)=>{assert.equal(message,'');state=result;}});
viewport.setFrame(frame);assert.equal(state.zoom,1);
viewport.zoomBy(2);assert.equal(state.zoom,2);
handlers.get('pointerdown')({button:0,pointerId:1,clientX:10,clientY:10,preventDefault(){},stopPropagation(){}});
handlers.get('pointermove')({pointerId:1,clientX:20,clientY:30,preventDefault(){},stopPropagation(){}});
assert.equal(state.panX,10);assert.equal(state.panY,20);
viewport.setMode('whole');assert.equal(state.zoom,1);assert.equal(state.panX,0);
viewport.setFrame(null);assert.equal(state,null);
viewport.destroy();assert.equal(handlers.size,0);assert.equal(removed,true);assert.equal(disconnected,true);

console.log(`ROI microscopy MSI regression passed: native intensity mapping, ${renderCases} real-pixel affine views, tiny ROI crops, fixed outlines, scale bars and viewport lifecycle.`);
