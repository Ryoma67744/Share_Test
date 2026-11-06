import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
const db=new PGlite({extensions:{pgcrypto}});
const sql=n=>readFile(new URL('../supabase/'+n,import.meta.url),'utf8');
const value=async(q,p=[])=>(await db.query(q,p)).rows[0].value;
const password='synthetic-master-only';
const session=(slug,id,rev,create)=>value('select public.request_publish_session_v2($1,$2,$3,$4,$5) as value',[password,slug,id,rev,create]);
const publish=(ticket,id,rev,create,sections=[],extra={})=>value('select public.publish_project_doc_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as value',
 [password,ticket.token,id,rev,create,extra.slug||'fixture',extra.name||'Fixture',JSON.stringify(extra.meta||{}),null,null,JSON.stringify(sections),JSON.stringify(extra.rois||[]),true]);
let checks=0;
const rejects=async(fn,re)=>{await assert.rejects(fn,re);checks++;};
const conflict=async(fn,pattern=/publish_conflict/)=>rejects(fn,error=>{
 assert.equal(error.code,'PT409','Deterministic conflicts must not ask PostgREST to retry a transaction');
 assert.match(error.message,pattern);return true;
});
const storedState=()=>value(`select jsonb_build_object(
 'projects',(select jsonb_agg(to_jsonb(p) order by id) from public.projects p),
 'sections',(select jsonb_agg(to_jsonb(s) order by id) from public.sections s),
 'rois',(select jsonb_agg(to_jsonb(r) order by id) from public.rois r),
 'receipts',(select jsonb_agg(to_jsonb(r) order by slug,request_id) from public.publish_receipts r),
 'sessions',(select jsonb_agg(to_jsonb(s) order by token) from public.publish_sessions s),
 'objects',(select jsonb_agg(to_jsonb(o) order by id) from storage.objects o)
 ) as value`);
try{
 await db.exec(`create role anon;create role authenticated;create schema extensions;create extension pgcrypto with schema extensions;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
 alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;
 grant select,insert,update,delete on storage.objects to anon,authenticated;`);
 await db.exec(await sql('schema.sql'));await db.exec(await sql('share_locks.sql'));
 await db.exec(`create or replace function public._verify_master_pw(_pw text) returns boolean language sql security definer as $$select _pw='synthetic-master-only'$$;
 insert into public.publish_sessions(token,slug,expires_at) values('legacy-ticket','fixture',now()+interval '1 hour');`);
 const migration=await sql('publish_safety_v2.sql');await db.exec(migration);await db.exec(migration);checks++;
 await rejects(()=>value("select public.request_publish_session($1,'fixture') as value",[password]),/publish_protocol_upgrade_required/);
 await rejects(()=>value("select public.upsert_project_doc($1,'fixture','bad','{}',null,null,'[]','[]',true) as value",[password]),/publish_protocol_upgrade_required/);
 assert.equal(await value("select public._publish_session_valid_for_path('legacy-ticket','fixture/old') as value"),false);checks++;
 await rejects(()=>session('fixture',randomUUID(),null,false),/baseline_unknown/);
 const emptyState=await storedState();
 await rejects(()=>value('select public.request_publish_session_v2($1,$2,$3,$4,$5) as value',
  ['wrong-password','fixture',randomUUID(),0,true]),error=>error.code==='28000');
 assert.deepEqual(await storedState(),emptyState,'Authentication still runs before ticket creation');checks++;
 await conflict(()=>session('fixture',randomUUID(),0,false));
 assert.deepEqual(await storedState(),emptyState,'A missing revision baseline must not mint a session or write data');checks++;
 const id=randomUUID(),ticket=await session('fixture',id,0,true),object=ticket.object_prefix+'original.txt';
 const concurrentCreateId=randomUUID(),concurrentCreateTicket=await session('fixture',concurrentCreateId,0,true);
 await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-publish-token':ticket.token})]);
 await db.exec('set role anon');
 await db.query("insert into storage.objects(bucket_id,name) values('atlases',$1)",[object]);checks++;
 await rejects(()=>db.query("insert into storage.objects(bucket_id,name) values('atlases','fixture/old-path')"),/row-level security/);
 await rejects(()=>db.query("insert into storage.objects(bucket_id,name) values('atlases',$1) on conflict(bucket_id,name) do update set name=excluded.name",[object]),/row-level security/);
 assert.equal((await db.query("update storage.objects set name='overwritten' where name=$1 returning *",[object])).rows.length,0);checks++;
 assert.equal((await db.query('delete from storage.objects where name=$1 returning *',[object])).rows.length,0);checks++;
 await db.exec('reset role');
 const section={id:'s',ordinal:1,displayName:'Section',meta:{},storagePaths:{images:{},msiSeries:{MSI_A:{path:object,filename:'original.txt',kind:'txt'}}}};
 const first=await publish(ticket,id,0,true,[section]);assert.equal(first.server_revision,1);checks++;
 const createdState=await storedState();
 await conflict(()=>publish(concurrentCreateTicket,concurrentCreateId,0,true,[section],{name:'Must not replace'}));
 assert.deepEqual(await storedState(),createdState,'Create conflict preserves originals, revisions, sessions and receipts');checks++;
 const repeated=await publish(ticket,id,0,true,[section]);assert.deepEqual(repeated,first);checks++;
 assert.deepEqual((await session('fixture',id,0,true)).receipt,first);checks++;
 await rejects(()=>publish(ticket,id,0,true,[section],{name:'different'}),/reused_with_different_document/);
 assert.equal(await value('select count(*)::int as value from public.projects'),1);checks++;
 const a=randomUUID(),b=randomUUID(),ta=await session('fixture',a,1,false),tb=await session('fixture',b,1,false);
 const pid=first.project_id,sid=await value('select id as value from public.sections where project_id=$1',[pid]);
 await db.query("insert into public.rois(project_id,section_id,color_key,name,poly_msi,created_by,version) values($1,$2,'Red','viewer ROI','[]','viewer',1)",[pid,sid]);
 assert.equal((await publish(ta,a,1,false,[section],{name:'winning'})).server_revision,2);checks++;
 const winningState=await storedState();
 await rejects(()=>value('select public.publish_project_doc_v2($1,$2,$3,$4,$5,$6,$7,$8,$9) as value',
  ['wrong-password',tb.token,b,1,false,'fixture','Denied','{}',null]),error=>error.code==='28000');
 assert.deepEqual(await storedState(),winningState,'Authentication still runs before revision checks and writes');checks++;
 await conflict(()=>publish(tb,b,1,false,[section],{name:'stale'}));
 assert.deepEqual(await storedState(),winningState,'Stale commit has no partial project, ROI, receipt or Storage writes');checks++;
 assert.equal(await value('select display_name as value from public.projects where id=$1',[pid]),'winning');checks++;
 assert.equal(await value('select count(*)::int as value from public.rois where created_by=\'viewer\''),1);checks++;
 await conflict(()=>session('fixture',randomUUID(),0,true));
 await conflict(()=>session('fixture',randomUUID(),1,false));
 assert.deepEqual(await storedState(),winningState,'Rejected create/update tickets do not allocate sessions');checks++;
 const missingId=randomUUID(),missingTicket=await session('fixture',missingId,2,false);
 await rejects(()=>publish(missingTicket,missingId,2,false,[{...section,storagePaths:{images:{HE:{path:'fixture/missing'}}}}]),/source_missing/);
 await rejects(()=>publish(missingTicket,missingId,2,false,[{id:'s'}]),/invalid_section/);
 await rejects(()=>publish(missingTicket,missingId,2,false,null),/invalid_publish_document/);
 await rejects(()=>publish(missingTicket,missingId,2,false,[{...section,storagePaths:{images:null}}]),/invalid_section/);
 await rejects(()=>publish(missingTicket,missingId,2,false,[{...section,storagePaths:{images:{MSI_A:{path:'fixture/missing'}},msiSeries:section.storagePaths.msiSeries}}]),/source_missing/);
 await rejects(()=>publish(missingTicket,missingId,2,false,[section],{meta:{roiMedia:null}}),/invalid_roi_media/);
 assert.equal(await value('select publish_revision as value from public.projects where id=$1',[pid]),2);checks++;
 const pub=await value("select row_to_json(s) as value from public.unlock_public_project('fixture') s");
 assert.equal((await value('select public.get_project_doc($1) as value',[pub.token])).publish_revision,2);checks++;
 await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-share-token':pub.token})]);
 await db.exec('set role anon');
 await db.query("insert into storage.objects(bucket_id,name) values('atlases','fixture/shared/unique-photo.png')");checks++;
 await rejects(()=>db.query("insert into storage.objects(bucket_id,name) values('atlases','another/shared/foreign.png')"),/row-level security/);
 await rejects(()=>db.query("insert into storage.objects(bucket_id,name) values('atlases','fixture/shared/unique-photo.png') on conflict(bucket_id,name) do update set name=excluded.name"),/row-level security/);
 await db.exec('reset role');
 await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-publish-token':ta.token})]);
 await db.exec('set role anon');
 await rejects(()=>db.query("insert into storage.objects(bucket_id,name) values('atlases',$1)",[ta.object_prefix+'after-commit']),/row-level security/);
 await rejects(()=>value('select public._publish_doc_write_v2($1,$2,$3,$4,$5,$6,$7,$8,$9) as value',[password,'fixture','bypass','{}',null,null,'[]','[]',true]),/permission denied/);
 await db.exec('reset role');
 // Shared edits use the same non-retryable conflict contract without changing
 // their existing optimistic locks, authorization or successful update path.
 const roiId=await value("select id as value from public.rois where project_id=$1 and created_by='viewer'",[pid]);
 const roiState=await storedState();
 await conflict(()=>value('select to_jsonb(public.update_roi($1,$2,$3,null,null,$4)) as value',[pub.token,roiId,0,'Rejected']),/stale_version/);
 assert.deepEqual(await storedState(),roiState);checks++;
 await rejects(()=>value('select public.update_roi($1,$2,$3) as value',['invalid-token',roiId,1]),error=>error.code==='28000');
 assert.deepEqual(await storedState(),roiState);checks++;
 const roiUpdated=await value('select to_jsonb(public.update_roi($1,$2,$3,null,null,$4)) as value',[pub.token,roiId,1,'Accepted']);
 assert.equal(roiUpdated.version,2);assert.equal(roiUpdated.name,'Accepted');checks++;
 const overlay=await value("select to_jsonb(public.create_share_overlay($1,'Shared','[{\"key\":\"MSI_A\"},{\"key\":\"MSI_B\"}]')) as value",[pub.token]);
 const getOverlay=()=>value('select to_jsonb(o) as value from public.share_overlays o where id=$1',[overlay.id]);
 await conflict(()=>value('select public.update_share_overlay($1,$2,$3,$4) as value',[pub.token,overlay.id,0,'Rejected']),/stale_version/);
 assert.deepEqual(await getOverlay(),overlay);checks++;
 await rejects(()=>value('select public.update_share_overlay($1,$2,$3) as value',['invalid-token',overlay.id,1]),error=>error.code==='28000');
 assert.deepEqual(await getOverlay(),overlay);checks++;
 const overlayUpdated=await value('select to_jsonb(public.update_share_overlay($1,$2,$3,$4)) as value',[pub.token,overlay.id,1,'Accepted']);
 assert.equal(overlayUpdated.version,2);assert.equal(overlayUpdated.name,'Accepted');checks++;
 const align=(version,payload={transform:'accepted'},token=pub.token)=>value('select to_jsonb(public.upsert_share_alignment($1,$2,$3::jsonb,$4)) as value',[token,sid,JSON.stringify(payload),version]);
 await conflict(()=>align(1),/stale_version/);
 assert.equal(await value('select count(*)::int as value from public.share_alignments'),0);checks++;
 const alignment=await align(null),getAlignment=()=>value('select to_jsonb(a) as value from public.share_alignments a where section_id=$1',[sid]);
 await conflict(()=>align(null,{transform:'rejected duplicate'}),/stale_version/);
 await conflict(()=>align(0,{transform:'rejected stale'}),/stale_version/);
 assert.deepEqual(await getAlignment(),alignment);checks++;
 await rejects(()=>align(1,{},'invalid-token'),error=>error.code==='28000');
 assert.deepEqual(await getAlignment(),alignment);checks++;
 const alignmentUpdated=await align(1,{transform:'updated'});
 assert.equal(alignmentUpdated.version,2);assert.deepEqual(alignmentUpdated.payload,{transform:'updated'});checks++;
 console.log('Publish safety SQL regression: PASS ('+checks+' checks; isolated PGlite, not production)');
}finally{await db.close();}
