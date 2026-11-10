/* One low-priority TIC accumulator at a time; source parsing stays in the existing worker. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TicRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    function create(options = {}) {
        const cache=options.cache, jobs=new WeakMap(), memory=new Map();
        let tail=Promise.resolve(), sequence=0;
        function cancel(owner) {const job=jobs.get(owner);if(job){job.cancelled=true;job.state='cancelled';jobs.delete(owner);} }
        function ensure(owner, spec) {
            const previous=jobs.get(owner);
            if(previous&&!previous.cancelled&&previous.signature===spec.signature
                && !(spec.explicit&&!previous.explicit&&previous.state!=='ready')
                && !(spec.retry&&['failed','unavailable','incomplete'].includes(previous.state)))return previous.promise;
            cancel(owner);
            const job={id:'tic-'+(++sequence),signature:spec.signature,state:'cacheLookup',cancelled:false,explicit:!!spec.explicit};
            jobs.set(owner,job);owner._ticJob=job;
            const current=()=>!job.cancelled&&!spec.signal?.aborted&&jobs.get(owner)===job&&spec.current();
            const check=()=>{if(!current())throw Object.assign(new Error('TIC job cancelled'),{name:'AbortError'});};
            const abort=()=>{job.cancelled=true;job.state='cancelled';};
            if(spec.signal)spec.signal.addEventListener('abort',abort,{once:true});
            const work=async()=>{
                check();
                let data=memory.get(spec.signature);
                if(!data&&spec.durable&&cache){const row=await cache.get(spec.signature);check();if(row){try{data=await spec.decodeCache(row);}catch(_){await cache.remove(spec.signature);}}}
                check();
                if(data){const accepted=await spec.accept(data);check();if(accepted!==false){job.state='ready';job.cacheHit=true;return true;}memory.delete(spec.signature);if(spec.durable&&cache)await cache.remove(spec.signature);}
                if(!spec.available()){job.state='unavailable';return false;}
                job.state='queued';
                // The FIFO owns only the accumulator. Each parsing step separately
                // enters the section scheduler's background lane, yielding to clicks.
                const run=async()=>{
                    check();job.state='running';let complete=true;
                    try {
                        const begin=await spec.step(job.id+':begin',()=>spec.call('tic-begin',{jobId:job.id,width:spec.width,height:spec.height}));
                        check();if(begin===false||begin==null)throw Object.assign(new Error('TIC job cancelled'),{name:'AbortError'});
                        for(let i=0;i<spec.entries.length;i++){
                            check();
                            const result=await spec.step(job.id+':'+i,async()=>{
                                check();const payload=await spec.source(spec.entries[i]);check();
                                if(!payload)throw new Error('TIC source is unavailable');
                                return spec.call('tic-step',{...payload,jobId:job.id});
                            });
                            check();if(result===false||result==null)throw Object.assign(new Error('TIC job cancelled'),{name:'AbortError'});
                            if(result.contributed===false)complete=false;
                        }
                        const result=await spec.step(job.id+':finish',()=>spec.call('tic-finish',{jobId:job.id}));
                        check();if(!result?.dataUrl){job.state='incomplete';return false;}
                        if(await spec.accept(result.dataUrl)===false){job.state='failed';return false;}
                        check();
                        if(!complete){job.state='incomplete';return true;}
                        memory.set(spec.signature,result.dataUrl);
                        while(memory.size>8)memory.delete(memory.keys().next().value);
                        if(spec.durable&&cache){const blob=spec.encodeCache(result.dataUrl);if(blob&&current())await cache.put(spec.signature,blob,result.width,result.height);}
                        check();job.state='ready';return true;
                    }finally{await spec.call('tic-dispose',{jobId:job.id}).catch(()=>{});}
                };
                const queued=tail.then(run,run);tail=queued.catch(()=>{});return queued;
            };
            job.promise=work().catch(error=>{job.state=error?.name==='AbortError'?'cancelled':'failed';if(job.state==='failed')spec.error?.(error);return false;})
                .finally(()=>{if(spec.signal)spec.signal.removeEventListener('abort',abort);});
            return job.promise;
        }
        return {ensure,cancel};
    }
    return {create};
});
