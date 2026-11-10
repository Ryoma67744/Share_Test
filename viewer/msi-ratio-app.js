/* Derived ratio UI and read-only source adapter. Never registers a measured MSI channel. */
(function(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MsiRatioApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
    'use strict';
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const csvCell = value => '"' + String(value == null || typeof value === 'number' && !Number.isFinite(value) ? '' : value).replace(/"/g,'""') + '"';
    const error = (message, code) => Object.assign(new Error(message), {code});
    const defaultDisplay = () => ({version:2,preset:'custom',aspectMode:'physical',rangePolicy:'maximum',colormap:'hotmetal',interpolation:'none',smoothingStrength:1,linearStrength:10});
    function install(h) {
        const app=h.app, Model=root.MsiRatioModel, Core=root.MsiRatioCore;
        if (!Model || !Core || app._ratioInstalled) return;
        app._ratioInstalled=true;
        let context=null, project=null, local={definitions:[],hidden:[],styles:{}}, cache=new Map(), entries=new Map(), workers=new Set(), selectionEpoch=0;
        const MAX_CACHE_BYTES=128*1024*1024;
        const shared=()=>!!(app.shareMode || app.project && app.project.__share);
        const keyOf=def=>Model.displayKey(def.id);
        const isRatio=key=>Model.isRatioKey(key,{schemaVersion:1,definitions:definitions()});
        function syncContext() {
            const next=h.contextKey();
            if(project===app.project && context===next)return;
            for(const worker of workers)worker.cancel();workers.clear();
            project=app.project;context=next;cache=new Map();entries=new Map();local={definitions:[],hidden:[],styles:{}};
            if(shared()&&context)try{const v=JSON.parse(sessionStorage.getItem('desi:ratios:'+context)||'null');if(v&&Array.isArray(v.definitions)){Model.normalizeRegistry({schemaVersion:1,definitions:v.definitions});local={definitions:v.definitions,hidden:Array.isArray(v.hidden)?v.hidden:[],styles:v.styles||{}};}}catch(_){}
        }
        function definitions() {
            syncContext();const reg=app.project&&app.project.meta&&app.project.meta.msiRatios;
            const saved=reg&&reg.schemaVersion===1&&Array.isArray(reg.definitions)?reg.definitions:[];
            return shared() ? saved.filter(d=>!local.hidden.includes(d.id)).concat(local.definitions) : saved;
        }
        const find=key=>definitions().find(d=>d.id===key||keyOf(d)===key)||null;
        const sectionId=sec=>Model.canonicalSectionId(sec);
        function binding(sec,def) {return def&&def.bindings&&(def.bindings[sectionId(sec)]||def.bindings[sec.id]);}
        function inputs(sec,key) {
            const def=find(key),b=binding(sec,def);
            if(!def||!b)throw error('この切片にはX / Yの対応がありません。','RATIO_BINDING_MISSING');
            const x=Model.resolveInput(sec,b.numerator),y=Model.resolveInput(sec,b.denominator);
            if(x.status!=='ready'||y.status!=='ready')throw error('入力が見つからないか変更されています。「比」で対応を指定し直してください。','RATIO_INPUT_MISSING');
            return {def,b,x,y};
        }
        function signature(sec,key) {
            syncContext();try{const p=inputs(sec,key);return Model.fingerprint([context,sectionId(sec),p.def.id,p.def.revision,p.def.denominatorMin,p.def.calculationVersion,p.b,h.sourceIdentity(sec,p.x.key),h.sourceIdentity(sec,p.y.key)]);}catch(e){return Model.fingerprint([context,sectionId(sec),key,e.code,find(key)]);}
        }
        function entry(sec,key) {
            if(!isRatio(key))return null;
            const def=find(key);if(!def||!binding(sec,def))return null;
            const stamp=signature(sec,key),id=sec.id+'|'+key;
            let rec=entries.get(id);if(rec&&rec.stamp===stamp){const result=cache.get(id)?.result;if(result){rec.entry.rawDispMax=display(key).outlierClip?result.robustMax:result.displayAuto.rawRange[1];rec.entry.bakeMode=display(key).outlierClip?'robust':'full';}return rec.entry;}
            let source=null;try{source=inputs(sec,key).x.entry;}catch(_){}
            const value={kind:'ratio',ratioId:def.id,compoundMeta:{name:h.safeName(def.name),base:h.safeName(def.name)},rawRange:[0,1],rawDispMax:1,rawTrueMax:null,bakeMode:'full',sourceReference:source&&h.sourceReference(source),sourceGeometry:source&&source.sourceGeometry};
            entries.set(id,{stamp,entry:value});return value;
        }
        function saveLocal(){if(shared()&&context)try{sessionStorage.setItem('desi:ratios:'+context,JSON.stringify(local));}catch(_){h.toast('このタブの比設定を保存できませんでした。');}}
        function store(def,previousId) {
            Model.normalizeRegistry({schemaVersion:1,definitions:[def]});
            syncContext();
            if(shared()){
                const own=local.definitions.find(d=>d.id===previousId);
                if(previousId&&!own){def.id=h.uid('ratio');def.revision=1;}
                local.definitions=local.definitions.filter(d=>d.id!==def.id);local.definitions.push(def);saveLocal();
            }else{
                const reg=app.project.meta&&app.project.meta.msiRatios;
                if(reg&&reg.schemaVersion!==1)throw error('この比定義は新しいアプリ版で作られています。対応版で編集してください。','RATIO_SCHEMA_UNSUPPORTED');
                const meta=app.project.meta||(app.project.meta={});
                meta.msiRatios={schemaVersion:1,definitions:definitions().filter(d=>d.id!==def.id).concat(def)};app.queueSave();
            }
            invalidate();return def;
        }
        function invalidate(){for(const task of workers)task.cancel();workers.clear();cache.clear();entries.clear();for(const p of app.panels.values())for(const key of Array.from(p.msiValueRasters.keys()))if(Model.isRatioKey(key)&&!p.section.msiSeries?.[key]){p.msiValueRasters.delete(key);delete p.imageSources[key];delete p.imageDataUrls[key];p._msiImageIdentity?.delete(key);p._msiLutCache?.delete(key);}app._roiDisplayRanges?.clear();refreshControls();}
        function trimCache() {
            let total=0;for(const rec of cache.values())total+=rec.bytes||0;
            for(const [key,rec] of cache){if(total<=MAX_CACHE_BYTES)break;if(!rec.result)continue;cache.delete(key);total-=rec.bytes||0;}
        }
        async function calculate(X,Y,options,assertCurrent,signal) {
            if(signal&&signal.aborted)throw error('比の計算を中止しました。','RATIO_CANCELLED');
            if(X.values.length<50000||typeof Worker==='undefined'){assertCurrent();return Core.calculate(X,Y,options);}
            return new Promise((resolve,reject)=>{
                const worker=new Worker(new URL('msi-ratio-worker.js',h.viewerBase).href);
                let finished=false,abortHandler=null;
                const cleanup=()=>{if(finished)return false;finished=true;if(signal&&abortHandler)signal.removeEventListener('abort',abortHandler);worker.terminate();workers.delete(task);return true;};
                const task={cancel(){if(cleanup())reject(error('比の計算を中止しました。','RATIO_CANCELLED'));}};
                workers.add(task);
                if(signal){abortHandler=()=>task.cancel();signal.addEventListener('abort',abortHandler,{once:true});if(signal.aborted){task.cancel();return;}}
                worker.onmessage=e=>{if(!cleanup())return;try{assertCurrent();if(e.data.error)throw error(e.data.error.message||e.data.error,'RATIO_CALCULATION');const result=e.data.result||e.data;resolve({...result,numerator:X,denominator:Y,positions:X.positions,rowIds:X.rowIds});}catch(err){reject(err);}};
                worker.onerror=e=>{if(cleanup())reject(error(e.message||'比の計算に失敗しました。','RATIO_WORKER'));};
                worker.postMessage({id:1,X,Y,options});
            });
        }
        async function inputData(grid,ent,assertCurrent,reference){
            const sourceFrame=h.frameKey(ent),chunks=[],chunkSize=50000,statuses=new Map();
            let positions=[],rowIds=[],sourceCells=null,chunk=null,n=0,exceptionCount=0,coordinateExceptionCount=0;
            let shared=!!reference&&reference.sourceFrame===sourceFrame;
            const compact=cell=>{
                if(!cell||!cell.status||cell.status==='valid')return null;
                if(!statuses.has(cell.status))statuses.set(cell.status,{status:cell.status});
                return statuses.get(cell.status);
            };
            // Keep original rows/tokens in the existing raw cache. The worker
            // only needs coordinates, row identity, values and exception status.
            for(const row of grid.rows){
                if(n&&n%chunkSize===0){await new Promise(ok=>setTimeout(ok,0));assertCurrent();}
                if(n%chunkSize===0){chunk=new Float64Array(chunkSize);chunks.push(chunk);}
                chunk[n%chunkSize]=row.v;
                const cells=row.sourceCells||{},cx=compact(cells.x),cy=compact(cells.y),cv=compact(cells.v);
                if(cx)coordinateExceptionCount++;if(cy)coordinateExceptionCount++;
                if(shared){
                    const p=reference.positions[n],pc=p&&p.sourceCells||{};
                    if(!p||reference.rowIds[n]!==row.rowId||!Object.is(p.x,row.x)||!Object.is(p.y,row.y)
                        ||(pc.x&&pc.x.status||null)!==(cx&&cx.status||null)||(pc.y&&pc.y.status||null)!==(cy&&cy.status||null)){
                        shared=false;positions=reference.positions.slice(0,n);rowIds=Array.from(reference.rowIds).slice(0,n);
                    }
                }
                if(!shared){const p={x:row.x,y:row.y};if(cx||cy)p.sourceCells={x:cx,y:cy};positions.push(p);rowIds.push(row.rowId);}
                if(cv){if(!sourceCells)sourceCells=[];sourceCells[n]=cv;exceptionCount++;}
                n++;
            }
            assertCurrent();
            const values=new Float64Array(n);
            for(let i=0;i<chunks.length;i++)values.set(chunks[i].subarray(0,Math.min(chunkSize,n-i*chunkSize)),i*chunkSize);
            if(shared){positions=n===reference.positions.length?reference.positions:reference.positions.slice(0,n);rowIds=n===reference.rowIds.length?reference.rowIds:reference.rowIds.slice(0,n);}
            if(sourceCells)sourceCells.length=n;
            return {positions,rowIds,sourceFrame,values,sourceCells,sourceGeometry:grid.sourceGeometry,
                _ratioExceptionCount:exceptionCount,_ratioCoordinateExceptionCount:coordinateExceptionCount};
        }
        function resultCacheBytes(result,raster,X,Y){
            let bytes=raster.values.byteLength+result.values.byteLength+result.valid.byteLength+result.reasons.byteLength+result.denominatorOrder.byteLength;
            const positions=new Set();
            for(const input of new Set([X,Y])){
                bytes+=input.values.byteLength;
                // Conservative JS-object allowance, not a claim about the VM's
                // exact heap layout. Count shared position/row-ID storage once.
                if(!positions.has(input.positions)){positions.add(input.positions);bytes+=input.positions.length*64+(input._ratioCoordinateExceptionCount||0)*32;}
                if(input.sourceCells)bytes+=input.sourceCells.length*8+(input._ratioExceptionCount||0)*32;
            }
            return bytes;
        }
        function numericBytes(result) {
            // Typed snapshots share buffers for identical inputs. Count each
            // buffer once; never materialize a million position/cell objects.
            const buffers=new Set();let bytes=0;
            const count=value=>{if(ArrayBuffer.isView(value)&&!buffers.has(value.buffer)){buffers.add(value.buffer);bytes+=value.byteLength;}};
            for(const key of ['values','valid','reasons','denominatorOrder','rgba'])count(result[key]);
            count(result.raster?.values);
            for(const input of [result.numerator,result.denominator])if(input){
                for(const key of ['x','y','values','rowIds'])count(input[key]);
                if(Array.isArray(input.rowIds))bytes+=input.rowIds.length*24;
            }
            return bytes;
        }
        function restoreNumeric(value,section,key,p,stamp,assertCurrent,service) {
            if(value.status==='unavailable')throw error('比を計算できません: '+value.reason,'RATIO_'+value.reason);
            const adapters=root.MsiAnalysisCore;
            if(!adapters)throw error('数値解析モジュールを利用できません。','ANALYSIS_UNAVAILABLE');
            const X=adapters.input(value.numerator),Y=value.denominator===value.numerator?X:adapters.input(value.denominator);
            const numeric={...value,numerator:X,denominator:Y,positions:X.positions,rowIds:X.rowIds};
            const raster=value.raster,max=value.summary.max,upper=value.displayAuto.rawRange[1];
            const ent=entry(section,key);Object.assign(ent,{rawRange:[0,upper],rawDispMax:upper,rawTrueMax:max,
                rasterW:raster.W,rasterH:raster.H,sourceGeometry:raster.sourceGeometry});
            entries.get(section.id+'|'+key).sourceGeometries={x:clone(X.sourceGeometry),y:clone(Y.sourceGeometry)};
            const out={...numeric,kind:'ratio',key,name:h.safeName(p.def.name),
                formula:h.inputLabel(section,p.x.key)+' / '+h.inputLabel(section,p.y.key),
                statistics:value.summary,inputSignature:stamp,sourceKey:p.x.key,frameSourceKey:p.x.key,
                sourceGeometry:raster.sourceGeometry,assertCurrent};
            Object.defineProperty(out,'_numericService',{value:service});
            return out;
        }
        async function resolveNumeric(section,key,options={}) {
            const service=typeof h.numericService==='function'?h.numericService():h.numericService;
            if(!service)throw error('数値解析Workerを利用できません。再読み込みしてお試しください。','ANALYSIS_UNAVAILABLE');
            const p=inputs(section,key),stamp=signature(section,key),owner=app.project,id=section.id+'|'+key;
            const controller=new AbortController(),signal=controller.signal,task={cancel:()=>controller.abort()};
            const abort=()=>controller.abort();workers.add(task);
            if(options.signal){options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();}
            const current=()=>!signal.aborted&&app.project===owner&&signature(section,key)===stamp&&(!options.current||options.current());
            const assertCurrent=()=>{if(!current())throw error('入力または比の条件が変更されました。再計算してください。',signal.aborted?'RATIO_CANCELLED':'RATIO_SOURCE_CHANGED');};
            const request=(op,payload,suffix)=>service.request(op,payload,{key:'ratio:'+stamp+':'+suffix,
                signal,current,priority:options.priority??10});
            async function build(force=false) {
                const readOptions={signal,current,force};let gx,gy;
                if(h.readPair)[gx,gy]=await h.readPair(section,p.x.key,p.y.key,readOptions);
                else {gx=await h.readGrid(section,p.x.key,readOptions);assertCurrent();gy=p.x.key===p.y.key?gx:await h.readGrid(section,p.y.key,readOptions);}
                assertCurrent();
                if(!gx?.handle||!gy?.handle)throw error('元の数値データを解析Workerへ読み込めません。','RATIO_SOURCE_UNAVAILABLE');
                const value=await request('ratio',{key:stamp,leftHandle:gx.handle,rightHandle:gy.handle,
                    leftSourceFrame:h.frameKey(p.x.entry),rightSourceFrame:h.frameKey(p.y.entry),
                    options:{denominatorMin:p.def.denominatorMin,coordinateConfirmed:!!p.b.coordinateConfirmed}},'calculate');
                assertCurrent();
                const result=restoreNumeric(value,section,key,p,stamp,assertCurrent,service);
                cache.set(id,{stamp,result,bytes:Number.isFinite(value.retainedBytes)?value.retainedBytes:numericBytes(value)});trimCache();return result;
            }
            try {
                assertCurrent();let rec=cache.get(id),result;
                if(!options.force&&rec?.stamp===stamp&&rec.result?._numericService===service&&service.isHandleCurrent(rec.result.handle)){
                    result=rec.result;cache.delete(id);cache.set(id,rec);
                }
                for(let attempt=0;attempt<2;attempt++)try {
                    if(!result)result=await build(options.force||attempt>0);
                    const keep=await ensureNumericKeep(section,key,result,{signal,current,priority:options.priority});
                    const roiStats=options.roiStats===false?null:await numericRoiStatistics(section,result,{signal,current,priority:options.priority});
                    assertCurrent();return {...result,assertCurrent,keepGrid:keep,...(roiStats?{roiStats}:{})};
                }catch(e){
                    assertCurrent();
                    if(attempt||e.code!=='ANALYSIS_HANDLE_EXPIRED')throw e;
                    if(cache.get(id)?.result===result)cache.delete(id);result=null;
                }
            } finally {workers.delete(task);options.signal?.removeEventListener('abort',abort);}
        }
        async function rasterize(result,geometry,assertCurrent) {
            const g=geometry&&geometry.displayGeometry;if(!g)throw error('測定座標の情報を取得できません。','RATIO_GEOMETRY');
            const W=g.W,H=g.H,values=new Float64Array(W*H).fill(NaN),counts=new Uint32Array(W*H);
            for(let i=0;i<result.values.length;i++){
                if(i&&i%50000===0){await new Promise(r=>setTimeout(r,0));assertCurrent();}
                if(!result.valid[i])continue;
                const p=result.positions[i],x=Math.round((p.x-g.x.origin)/g.x.step),y=Math.round((p.y-g.y.origin)/g.y.step);
                if(x<0||y<0||x>=W||y>=H)continue;
                const k=y*W+x,n=++counts[k],v=result.values[i];values[k]=n===1?v:values[k]+(v-values[k])/n;
            }
            return {W,H,values,sourceGeometry:clone(geometry)};
        }
        function ratioRows(result){return {[Symbol.iterator]:function*(){for(let i=0;i<result.values.length;i++){const p=result.positions[i];yield {x:p.x,y:p.y,rowId:result.rowIds&&result.rowIds[i],v:result.values[i]};}}};}
        function roiStatistics(section,result) {
            const ambiguousLegacy=new Set(Object.values(section.msiSeries||{}).map(ent=>h.sourceReference(ent))).size>1;
            const pair=inputs(section,result.key);
            return (app.project.rois||[]).filter(r=>r.polysBySection&&r.polysBySection[section.id]).map(roi=>{
                const poly=roi.polysBySection[section.id],meta=h.roiMeta(roi,section);
                if(!meta&&ambiguousLegacy)return {roiId:roi.id,name:roi.name||roi.id,status:'unavailable',reason:'legacy-roi-source-ambiguous',statistics:null};
                const denominator=meta&&meta.sourceRef===result.denominator.sourceGeometry.sourceRef;
                let geometry=denominator?result.denominator.sourceGeometry:result.sourceGeometry;
                let sourceEntry=denominator?pair.y.entry:pair.x.entry,preparedMeta=meta;
                if(meta&&meta.version==='msi-group-v1') {
                    const groups=root.MsiSpatialGroups;
                    if(!groups||!groups.roiCompatible(meta,result.numerator.sourceGeometry,section,pair.x.entry)
                        ||!groups.roiCompatible(meta,result.denominator.sourceGeometry,section,pair.y.entry))
                        return {roiId:roi.id,name:roi.name||roi.id,status:'unavailable',reason:'roi-group-mismatch',statistics:null};
                    geometry=result.sourceGeometry;sourceEntry=pair.x.entry;
                    // Compatibility is checked once, not once per measurement.
                    preparedMeta={...meta,version:'msi-source-v1',sourceRef:geometry.sourceRef};
                } else if(meta&&meta.sourceRef!==geometry.sourceRef)return {roiId:roi.id,name:roi.name||roi.id,status:'unavailable',reason:'roi-source-mismatch',statistics:null};
                let unavailable=false;
                const stats=Core.summarize(result,(x,y)=>{const inside=h.roiContains(poly,preparedMeta,geometry,x,y,section,sourceEntry);if(inside===null)unavailable=true;return inside===true;});
                return {roiId:roi.id,name:roi.name||roi.id,status:unavailable?'unavailable':'ready',reason:unavailable?'roi-geometry-unavailable':null,statistics:unavailable?null:stats};
            });
        }
        async function numericRoiStatistics(section,result,options) {
            const owner=app.project,roiStamp=Model.fingerprint([owner.rois||[],section.meta?.spatialGroups||null]);
            const ambiguousLegacy=new Set(Object.values(section.msiSeries||{}).map(ent=>h.sourceReference(ent))).size>1;
            const pair=inputs(section,result.key),rows=[],selections=[];
            for(const roi of app.project.rois||[]) {
                if(!roi.polysBySection?.[section.id])continue;
                const row={roiId:roi.id,name:roi.name||roi.id},poly=roi.polysBySection[section.id],meta=h.roiMeta(roi,section);
                const unavailable=reason=>Object.assign(row,{status:'unavailable',reason,statistics:null});
                rows.push(row);
                if(!meta&&ambiguousLegacy){unavailable('legacy-roi-source-ambiguous');continue;}
                const denominator=meta&&meta.sourceRef===result.denominator.sourceGeometry.sourceRef;
                let geometry=denominator?result.denominator.sourceGeometry:result.sourceGeometry;
                let sourceEntry=denominator?pair.y.entry:pair.x.entry,preparedMeta=meta;
                if(meta?.version==='msi-group-v1') {
                    const groups=root.MsiSpatialGroups;
                    if(!groups||!groups.roiCompatible(meta,result.numerator.sourceGeometry,section,pair.x.entry)
                        ||!groups.roiCompatible(meta,result.denominator.sourceGeometry,section,pair.y.entry)){
                        unavailable('roi-group-mismatch');continue;
                    }
                    geometry=result.sourceGeometry;sourceEntry=pair.x.entry;
                    preparedMeta={...meta,version:'msi-source-v1',sourceRef:geometry.sourceRef};
                }else if(meta&&meta.sourceRef!==geometry.sourceRef){unavailable('roi-source-mismatch');continue;}
                const selection=h.roiSelection?h.roiSelection(section,poly,preparedMeta,geometry,sourceEntry):{poly,meta:preparedMeta,geometry};
                if(selection.unavailable){unavailable(selection.reason||'roi-geometry-unavailable');continue;}
                selections.push({...selection,id:rows.length-1});
            }
            if(selections.length) {
                const snapshot=clone(selections);
                const computed=await result._numericService.request('ratio-roi',{handle:result.handle,selections:snapshot},
                    {...options,key:'ratio-roi:'+result.inputSignature+':'+Model.fingerprint(snapshot)});
                if(app.project!==owner||Model.fingerprint([owner.rois||[],section.meta?.spatialGroups||null])!==roiStamp)
                    throw error('集計中にROIが変更されました。再計算してください。','RATIO_SOURCE_CHANGED');
                for(const item of computed)Object.assign(rows[item.id],{status:item.status,reason:item.reason||null,statistics:item.statistics});
            }
            return rows;
        }
        function numericKeepInputs(section,key,result) {
            const pair=inputs(section,key),x=h.otsuGrid(section,pair.x.key),y=h.otsuGrid(section,pair.y.key);
            if(!x||!y)return null;
            const gx=result.numerator.sourceGeometry.displayGeometry,gy=result.denominator.sourceGeometry.displayGeometry;
            if(x.W!==gx.W||x.H!==gx.H||y.W!==gy.W||y.H!==gy.H)return null;
            return {x,y,stamp:JSON.stringify([h.otsuStamp(section),result.inputSignature])};
        }
        async function ensureNumericKeep(section,key,result,options={}) {
            const input=numericKeepInputs(section,key,result);if(!input)return null;
            if(result._keepStamp===input.stamp)return result._keep;
            const value=await result._numericService.request('ratio-keep',{handle:result.handle,x:input.x,y:input.y},
                {...options,key:'ratio-keep:'+input.stamp});
            if(options.current&&!options.current())throw error('比の計算を中止しました。','RATIO_CANCELLED');
            const retained=cache.get(section.id+'|'+key),bytes=value?.keep?.byteLength||0;
            if(retained?.result===result)retained.bytes+=bytes-(result._keepBytes||0);
            result._keepBytes=bytes;
            result._keepStamp=input.stamp;result._keep=value;trimCache();return value;
        }
        // Synchronous overlay/drawing guard. Keep the verified input frames
        // with the display entry even after the large numeric LRU is evicted.
        // Painting never starts another parse.
        function roiCompatible(section,key,meta) {
            syncContext();
            if(!meta||meta.version!=='msi-group-v1'||!root.MsiSpatialGroups)return false;
            try {
                const pair=inputs(section,key),record=entries.get(section.id+'|'+key);
                if(!record||!record.sourceGeometries||record.stamp!==signature(section,key))return false;
                return root.MsiSpatialGroups.roiCompatible(meta,record.sourceGeometries.x,section,pair.x.entry)
                    &&root.MsiSpatialGroups.roiCompatible(meta,record.sourceGeometries.y,section,pair.y.entry);
            } catch (_) { return false; }
        }
        async function resolve(section,key,options={}) {
            if(h.numericService){syncContext();return resolveNumeric(section,key,options);}
            syncContext();const p=inputs(section,key),stamp=signature(section,key),owner=app.project,id=section.id+'|'+key;
            const assertCurrent=()=>{if(app.project!==owner||signature(section,key)!==stamp||options.signal&&options.signal.aborted)throw error('入力または比の条件が変更されました。再計算してください。','RATIO_SOURCE_CHANGED');};
            let rec=cache.get(id);
            if(!rec||rec.stamp!==stamp){
                rec={stamp,bytes:0};cache.set(id,rec);
                rec.promise=(async()=>{
                    let gx,gy;
                    if(h.readPair)[gx,gy]=await h.readPair(section,p.x.key,p.y.key);
                    else if(h.frameKey(p.x.entry)===h.frameKey(p.y.entry)){
                        gx=await h.readGrid(section,p.x.key);assertCurrent();
                        if(p.x.key===p.y.key)gy=gx;
                        else{await new Promise(ok=>setTimeout(ok,0));assertCurrent();gy=await h.readGrid(section,p.y.key);}
                    }else [gx,gy]=await Promise.all([h.readGrid(section,p.x.key),h.readGrid(section,p.y.key)]);
                    assertCurrent();
                    if(!gx||!gy)throw error('元の数値データを読み込めません。','RATIO_SOURCE_UNAVAILABLE');
                    const X=await inputData(gx,p.x.entry,assertCurrent),Y=p.x.key===p.y.key?X:await inputData(gy,p.y.entry,assertCurrent,X);
                    const numeric=await calculate(X,Y,{denominatorMin:p.def.denominatorMin,coordinateConfirmed:!!p.b.coordinateConfirmed},assertCurrent,options.signal);assertCurrent();
                    if(numeric.status==='unavailable')throw error('比を計算できません: '+numeric.reason,'RATIO_'+numeric.reason);
                    numeric.sourceGeometry=clone(gx.sourceGeometry);
                    const raster=await rasterize(numeric,gx.sourceGeometry,assertCurrent);assertCurrent();
                    const max=numeric.summary.max,upper=Number.isFinite(max)&&max>0?max:1;
                    const ent=entry(section,key);Object.assign(ent,{rawRange:[0,upper],rawDispMax:upper,rawTrueMax:max,rasterW:raster.W,rasterH:raster.H,sourceGeometry:raster.sourceGeometry});
                    entries.get(id).sourceGeometries={x:clone(X.sourceGeometry),y:clone(Y.sourceGeometry)};
                    const finite=Float64Array.from(raster.values).filter(Number.isFinite).sort();
                    const robustMax=finite.length?finite[Math.floor((finite.length-1)*.999)]:upper;
                    const out={...numeric,kind:'ratio',key,name:h.safeName(p.def.name),formula:h.inputLabel(section,p.x.key)+' / '+h.inputLabel(section,p.y.key),denominatorMin:p.def.denominatorMin,raster,statistics:numeric.summary,inputSignature:stamp,sourceKey:p.x.key,frameSourceKey:p.x.key,sourceGeometry:raster.sourceGeometry,displayAuto:{rawRange:[0,upper],max},robustMax:robustMax>0?robustMax:upper,assertCurrent};
                    rec.result=out;rec.bytes=resultCacheBytes(numeric,raster,X,Y);trimCache();return out;
                })().catch(e=>{if(cache.get(id)===rec)cache.delete(id);throw e;});
            }else{cache.delete(id);cache.set(id,rec);}
            const result=await rec.promise;assertCurrent();
            const out={...result,assertCurrent,keepGrid:keepGrid(section,key,result)};
            if(options.roiStats!==false)out.roiStats=roiStatistics(section,result);
            return out;
        }
        function keepGrid(section,key,result) {
            const retained=cache.get(section.id+'|'+key)?.result;
            if(retained?._numericService) {
                const input=numericKeepInputs(section,key,retained);if(!input)return null;
                if(retained._keepStamp===input.stamp)return retained._keep;
                if(retained._keepPending!==input.stamp) {
                    retained._keepPending=input.stamp;
                    const owner=app.project,current=()=>app.project===owner&&signature(section,key)===retained.inputSignature;
                    ensureNumericKeep(section,key,retained,{current,priority:10}).then(()=>{
                        if(current())app.repaintAllMsi();
                    }).catch(e=>{
                        // A lost handle is rebuilt through the normal bounded
                        // service, never by a synchronous main-thread fallback.
                        if(e.code==='ANALYSIS_HANDLE_EXPIRED'&&current())resolve(section,key,{roiStats:false,current})
                            .then(()=>{if(current())app.repaintAllMsi();}).catch(()=>{});
                    }).finally(()=>{if(retained._keepPending===input.stamp)retained._keepPending=null;});
                }
                return null;
            }
            let pair;try{pair=inputs(section,key);}catch(_){return null;}
            const x=h.otsuGrid(section,pair.x.key),y=h.otsuGrid(section,pair.y.key);
            if(!x||!y)return null;
            const r=result||(cache.get(section.id+'|'+key)||{}).result;if(!r)return null;
            const gx=r.numerator.sourceGeometry.displayGeometry,gy=r.denominator.sourceGeometry.displayGeometry;
            if(x.W!==gx.W||x.H!==gx.H||y.W!==gy.W||y.H!==gy.H)return null;
            const stamp=[h.otsuStamp(section),r.inputSignature];
            if(r._keepStamp===JSON.stringify(stamp))return r._keep;
            const keep=new Uint8Array(r.raster.W*r.raster.H);
            for(let i=0;i<r.positions.length;i++){
                const a=r.positions[i],b=r.denominator.positions[r.denominatorOrder[i]];
                if(!Number.isFinite(a.x)||!Number.isFinite(a.y)||!b)continue;
                const ax=Math.round((a.x-gx.x.origin)/gx.x.step),ay=Math.round((a.y-gx.y.origin)/gx.y.step),bx=Math.round((b.x-gy.x.origin)/gy.x.step),by=Math.round((b.y-gy.y.origin)/gy.y.step);
                if(ax>=0&&ay>=0&&ax<x.W&&ay<x.H&&bx>=0&&by>=0&&bx<y.W&&by<y.H&&x.keep[ay*x.W+ax]&&y.keep[by*y.W+bx])keep[ay*x.W+ax]=1;
            }
            r._keepStamp=JSON.stringify(stamp);r._keep={W:r.raster.W,H:r.raster.H,keep};return r._keep;
        }
        function load(panel,key,options={}) {
            const stamp=signature(panel.section,key),epoch=panel._loadEpoch;
            const inflight=panel._msiLoadInFlight.get(key);
            if(inflight&&inflight.identity===stamp&&!inflight.signal?.aborted){
                app.promoteLayerLoad?.(panel,'msi:'+key+':'+stamp,options.priority,!!options.automatic);return inflight;
            }
            if(panel.isMsiLayerReady(key))return Promise.resolve(true);
            const run=async(request={})=>{
                const current=()=>!request.signal?.aborted&&!panel._destroyed&&panel._loadEpoch===epoch&&signature(panel.section,key)===stamp
                    &&(!options.current||options.current());
                try{
                    const result=await resolve(panel.section,key,{roiStats:false,signal:request.signal,current,priority:options.priority});
                    if(!current())return false;
                    const r=result.raster,canvas=document.createElement('canvas');canvas.width=r.W;canvas.height=r.H;
                    const ctx=canvas.getContext('2d'),image=ctx.createImageData(r.W,r.H),max=result.displayAuto.rawRange[1];
                    if(result.rgba)image.data.set(result.rgba);
                    else for(let i=0;i<r.values.length;i++)if(Number.isFinite(r.values[i])){const n=Math.round(Math.max(0,Math.min(1,r.values[i]/max))*255);image.data[i*4]=image.data[i*4+1]=image.data[i*4+2]=n;image.data[i*4+3]=255;}
                    ctx.putImageData(image,0,0);const url=canvas.toDataURL('image/png');
                    if(!await panel.attachImage(key,url,current)||!current())return false;
                    panel.imageDataUrls[key]=url;panel.msiValueRasters.set(key,r);panel._initLayerSettings(key);panel._msiImageIdentity.set(key,stamp);panel._msiLoadErrors.delete(key);panel._touchMsiLru(key);
                    updateStatus(panel,key,result.status==='empty'?'有効な比なし':app.otsuBgRemove&&!result.keepGrid?'TIC背景maskを利用できません':'');
                    return true;
                }catch(e){if(current()&&!['RATIO_CANCELLED','ANALYSIS_CANCELLED'].includes(e.code)&&e.name!=='AbortError'){delete panel.imageSources[key];delete panel.imageDataUrls[key];panel.msiValueRasters.delete(key);panel._msiLoadErrors.set(key,{identity:stamp,error:e});updateStatus(panel,key,e.message);}return false;}
                finally{if(panel._msiLoadInFlight.get(key)===promise)panel._msiLoadInFlight.delete(key);}
            };
            const promise=app.requestLayerLoad?app.requestLayerLoad(panel,'msi:'+key+':'+stamp,'msi',run,options):Promise.resolve().then(run);
            promise.identity=stamp;panel._msiLoadInFlight.set(key,promise);
            const clear=()=>{if(panel._msiLoadInFlight.get(key)===promise)panel._msiLoadInFlight.delete(key);};
            promise.then(clear,clear);return promise;
        }
        function updateStatus(panel,key,message){let node=panel.dom.canvasCell.querySelector('.ratio-status');if(!node){node=document.createElement('div');node.className='ratio-status';node.setAttribute('role','status');panel.dom.canvasCell.appendChild(node);}node.dataset.ratioKey=key;node.textContent=message;node.hidden=!message;}
        function display(key){const def=find(key);const value=def&&def.display||defaultDisplay();return {...defaultDisplay(),...value,...(shared()&&local.styles[key]||{})};}
        function saveStyle(key,patch){const def=find(key);if(!def)return;const next={...display(key),...patch};if(shared()){local.styles[key]=next;saveLocal();}else{def.display=next;app.queueSave();}refreshControls();}
        function refreshControls(){const select=document.getElementById('ratio-display-select');if(!select)return;const active=app.viewMode==='compound'?app.focusCompoundKey:app.panels.get(app.activeSectionId)?.activeMsiKey;select.innerHTML='<option value="">単分子</option>'+definitions().map(d=>'<option value="'+escape(keyOf(d))+'">'+escape(h.safeName(d.name))+'</option>').join('');select.value=isRatio(active)?active:'';}
        async function activate(key) {
            if(!app.project)return;
            const selection=++selectionEpoch;
            const projectAtStart=app.project,targets=app.viewMode==='free'?[app.panels.get(app.activeSectionId)].filter(Boolean):Array.from(app.panels.values());
            // Keep the complete scientific scope, but start visible panels
            // first and dispatch at most two display consumers at a time.
            targets.sort((a,b)=>Number(!!app.isSectionLoadWanted?.(b))-Number(!!app.isSectionLoadWanted?.(a)));
            const runTargets=async run=>{
                let next=0;
                const lane=async()=>{while(app.project===projectAtStart&&selection===selectionEpoch){
                    const panel=targets[next++];if(!panel)return;await run(panel);
                }};
                await Promise.all(Array.from({length:Math.min(2,targets.length)},lane));
            };
            const refresh=()=>{
                const style=app.getMsiDisplaySettings();app.msiSmoothing=style.interpolation;
                app.msiSmoothingStrength=style.smoothingStrength;app.msiLinearStrength=style.linearStrength;
                h.setColormap(style.colormap);app.refreshMsiDisplayControls();
                app.recomputeMsiAbsScale();app.repaintAllMsi();h.refreshToolbar();refreshControls();
            };
            if(!isRatio(key)){
                const previous=app._ratioPreviousKey;
                const fallback=previous&&app.project.sections.some(s=>s.msiSeries&&s.msiSeries[previous])?previous:Object.keys(app.project.sections[0]?.msiSeries||{})[0];
                if(app.viewMode==='compound'&&fallback)app.setFocusCompoundKey(fallback);
                await runTargets(async p=>{
                    const series=p.section.msiSeries||{},chosen=series[key]?key:app.viewMode==='free'&&series[p._ratioPreviousKey]?p._ratioPreviousKey:series[fallback]?fallback:Object.keys(series)[0];
                    if(!chosen||!await p.ensureMsiLayerLoaded(chosen)||app.project!==projectAtStart||selection!==selectionEpoch)return;
                    for(const k of [...p.visibleLayers])if(/^MSI_/i.test(k))p.visibleLayers.delete(k);
                    p.visibleLayers.add(chosen);p.activeMsiKey=chosen;
                    const status=p.dom.canvasCell.querySelector('.ratio-status');if(status)status.hidden=true;
                    p.setupCanvasSize();p.populateThumbnails();p.rebuildLayerBar();p.renderComposite();p.drawAllRois();
                });
                if(app.project===projectAtStart&&selection===selectionEpoch)refresh();return;
            }
            if(!isRatio(app.focusCompoundKey))app._ratioPreviousKey=app.focusCompoundKey;
            app.activeOverlay=null;
            for(const p of targets){if(!isRatio(p.activeMsiKey)&&p.section.msiSeries?.[p.activeMsiKey])p._ratioPreviousKey=p.activeMsiKey;updateStatus(p,key,'比を計算中…');p._msiLoadErrors.delete(key);}
            if(app.viewMode==='compound')app.setFocusCompoundKey(key);
            await runTargets(async p=>{if(await load(p,key,{priority:app.isSectionLoadWanted?.(p)?0:30,
                current:()=>app.project===projectAtStart&&selection===selectionEpoch})){if(app.project!==projectAtStart||selection!==selectionEpoch)return;for(const k of [...p.visibleLayers])if(/^MSI_/i.test(k))p.visibleLayers.delete(k);p.visibleLayers.add(key);p.activeMsiKey=key;p.setupCanvasSize();p.populateThumbnails();p.rebuildLayerBar();p.renderComposite();p.drawAllRois();}});
            if(app.project!==projectAtStart||selection!==selectionEpoch)return;refresh();
        }
        const format=v=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString(undefined,{maximumSignificantDigits:7}):'—';
        async function summaryTable(host,key) {
            const request=(host._ratioSummaryRequest||0)+1;host._ratioSummaryRequest=request;
            host._ratioSummaryController?.abort();const controller=new AbortController();host._ratioSummaryController=controller;
            const owner=app.project,sections=(owner.sections||[]).slice(),results=[];
            const definitionStamp=Model.fingerprint(find(key)),roiStamp=Model.fingerprint(owner.rois||[]);
            const sectionStamp=()=>Model.fingerprint((app.project?.sections||[]).map(sec=>[sec.id,sec.name,sec.displayName]));
            const expectedSections=sectionStamp(),inputsAtStart=sections.map(sec=>[sec,signature(sec,key)]);
            host.textContent='集計中…';
            const current=()=>{
                if(controller.signal.aborted||host._ratioSummaryRequest!==request||!host.isConnected)return false;
                if(app.project!==owner||Model.fingerprint(find(key))!==definitionStamp
                    ||Model.fingerprint(owner.rois||[])!==roiStamp||sectionStamp()!==expectedSections
                    ||inputsAtStart.some(([sec,stamp])=>signature(sec,key)!==stamp)){
                    host.textContent='集計中に比・入力・ROIが変わりました。ROI集計を再実行してください。';
                    return false;
                }
                return true;
            };
            for(const sec of sections){
                if(!current())return;
                try{const r=await resolve(sec,key,{signal:controller.signal,current});if(!current())return;r.assertCurrent();
                    // The table needs small summaries only. Do not retain each
                    // section's original numeric snapshots until the last row.
                    results.push({sec,r:{statistics:r.statistics,roiStats:r.roiStats}});}
                catch(e){if(!current())return;results.push({sec,error:e.message});}
            }
            if(!current())return;
            host.innerHTML='<div class="ratio-table-wrap"><table><thead><tr><th>切片 / ROI</th><th>総信号比</th><th>比の平均</th><th>比の中央値</th><th>有効 / 対象</th><th>有効率</th></tr></thead><tbody>'+results.map(({sec,r,error:e})=>e?'<tr><td>'+escape(sec.displayName||sec.name||sec.id)+'</td><td colspan="5">'+escape(e)+'</td></tr>':(r.roiStats.length?r.roiStats:[{name:'全測定位置',statistics:r.statistics}]).map(item=>{const s=item.statistics;return '<tr><td>'+escape(sec.displayName||sec.name||sec.id)+' / '+escape(item.name)+'</td>'+(s?'<td>'+format(s.totalRatio)+'</td><td>'+format(s.mean)+'</td><td>'+format(s.median)+'</td><td>'+s.nValid+' / '+s.nCandidate+'</td><td>'+format(100*s.validFraction)+'%</td>':'<td colspan="5">'+escape(item.reason||'集計不可')+'</td>')+'</tr>';}).join('')).join('')+'</tbody></table></div><p class="ratio-help">総信号比 = 同じ有効位置のXの合計 ÷ Yの合計。比の平均は各位置のX / Yの平均です。</p>';
        }
        async function exportCsv(key,kind) {
            const projectAtStart=app.project,def=clone(find(key));if(!def)return;
            const sectionsAtStart=projectAtStart.sections.slice(),definitionStamp=Model.fingerprint(def),roiStamp=Model.fingerprint(projectAtStart.rois||[]);
            const sectionStamp=()=>Model.fingerprint(app.project.sections.map(sec=>[sec.id,sec.name,sec.displayName]));
            const expectedSections=sectionStamp(),inputStamps=sectionsAtStart.filter(sec=>binding(sec,def)).map(sec=>[sec,signature(sec,key)]);
            const assertSnapshot=()=>{
                if(app.project!==projectAtStart||Model.fingerprint(find(key))!==definitionStamp
                    ||Model.fingerprint(projectAtStart.rois||[])!==roiStamp||sectionStamp()!==expectedSections
                    ||inputStamps.some(([sec,stamp])=>signature(sec,key)!==stamp))
                    throw error('出力中に比・入力・ROIが変わりました。もう一度出力してください。','RATIO_SOURCE_CHANGED');
            };
            const columns=kind==='summary'?['section_id','section','ratio_id','ratio','ROI_id','ROI','denominator_min','sum_X','sum_Y','total_ratio','mean_ratio','median_ratio','n_valid','n_candidate','valid_fraction','excluded_reasons','status','calculation_version']:['section_id','section','ratio_id','ratio','row_id_X','row_id_Y','x','y','X','Y','ratio_value','valid','invalid_reason','denominator_min','join_method','input_revision','calculation_version'];
            columns.push('project_id','project','numerator_name','denominator_name','numerator_ref_sha256','denominator_ref_sha256');
            if(kind==='summary')columns.push('input_revision');
            const parts=['\uFEFF'+columns.map(csvCell).join(',')+'\r\n'];
            const projectId=projectAtStart.id,projectName=projectAtStart.displayName||projectAtStart.name||'';
            for(const sec of sectionsAtStart){
                if(!binding(sec,def))continue;
                assertSnapshot();const r=await resolve(sec,key);r.assertCurrent();assertSnapshot();
                const input=inputs(sec,key),frozen=binding(sec,def);
                const identity=ref=>Model.fingerprint({source:ref.source,reader:ref.reader,feature:ref.feature});
                const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
                const [revisionHash,numeratorHash,denominatorHash]=await Promise.all([sha(signature(sec,key)),sha(identity(frozen.numerator)),sha(identity(frozen.denominator))]);
                const provenance=[projectId,projectName,h.safeName(h.inputLabel(sec,input.x.key)),h.safeName(h.inputLabel(sec,input.y.key)),numeratorHash,denominatorHash];
                assertSnapshot();
                if(kind==='summary'){
                    for(const row of r.roiStats.length?r.roiStats:[{roiId:'',name:'All measured positions',statistics:r.statistics,status:'ready'}]){const s=row.statistics||{};parts.push([sec.id,sec.displayName||sec.name,def.id,h.safeName(def.name),row.roiId,row.name,def.denominatorMin,s.sumX,s.sumY,s.totalRatio,s.mean,s.median,s.nValid,s.nCandidate,s.validFraction,JSON.stringify(s.reasonCounts||{}),row.status,def.calculationVersion,...provenance,revisionHash].map(csvCell).join(',')+'\r\n');}
                }else{
                    for(let from=0;from<r.values.length;from+=10000){assertSnapshot();let chunk='';for(let i=from;i<Math.min(from+10000,r.values.length);i++){const j=r.denominatorOrder[i],p=r.positions[i];chunk+=[sec.id,sec.displayName||sec.name,def.id,h.safeName(def.name),r.rowIds[i],r.denominator.rowIds[j],p.x,p.y,r.numerator.values[i],r.denominator.values[j],r.valid[i]?r.values[i]:null,r.valid[i],Core.reasonNames(r.reasons[i]).join('|'),def.denominatorMin,r.joinMethod,revisionHash,def.calculationVersion,...provenance].map(csvCell).join(',')+'\r\n';}parts.push(chunk);await new Promise(ok=>setTimeout(ok,0));r.assertCurrent();assertSnapshot();}
                }
            }
            assertSnapshot();h.download(new Blob(parts,{type:'text/csv;charset=utf-8'}),'ratio_'+kind+'_'+def.id+'.csv');
        }
        function openDialog(key) {
            if(!app.project){h.toast('プロジェクトを開いてください。');return;}
            if(app.project.meta?.msiRatios&&app.project.meta.msiRatios.schemaVersion!==1){h.toast('この比は新しいアプリ版で保存されています。対応版で表示・編集してください。');return;}
            const previousDialog=document.getElementById('msi-ratio-dialog');
            previousDialog?.querySelector('[data-ratio-results]')?._ratioSummaryController?.abort();previousDialog?.remove();
            let current=find(key);
            const draft=current?clone(current):{id:h.uid('ratio'),name:'',revision:1,operation:'divide',calculationVersion:'msi-ratio-v1',denominatorMin:0,numeratorPolicy:'nonnegative',invalidPolicy:'exclude',bindings:{},display:defaultDisplay()};
            const owner=app.project,dialog=document.createElement('dialog');dialog.id='msi-ratio-dialog';
            const sections=owner.sections||[];
            const options=(sec,value)=>'<option value="">選択してください</option>'+Object.keys(sec.msiSeries||{}).filter(k=>!isRatio(k)&&['txt','txt-analyte','raw','parquet','xlsx'].includes(sec.msiSeries[k].kind||'xlsx')).map(k=>'<option value="'+escape(k)+'" '+(k===value?'selected':'')+'>'+escape(h.inputLabel(sec,k)+(h.inputDetails?' — '+h.inputDetails(sec,k):''))+'</option>').join('');
            const selected=(sec,field)=>{const b=binding(sec,draft);if(b){const r=Model.resolveInput(sec,b[field]);if(r.status==='ready')return r.key;}return '';};
            dialog.innerHTML='<form method="dialog" class="ratio-title"><h2>比</h2><span>'+ (shared()?'このタブの個人設定':'プロジェクトに保存')+'</span><button aria-label="閉じる">閉じる</button></form><div class="ratio-body"><p>分子側（X）と分母側（Y）を選び、元の信号強度からX / Yを計算します。</p><div class="ratio-form"><label>保存した比<select data-ratio-saved><option value="">新しい比</option>'+definitions().map(d=>'<option value="'+escape(keyOf(d))+'" '+(current&&current.id===d.id?'selected':'')+'>'+escape(h.safeName(d.name))+'</option>').join('')+'</select></label><label>名称<input data-ratio-name value="'+escape(h.safeName(draft.name))+'" placeholder="X / Y"></label><label>分母下限（Y &gt; 下限）<input data-ratio-threshold type="number" min="0" step="any" value="'+draft.denominatorMin+'"></label></div><div class="ratio-table-wrap"><table><thead><tr><th>切片</th><th>分子側（X）</th><th>分母側（Y）</th><th>別ファイルの座標確認</th></tr></thead><tbody>'+sections.map((sec,i)=>'<tr data-ratio-section="'+i+'"><td>'+escape(sec.displayName||sec.name||sec.id)+'</td><td><select data-ratio-x aria-label="'+escape(sec.displayName||sec.name||sec.id)+' 分子側 X">'+options(sec,selected(sec,'numerator'))+'</select></td><td><select data-ratio-y aria-label="'+escape(sec.displayName||sec.name||sec.id)+' 分母側 Y">'+options(sec,selected(sec,'denominator'))+'</select></td><td><label><input type="checkbox" data-ratio-coordinates '+(binding(sec,draft)?.coordinateConfirmed?'checked':'')+'>同じ単位・原点の測定座標</label></td></tr>').join('')+'</tbody></table></div><p class="ratio-help">同じ元データでは元行IDで対応します。別ファイルは座標の単位・原点を確認したうえで、座標が完全に一意に対応する場合だけ計算できます。</p><div class="ratio-actions"><button data-ratio-swap>X / Yを入替</button><button data-ratio-apply class="ratio-primary">保存して表示</button><button data-ratio-summary>ROI集計</button><button data-ratio-csv="summary">ROI集計CSV</button><button data-ratio-csv="values">測定点CSV</button><button data-ratio-delete '+(!current?'disabled':'')+'>削除</button></div><p data-ratio-status role="status"></p><div data-ratio-results></div><p class="ratio-help">分母0・欠測は除外し、X=0で分母が有効な位置は比0を保持します。元データ・既存ROI集計は変更しません。</p></div>';
            document.body.appendChild(dialog);dialog.showModal();
            const searchLabel=document.createElement('label');searchLabel.className='ratio-input-search';searchLabel.textContent='入力を検索 ';
            const search=document.createElement('input');search.type='search';search.placeholder='分子名・ファイル・測定条件';search.setAttribute('aria-label','比の入力を検索');searchLabel.append(search);
            dialog.querySelector('.ratio-table-wrap').before(searchLabel);
            search.oninput=()=>{const terms=search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);for(const select of dialog.querySelectorAll('[data-ratio-x],[data-ratio-y]'))for(const option of select.options)option.hidden=!!option.value&&!option.selected&&!terms.every(term=>option.textContent.toLocaleLowerCase().includes(term));};
            let appliedKey=current?keyOf(current):null;
            const formStamp=()=>JSON.stringify([...dialog.querySelectorAll('[data-ratio-name],[data-ratio-threshold],[data-ratio-x],[data-ratio-y],[data-ratio-coordinates]')].map(el=>el.type==='checkbox'?el.checked:el.value));
            let appliedForm=appliedKey?formStamp():null;
            const requireSaved=()=>{if(!appliedKey||formStamp()!==appliedForm)throw new Error('変更を反映するには、先に「保存して表示」を押してください。');};
            const status=message=>{dialog.querySelector('[data-ratio-status]').textContent=message;};
            const read=()=>{
                if(app.project!==owner)throw error('プロジェクトが変わりました。開き直してください。','RATIO_SOURCE_CHANGED');
                const value=Number(dialog.querySelector('[data-ratio-threshold]').value);if(!Number.isFinite(value)||value<0)throw new Error('分母下限は0以上の数値にしてください。');
                const next={...clone(draft),bindings:{},denominatorMin:value,name:dialog.querySelector('[data-ratio-name]').value.trim(),revision:(current?current.revision:0)+1};
                for(const row of dialog.querySelectorAll('[data-ratio-section]')){const sec=sections[Number(row.dataset.ratioSection)],x=row.querySelector('[data-ratio-x]').value,y=row.querySelector('[data-ratio-y]').value;if(!x&&!y)continue;if(!x||!y)throw new Error((sec.displayName||sec.name||sec.id)+'のXとYを両方選んでください。');const a=sec.msiSeries[x],b=sec.msiSeries[y];if(!a||!b)throw new Error('入力が変更されました。選び直してください。');next.bindings[sectionId(sec)]={numerator:Model.makeInputRef(a,x),denominator:Model.makeInputRef(b,y),coordinateConfirmed:row.querySelector('[data-ratio-coordinates]').checked,coordinateEvidence:row.querySelector('[data-ratio-coordinates]').checked?'user-confirmed-same-coordinate-system':''};if(!next.name)next.name=h.inputLabel(sec,x)+' / '+h.inputLabel(sec,y);}
                if(!Object.keys(next.bindings).length)throw new Error('少なくとも1切片のXとYを選んでください。');return next;
            };
            const act=fn=>async()=>{try{await fn();}catch(e){status(e.message);}};
            dialog.querySelector('[data-ratio-saved]').onchange=e=>openDialog(e.target.value);
            dialog.querySelectorAll('[data-ratio-y]').forEach(el=>el.onchange=()=>{dialog.querySelector('[data-ratio-threshold]').value='0';status('分母が変わったため下限を0に戻しました。');});
            dialog.querySelector('[data-ratio-swap]').onclick=()=>{for(const row of dialog.querySelectorAll('[data-ratio-section]')){const x=row.querySelector('[data-ratio-x]'),y=row.querySelector('[data-ratio-y]'),old=x.value;x.value=y.value;y.value=old;}dialog.querySelector('[data-ratio-threshold]').value='0';status('分母が変わったため下限を0に戻しました。');};
            dialog.querySelector('[data-ratio-apply]').onclick=act(async()=>{const value=store(read(),current&&current.id);current=value;draft.id=value.id;appliedKey=keyOf(value);appliedForm=formStamp();dialog.querySelector('[data-ratio-delete]').disabled=false;status('比を計算中…');await activate(appliedKey);status('比を保存しました。利用できない切片には理由が表示されます。');await summaryTable(dialog.querySelector('[data-ratio-results]'),appliedKey);});
            dialog.querySelector('[data-ratio-summary]').onclick=act(async()=>{requireSaved();await summaryTable(dialog.querySelector('[data-ratio-results]'),appliedKey);});
            dialog.querySelectorAll('[data-ratio-csv]').forEach(btn=>btn.onclick=act(async()=>{requireSaved();status('CSVを作成中…');await exportCsv(appliedKey,btn.dataset.ratioCsv);status('CSVを出力しました。');}));
            dialog.querySelector('[data-ratio-delete]').onclick=act(async()=>{if(!current)return;if(shared()){local.definitions=local.definitions.filter(d=>d.id!==current.id);if(!local.hidden.includes(current.id))local.hidden.push(current.id);saveLocal();}else{app.project.meta.msiRatios.definitions=definitions().filter(d=>d.id!==current.id);app.queueSave();}invalidate();await activate('');dialog.close();});
            dialog.addEventListener('close',()=>{dialog.querySelector('[data-ratio-results]')?._ratioSummaryController?.abort();dialog.remove();},{once:true});
        }
        Object.assign(app,{getRatioDefinitions:definitions,ratioSignature:signature,ratioEntry:entry,
            ratioRoiCompatible:roiCompatible,
            ratioSourceKey(section,key){try{return inputs(section,key).x.key;}catch(_){return null;}},
            ratioKeys(section){return definitions().filter(d=>binding(section,d)).map(keyOf);},resolveRatio:resolve,openRatioDialog:openDialog,
            ratioKeepGrid:keepGrid,loadRatioLayer:load,activateRatio:activate,
            async ratioRawGrid(section,key,options={}){const r=await resolve(section,key,{...options,roiStats:false});return {rows:ratioRows(r),sourceGeometry:r.sourceGeometry,W:r.raster.W,H:r.raster.H,handle:r.handle,ratio:true};},
            getRatioDisplayStyle(key){const s=display(key);return {...s,kind:'ratio',mode:s.scaleMode||'same',lut:h.colormap(s.colormap),background:h.colormap(s.colormap)[0],smoothing:s.interpolation,otsu:app.otsuBgRemove};},
            ratioExportRegistry(includePersonal=true){syncContext();const saved=clone(app.project.meta?.msiRatios)||{schemaVersion:1,definitions:[]};return shared()&&includePersonal?{schemaVersion:1,definitions:clone(definitions()).map(d=>({...d,display:display(keyOf(d))}))}:saved;}
        });
        const activeKey=()=>app._ratioRenderingKey!==undefined?app._ratioRenderingKey:(app.viewMode==='free'?app.panels.get(app.activeSectionId)?.activeMsiKey:app.focusCompoundKey);
        const normalGet=app.getMsiDisplaySettings,normalUpdate=app.updateMsiDisplaySettings,normalFocus=app.setFocusCompoundKey;
        app.getMsiDisplaySettings=function(){const key=activeKey();if(isRatio(key)&&find(key))return {...display(key),explicit:true};return normalGet.call(this);};
        app.updateMsiDisplaySettings=function(patch,redraw=true){const key=activeKey();if(!isRatio(key)||!find(key))return normalUpdate.call(this,patch,redraw);saveStyle(key,patch);const s=display(key);this.msiSmoothing=s.interpolation;this.msiSmoothingStrength=s.smoothingStrength;this.msiLinearStrength=s.linearStrength;h.setColormap(s.colormap);this.refreshMsiDisplayControls();if(redraw)this.repaintAllMsi();};
        app.setFocusCompoundKey=function(key){const prev=this.focusCompoundKey;normalFocus.call(this,key);if(isRatio(key)||isRatio(prev)){const s=this.getMsiDisplaySettings();this.msiSmoothing=s.interpolation;this.msiSmoothingStrength=s.smoothingStrength;this.msiLinearStrength=s.linearStrength;h.setColormap(s.colormap);this.refreshMsiDisplayControls();for(const p of this.panels.values()){const node=p.dom.canvasCell.querySelector('.ratio-status');if(node)node.hidden=node.dataset.ratioKey!==key;}this.repaintAllMsi();}refreshControls();};
        const normalClip=app.setMsiOutlierClipAll,normalOtsu=app.setOtsuBgRemove;
        app.setMsiOutlierClipAll=function(on,options){const key=activeKey();if(!isRatio(key))return normalClip.call(this,on,options);this.updateMsiDisplaySettings({outlierClip:!!on,rangePolicy:on?'legacy':'maximum'});h.refreshToolbar();return Promise.resolve();};
        app.setOtsuBgRemove=function(on){if(!isRatio(activeKey()))return normalOtsu.call(this,on);this.otsuBgRemove=!!on;this._rerenderOtsu();h.refreshToolbar();return Promise.resolve();};
        const normalPreset=app.setMsiDisplayPreset;
        app.setMsiDisplayPreset=async function(name){
            const key=activeKey();if(!isRatio(key))return normalPreset.call(this,name);
            const windows=this.roiOnlyMode?this.msiRoiUserWindow:this.msiUserWindow;if(windows)delete windows[key];
            const next=root.MsiDisplaySettings.preset(name);next.outlierClip=name==='current';
            next.ranges=clone(display(key).ranges)||{version:1};delete next.ranges[this.roiOnlyMode?'roi':'whole'];next.scaleMode='same';
            const scale=document.getElementById('msi-scale-mode');if(scale)scale.value='same';
            this.updateMsiDisplaySettings(next);if(this.otsuBgRemove)await this.setOtsuBgRemove(false);
            h.refreshToolbar();
        };
        // Free-mode panels and thumbnails can show different derived styles.
        for(const method of ['renderComposite','renderMsiThumbnail']){
            const original=h.Panel.prototype[method];
            h.Panel.prototype[method]=function(...args){
                const key=method==='renderMsiThumbnail'?args[0]:app.viewMode==='compound'?app.focusCompoundKey:this.activeMsiKey;
                const saved={key:app._ratioRenderingKey,mode:app.msiSmoothing,median:app.msiSmoothingStrength,linear:app.msiLinearStrength,colormap:h.currentColormap()};
                const style=isRatio(key)&&find(key)?display(key):normalGet.call(app);
                app._ratioRenderingKey=key||null;app.msiSmoothing=style.interpolation;app.msiSmoothingStrength=style.smoothingStrength;app.msiLinearStrength=style.linearStrength;h.setColormap(style.colormap);
                try{return original.apply(this,args);}finally{app._ratioRenderingKey=saved.key;app.msiSmoothing=saved.mode;app.msiSmoothingStrength=saved.median;app.msiLinearStrength=saved.linear;h.setColormap(saved.colormap);}
            };
        }
        // Ratio windows are portable derived-display metadata. Individual ranges
        // use canonical section IDs; whole-image and ROI-only windows stay separate.
        const rangeScope=()=>app.roiOnlyMode?'roi':'whole';
        const rangeId=(key,section)=>display(key).scaleMode==='individual'?sectionId(section):'same';
        app.getRatioManualRange=function(key,section){return display(key).ranges?.[rangeScope()]?.[rangeId(key,section)]||null;};
        app.updateRatioRange=function(key,section,edge,value){
            if(!isRatio(key))return false;
            const ranges=clone(display(key).ranges)||{version:1},scope=rangeScope(),id=rangeId(key,section);
            const group=ranges[scope]||(ranges[scope]={});
            if(edge==='reset')delete group[id];
            else{
                // Disabling a focused, not-yet-ready toolbar input can emit a
                // final change with ''. An empty field must not become zero.
                if((typeof value!=='number'&&typeof value!=='string')||(typeof value==='string'&&!value.trim()))return false;
                const number=Number(value);if(!Number.isFinite(number))return false;
                const window={...(group[id]||{})};window[edge==='min'?'min':'max']=number;
                if(Number.isFinite(window.min)&&Number.isFinite(window.max)&&window.min>=window.max){
                    const gap=Math.abs((edge==='min'?window.max:window.min)||1)*1e-6+1e-9;
                    if(edge==='min')window.min=window.max-gap;else window.max=window.min+gap;
                }
                group[id]=window;
            }
            saveStyle(key,{ranges});app.repaintAllMsi();h.refreshToolbar();return true;
        };
        const normalWindow=app.getMsiWindow,normalScale=app.setMsiScaleMode;
        app.getMsiWindow=function(key,rawRange,dispMax,trueMax,section){
            if(!isRatio(key))return normalWindow.call(this,key,rawRange,dispMax,trueMax,section);
            h.rangeContext(key);
            const windows=this.roiOnlyMode?this.msiRoiUserWindow:this.msiUserWindow;
            const previous=windows[key],scale=this.msiScaleMode;
            windows[key]=this.getRatioManualRange(key,section);this.msiScaleMode=display(key).scaleMode||'same';
            try{return normalWindow.call(this,key,rawRange,dispMax,trueMax,section);}
            finally{if(previous===undefined)delete windows[key];else windows[key]=previous;this.msiScaleMode=scale;}
        };
        app.setMsiScaleMode=function(mode){const key=activeKey();if(!isRatio(key))return normalScale.call(this,mode);saveStyle(key,{scaleMode:mode==='individual'?'individual':'same'});this.repaintAllMsi();h.refreshToolbar();};
        const button=document.createElement('button');button.id='btn-msi-ratio';button.type='button';button.textContent='比';button.className='ratio-entry-button';button.onclick=()=>openDialog(isRatio(activeKey())?activeKey():null);
        const select=document.createElement('select');select.id='ratio-display-select';select.setAttribute('aria-label','単分子・比の表示選択');select.onchange=()=>activate(select.value).catch(e=>h.toast(e.message));
        const bar=document.createElement('div');bar.className='ratio-entry';bar.append(button,select);document.getElementById('method-actions')?.prepend(bar);refreshControls();
        return {definitions,entry,resolve,activate,openDialog,refreshControls,signature,store,invalidate,display,saveStyle,inputs,exportCsv};
    }
    return {install};
});
