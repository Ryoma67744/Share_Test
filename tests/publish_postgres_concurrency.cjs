'use strict';
// Real, separate PostgreSQL sessions. Run only against the disposable CI database.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const url=new URL(process.env.DATABASE_URL || 'postgres://localhost/invalid');
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !/^\/share_test_ci(?:_[a-z0-9]+)?$/.test(url.pathname))
 throw new Error('Requires a disposable localhost database named share_test_ci; refuses other databases');
const sqlString=value=>value===null?'null':"'"+String(value).replace(/'/g,"''")+"'";
function session(name){
 const p=spawn('psql',['-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose',url.href],
  {env:{...process.env,PGAPPNAME:name,PGOPTIONS:'-c statement_timeout=15000 -c lock_timeout=10000'}});
 let stdout='',stderr='';const readers=[];
 const done=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',code=>resolve({code,stdout,stderr}));});
 p.stdout.on('data',chunk=>{stdout+=chunk;for(const r of readers)if(stdout.includes(r.text))r.resolve();});
 p.stderr.on('data',chunk=>{stderr+=chunk;});
 return {write:sql=>p.stdin.write(sql+'\n'),finish:sql=>{p.stdin.end((sql||'')+'\n');return done;},
  waitFor: text=>Promise.race([new Promise(resolve=>{if(stdout.includes(text))resolve();else readers.push({text,resolve});}),
   new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('psql barrier timed out: '+name)),12000);timer.unref();})]),
  kill:()=>p.kill(),done};
}
async function query(sql){const result=await session('fixture-query').finish(sql);if(result.code)throw new Error(result.stderr);return result.stdout.trim();}
const json=async sql=>JSON.parse(await query(sql));
const pw='synthetic-master-only';
const ticket=async(slug,id,rev,create)=>json(`select public.request_publish_session_v2('${pw}',${sqlString(slug)},'${id}',${rev},${create});`);
const commit=(slug,t,id,rev,create,name,sections=[])=>`select public.publish_project_doc_v2('${pw}','${t.token}','${id}',${rev},${create},${sqlString(slug)},${sqlString(name)},'{}',null,null,${sqlString(JSON.stringify(sections))}::jsonb,'[]',true);`;
async function race(slug,first,second,secondSucceeds=false){
 const a=session('publish-race-A'),b=session('publish-race-B');
 try{
  a.write(`begin; select pg_advisory_xact_lock(hashtextextended('publish-v2:${slug}',0));\n\\echo LOCKED`);
  await a.waitFor('LOCKED');
  const bDone=b.finish(second);
  let blocked=false;
  for(let n=0;n<100;n++){
   blocked=(await query("select count(*) from pg_stat_activity where application_name='publish-race-B' and wait_event_type='Lock';"))==='1';
   if(blocked)break;await new Promise(r=>setTimeout(r,25));
  }
  assert.equal(blocked,true,'second real connection must contend for the same publish lock');
  const [ra,rb]=await Promise.all([a.finish(first+'\ncommit;'),bDone]);
  assert.equal(ra.code,0,ra.stderr);
  if(secondSucceeds)assert.equal(rb.code,0,rb.stderr);
  else {assert.notEqual(rb.code,0);assert.match(rb.stderr,/publish_conflict/);assert.match(rb.stderr,/\bPT409\b/);}
  return [ra,rb];
 } finally {a.kill();b.kill();}
}
async function main(){
 assert.equal(await query("select count(*) from information_schema.tables where table_schema in ('public','storage');"),'0','database must be empty; no existing data is removed');
 await query(`create role anon;create role authenticated;create schema extensions;create extension pgcrypto with schema extensions;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
 alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;
 grant select,insert,update,delete on storage.objects to anon,authenticated;`);
 for(const file of ['schema.sql','share_locks.sql'])await query(fs.readFileSync(path.join(__dirname,'../supabase',file),'utf8'));
 await query(`create or replace function public._verify_master_pw(_pw text) returns boolean language sql security definer as $$select _pw='${pw}'$$;`);
 await query(fs.readFileSync(path.join(__dirname,'../supabase/publish_safety_v2.sql'),'utf8'));
 const initial=randomUUID(),it=await ticket('race',initial,0,true);
 await query(commit('race',it,initial,0,true,'Initial'));
 const a=randomUUID(),b=randomUUID(),ta=await ticket('race',a,1,false),tb=await ticket('race',b,1,false);
 await race('race',commit('race',ta,a,1,false,'Winner'),commit('race',tb,b,1,false,'Stale loser'));
 assert.equal(await query("select publish_revision||':'||display_name from public.projects where slug='race';"),'2:Winner');
 const ca=randomUUID(),cb=randomUUID(),cta=await ticket('new-race',ca,0,true),ctb=await ticket('new-race',cb,0,true);
 await race('new-race',commit('new-race',cta,ca,0,true,'Created'),commit('new-race',ctb,cb,0,true,'Must not replace'));
 assert.equal(await query("select publish_revision||':'||display_name from public.projects where slug='new-race';"),'1:Created');
 const retry=randomUUID(),rt=await ticket('race',retry,2,false),retrySql=commit('race',rt,retry,2,false,'Retried once');
 await race('race',retrySql,retrySql,true);
 assert.equal(await query("select publish_revision from public.projects where slug='race';"),'3');
 assert.equal(await query(`select count(*) from public.publish_receipts where request_id='${retry}';`),'1');
 const fail=randomUUID(),ft=await ticket('race',fail,3,false);
 const failure=await session('fixture-invalid').finish(commit('race',ft,fail,3,false,'Missing original',[
  {id:'s',storagePaths:{images:{HE:{path:'race/nonexistent'}}}}]));
 assert.notEqual(failure.code,0);assert.match(failure.stderr,/publish_source_missing/);
 assert.equal(await query("select publish_revision||':'||display_name from public.projects where slug='race';"),'3:Retried once');
 console.log('PostgreSQL multi-connection publish safety: PASS (update/create races, concurrent retry, atomic failure)');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
