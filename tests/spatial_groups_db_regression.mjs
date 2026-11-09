import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import Spatial from '../viewer/msi-spatial-groups.js';

const db=new PGlite({extensions:{pgcrypto}});
const sql=name=>readFile(new URL('../supabase/'+name,import.meta.url),'utf8');
const value=async(query,params=[])=>(await db.query(query,params)).rows[0].value;
const clone=value=>JSON.parse(JSON.stringify(value));
const password='synthetic-spatial-master';
const section={id:'local-section',ordinal:1,displayName:'Section',meta:{},storagePaths:{images:{},msiSeries:{}}};
const entry={kind:'txt',sourceFileId:'source-A'};
const geometry={sourceRef:Spatial.sourceReference(entry),
    legacy:{W:2,H:2,confirmed:true,x:[[0,0],[1,1]],y:[[0,0],[1,1]]},
    displayGeometry:{version:'msi-proportional-v1',W:2,H:2,x:{origin:0,step:1},y:{origin:0,step:1}}};
const groupRoi=Spatial.roiMeta(section,entry,geometry);
const groupId=groupRoi.groupId;
const envelope={version:'msi-roi-polygon-v1',vertices:[[0,0],[1,0],[0,1]],geometry:groupRoi};
const record={scope:'group',groupId,groupFrameKey:groupRoi.frameKey,groupFrameVersion:1,T_he_to_msi:[[1,0,0],[0,1,0],[0,0,1]]};
section.meta.alignment={HE:{byGroup:{[groupId]:record}}};
const roi={sectionId:section.id,colorKey:'Red',name:'Shared shape',polyMsi:envelope,createdBy:'master'};
const publish=(sections,rois=[],meta={})=>value('select public._publish_doc_write_v2($1,$2,$3,$4,$5,$6,$7,$8,$9) as value',
    [password,'spatial-fixture','Fixture',JSON.stringify(meta),null,null,JSON.stringify(sections),JSON.stringify(rois),true]);
let checks=0;
const reject=async(fn,pattern)=>{await assert.rejects(fn,error=>{
    assert.match(error.message,pattern);assert.notEqual(error.code,'40001');return true;
});checks++;};
const stored=()=>value(`select jsonb_build_object(
 'sections',(select jsonb_agg(to_jsonb(s) order by id) from public.sections s),
 'rois',(select jsonb_agg(to_jsonb(r) order by id) from public.rois r),
 'alignments',(select jsonb_agg(to_jsonb(a) order by section_id) from public.share_alignments a)
) as value`);
try {
    await db.exec(`create role anon;create role authenticated;create schema extensions;create extension pgcrypto with schema extensions;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
      alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;
      grant select,insert,update,delete on storage.objects to anon,authenticated;`);
    await db.exec(await sql('schema.sql'));
    await db.exec(await sql('share_locks.sql'));
    await db.exec(`create or replace function public._verify_master_pw(_pw text) returns boolean language sql security definer as $$select _pw='synthetic-spatial-master'$$;`);
    await db.exec(await sql('publish_safety_v2.sql'));
    const migration=await sql('spatial_groups_v1.sql');
    await db.exec(migration);await db.exec(migration);checks++;
    assert.deepEqual(await value('select public.spatial_group_capabilities_v1() as value'),
        {version:1,roiGeometry:'msi-group-v1',alignmentScope:'group',protectDowngrade:true,bulkRoi:true});checks++;

    const legacy={...clone(section),meta:{}};
    await publish([legacy],[]);checks++;
    const before=await stored();
    await reject(()=>publish([section],[roi]),/spatial_publish_upgrade_required/);
    assert.deepEqual(await stored(),before,'rejected publisher cannot partially migrate data');checks++;
    await publish([section],[roi],{spatialWriteProtocol:1});
    assert.equal(await value("select meta ? 'spatialWriteProtocol' as value from public.projects where slug='spatial-fixture'"),false);checks++;
    const sid=await value("select id as value from public.sections where meta->>'client_id'='local-section'");
    const pid=await value("select id as value from public.projects where slug='spatial-fixture'");
    let token=(await value("select to_jsonb(t) as value from public.unlock_public_project('spatial-fixture') t")).token;
    const id=await value("select id as value from public.rois where color_key='Red'");
    const renamed=await value('select to_jsonb(public.update_roi($1,$2,$3,null,null,$4)) as value',[token,id,1,'Renamed']);
    assert.deepEqual(renamed.poly_msi,envelope);checks++;
    await reject(()=>value('select public.update_roi($1,$2,$3,null,$4) as value',[token,id,2,JSON.stringify([[0,0],[1,0],[0,1]])]),/spatial_roi_downgrade/);
    assert.equal(await value('select version as value from public.rois where id=$1',[id]),2);checks++;
    await reject(()=>value('select public.update_roi($1,$2,$3,null,null,$4) as value',[token,id,1,'stale']),/stale_version/);
    const foreign=clone(envelope);foreign.geometry.sectionId='another-section';
    await reject(()=>value('select public.create_roi($1,$2,$3,$4,$5,$6) as value',[token,sid,'Blue','Foreign',JSON.stringify(foreign),'viewer']),/invalid_spatial_roi/);
    const invalid=clone(envelope);invalid.geometry.frameKey='incorrect';
    await reject(()=>value('select public.create_roi($1,$2,$3,$4,$5,$6) as value',[token,sid,'Blue','Invalid',JSON.stringify(invalid),'viewer']),/invalid_spatial_roi/);
    await value('select public.create_roi($1,$2,$3,$4,$5,$6) as value',[token,sid,'Blue','Collaborator',JSON.stringify(envelope),'viewer']);checks++;

    const alignment={alignment:{HE:{byGroup:{[groupId]:record}}}};
    await db.query('insert into public.share_alignments(project_id,section_id,payload) values($1,$2,$3)',[pid,sid,JSON.stringify(alignment)]);checks++;
    await reject(()=>db.query("update public.share_alignments set payload='{}' where section_id=$1",[sid]),/spatial_alignment_downgrade/);
    const wrongAlignment=clone(alignment);wrongAlignment.alignment.HE.byGroup[groupId].groupFrameKey='different';
    await reject(()=>db.query('update public.share_alignments set payload=$1 where section_id=$2',[JSON.stringify(wrongAlignment),sid]),/invalid_spatial_alignment/);
    await reject(()=>db.query("update public.sections set meta='{}' where id=$1",[sid]),/spatial_contract_downgrade/);
    const altered=clone(section.meta);altered.spatialGroups.groups[0].frameKey='different';
    await reject(()=>db.query('update public.sections set meta=$1 where id=$2',[JSON.stringify(altered),sid]),/spatial_contract_downgrade/);

    const unchanged=await stored();
    await reject(()=>publish([section],[roi]),/spatial_publish_upgrade_required/);
    assert.deepEqual(await stored(),unchanged);checks++;
    const downgraded={...clone(roi),polyMsi:envelope.vertices};
    await reject(()=>publish([section],[downgraded],{spatialWriteProtocol:1}),/spatial_roi_downgrade/);
    assert.deepEqual(await stored(),unchanged);checks++;
    const added={...entry,sourceFileId:'source-B'};
    Spatial.ensureGroup(section,added,{...geometry,sourceRef:Spatial.sourceReference(added)});
    await publish([section],[roi],{spatialWriteProtocol:1});
    assert.equal(await value("select jsonb_array_length(meta#>'{spatialGroups,groups,0,members}') as value from public.sections where id=$1",[sid]),2);checks++;
    assert.equal(await value("select count(*)::int as value from public.rois where created_by='viewer'"),1);checks++;
    await publish([section],[],{spatialWriteProtocol:1});
    assert.equal(await value("select count(*)::int as value from public.rois where created_by='master'"),0,'intentional ROI deletion remains supported');checks++;
    assert.equal(await value("select count(*)::int as value from public.rois where created_by='viewer'"),1);checks++;
    const publicPublish=async meta=>{
        const requestId=randomUUID();
        const revision=await value('select publish_revision as value from public.projects where id=$1',[pid]);
        const ticket=await value('select public.request_publish_session_v2($1,$2,$3,$4,false) as value',
            [password,'spatial-fixture',requestId,revision]);
        return value('select public.publish_project_doc_v2($1,$2,$3,$4,false,$5,$6,$7,null,null,$8,$9,true) as value',
            [password,ticket.token,requestId,revision,'spatial-fixture','Public path',JSON.stringify(meta),JSON.stringify([section]),'[]']);
    };
    assert.equal((await publicPublish({spatialWriteProtocol:1})).server_revision,1);checks++;
    const publicState=await stored();
    await reject(()=>publicPublish({}),/spatial_publish_upgrade_required/);
    assert.deepEqual(await stored(),publicState,'the public v2 publisher invokes the guarded writer');checks++;
    token=(await value("select to_jsonb(t) as value from public.unlock_public_project('spatial-fixture') t")).token;

    const createLegacy=async color=>value('select to_jsonb(public.create_roi($1,$2,$3,$4,$5,$6)) as value',
        [token,sid,color,'Legacy '+color,JSON.stringify(envelope.vertices),'viewer']);
    const firstLegacy=await createLegacy('Green'),secondLegacy=await createLegacy('Yellow');
    const convert=updates=>value('select public.convert_rois_to_spatial_group_v1($1,$2) as value',[token,JSON.stringify(updates)]);
    const updates=[firstLegacy,secondLegacy].map(row=>({id:row.id,expectedVersion:row.version,poly_msi:envelope}));
    const beforeBatch=await stored();
    await reject(()=>convert([updates[0],{...updates[1],expectedVersion:999}]),/stale_version/);
    assert.deepEqual(await stored(),beforeBatch,'a late batch conflict rolls back the earlier converted ROI');checks++;
    await reject(()=>convert([updates[0],updates[0]]),/invalid_spatial_roi_update/);
    assert.deepEqual(await stored(),beforeBatch);checks++;
    assert.deepEqual(await convert(updates),updates.map(row=>({id:row.id,version:2})));checks++;
    assert.equal(await value("select count(*)::int as value from public.rois where color_key in ('Green','Yellow') and poly_msi#>>'{geometry,version}'='msi-group-v1'"),2);checks++;
    await reject(()=>value('select public.convert_rois_to_spatial_group_v1($1,$2) as value',['invalid-token',JSON.stringify(updates)]),/token|unauthorized/);
    await db.exec('set role anon');
    assert.equal((await value('select public.spatial_group_capabilities_v1() as value')).version,1);checks++;
    await reject(()=>value("select public._spatial_group_v1('{}','x') as value"),/permission denied/);
    await db.exec('reset role');
    console.log('Spatial group database regression: PASS ('+checks+' checks)');
} finally {await db.close();}
