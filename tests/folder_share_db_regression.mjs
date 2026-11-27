import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';

// Disposable PostgreSQL only. Authentication, JSON validation, row locks and
// rollback execute in SQL; the production folder password implementation stays real.
const db = new PGlite({extensions:{pgcrypto}});
const sql = name => readFile(new URL('../supabase/' + name, import.meta.url), 'utf8');
const migrationName = 'migrations/20261127114758_folder_share_checked.sql';
const value = async (query, params=[]) => (await db.query(query, params)).rows[0].value;
const pw = 'synthetic-folder-master';
const clone = value => JSON.parse(JSON.stringify(value));
const treeState = () => value('select tree as value from public.workspace_tree where id=1');
const snapshot = () => value(`select jsonb_build_object(
  'workspace',(select jsonb_agg(to_jsonb(w) order by id) from public.workspace_tree w),
  'shares',(select jsonb_agg(to_jsonb(f) order by slug) from public.folder_shares f),
  'projects',(select jsonb_agg(to_jsonb(p) order by slug) from public.projects p)) as value`);
const publish = (expected, candidate, index, password=null, master=pw) => value(
  'select public.publish_folder_share_checked($1,$2,$3,$4,$5,$6) as value',
  [master,'parent',JSON.stringify(expected),JSON.stringify(candidate),JSON.stringify(index),password]);
let checks = 0;
async function rejectsUnchanged(run, code, message) {
  const before = await snapshot();
  await assert.rejects(run, error => {assert.equal(error.code,code);assert.match(error.message,message);return true;});
  assert.deepEqual(await snapshot(),before,'Failed publication must leave the tree, index, passwords and projects unchanged');
  checks++;
}
function candidate(expected, isPublic=true) {
  const next=clone(expected), folder=next.children[0];
  folder.children=folder.children.filter(node=>node.type==='folder'||node.slug);
  Object.assign(folder,{shareSlug:'stable-share',shareIsPublic:isPublic,shareIncludeSubfolders:true});
  return next;
}
function index(folder, include=true) {
  return {name:folder.name,children:folder.children.flatMap(node=>node.type==='folder'
    ? include?[{type:'folder',...index(node,true)}]:[]
    : [{type:'project',slug:node.slug,displayName:'Reviewed '+node.slug}])};
}
try {
  await db.exec(`create role anon;create role authenticated;create schema extensions;
    create extension pgcrypto with schema extensions;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated;
    grant select,insert,update,delete on storage.objects to anon,authenticated;`);
  await db.exec(await sql('schema.sql')); await db.exec(await sql('share_locks.sql'));
  // Deliberately returns SQL NULL for a NULL password to exercise IS NOT TRUE.
  await db.exec(`create or replace function public._verify_master_pw(_pw text) returns boolean
    language sql security definer as $$select _pw='synthetic-folder-master'$$;`);
  const originalPublish = await value("select pg_get_functiondef('public.publish_folder_share(text,text,text,jsonb,boolean,text)'::regprocedure) as value");
  const beforeInstall = await snapshot(), migration=await sql(migrationName);
  await db.exec(migration);await db.exec(migration);
  assert.deepEqual(await snapshot(),beforeInstall);
  assert.equal(await value("select pg_get_functiondef('public.publish_folder_share(text,text,text,jsonb,boolean,text)'::regprocedure) as value"),originalPublish);checks++;
  const signature='public.publish_folder_share_checked(text,text,jsonb,jsonb,jsonb,text)';
  for(const role of ['anon','authenticated']) {
    assert.equal(await value('select has_function_privilege($1,$2,\'EXECUTE\') as value',[role,signature]),true);
    assert.equal(await value('select has_function_privilege($1,$2,\'EXECUTE\') as value',[role,'public._folder_share_index_shape(jsonb,boolean)']),false);checks++;
  }
  const proc=(await db.query(`select prosecdef,proconfig,
    exists(select 1 from aclexplode(proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
    from pg_proc where oid=$1::regprocedure`,[signature])).rows[0];
  assert.equal(proc.prosecdef,true);assert.equal(proc.public_execute,false);
  assert.deepEqual(proc.proconfig,['search_path=pg_catalog, public, extensions']);checks++;
  for(const bad of [null,'wrong-master']) await rejectsUnchanged(()=>publish(null,null,null,null,bad),'28000',/unauthorized/);

  const project=i=>({type:'project',slug:'published-'+i});
  const original={version:1,children:[{type:'folder',id:'parent',name:'Parent',shareSlug:'stable-share',children:[
    ...Array.from({length:4},(_,i)=>({type:'project',localId:'unknown-'+i})),
    {type:'folder',id:'hcc',name:'HCC',shareSlug:'child-hcc',children:[0,1,2].map(project)},
    {type:'folder',id:'gpx',name:'GPX',children:[3].map(project)},
    {type:'folder',id:'clinical',name:'Clinical',children:[4,5,6].map(project)},
  ]},{type:'folder',id:'other',name:'Other folder',children:[]}]};
  await db.query('insert into public.workspace_tree(id,tree) values(1,$1)',[JSON.stringify(original)]);
  await db.exec("insert into public.projects(slug,display_name,is_public) select 'published-'||i,'Published '||i,i<>6 from generate_series(0,6) i");
  await db.query("select public.publish_folder_share($1,'stable-share','Previous',$2,true,null)",[pw,JSON.stringify({name:'Previous',children:[project(0)]})]);
  const next=candidate(original), doc=index(next.children[0]);
  await rejectsUnchanged(()=>publish(null,next,doc),'22023',/folder_share_invalid_tree/);
  await rejectsUnchanged(()=>publish({...original,version:99},next,doc),'PT409',/folder_tree_changed/);
  const unresolved=clone(next);unresolved.children[0].children.unshift({type:'project',localId:'unknown'});
  await rejectsUnchanged(()=>publish(original,unresolved,doc),'22023',/folder_share_unresolved/);
  const omitted=clone(doc);omitted.children[2].children.pop();
  await rejectsUnchanged(()=>publish(original,next,omitted),'22023',/folder_share_invalid_index/);
  const extra=clone(doc);extra.children.push(project(0));
  await rejectsUnchanged(()=>publish(original,next,extra),'22023',/folder_share_invalid_index/);
  const swapped=clone(doc);swapped.children.reverse();
  await rejectsUnchanged(()=>publish(original,next,swapped),'22023',/folder_share_invalid_index/);
  const unrelated=clone(next);unrelated.children[1].name='Must not change';
  await rejectsUnchanged(()=>publish(original,unrelated,doc),'22023',/folder_share_invalid_tree/);
  const renamedSlug=clone(next);renamedSlug.children[0].shareSlug='different-url';
  await rejectsUnchanged(()=>publish(original,renamedSlug,doc),'PT409',/folder_share_slug_changed/);
  const invalidFlag=clone(next);invalidFlag.children[0].shareIsPublic='true';
  await rejectsUnchanged(()=>publish(original,invalidFlag,doc),'22023',/folder_share_invalid_tree/);
  const empty=clone(next);empty.children[0].children=[];
  await rejectsUnchanged(()=>publish(original,empty,index(empty.children[0])),'22023',/folder_share_empty/);

  // A count-stable catalogue swap can fool pagination, but publication must
  // reject the old slug which get_folder_index intentionally still displays.
  await db.exec("delete from public.projects where slug='published-6';insert into public.projects(slug,display_name) values('replacement','Replacement')");
  await rejectsUnchanged(()=>publish(original,next,doc),'PT409',/folder_share_project_missing/);
  await db.exec("delete from public.projects where slug='replacement';insert into public.projects(slug,display_name,is_public) values('published-6','Published 6',false)");

  await db.exec('set role anon');
  const receipt=await publish(original,next,doc);
  assert.deepEqual(receipt,{slug:'stable-share',project_count:7,placement_count:7,
    project_slugs:Array.from({length:7},(_,i)=>'published-'+i)});checks++;
  await assert.rejects(()=>db.query('select * from public.workspace_tree'),error=>error.code==='42501');checks++;
  await db.exec('reset role');
  assert.deepEqual(await treeState(),next);
  assert.deepEqual(await value("select index_doc as value from public.folder_shares where slug='stable-share'"),doc);checks++;
  await rejectsUnchanged(()=>publish(original,next,doc),'PT409',/folder_tree_changed/);

  // Proven local aliases retain their local identity and gain a stable slug.
  // Duplicate placements are allowed; the receipt distinguishes unique IDs.
  const alias=candidate(next);alias.children[0].children.unshift({type:'project',localId:'known-local',slug:'published-0'});
  const aliasReceipt=await publish(next,alias,index(alias.children[0]));
  assert.equal(aliasReceipt.project_count,7);assert.equal(aliasReceipt.placement_count,8);checks++;
  const direct=clone(alias);direct.children[0].shareIncludeSubfolders=false;
  const directReceipt=await publish(alias,direct,index(direct.children[0],false));
  assert.equal(directReceipt.project_count,1);assert.equal(directReceipt.placement_count,1);
  assert.deepEqual((await treeState()).children[0].children.slice(1),alias.children[0].children.slice(1));checks++;

  const privateTree=clone(direct);privateTree.children[0].shareIsPublic=false;
  const privateDoc=index(privateTree.children[0],false);
  await publish(direct,privateTree,privateDoc,'fixture-folder-password');
  const hash=await value("select password_hash as value from public.folder_shares where slug='stable-share'");
  assert.ok(hash&&!hash.includes('fixture-folder-password'));
  await assert.rejects(()=>value("select public.get_folder_index('stable-share',null) as value"),error=>error.code==='28P01');
  assert.equal((await value("select public.get_folder_index('stable-share','fixture-folder-password') as value")).is_public,false);checks++;
  await publish(privateTree,privateTree,privateDoc,null);
  assert.equal(await value("select password_hash as value from public.folder_shares where slug='stable-share'"),hash,'Existing private password is preserved');checks++;

  // Fail AFTER the folder upsert to prove the workspace + share write is atomic.
  await db.exec(`create function public.fixture_reject_workspace() returns trigger language plpgsql as $$begin
    raise exception 'synthetic workspace failure';end$$;
    create trigger fixture_reject_workspace before update on public.workspace_tree
    for each row execute function public.fixture_reject_workspace();`);
  const rollbackTree=clone(privateTree);rollbackTree.children[0].name='Must roll back';
  await rejectsUnchanged(()=>publish(privateTree,rollbackTree,index(rollbackTree.children[0],false),'replacement-password'),'P0001',/synthetic workspace failure/);
  await db.exec('drop trigger fixture_reject_workspace on public.workspace_tree;drop function public.fixture_reject_workspace()');
  console.log('Folder-share SQL regression: PASS ('+checks+' checks; isolated PGlite, not production)');
  console.log('Contention is covered by publish_postgres_concurrency.cjs using separate disposable PostgreSQL sessions.');
} finally {await db.close();}
