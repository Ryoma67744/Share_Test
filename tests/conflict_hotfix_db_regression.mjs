import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';

// Exercise the existing-server repair against real application definitions.
// All data and credentials in this database are synthetic and local only.
const db = new PGlite({extensions:{pgcrypto}});
const sql = name => readFile(new URL('../supabase/'+name,import.meta.url),'utf8');
const names = ['request_publish_session_v2','publish_project_doc_v2','update_roi',
  'update_share_overlay','upsert_share_alignment','register_from_exp_batch','save_mrm_exp_document'];
const functions = async () => (await db.query(`select oid::text, proname, prosrc,
  proowner::text, proacl::text, proconfig, prosecdef, prorettype::text, proargtypes::text
  from pg_proc where pronamespace='public'::regnamespace and proname=any($1) order by proname`,[names])).rows;
const tables = async () => {
  const list=(await db.query(`select schemaname,tablename from pg_tables
    where schemaname in ('public','storage') order by schemaname,tablename`)).rows;
  const result={};
  for (const {schemaname,tablename} of list) {
    const name='"'+schemaname+'"."'+tablename+'"';
    result[name]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as rows from ${name} t`)).rows[0].rows;
  }
  return result;
};
let checks=0;
try {
  await db.exec(`create role anon;create role authenticated;create schema extensions;
    create extension pgcrypto with schema extensions;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated;
    grant select,insert,update,delete on storage.objects to anon,authenticated;`);
  for (const file of ['schema.sql','share_locks.sql','publish_safety_v2.sql',
    'mrm_library.sql','mrm_reconcile.sql','mrm_exp_import.sql']) {
    // Reproduce the old deployment without copying whole stale SQL files.
    await db.exec((await sql(file)).replace(/(errcode\s*=\s*)'PT409'/gi,"$1'40001'"));
  }
  await db.exec(`create function public.unrelated_serialization_test() returns void language plpgsql
    as $$begin raise exception 'unrelated' using errcode='40001';end$$;
    create or replace function public._verify_master_pw(_pw text) returns boolean language sql security definer
    as $$select $1='synthetic-master-only'$$;
    insert into public.projects(slug,display_name) values('hotfix-fixture','Keep this project');
    insert into public.sections(project_id,ordinal,display_name)
      select id,1,'Keep this section' from public.projects where slug='hotfix-fixture';
    insert into public.rois(project_id,section_id,color_key,name,poly_msi,created_by)
      select project_id,id,'Red','Keep this ROI','[[1,2],[3,4],[5,6]]','master' from public.sections;
    insert into storage.objects(bucket_id,name) values('atlases','hotfix-fixture/source.txt');
    insert into public.mrm_compounds(name,note) values('Keep this molecule','Keep this note');`);
  const before=await functions(), dataBefore=await tables();
  assert.equal(before.length,7);checks++;
  assert.equal(before.reduce((n,f)=>n+[...f.prosrc.matchAll(/errcode\s*=\s*'40001'/gi)].length,0),12);checks++;
  const migration=await sql('conflict_error_hotfix.sql');
  const result=await db.exec(migration);
  const after=await functions();
  assert.deepEqual(after,before.map(f=>({...f,prosrc:f.prosrc.replace(/(errcode\s*=\s*)'40001'/gi,"$1'PT409'")})));checks++;
  assert.deepEqual(await tables(),dataBefore);checks++;
  assert.equal(result.at(-1).rows.length,7);assert.ok(result.at(-1).rows.every(r=>r.ready));checks++;
  await db.exec(migration);assert.deepEqual(await functions(),after);assert.deepEqual(await tables(),dataBefore);checks+=2;
  await assert.rejects(()=>db.query('select public.unrelated_serialization_test()'),{code:'40001'});checks++;
  await assert.rejects(()=>db.query("select public.request_publish_session_v2('wrong','missing',gen_random_uuid(),0,false)"),{code:'28000'});checks++;
  await assert.rejects(()=>db.query("select public.request_publish_session_v2('synthetic-master-only','missing',gen_random_uuid(),0,false)"),{code:'PT409'});checks++;
  assert.deepEqual(await tables(),dataBefore);checks++;

  // A later unexpected definition must roll back earlier replacements too.
  for (const name of ['request_publish_session_v2','save_mrm_exp_document']) {
    const row=(await db.query('select pg_get_functiondef(oid) as definition from pg_proc where pronamespace=\'public\'::regnamespace and proname=$1',[name])).rows[0];
    const replacement=name==='save_mrm_exp_document'?'P0001':'40001';
    await db.exec(row.definition.replace(/(errcode\s*=\s*)'PT409'/gi,"$1'"+replacement+"'"));
  }
  const unexpected=await functions();
  await assert.rejects(()=>db.exec(migration),/Unexpected conflict handlers/);checks++;
  await db.exec('rollback');
  assert.deepEqual(await functions(),unexpected);assert.deepEqual(await tables(),dataBefore);checks+=2;
  console.log('Conflict hotfix SQL regression: PASS ('+checks+' checks; isolated PGlite)');
} finally {await db.close();}
