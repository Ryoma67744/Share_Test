'use strict';
const assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const Geometry=require('../viewer/msi-display-geometry.js');
const {runtime}=require('./viewer-runtime.cjs');
const near=(a,b,message)=>assert.ok(Math.abs(a-b)<1e-9*Math.max(1,Math.abs(a),Math.abs(b)),message||`${a} != ${b}`);
const point=(M,x,y)=>[M[0][0]*x+M[0][1]*y+M[0][2],M[1][0]*x+M[1][1]*y+M[1][2]];
const turn=degrees=>{const r=degrees*Math.PI/180;return [[Math.cos(r),-Math.sin(r),0],[Math.sin(r),Math.cos(r),0],[0,0,1]];};
const make=(extra={})=>Geometry.createFrame({width:100,height:50,sourceWidth:100,sourceHeight:50,
 registeredPitch:{x:30,y:60},aspectMode:'physical',...extra});

const physical=make();assert.equal(physical.aspectMode,'physical');
assert.deepEqual(physical.sourceBoundsUm,{x:0,y:0,width:3000,height:3000});
assert.deepEqual(physical.bounds,{x:0,y:0,width:100,height:100});
assert.deepEqual(physical.matrix,[[1,0,0],[0,2,0],[0,0,1]]);
assert.deepEqual(make({registeredPitch:{x:'30',y:'30'}}).matrix,[[1,0,0],[0,1,0],[0,0,1]]);
assert.deepEqual(make({aspectMode:'legacy'}).bounds,{x:0,y:0,width:100,height:50});
assert.deepEqual(make({sourceWidth:undefined}).matrix,[[1,0,0],[0,1,0],[0,0,1]],'Missing source dimensions never invent physical calibration');
assert.equal(make({sourceWidth:undefined}).calibrated,false);
assert.equal(make({registeredPitch:{x:0,y:30}}).calibrated,false);
assert.throws(()=>make({registeredPitch:{x:1e308,y:1e308}}),/numeric limits/,'An overflowing physical footprint is rejected');

// Keep source footprint N*p and source first/last-centre span (N-1)*p
// independently, for both a finer and a coarser display raster.
for(const width of [2,3,5,51])for(const height of [2,4,9]) {
 const input={width,height,sourceWidth:3,sourceHeight:4,registeredPitch:{x:30,y:60},aspectMode:'physical'};
 const frozen=JSON.stringify(input),f=Geometry.createFrame(input);
 assert.equal(JSON.stringify(input),frozen);
 assert.deepEqual(f.sourceBoundsUm,{x:0,y:0,width:90,height:240});
 const first=point(f.matrix,.5,.5),last=point(f.matrix,width-.5,height-.5);
 near(first[0]*f.unitUm,15);near(first[1]*f.unitUm,30);
 near((last[0]-first[0])*f.unitUm,60);near((last[1]-first[1])*f.unitUm,180);
 const edge0=point(f.matrix,f.sampleBounds.x,f.sampleBounds.y);
 const edge1=point(f.matrix,f.sampleBounds.x+f.sampleBounds.width,f.sampleBounds.y+f.sampleBounds.height);
 near(edge0[0],0);near(edge0[1],0);near(edge1[0]*f.unitUm,90);near(edge1[1]*f.unitUm,240);
}
const single=make({width:1,height:1,sourceWidth:1,sourceHeight:1});
assert.deepEqual(single.bounds,{x:0,y:0,width:1,height:2});
assert.equal(make({width:1,sourceWidth:3}).calibrated,false,'A collapsed axis cannot supply an endpoint-centre mapping');

// Main, thumbnails, Align and scale bars use the actual production helpers.
// The same inverse must still return the original ROI centre coordinates.
const app={getMsiDisplaySettings:()=>({aspectMode:'physical'}),panels:new Map()};
const c=runtime({App:app,MsiDisplayGeometry:Geometry,document:{createElement:()=>createCanvas(1,1)},
 get2dContext:canvas=>{const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;return ctx;}},['msiLayerSourceGeometry','msiSourceReference']);
for(const degrees of [0,90,37])for(const mirror of [1,-1]) {
 const section={id:'s',meta:{world_coords:{msi_um_per_px:{x:30,y:60}},displayTransform:{version:2,baseOrientation:'native-raster',mirror:[mirror,0,0,1]},viewerTransform:{rotMSI:degrees}},msiSeries:{MSI_a:{kind:'txt',blobId:'source'}}};
 const geometry={sourceRef:c.msiSourceReference(section.msiSeries.MSI_a),legacy:{W:3,H:4},displayGeometry:{W:5,H:9}};
 app.panels.set('s',{msiValueRasters:new Map([['MSI_a',{sourceGeometry:geometry}]])});
 const base=c.sectionMsiPhysicalFrame(section,'MSI_a',5,9);
 const frame={width:200,height:200,backingScale:2,msiDisplay:base};
 const M=c.sectionMsiCanvasMatrix(section,5,9,frame,'msi');
 const roiM=c.displayAffineMultiply(M,[[1,0,.5],[0,1,.5],[0,0,1]]),inv=c.invertAffine(roiM);
 for(const p of [[0,0],[4,8],[1.125,6.25]]) {
  const screen=point(roiM,...p),roundTrip=point(inv,...screen);near(roundTrip[0],p[0]);near(roundTrip[1],p[1]);
 }
 // A physical display has the same horizontal distance per canvas pixel at
 // every angle; the pitch is consumed once, not squared by the scale bar.
 near(c.displayHorizontalUmPerPixel(M,base.displayPitch),15);
 const viewed=c.sectionMsiPhysicalFrame(section,'MSI_a',5,9,c.sectionLayerViewLinear(section,'msi'));
 const bake=c.msiFrameBakeGeometry(viewed,3),center=point(bake.matrix,2.5,4.5);
 near(center[0],bake.width/2);near(center[1],bake.height/2);
}
{
 const section={id:'overflow',meta:{world_coords:{msi_um_per_px:{x:1e308,y:1e308}}},msiSeries:{MSI_a:{kind:'txt',blobId:'source'}}};
 app.panels.set(section.id,{msiValueRasters:new Map([['MSI_a',{sourceGeometry:{legacy:{W:100,H:50},displayGeometry:{W:100,H:50}}}]])});
 const before=JSON.stringify(section);
 assert.equal(c.sectionMsiPhysicalFrame(section,'MSI_a',100,50),null,'An impossible physical frame falls back without stopping image rendering');
 assert.equal(c.resolveMsiPhysicalCalibration(section,'MSI_a').displayPitch,null,'An overflowing calibration cannot produce a scale bar');
 assert.equal(JSON.stringify(section),before);
}

// Real raster paint tests the optional boundary-cell extension. Transparent
// (missing) boundary cells remain transparent; no synthetic intensity is added.
for(const width of [2,5]) {
 const f=Geometry.createFrame({width,height:1,sourceWidth:3,sourceHeight:1,registeredPitch:{x:30,y:30},aspectMode:'physical'});
 const src=createCanvas(width,1),sc=src.getContext('2d');sc.fillStyle='#ff0000';sc.fillRect(0,0,1,1);sc.fillStyle='#00ff00';sc.fillRect(width-1,0,1,1);
 const before=Buffer.from(sc.getImageData(0,0,width,1).data);
 const out=c.bakeMsiImageWithFrame(src,f,20,false),ctx=out.getContext('2d');
 assert.equal(out.width,60);assert.equal(out.height,20);
 assert.deepEqual([...ctx.getImageData(0,10,1,1).data],[255,0,0,255]);
 assert.deepEqual([...ctx.getImageData(59,10,1,1).data],[0,255,0,255]);
 if(width===5)assert.equal(ctx.getImageData(30,10,1,1).data[3],0);
 assert.deepEqual(Buffer.from(sc.getImageData(0,0,width,1).data),before);
 sc.clearRect(0,0,1,1);const missing=c.bakeMsiImageWithFrame(src,f,20,false);
 assert.equal(missing.getContext('2d').getImageData(0,10,1,1).data[3],0);
}
{
 const src=createCanvas(2,2),ctx=src.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,1,2);ctx.fillStyle='#00ff00';ctx.fillRect(1,0,1,2);
 const f=make({width:2,height:2,sourceWidth:2,sourceHeight:2,registeredPitch:{x:30,y:45}});
 const nearest=c.bakeMsiImageWithFrame(src,f,3,false).getContext('2d').getImageData(0,0,6,9).data;
 for(let i=0;i<nearest.length;i+=4)assert.ok(nearest[i]===255||nearest[i+1]===255,'Nearest physical thumbnail cannot blend two measurement colours');
 const linear=c.bakeMsiImageWithFrame(src,f,3,true);
 assert.equal(linear.getContext('2d').imageSmoothingEnabled,true,'Explicit linear thumbnail interpolation remains available');
}
const huge=make({registeredPitch:{x:1,y:1000000},orientation:turn(37)}),bounded=c.msiFrameBakeGeometry(huge,1);
assert.ok(bounded.width<=6144&&bounded.height<=6144&&bounded.width*bounded.height<=16010000,'Extreme aspect keeps one uniform bounded scale');
console.log('MSI display geometry regression: PASS (physical frames, centre/edge contracts, legacy mode, ROI inverse, bars, bounded nearest boundary paint)');
