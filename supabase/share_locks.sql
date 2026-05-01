-- ============================================================
-- Share-Only mode add-on: ROI exclusive lock + project upsert
-- ------------------------------------------------------------
-- Apply AFTER schema.sql in the Supabase SQL Editor.
-- Idempotent: safe to re-run.
-- ============================================================

-- ---- 1. roi_locks: one-writer-at-a-time semaphore -----------
create table if not exists public.roi_locks (
    project_id   uuid primary key references public.projects(id) on delete cascade,
    holder_token text not null,
    holder_label text,
    acquired_at  timestamptz not null default now(),
    heartbeat_at timestamptz not null default now()
);

alter table public.roi_locks enable row level security;
-- All access goes through SECURITY DEFINER RPCs below; deny direct
-- table access from anon role.
revoke all on public.roi_locks from anon, authenticated;

-- Resolve project_id from a session token (created by unlock_project).
create or replace function public._project_from_token(_token text)
returns uuid language sql security definer set search_path = public as $$
    select project_id from public.session_tokens
     where token = _token and expires_at > now();
$$;

-- Acquire / refresh ROI lock. A lock is considered stale after 30 s
-- without a heartbeat; in that case any caller may take it over.
create or replace function public.acquire_roi_lock(_token text, _label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_pid uuid;
    v_existing public.roi_locks%rowtype;
begin
    v_pid := public._project_from_token(_token);
    if v_pid is null then
        return jsonb_build_object('ok', false, 'reason', 'invalid_token');
    end if;
    select * into v_existing from public.roi_locks where project_id = v_pid;
    if found
       and v_existing.holder_token <> _token
       and v_existing.heartbeat_at > now() - interval '30 seconds' then
        return jsonb_build_object(
            'ok', false,
            'reason', 'busy',
            'holder_label', v_existing.holder_label,
            'last_seen', v_existing.heartbeat_at
        );
    end if;
    insert into public.roi_locks(project_id, holder_token, holder_label)
        values (v_pid, _token, _label)
        on conflict (project_id) do update
        set holder_token = excluded.holder_token,
            holder_label = excluded.holder_label,
            acquired_at  = now(),
            heartbeat_at = now();
    return jsonb_build_object('ok', true);
end;
$$;

-- Heartbeat the lock so other clients keep seeing it as held. No-op
-- if the caller is not the current holder.
create or replace function public.heartbeat_roi_lock(_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_pid uuid; v_n int; begin
    v_pid := public._project_from_token(_token);
    if v_pid is null then
        return jsonb_build_object('ok', false, 'reason', 'invalid_token');
    end if;
    update public.roi_locks
       set heartbeat_at = now()
     where project_id = v_pid and holder_token = _token;
    get diagnostics v_n = row_count;
    return jsonb_build_object('ok', v_n > 0);
end;
$$;

-- Release the lock. Only the holder may release; otherwise no-op.
create or replace function public.release_roi_lock(_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_pid uuid; begin
    v_pid := public._project_from_token(_token);
    if v_pid is null then
        return jsonb_build_object('ok', false, 'reason', 'invalid_token');
    end if;
    delete from public.roi_locks
     where project_id = v_pid and holder_token = _token;
    return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.acquire_roi_lock(text, text) to anon, authenticated;
grant execute on function public.heartbeat_roi_lock(text)      to anon, authenticated;
grant execute on function public.release_roi_lock(text)        to anon, authenticated;

-- ---- 2. Schema patches required by upsert_project_doc -------
-- schema.sql predates the share_locks add-on, so it is missing a
-- couple of columns that the publish helper writes to. Add them
-- idempotently so a fresh "schema.sql then share_locks.sql" run
-- works end-to-end.
alter table public.projects add column if not exists updated_at timestamptz not null default now();
alter table public.rois     add column if not exists name        text;

-- ---- 3. upsert_project_doc: Master-side publish helper ------
-- Pushes the entire project document (meta + sections + rois) plus
-- a fresh viewer/admin password set, in one transaction. Designed to
-- be called once per "Publish to share" click.
create or replace function public.upsert_project_doc(
    _slug          text,
    _display_name  text,
    _meta          jsonb,
    _viewer_pw     text,
    _admin_pw      text default null,
    _sections      jsonb default '[]'::jsonb,
    _rois          jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_pid uuid;
    sec   jsonb;
    roi   jsonb;
    v_sec_id uuid;
begin
    if _slug is null or length(trim(_slug)) = 0 then
        return jsonb_build_object('ok', false, 'reason', 'slug_required');
    end if;
    if _viewer_pw is null or length(_viewer_pw) < 4 then
        return jsonb_build_object('ok', false, 'reason', 'viewer_password_required');
    end if;

    insert into public.projects(slug, display_name, anatomy_palette)
        values (_slug, coalesce(_display_name, _slug), coalesce(_meta->'anatomyPalette', '{}'::jsonb))
        on conflict (slug) do update
        set display_name    = excluded.display_name,
            anatomy_palette = excluded.anatomy_palette,
            updated_at      = now()
        returning id into v_pid;

    -- (Re)set credentials. set_project_password is provided by schema.sql.
    perform public.set_project_password(_slug, 'viewer', _viewer_pw);
    if _admin_pw is not null and length(_admin_pw) >= 4 then
        perform public.set_project_password(_slug, 'admin', _admin_pw);
    end if;

    -- Replace sections wholesale. Caller passes the full ordered list.
    delete from public.sections where project_id = v_pid;
    for sec in select * from jsonb_array_elements(coalesce(_sections, '[]'::jsonb))
    loop
        insert into public.sections(project_id, ordinal, display_name, meta, storage_paths)
            values (
                v_pid,
                coalesce((sec->>'ordinal')::int, 0),
                coalesce(sec->>'displayName', 'Section'),
                coalesce(sec->'meta', '{}'::jsonb),
                coalesce(sec->'storagePaths', '{}'::jsonb)
            )
            returning id into v_sec_id;
        -- Persist the synthetic id so the client can map ROIs back.
        update public.sections set meta = jsonb_set(meta, '{client_id}', to_jsonb(sec->>'id'))
            where id = v_sec_id;
    end loop;

    -- Replace ROIs wholesale.
    delete from public.rois where project_id = v_pid;
    for roi in select * from jsonb_array_elements(coalesce(_rois, '[]'::jsonb))
    loop
        -- ROIs reference sections by client_id; resolve to server uuid.
        v_sec_id := null;
        select id into v_sec_id from public.sections
            where project_id = v_pid
              and meta->>'client_id' = roi->>'sectionId'
            limit 1;
        if v_sec_id is null then
            continue;  -- skip ROIs whose section did not survive
        end if;
        insert into public.rois(project_id, section_id, color_key, name, poly_msi, created_by, version)
            values (
                v_pid,
                v_sec_id,
                coalesce(roi->>'colorKey', 'default'),
                roi->>'name',
                coalesce(roi->'polyMsi', '[]'::jsonb),
                coalesce(roi->>'createdBy', 'master'),
                coalesce((roi->>'version')::int, 1)
            );
    end loop;

    return jsonb_build_object('ok', true, 'project_id', v_pid);
end;
$$;

grant execute on function public.upsert_project_doc(text, text, jsonb, text, text, jsonb, jsonb) to anon, authenticated;

-- ---- 4. Storage policies for the `atlases` bucket -----------
-- schema.sql creates the bucket with `public = true`, which only governs
-- public READ. Writes (INSERT/UPDATE/DELETE on storage.objects) are still
-- subject to RLS, and Supabase ships with no default policies. Without
-- the policies below the master-side publish flow fails on its very
-- first blob upload with:
--   "new row violates row-level security policy"
--
-- We grant anon + authenticated full write access scoped to the
-- `atlases` bucket. The publish handler runs from the browser with
-- only the anon key; this matches that trust model (anyone who can
-- reach the page can already publish, and the bucket is already
-- public-read by design).
do $$
begin
    if not exists (
        select 1 from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname = 'atlases anon read'
    ) then
        create policy "atlases anon read" on storage.objects
            for select to anon, authenticated
            using (bucket_id = 'atlases');
    end if;
    if not exists (
        select 1 from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname = 'atlases anon insert'
    ) then
        create policy "atlases anon insert" on storage.objects
            for insert to anon, authenticated
            with check (bucket_id = 'atlases');
    end if;
    if not exists (
        select 1 from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname = 'atlases anon update'
    ) then
        create policy "atlases anon update" on storage.objects
            for update to anon, authenticated
            using (bucket_id = 'atlases')
            with check (bucket_id = 'atlases');
    end if;
    if not exists (
        select 1 from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname = 'atlases anon delete'
    ) then
        create policy "atlases anon delete" on storage.objects
            for delete to anon, authenticated
            using (bucket_id = 'atlases');
    end if;
end
$$;
