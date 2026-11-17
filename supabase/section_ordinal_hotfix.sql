-- Share_Test: repair section ordering during publication.
-- Apply to an existing publish-v2 deployment as postgres after operator review.
-- Safe to rerun. Applying this script changes function code only; it does not
-- rewrite project, section, ROI, image, MRM, credential, receipt, or Storage rows.
-- The next normal publish preserves retained section UUIDs and writes array
-- order as 1..N, including retry payloads containing legacy duplicate ordinals.
--
-- This patches the known base writer in place. If spatial_groups_v1.sql has
-- renamed it, its guarded wrapper is verified and left untouched. Do NOT
-- reapply publish_safety_v2.sql to an existing spatial-groups deployment.
-- Full body fingerprints intentionally fail closed on other implementations.
-- CRLF line endings are normalized to LF for matching only; no other source
-- differences are accepted. The spatial wrapper itself is never rewritten.
-- Function signatures, ownership, security attributes, and grants are retained.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $hotfix$
declare
    base_oid regprocedure;
    wrapper_oid regprocedure;
    renamed_oid regprocedure;
    source_raw text;
    source_before text;
    source_after text;
    wrapper_source text;
    definition text;
    expected_legacy_hash constant text := 'da55e2999b00804e134f75b2be43ba11';
    expected_patched_hash constant text := '8e4bf0b44161cae2480323ce21c240b4';
    expected_spatial_wrapper_hash constant text := 'cfe41d7f3a3ecb145222fe98105730c4';
    legacy_declarations constant text := $legacy_declarations$    v_client_ids text[];
$legacy_declarations$;
    patched_declarations constant text := $patched_declarations$    v_client_ids text[];
    v_staged_section_id uuid;
    v_temporary_ordinal bigint;
    v_section_ordinal bigint;
$patched_declarations$;
    legacy_sections constant text := $legacy_sections$    -- Merge sections by client_id (do NOT delete-all). Preserving each
    -- section's UUID keeps its ROIs — including collaborator ('viewer') ROIs
    -- added on the shared copy — from being cascade-deleted on every master
    -- auto-publish (schema.sql rois.section_id ON DELETE CASCADE).
    v_client_ids := (
        select array_agg(s->>'id')
          from jsonb_array_elements(coalesce(_sections, '[]'::jsonb)) s
         where s->>'id' is not null
    );
    -- Remove only sections the master no longer has (their client_id is absent
    -- from the incoming doc). If the doc carries no sections, leave existing
    -- ones untouched (degenerate case — never wipe everything).
    if v_client_ids is not null and array_length(v_client_ids, 1) is not null then
        delete from public.sections
            where project_id = v_pid
              and (meta->>'client_id' is null
                   or not (meta->>'client_id' = any(v_client_ids)));
    end if;
    for sec in select * from jsonb_array_elements(coalesce(_sections, '[]'::jsonb))
    loop
        v_sec_id := null;
        select id into v_sec_id from public.sections
            where project_id = v_pid
              and meta->>'client_id' = (sec->>'id')
            limit 1;
        if v_sec_id is null then
            insert into public.sections(project_id, ordinal, display_name, meta, storage_paths)
                values (
                    v_pid,
                    coalesce((sec->>'ordinal')::int, 0),
                    coalesce(sec->>'displayName', 'Section'),
                    jsonb_set(coalesce(sec->'meta', '{}'::jsonb), '{client_id}', to_jsonb(sec->>'id')),
                    coalesce(sec->'storagePaths', '{}'::jsonb)
                );
        else
            update public.sections set
                ordinal       = coalesce((sec->>'ordinal')::int, 0),
                display_name  = coalesce(sec->>'displayName', 'Section'),
                meta          = jsonb_set(coalesce(sec->'meta', '{}'::jsonb), '{client_id}', to_jsonb(sec->>'id')),
                storage_paths = coalesce(sec->'storagePaths', '{}'::jsonb)
             where id = v_sec_id;
        end if;
    end loop;

$legacy_sections$;
    patched_sections constant text := $patched_sections$    -- Merge sections by client_id (do NOT delete-all). Preserving each
    -- section's UUID keeps its ROIs — including collaborator ('viewer') ROIs
    -- added on the shared copy — from being cascade-deleted on every master
    -- auto-publish (schema.sql rois.section_id ON DELETE CASCADE).
    v_client_ids := (
        select array_agg(s->>'id')
          from jsonb_array_elements(coalesce(_sections, '[]'::jsonb)) s
         where s->>'id' is not null
    );
    -- Remove only sections the master no longer has (their client_id is absent
    -- from the incoming doc). If the doc carries no sections, leave existing
    -- ones untouched (degenerate case — never wipe everything).
    if v_client_ids is not null and array_length(v_client_ids, 1) is not null then
        delete from public.sections
            where project_id = v_pid
              and (meta->>'client_id' is null
                   or not (meta->>'client_id' = any(v_client_ids)));

        -- An ambiguous legacy client identity cannot be repaired by ordering:
        -- LIMIT 1 below would otherwise leave one staged row unfinalized.
        if exists (select 1 from public.sections where project_id = v_pid
                    group by meta->>'client_id' having count(*) > 1) then
            raise exception 'invalid_stored_section_identity' using errcode = '22023';
        end if;

        -- Keep each retained section UUID (and its collaborator associations),
        -- but free all final positive slots before applying the document order.
        -- A direct swap of two UNIQUE(project_id, ordinal) values would fail
        -- even when the final document has no duplicates. Legacy rows may
        -- already use negative ordinals, so reserve only currently unused
        -- slots; bigint arithmetic prevents INT_MIN from wrapping around.
        v_temporary_ordinal := -1;
        for v_staged_section_id in
            select id from public.sections where project_id = v_pid order by id for update
        loop
            while v_temporary_ordinal >= -2147483648::bigint
              and exists (select 1 from public.sections
                          where project_id = v_pid and ordinal = v_temporary_ordinal)
            loop
                v_temporary_ordinal := v_temporary_ordinal - 1;
            end loop;
            if v_temporary_ordinal < -2147483648::bigint then
                raise exception 'section_ordinal_staging_exhausted' using errcode = '22003';
            end if;
            update public.sections set ordinal = v_temporary_ordinal::integer
             where id = v_staged_section_id;
            v_temporary_ordinal := v_temporary_ordinal - 1;
        end loop;
    end if;

    -- The array is the viewer's section order. Old local projects can carry
    -- duplicate/missing ordinal fields after delete/add; never trust those
    -- fields or alter the original request used for receipt hashing/retries.
    for sec, v_section_ordinal in
        select section_doc, section_position
          from jsonb_array_elements(coalesce(_sections, '[]'::jsonb))
               with ordinality as incoming(section_doc, section_position)
         order by section_position
    loop
        if v_section_ordinal > 2147483647::bigint then
            raise exception 'section_ordinal_out_of_range' using errcode = '22003';
        end if;
        v_sec_id := null;
        select id into v_sec_id from public.sections
            where project_id = v_pid
              and meta->>'client_id' = (sec->>'id')
            limit 1;
        if v_sec_id is null then
            insert into public.sections(project_id, ordinal, display_name, meta, storage_paths)
                values (
                    v_pid,
                    v_section_ordinal::integer,
                    coalesce(sec->>'displayName', 'Section'),
                    jsonb_set(coalesce(sec->'meta', '{}'::jsonb), '{client_id}', to_jsonb(sec->>'id')),
                    coalesce(sec->'storagePaths', '{}'::jsonb)
                );
        else
            update public.sections set
                ordinal       = v_section_ordinal::integer,
                display_name  = coalesce(sec->>'displayName', 'Section'),
                meta          = jsonb_set(coalesce(sec->'meta', '{}'::jsonb), '{client_id}', to_jsonb(sec->>'id')),
                storage_paths = coalesce(sec->'storagePaths', '{}'::jsonb)
             where id = v_sec_id;
        end if;
    end loop;

$patched_sections$;
begin
    if to_regprocedure('public.publish_project_doc_v2(text,text,uuid,bigint,boolean,text,text,jsonb,text,text,jsonb,jsonb,boolean)') is null then
        raise exception 'Required Share_Test publish-v2 API is missing. No changes committed.';
    end if;
    wrapper_oid := to_regprocedure('public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)');
    renamed_oid := to_regprocedure('public._publish_doc_write_before_spatial_v1(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)');
    if wrapper_oid is null then
        raise exception 'Required Share_Test document writer is missing. No changes committed.';
    end if;
    if renamed_oid is not null then
        select prosrc into wrapper_source from pg_proc where oid = wrapper_oid;
        if md5(replace(wrapper_source, E'\r\n', E'\n')) is distinct from expected_spatial_wrapper_hash then
            raise exception 'Unexpected Share_Test spatial publish wrapper. Review the installed code; no changes committed.';
        end if;
        base_oid := renamed_oid;
    else
        base_oid := wrapper_oid;
    end if;
    select prosrc, pg_get_functiondef(oid) into source_raw, definition
      from pg_proc where oid = base_oid;
    source_before := replace(source_raw, E'\r\n', E'\n');
    if md5(source_before) = expected_patched_hash then
        raise notice 'Section ordering already patched: %', base_oid;
    elsif md5(source_before) = expected_legacy_hash then
        -- Normalize the embedded patch strings too, so running this SQL file
        -- with Windows line endings produces the same verified LF body.
        source_after := replace(replace(source_before,
            replace(legacy_declarations, E'\r\n', E'\n'),
            replace(patched_declarations, E'\r\n', E'\n')),
            replace(legacy_sections, E'\r\n', E'\n'),
            replace(patched_sections, E'\r\n', E'\n'));
        if md5(source_after) is distinct from expected_patched_hash then
            raise exception 'Section-order patch did not produce the expected writer. No changes committed.';
        end if;
        execute replace(definition, source_raw, source_after);
        raise notice 'Section ordering patched: %', base_oid;
    else
        raise exception 'Unexpected Share_Test document writer: %. Review the installed code; no changes committed.', base_oid;
    end if;
end;
$hotfix$;

notify pgrst, 'reload schema';
commit;

-- Verification: ready and spatial_guard_preserved must both be true.
select p.proname as function_name,
       md5(replace(p.prosrc, E'\r\n', E'\n')) = '8e4bf0b44161cae2480323ce21c240b4' as ready,
       case when to_regprocedure('public._publish_doc_write_before_spatial_v1(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)') is null
            then true
            else exists (select 1 from pg_proc w
                          where w.oid = to_regprocedure('public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)')
                            and md5(replace(w.prosrc, E'\r\n', E'\n')) = 'cfe41d7f3a3ecb145222fe98105730c4')
       end as spatial_guard_preserved
  from pg_proc p
 where p.oid = coalesce(
    to_regprocedure('public._publish_doc_write_before_spatial_v1(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)'),
    to_regprocedure('public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)')
 );
