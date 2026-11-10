/* Worker-owned source/ratio handles. Parsers and scientific functions are injected verbatim. */
(function(root,factory){
    const api=factory();api.workerSource=()=> '('+factory.toString()+')()';
    if(typeof module==='object'&&module.exports)module.exports=api;
    if(root)root.MsiAnalysisWorker=api;
})(typeof globalThis!=='undefined'?globalThis:this,function analysisWorkerFactory(){
    'use strict';
    const error=(code,message)=>Object.assign(new Error(message),{code});
    function create(options){
        const C=options.Core,F=options.functions,Ratio=options.RatioCore,Range=options.RoiRange;
        const maxBytes=options.maxBytes??128*1024*1024,cache=new Map(),inflight=new Map();
        let bytes=0,serial=0;
        function get(key){const row=cache.get(key);if(row){cache.delete(key);cache.set(key,row);}return row?.value;}
        function drop(key){const row=cache.get(key);if(row){bytes-=row.bytes;cache.delete(key);}}
        function retain(key,value,required=false){
            const size=C.retainedBytes(value);
            if(size>maxBytes){if(required)throw error('ANALYSIS_CAPACITY','この解析結果を保持するメモリ容量が不足しています。');return value;}
            drop(key);
            while(bytes+size>maxBytes&&cache.size)drop(cache.keys().next().value);
            cache.set(key,{value,bytes:size});bytes+=size;return value;
        }
        function use(handle,type){
            const found=handle&&get(handle.id);
            if(!found||type&&found.type!==type)throw error('ANALYSIS_HANDLE_EXPIRED','解析用の原本キャッシュを読み直してください。');
            return found;
        }
        function sourceKey(p){
            const d=p.def||{},kind=d.kind==='txt-analyte'?'txt':d.kind||'xlsx';
            const identity=d.blobId||d.sourceUrl||d.storagePath||d.path||p.sourceKey||p.cacheKey;
            if(!identity)return null;
            return 'decoded:'+JSON.stringify([kind,identity,d.sourceHash||d.sourceRevision||'',
                kind==='raw'?(d.func||1):kind==='xlsx'?(d.sheet||''):
                    [d.x||'x',d.y||'y',d.dataStartLine??4,Number.isFinite(d.compound_index)||Number.isFinite(d.v_index)||d.kind==='txt-analyte']]);
        }
        async function parsed(p){
            const key=sourceKey(p),hit=key&&get(key);if(hit)return hit;
            if(key&&inflight.has(key))return inflight.get(key);
            const task=(async()=>{
                if(!p.blob)throw error('ANALYSIS_SOURCE_MISSING','解析用の原本がありません。');
                const buf=await p.blob.arrayBuffer(),def=p.def||{};
                const value=def.kind==='raw'?{kind:'raw',data:await F.rawDecodeFunction(F.rawBundleFromZip(buf),def.func||1)}:
                    def.kind==='txt'||def.kind==='txt-analyte'?{kind:'txt',data:F.msiTextTable(buf,def)}:
                    {kind:'xlsx',data:F.parseXlsxSheet(buf,def)};
                if(key)retain(key,value);return value;
            })();
            if(key)inflight.set(key,task);
            try{return await task;}finally{if(key&&inflight.get(key)===task)inflight.delete(key);}
        }
        function rowsFrom(source,def){
            if(source.kind==='raw')return F.rawRowsFromDecoded(source.data,def);
            if(source.kind==='xlsx')return F.rowsFromParsedXlsx(source.data,def);
            const table=source.data,vi=F.msiTextValueColumn(table,def);
            const rows=table.records.map(r=>F.msiSourceRow(r.cells[table.xi],r.cells[table.yi],r.cells[vi],r.rowId));
            if(!rows.length)throw new Error('no measurement rows in txt');return rows;
        }
        async function rows(p){return rowsFrom(await parsed(p),p.def||{});}
        function gridReply(record,includeSnapshot){
            const snapshot=record.snapshot,g=snapshot.sourceGeometry.displayGeometry;
            const result={handle:{id:record.id},layerKey:record.layerKey,W:g.W,H:g.H,byteLength:record.byteLength,
                sourceGeometry:structuredClone(snapshot.sourceGeometry),sourceStats:structuredClone(snapshot.sourceStats)};
            if(includeSnapshot)result.snapshot={...structuredClone(snapshot),handle:{id:record.id}};
            return result;
        }
        function gridRecord(key,layerKey,snapshot){
            const id='grid:'+(key||++serial),record={type:'grid',id,layerKey,snapshot,byteLength:C.retainedBytes(snapshot)};
            retain(id,record,true);return record;
        }
        async function open(p){
            const entries=p.entries?.length?p.entries:[{layerKey:p.layerKey||'value',ent:p.def}],records=[];
            const keys=entries.map(item=>'grid:'+(p.key?p.key+'|'+item.layerKey:++serial));
            const hits=keys.map(key=>get(key));
            if(hits.every(Boolean))return gridReplies(hits,p.snapshots!==false);
            const source=await parsed(p);
            const matrix=F.msiMatrixFromRows(i=>rowsFrom(source,entries[i].ent),entries,p.def||entries[0].ent);
            let coordinates;
            for(let i=0;i<entries.length;i++){
                const item=entries[i],col=matrix.cols[i];
                // Legacy geometry is feature-specific, just like the paired
                // main-thread adapter: never let a second MRM change its axes.
                const geometry=F.createMsiSourceGeometry(matrix.positions,item.ent,[col]);
                const stats=F.msiSourceStats(F.msiMatrixRows(matrix.positions,col,matrix.rowIds));
                const snapshot=C.snapshot(matrix,col,geometry,stats,coordinates);coordinates=coordinates||snapshot;
                records.push(gridRecord(keys[i].slice(5),item.layerKey,snapshot));
            }
            // Returning already-evicted handles would make callers retry in a
            // loop. A multi-feature request must fit as one useful workset.
            if(records.some(record=>!cache.has(record.id)))throw error('ANALYSIS_CAPACITY','同時に保持する原本の列数を減らしてください。');
            return gridReplies(records,p.snapshots!==false);
        }
        function reply(grids){return grids.length===1?{...grids[0],grids}:{grids};}
        function gridReplies(records,includeSnapshots){
            const snapshots=includeSnapshots?structuredClone(records.map(record=>record.snapshot)):null;
            return reply(records.map((record,i)=>{const result=gridReply(record,false);
                if(snapshots)result.snapshot={...snapshots[i],handle:result.handle};return result;}));
        }
        function register(p){
            const id=p.key?'grid:'+p.key:null,hit=id&&get(id);if(hit)return gridReply(hit,p.snapshots!==false);
            let snapshot=p.snapshot;
            if(!snapshot){
                const section=C.parquetSection(p.section);
                const sourceRows=Array.from(F.parquetSourceRows(C.parquetColumn(p.column),section));
                // Parquet coordinates are already confirmed by its shared
                // geometry reader; retain that exact geometry, not a new grid.
                const matrix={positions:sourceRows,rowIds:sourceRows.map(row=>row.rowId),sourceFrame:F.msiSourceFrameKey(p.def)};
                const col={values:sourceRows.map(row=>row.v),sourceCells:sourceRows.map(row=>row.sourceCells?.v)};
                const geometry={...(p.sourceGeometry||section.sourceGeometry),sourceRef:F.msiSourceReference(p.def)};
                snapshot=C.snapshot(matrix,col,geometry,F.msiSourceStats(sourceRows));
            }else snapshot=structuredClone(snapshot);
            if(p.sourceGeometry)snapshot.sourceGeometry=structuredClone(p.sourceGeometry);
            const record=gridRecord(p.key,p.layerKey||'value',snapshot);return gridReply(record,p.snapshots!==false);
        }
        function numericReply(record){
            const n=record.numeric;
            const pair=structuredClone({numerator:record.left,denominator:record.right});
            const result={handle:{id:record.id},status:n.status,reason:n.reason,calculationVersion:n.calculationVersion,
                denominatorMin:n.denominatorMin,joinMethod:n.joinMethod,summary:structuredClone(n.summary),
                values:n.values?.slice(),valid:n.valid?.slice(),reasons:n.reasons?.slice(),denominatorOrder:n.denominatorOrder?.slice(),
                ...pair,
                sourceGeometry:structuredClone(record.left.sourceGeometry),...structuredClone(record.display)};
            result.retainedBytes=C.retainedBytes(result);return result;
        }
        function ratio(p){
            const id='ratio:'+(p.key||++serial),hit=get(id);if(hit)return numericReply(hit);
            const left={...use(p.leftHandle,'grid').snapshot},right={...use(p.rightHandle,'grid').snapshot};
            if(p.leftSourceFrame!==undefined)left.sourceFrame=p.leftSourceFrame;
            if(p.rightSourceFrame!==undefined)right.sourceFrame=p.rightSourceFrame;
            const numeric=Ratio.calculate(C.input(left,{materialize:true}),C.input(right,{materialize:true}),p.options||{});
            if(!numeric.values)return numeric;
            const display=numeric.status==='unavailable'?{}:C.ratioDisplay(numeric,left.sourceGeometry);
            // Keep only compact snapshots after the hot numeric loops. Ordinary
            // positions and status exceptions are temporary Worker workspace.
            numeric.numerator=C.input(left);numeric.denominator=C.input(right);numeric.positions=numeric.numerator.positions;
            const record={type:'ratio',id,left,right,numeric,display};retain(id,record,true);return numericReply(record);
        }
        const contains=(selection,geometry)=>(x,y)=>selection?.unavailable?null:
            F.roiContainsSourcePoint(selection?.poly,selection?.meta,selection?.geometry||geometry,x,y);
        function roi(p){
            const record=use(p.handle),snapshot=record.type==='ratio'?{...record.left,values:record.numeric.values,sourceCells:null}:record.snapshot;
            const selection=p.selection||{};
            if(selection.unavailable)return {values:[],unavailable:true,reason:selection.reason||'roi-geometry-unavailable'};
            const grid=C.grid(snapshot),result=F.collectRoiSourceRows(grid,selection.poly,selection.meta,selection.originalMeta===undefined?selection.meta:selection.originalMeta);
            result.stats=F.calcStats(result.values);
            if(p.includeValues===false){delete result.values;delete result.rowIds;if(result.legacyMembership)delete result.legacyMembership.rowIds;}
            return result;
        }
        function roiRange(p){
            const record=use(p.handle),snapshot=record.type==='ratio'?{...record.left,values:record.numeric.values,sourceCells:null}:record.snapshot;
            const polygons=p.polygons||[];
            return {status:'ready',raster:Range.summarizeRaster(p.raster,polygons.map(item=>
                (x,y)=>F.pointInPolygon(x,y,item.polyRaster)),{bakeMode:p.bakeMode,percentile:p.percentile}),
                source:Range.summarizeRows(C.rows(snapshot),polygons.map(item=>row=>contains(item.selection,snapshot.sourceGeometry)(row.x,row.y)))};
        }
        function ratioRoi(p){
            const record=use(p.handle,'ratio');
            return (p.selections||[]).map(selection=>{
                if(selection.unavailable)return {id:selection.id,status:'unavailable',reason:selection.reason,statistics:null};
                let unavailable=false;const test=contains(selection,record.left.sourceGeometry);
                const statistics=Ratio.summarize(record.numeric,(x,y)=>{const inside=test(x,y);if(inside===null)unavailable=true;return inside===true;});
                return {id:selection.id,status:unavailable?'unavailable':'ready',reason:unavailable?'roi-geometry-unavailable':null,statistics:unavailable?null:statistics};
            });
        }
        async function dispatch(op,p={}){
            if(op==='source-open')return open(p);
            if(op==='source-register')return register(p);
            if(op==='source-snapshot'){const record=use(p.handle,'grid');return {...structuredClone(record.snapshot),handle:{id:record.id}};}
            if(op==='ratio')return ratio(p);
            if(op==='roi')return roi(p);
            if(op==='roi-range')return roiRange(p);
            if(op==='ratio-roi')return ratioRoi(p);
            if(op==='ratio-keep'){const r=use(p.handle,'ratio');return C.ratioKeep(r.numeric,r.display.raster,p.x,p.y);}
            if(op==='parquet-geometry'){
                const result=F.buildParquetGeometryColumns(p.cols,p.roles);
                return {...result,sections:result.sections.map(C.packParquetSection)};
            }
            if(op==='parquet-raster')return F.buildParquetRasterValues(C.parquetColumn(p.col),C.parquetSection(p.sec),p.ent);
            if(op==='parquet-tic-start'){
                const id='parquet-tic:'+(++serial),slots=p.slots.map(slot=>({...slot,g:C.parquetSection(slot.g)}));
                retain(id,{type:'parquet-tic',id,slots},true);return {handle:{id}};
            }
            if(op==='parquet-tic-chunk'){
                const record=use(p.handle,'parquet-tic');
                return {statsByKey:F.accumulateParquetColumns(p.chunk,p.cols.map(C.parquetColumn),record.slots)};
            }
            if(op==='parquet-tic-finish'){
                const record=use(p.handle,'parquet-tic');drop(record.id);
                return {slots:record.slots.map(slot=>({t:{accum:slot.t.accum,count:slot.t.count},ticRaw:slot.ticRaw}))};
            }
            if(op==='analysis-release'){drop(p.handle?.id);return {released:true};}
            throw error('ANALYSIS_OPERATION','Unknown analysis operation: '+op);
        }
        return {dispatch,rows,snapshot:()=>({bytes,maxBytes,entries:cache.size,inflight:inflight.size})};
    }
    return {create};
});
