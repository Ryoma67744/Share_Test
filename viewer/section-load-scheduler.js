/* Bounded, priority-ordered display work. Source initialization has its own gate. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SectionLoadScheduler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    function create(options = {}) {
        const limit = options.concurrency || 2, imageLimit = options.imageConcurrency || 1;
        const jobs = new Map(), idle = new Set();
        let sequence = 0, active = 0, images = 0, disposed = false, pumping = false;
        const valid = job => !disposed && !job.cancelled && (!job.valid || job.valid());
        function notifyIdle() {
            if ([...jobs.values()].some(job => !job.cancelled && job.priority < 30)) return;
            for (const resolve of idle) resolve();
            idle.clear();
        }
        function remove(job) { if (jobs.get(job.key) === job) jobs.delete(job.key); }
        function pump() {
            if (pumping) return;
            pumping = true;
            queueMicrotask(() => {
                pumping = false;
                for (const job of [...jobs.values()]) if (!job.started && !valid(job)) {
                    job.cancelled=true;job.controller.abort();remove(job);job.resolve(false);
                }
                const waiting = [...jobs.values()].filter(job => !job.started)
                    .sort((a,b) => a.priority - b.priority || a.sequence - b.sequence);
                for (const job of waiting) {
                    if (active >= limit) break;
                    if (job.kind === 'image' && images >= imageLimit) continue;
                    // Background work yields whenever foreground is queued or active.
                    if (job.priority >= 30 && [...jobs.values()].some(j => !j.cancelled && j.priority < 30)) continue;
                    job.started = true; active++; if (job.kind === 'image') images++;
                    Promise.resolve().then(() => valid(job) ? job.run({signal:job.controller.signal}) : false)
                        .then(value => job.resolve(valid(job) ? value : false), error => {
                            if (!valid(job) || job.controller.signal.aborted) job.resolve(false);
                            else job.reject(error);
                        })
                        .finally(() => { active--; if (job.kind === 'image') images--; remove(job); notifyIdle(); pump(); });
                }
                notifyIdle();
            });
        }
        function enqueue(spec) {
            if (disposed) return Promise.resolve(false);
            const old = jobs.get(spec.key);
            if (old && !old.cancelled) {
                old.priority = Math.min(old.priority, spec.priority ?? 10);
                // An explicit consumer can join a previously automatic request.
                if (spec.automatic===false || !spec.valid) {
                    old.automatic=false;old.valid=spec.valid || spec.baseValid || null;old.baseValid=spec.baseValid || null;
                }
                pump(); return old.promise;
            }
            const job = {...spec, priority:spec.priority ?? 10, sequence:sequence++, started:false,controller:new AbortController()};
            job.promise = new Promise((resolve,reject) => { job.resolve=resolve; job.reject=reject; });
            job.promise.signal = job.controller.signal;
            jobs.set(job.key,job); pump(); return job.promise;
        }
        function cancelWhere(predicate) {
            for (const job of [...jobs.values()]) if (predicate(job)) {
                job.cancelled=true;
                job.controller.abort();job.resolve(false);
                if (!job.started) remove(job);
            }
            notifyIdle(); pump();
        }
        return {enqueue, cancelWhere, refresh:pump,
            promote(key, priority=0, keepValidity=false) { const job=jobs.get(key); if(job){job.priority=Math.min(job.priority,priority);if(!keepValidity){job.valid=job.baseValid || null;job.automatic=false;}pump();} },
            whenForegroundIdle() { if (![...jobs.values()].some(j=>!j.cancelled && j.priority<30)) return Promise.resolve(); return new Promise(resolve=>idle.add(resolve)); },
            dispose() { disposed=true; cancelWhere(()=>true); },
            snapshot() { return {active,images,queued:[...jobs.values()].filter(j=>!j.started).length}; }
        };
    }
    // Global to this page, including project changes. A superseded request must
    // not let the next project open another large footer while it is still decoding.
    let sourceTail = Promise.resolve();
    function warmSource(run) {
        const job = sourceTail.then(run);
        sourceTail = job.catch(()=>{});
        return job;
    }
    return {create,warmSource};
});
