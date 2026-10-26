import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { matchExpRows } from '../mrm/exp-library-import.mjs';
import { parseExp, createDraft, serializeDocument, restoreDocument } from '../mrm/exp-core.mjs';
import { createHash } from 'node:crypto';

const db = new PGlite({ extensions: { pgcrypto } });
const sqlFile = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
let checks = 0;
const scalar = async (sql, params = []) => (await db.query(sql,params)).rows[0].value;
const expectError = async (fn, pattern) => {
  await assert.rejects(fn, pattern); checks++;
};
try {
 await db.exec(`create role anon; create role authenticated; create schema extensions;
 create extension pgcrypto with schema extensions;
 create function public._verify_master_pw(text) returns boolean language sql as $$ select $1 = 'test-master' $$;
 create table public.projects(id uuid primary key, slug text, name text);
 create table public.sections(id uuid primary key, project_id uuid, storage_paths jsonb);`);
 // The real schemas/RPCs are loaded; only the authentication/project fixtures
 // above substitute unrelated application services. No production DB is used.
 await db.exec(await sqlFile('mrm_library.sql'));
 await db.exec(await sqlFile('mrm_reconcile.sql'));
 const migration = await sqlFile('mrm_exp_import.sql');
 await db.exec(migration);
 await db.exec(migration); // repeatability
 checks++;
 const getLibrary = () => scalar('select public.list_mrm_library($1) as value',['test-master']);
 const preview = async rows => matchExpRows(rows,await getLibrary(),{shelf:'main'}).map(result => {
   assert.ok(result.payload,result.message); return result.payload;
 });
 const register = rows => scalar('select public.register_from_exp_batch($1,$2::jsonb) as value',['test-master',JSON.stringify(rows)]);
 const row = {id:'r1',name:'Lactate',polarity:'-',precursor:'89.000',product:43,ce:11,cv:20,tags:['source'],shelf:'main'};
 await expectError(() => scalar('select public.register_from_exp_batch($1,$2::jsonb) as value',['wrong','[]']),/unauthorized/);
 let result = await register(await preview([row,row]));
 assert.equal(result.ok_count,2); assert.equal(result.results[0].action,'created'); assert.equal(result.results[1].action,'reused'); checks++;
 const cid = result.results[0].compound_id, tid = result.results[0].transition_id;
 assert.equal(await scalar('select count(*)::int as value from public.mrm_usages'),0); checks++;
 await db.query(`update public.mrm_compounds set note='keep compound',check_level='std',shelf='archive' where id=$1;
 `,[cid]);
 await db.query(`update public.mrm_transitions set role='quantifier',is_recommended=true,intensity_note='strong',note='keep transition' where id=$1`,[tid]);
 result = await register(await preview([{...row,tags:['new-tag']} ]));
 assert.equal(result.results[0].action,'reused');
 const compound = (await getLibrary())[0];
 assert.deepEqual(compound.tags.sort(),['new-tag','source']);
 assert.equal(compound.polarity,'-'); assert.equal(compound.shelf,'archive'); assert.equal(compound.check_level,'std'); assert.equal(compound.note,'keep compound');
 assert.equal(compound.transitions[0].is_recommended,true); assert.equal(compound.transitions[0].role,'quantifier');
 assert.equal(compound.transitions[0].intensity_note,'strong'); assert.equal(compound.transitions[0].note,'keep transition'); checks++;
 let rows = await preview([{...row,ce:15}]);
 await expectError(() => register(rows),/Acknowledge new condition/);
 rows[0].allow_new_condition = true;
 await register(rows); checks++;
 // All input rows are validated before writes: an invalid last row must not
 // partially create the earlier compound or add tags.
 rows = await preview([{...row,name:'Would be created'},{...row,name:'Invalid'}]); rows[1].ce='12abc';
 await expectError(() => register(rows),/Invalid numeric field/);
 assert.equal(await scalar("select count(*)::int as value from public.mrm_compounds where name='Would be created'"),0); checks++;
 for (const invalid of [null,'',true,'NaN','Infinity','-Infinity','1e999']) {
   rows = await preview([{...row,name:'Invalid'}]); rows[0].ce=invalid;
   await expectError(() => register(rows),/Invalid numeric field|outside supported range/);
 }
 rows = await preview([{...row,name:'Invalid'}]); rows[0].product=0;
 await expectError(() => register(rows),/Mass must be positive/);
 rows = await preview([row]); rows[0].polarity='+';
 await expectError(() => register(rows),/Polarity conflict/);
 rows = await preview([row]);
 await db.query('update public.mrm_transitions set ce=99 where id=$1',[tid]);
 await expectError(() => register(rows),/Transitions changed/);
 rows = await preview([{...row,name:'Conflicting'},{...row,name:'Conflicting',polarity:'+'}]);
 await expectError(() => register(rows),/Conflicting polarities/);
 rows = await preview([{...row,name:'Conflicting'},{...row,name:'Conflicting',shelf:'archive'}]);
 await expectError(() => register(rows),/Conflicting destinations/);
 // A name created after the preview cannot silently become an existing match.
 rows = await preview([{...row,name:'Raced'}]);
 await scalar("select public.upsert_compound('test-master','Raced') as value");
 await expectError(() => register(rows),/Library changed/);
 // Every allocator shares the existing batch lock before reading max().
 for (const name of ['upsert_compound','register_from_result','register_from_result_batch','register_measured_compound']) {
   const body = (await scalar('select prosrc as value from pg_proc where proname=$1',[name])).replace(/--[^\n]*/g,'');
   assert.ok(body.indexOf('pg_advisory_xact_lock')>=0,name);
   assert.ok(body.indexOf('pg_advisory_xact_lock')<body.indexOf('max(serial_no)'),name); checks++;
 }
 const updateBody = await scalar("select prosrc as value from pg_proc where proname='update_compound'");
 assert.ok(updateBody.indexOf('pg_advisory_xact_lock') < updateBody.indexOf('update public.mrm_compounds')); checks++;
 // Test the upgrade path as well as the fresh-install SQL: remove the shared
 // lock from one old RPC, then let the migration restore it exactly once.
 let definition = await scalar("select pg_get_functiondef(oid) as value from pg_proc where proname='upsert_compound'");
 definition=definition.replace(/    perform pg_advisory_xact_lock\(hashtext\('public.mrm_compounds.serial_no'\)\);\n/,'');
 await db.exec(definition); await db.exec(migration);
 const patched = await scalar("select prosrc as value from pg_proc where proname='upsert_compound'");
 assert.equal(patched.match(/pg_advisory_xact_lock/g).length,1); checks++;
 const source = await readFile(new URL('./fixtures/exp/flat-mrm-synthetic.exp',import.meta.url));
 const parsed = parseExp(source,{filename:'method.exp'});
 const payload = serializeDocument(parsed,createDraft(parsed));
 const save=(p=payload,id=null,revision=null,pw='test-master')=>scalar('select public.save_mrm_exp_document($1,$2,$3::jsonb,$4,$5) as value',[pw,'Method',JSON.stringify(p),id,revision]);
 let document=await save(); assert.equal(document.revision,1);
 assert.equal(document.source_sha256,createHash('sha256').update(source).digest('hex')); checks++;
 const get=()=>scalar('select public.get_mrm_exp_document($1,$2) as value',['test-master',document.id]);
 assert.deepEqual((await get()).payload,payload);
 assert.equal(restoreDocument((await get()).payload).rows.length,parsed.rows.length); checks++;
 document=await save(payload,document.id,1); assert.equal(document.revision,2); checks++;
 await expectError(()=>save(payload,document.id,1),/changed or missing/);
 await expectError(()=>save(payload,null,null,'wrong'),/unauthorized/);
 await expectError(()=>save({...payload,version:2}),/Invalid version/);
 await expectError(()=>save({...payload,parserVersion:1}),/Invalid version/);
 await expectError(()=>save({...payload,profile:'unknown'}),/Invalid version/);
 await expectError(()=>save({...payload,originalBase64:'!notbase64!'}),/Invalid base64/);
 await expectError(()=>save({...payload,rows:[payload.rows[0],payload.rows[0]]}),/Duplicate saved row/);
 await expectError(()=>save({...payload,originalBase64:Buffer.alloc(1048577).toString('base64')}),/exceeds supported limits/);
 await expectError(()=>save({...payload,rows:[{...payload.rows[0],cv:'oops'}]}),/Invalid numeric field/);
 assert.equal((await scalar('select public.list_mrm_exp_documents($1) as value',['test-master'])).length,1); checks++;
 await db.exec('set role anon');
 await expectError(()=>db.query('select * from public.mrm_exp_documents'),/permission denied/);
 await expectError(()=>scalar('select public.list_mrm_exp_documents($1) as value',['wrong']),/unauthorized/);
 assert.equal((await scalar('select public.list_mrm_exp_documents($1) as value',['test-master'])).length,1); checks++;
 await db.exec('reset role');
 console.log(`exp import database: ${checks} PostgreSQL execution checks passed (PGlite)`);
 console.log('Concurrency limitation: PGlite is single connection; lock placement/order is checked, multi-session contention requires PostgreSQL.');
} finally {
 await db.close();
}
