/* Disposable derived images only. Never shares transactions with project/original stores. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TicCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const MAX_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 128;
    function create(options = {}) {
        const idb = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
        const now = options.now || Date.now;
        const maxBytes = options.maxBytes || MAX_BYTES, maxEntries = options.maxEntries || MAX_ENTRIES;
        let opening;
        const request = req => new Promise((resolve,reject) => {req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
        function open() {
            if (!idb) return Promise.resolve(null);
            if (!opening) opening = new Promise(resolve => {
                let settled = false;
                const settle = db => {if(!settled){settled=true;resolve(db);}else if(db)db.close();};
                try {
                    const req = idb.open('desi-render-cache',1);
                    req.onupgradeneeded = () => {if(!req.result.objectStoreNames.contains('tic'))req.result.createObjectStore('tic',{keyPath:'signature'});};
                    req.onsuccess = () => {const db=req.result;db.onversionchange=()=>{db.close();opening=null;};settle(db);};
                    req.onerror = () => settle(null);
                    req.onblocked = () => settle(null);
                } catch (_) {settle(null);}
            });
            return opening;
        }
        async function run(work) {
            const db = await open(); if(!db)return null;
            const tx = db.transaction(['tic'],'readwrite'), store = tx.objectStore('tic');
            const done = new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('cache transaction aborted'));tx.onerror=()=>{};});
            try {const result=await work(store);await done;return result;}
            catch(error){try{tx.abort();}catch(_){}await done.catch(()=>{});throw error;}
        }
        async function get(signature) {
            try {return await run(async store=>{
                const row=await request(store.get(signature));
                if(!row||!row.complete||!row.blob||!(row.width>0)||!(row.height>0))return null;
                row.lastUsedAt=now();await request(store.put(row));return row;
            });} catch(_){return null;}
        }
        async function put(signature,blob,width,height) {
            if(!blob||!Number.isFinite(blob.size)||blob.size>maxBytes||!(width>0)||!(height>0))return false;
            try {return !!await run(async store=>{
                const rows=await request(store.getAll());
                const existing=rows.find(r=>r.signature===signature);
                const rest=rows.filter(r=>r.signature!==signature).sort((a,b)=>(a.lastUsedAt||0)-(b.lastUsedAt||0));
                let bytes=rest.reduce((n,r)=>n+(r.byteSize||0),0)+blob.size, count=rest.length+1;
                for(const row of rest){if(bytes<=maxBytes&&count<=maxEntries)break;await request(store.delete(row.signature));bytes-=row.byteSize||0;count--;}
                await request(store.put({signature,blob,width,height,byteSize:blob.size,complete:true,createdAt:existing?.createdAt||now(),lastUsedAt:now()}));
                return true;
            });}catch(_){return false;}
        }
        async function remove(signature){try{await run(store=>request(store.delete(signature)));}catch(_){} }
        return {get,put,remove};
    }
    function dataUrlBlob(value) {
        if(typeof value!=='string'||!value.startsWith('data:image/png;base64,'))return null;
        const text=atob(value.slice(value.indexOf(',')+1)), bytes=new Uint8Array(text.length);
        for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);
        return new Blob([bytes],{type:'image/png'});
    }
    function blobDataUrl(blob) {
        return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
    }
    return {create,MAX_BYTES,MAX_ENTRIES,dataUrlBlob,blobDataUrl};
});
