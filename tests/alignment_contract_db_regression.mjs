import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import Spatial from '../viewer/msi-spatial-groups.js';

// Disposable PostgreSQL instances and synthetic data only. Never connects to
// Supabase, reads credentials, or changes a production project.
const sql=name=>readFile(new URL('../supabase/'+name,import.meta.url),'utf8');
const [schema,locks,publisher,spatial,ordinal,migration]=await Promise.all(
    ['schema.sql','share_locks.sql','publish_safety_v2.sql','spatial_groups_v1.sql',
        'section_ordinal_hotfix.sql','alignment_contract_v2.sql'].map(sql));
const password='synthetic-alignment-contract-master';
const writer='public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)';
const savedWriter='public._publish_doc_write_before_alignment_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)';
const shared='public.upsert_share_alignment(text,uuid,jsonb,integer,text)';
const savedShared='public._upsert_share_alignment_before_contract_v2(text,uuid,jsonb,integer,text)';
const publicWriter='public.publish_project_doc_v2(text,text,uuid,bigint,boolean,text,text,jsonb,text,text,jsonb,jsonb,boolean)';
const spatialBase='public._publish_doc_write_before_spatial_v1(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)';
const clone=value=>JSON.parse(JSON.stringify(value));
const windows=source=>source.replace(/\r?\n/g,'\r\n');
const identity=[[1,0,0],[0,1,0],[0,0,1]];
const record=(matrix=identity)=>({alignmentContractVersion:2,renderContract:'msi-shared-display-v1',
    alignment_raster_basis:'legacy-msi-pixel-edges-v1',T_he_to_msi:clone(matrix),scope:'source',
    frame:{version:'msi-alignment-frame-v2',key:'frame-A',coordinateKey:'raw-grid-A',confirmed:true},
    imageIdentity:'synthetic-image',landmarks:{he:[[0,0],[2,0]],msi:[[0,0],[2,0]]},
    preservedExtra:{note:'opaque record metadata'}});
const payload=(matrix=identity)=>{
    const r=record(matrix);
    return {alignment:{HE_STAIN:{...clone(r),byFrame:{'frame-A':clone(r)},bySource:{'source-A':clone(r)},
        sharedByCoordinate:{'raw-grid-A':{...clone(r),scope:'shared'}}}},
    world_coords:{T_he_to_msi:clone(matrix),alignment_raster_basis:'legacy-msi-pixel-edges-v1'},
    alignmentFrameVersion:'msi-alignment-frame-v1',alignmentHeKey:'HE_STAIN'};
};
const section=(id,meta={})=>({id,ordinal:1,displayName:'Section '+id,meta:clone(meta),
    storagePaths:{images:{},msiSeries:{}}});
const protocol={spatialWriteProtocol:1,alignmentWriteProtocol:2};
const downgrade=entry=>{
    delete entry.alignmentContractVersion;delete entry.renderContract;
    if(entry.frame)entry.frame.version='msi-alignment-frame-v1';
};
let checks=0;
const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const reject=async(fn,pattern)=>{
    await assert.rejects(fn,error=>{assert.match(error.message,pattern);assert.notEqual(error.code,'40001');return true;});checks++;
};

async function fixture({withSpatial=false,crlf=false,legacyOrdinal=false}={}) {
    const db=new PGlite({extensions:{pgcrypto}});
    const value=async(query,params=[])=>(await db.query(query,params)).rows[0].value;
    const source=signature=>value('select prosrc as value from pg_proc where oid=$1::regprocedure',[signature]);
    const acl=signature=>value(`select jsonb_build_object('owner',p.proowner,'securityDefiner',p.prosecdef,
      'privileges',(select jsonb_agg(jsonb_build_array(a.grantor,a.grantee,a.privilege_type,a.is_grantable)
        order by a.grantor,a.grantee,a.privilege_type,a.is_grantable)
        from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) as value
      from pg_proc p where oid=$1::regprocedure`,[signature]);
    const state=()=>value(`select jsonb_build_object(
      'projects',(select jsonb_agg(to_jsonb(p) order by id) from public.projects p),
      'sections',(select jsonb_agg(to_jsonb(s) order by id) from public.sections s),
      'alignments',(select jsonb_agg(to_jsonb(a) order by section_id) from public.share_alignments a),
      'rois',(select jsonb_agg(to_jsonb(r) order by id) from public.rois r),
      'credentials',(select jsonb_agg(to_jsonb(c) order by project_id,role) from public.project_credentials c),
      'receipts',(select jsonb_agg(to_jsonb(r) order by slug,request_id) from public.publish_receipts r),
      'sessions',(select jsonb_agg(to_jsonb(s) order by token) from public.publish_sessions s),
      'tokens',(select jsonb_agg(to_jsonb(t) order by token) from public.session_tokens t)
    ) as value`);
    const revision=()=>value("select coalesce((select publish_revision from public.projects where slug='alignment-fixture'),0) as value");
    const prepare=async()=>{
        const rev=await revision(),create=rev===0,id=randomUUID();
        const ticket=await value('select public.request_publish_session_v2($1,$2,$3,$4,$5) as value',
            [password,'alignment-fixture',id,rev,create]);
        return {id,rev,create,ticket};
    };
    const commit=(request,sections,meta=protocol,rois=[],pw=password)=>value(
        'select public.publish_project_doc_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as value',
        [pw,request.ticket.token,request.id,request.rev,request.create,'alignment-fixture','Alignment fixture',
            JSON.stringify(meta),null,null,JSON.stringify(sections),JSON.stringify(rois),true]);
    const publish=async(sections,meta=protocol,rois=[])=>commit(await prepare(),sections,meta,rois);
    const token=async()=>(await value("select to_jsonb(t) as value from public.unlock_public_project('alignment-fixture') t")).token;
    const sharedWrite=(access,sid,data,version=null,modern=true)=>value(
        'select to_jsonb(public.upsert_share_alignment($1,$2,$3,$4,$5)) as value',
        [access,sid,JSON.stringify(modern?{...data,alignmentWriteProtocol:2}:data),version,'synthetic viewer']);
    const snapshotReject=async(request,sections,meta,pattern)=>{
        const before=await state();
        await reject(()=>commit(request,sections,meta),pattern);
        equal(await state(),before,'Rejected publication is atomic, including revision and receipts');
    };
    try {
        await db.exec(`create role anon;create role authenticated;create role alignment_test_reader;
          create schema extensions;create extension pgcrypto with schema extensions;
          create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
          create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
          alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;
          grant select,insert,update,delete on storage.objects to anon,authenticated;`);
        await db.exec(schema);await db.exec(crlf?windows(locks):locks);
        await db.exec(crlf?windows(publisher):publisher);
        await db.exec(`create or replace function public._verify_master_pw(_pw text) returns boolean
          language sql security definer as $$select _pw='synthetic-alignment-contract-master'$$;`);
        if(legacyOrdinal) {
            const old=locks.match(/create or replace function public\.upsert_project_doc\([\s\S]*?\n\$\$;/)[0]
                .replace('public.upsert_project_doc(', 'public._publish_doc_write_v2(');
            await db.exec(crlf?windows(old):old);
        }
        if(withSpatial)await db.exec(crlf?windows(spatial):spatial);
        // Exercise ACL preservation, not merely the repository's default grant order.
        await db.exec(`revoke all on function ${shared} from public;
          grant execute on function ${shared} to alignment_test_reader with grant option;`);
        return {db,value,source,acl,state,prepare,commit,publish,token,sharedWrite,snapshotReject,revision,withSpatial,crlf};
    } catch(error) {await db.close();throw error;}
}

async function exercise(f) {
    const {db,value,source,acl,state,prepare,commit,publish,token,sharedWrite,snapshotReject,revision}=f;
    const a=section('A'),b=section('B');
    const initialRequest=await prepare();
    const initialReceipt=await commit(initialRequest,[a,b],{spatialWriteProtocol:1});
    const sidA=await value("select id as value from public.sections where meta->>'client_id'='A'");
    const sidB=await value("select id as value from public.sections where meta->>'client_id'='B'");
    const legacy={alignment:{HE_STAIN:{scale_pct:150,offx:12,offy:-3},IF_STAIN:null},world_coords:{T_he_to_msi:[[1.5,0,12],[0,1.5,-3],[0,0,1]]}};
    let access=await token();
    const beforeShared=await sharedWrite(access,sidB,legacy,null,false);
    const before=await state(),writerSource=await source(writer),sharedSource=await source(shared),publicSource=await source(publicWriter);
    const writerAcl=await acl(writer),sharedAcl=await acl(shared),publicAcl=await acl(publicWriter);
    const spatialSource=f.withSpatial?await source(spatialBase):null;
    const install=f.crlf?windows(migration):migration;
    await db.exec(install);
    equal(await state(),before,'Installation does not rewrite any project, credentials, ROI, alignment, token, session or receipt');
    equal(await source(savedWriter),writerSource,'Original base/spatial wrapper bytes are retained');
    equal(await source(savedShared),sharedSource,'Original shared authorization/CAS writer bytes are retained');
    equal(await source(publicWriter),publicSource,'Public receipt/session/hash/CAS body is unchanged');
    if(f.withSpatial)equal(await source(spatialBase),spatialSource,'Ordinal-fixed base behind spatial wrapper is unchanged');
    equal(await acl(writer),writerAcl,'Internal endpoint owner and ACL are preserved');
    equal(await acl(shared),sharedAcl,'Shared endpoint owner, restricted PUBLIC grant and custom grants are preserved');
    equal(await acl(publicWriter),publicAcl,'Public publisher privileges are preserved');
    const installedSources=[await source(writer),await source(shared)];
    await db.exec(install);
    equal([await source(writer),await source(shared)],installedSources,'Rerun does not stack or change wrappers');
    equal(await state(),before,'Rerun has no data effects');
    equal(await value('select public.alignment_contract_capabilities_v2() as value'),
        {version:2,renderContract:'msi-shared-display-v1',protectDowngrade:true});
    equal(await commit(initialRequest,[a,b],{spatialWriteProtocol:1}),initialReceipt,'Existing immutable receipt replay remains valid');
    await reject(()=>commit(initialRequest,[a,b],protocol),/publish_request_reused_with_different_document/);
    equal(await state(),before,'Adding a marker to an already committed request cannot change its immutable receipt or data');
    await db.exec('set role anon');
    equal((await value('select public.alignment_contract_capabilities_v2() as value')).version,2);
    await reject(()=>value('select public._alignment_has_contract_v2($1) as value',['{}']),/permission denied/);
    equal(await value('select has_function_privilege(current_user,$1,\'execute\') as value',[savedWriter]),false);
    equal(await value('select has_function_privilege(current_user,$1,\'execute\') as value',[savedShared]),false);
    await db.exec('reset role');
    equal(await value('select has_function_privilege(\'alignment_test_reader\',$1,\'execute\') as value',[savedShared]),false,
        'Custom client grants cannot bypass the new shared guard');

    // Existing legacy-only clients can still save and publish unchanged semantics.
    const legacyUpdated=await sharedWrite(access,sidB,legacy,beforeShared.version,false);
    equal(legacyUpdated.payload,legacy);
    await publish([a,b],{spatialWriteProtocol:1});
    equal(await value('select payload as value from public.share_alignments where section_id=$1',[sidB]),legacy);
    const oldPending=await prepare();
    const oldPendingArgs=clone({sections:[a,b],meta:{spatialWriteProtocol:1}});
    const oldPendingSnapshot=clone(oldPendingArgs);
    await commit(oldPending,oldPendingArgs.sections,{...oldPendingArgs.meta,alignmentWriteProtocol:2});
    equal(oldPendingArgs,oldPendingSnapshot,'An uncommitted old job can gain a transport marker without editing its prepared document');

    const matrices=[identity,[[2,0,13],[0,2,-7],[0,0,1]],[[0,-2,3],[2,0,-8],[0,0,1]],
        [[1,0,2],[0,-1,3],[0,0,1]],[[2,.35,9],[.1,3,-4],[0,0,1]],[[.000001,0,0],[0,.000001,0],[0,0,1]]];
    for(const matrix of matrices) {
        a.meta=payload(matrix);
        await publish([a,b]);
        const stored=await value('select meta as value from public.sections where id=$1',[sidA]);
        equal(stored,{...a.meta,client_id:'A'},'Canonical proper/reflected/general affine payload round-trips without scalar reconstruction');
    }
    equal(await value("select meta ? 'alignmentWriteProtocol' as value from public.projects where slug='alignment-fixture'"),false,
        'Publication marker is request-only');
    access=await token();
    const doc=await value('select public.get_project_doc($1) as value',[access]);
    equal(doc.sections.find(s=>s.id===sidA).meta,{...a.meta,client_id:'A'},'Snapshot read retains exact contract and matrix');
    equal(await value("select coalesce(current_setting('share_test.alignment_write_protocol',true),'') as value"),'',
        'Protocol capability cannot leak into a later request');
    await db.query("update public.sections set meta=jsonb_set(meta,'{unrelatedNote}','\"retained alignment\"') where id=$1",[sidA]);
    equal(await value("select meta->'alignment' as value from public.sections where id=$1",[sidA]),a.meta.alignment,
        'Unrelated section metadata updates can retain the alignment subtree without protocol 2');
    const unrelatedState=await state();
    await reject(()=>db.query("update public.sections set meta=jsonb_set(meta,'{alignment,HE_STAIN,byFrame,frame-A,T_he_to_msi}', $2) where id=$1",
        [sidA,JSON.stringify(identity)]),/alignment_upgrade_required/);
    equal(await state(),unrelatedState,'Direct canonical matrix edit still requires the protocol');
    await reject(()=>db.query("update public.sections set meta=meta-'alignment' where id=$1",[sidA]),/alignment_upgrade_required/);
    equal(await state(),unrelatedState,'Removing the canonical alignment subtree still requires the protocol');

    const oldClient=clone(a);
    for(const entry of [oldClient.meta.alignment.HE_STAIN,...Object.values(oldClient.meta.alignment.HE_STAIN.byFrame),
        ...Object.values(oldClient.meta.alignment.HE_STAIN.bySource),...Object.values(oldClient.meta.alignment.HE_STAIN.sharedByCoordinate)])downgrade(entry);
    await snapshotReject(await prepare(),[oldClient,b],{spatialWriteProtocol:1},/alignment_upgrade_required/);
    await snapshotReject(await prepare(),[],{spatialWriteProtocol:1},/alignment_upgrade_required/);
    await snapshotReject(await prepare(),[a,b],{spatialWriteProtocol:1,alignmentWriteProtocol:'2'},/invalid_alignment_write_protocol/);
    for(const path of [[],['byFrame','frame-A'],['bySource','source-A'],['sharedByCoordinate','raw-grid-A']]) {
        const downgraded=clone(a);let target=downgraded.meta.alignment.HE_STAIN;
        for(const key of path)target=target[key];
        downgrade(target);
        await snapshotReject(await prepare(),[downgraded,b],protocol,/alignment_contract_downgrade/);
    }
    const malformed=[r=>{delete r.renderContract;},r=>{r.alignmentContractVersion='2';},
        r=>{r.renderContract='unknown';},r=>{r.frame.version='msi-alignment-frame-v1';},
        r=>{r.frame.key='';},r=>{r.frame.key=123;},r=>{r.alignment_raster_basis='different-basis';},
        r=>{r.T_he_to_msi=[[1,2,0],[2,4,0],[0,0,1]];},r=>{r.T_he_to_msi[2][0]=.1;},
        r=>{r.T_he_to_msi[0][0]=null;},r=>{r.T_he_to_msi[0][0]='Infinity';},
        r=>{r.T_he_to_msi=[[1,0],[0,1]];},r=>{r.T_he_to_msi=[[1e308,0,0],[0,1e308,0],[0,0,1]];}];
    for(const corrupt of malformed) {
        const bad=clone(a);corrupt(bad.meta.alignment.HE_STAIN.byFrame['frame-A']);
        await snapshotReject(await prepare(),[bad,b],protocol,/invalid_alignment_contract/);
    }
    equal(await value("select public._alignment_valid_affine_v2('[[1e400,0,0],[0,1,0],[0,0,1]]'::jsonb) as value"),false,
        'JSONB numeric outside finite JS/float range is rejected');
    const badAuth=await prepare(),authState=await state();
    await reject(()=>commit(badAuth,[a,b],protocol,[],'wrong-master'),/unauthorized/);
    equal(await state(),authState);
    const stale=await prepare();await publish([a,b]);
    const staleState=await state();await reject(()=>commit(stale,[a,b]),/publish_conflict/);equal(await state(),staleState);
    const replay=await prepare(),receipt=await commit(replay,[a,b]);
    equal(await commit(replay,[a,b]),receipt,'Protected content preserves receipt idempotency');
    await reject(()=>commit(replay,[a,b],{spatialWriteProtocol:1}),/publish_request_reused_with_different_document/);

    access=await token();
    await reject(()=>sharedWrite(access,sidA,legacy,null,false),/alignment_upgrade_required/);
    await reject(()=>sharedWrite('invalid-token',sidA,payload()),/token|unauthorized/);
    await reject(()=>sharedWrite(access,randomUUID(),payload()),/section not in this project/);
    const first=await sharedWrite(access,sidA,payload(matrices[4]));
    equal(first.payload,payload(matrices[4]),'Shared request marker is stripped and affine payload remains exact');
    const sharedBefore=await state();
    await reject(()=>sharedWrite(access,sidA,legacy,first.version,false),/alignment_upgrade_required/);
    equal(await state(),sharedBefore,'Old shared-client downgrade changes no row/version');
    await reject(()=>sharedWrite(access,sidA,payload(),0),/stale_version/);
    equal(await state(),sharedBefore,'Shared stale version remains atomic');
    const downgradedPayload=payload();downgrade(downgradedPayload.alignment.HE_STAIN.byFrame['frame-A']);
    await reject(()=>sharedWrite(access,sidA,downgradedPayload,first.version),/alignment_contract_downgrade/);
    equal(await state(),sharedBefore);
    const cleared=await sharedWrite(access,sidA,{alignment:{}},first.version);
    equal(cleared.payload,{alignment:{}},'Modern explicit removal is allowed');
    const restored=await sharedWrite(access,sidA,payload(),cleared.version);
    equal((await value('select coalesce(jsonb_agg(to_jsonb(a)),\'[]\'::jsonb) as value from public.list_share_alignments($1) a',[access]))
        .find(row=>row.section_id===sidA).payload,restored.payload,'Shared read snapshot retains v2');
    await value('select public.delete_share_alignment($1,$2) as value',[access,sidA]);
    equal(await value('select count(*)::int as value from public.share_alignments where section_id=$1',[sidA]),0,
        'Existing authorized delete restores master alignment');

    // A section protected only by a shared record is also protected from an
    // old publication that would cascade-delete that collaborator alignment.
    const protectedB=await sharedWrite(access,sidB,payload(),legacyUpdated.version);
    equal(protectedB.payload,payload());
    await snapshotReject(await prepare(),[b],{spatialWriteProtocol:1},/alignment_upgrade_required/);

    if(f.withSpatial) {
        const entry={kind:'txt',sourceFileId:'source-A'};
        const geometry={sourceRef:Spatial.sourceReference(entry),legacy:{W:2,H:2,confirmed:true,x:[[0,0],[1,1]],y:[[0,0],[1,1]]},
            displayGeometry:{version:'msi-proportional-v1',W:2,H:2,x:{origin:0,step:1},y:{origin:0,step:1}}};
        const group=Spatial.roiMeta(a,entry,geometry);
        const groupRecord={...record(matrices[4]),scope:'group',groupId:group.groupId,groupFrameKey:group.frameKey,groupFrameVersion:1};
        a.meta.alignment.HE_STAIN.byGroup={[group.groupId]:groupRecord};
        await publish([a,b]);
        const regrouped=clone(a);delete regrouped.meta.alignment.HE_STAIN.byFrame;delete regrouped.meta.alignment.HE_STAIN.bySource;
        await publish([regrouped,b]);a.meta=regrouped.meta;
        equal(await value("select meta#>'{alignment,HE_STAIN,byGroup}' as value from public.sections where id=$1",[sidA]),
            a.meta.alignment.HE_STAIN.byGroup,'Explicit group re-scope can remove individual override paths');
        access=await token();
        const roi=await value('select to_jsonb(public.create_roi($1,$2,$3,$4,$5,$6)) as value',
            [access,sidA,'Green','Legacy ROI',JSON.stringify([[0,0],[1,0],[0,1]]),'viewer']);
        const sectionBeforeConversion=await value('select meta as value from public.sections where id=$1',[sidA]);
        const conversion=[{id:roi.id,expectedVersion:roi.version,
            poly_msi:{version:'msi-roi-polygon-v1',vertices:[[0,0],[1,0],[0,1]],geometry:group}}];
        equal(await value('select public.convert_rois_to_spatial_group_v1($1,$2) as value',[access,JSON.stringify(conversion)]),
            [{id:roi.id,version:roi.version+1}],'Existing ROI conversion RPC remains usable with a protected alignment');
        equal(await value('select meta as value from public.sections where id=$1',[sidA]),sectionBeforeConversion,
            'ROI conversion preserves the canonical alignment metadata');
        await snapshotReject(await prepare(),[a,b],{alignmentWriteProtocol:2},/spatial_publish_upgrade_required/);
        const wrong=clone(a);wrong.meta.alignment.HE_STAIN.byGroup[group.groupId].groupFrameKey='wrong';
        await snapshotReject(await prepare(),[wrong,b],protocol,/invalid_spatial_alignment/);
        const downgradeGroup=clone(a);downgrade(downgradeGroup.meta.alignment.HE_STAIN.byGroup[group.groupId]);
        await snapshotReject(await prepare(),[downgradeGroup,b],protocol,/alignment_contract_downgrade/);
        const missingGroup=clone(a);delete missingGroup.meta.alignment.HE_STAIN.byGroup;
        await snapshotReject(await prepare(),[missingGroup,b],protocol,/spatial_alignment_downgrade/);
    }
    a.ordinal=99;b.ordinal=99;
    await publish([b,a]);
    equal((await db.query('select id,ordinal from public.sections order by ordinal')).rows,
        [{id:sidB,ordinal:1},{id:sidA,ordinal:2}],'Ordinal repair and preserved UUIDs still work behind both wrappers');
    equal(await value('select payload as value from public.share_alignments where section_id=$1',[sidB]),payload(),
        'Publication retains collaborator alignment');
    const finalRevision=await revision();
    await publish([]);
    equal(await revision(),finalRevision+1);
    equal(await value('select count(*)::int as value from public.sections'),0,'Authorized modern full section deletion remains supported');
    equal(await value('select count(*)::int as value from public.share_alignments'),0,'Authorized section deletion retains existing cascade semantics');
    equal(await value("select coalesce(current_setting('share_test.alignment_write_protocol',true),'') as value"),'');
}

for(const options of [{withSpatial:false},{withSpatial:true},{withSpatial:true,crlf:true}]) {
    const f=await fixture(options);
    try {await exercise(f);} finally {await f.db.close();}
}

// Deployment must stop on a legacy ordinal writer or a customized endpoint;
// it must never replace unknown deployed code using a broad schema reapply.
const prerequisite=await fixture({withSpatial:true,crlf:true,legacyOrdinal:true});
try {
    const before=await prerequisite.source(writer);
    await reject(()=>prerequisite.db.exec(migration),/section_ordinal_hotfix/);
    await prerequisite.db.exec('rollback');
    equal(await prerequisite.source(writer),before);
    equal(await prerequisite.value("select to_regprocedure('public.alignment_contract_capabilities_v2()')::text as value"),null);
    await prerequisite.db.exec(windows(ordinal));
    await prerequisite.db.exec(windows(migration));
    equal((await prerequisite.value('select public.alignment_contract_capabilities_v2() as value')).version,2,
        'Reviewed ordinal prerequisite followed by alignment migration succeeds');
} finally {await prerequisite.db.close();}

const customized=await fixture();
try {
    const definition=await customized.value('select pg_get_functiondef($1::regprocedure) as value',[shared]);
    const old=await customized.source(shared),changed=old+'\n-- custom operator logic\n';
    await customized.db.exec(definition.replace(old,changed));
    await reject(()=>customized.db.exec(migration),/unexpected_shared_base/);
    await customized.db.exec('rollback');
    equal(await customized.source(shared),changed,'Unexpected custom function is left unchanged');
    equal(await customized.value("select to_regprocedure('public._publish_doc_write_before_alignment_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)')::text as value"),null);
} finally {await customized.db.close();}

console.log('Alignment contract database regression: PASS ('+checks+' checks; synthetic databases only)');
