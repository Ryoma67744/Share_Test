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
alter table public.projects add column if not exists meta jsonb not null default '{}'::jsonb;
alter table public.projects add column if not exists is_public boolean not null default false;
alter table public.rois     add column if not exists name        text;

-- ---- 2b. Master credential (Phase 1) ------------------------
-- Single-row table holding the bcrypt-hashed master password. All
-- write-side RPCs and Storage write policies validate against this row
-- so a leaked anon key alone is not enough to mutate published data.
--
-- BOOTSTRAP (run once in the Supabase SQL Editor after applying this
-- migration):
--     select public.set_master_password('MSIadomine');
-- Replace the literal with whatever long master password you prefer
-- (8 chars minimum). Re-running rotates the password.
create table if not exists public.master_credentials (
    id            int primary key check (id = 1),
    password_hash text not null,
    updated_at    timestamptz not null default now()
);
alter table public.master_credentials enable row level security;
revoke all on public.master_credentials from anon, authenticated;

create or replace function public.set_master_password(_pw text)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if _pw is null or length(_pw) < 8 then
        raise exception 'master password must be at least 8 characters';
    end if;
    insert into public.master_credentials(id, password_hash)
        values (1, crypt(_pw, gen_salt('bf')))
    on conflict (id) do update
        set password_hash = excluded.password_hash, updated_at = now();
end
$$;
revoke all on function public.set_master_password(text) from public, anon, authenticated;

create or replace function public._verify_master_pw(_pw text)
returns boolean
language sql security definer set search_path = public, extensions
as $$
    select exists (
        select 1 from public.master_credentials
         where id = 1 and password_hash = crypt(_pw, password_hash)
    );
$$;
revoke all on function public._verify_master_pw(text) from public, anon, authenticated;

-- Public-callable wrapper used by the manager-page unlock gate. Returns
-- true/false rather than raising, so the client can show a "wrong
-- password" message without a network-error code path. Anon-allowed by
-- design because the caller is the gate itself; even if leaked, it only
-- enables a (rate-limit-bound) bcrypt check.
create or replace function public.verify_master_pw(_pw text)
returns boolean
language sql security definer set search_path = public, extensions
as $$
    select public._verify_master_pw(_pw);
$$;
grant execute on function public.verify_master_pw(text) to anon, authenticated;

-- ---- 2c. Publish session token (Phase 1) ---------------------
-- Short-lived per-publish ticket. Issued by request_publish_session()
-- after master-pw verification, then sent as the "x-publish-token"
-- header on Storage upload requests. Storage RLS policy below validates
-- the token + slug match before allowing the write.
create table if not exists public.publish_sessions (
    token       text primary key,
    slug        text not null,
    expires_at  timestamptz not null
);
alter table public.publish_sessions enable row level security;
revoke all on public.publish_sessions from anon, authenticated;

create or replace function public.request_publish_session(_master_pw text, _slug text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_token   text;
    v_expires timestamptz;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    if _slug is null or length(trim(_slug)) = 0 then
        raise exception 'slug required';
    end if;
    -- Garbage-collect expired tokens opportunistically.
    delete from public.publish_sessions where expires_at < now();
    v_token   := encode(gen_random_bytes(24), 'hex');
    v_expires := now() + interval '1 hour';
    insert into public.publish_sessions(token, slug, expires_at)
         values (v_token, _slug, v_expires);
    return jsonb_build_object('token', v_token, 'slug', _slug, 'expires_at', v_expires);
end
$$;
grant execute on function public.request_publish_session(text, text) to anon, authenticated;

-- ---- 3. upsert_project_doc: Master-side publish helper ------
-- Pushes the entire project document (meta + sections + rois) plus
-- a fresh viewer/admin password set, in one transaction. Designed to
-- be called once per "Publish to share" click.
-- Phase 1 added _master_pw as the first argument; the previous (7-arg)
-- signature must be dropped explicitly because CREATE OR REPLACE doesn't
-- replace functions whose argument list changed. Phase 3 adds _is_public
-- to allow public-link sharing.
drop function if exists public.upsert_project_doc(text, text, jsonb, text, text, jsonb, jsonb);
drop function if exists public.upsert_project_doc(text, text, text, jsonb, text, text, jsonb, jsonb);

create or replace function public.upsert_project_doc(
    _master_pw     text,
    _slug          text,
    _display_name  text,
    _meta          jsonb,
    _viewer_pw     text,
    _admin_pw      text default null,
    _sections      jsonb default '[]'::jsonb,
    _rois          jsonb default '[]'::jsonb,
    _is_public     boolean default false
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
    -- Public links don't carry a viewer password; the column-NOT-NULL
    -- constraint on project_credentials is sidestepped by simply NOT
    -- inserting a viewer row when _is_public is true.
    if not coalesce(_is_public, false) then
        if _viewer_pw is null or length(_viewer_pw) < 4 then
            return jsonb_build_object('ok', false, 'reason', 'viewer_password_required');
        end if;
    end if;
    -- Master credential check (Phase 1). Even if the anon key is leaked,
    -- this RPC will refuse to write without the master password.
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;

    insert into public.projects(slug, display_name, anatomy_palette, meta, is_public)
        values (
            _slug,
            coalesce(_display_name, _slug),
            coalesce(_meta->'anatomyPalette', '{}'::jsonb),
            jsonb_strip_nulls(jsonb_build_object('memo', coalesce(_meta->'memo', '{}'::jsonb))),
            coalesce(_is_public, false)
        )
        on conflict (slug) do update
        set display_name    = excluded.display_name,
            anatomy_palette = excluded.anatomy_palette,
            meta            = jsonb_set(
                                  coalesce(public.projects.meta, '{}'::jsonb),
                                  '{memo}',
                                  coalesce(_meta->'memo', '{}'::jsonb)
                              ),
            is_public       = excluded.is_public,
            updated_at      = now()
        returning id into v_pid;

    -- (Re)set credentials. set_project_password is provided by schema.sql.
    if coalesce(_is_public, false) then
        -- Switching a private project to public must clear any stored
        -- viewer hash so the project can never accidentally accept the
        -- old password again. Admin credential is unaffected.
        delete from public.project_credentials
            where project_id = v_pid and role = 'viewer';
        -- Existing viewer-role tokens issued under the old password
        -- become moot anyway, but proactively clearing them stops a
        -- stale viewer session from outliving the privacy change.
        delete from public.session_tokens
            where project_id = v_pid and role = 'viewer';
    else
        perform public.set_project_password(_slug, 'viewer', _viewer_pw);
    end if;
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

grant execute on function public.upsert_project_doc(text, text, text, jsonb, text, text, jsonb, jsonb, boolean) to anon, authenticated;

-- ---- 3b. unlock_public_project: anonymous-token mint for is_public projects ----
-- Mirrors unlock_project's "issue a 12-hour viewer token" behavior, but
-- gates only on the projects.is_public flag (no password compare). The
-- frontend tries this RPC first; on `not_public` it falls back to the
-- password modal + unlock_project pair so private projects keep their
-- existing flow.
create or replace function public.unlock_public_project(_slug text)
returns table (token text, role text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_pid     uuid;
    v_token   text;
    v_expires timestamptz;
begin
    if _slug is null or length(trim(_slug)) = 0 then
        raise exception 'slug_required' using errcode = '22023';
    end if;
    select id into v_pid from public.projects
        where slug = _slug and is_public = true
        limit 1;
    if v_pid is null then
        raise exception 'not_public' using errcode = '28P02';
    end if;
    -- GC expired tokens like unlock_project does.
    delete from public.session_tokens where expires_at < now();
    v_token   := encode(gen_random_bytes(24), 'hex');
    v_expires := now() + interval '12 hour';
    insert into public.session_tokens(token, project_id, role, expires_at)
        values (v_token, v_pid, 'viewer', v_expires);
    token       := v_token;
    role        := 'viewer';
    expires_at  := v_expires;
    return next;
end
$$;
grant execute on function public.unlock_public_project(text) to anon, authenticated;

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
-- Phase 1 (write policies): replace the wide-open anon write policies
-- with publish-token-gated ones. Reads are still public — the bucket is
-- public-read by design and signed-URL reads are deferred to Phase 2.
do $$
begin
    -- Drop the legacy "anyone with the anon key can write" policies.
    if exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='atlases anon insert') then
        drop policy "atlases anon insert" on storage.objects;
    end if;
    if exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='atlases anon update') then
        drop policy "atlases anon update" on storage.objects;
    end if;
    if exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='atlases anon delete') then
        drop policy "atlases anon delete" on storage.objects;
    end if;

    -- Read stays public (bucket is public:true, plus an explicit anon
    -- SELECT policy so signed-URL fetches and direct GETs both work).
    if not exists (
        select 1 from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname = 'atlases anon read'
    ) then
        create policy "atlases anon read" on storage.objects
            for select to anon, authenticated
            using (bucket_id = 'atlases');
    end if;

    -- Write policies require an x-publish-token header that maps to a
    -- non-expired publish_sessions row whose slug prefixes the path.
    -- request.headers is provided by Supabase's request middleware as a
    -- jsonb; the nullif guard avoids errors when the header is missing.
    if not exists (
        select 1 from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname = 'atlases publish-token insert'
    ) then
        create policy "atlases publish-token insert" on storage.objects
            for insert to anon, authenticated
            with check (
                bucket_id = 'atlases'
                and exists (
                    select 1 from public.publish_sessions ps
                     where ps.token = nullif(current_setting('request.headers', true), '')::jsonb->>'x-publish-token'
                       and ps.expires_at > now()
                       and storage.objects.name like ps.slug || '/%'
                )
            );
    end if;

    if not exists (
        select 1 from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname = 'atlases publish-token update'
    ) then
        create policy "atlases publish-token update" on storage.objects
            for update to anon, authenticated
            using (
                bucket_id = 'atlases'
                and exists (
                    select 1 from public.publish_sessions ps
                     where ps.token = nullif(current_setting('request.headers', true), '')::jsonb->>'x-publish-token'
                       and ps.expires_at > now()
                       and storage.objects.name like ps.slug || '/%'
                )
            )
            with check (
                bucket_id = 'atlases'
                and exists (
                    select 1 from public.publish_sessions ps
                     where ps.token = nullif(current_setting('request.headers', true), '')::jsonb->>'x-publish-token'
                       and ps.expires_at > now()
                       and storage.objects.name like ps.slug || '/%'
                )
            );
    end if;
end
$$;

-- ---- 5. get_project_doc: include projects.meta in the payload ------
-- schema.sql's original definition of get_project_doc was written before
-- projects.meta existed. Re-create it here so the client receives the
-- master-supplied memo (experiment date, machine, matrix, Google Keep,
-- free note) alongside sections and ROIs, and can populate the right-
-- hand Memo panel directly from the server. Body is otherwise identical
-- to the schema.sql version.
create or replace function public.get_project_doc(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r record;
  v_doc jsonb;
begin
  select * into r from _resolve_token(p_token);
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'project_slug', p.slug,
      'display_name', p.display_name,
      'project_meta', p.meta
    ),
    'anatomy_palette', p.anatomy_palette,
    'sections', coalesce(
      (select jsonb_agg(jsonb_build_object(
                'id', s.id,
                'ordinal', s.ordinal,
                'display_name', s.display_name,
                'meta', s.meta,
                'storage_paths', s.storage_paths
              ) order by s.ordinal)
         from sections s
        where s.project_id = r.project_id),
      '[]'::jsonb
    )
  ) into v_doc
  from projects p where p.id = r.project_id;
  return v_doc;
end
$$;

grant execute on function public.get_project_doc(text) to anon, authenticated;

-- ---- 6. list_projects: master-side cross-project listing -----------
-- Returns every project whose admin password matches _owner_password.
-- Convention: the master uses a single shared admin password (default
-- "MSIadomine") across all of their published projects, so one call
-- returns the full catalogue. Mismatching credentials return an empty
-- result; an empty / too-short password raises 28P01 to keep clients
-- from probing.
create or replace function public.list_projects(_owner_password text)
returns table (slug text, display_name text, meta jsonb, created_at timestamptz, updated_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
    if _owner_password is null or length(_owner_password) < 4 then
        raise exception 'invalid credentials' using errcode = '28P01';
    end if;
    return query
        select p.slug, p.display_name, p.meta, p.created_at, p.updated_at
          from public.projects p
         where exists (
             select 1 from public.project_credentials c
              where c.project_id = p.id
                and c.role = 'admin'
                and c.password_hash = crypt(_owner_password, c.password_hash)
         )
         order by coalesce(p.updated_at, p.created_at) desc;
end
$$;

grant execute on function public.list_projects(text) to anon, authenticated;

-- ---- 7. Storage RLS helper for publish_sessions (Phase 1 fix) ------
-- The atlases write policies in section 4 reference publish_sessions
-- from a subquery that is evaluated as the request's role (anon when
-- the browser uses the publishable key). publish_sessions has RLS on
-- and `revoke all ... from anon`, so the anon role can read no rows
-- from it; the `exists (...)` subquery in those policies therefore
-- returns false unconditionally and every Storage upload fails with:
--     "new row violates row-level security policy"
-- Wrap the lookup in a SECURITY DEFINER function so the storage RLS
-- subquery runs with the function owner's privileges and can see the
-- session row that request_publish_session just inserted. The function
-- still validates the publish-token header and the slug-prefixed path,
-- so the gate semantics are unchanged.
create or replace function public._publish_session_valid_for_path(p_token text, p_path text)
returns boolean
language sql security definer set search_path = public, extensions
as $$
    select exists (
        select 1 from public.publish_sessions ps
         where ps.token = p_token
           and ps.expires_at > now()
           and p_path like ps.slug || '/%'
    );
$$;
revoke all on function public._publish_session_valid_for_path(text, text) from public;
grant execute on function public._publish_session_valid_for_path(text, text) to anon, authenticated;

-- Replace the broken atlases write policies with ones that delegate
-- the publish_sessions lookup to the SECURITY DEFINER helper above.
do $$
begin
    if exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='atlases publish-token insert') then
        drop policy "atlases publish-token insert" on storage.objects;
    end if;
    if exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='atlases publish-token update') then
        drop policy "atlases publish-token update" on storage.objects;
    end if;

    create policy "atlases publish-token insert" on storage.objects
        for insert to anon, authenticated
        with check (
            bucket_id = 'atlases'
            and public._publish_session_valid_for_path(
                nullif(current_setting('request.headers', true), '')::jsonb->>'x-publish-token',
                storage.objects.name
            )
        );

    create policy "atlases publish-token update" on storage.objects
        for update to anon, authenticated
        using (
            bucket_id = 'atlases'
            and public._publish_session_valid_for_path(
                nullif(current_setting('request.headers', true), '')::jsonb->>'x-publish-token',
                storage.objects.name
            )
        )
        with check (
            bucket_id = 'atlases'
            and public._publish_session_valid_for_path(
                nullif(current_setting('request.headers', true), '')::jsonb->>'x-publish-token',
                storage.objects.name
            )
        );
end
$$;
