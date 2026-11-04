'use strict';
// Deterministic transaction test adapter. Real IDB inter-tab behavior is covered
// separately in project_store_safety_browser_regression.cjs.
module.exports = function memoryIdb(initial = {}) {
 const names = ['projects','project_index','blobs','pq_index','project_recovery','blob_pins','archive_jobs'];
 const stores = Object.fromEntries(names.map(n => [n, initial[n] || new Map()]));
 let tail=Promise.resolve(); const api={stores,operations:[],failNextCommit:false};
 api.transaction=async (input, mode) => {
  const names=Array.from(input), previous=tail;let release;tail=new Promise(r=>release=r);await previous;
  const draft=Object.fromEntries(names.map(n=>[n,new Map([...stores[n]].map(([k,v])=>[k,structuredClone(v)]))]));
  let finished=false,timer;
  const t={error:null,abort(){if(finished)return;finished=true;clearImmediate(timer);t.error ||= new Error('transaction aborted');t.onabort?.();release();},objectStore(name){
   const issue=(op,key,value)=>{if(finished)throw new Error('inactive transaction');clearImmediate(timer);const req={};setImmediate(()=>{
    if(finished)return;
    try{
     api.operations.push({store:name,op,key});const m=draft[name];
     if(op==='get')req.result=structuredClone(m.get(key));
     else if(op==='getAll')req.result=structuredClone([...m.values()]);
     else if(op==='getAllKeys')req.result=[...m.keys()];
     else if(op==='delete')m.delete(key);
     else {if(op==='add'&&m.has(key))throw new Error('duplicate key');m.set(key,structuredClone(value));req.result=key;}
     req.onsuccess?.();timer=setImmediate(()=>{if(api.failNextCommit){api.failNextCommit=false;t.error=Object.assign(new Error('quota exhausted at commit'),{name:'QuotaExceededError'});t.abort();return;}
       finished=true;if(mode==='readwrite')for(const n of names){stores[n].clear();for(const [k,v]of draft[n])stores[n].set(k,structuredClone(v));}t.oncomplete?.();release();});
    }catch(e){req.error=e;req.onerror?.();t.error=e;t.abort();}
   });return req;};
   return {get:k=>issue('get',k),getAll:()=>issue('getAll'),getAllKeys:()=>issue('getAllKeys'),add:v=>issue('add',v.id,v),put:v=>issue('put',v.id,v),delete:k=>issue('delete',k)};
  }};return t;
 };return api;
};
