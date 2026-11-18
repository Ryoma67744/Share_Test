import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import Spatial from '../viewer/msi-spatial-groups.js';

// Every database in this suite is disposable and contains synthetic data only.
const sql=name=>readFile(new URL('../supabase/'+name,import.meta.url),'utf8');
const [schema,locks,publisher,spatial,hotfix]=await Promise.all(
    ['schema.sql','share_locks.sql','publish_safety_v2.sql','spatial_groups_v1.sql','section_ordinal_hotfix.sql'].map(sql));
const signature='public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)';
const baseSignature='public._publish_doc_write_before_spatial_v1(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)';
const password='synthetic-ordinal-master';
const clone=value=>JSON.parse(JSON.stringify(value));
let checks=0;
const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const reject=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
const section=(id,ordinal)=>({id,ordinal,displayName:'Section '+id,meta:{},storagePaths:{images:{},msiSeries:{}}});

// The repository's retained pre-v2 script is the actual old implementation.
// Install only its writer definition into the disposable fixture, never its
// legacy grants or its public endpoint. This needs neither git nor a fixture
// copied from the new implementation under test.
const legacyDefinition=locks.match(/create or replace function public\.upsert_project_doc\([\s\S]*?\n\$\$;/)?.[0];
assert.ok(legacyDefinition,'Legacy writer fixture must remain available');
const legacyWriter=legacyDefinition.replace('public.upsert_project_doc(', 'public._publish_doc_write_v2(');
const windowsLines=source=>source.replace(/\r?\n/g,'\r\n');

async function fixture({legacy=false,withSpatial=false,crlf=false}={}) {
    const db=new PGlite({extensions:{pgcrypto}});
    const value=async(query,params=[])=>(await db.query(query,params)).rows[0].value;
    const rows=async()=> (await db.query("select id,ordinal,display_name,meta,storage_paths from public.sections order by ordinal")).rows;
    const state=()=>value(`select jsonb_build_object(
        'projects',(select jsonb_agg(to_jsonb(p) order by id) from public.projects p),
        'sections',(select jsonb_agg(to_jsonb(s) order by id) from public.sections s),
        'rois',(select jsonb_agg(to_jsonb(r) order by id) from public.rois r),
        'alignments',(select jsonb_agg(to_jsonb(a) order by section_id) from public.share_alignments a),
        'receipts',(select jsonb_agg(to_jsonb(r) order by slug,request_id) from public.publish_receipts r),
        'sessions',(select jsonb_agg(to_jsonb(s) order by token) from public.publish_sessions s),
        'objects',(select jsonb_agg(to_jsonb(o) order by id) from storage.objects o)
    ) as value`);
    const prepare=async(revision,create=false)=>{
        const id=randomUUID();
        const ticket=await value('select public.request_publish_session_v2($1,$2,$3,$4,$5) as value',
            [password,'ordinal-fixture',id,revision,create]);
        return {id,ticket,revision,create};
    };
    const commit=(request,sections,rois=[],meta={spatialWriteProtocol:1})=>value(
        'select public.publish_project_doc_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as value',
        [password,request.ticket.token,request.id,request.revision,request.create,'ordinal-fixture','Ordinal fixture',
            JSON.stringify(meta),null,null,JSON.stringify(sections),JSON.stringify(rois),true]);
    const publish=async(sections,rois=[],meta={spatialWriteProtocol:1})=>{
        const revision=await value("select coalesce((select publish_revision from public.projects where slug='ordinal-fixture'),0) as value");
        return commit(await prepare(revision,revision===0),sections,rois,meta);
    };
    try {
        await db.exec(`create role anon;create role authenticated;create schema extensions;create extension pgcrypto with schema extensions;
            create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
            create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
            alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;
            grant select,insert,update,delete on storage.objects to anon,authenticated;`);
        await db.exec(schema);await db.exec(locks);await db.exec(publisher);
        await db.exec(`create or replace function public._verify_master_pw(_pw text) returns boolean
            language sql security definer as $$select _pw='synthetic-ordinal-master'$$;`);
        const expectedSource=await value('select prosrc as value from pg_proc where oid=$1::regprocedure',[signature]);
        if(legacy)await db.exec(crlf?windowsLines(legacyWriter):legacyWriter);
        if(withSpatial)await db.exec(crlf?windowsLines(spatial):spatial);
        if(crlf) {
            equal(/\r\n/.test(await value('select prosrc as value from pg_proc where oid=$1::regprocedure',
                [withSpatial?baseSignature:signature])),true,'Fixture stores genuine CRLF in the legacy function body');
            if(withSpatial)equal(/\r\n/.test(await value('select prosrc as value from pg_proc where oid=$1::regprocedure',
                [signature])),true,'Fixture stores genuine CRLF in the spatial guard body');
        }
        return {db,value,rows,state,prepare,commit,publish,withSpatial,expectedSource};
    } catch(error) {await db.close();throw error;}
}

async function assertOrder(f,ids) {
    const rows=await f.rows();
    equal(rows.map(row=>row.meta.client_id),ids,'Stored order must follow the document array');
    equal(rows.map(row=>row.ordinal),ids.map((_,index)=>index+1),'Stored ordinals must be unique and consecutive');
    return rows;
}

async function exercise(f) {
    const {db,value,rows,state,prepare,commit,publish}=f;
    const initial=await rows(),ids=new Map(initial.map(row=>[row.meta.client_id,row.id]));
    const pid=await value("select id as value from public.projects where slug='ordinal-fixture'");
    const a=section('A',1),b=section('B',1),c=section('C',1),d=section('D',1),e=section('E',1);
    await db.query("insert into storage.objects(bucket_id,name) values('atlases','ordinal-fixture/source.txt')");
    b.storagePaths.msiSeries.MSI_A={path:'ordinal-fixture/source.txt',filename:'unchanged-original.txt',kind:'txt'};
    const viewerRoi=await value(`insert into public.rois(project_id,section_id,color_key,name,poly_msi,created_by,version)
        values($1,$2,'Blue','Collaborator ROI','[[0,0],[1,0],[0,1]]','viewer',4) returning to_jsonb(rois) as value`,[pid,ids.get('B')]);
    const alignment=await value(`insert into public.share_alignments(project_id,section_id,payload)
        values($1,$2,'{"landmark":"retained"}') returning to_jsonb(share_alignments) as value`,[pid,ids.get('B')]);
    const masterRoi={sectionId:'B',colorKey:'Red',name:'Master ROI',polyMsi:[[0,0],[2,0],[0,2]],createdBy:'master',version:2};
    const originalObjects=(await state()).objects;

    // Inserting first would collide with the former A:1 in the old row loop.
    // Missing, string and duplicate legacy ordinals are all ignored safely.
    const missing=clone(b);delete missing.ordinal;
    await publish([c,missing,{...a,ordinal:'invalid legacy value'}],[masterRoi]);
    let saved=await assertOrder(f,['C','B','A']);
    for(const row of saved)if(ids.has(row.meta.client_id))equal(row.id,ids.get(row.meta.client_id),'Retained section UUID must not change');
    ids.set('C',saved[0].id);
    equal(saved[1].display_name,b.displayName,'Section labels remain unchanged');
    equal(saved[1].storage_paths,b.storagePaths,'Original references remain attached to their section');
    equal(await value('select to_jsonb(r) as value from public.rois r where id=$1',[viewerRoi.id]),viewerRoi,'Collaborator ROI and version survive insertion and reorder');
    equal(await value('select to_jsonb(a) as value from public.share_alignments a where section_id=$1',[ids.get('B')]),alignment,'Shared alignment survives insertion and reorder');
    equal(await value("select section_id as value from public.rois where created_by='master'"),ids.get('B'),'Master ROI resolves to the same server section');
    equal((await state()).objects,originalObjects,'Publishing changes no stored original objects');

    // A pure swap also failed before the fix, despite a final unique sequence.
    await publish([{...a,ordinal:1},{...b,ordinal:2},{...c,ordinal:3}],[masterRoi]);
    await assertOrder(f,['A','B','C']);
    await publish([a,b,c,d],[masterRoi]);
    saved=await assertOrder(f,['A','B','C','D']);ids.set('D',saved[3].id);
    const extremes=[['A',-2147483648],['B',-1],['C',-2],['D',2147483647]];
    for(const [clientId,ordinal]of extremes)await db.query("update public.sections set ordinal=$1 where meta->>'client_id'=$2",[ordinal,clientId]);
    await publish([d,c,b,a],[masterRoi]);
    saved=await assertOrder(f,['D','C','B','A']);
    for(const row of saved)equal(row.id,ids.get(row.meta.client_id),'Legacy INT_MIN/INT_MAX and occupied negative slots cannot lose section identity');

    // Remove a middle section and add another: no client ID or ordinal reuse.
    await publish([d,e,b,a],[masterRoi]);
    saved=await assertOrder(f,['D','E','B','A']);
    equal(saved.filter(row=>row.meta.client_id!=='E').map(row=>row.id),['D','B','A'].map(id=>ids.get(id)));
    equal(await value('select count(*)::int as value from public.sections where id=$1',[ids.get('C')]),0,'Only the removed section disappears');
    equal(await value('select to_jsonb(r) as value from public.rois r where id=$1',[viewerRoi.id]),viewerRoi);
    equal(await value('select to_jsonb(a) as value from public.share_alignments a where section_id=$1',[ids.get('B')]),alignment);

    let revision=await value('select publish_revision as value from public.projects where id=$1',[pid]);
    const failed=await prepare(revision),before=await state();
    await reject(()=>commit(failed,[a,a]),error=>error.code==='22023'&&/invalid_section_identity/.test(error.message));
    equal(await state(),before,'Malformed duplicate client IDs cannot partially update any row');
    // The version cast fails after section staging/upserts and master ROI removal.
    await reject(()=>commit(failed,[a,b,e,d],[{...masterRoi,version:'invalid'}]),/invalid input syntax for type integer/);
    equal(await state(),before,'A late error rolls back temporary ordinals, metadata, ROIs and revision together');
    await reject(()=>commit(failed,[a,{...b,storagePaths:{images:{HE:{path:'ordinal-fixture/missing'}}}},e,d],[masterRoi]),/publish_source_missing/);
    equal(await state(),before,'Missing originals fail before changing the published document');

    // Legacy databases had no unique client_id constraint. An ambiguous match
    // must stop publication rather than leave an unmatched row at a temp slot.
    const ambiguousId=await value(`insert into public.sections(project_id,ordinal,display_name,meta,storage_paths)
        values($1,99,'Ambiguous legacy row','{"client_id":"B"}','{}') returning id as value`,[pid]);
    const ambiguous=await prepare(revision),ambiguousState=await state();
    await reject(()=>commit(ambiguous,[a,b,e],[masterRoi]),error=>error.code==='22023'&&/invalid_stored_section_identity/.test(error.message));
    equal(await state(),ambiguousState,'Ambiguous stored identities roll back even preceding section deletions');
    await db.query('delete from public.sections where id=$1',[ambiguousId]);

    const stale=await prepare(revision);
    await publish([d,e,b,a],[masterRoi]);
    const advanced=await state();
    await reject(()=>commit(stale,[a,b,e,d],[masterRoi]),error=>error.code==='PT409');
    equal(await state(),advanced,'Revision conflicts retain the complete winning document');
    equal(await value("select condeferrable as value from pg_constraint where conrelid='public.sections'::regclass and conname='sections_project_id_ordinal_key'"),false,'Existing ON CONFLICT users retain an immediate unique index');

    if(f.withSpatial) {
        const spatialA=clone(a),entry={kind:'txt',sourceFileId:'synthetic-source'};
        const geometry={sourceRef:Spatial.sourceReference(entry),
            legacy:{W:2,H:2,confirmed:true,x:[[0,0],[1,1]],y:[[0,0],[1,1]]},
            displayGeometry:{version:'msi-proportional-v1',W:2,H:2,x:{origin:0,step:1},y:{origin:0,step:1}}};
        const group=Spatial.roiMeta(spatialA,entry,geometry);
        const spatialRoi={sectionId:'A',colorKey:'Red',name:'Spatial ROI',createdBy:'master',
            polyMsi:{version:'msi-roi-polygon-v1',vertices:[[0,0],[1,0],[0,1]],geometry:group}};
        await publish([spatialA,b,e,d],[spatialRoi]);
        await assertOrder(f,['A','B','E','D']);
        revision=await value('select publish_revision as value from public.projects where id=$1',[pid]);
        const guarded=await prepare(revision),guardedState=await state();
        await reject(()=>commit(guarded,[b,spatialA,e,d],[spatialRoi],{}),/spatial_publish_upgrade_required/);
        equal(await state(),guardedState,'The spatial wrapper remains active in the public publisher');
        await reject(()=>commit(guarded,[b,spatialA,e,d],[{...spatialRoi,polyMsi:spatialRoi.polyMsi.vertices}]),/spatial_roi_downgrade/);
        equal(await state(),guardedState,'Spatial downgrade cannot remove the existing geometry');
        await publish([b,spatialA,e,d],[spatialRoi]);
        await assertOrder(f,['B','A','E','D']);
        equal(await value("select id as value from public.sections where meta->>'client_id'='A'"),ids.get('A'));
    }
    await publish([]);
    equal(await rows(),[],'Explicitly publishing an empty project remains supported');
}

for(const mode of [
    {legacy:false,withSpatial:false},
    {legacy:true,withSpatial:false},
    {legacy:true,withSpatial:true},
    {legacy:true,withSpatial:false,crlf:true},
    {legacy:true,withSpatial:true,crlf:true},
]) {
    const f=await fixture(mode);
    const appliedHotfix=mode.crlf?windowsLines(hotfix):hotfix;
    try {
        const request=await f.prepare(0,true),duplicateSections=[section('A',1),section('B',1)];
        const before=await f.state();
        const wrapper=mode.withSpatial?await f.value('select pg_get_functiondef($1::regprocedure) as value',[signature]):null;
        const privileges=async()=>f.value(`select jsonb_agg(jsonb_build_object('name',p.proname,'owner',p.proowner,
            'acl',p.proacl,'securityDefiner',p.prosecdef,'config',p.proconfig) order by p.proname) as value
            from pg_proc p where p.oid in (to_regprocedure($1),to_regprocedure($2))`,[signature,baseSignature]);
        const beforePrivileges=await privileges();
        if(mode.legacy) {
            await reject(()=>f.commit(request,duplicateSections),error=>error.code==='23505'&&error.constraint==='sections_project_id_ordinal_key');
            equal(await f.state(),before,'The reported legacy constraint error is reproducible without partial writes');
        }
        const verification=(await f.db.exec(appliedHotfix)).at(-1).rows[0];
        equal([verification.ready,verification.spatial_guard_preserved],[true,true],
            'Migration verification recognizes both LF and CRLF deployments');
        equal(await f.state(),before,'Applying the hotfix changes function definitions only');
        equal(await f.value('select prosrc as value from pg_proc where oid=$1::regprocedure',
            [mode.withSpatial?baseSignature:signature]),f.expectedSource,'Upgrade and fresh installation use the identical writer implementation');
        equal(await privileges(),beforePrivileges,'Hotfix retains internal writer ownership, ACLs and search paths');
        if(mode.withSpatial)equal(await f.value('select pg_get_functiondef($1::regprocedure) as value',[signature]),wrapper,'Spatial wrapper definition is unchanged');
        const receipt=await f.commit(request,duplicateSections);
        equal(receipt.server_revision,1,'An unchanged previously failed request becomes publishable');
        await assertOrder(f,['A','B']);
        const committed=await f.state();
        equal(await f.commit(request,duplicateSections),receipt,'Exact retries return the same publication receipt');
        equal(await f.state(),committed,'Receipt replay does not rewrite rows or increment revisions');
        await reject(()=>f.commit(request,[section('A',1),section('B',2)]),/reused_with_different_document/);
        equal(await f.state(),committed,'Canonicalizing storage does not weaken immutable request hashing');
        await f.db.exec(appliedHotfix);await f.db.exec(appliedHotfix);
        equal(await f.state(),committed,'Repeated hotfix application preserves every published row');
        equal(await privileges(),beforePrivileges);
        if(mode.withSpatial)equal(await f.value('select pg_get_functiondef($1::regprocedure) as value',[signature]),wrapper,
            'Repeated hotfix application preserves the spatial wrapper bytes, including CRLF');
        equal(await f.value("select has_function_privilege('anon',$1,'EXECUTE') as value",[signature]),false);
        if(mode.withSpatial)equal(await f.value("select has_function_privilege('authenticated',$1,'EXECUTE') as value",[baseSignature]),false);
        await exercise(f);
        // Unknown deployments must not be partially overwritten. A harmless
        // extra comment simulates locally customized code with a new hash.
        const target=signature; // Base writer without spatial; guard wrapper with it.
        const originalDefinition=await f.value('select pg_get_functiondef($1::regprocedure) as value',[target]);
        await f.db.exec(originalDefinition.replace(/(\r?\n)begin(\r?\n)/,
            '$1-- Synthetic unrecognized deployment$2begin$2'));
        const customized=await f.value('select pg_get_functiondef($1::regprocedure) as value',[target]),safeState=await f.state();
        await reject(()=>f.db.exec(appliedHotfix),/Unexpected Share_Test/);
        await f.db.exec('rollback');
        equal(await f.value('select pg_get_functiondef($1::regprocedure) as value',[target]),customized,'Unexpected function bodies are retained for operator review');
        equal(await f.state(),safeState,'Rejected migration cannot change stored data');
        await f.db.exec(originalDefinition);
    } finally {await f.db.close();}
}
console.log('Section ordinal SQL regression: PASS ('+checks+' checks; disposable PGlite only)');
