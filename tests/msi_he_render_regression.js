'use strict';
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const { runtime } = require('./viewer-runtime.cjs');
const id = [[1,0,0],[0,1,0],[0,0,1]];
let geometry;
const c = runtime({
  document: { createElement: () => createCanvas(1, 1) },
  get2dContext: canvas => canvas.getContext('2d'),
  msiLayerSourceGeometry: () => geometry,
  msiLegacyRasterSize: () => ({ w: geometry.legacy.W, h: geometry.legacy.H }),
}, ['msiAxisInterpolate', 'msiLegacyRasterPointToDisplay', 'msiDisplayRasterPointToLegacy']);
function grid(w, h, irregular = false) {
  return { legacy: { W:w, H:h,
    x:Array.from({length:w}, (_,i) => [irregular ? i + (i > 7 ? 5 : 0) : i + Math.sin(i) * 0.00002, i]),
    y:Array.from({length:h}, (_,i) => [i + Math.cos(i) * 0.00002, i]),
  }, displayGeometry: { W:w+(irregular?5:0), H:h, x:{origin:0,step:1}, y:{origin:0,step:1} } };
}
function white(w,h) {
  const src=createCanvas(w,h), ctx=src.getContext('2d');
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,w,h); return src;
}
let cases=0;
for (const irregular of [false,true]) for (const scale of [1,1.25,2,3,5,6]) {
  geometry=grid(312,149,irregular);
  const before=JSON.stringify(geometry), transform=JSON.stringify(id);
  const out=c.heMsiDisplayWarp(white(312,149),id,{id:'synthetic'},'MSI_a',scale);
  assert.ok(out, 'changed geometry is rendered');
  const d=out.getContext('2d').getImageData(0,0,out.width,out.height).data;
  for(let y=3;y<out.height-3;y++) for(let x=3;x<out.width-3;x++) {
    const n=4*(y*out.width+x);
    assert.equal(d[n+3],255,`opaque HE develops a seam: scale=${scale}, irregular=${irregular}, x=${x}, y=${y}`);
    assert.equal(d[n],255,'white interior must remain white');
  }
  assert.equal(JSON.stringify(geometry),before,'render never edits source geometry');
  assert.equal(JSON.stringify(id),transform,'render never edits registration');
  cases++;
}
// A smooth colour ramp tests the full inverse mapping and the edge/centre
// convention, not the number or arrangement of drawImage calls.
geometry=grid(32,19,true);
const src=createCanvas(128,76), ctx=src.getContext('2d'), pixels=ctx.createImageData(128,76);
for(let y=0;y<76;y++)for(let x=0;x<128;x++)pixels.data.set([x*2,y*3,80,255],4*(y*128+x));
ctx.putImageData(pixels,0,0);
const T=[[.25,0,0],[0,.25,0],[0,0,1]], out=c.heMsiDisplayWarp(src,T,{},'MSI_a',2);
const data=out.getContext('2d').getImageData(0,0,out.width,out.height).data;
for(const [x,y] of [[10,10],[30,20],[52,16]]) {
  const legacy=c.msiDisplayEdgePointToLegacy({},'MSI_a',[(x+.5)*37/out.width,(y+.5)*19/out.height]);
  const expected=[(legacy[0]*4-.5)*2,(legacy[1]*4-.5)*3,80];
  expected.forEach((v,j)=>assert.ok(Math.abs(data[4*(y*out.width+x)+j]-v)<=2,'registered HE colour matches inverse coordinate'));
}
console.log(`HE real-pixel regression: ${cases} white-image cases plus registered colour ramp passed`);
