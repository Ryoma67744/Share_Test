'use strict';
const assert=require('node:assert/strict'),Service=require('../viewer/msi-analysis-service.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(options={}){
 const workers=[],timers=new Map(),resets=[];let timerId=0,now=0;
 const service=Service.create({maxQueued:3,timeoutMs:100,...options,
  createWorker(){const w={sent:[],terminated:false,postMessage(message,transfer){this.sent.push({message,transfer});},terminate(){this.terminated=true;},
   reply(result,error,override){const message=this.sent.at(-1).message;this.onmessage?.({data:{id:message.id,generation:message.generation,result,error,...override}});}};workers.push(w);return w;},
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);},
  onReset:event=>resets.push(event)});
 return {service,workers,timers,resets,advance(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}}};
}
async function main(){
 {
  const h=harness(),s=h.service;
  const source=s.request('source-open',{}, {priority:0});await flush();
  const background=s.request('tic-step',{}, {priority:30});
  const foreground=(async()=>{await source;await Promise.resolve();await Promise.resolve();return s.request('ratio',{}, {priority:10});})();
  h.workers[0].reply({source:true});await flush();
  assert.deepEqual(h.workers[0].sent.map(item=>item.message.op),['source-open','ratio'],
   'chained foreground analysis is admitted before queued background work');
  assert.equal(h.timers.size,1,'foreground arrival cancels the background admission timer');
  h.workers[0].reply('numeric result');assert.equal(await foreground,'numeric result');await flush();
  assert.equal(h.workers[0].sent.length,2,'background admission yields a task rather than racing promise continuations');
  h.advance(0);await flush();assert.equal(h.workers[0].sent.at(-1).message.op,'tic-step');
  h.workers[0].reply('background result');assert.equal(await background,'background result');s.dispose();assert.equal(h.timers.size,0);
 }
 {
  const h=harness(),s=h.service,controller=new AbortController();
  const queued=s.request('tic-step',{}, {priority:30,signal:controller.signal});
  const check=assert.rejects(queued,{code:'ANALYSIS_CANCELLED'});await flush();
  assert.equal(h.workers.length,0);assert.equal(h.timers.size,1);
  controller.abort();await check;await flush();assert.equal(h.timers.size,0,'abandoned admission leaves no timer');
  const next=s.request('tic-step',{}, {priority:30}),disposed=assert.rejects(next,{code:'ANALYSIS_DISPOSED'});await flush();
  s.dispose();await disposed;assert.equal(h.timers.size,0);h.advance(0);await flush();assert.equal(h.workers.length,0);
 }
 {
  const h=harness(),s=h.service,first=s.request('parse',{input:1},{key:'first',timeoutMs:100});await flush();
  const low=s.request('parse',{input:2},{key:'low',priority:20,timeoutMs:5}),high=s.request('parse',{input:3},{key:'high',priority:0,timeoutMs:5});
  assert.equal(h.workers.length,1);assert.equal(h.timers.size,1,'queued time is outside processing timeouts');
  h.advance(50);h.workers[0].reply('first');assert.equal(await first,'first');await flush();
  assert.equal(h.workers[0].sent.at(-1).message.payload.input,3);h.workers[0].reply('high');assert.equal(await high,'high');await flush();
  h.workers[0].reply('low');assert.equal(await low,'low');assert.equal(s.snapshot().active,0);assert.equal(h.timers.size,0);s.dispose();
 }
 {
  const h=harness(),s=h.service,a=new AbortController(),b=new AbortController(),bytes=new Float64Array([1,NaN,9007199254740992]);
  const one=s.request('source-open',{bytes},{key:'same',signal:a.signal}),two=s.request('source-open',{bytes},{key:'same',signal:b.signal});
  const rejected=assert.rejects(one,{code:'ANALYSIS_CANCELLED'});await flush();a.abort();await rejected;
  assert.equal(h.workers[0].terminated,false);assert.equal(h.workers[0].sent.length,1);assert.equal(h.workers[0].sent[0].transfer,undefined);
  h.workers[0].reply({handle:{id:'source'},grids:[{handle:{id:'left'}},{handle:{id:'right'}}]});
  const result=await two;assert.ok(s.isHandleCurrent(result.handle));assert.ok(result.grids.every(grid=>s.isHandleCurrent(grid.handle)));
  assert.equal(bytes.byteLength,24);assert.ok(Number.isNaN(bytes[1]));s.dispose();
 }
 {
  const h=harness(),s=h.service,controller=new AbortController();
  const request=s.request('parse',{}, {signal:controller.signal}),rejected=assert.rejects(request,{code:'ANALYSIS_CANCELLED'});await flush();
  const original=h.workers[0],oldHandler=original.onmessage,oldMessage=original.sent[0].message,oldGeneration=s.generation;
  controller.abort();await rejected;assert.equal(original.terminated,true);assert.equal(s.generation,oldGeneration+1);
  const next=s.request('parse',{});await flush();oldHandler({data:{id:oldMessage.id,generation:oldMessage.generation,result:'obsolete'}});
  assert.equal(s.snapshot().active,1);h.workers[1].reply('current');assert.equal(await next,'current');s.dispose();
 }
 {
  const h=harness(),s=h.service;
  const open=s.request('source-open',{});await flush();h.workers[0].reply({handle:{id:'retained'}});const {handle}=await open;
  const bad=s.request('roi',{handle}),badCheck=assert.rejects(bad,{code:'BAD_GEOMETRY'});await flush();h.workers[0].reply(null,{message:'bad geometry',code:'BAD_GEOMETRY'});await badCheck;
  assert.equal(s.isHandleCurrent(handle),true);assert.equal(h.workers[0].terminated,false,'ordinary operation errors preserve source handles');
  const crash=s.request('roi',{handle}),crashCheck=assert.rejects(crash,{code:'ANALYSIS_WORKER_CRASH'});await flush();
  const waiting=s.request('roi',{handle}),waitingCheck=assert.rejects(waiting,{code:'ANALYSIS_HANDLE_EXPIRED'});
  h.workers[0].onerror({message:'crash',preventDefault(){}});await crashCheck;await waitingCheck;
  assert.equal(s.isHandleCurrent(handle),false);await assert.rejects(()=>s.request('roi',{handle}),{code:'ANALYSIS_HANDLE_EXPIRED'});s.dispose();
 }
 {
  const h=harness(),s=h.service;
  const short=s.request('parse',{}, {key:'shared',timeoutMs:5}),long=s.request('parse',{}, {key:'shared',timeoutMs:20});
  const shortCheck=assert.rejects(short,{code:'ANALYSIS_TIMEOUT'});await flush();h.advance(5);await shortCheck;
  assert.equal(h.workers[0].terminated,false,'one timed-out consumer does not terminate another');
  const longCheck=assert.rejects(long,{code:'ANALYSIS_TIMEOUT'});h.advance(15);await longCheck;assert.equal(h.workers[0].terminated,true);assert.equal(h.timers.size,0);s.dispose();
 }
 {
  const h=harness({maxQueued:1}),s=h.service;
  const active=s.request('parse',{});await flush();const controller=new AbortController();
  const queued=s.request('parse',{}, {key:'queued',signal:controller.signal}),queuedCheck=assert.rejects(queued,{code:'ANALYSIS_CANCELLED'});
  await assert.rejects(()=>s.request('parse',{}, {waitForCapacity:false}),{code:'ANALYSIS_QUEUE_FULL'});
  const eventual=s.request('parse',{required:true});assert.equal(s.snapshot().queued,1);assert.equal(s.snapshot().waiting,1);
  assert.equal(h.timers.size,1,'capacity admission also does not consume processing timeout');controller.abort();await queuedCheck;
  assert.equal(h.workers[0].terminated,false,'cancelled queue entry does not invalidate the active worker');
  h.workers[0].reply('done');await active;await flush();assert.equal(h.workers[0].sent.at(-1).message.payload.required,true);
  h.workers[0].reply('explicit output');assert.equal(await eventual,'explicit output');assert.equal(s.snapshot().queued,0);assert.equal(s.snapshot().waiting,0);s.dispose();
 }
 {
  const h=harness(),s=h.service;let current=true;
  const stale=s.request('parse',{}, {current:()=>current}),staleCheck=assert.rejects(stale,{code:'ANALYSIS_CANCELLED'});await flush();current=false;
  h.workers[0].reply({answer:42});await staleCheck;
  const a=s.request('parse',{}),b=s.request('parse',{}),checks=[assert.rejects(a,{code:'ANALYSIS_DISPOSED'}),assert.rejects(b,{code:'ANALYSIS_DISPOSED'})];await flush();s.dispose();await Promise.all(checks);
  assert.equal(s.snapshot().consumers,0);assert.equal(h.timers.size,0);await assert.rejects(()=>s.request('parse',{}),{code:'ANALYSIS_DISPOSED'});
 }
 console.log('MSI analysis service: one worker, bounded queue, dedupe, consumer cancellation, generation handles, timeout/crash and settlement PASS.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
