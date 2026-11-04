/* Display-only MSI geometry. Source rows, rasters, ROIs and registrations stay unchanged. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MsiDisplayGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const identity = () => [[1,0,0],[0,1,0],[0,0,1]];
    const multiply = (a,b) => a.map((row,i) => row.map((_,j) => a[i][0]*b[0][j]+a[i][1]*b[1][j]+a[i][2]*b[2][j]));
    const point = (m,x,y) => [m[0][0]*x+m[0][1]*y+m[0][2],m[1][0]*x+m[1][1]*y+m[1][2]];
    function bounds(rect,matrix) {
        const points = [[rect.x,rect.y],[rect.x+rect.width,rect.y],[rect.x,rect.y+rect.height],[rect.x+rect.width,rect.y+rect.height]]
            .map(p => point(matrix,p[0],p[1]));
        const x = Math.min(...points.map(p=>p[0])), y = Math.min(...points.map(p=>p[1]));
        return {x,y,width:Math.max(...points.map(p=>p[0]))-x,height:Math.max(...points.map(p=>p[1]))-y};
    }
    function positive(value) {
        if (typeof value === 'string' && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) value=Number(value);
        return typeof value==='number' && Number.isFinite(value) && value>0 ? value : null;
    }
    const dimension = value => Number.isSafeInteger(value) && value>0;
    function orientation(value) {
        if(value==null)return identity();
        if(!Array.isArray(value)||value.length!==3||!value.every(row=>Array.isArray(row)&&row.length===3&&row.every(Number.isFinite))
            ||Math.abs(value[2][0])>1e-12||Math.abs(value[2][1])>1e-12||Math.abs(value[2][2]-1)>1e-12
            ||Math.abs(value[0][0]*value[1][1]-value[0][1]*value[1][0])<1e-14)throw new Error('Invalid MSI display orientation');
        return value.map(row=>row.slice());
    }
    function createFrame(input) {
        const o=input||{}, W=o.width,H=o.height;
        if(!dimension(W)||!dimension(H))throw new Error('Invalid MSI display raster dimensions');
        const O=orientation(o.orientation), sourceW=o.sourceWidth,sourceH=o.sourceHeight;
        const px=positive(o.registeredPitch&&o.registeredPitch.x),py=positive(o.registeredPitch&&o.registeredPitch.y);
        const calibrated=!!(px&&py&&dimension(sourceW)&&dimension(sourceH)
            &&(sourceW===W||(sourceW>1&&W>1))&&(sourceH===H||(sourceH>1&&H>1)));
        const displayPitch=calibrated?{x:px*(sourceW===W?1:(sourceW-1)/(W-1)),y:py*(sourceH===H?1:(sourceH-1)/(H-1))}:null;
        const sourceBoundsUm=calibrated?{x:0,y:0,width:sourceW*px,height:sourceH*py}:null;
        if(calibrated&&(![displayPitch.x,displayPitch.y,sourceBoundsUm.width,sourceBoundsUm.height].every(v=>Number.isFinite(v)&&v>0)))
            throw new Error('MSI physical display bounds exceed numeric limits');
        const physical=o.aspectMode==='physical'&&calibrated;
        const unit=physical?Math.min(px,py):1;
        // Source bounds are pixel EDGES; the first/last CENTRES are a separate
        // contract. Resampling cannot change the source footprint N*pitch.
        const qx=physical?displayPitch.x/unit:1,qy=physical?displayPitch.y/unit:1;
        const dx=physical?(px-displayPitch.x)/(2*unit):0,dy=physical?(py-displayPitch.y)/(2*unit):0;
        const rasterToFrame=[[qx,0,dx],[0,qy,dy],[0,0,1]];
        const frameBounds={x:0,y:0,width:physical?sourceW*px/unit:W,height:physical?sourceH*py/unit:H};
        const sampleBounds={x:-dx/qx,y:-dy/qy,width:frameBounds.width/qx,height:frameBounds.height/qy};
        const matrix=multiply(O,rasterToFrame), viewBounds=bounds(frameBounds,O);
        if(![...matrix.flat(),...Object.values(viewBounds),...Object.values(sampleBounds)].every(Number.isFinite)
            ||!(viewBounds.width>0&&viewBounds.height>0))throw new Error('MSI physical display bounds exceed numeric limits');
        return {width:W,height:H,sourceWidth:dimension(sourceW)?sourceW:null,sourceHeight:dimension(sourceH)?sourceH:null,
            matrix,bounds:viewBounds,sampleBounds,rasterToFrame,frameBounds,orientation:O,displayPitch,
            sourceBoundsUm,
            unitUm:physical?unit:null,aspectMode:physical?'physical':'legacy',calibrated};
    }
    // Source rectangles always stay within the original display bitmap. Only
    // its boundary cell footprint is extended; missing boundary cells remain
    // missing. Consumers may instead inverse-sample sampleBounds and clamp the
    // source index, retaining their existing finite-value/alpha checks.
    function drawingRects(frame) {
        const axis=(n,start,length)=>{
            const end=start+length,out=[];
            if(start<0)out.push({s:0,n:1,d:start,l:Math.min(end,0)-start});
            const lo=Math.max(0,start),hi=Math.min(n,end);
            if(hi>lo)out.push({s:lo,n:hi-lo,d:lo,l:hi-lo});
            if(end>n)out.push({s:n-1,n:1,d:Math.max(start,n),l:end-Math.max(start,n)});
            return out.filter(p=>p.l>0);
        };
        const r=frame.sampleBounds, xs=axis(frame.width,r.x,r.width),ys=axis(frame.height,r.y,r.height),out=[];
        for(const x of xs)for(const y of ys)out.push({source:{x:x.s,y:y.s,width:x.n,height:y.n},dest:{x:x.d,y:y.d,width:x.l,height:y.l}});
        return out;
    }
    return Object.freeze({createFrame,drawingRects,bounds});
});
