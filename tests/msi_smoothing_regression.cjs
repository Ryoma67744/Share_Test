'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Smoothing = require('../viewer/msi-smoothing.js');
const Settings = require('../viewer/msi-display-settings.js');

for (const [value, expected] of [[undefined,0],[null,0],['50',0],[true,0],[{},0],[NaN,0],
    [Infinity,0],[-Infinity,0],[-1,0],[0,0],[0.49,0],[0.5,1],[25.6,26],[100,100],[101,100]]) {
    assert.equal(Smoothing.normalizeStrength(value), expected);
    assert.equal(Settings.normalize({version:1,smoothingStrength:value}).smoothingStrength, expected,
        'Stored settings and the renderer normalize strength identically');
}

const rgba = values => Uint8ClampedArray.from(values.flatMap(value => Array.isArray(value) ? value : [value,value,value,255]));
const snapshot = value => Array.from(value);
const input = rgba([0,100,[250,30,80,127],[60,50,40,0]]), original = snapshot(input);
for (const strength of [0,undefined,NaN,Infinity,'80']) {
    const output = Smoothing.smoothRgba(input,4,1,strength);
    assert.notEqual(output,input,'The display result owns its pixel buffer even at strength zero');
    assert.deepEqual(snapshot(output),original,'Zero/invalid strength keeps the legacy appearance byte-for-byte');
    output[0]=99;
    assert.deepEqual(snapshot(input),original,'Editing a returned display buffer cannot alter its source');
}
for(const strength of [1,50,100]) {
    const one=rgba([[5,99,250,80]]);
    assert.deepEqual(Smoothing.smoothRgba(one,1,1,strength),one,'A single source pixel remains unchanged');
}

// A stronger setting spreads an isolated display peak over more neighbouring
// source pixels. Its source buffer and every alpha byte remain unchanged.
const impulse=rgba(Array.from({length:19},(_,i)=>i===9?255:0)), impulseBefore=snapshot(impulse);
const weak=Smoothing.smoothRgba(impulse,19,1,25), strong=Smoothing.smoothRgba(impulse,19,1,100);
assert.ok(weak[9*4] < 255 && strong[9*4] < weak[9*4]);
assert.ok(strong[5*4] > weak[5*4],'Greater strength reaches farther from the peak');
assert.deepEqual(snapshot(impulse),impulseBefore,'Smoothing never modifies original pixels');
assert.deepEqual(snapshot(Smoothing.smoothRgba(impulse,1,19,100)),snapshot(strong),
    'Horizontal and vertical one-pixel axes use the same kernel');
const wide=rgba(Array.from({length:16385},(_,i)=>(i*41)%256));
assert.deepEqual(Smoothing.smoothRgba(wide,16385,1,100),Smoothing.smoothRgba(wide,1,16385,100),
    'An exceptionally wide raster takes the bounded-memory transposed path without changing the result');

// Masked background must neither pull the tissue colour toward black/red nor
// receive signal. Transparent RGB garbage must also be excluded as a neighbour.
const masked=rgba([[10,90,220,255],[255,0,0,255],[10,90,220,30],[0,255,0,0],[10,90,220,255]]);
const mask=Uint8Array.from([1,0,1,1,1]), maskBefore=snapshot(mask), maskedBefore=snapshot(masked);
const maskedOutput=Smoothing.smoothRgba(masked,5,1,100,mask);
assert.deepEqual(snapshot(maskedOutput),maskedBefore,'Uniform valid tissue and both kinds of holes are preserved');
assert.deepEqual(snapshot(mask),maskBefore);assert.deepEqual(snapshot(masked),maskedBefore);
assert.deepEqual(Smoothing.smoothRgba(input,4,1,100,new Uint8Array(4)),input,
    'An entirely hidden raster is unchanged');

// An independent direct 2D convolution verifies normalized masking across
// unequal row weights, boundaries and a ring-buffer wrap. Rounding tolerance is
// one RGB byte because production intentionally uses Float32 intermediates.
function reference(source,W,H,strength,mask) {
    const output=new Uint8ClampedArray(source),sigma=3*strength/100,radius=Math.ceil(sigma*3);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++) {
        const p=y*W+x;
        if(!source[p*4+3]||!mask[p])continue;
        const sums=[0,0,0];let total=0;
        for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++) {
            const nx=x+dx,ny=y+dy;if(nx<0||nx>=W||ny<0||ny>=H)continue;
            const q=ny*W+nx;if(!source[q*4+3]||!mask[q])continue;
            const weight=Math.exp(-(dx*dx+dy*dy)/(2*sigma*sigma));
            for(let c=0;c<3;c++)sums[c]+=source[q*4+c]*weight;
            total+=weight;
        }
        for(let c=0;c<3;c++)output[p*4+c]=sums[c]/total;
    }
    return output;
}
for(const [W,H] of [[7,23],[23,7],[1,29],[29,1]]) {
    const sample=rgba(Array.from({length:W*H},(_,i)=>[(i*73)%256,(i*13)%256,(i*191)%256,i%11?40+i%216:0]));
    const mask=Uint8Array.from({length:W*H},(_,i)=>i%7&&i%13?1:0);
    for(const strength of [17,50,100]) {
        const output=Smoothing.smoothRgba(sample,W,H,strength,mask),expected=reference(sample,W,H,strength,mask);
        for(let i=0;i<output.length;i++) {
            const p=Math.floor(i/4),unaltered=i%4===3||!mask[p]||!sample[p*4+3];
            assert.ok(Math.abs(output[i]-expected[i]) <= (unaltered?0:1),`Masked Gaussian mismatch at ${W}x${H}, ${strength}, byte ${i}`);
        }
    }
}

for(const [W,H] of [[0,1],[1,0],[-1,1],[1.5,2],[NaN,1],[Infinity,1],[Number.MAX_SAFE_INTEGER,2]])
    assert.throws(()=>Smoothing.smoothRgba(input,W,H,50),RangeError);
for(const bad of [null,[],new Float32Array([NaN,1,2,3]),new Uint8Array(3)])
    assert.throws(()=>Smoothing.smoothRgba(bad,1,1,50),TypeError);
assert.throws(()=>Smoothing.smoothRgba(input,4,1,50,new Uint8Array(3)),TypeError);
assert.throws(()=>Smoothing.smoothRgba(input,4,1,50,'1111'),TypeError);

const browser=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../viewer/msi-smoothing.js'),'utf8'),browser);
assert.equal(browser.MsiSmoothing.normalizeStrength(37.5),38,'The browser global exposes the same API');
assert.deepEqual(snapshot(browser.MsiSmoothing.smoothRgba(input,4,1,0)),original,'Cross-realm byte arrays are accepted');
console.log('MSI smoothing: masked Gaussian, zero compatibility, stronger spread, immutable sources, bounded rows and validation PASS');
