/* One bounded numerical worker; immutable inputs stay owned by their callers. */
(function(root,factory){
    const api=factory();
    if(typeof module==='object'&&module.exports)module.exports=api;
    if(root)root.MsiAnalysisService=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
    'use strict';
    const failure=(message,code,name)=>Object.assign(new Error(message),{code,...(name?{name}:{})});
    const cancelled=()=>failure('Analysis request cancelled','ANALYSIS_CANCELLED','AbortError');
    const expired=()=>failure('Analysis source handle expired; reload the original source','ANALYSIS_HANDLE_EXPIRED');
    function create(options={}){
        const factory=options.createWorker||(()=>{
            if(typeof Worker==='undefined'||!options.workerUrl)throw failure('Analysis Worker unavailable','ANALYSIS_WORKER_UNAVAILABLE');
            return new Worker(options.workerUrl);
        });
        const arm=options.setTimeout||setTimeout,disarm=options.clearTimeout||clearTimeout;
        const defaultTimeout=Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:180000;
        const maxQueued=Number.isInteger(options.maxQueued)&&options.maxQueued>0?options.maxQueued:64;
        const jobs=new Map(),queue=[],waiting=[];
        let generation=1,sequence=0,worker=null,active=null,disposed=false,pumping=false;
        let backgroundTimer=null,backgroundReady=false;
        function clearBackgroundTurn(){
            if(backgroundTimer!=null)disarm(backgroundTimer);
            backgroundTimer=null;backgroundReady=false;
        }
        const valid=consumer=>{try{return !consumer.signal?.aborted&&(!consumer.current||consumer.current()!==false);}catch(_){return false;}};
        const isHandleCurrent=handle=>!!handle&&!disposed&&handle.generation===generation;
        function handlesCurrent(payload){
            for(const key of ['handle','leftHandle','rightHandle'])
                if(payload&&payload[key]!=null&&!isHandleCurrent(payload[key]))return false;
            return true;
        }
        function finish(consumer,error,value){
            if(consumer.done)return;
            consumer.done=true;if(consumer.timer!=null)disarm(consumer.timer);
            consumer.signal?.removeEventListener('abort',consumer.abort);
            consumer.job.consumers.delete(consumer);
            if(!error&&!valid(consumer))error=cancelled();
            if(error)consumer.reject(error);else consumer.resolve(value);
        }
        function remove(job){
            if(job.key!=null&&jobs.get(job.key)===job)jobs.delete(job.key);
            const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);
            const waiter=waiting.indexOf(job);if(waiter>=0)waiting.splice(waiter,1);
        }
        function settleJob(job,error,value){
            remove(job);if(active===job)active=null;
            for(const consumer of [...job.consumers])finish(consumer,error,value);
        }
        function discardWorker(reason){
            clearBackgroundTurn();
            const previous=worker;worker=null;
            if(previous){previous.onmessage=null;previous.onerror=null;previous.onmessageerror=null;try{previous.terminate();}catch(_){}}
            generation++;
            try{options.onReset?.({generation,reason});}catch(_){}
        }
        function reset(reason){
            const error=reason instanceof Error?reason:failure(String(reason||'Analysis Worker reset'),'ANALYSIS_WORKER_RESET');
            const running=active;if(running)settleJob(running,error);
            discardWorker(error);pump();
        }
        function stopUnused(job,reason=cancelled()){
            if(job.consumers.size)return;
            remove(job);
            if(active===job){active=null;discardWorker(reason);}
            pump();
        }
        function startTimer(consumer){
            if(consumer.done||consumer.timer!=null)return;
            consumer.timer=arm(()=>{
                const error=failure('Analysis processing timed out','ANALYSIS_TIMEOUT');
                finish(consumer,error);stopUnused(consumer.job,error);
            },consumer.timeoutMs);
        }
        function decorate(result,stamp){
            if(!result||typeof result!=='object')return result;
            if(!result.handle&&!Array.isArray(result.grids))return result;
            const withHandle=value=>value&&value.handle?{...value,handle:{...value.handle,generation:stamp}}:value;
            const value=withHandle(result);
            return Array.isArray(result.grids)?{...value,grids:result.grids.map(withHandle)}:value;
        }
        function connect(){
            if(worker)return worker;
            const instance=factory();
            if(!instance||typeof instance.postMessage!=='function'||typeof instance.terminate!=='function')
                throw failure('Invalid Analysis Worker transport','ANALYSIS_WORKER_UNAVAILABLE');
            const stamp=generation;worker=instance;
            instance.onmessage=event=>{
                const message=event.data||{},job=active;
                if(disposed||worker!==instance||generation!==stamp||!job||message.id!==job.id||message.generation!==stamp)return;
                const supplied=message.error;
                if(supplied){
                    const error=failure(typeof supplied==='string'?supplied:supplied.message||'Analysis failed',supplied.code||'ANALYSIS_FAILED');
                    settleJob(job,error);
                }else settleJob(job,null,decorate(message.result,stamp));
                pump();
            };
            instance.onerror=event=>{
                event.preventDefault?.();
                if(worker===instance&&generation===stamp)reset(failure(event.message||'Analysis Worker crashed','ANALYSIS_WORKER_CRASH'));
            };
            instance.onmessageerror=()=>{
                if(worker===instance&&generation===stamp)reset(failure('Analysis Worker result could not be decoded','ANALYSIS_MESSAGE_ERROR'));
            };
            return instance;
        }
        function pump(){
            if(pumping||disposed)return;pumping=true;
            queueMicrotask(()=>{
                pumping=false;if(disposed)return;
                const admit=()=>{
                    const pending=[...queue,...waiting].sort((a,b)=>a.priority-b.priority||a.sequence-b.sequence);
                    queue.splice(0,queue.length,...pending.slice(0,maxQueued));
                    waiting.splice(0,waiting.length,...pending.slice(maxQueued));
                };
                admit();
                if(active){
                    for(const consumer of [...active.consumers])if(!valid(consumer))finish(consumer,cancelled());
                    if(active.consumers.size)return;
                    const abandoned=active;active=null;remove(abandoned);discardWorker(cancelled());
                }
                while((queue.length||waiting.length)&&!active){
                    admit();
                    const job=queue.shift();
                    for(const consumer of [...job.consumers])if(!valid(consumer))finish(consumer,cancelled());
                    if(!job.consumers.size){remove(job);continue;}
                    if(!handlesCurrent(job.payload)){settleJob(job,expired());continue;}
                    // Completing a source operation resumes several foreground
                    // Promise adapters before the next numeric request appears.
                    // Let those microtasks drain before admitting TIC/prefetch.
                    // A foreground arrival clears this one-turn permission.
                    if(job.priority>=30&&!backgroundReady){
                        queue.unshift(job);
                        if(backgroundTimer==null)backgroundTimer=arm(()=>{
                            backgroundTimer=null;backgroundReady=true;pump();
                        },0);
                        return;
                    }
                    clearBackgroundTurn();
                    active=job;job.generation=generation;
                    try{
                        const transport=connect();
                        for(const consumer of job.consumers)startTimer(consumer);
                        // No transfer list: source bytes/typed arrays can also be
                        // owned by another viewer, ROI calculation or export.
                        transport.postMessage({id:job.id,generation,op:job.op,payload:job.payload});
                    }catch(error){
                        // postMessage cloning/validation failure is per operation;
                        // previously successful handles in this worker stay valid.
                        settleJob(job,error?.code?error:failure(error.message||String(error),'ANALYSIS_TRANSPORT_ERROR'));
                    }
                }
                if(!active&&!queue.length&&!waiting.length)clearBackgroundTurn();
            });
        }
        function request(op,payload={},settings={}){
            if(disposed)return Promise.reject(failure('Analysis service disposed','ANALYSIS_DISPOSED'));
            if(settings.signal?.aborted)return Promise.reject(cancelled());
            if(!handlesCurrent(payload))return Promise.reject(expired());
            const key=settings.key==null?null:String(op)+'\0'+String(settings.key);
            let job=key==null?null:jobs.get(key);
            if(!job){
                if(queue.length>=maxQueued&&settings.waitForCapacity===false)
                    return Promise.reject(failure('Analysis queue is full','ANALYSIS_QUEUE_FULL'));
                job={id:++sequence,sequence,op,payload,key,priority:settings.priority??10,consumers:new Set(),generation:null};
                // Admission waiters retain only the caller's descriptor/reference;
                // no transfer/clone, Worker work or processing timer starts here.
                // Explicit Promise.all callers therefore backpressure, not drop.
                (queue.length<maxQueued?queue:waiting).push(job);if(key!=null)jobs.set(key,job);
            }else job.priority=Math.min(job.priority,settings.priority??10);
            const promise=new Promise((resolve,reject)=>{
                const consumer={job,resolve,reject,signal:settings.signal,current:settings.current,done:false,timer:null,
                    timeoutMs:Number.isFinite(settings.timeoutMs)&&settings.timeoutMs>0?settings.timeoutMs:defaultTimeout};
                consumer.abort=()=>{finish(consumer,cancelled());stopUnused(job);};
                job.consumers.add(consumer);consumer.signal?.addEventListener('abort',consumer.abort,{once:true});
                if(active===job)startTimer(consumer);
            });
            pump();return promise;
        }
        function dispose(){
            if(disposed)return;disposed=true;
            const error=failure('Analysis service disposed','ANALYSIS_DISPOSED');
            for(const job of [...queue,...waiting])settleJob(job,error);
            if(active)settleJob(active,error);discardWorker(error);
        }
        return {request,reset,dispose,isHandleCurrent,refresh:pump,get generation(){return generation;},
            snapshot:()=>({generation,active:active?1:0,queued:queue.length,waiting:waiting.length,
                consumers:(active?active.consumers.size:0)+[...queue,...waiting].reduce((n,j)=>n+j.consumers.size,0),disposed})};
    }
    return {create};
});
