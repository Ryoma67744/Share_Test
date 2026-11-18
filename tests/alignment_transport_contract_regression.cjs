'use strict';
// Execute the production capability gate and RPC transport with a synthetic
// client. No account, database, credentials or network are used by this test.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Archive=require('../viewer/project-archive.js');
const Transform=require('../viewer/alignment-transform.js');
const html=fs.readFileSync(path.join(__dirname,'../viewer/index.html'),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x));
function fn(name){const at=html.indexOf('function '+name+'(');assert.ok(at>=0,name);
    return (html.slice(at-6,at)==='async '?'async ':'')+html.slice(at,html.indexOf('\n}',at)+2);}
const validCaps={version:2,renderContract:'msi-shared-display-v1',protectDowngrade:true};
const record=Transform.upgrade({scale_pct:.15,offx:3,offy:4,rotate_deg:10},'manual');
record.alignment_raster_basis='legacy-msi-pixel-edges-v1';record.frame={version:'msi-alignment-frame-v2',key:'frame'};
const payload={alignment:{HE_STAIN:{byFrame:{frame:record}}},world_coords:{T_he_to_msi:record.T_he_to_msi}};
function setup(){
    const calls=[],notices=[];
    let caps=validCaps;
    const c=vm.createContext({console:{warn(){}},JSON,Object,Array,Map,Set,Number,Math,Promise,AbortController,
        SUPABASE_URL:'https://fixture.invalid',SUPABASE_ANON_KEY:'synthetic-public-key',window:{},ProjectArchive:Archive,
        supabase:{createClient:()=>({rpc:async(name,args)=>{
            calls.push({name,args:copy(args)});
            if(name==='alignment_contract_capabilities_v2'){
                const value=typeof caps==='function'?await caps():caps;
                return value instanceof Error?{error:value}:{data:value};
            }
            return {data:{version:5}};
        }})},
        App:{project:{id:'p'},shareMode:{token:'synthetic-token'}},
        _shareAlignServerMissing:false,_shareAlignBySection:new Map(),_shareAlignWriteGen:0,
        showToast:message=>notices.push(message),getShareAlignmentVersion:()=>4,
        captureSectionAlignment:section=>copy(section.meta),_isStaleVersionError:()=>false,
        _noteShareAlignServerMissing:()=>assert.fail('Capability failure is not a missing shared-alignment table')});
    const begin=html.indexOf('const SupabaseClient = (() => {'),end=html.indexOf('\n})();',begin)+6;
    vm.runInContext(html.slice(begin,end)+'\nglobalThis.api=SupabaseClient;',c);
    for(const name of ['_isMissingRpc','ensureAlignmentServerSupport','pushShareAlignment'])vm.runInContext(fn(name),c);
    return {c,calls,notices,setCaps:value=>{caps=value;}};
}
async function main(){
    const t=setup(),args=Object.freeze({_meta:Object.freeze({memo:{text:'unchanged'},spatialWriteProtocol:1}),
        _sections:[{id:'s',meta:copy(payload)}],_request_id:'immutable-request'}),before=copy(args);
    await t.c.api.publishProjectDocV2(args);await t.c.api.publishProjectDocV2(args);
    assert.deepEqual(args,before,'transport leaves the frozen publication snapshot untouched');
    assert.deepEqual(t.calls[0],t.calls[1],'retries use identical protocol markers');
    assert.equal(t.calls[0].args._meta.alignmentWriteProtocol,2);assert.equal(t.calls[0].args._meta.spatialWriteProtocol,1);
    assert.deepEqual(t.calls[0].args._sections,before._sections);
    const frozen=Object.freeze(copy(payload)),saved=copy(frozen);
    await t.c.api.upsertShareAlignment('token','section',frozen,4);
    assert.deepEqual(frozen,saved);assert.equal(t.calls.at(-1).args.p_payload.alignmentWriteProtocol,2);
    assert.equal(t.calls.at(-1).args.p_expected_version,4);
    assert.equal(await t.c.ensureAlignmentServerSupport(),true);
    for(const bad of [null,{}, {...validCaps,version:1},{...validCaps,protectDowngrade:false},{...validCaps,renderContract:'future'}]){
        t.setCaps(bad);await assert.rejects(()=>t.c.ensureAlignmentServerSupport(),/サーバへ更新/);
    }
    const missing=Object.assign(new Error('Could not find the function'),{code:'PGRST202'});
    t.setCaps(missing);await assert.rejects(()=>t.c.ensureAlignmentServerSupport(),/ローカルの内容は保持/);
    const denied=Object.assign(new Error('denied'),{code:'42501'});
    t.setCaps(denied);await assert.rejects(()=>t.c.ensureAlignmentServerSupport(),error=>error===denied);
    const section={id:'s',meta:copy(payload)},original=copy(section);
    const protectedSave=setup();protectedSave.setCaps(missing);
    assert.equal(await protectedSave.c.pushShareAlignment(section,{payload,expectedVersion:4}),false);
    assert.equal(protectedSave.calls.filter(x=>x.name==='upsert_share_alignment').length,0);
    assert.deepEqual(section,original);assert.equal(protectedSave.c._shareAlignBySection.size,0);
    protectedSave.setCaps(validCaps);
    assert.equal(await protectedSave.c.pushShareAlignment(section,{payload,expectedVersion:4}),true);
    assert.equal(protectedSave.calls.at(-1).args.p_expected_version,4);
    assert.equal(protectedSave.c._shareAlignBySection.get('s').payload.alignmentWriteProtocol,undefined,
        'request-only protocol marker never enters the local shared cache');
    const legacy=setup();legacy.setCaps(missing);
    assert.equal(await legacy.c.pushShareAlignment({id:'s',meta:{alignment:{HE_STAIN:{scale_pct:100}}}}),true);
    assert.deepEqual(legacy.calls.map(x=>x.name),['upsert_share_alignment'],'legacy saves do not require a new capability');
    for(const change of ['project','token','closed']){
        const race=setup();let finish;race.setCaps(()=>new Promise(resolve=>{finish=resolve;}));let current=true;
        const pending=race.c.pushShareAlignment(section,{payload,expectedVersion:4,isCurrent:()=>current});
        if(change==='project')race.c.App.project={id:'different'};
        if(change==='token')race.c.App.shareMode.token='different';
        if(change==='closed')current=false;
        finish(validCaps);assert.equal(await pending,false,change+' invalidates a late capability response');
        assert.equal(race.calls.filter(x=>x.name==='upsert_share_alignment').length,0);
    }
    for(const change of ['project','token','closed'])for(const rejected of [false,true]){
        const race=setup();let finish,entered;
        const started=new Promise(resolve=>{entered=resolve;});let current=true;
        race.c.api.upsertShareAlignment=()=>new Promise((resolve,reject)=>{finish=()=>rejected?reject(new Error('late failure')):resolve({version:5});entered();});
        const pending=race.c.pushShareAlignment(section,{payload,expectedVersion:4,isCurrent:()=>current});
        await started;
        if(change==='project')race.c.App.project={id:'different'};
        if(change==='token')race.c.App.shareMode.token='different';
        if(change==='closed')current=false;
        finish();assert.equal(await pending,false,'late RPC completion cannot enter another session');
        assert.equal(race.c._shareAlignBySection.size,0);assert.equal(race.c._shareAlignWriteGen,0);
        assert.deepEqual(race.notices,[]);
    }
    // The master gate must run before sessions, uploads or pending-job mutation.
    const master=setup();master.setCaps(missing);let started=0;
    Object.assign(master.c,{ProjectStorage:{recordPublishReceipt(){},pinBlobs(){}},
        _publishContext:()=>({}),PublishSafety:{run:async()=>{started++;return 'legacy-ok';}},
        freezeMsiSourceReferences(){},roiMediaForTransport(){},roiMediaPublicItem(){},alignmentImageIdentity(){},isViewerOverlay(){},encodeRoiPolygon(){},
        location:{origin:'https://fixture.invalid',pathname:'/viewer/'},
        _publishStatus(){}});
    vm.runInContext(fn('_publishCoreInner'),master.c);
    const project={id:'p',sections:[{id:'s',meta:copy(payload)}]},snapshot=copy(project);
    await assert.rejects(()=>master.c._publishCoreInner(project,{slug:'fixture'},'synthetic',{}),/ローカルの内容は保持/);
    assert.equal(started,0);assert.deepEqual(project,snapshot);
    let completeCapability,comparedCurrent=true,assertions=0;
    master.setCaps(()=>new Promise(resolve=>{completeCapability=resolve;}));
    const pending=master.c._publishCoreInner(project,{slug:'fixture'},'synthetic',{
        assertBeforeStart(){assertions++;if(!comparedCurrent)throw new Error('compared version changed');}});
    comparedCurrent=false;completeCapability(validCaps);
    await assert.rejects(pending,/compared version changed/);
    assert.equal(assertions,2);assert.equal(started,0);assert.deepEqual(project,snapshot);
    console.log('PASS alignment transport: immutable protocol markers, capabilities, legacy writes, shared CAS, late responses and master gate');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
