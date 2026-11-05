'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createCanvas, ImageData} = require('@napi-rs/canvas');
const Smoothing = require('../viewer/msi-smoothing.js');
const snapshot = value => Array.from(value);

for (const [value, expected] of [[undefined,1],[null,1],['5',1],[true,1],[{},1],[NaN,1],
    [Infinity,1],[-Infinity,1],[-1,1],[0,1],[1.49,1],[1.5,2],[5.6,6],[10,10],[11,10]]) {
    assert.equal(Smoothing.normalizeLevel(value), expected);
}
assert.equal(Smoothing.normalizeLevel(undefined,10),10);
assert.equal(Smoothing.normalizeLevel(undefined,NaN),1);

// A deliberately independent sorting oracle verifies the genuine square 2-D
// median, rather than reimplementing the production histogram algorithm.
function reference(source,W,H,radius,mask) {
    const result = new Uint8Array(source);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++) {
        const center=y*W+x;
        if(mask && !mask[center])continue;
        const neighbors=[];
        for(let ny=Math.max(0,y-radius);ny<=Math.min(H-1,y+radius);ny++)
            for(let nx=Math.max(0,x-radius);nx<=Math.min(W-1,x+radius);nx++) {
                const index=ny*W+nx;
                if(!mask || mask[index])neighbors.push(source[index]);
            }
        neighbors.sort((a,b)=>a-b);
        if(neighbors.length)result[center]=neighbors[(neighbors.length-1)>>1];
    }
    return result;
}
const impulse=Uint8Array.from({length:49},(_,i)=>i===24?255:20), impulseBefore=snapshot(impulse);
assert.deepEqual(Smoothing.medianIndices(impulse,7,7,1),new Uint8Array(49).fill(20),
    'A median removes an isolated bright pixel without spreading it over surrounding pixels');
assert.deepEqual(snapshot(impulse),impulseBefore,'Display filtering leaves the source unchanged');
const edge=Uint8Array.from({length:51*51},(_,i)=>i%51<25?20:220);
for(let level=1;level<=10;level++) {
    assert.deepEqual(Smoothing.medianIndices(edge,51,51,level),edge,'A straight tissue boundary is preserved at every level');
    const one=Uint8Array.of(150);
    const result=Smoothing.medianIndices(one,1,1,level);
    assert.notEqual(result,one);assert.deepEqual(result,one);
}
const masked=Uint8Array.from([10,255,10,0,10]),mask=Uint8Array.from([1,0,1,0,1]);
assert.deepEqual(Smoothing.medianIndices(masked,5,1,10,mask),masked,'Hidden or missing pixels neither contribute nor receive signal');
assert.deepEqual(Smoothing.medianIndices(impulse,7,7,10,new Uint8Array(49)),impulse,'Entirely hidden images stay unchanged');
for(const [W,H] of [[7,23],[23,7],[1,29],[29,1],[2,2],[19,17]]) {
    const source=Uint8Array.from({length:W*H},(_,i)=>(i*73+i*i*13)%256);
    const valid=Uint8Array.from({length:W*H},(_,i)=>i%7&&i%13?1:0);
    const before=snapshot(source),beforeMask=snapshot(valid);
    for(let level=1;level<=10;level++)for(const sampleMask of [valid,null]) {
        assert.deepEqual(Smoothing.medianIndices(source,W,H,level,sampleMask),reference(source,W,H,level,sampleMask),
            `Masked 2-D median mismatch at ${W}x${H}, level ${level}`);
    }
    assert.deepEqual(snapshot(source),before);assert.deepEqual(snapshot(valid),beforeMask);
}
const wide=Uint8Array.from({length:16385},(_,i)=>(i*41)%256);
assert.deepEqual(Smoothing.medianIndices(wide,16385,1,10),Smoothing.medianIndices(wide,1,16385,10));
for(const [W,H] of [[0,1],[1,0],[-1,1],[1.5,2],[NaN,1],[Infinity,1],[Number.MAX_SAFE_INTEGER,2]])
    assert.throws(()=>Smoothing.medianIndices(impulse,W,H,5),RangeError);
for(const bad of [null,[],new Float32Array([1]),new Uint8Array(3)])
    assert.throws(()=>Smoothing.medianIndices(bad,1,1,5),TypeError);
assert.throws(()=>Smoothing.medianIndices(impulse,7,7,5,new Uint8Array(3)),TypeError);
assert.throws(()=>Smoothing.medianIndices(impulse,7,7,5,'1'.repeat(49)),TypeError);
const owned=Smoothing.medianIndices(impulse,7,7,1);owned[0]=99;
assert.equal(impulse[0],20,'The return buffer cannot alias source measurements');

// Compare each Linear level to the independent premultiplied RGBA crossfade of
// native nearest and native Linear samples. This catches source-over stacking,
// opacity applied twice, lost alpha, lost transforms and clipping mistakes.
const source=createCanvas(3,2),sourceContext=source.getContext('2d');
sourceContext.putImageData(new ImageData(Uint8ClampedArray.from([
    220,20,50,255, 20,230,70,128, 20,50,245,0,
    30,100,220,64, 240,190,20,255, 180,30,190,255
]),3,2),0,0);
const sourceBefore=snapshot(sourceContext.getImageData(0,0,3,2).data);
const W=80,H=64,background=[31,57,83],opacity=0.6;
const transform=ctx=>{ctx.translate(48,8);ctx.rotate(Math.PI/2);ctx.scale(1.25,1.5);};
function sampled(linear) {
    const c=createCanvas(W,H),ctx=c.getContext('2d');transform(ctx);
    ctx.imageSmoothingEnabled=linear;ctx.drawImage(source,0,0,36,24);
    return ctx.getImageData(0,0,W,H).data;
}
const nearest=sampled(false),linear=sampled(true),results=[];
for(let level=1;level<=10;level++) {
    const canvas=createCanvas(W,H),ctx=canvas.getContext('2d');
    ctx.fillStyle=`rgb(${background.join(',')})`;ctx.fillRect(0,0,W,H);
    ctx.beginPath();ctx.rect(12,12,40,40);ctx.clip();
    transform(ctx);ctx.globalAlpha=opacity;ctx.imageSmoothingEnabled=false;
    const before=ctx.getTransform();
    Smoothing.drawImage(ctx,source,level,0,0,36,24);
    assert.equal(ctx.globalAlpha,opacity);assert.equal(ctx.imageSmoothingEnabled,false);
    for(const key of ['a','b','c','d','e','f'])assert.equal(ctx.getTransform()[key],before[key]);
    const output=ctx.getImageData(0,0,W,H).data;results.push(snapshot(output));
    const t=level/10;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++) {
        const p=(y*W+x)*4,inside=x>=12&&x<52&&y>=12&&y<52;
        const alpha=inside?((1-t)*nearest[p+3]+t*linear[p+3])/255*opacity:0;
        for(let channel=0;channel<3;channel++) {
            const premult=inside?((1-t)*nearest[p+channel]*nearest[p+3]+t*linear[p+channel]*linear[p+3])/255*opacity:0;
            const expected=premult+background[channel]*(1-alpha);
            assert.ok(Math.abs(output[p+channel]-expected)<=3,
                `Linear ${level} differs from premultiplied sample at ${x},${y}, channel ${channel}: ${output[p+channel]} vs ${expected}`);
        }
        assert.equal(output[p+3],255,'Display interpolation must not make an opaque composed image translucent');
    }
}
for(let level=1;level<10;level++)assert.notDeepEqual(results[level-1],results[level],`Linear levels ${level} and ${level+1} must have distinct output`);
const exact=createCanvas(W,H),exactContext=exact.getContext('2d');
exactContext.fillStyle=`rgb(${background.join(',')})`;exactContext.fillRect(0,0,W,H);
exactContext.beginPath();exactContext.rect(12,12,40,40);exactContext.clip();
transform(exactContext);exactContext.globalAlpha=opacity;exactContext.imageSmoothingEnabled=true;
exactContext.drawImage(source,0,0,36,24);
assert.deepEqual(results[9],snapshot(exactContext.getImageData(0,0,W,H).data),'Linear level 10 matches the former browser draw byte-for-byte');
assert.deepEqual(snapshot(sourceContext.getImageData(0,0,3,2).data),sourceBefore,'Interpolation never changes source image pixels');

// Exercise all drawImage signatures and scratch cropping with a reflected,
// skewed transform and destinations partly outside the visible canvas.
for (const args of [[-1,-1],[-1,-1,7,5],[1,0,2,2,-1,-1,7,5]]) {
    function drawVariant(mode) {
        const canvas=createCanvas(32,24),ctx=canvas.getContext('2d');
        ctx.setTransform(-6,0.8,0.6,5,18,2);
        if(typeof mode==='number')Smoothing.drawImage(ctx,source,mode,...args);
        else {ctx.imageSmoothingEnabled=mode;ctx.drawImage(source,...args);}
        return ctx.getImageData(0,0,32,24).data;
    }
    const a=drawVariant(false),b=drawVariant(true),mixed=drawVariant(4);
    for(let i=0;i<a.length;i+=4) {
        assert.ok(Math.abs(mixed[i+3]-(0.6*a[i+3]+0.4*b[i+3]))<=2,'Cropped interpolation preserves weighted coverage');
        for(let c=0;c<3;c++)assert.ok(Math.abs(mixed[i+c]*mixed[i+3]/255-
            (0.6*a[i+c]*a[i+3]+0.4*b[i+c]*b[i+3])/255)<=3,
            'Reflected/cropped image uses the same premultiplied interpolation');
    }
    assert.deepEqual(drawVariant(10),b,'Every drawImage signature has the exact legacy Linear endpoint');
}

const browser=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../viewer/msi-smoothing.js'),'utf8'),browser);
assert.equal(browser.MsiSmoothing.normalizeLevel(5.5),6);
assert.deepEqual(snapshot(browser.MsiSmoothing.medianIndices(impulse,7,7,1)),new Array(49).fill(20),'Cross-realm byte arrays are accepted');
console.log('MSI smoothing: ten masked 2-D median levels, intact edges and sources, ten alpha-correct Linear levels, transforms and clipping PASS');
