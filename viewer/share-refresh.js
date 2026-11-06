(function(root,factory){
    const api=factory();
    if(typeof module==='object'&&module.exports)module.exports=api;
    else root.ShareRefresh=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
    'use strict';
    const error=(code,message)=>Object.assign(new Error(message),{code});
    function assertActive(signal){if(signal?.aborted)throw error('SHARE_REFRESH_CANCELLED','共有版の取得を中断しました。');}
    async function withDeadline(run,{signal,timeoutMs=45000}={}){
        assertActive(signal);
        const controller=new AbortController();
        let timer, listener;
        const stopped=new Promise((_,reject)=>{
            listener=()=>{controller.abort();reject(error('SHARE_REFRESH_CANCELLED','共有版の取得を中断しました。'));};
            signal?.addEventListener('abort',listener,{once:true});
            timer=setTimeout(()=>{controller.abort();reject(error('SHARE_REFRESH_TIMEOUT','サーバーの応答を待っています。接続を確認してから再度お試しください。'));},timeoutMs);
        });
        try{return await Promise.race([Promise.resolve().then(()=>run(controller.signal)),stopped]);}
        finally{clearTimeout(timer);signal?.removeEventListener('abort',listener);}
    }
    // Stream large originals with an inactivity deadline, rather than limiting
    // the total time of a healthy download on a slow connection.
    async function fetchBlob(url,{signal,stallMs=120000,onProgress,fetchImpl=fetch}={}){
        assertActive(signal);
        const controller=new AbortController();let timer,reader,loaded=0;
        const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
        const arm=()=>{clearTimeout(timer);timer=setTimeout(cancel,stallMs);};
        try{
            arm();const response=await fetchImpl(url,{signal:controller.signal});
            if(!response.ok){await response.body?.cancel();throw error('SHARE_SOURCE_FAILED','原本を取得できませんでした (HTTP '+response.status+')。');}
            const total=Number(response.headers.get('content-length'))||0;
            if(!response.body?.getReader)return await response.blob();
            reader=response.body.getReader();const parts=[];
            for(;;){assertActive(signal);const chunk=await reader.read();if(chunk.done)break;parts.push(chunk.value);loaded+=chunk.value.byteLength;arm();onProgress?.(loaded,total);}
            return new Blob(parts,{type:response.headers.get('content-type')||'application/octet-stream'});
        }catch(e){
            assertActive(signal);
            if(controller.signal.aborted)throw error('SHARE_REFRESH_TIMEOUT','原本のダウンロードが停止しました。接続を確認してから再度お試しください。');
            throw e;
        }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);try{await reader?.cancel();}catch(_){} }
    }
    function compare(project,doc){
        const local=project.shareInfo||{},revision=doc?.publish_revision;
        if(!Number.isSafeInteger(revision)||revision<0)throw error('SHARE_REVISION_MISSING','共有の公開版番号を確認できません。既存プロジェクトは更新していません。');
        const slug=doc?.slug||doc?.meta?.project_slug;
        if(slug&&slug!==local.slug)throw error('SHARE_TARGET_CHANGED','共有先が一致しません。既存プロジェクトは更新していません。');
        const remote=doc.sections||[],remoteIds=new Set(remote.map(s=>String(s.meta?.client_id||s.client_id||s.id)));
        const sections=project.sections||[],localIds=new Set(sections.map(s=>String(s.id)));
        const added=remote.filter(s=>!localIds.has(String(s.meta?.client_id||s.client_id||s.id)));
        const removed=sections.filter(s=>!remoteIds.has(String(s.id)));
        const known=Number.isSafeInteger(local.serverRevision)&&local.serverRevision>=0;
        return {revision,localRevision:known?local.serverRevision:null,localCount:sections.length,remoteCount:remote.length,
            added,removed,older:known&&revision<local.serverRevision,
            dirty:!!(project.__publishPending||local.pendingPublish),
            same:known&&revision===local.serverRevision&&added.length===0&&removed.length===0};
    }
    return {assertActive,withDeadline,fetchBlob,compare};
});
