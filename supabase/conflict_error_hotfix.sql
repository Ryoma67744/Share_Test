-- Share_Test: stop PostgREST from retrying application-level conflicts.
-- Run once in the existing project's Supabase SQL Editor as postgres.
-- Safe to rerun. No project, ROI, image, MRM, or credential rows are changed.
-- Only the error codes in seven known function signatures are replaced.
-- Existing signatures, authentication checks, locks, ownership and grants remain.
--
-- IMPORTANT: after this commits, stop the already-looping backend(s), or
-- restart the project. Changing a function does not stop in-flight retries.
-- https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions

begin;
set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $hotfix$
declare
    target record;
    function_oid regprocedure;
    source_before text;
    source_after text;
    definition text;
    known_codes integer;
begin
    for target in select * from (values
        ('public.request_publish_session_v2(text,text,uuid,bigint,boolean)', 2, true),
        ('public.publish_project_doc_v2(text,text,uuid,bigint,boolean,text,text,jsonb,text,text,jsonb,jsonb,boolean)', 2, true),
        ('public.update_roi(text,uuid,integer,text,jsonb,text)', 1, false),
        ('public.update_share_overlay(text,uuid,integer,text,jsonb,text,boolean)', 1, false),
        ('public.upsert_share_alignment(text,uuid,jsonb,integer,text)', 2, false),
        ('public.register_from_exp_batch(text,jsonb)', 3, false),
        ('public.save_mrm_exp_document(text,text,jsonb,uuid,integer)', 1, false)
    ) as expected(signature, code_count, required) loop
        function_oid := to_regprocedure(target.signature);
        if function_oid is null then
            if target.required then
                raise exception 'Required Share_Test function is missing: %. No changes committed.', target.signature;
            end if;
            raise notice 'Not installed; skipped: %', target.signature;
            continue;
        end if;
        select prosrc, pg_get_functiondef(oid) into source_before, definition
          from pg_proc where oid = function_oid;
        select count(*) into known_codes from regexp_matches(source_before,
            $pattern$\merrcode\s*=\s*'(40001|PT409)'$pattern$, 'gi');
        if known_codes <> target.code_count then
            raise exception 'Unexpected conflict handlers in %. Expected %, found %. No changes committed.',
                target.signature, target.code_count, known_codes;
        end if;
        source_after := regexp_replace(source_before,
            $pattern$(\merrcode\s*=\s*)'40001'$pattern$,
            $replacement$\1'PT409'$replacement$, 'gi');
        if source_after is distinct from source_before then
            execute replace(definition, source_before, source_after);
            raise notice 'Patched: %', target.signature;
        else
            raise notice 'Already patched: %', target.signature;
        end if;
    end loop;
end;
$hotfix$;

notify pgrst, 'reload schema';
commit;

-- Verification result: all installed targets must say ready = true.
select p.proname as function_name,
       not (p.prosrc ~* $pattern$\merrcode\s*=\s*'40001'$pattern$)
       and p.prosrc ~* $pattern$\merrcode\s*=\s*'PT409'$pattern$ as ready
  from pg_proc p
 where p.oid in (
    to_regprocedure('public.request_publish_session_v2(text,text,uuid,bigint,boolean)'),
    to_regprocedure('public.publish_project_doc_v2(text,text,uuid,bigint,boolean,text,text,jsonb,text,text,jsonb,jsonb,boolean)'),
    to_regprocedure('public.update_roi(text,uuid,integer,text,jsonb,text)'),
    to_regprocedure('public.update_share_overlay(text,uuid,integer,text,jsonb,text,boolean)'),
    to_regprocedure('public.upsert_share_alignment(text,uuid,jsonb,integer,text)'),
    to_regprocedure('public.register_from_exp_batch(text,jsonb)'),
    to_regprocedure('public.save_mrm_exp_document(text,text,jsonb,uuid,integer)')
 ) order by p.proname;
