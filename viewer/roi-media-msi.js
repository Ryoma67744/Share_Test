(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoiMediaMsi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // This module owns only a comparison viewport. Neither quantitative ROI
  // membership nor the main viewer's image settings are modified here.
  const IDENTITY = [[1,0,0],[0,1,0],[0,0,1]];
  const MARGINS = Object.freeze([2,4,8,16]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const point = (m, p) => [m[0][0]*p[0]+m[0][1]*p[1]+m[0][2], m[1][0]*p[0]+m[1][1]*p[1]+m[1][2]];
  const corners = r => [[r.x,r.y],[r.x+r.width,r.y],[r.x+r.width,r.y+r.height],[r.x,r.y+r.height]];

  function bounds(points) {
    let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
    for(const p of points) { x=Math.min(x,p[0]);y=Math.min(y,p[1]);right=Math.max(right,p[0]);bottom=Math.max(bottom,p[1]); }
    return {x,y,width:right-x,height:bottom-y};
  }
  function affine(input) {
    const m = input == null ? IDENTITY : input;
    if (!Array.isArray(m) || m.length !== 3 || !m.every(r=>Array.isArray(r) && r.length === 3 && r.every(Number.isFinite))
        || Math.abs(m[2][0]) > 1e-10 || Math.abs(m[2][1]) > 1e-10 || Math.abs(m[2][2]-1) > 1e-10
        || Math.abs(m[0][0]*m[1][1]-m[0][1]*m[1][0]) < 1e-14) {
      throw new Error('MSIの表示座標が不正です。');
    }
    return m.map(r=>r.slice());
  }
  function dimensions(source) {
    const width = Number(source && (source.naturalWidth || source.width));
    const height = Number(source && (source.naturalHeight || source.height));
    if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('MSI画像を読み込めません。');
    }
    return {width,height};
  }
  function marginValue(value) { return MARGINS.includes(Number(value)) ? Number(value) : 4; }

  // Input polygon is in measurement-centre coordinates, before section view
  // transforms. The sole +0.5 correction is here, shared by ROI/crop/locator.
  function geometry(frame, margin) {
    const size = dimensions(frame && frame.canvas);
    if (!Array.isArray(frame.polygon) || frame.polygon.length < 3
        || !frame.polygon.every(p=>Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      throw new Error('このMSI画像に対応するROI座標を確認できません。');
    }
    const transform = affine(frame.transform);
    const polygon = frame.polygon.map(p=>[p[0]+0.5,p[1]+0.5]);
    const nativeBounds = bounds(polygon), pad = marginValue(margin);
    if (nativeBounds.x > size.width || nativeBounds.y > size.height
        || nativeBounds.x+nativeBounds.width < 0 || nativeBounds.y+nativeBounds.height < 0) {
      throw new Error('ROIがMSI画像の範囲外です。');
    }
    // Floor/ceil are image edges, not resampled intensities. Degenerate tiny
    // polygons still produce a positive crop and never request a 0px canvas.
    const left = clamp(Math.floor(nativeBounds.x)-pad, 0, size.width-1);
    const top = clamp(Math.floor(nativeBounds.y)-pad, 0, size.height-1);
    const right = clamp(Math.ceil(nativeBounds.x+nativeBounds.width)+pad, left+1, size.width);
    const bottom = clamp(Math.ceil(nativeBounds.y+nativeBounds.height)+pad, top+1, size.height);
    const crop = {x:left,y:top,width:right-left,height:bottom-top};
    const whole = {x:0,y:0,width:size.width,height:size.height};
    const worldPolygon = polygon.map(p=>point(transform,p));
    const cropPolygon = corners(crop).map(p=>point(transform,p));
    return {size,transform,polygon,worldPolygon,nativeBounds,crop,whole,cropPolygon,
      wholeBounds:bounds(corners(whole).map(p=>point(transform,p))), cropBounds:bounds(cropPolygon)};
  }

  function newCanvas(createCanvas, width, height) {
    const canvas = createCanvas ? createCanvas(width,height) : document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    return canvas;
  }

  // The caller supplies the main viewer's msiValueEval/msiWindowEval functions;
  // normalization is not reimplemented. Native values, when available, bypass
  // the 8-bit PNG round trip in exactly the same way as renderComposite.
  function colorize(source, options) {
    const o = options || {}, {width,height} = dimensions(source);
    if (typeof o.evaluateValue !== 'function' || typeof o.evaluateLuminance !== 'function'
        || !Array.isArray(o.lut) || o.lut.length !== 256) throw new Error('MSIの配色設定が不正です。');
    const canvas = newCanvas(o.createCanvas,width,height), ctx = canvas.getContext('2d', {willReadFrequently:true});
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source,0,0);
    const pixels = ctx.getImageData(0,0,width,height), d = pixels.data;
    const vr = o.valueRaster, keep = o.keepGrid;
    const useValues = !!(vr && vr.W === width && vr.H === height && vr.values && vr.values.length === width*height);
    const useKeep = !!(keep && keep.W === width && keep.H === height && keep.keep && keep.keep.length === width*height);
    const bg = Array.isArray(o.background) && o.background.length >= 3 ? o.background : [0,0,0];
    const rawRange = Array.isArray(o.rawRange) && o.rawRange.length === 2 && o.rawRange.every(Number.isFinite) ? o.rawRange : null;
    const fallbackMax = Number.isFinite(o.fallbackMax) ? o.fallbackMax : (rawRange ? rawRange[1] : 255);
    for (let i=0;i<d.length;i+=4) {
      let color = bg;
      if (d[i+3] !== 0 && !(useKeep && keep.keep[i/4] === 0)) {
        const value = useValues ? vr.values[i/4] : NaN;
        const ev = Number.isFinite(value) ? o.evaluateValue(value,o.window,fallbackMax)
          : o.evaluateLuminance(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2],rawRange,o.window);
        if (!ev || !Number.isFinite(ev.n)) throw new Error('MSIの強度範囲を確認できません。');
        color = o.lut[Math.round(clamp(ev.n,0,1)*255)];
      }
      d[i]=color[0]; d[i+1]=color[1]; d[i+2]=color[2]; d[i+3]=255;
    }
    ctx.putImageData(pixels,0,0);
    return canvas;
  }

  function path(ctx, points) {
    ctx.beginPath(); ctx.moveTo(points[0][0],points[0][1]);
    for (let i=1;i<points.length;i++) ctx.lineTo(points[i][0],points[i][1]);
    ctx.closePath();
  }
  function cssColor(value, fallback) {
    if (Array.isArray(value) && value.length >= 3 && value.slice(0,3).every(Number.isFinite)) {
      return 'rgb('+value.slice(0,3).map(v=>Math.round(clamp(v,0,255))).join(',')+')';
    }
    return typeof value === 'string' && value.length ? value : fallback;
  }

  function scaleBar(imageMatrix, pitch, width) {
    if (!pitch || !(pitch.x > 0) || !(pitch.y > 0) || !Number.isFinite(pitch.x) || !Number.isFinite(pitch.y) || width < 100) return null;
    const T=imageMatrix, det=T[0][0]*T[1][1]-T[0][1]*T[1][0];
    // A horizontal screen segment can cross both native axes after rotation.
    const umPerPixel=Math.hypot(T[1][1]/det*pitch.x,-T[1][0]/det*pitch.y);
    if (!(umPerPixel > 0) || !Number.isFinite(umPerPixel)) return null;
    const target=Math.min(100,width*0.3), order=Math.pow(10,Math.floor(Math.log10(target*umPerPixel)));
    let length=order;
    for(const multiple of [1,2,5,10]) if(order*multiple/umPerPixel <= target) length=order*multiple;
    const display=length >= 1000 ? length/1000 : length;
    return {length,pixels:length/umPerPixel,umPerPixel,label:Number(display.toPrecision(3))+(length >= 1000 ? ' mm' : ' μm')};
  }

  function draw(canvas, frame, options) {
    const o = options || {};
    const width = Math.max(1,finite(o.width,canvas.clientWidth || canvas.width || 1));
    const height = Math.max(1,finite(o.height,canvas.clientHeight || canvas.height || 1));
    const dpr = clamp(finite(o.dpr,1),1,4);
    if (canvas.width !== Math.round(width*dpr)) canvas.width = Math.round(width*dpr);
    if (canvas.height !== Math.round(height*dpr)) canvas.height = Math.round(height*dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,width,height);
    ctx.fillStyle = cssColor(frame && frame.background,'#000'); ctx.fillRect(0,0,width,height);
    if (!frame) return null;
    const g = geometry(frame,o.margin), whole = o.mode === 'whole';
    const extent = whole ? g.wholeBounds : g.cropBounds;
    const fitScale = Math.min(width/extent.width,height/extent.height);
    const zoom = clamp(finite(o.zoom,1),0.05,256), scale = fitScale*zoom;
    const panX = finite(o.panX,0), panY = finite(o.panY,0);
    const x = width/2 + panX - (extent.x+extent.width/2)*scale;
    const y = height/2 + panY - (extent.y+extent.height/2)*scale;
    const screen = p=>[p[0]*scale+x,p[1]*scale+y];
    const T = g.transform;
    const imageMatrix = [[scale*T[0][0],scale*T[0][1],scale*T[0][2]+x],
      [scale*T[1][0],scale*T[1][1],scale*T[1][2]+y],[0,0,1]];
    ctx.save();
    ctx.beginPath(); ctx.rect(0,0,width,height); ctx.clip();
    ctx.transform(imageMatrix[0][0],imageMatrix[1][0],imageMatrix[0][1],imageMatrix[1][1],imageMatrix[0][2],imageMatrix[1][2]);
    ctx.imageSmoothingEnabled = false;
    const sourceRect = whole ? g.whole : g.crop;
    ctx.drawImage(frame.canvas,sourceRect.x,sourceRect.y,sourceRect.width,sourceRect.height,
      sourceRect.x,sourceRect.y,sourceRect.width,sourceRect.height);
    ctx.restore();
    const screenPolygon = g.worldPolygon.map(screen);
    if (o.outline !== false) {
      ctx.save();
      path(ctx,screenPolygon); ctx.lineJoin = 'round';
      ctx.lineWidth = 1.25; ctx.strokeStyle = cssColor(frame.roiColor,'#ffe066'); ctx.stroke();
      if (whole) {
        // Dashed viewport guide is explicitly different from the actual ROI.
        // At whole-section scale tiny ROI locations also receive hollow corner
        // brackets outside the ROI. Nothing is drawn across its centre.
        const guide = g.cropPolygon.map(screen);
        path(ctx,guide); ctx.setLineDash([4,3]); ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.setLineDash([]);
        const b = bounds(screenPolygon);
        if (b.width < 12 && b.height < 12) {
          const cx=b.x+b.width/2, cy=b.y+b.height/2, r=8, arm=4;
          ctx.beginPath();
          for (const sx of [-1,1]) for (const sy of [-1,1]) {
            ctx.moveTo(cx+sx*(r-arm),cy+sy*r); ctx.lineTo(cx+sx*r,cy+sy*r); ctx.lineTo(cx+sx*r,cy+sy*(r-arm));
          }
          ctx.strokeStyle = cssColor(frame.roiColor,'#ffe066'); ctx.stroke();
        }
      }
      ctx.restore();
    }
    const bar=o.scaleBar === false ? null : scaleBar(imageMatrix,frame.pixelPitch,width);
    if(bar && height >= 80) {
      ctx.save();ctx.fillStyle='rgba(0,0,0,.65)';ctx.fillRect(8,height-41,Math.max(bar.pixels+16,66),33);
      ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(16,height-16);ctx.lineTo(16+bar.pixels,height-16);ctx.stroke();
      ctx.font='11px system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom';ctx.fillStyle='#fff';ctx.fillText(bar.label,16,height-22);ctx.restore();
    }
    return {geometry:g,extent,fitScale,scale,imageMatrix,screenPolygon,width,height,zoom,panX,panY,scaleBar:bar};
  }

  function createViewport(host, options) {
    const o = options || {}, doc = host.ownerDocument || document, win = doc.defaultView || globalThis;
    const canvas = doc.createElement('canvas');
    canvas.className = 'roi-media-msi-canvas';
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab;';
    canvas.tabIndex = 0;
    canvas.setAttribute('role','img'); canvas.setAttribute('aria-label','ROIに対応するMSI画像');
    host.appendChild(canvas);
    let frame = null, mode = 'crop', margin = 4, outline = true, zoom = 1, panX = 0, panY = 0;
    let disposed = false, drag = null, last = null, observer = null;
    const listeners = [];
    function listen(target,type,handler,opts) { target.addEventListener(type,handler,opts); listeners.push(()=>target.removeEventListener(type,handler,opts)); }
    function render() {
      if (disposed) return;
      const rect = host.getBoundingClientRect();
      try {
        last = draw(canvas,frame,{width:rect.width || host.clientWidth || 1,height:rect.height || host.clientHeight || 1,
          dpr:win.devicePixelRatio || 1,mode,margin,outline,zoom,panX,panY});
        if (typeof o.onStatus === 'function') o.onStatus('',last);
      } catch (error) {
        last = null; draw(canvas,null,{width:rect.width || 1,height:rect.height || 1,dpr:win.devicePixelRatio || 1});
        if (typeof o.onStatus === 'function') o.onStatus(error.message || String(error),null);
      }
    }
    function fit() { zoom=1; panX=0; panY=0; render(); }
    function zoomBy(factor,anchor) {
      if (disposed || !frame || !(Number(factor)>0)) return;
      const next = clamp(zoom*Number(factor),0.05,256), ratio = next/zoom;
      const rect = host.getBoundingClientRect();
      const ax = anchor ? anchor[0]-rect.width/2 : 0, ay = anchor ? anchor[1]-rect.height/2 : 0;
      panX = ax+(panX-ax)*ratio; panY = ay+(panY-ay)*ratio; zoom = next; render();
    }
    listen(canvas,'wheel',event=>{
      event.preventDefault(); event.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      // deltaMode 1/2 are lines/pages rather than CSS pixels.
      const dy = event.deltaY*(event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      zoomBy(Math.exp(-clamp(dy,-500,500)*0.002),[event.clientX-rect.left,event.clientY-rect.top]);
    },{passive:false});
    listen(canvas,'pointerdown',event=>{
      if (event.button !== 0 || !frame || drag) return;
      event.preventDefault(); event.stopPropagation();
      if (typeof canvas.focus === 'function') canvas.focus({preventScroll:true});
      drag={id:event.pointerId,x:event.clientX,y:event.clientY,panX,panY}; canvas.style.cursor='grabbing';
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
    });
    listen(canvas,'pointermove',event=>{
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      panX=drag.panX+event.clientX-drag.x; panY=drag.panY+event.clientY-drag.y; render();
    });
    function release(event) {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      const id=drag.id; drag=null; canvas.style.cursor='grab';
      try { if (canvas.releasePointerCapture) canvas.releasePointerCapture(id); } catch (_) {}
    }
    listen(canvas,'pointerup',release); listen(canvas,'pointercancel',release); listen(canvas,'lostpointercapture',release);
    listen(canvas,'dblclick',event=>{event.preventDefault();event.stopPropagation();fit();});
    if (typeof win.ResizeObserver === 'function') { observer=new win.ResizeObserver(render);observer.observe(host); }
    else if (win.addEventListener) listen(win,'resize',render);
    render();
    return {
      canvas,
      setFrame(value) { if(disposed)return null;release();frame=value || null;fit();return last; },
      setMode(value) { if(disposed)return;mode=value==='whole'?'whole':'crop';fit(); },
      setMargin(value) { if(disposed)return;margin=marginValue(value);fit(); },
      setOutline(value) { if(disposed)return;outline=!!value;render(); },
      zoomBy,fit,resize:render,
      panBy(dx,dy) { if(disposed || !frame)return;panX+=finite(dx,0);panY+=finite(dy,0);render(); },
      destroy() { if(disposed)return;release();disposed=true;frame=null;last=null;if(observer)observer.disconnect();listeners.splice(0).forEach(fn=>fn());canvas.remove(); }
    };
  }

  return Object.freeze({MARGINS,geometry,colorize,draw,scaleBar,createViewport});
});
