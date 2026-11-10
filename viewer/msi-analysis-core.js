/* Compact, lossless source snapshots and lazy compatibility views. No DOM. */
(function(root,factory){
    const api=factory();api.workerSource=()=> '('+factory.toString()+')()';
    if(typeof module==='object'&&module.exports)module.exports=api;
    if(root)root.MsiAnalysisCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function analysisCoreFactory(){
    'use strict';
    const copy=value=>value==null?value:structuredClone(value);
    const token=value=>Object.is(value,-0)?'-0':String(value);
    function indexed(length,get){
        const target={length};
        return new Proxy(target,{get(object,key){
            if(key===Symbol.iterator)return function*(){for(let i=0;i<length;i++)yield get(i);};
            if(key==='at')return i=>get(i<0?length+i:i);
            if(key==='slice')return (start=0,end=length)=>Array.from({length:Math.max(0,Math.min(length,end)-Math.max(0,start))},(_,i)=>get(Math.max(0,start)+i));
            if(key==='map')return fn=>Array.from({length},(_,i)=>fn(get(i),i));
            if(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)){const i=Number(key);return i<length?get(i):undefined;}
            return object[key];
        }});
    }
    function packCells(cells,values){
        let defaults=null,any=false;const exceptions={};
        if(!cells)return null;
        // Pick one implicit valid-cell shape first. Entirely absent Parquet
        // coordinate metadata needs neither a dense null map nor a token copy.
        for(let i=0;i<values.length;i++){
            const cell=cells[i];if(!cell)continue;any=true;
            if(cell.status==='valid'&&Number.isFinite(values[i])&&Object.is(cell.value,values[i])&&cell.token===token(values[i])){
                defaults={...cell};delete defaults.value;delete defaults.token;break;
            }
        }
        if(!any)return null;
        const defaultKeys=Object.keys(defaults||{});
        for(let i=0;i<values.length;i++){
            const cell=cells&&cells[i];
            if(!cell){if(defaults)exceptions[i]=null;continue;}
            const simple=cell.status==='valid'&&Number.isFinite(values[i])&&Object.is(cell.value,values[i])&&cell.token===token(values[i]);
            const same=simple&&Object.keys(cell).length===defaultKeys.length+2
                &&defaultKeys.every(key=>Object.is(cell[key],defaults[key]));
            if(!same)exceptions[i]=copy(cell);
        }
        return any?{defaults,exceptions}:null;
    }
    function unpackCell(packed,value,index){
        if(!packed)return undefined;
        if(Object.prototype.hasOwnProperty.call(packed.exceptions||{},index))return packed.exceptions[index]||undefined;
        return packed.defaults?{...packed.defaults,token:token(value),value}:undefined;
    }
    function cell(snapshot,index,axis='v'){
        return unpackCell(axis==='v'?snapshot.sourceCells:snapshot.coordinateCells?.[axis],axis==='v'?snapshot.values[index]:snapshot[axis][index],index);
    }
    function snapshot(matrix,col,geometry,stats,sharedCoordinates){
        const positions=matrix.positions,n=positions.length;
        const values=Float64Array.from(col.values);
        if(sharedCoordinates){
            if(sharedCoordinates.x.length!==n)throw new Error('Shared source coordinates have different row counts');
            return {version:1,x:sharedCoordinates.x,y:sharedCoordinates.y,rowIds:sharedCoordinates.rowIds,
                coordinateCells:sharedCoordinates.coordinateCells,...(sharedCoordinates.legacyX?{legacyX:sharedCoordinates.legacyX,legacyY:sharedCoordinates.legacyY}:{}),
                values,sourceFrame:matrix.sourceFrame,sourceGeometry:copy(geometry),sourceStats:copy(stats),ratioCoordinateCells:false,
                sourceCells:packCells(col.sourceCells,values)};
        }
        const x=new Float64Array(n),y=new Float64Array(n);
        let legacyX,legacyY;
        const cx=new Array(n),cy=new Array(n);
        for(let i=0;i<n;i++){
            const p=positions[i];x[i]=p.x;y[i]=p.y;cx[i]=p.sourceCells?.x;cy[i]=p.sourceCells?.y;
            if(!legacyX&&(p.legacyX!==undefined||p.legacyY!==undefined)){legacyX=new Float64Array(n).fill(NaN);legacyY=new Float64Array(n).fill(NaN);}
            if(legacyX){legacyX[i]=p.legacyX;legacyY[i]=p.legacyY;}
        }
        const ids=matrix.rowIds||positions.map((p,i)=>p.rowId==null?i:p.rowId);
        return {version:1,x,y,values,rowIds:ids.every(id=>typeof id==='number')?Float64Array.from(ids):copy(ids),
            sourceFrame:matrix.sourceFrame,sourceGeometry:copy(geometry),sourceStats:copy(stats),ratioCoordinateCells:false,
            sourceCells:packCells(col.sourceCells,values),coordinateCells:{x:packCells(cx,x),y:packCells(cy,y)},
            ...(legacyX?{legacyX,legacyY}:{})};
    }
    function positions(snapshot,coordinateCells=true){
        return indexed(snapshot.x.length,i=>({x:snapshot.x[i],y:snapshot.y[i],rowId:snapshot.rowIds?.[i],
            ...(snapshot.legacyX?{legacyX:snapshot.legacyX[i],legacyY:snapshot.legacyY[i]}:{}),
            ...(coordinateCells?{sourceCells:{x:cell(snapshot,i,'x'),y:cell(snapshot,i,'y')}}:{})}));
    }
    function rows(snapshot){
        return {[Symbol.iterator]:function*(){for(let i=0;i<snapshot.values.length;i++)yield {
            x:snapshot.x[i],y:snapshot.y[i],v:snapshot.values[i],rowId:snapshot.rowIds?.[i],sourceCells:{v:cell(snapshot,i)}};}};
    }
    function grid(snapshot){
        const g=snapshot.sourceGeometry?.displayGeometry;
        return {W:g?.W,H:g?.H,rows:rows(snapshot),sourceGeometry:snapshot.sourceGeometry,sourceStats:snapshot.sourceStats,
            handle:snapshot.handle,snapshot};
    }
    function packParquetSection(section){
        const {sourceRows,...out}=section;
        if(!out.sourceCoordinates&&sourceRows){
            const n=sourceRows.length,x=new Float64Array(n),y=new Float64Array(n),rowIds=new Float64Array(n);
            for(let i=0;i<n;i++){const row=sourceRows[i];x[i]=row.x;y[i]=row.y;rowIds[i]=row.rowId;}
            out.sourceCoordinates={x,y,rowIds};
        }
        return out;
    }
    function parquetSection(section){
        return section?.sourceCoordinates?{...section,sourceRows:positions(section.sourceCoordinates,false)}:section;
    }
    function packParquetColumn(column){
        return column==null?column:{values:column,sourceCellStates:column._sourceCellStates||null};
    }
    function parquetColumn(column){
        if(column&&Object.prototype.hasOwnProperty.call(column,'sourceCellStates')&&column.values){
            if(column.sourceCellStates)column.values._sourceCellStates=column.sourceCellStates;
            return column.values;
        }
        return column;
    }
    function input(snapshot,options={}){
        // Ordinary ROI grids historically expose only the value cell. Keep
        // ratio's old inputData contract; coordinate metadata is still retained
        // losslessly in the snapshot for original-row/export adapters.
        const statusCells=packed=>{
            let out=null,count=0;const statuses=new Map();
            for(const [index,cell] of Object.entries(packed?.exceptions||{}))if(cell?.status&&cell.status!=='valid'){
                if(!out)out=new Array(snapshot.values.length);
                if(!statuses.has(cell.status))statuses.set(cell.status,{status:cell.status});
                out[index]=statuses.get(cell.status);count++;
            }
            return {cells:out,count};
        };
        const valueCells=statusCells(snapshot.sourceCells),xCells=snapshot.ratioCoordinateCells===false?{}:statusCells(snapshot.coordinateCells?.x),
            yCells=snapshot.ratioCoordinateCells===false?{}:statusCells(snapshot.coordinateCells?.y);
        const point=i=>{const p={x:snapshot.x[i],y:snapshot.y[i]},x=xCells.cells?.[i],y=yCells.cells?.[i];if(x||y)p.sourceCells={x:x||null,y:y||null};return p;};
        const points=options.materialize?Array.from({length:snapshot.values.length},(_,i)=>point(i)):indexed(snapshot.values.length,point);
        return {positions:points,rowIds:snapshot.rowIds,values:snapshot.values,
            sourceFrame:snapshot.sourceFrame,sourceGeometry:snapshot.sourceGeometry,
            sourceCells:valueCells.cells,
            _ratioExceptionCount:valueCells.count,_ratioCoordinateExceptionCount:(xCells.count||0)+(yCells.count||0)};
    }
    function rasterize(result,geometry){
        const g=geometry?.displayGeometry;if(!g)throw new Error('測定座標の情報を取得できません。');
        const W=g.W,H=g.H,values=new Float64Array(W*H).fill(NaN),counts=new Uint32Array(W*H);
        for(let i=0;i<result.values.length;i++){
            if(!result.valid[i])continue;
            const p=result.positions[i],x=Math.round((p.x-g.x.origin)/g.x.step),y=Math.round((p.y-g.y.origin)/g.y.step);
            if(x<0||y<0||x>=W||y>=H)continue;
            const k=y*W+x,n=++counts[k],v=result.values[i];values[k]=n===1?v:values[k]+(v-values[k])/n;
        }
        return {W,H,values,sourceGeometry:copy(geometry)};
    }
    function ratioDisplay(result,geometry){
        const raster=rasterize(result,geometry),max=result.summary.max,upper=Number.isFinite(max)&&max>0?max:1;
        const finite=Float64Array.from(raster.values).filter(Number.isFinite).sort();
        const robustMax=finite.length?finite[Math.floor((finite.length-1)*.999)]:upper;
        const rgba=new Uint8ClampedArray(raster.values.length*4);
        for(let i=0;i<raster.values.length;i++)if(Number.isFinite(raster.values[i])){
            const value=Math.round(Math.max(0,Math.min(1,raster.values[i]/upper))*255);
            rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=value;rgba[i*4+3]=255;
        }
        return {raster,robustMax:robustMax>0?robustMax:upper,displayAuto:{rawRange:[0,upper],max},rgba};
    }
    function ratioKeep(result,raster,x,y){
        const gx=result.numerator.sourceGeometry.displayGeometry,gy=result.denominator.sourceGeometry.displayGeometry;
        if(!x||!y||x.W!==gx.W||x.H!==gx.H||y.W!==gy.W||y.H!==gy.H)return null;
        const keep=new Uint8Array(raster.W*raster.H);
        for(let i=0;i<result.positions.length;i++){
            const a=result.positions[i],b=result.denominator.positions[result.denominatorOrder[i]];
            if(!Number.isFinite(a.x)||!Number.isFinite(a.y)||!b)continue;
            const ax=Math.round((a.x-gx.x.origin)/gx.x.step),ay=Math.round((a.y-gx.y.origin)/gx.y.step),
                bx=Math.round((b.x-gy.x.origin)/gy.x.step),by=Math.round((b.y-gy.y.origin)/gy.y.step);
            if(ax>=0&&ay>=0&&ax<x.W&&ay<x.H&&bx>=0&&by>=0&&bx<y.W&&by<y.H&&x.keep[ay*x.W+ax]&&y.keep[by*y.W+bx])keep[ay*raster.W+ax]=1;
        }
        return {W:raster.W,H:raster.H,keep};
    }
    function transferables(value){
        const found=new Set(),seen=new Set();
        const visit=v=>{if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);
            if(ArrayBuffer.isView(v)){found.add(v.buffer);return;}if(Object.prototype.toString.call(v)==='[object ArrayBuffer]'){found.add(v);return;}
            if(v instanceof Map){for(const [key,item] of v){visit(key);visit(item);}return;}
            if(v instanceof Set){for(const item of v)visit(item);return;}
            for(const key of Object.keys(v))visit(v[key]);};
        visit(value);return [...found];
    }
    // Conservative retention accounting, not a claim about any JS VM layout.
    function retainedBytes(value,seen=new Set()){
        if(value==null)return 0;if(typeof value==='string')return value.length*2+16;
        if(typeof value!=='object')return 8;if(seen.has(value))return 0;seen.add(value);
        if(ArrayBuffer.isView(value))return retainedBytes(value.buffer,seen)+32;
        if(Object.prototype.toString.call(value)==='[object ArrayBuffer]')return value.byteLength;
        let bytes=Array.isArray(value)?24+value.length*8:48;
        if(value instanceof Map){for(const [k,v] of value)bytes+=retainedBytes(k,seen)+retainedBytes(v,seen)+32;return bytes;}
        for(const key of Object.keys(value))bytes+=key.length*2+retainedBytes(value[key],seen);
        return bytes;
    }
    return {indexed,cell,snapshot,positions,rows,grid,packParquetSection,parquetSection,packParquetColumn,parquetColumn,input,rasterize,ratioDisplay,ratioKeep,transferables,retainedBytes};
});
