import * as XLSX from 'xlsx';
import { msiSourceRow, msiTextTable, msiTextValueColumn } from './source-cells.js';

// =============================================================================
// MSI parsing / ROI extraction — ported VERBATIM from the web app
// (viewer/index.html) so the connector's numbers match what the app shows.
// Keep these in sync with the app's a1ColToIndex / buildMsiGrid /
// parseXlsxToRows / parseTxtToRows / pointInPolygon.
// =============================================================================

export function a1ColToIndex(colRef) {
  if (typeof colRef === 'number') return colRef;
  const s = String(colRef || '').toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 65 || c > 90) return NaN;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export function pointInPolygon(x, y, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i][0], yi = vertices[i][1];
    const xj = vertices[j][0], yj = vertices[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Reconstruct the MSI pixel grid from raw rows exactly as the app does, so ROI
// polygons (which live in this pixel space) line up with the raw coordinates.
//
// The ordinal fallback COLLAPSES GAPS, changing the geometry. Kept in sync with the
// app: each axis reports which guard tripped and the result carries `gridFallback`.
// Nothing here consumes it yet — it exists so this stays a verbatim port.
export function buildLegacyMsiGrid(rows) {
    const xSet = new Set(), ySet = new Set();
    for (const r of rows) {
        if (!r) continue;
        if (Number.isFinite(r.x)) xSet.add(r.x);
        if (Number.isFinite(r.y)) ySet.add(r.y);
    }
    const ordinal = (vals) => new Map(vals.map((v, i) => [v, i]));
    const axis = (vals) => {
        const n = vals.length;
        // n <= 1 is degenerate, not a fallback: with one coordinate there is no
        // spacing to get wrong and nothing to collapse.
        if (n <= 1) return { index: ordinal(vals), size: Math.max(1, n), fallback: null };
        // Positive gaps between consecutive distinct coords. The pixel pitch is
        // picked from these below.
        const gaps = [];
        let minGap = Infinity;
        for (let i = 1; i < n; i++) {
            const d = vals[i] - vals[i - 1];
            if (d > 0) { gaps.push(d); if (d < minGap) minGap = d; }
        }
        if (!(minGap > 0) || !Number.isFinite(minGap)) return { index: ordinal(vals), size: n, fallback: 'pitch' };
        // 与えた step で格子を組めるか。組めたら {index,size}、無理なら理由だけ。
        const build = (step) => {
            const size = Math.round((vals[n - 1] - vals[0]) / step) + 1;
            // A coordinate grid should never dwarf the number of distinct
            // coordinates. Past a safety factor or an absolute cap the spacing is
            // too irregular (or noisy) to trust — fall back to ordinal indexing.
            const INFLATION_LIMIT = 4, ABS_CAP = 8192;
            if (!(size >= n) || size > ABS_CAP || size > n * INFLATION_LIMIT + 1) {
                return { fallback: 'inflation' };
            }
            const index = new Map();
            const used = new Set();
            for (const v of vals) {
                const k = Math.round((v - vals[0]) / step);
                // Two distinct coords landing in one cell => pitch is wrong for this
                // data; ordinal indexing is the safe choice.
                if (used.has(k)) return { fallback: 'collision' };
                used.add(k);
                index.set(v, k);
            }
            return { index, size, fallback: null };
        };
        // ★ ピッチは**差分の中央値**を先に試す。
        //   最小値は推定量として最も脆い。座標が 1 組でも真のピッチより近いと
        //   (ステージのジッタ / 浮動小数の誤差) step が過小になり、
        //   round((v-v0)/step) が座標を広げて、**飛んでいない走査線にも隙間**が入る。
        //   空きセルは NaN のまま透明に焼かれ (bakeRasterFromValues)、MSI は
        //   -90° 回転で描かれるので、格子の 1 行が**画面では縦線**として出る。
        //   膨張ガードは 4 倍まで許すので、軽度の膨張は無警告で通ってしまう。
        //
        //   完全な等間隔ラスタでは 中央値 == 最小値 なので**結果は一切変わらない**
        //   (既存画像・ROI 対応を動かさないことが最優先)。走査が実際に飛んでいる
        //   ときも差分の大半はピッチのままなので、中央値は真値を保つ =
        //   本物の欠測は今までどおり空きとして残る。
        //   疎な ROI データで中央値が大きすぎる場合は衝突するので、下の最小値
        //   経路へ退避する (= 従来とまったく同じ処理)。
        const sorted = gaps.slice().sort((a, b) => a - b);
        const median = sorted[(sorted.length - 1) >> 1];   // 偶数個は小さい側 (潰さない方)
        if (median > 0 && median !== minGap) {
            const byMedian = build(median);
            if (!byMedian.fallback) return byMedian;
        }
        const byMin = build(minGap);
        if (byMin.fallback) return { index: ordinal(vals), size: n, fallback: byMin.fallback };
        return byMin;
    };
    const ax = axis([...xSet].sort((a, b) => a - b));
    const ay = axis([...ySet].sort((a, b) => a - b));
    const gridFallback = (ax.fallback || ay.fallback)
        ? { x: ax.fallback || null, y: ay.fallback || null }
        : null;
    return { xIndex: ax.index, yIndex: ay.index, W: ax.size, H: ay.size, gridFallback };
}

export function buildMsiGrid(rows) {
    const xs = new Set(), ys = new Set();
    for (const r of rows || []) {
        if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
        xs.add(r.x); ys.add(r.y);
    }
    const axis = vals => {
        vals.sort((a,b) => a-b);
        const origin = vals.length ? vals[0] : 0;
        const span = vals.length ? vals[vals.length-1]-origin : 0;
        let step = Infinity;
        for (let i=1;i<vals.length;i++) step = Math.min(step, vals[i]-vals[i-1]);
        if (!(step > 0) || !Number.isFinite(step)) step = 1;
        step = Math.max(step, span / 4095);
        return { vals, origin, span, step, size: Math.max(1,Math.round(span/step)+1) };
    };
    const x=axis([...xs]), y=axis([...ys]);
    const factor=Math.max(1,Math.sqrt(x.size*y.size/4194304));
    for (const a of [x,y]) {
        a.step *= factor;
        a.size = Math.max(1, Math.floor(a.span/a.step)+1);
        // Include both ends; continuous positions preserve all intervening gaps.
        if (a.span && a.size>1) a.step=a.span/(a.size-1);
    }
    const ix=new Map(x.vals.map(v=>[v,Math.round((v-x.origin)/x.step)]));
    const iy=new Map(y.vals.map(v=>[v,Math.round((v-y.origin)/y.step)]));
    const displayGeometry={ version:'msi-proportional-v1', W:x.size, H:y.size,
        x:{origin:x.origin,step:x.step}, y:{origin:y.origin,step:y.step} };
    return {xIndex:ix,yIndex:iy,W:x.size,H:y.size,gridFallback:null,displayGeometry};
}

export function msiSourceReference(ent) {
    ent=ent||{};
    if(ent.sourceReference)return ent.sourceReference;
    return JSON.stringify([ent.sourceFileId||ent.blobId||ent.sourceUrl||'',ent.kind||'',
        ent.sheet||'',ent.func||1,ent.annotation||'',ent.sourceHash||ent.sourceRevision||'']);
}

export function createMsiSourceGeometry(rows, ent, legacyColumns) {
    const grid=buildMsiGrid(rows), legacyRows=rows.map(r=>({x:Number.isFinite(r.legacyX)?r.legacyX:r.x,y:Number.isFinite(r.legacyY)?r.legacyY:r.y})), legacy=buildLegacyMsiGrid(legacyRows);
    const pairs=axis=>{const out=new Map();for(let i=0;i<rows.length;i++){const raw=rows[i][axis],old=legacyRows[i][axis],index=(axis==='x'?legacy.xIndex:legacy.yIndex).get(old);if(Number.isFinite(raw)&&index!=null)out.set(raw,index);}return [...out].sort((a,b)=>a[0]-b[0]);};
    // Legacy polygons carried no source-coordinate contract. The old display
    // parser could remove an invalid-value row or coerce a blank coordinate to
    // zero, while the old ROI matrix retained a different coordinate set.
    // Confirm that these historical paths define the same axes before using
    // their polygon; retain new source-coordinate geometry even when they do not.
    let legacyReason=null;
    for(const row of rows) for(const axis of ['x','y']) {
        const cell=row.sourceCells&&row.sourceCells[axis];
        if(!Number.isFinite(row[axis]) || (cell&&cell.status!=='valid')) {
            legacyReason='legacy-coordinate-unconfirmed';break;
        }
    }
    if(!legacyReason && !(ent&&ent.kind==='parquet')) {
        let columns=legacyColumns ? (Array.isArray(legacyColumns)?legacyColumns:[legacyColumns]) : null;
        if(!columns) {
            if(rows.every(row=>Object.prototype.hasOwnProperty.call(row,'v'))) columns=[null];
            else legacyReason='legacy-value-axis-unconfirmed';
        }
        const oldFiniteValue=(row,i,col)=>{
            const cell=col ? col.sourceCells&&col.sourceCells[i] : row.sourceCells&&row.sourceCells.v;
            const value=col ? (col.values||[])[i] : row.v;
            if(!cell)return Number.isFinite(value);
            if(cell.sourceType==='e'&&Number.isFinite(cell.errorCode))return true;
            if(cell.type==='null')return true; // old Number(null) = 0
            if(cell.type==='undefined')return false;
            if(cell.type==='boolean')return true; // old Number(bool) = 0/1
            return Number.isFinite(Number(cell.token));
        };
        for(const col of columns||[]) {
            const displayRows=legacyRows.filter((_,i)=>oldFiniteValue(rows[i],i,col));
            const rendered=buildLegacyMsiGrid(displayRows);
            const sameAxis=axis=>[...rendered[axis]].every(([value,index])=>legacy[axis].get(value)===index);
            if(!displayRows.length || rendered.W!==legacy.W || rendered.H!==legacy.H
                || !sameAxis('xIndex') || !sameAxis('yIndex')) {
                legacyReason='legacy-render-quant-axis-mismatch';break;
            }
        }
    }
    return {sourceRef:msiSourceReference(ent),displayGeometry:grid.displayGeometry,
        legacy:{W:legacy.W,H:legacy.H,confirmed:!legacyReason,reason:legacyReason,
            x:pairs('x'),y:pairs('y')}};
}

export function msiAxisInterpolate(pairs, value, inverse) {
    if (!pairs || !pairs.length || !Number.isFinite(value)) return NaN;
    if(inverse){
        const groups=new Map();for(const p of pairs){const g=groups.get(p[1])||[0,0];g[0]+=p[0];g[1]++;groups.set(p[1],g);}
        pairs=[...groups].map(([index,g])=>[g[0]/g[1],index]);
    }
    const a=inverse?1:0,b=inverse?0:1;
    if(pairs.length===1) return pairs[0][b]+value-pairs[0][a];
    let lo=0,hi=pairs.length-1;
    while(hi-lo>1){const m=(lo+hi)>>1;if(pairs[m][a]<=value)lo=m;else hi=m;}
    const p=pairs[lo],q=pairs[hi];
    return p[b]+(value-p[a])*(q[b]-p[b])/(q[a]-p[a]);
}

export function msiValidRoiGeometry(meta) {
    if(!meta||meta.version!=='msi-source-v1'||typeof meta.sourceRef!=='string'||!meta.sourceRef)return false;
    const g=meta.displayGeometry;
    return !!(g&&g.version==='msi-proportional-v1'&&g.x&&g.y
        &&Number.isFinite(g.x.origin)&&Number.isFinite(g.y.origin)
        &&Number.isFinite(g.x.step)&&g.x.step>0&&Number.isFinite(g.y.step)&&g.y.step>0
        &&Number.isInteger(g.W)&&g.W>0&&Number.isInteger(g.H)&&g.H>0);
}

export function roiContainsSourcePoint(poly,meta,geometry,x,y) {
    if(!Number.isFinite(x)||!Number.isFinite(y)||!geometry)return false;
    if(msiValidRoiGeometry(meta)) {
        if(meta.sourceRef!==geometry.sourceRef)return null;
        const g=meta.displayGeometry;
        if(!g||!g.x||!g.y)return null;
        return pointInPolygon((x-g.x.origin)/g.x.step,(y-g.y.origin)/g.y.step,poly);
    }
    if(meta)return null;
    const g=geometry.legacy;
    if(!g||g.confirmed===false)return null;
    return pointInPolygon(msiAxisInterpolate(g.x,x,false),msiAxisInterpolate(g.y,y,false),poly);
}

// xlsx ArrayBuffer/Buffer → [{x,y,v}] using the def stored in the project doc's
// storage_paths.msiSeries entry (sheet / data_start_row / col_x / col_y / col_v).
function rowsFromParsedXlsx(parsed, def) {
    const aoa = parsed && parsed.aoa;
    if (!Array.isArray(aoa)) throw new Error('invalid parsed xlsx sheet');
    const startIdx = Math.max(0, (def.data_start_row || 1) - 1);
    const xi = a1ColToIndex(def.col_x), yi = a1ColToIndex(def.col_y), vi = a1ColToIndex(def.col_v);
    if (![xi, yi, vi].every(i => Number.isInteger(i) && i >= 0)) throw new Error('invalid xlsx column refs');
    const rows = [];
    for (let i = startIdx; i < aoa.length; i++) {
        const r = aoa[i] || [];
        const row = msiSourceRow(r[xi], r[yi], r[vi], i);
        if (parsed.sheet) {
            for (const [key, column] of [['x', xi], ['y', yi], ['v', vi]]) {
                const cell = parsed.sheet[XLSX.utils.encode_cell({ r: i, c: column })];
                if (!cell) continue;
                row.sourceCells[key].sourceType = cell.t;
                if (cell.f != null) row.sourceCells[key].formula = cell.f;
                if (cell.t === 'e') {
                    row[key] = NaN;
                    row.sourceCells[key].value = NaN;
                    row.sourceCells[key].status = 'invalid-cell';
                    row.sourceCells[key].errorCode = cell.v;
                    row.sourceCells[key].token = cell.w != null ? String(cell.w) : '#EXCEL_ERROR:' + String(cell.v);
                }
            }
        }
        rows.push(row);
    }
    if (!rows.length) throw new Error('no measurement rows in xlsx');
    return rows;
}

export function parseXlsxToRows(buf, def) {
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const sheet = wb.Sheets[def.sheet || wb.SheetNames[0]];
  if (!sheet) throw new Error('xlsx sheet not found');
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  return rowsFromParsedXlsx({ aoa, sheet }, def);
}

export function parseTxtToRows(buf, def) {
    const table = msiTextTable(buf, def);
    const vi = msiTextValueColumn(table, def);
    const rows = table.records.map(r => msiSourceRow(r.cells[table.xi], r.cells[table.yi], r.cells[vi], r.rowId));
    if (!rows.length) throw new Error('no measurement rows in txt');
    return rows;
}

// Synchronous formats only. kind:'raw' is async (ZIP inflation) and is
// dispatched in rows.js/loadRowsForDef alongside parquet, so this stays sync
// and callers never have to guess whether the result is a promise.
export function parseMsiRows(buf, def) {
  return (def && (def.kind === 'txt' || def.kind === 'txt-analyte')) ? parseTxtToRows(buf, def) : parseXlsxToRows(buf, def);
}

// Extract RAW MSI values inside an ROI polygon. Mirrors the app's export path
// (appendRoisToAnalyteLines): map each raw row to its grid pixel cell via
// buildMsiGrid, then pointInPolygon on pixel coords. Returns the raw intensity
// values (NOT the 0-255 display luminance the analysis chart uses).
export function extractRoiValues(rows, polyMsi, precomputedGrid, roiGeometry, ent) {
  const out=[];out.rowIds=[];out.nUniqueCoordinates=0;
  if(!polyMsi||!polyMsi.length)return out;
  const geometry=precomputedGrid&&precomputedGrid.sourceRef?precomputedGrid:createMsiSourceGeometry(rows,ent);
  if(!roiGeometry&&geometry.legacy&&geometry.legacy.confirmed===false)
    throw new Error('Legacy ROI geometry is unconfirmed: '+geometry.legacy.reason+'; original polygon was preserved');
  const coords=new Set();
  for(const [i,r] of rows.entries()) {
    const inside=roiContainsSourcePoint(polyMsi,roiGeometry,geometry,r.x,r.y);
    if(inside===null)throw new Error('ROI source geometry cannot be resolved');
    if(!inside)continue;
    const cell=r.sourceCells&&r.sourceCells.v;
    if(cell&&(cell.status==='unsafe-integer'||cell.status==='unsupported-decimal'||cell.status==='unsupported-type'))
      throw new Error('ROI contains values whose source precision is unsupported');
    if(!Number.isFinite(r.v))continue;
    out.push(r.v);out.rowIds.push(r.rowId==null?i:r.rowId);coords.add(r.x+'|'+r.y);
  }
  out.nUniqueCoordinates=coords.size;return out;
}

export function stats(values) {
  const selected=Array.from(values||[]).filter(Number.isFinite);
  const n = selected.length;
  if (!n) return { n: 0, mean: null, min: null, max: null, median: null, q1: null, q3: null, sd: null };
  const a = Float64Array.from(selected).sort();
  const at = (p) => a[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  let sum = 0; for (const v of selected) sum += v;
  const mean = sum / n;
  let varsum = 0; for (const v of selected) varsum += (v - mean) * (v - mean);
  return {
    n,
    nUniqueCoordinates:values.nUniqueCoordinates??null,
    rowIds:values.rowIds||null,
    mean,
    min: a[0],
    max: a[n - 1],
    median: at(0.5),
    q1: at(0.25),
    q3: at(0.75),
    sd: Math.sqrt(varsum / n),
  };
}
