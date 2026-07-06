-- ===========================================================================
-- Marmoset Atlas Viewer  --  Supabase schema (Phase 1)
-- ---------------------------------------------------------------------------
-- Run this file once on a fresh Supabase project (SQL Editor → New Query →
-- paste → Run). Idempotent: re-running will not destroy existing data unless
-- you uncomment the DROPs at the bottom of the file.
--
-- After running:
--   1) Insert one row in `projects` for your atlas (e.g. cor_slide_1_10)
--   2) Insert two rows in `project_credentials` (viewer + admin) using
--      `set_project_password(slug, role, plain_password)` — see seed_*.sql
--   3) Upload HE / CSV / overlay JSON to the `atlases` Storage bucket
--   4) Insert one row per slice in `sections`
--   5) Optionally seed initial ROIs via `import_rois_jsonb`
-- ===========================================================================

create extension if not exists "pgcrypto";   -- for crypt() / gen_salt()

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists projects (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  display_name    text not null,
  anatomy_palette jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create table if not exists project_credentials (
  project_id    uuid not null references projects(id) on delete cascade,
  role          text not null check (role in ('viewer','admin')),
  password_hash text not null,
  primary key (project_id, role)
);

create table if not exists sections (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  ordinal       int  not null default 0,
  display_name  text not null,
  meta          jsonb not null default '{}'::jsonb,
  storage_paths jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (project_id, ordinal)
);

create table if not exists rois (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  section_id  uuid not null references sections(id) on delete cascade,
  color_key   text not null,
  name        text,
  poly_msi    jsonb not null,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int  not null default 1
);

-- Idempotent for existing deployments (create table if not exists above is a
-- no-op once the table exists, so the name column is added here on re-run).
alter table rois add column if not exists name text;

create index if not exists rois_project_section_idx on rois(project_id, section_id);

-- ---------------------------------------------------------------------------
-- Token model
-- ---------------------------------------------------------------------------
-- We do NOT use Supabase Auth. Instead `unlock_project` issues a short-lived
-- opaque token stored in `session_tokens`. Every other RPC takes the token
-- and looks up role + project_id from this table.
-- ---------------------------------------------------------------------------

create table if not exists session_tokens (
  token       text primary key,
  project_id  uuid not null references projects(id) on delete cascade,
  role        text not null check (role in ('viewer','admin')),
  expires_at  timestamptz not null
);

create index if not exists session_tokens_expires_idx on session_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Direct table access is blocked from the anon key. All reads/writes go
-- through SECURITY DEFINER RPCs declared below.
-- ---------------------------------------------------------------------------

alter table projects             enable row level security;
alter table project_credentials  enable row level security;
alter table sections             enable row level security;
alter table rois                 enable row level security;
alter table session_tokens       enable row level security;

-- (no permissive policies — all access via RPCs)

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- Verify a token and return (project_id, role); raises if invalid/expired.
create or replace function _resolve_token(p_token text)
returns table (project_id uuid, role text)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from session_tokens where expires_at < now();
  return query
    select t.project_id, t.role
      from session_tokens t
     where t.token = p_token
       and t.expires_at > now()
     limit 1;
  if not found then
    raise exception 'invalid or expired token' using errcode = '28000';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Admin helpers (called from SQL editor by you, the project owner)
-- ---------------------------------------------------------------------------

-- Set or rotate a project password. Hashes with bcrypt.
create or replace function set_project_password(
  p_slug text, p_role text, p_password text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_project_id uuid;
begin
  if p_role not in ('viewer','admin') then
    raise exception 'role must be viewer or admin';
  end if;
  select id into v_project_id from projects where slug = p_slug;
  if v_project_id is null then
    raise exception 'project not found: %', p_slug;
  end if;
  insert into project_credentials(project_id, role, password_hash)
       values (v_project_id, p_role, crypt(p_password, gen_salt('bf', 12)))
  on conflict (project_id, role) do update
       set password_hash = excluded.password_hash;
end
$$;

-- Bulk import ROIs from a JSON array (used by seed scripts).
-- Shape: [{"section_ordinal":0,"color_key":"Red","poly_msi":[[..]],"created_by":"seed"}]
create or replace function import_rois_jsonb(p_slug text, p_rois jsonb)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_project_id uuid;
  v_count int := 0;
  v_row jsonb;
  v_section_id uuid;
begin
  select id into v_project_id from projects where slug = p_slug;
  if v_project_id is null then raise exception 'project not found: %', p_slug; end if;
  for v_row in select * from jsonb_array_elements(p_rois) loop
    select id into v_section_id
      from sections
     where project_id = v_project_id
       and ordinal = (v_row->>'section_ordinal')::int;
    if v_section_id is null then
      raise exception 'section ordinal % not found for project %',
        v_row->>'section_ordinal', p_slug;
    end if;
    insert into rois(project_id, section_id, color_key, poly_msi, created_by)
    values (v_project_id, v_section_id,
            v_row->>'color_key',
            v_row->'poly_msi',
            coalesce(v_row->>'created_by','seed'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs (callable with the anon key from the browser)
-- ---------------------------------------------------------------------------

-- Authenticate against a project and obtain a session token.
create or replace function unlock_project(p_slug text, p_password text)
returns table (token text, role text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_project_id uuid;
  v_role text;
  v_token text;
  v_expires timestamptz;
begin
  select p.id into v_project_id from projects p where p.slug = p_slug;
  if v_project_id is null then
    raise exception 'invalid credentials' using errcode = '28P01';
  end if;
  -- Try admin first (so a single admin password also implies viewer rights).
  select c.role into v_role
    from project_credentials c
   where c.project_id = v_project_id
     and c.password_hash = crypt(p_password, c.password_hash)
   order by case c.role when 'admin' then 0 else 1 end
   limit 1;
  if v_role is null then
    raise exception 'invalid credentials' using errcode = '28P01';
  end if;
  v_token := encode(gen_random_bytes(24), 'hex');
  v_expires := now() + interval '12 hours';
  insert into session_tokens(token, project_id, role, expires_at)
       values (v_token, v_project_id, v_role, v_expires);
  return query select v_token, v_role, v_expires;
end
$$;

-- Fetch the project document (palette + sections + signed URLs not included
-- here; the frontend asks Storage separately for signed URLs).
create or replace function get_project_doc(p_token text)
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
      'display_name', p.display_name
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
        where s.project_id = p.id),
      '[]'::jsonb
    )
  ) into v_doc
  from projects p where p.id = r.project_id;
  return v_doc;
end
$$;

-- Return all ROIs of a section.
create or replace function list_rois(p_token text, p_section_id uuid)
returns setof rois
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r record;
begin
  select * into r from _resolve_token(p_token);
  return query
    select * from rois
     where project_id = r.project_id
       and section_id = p_section_id
     order by created_at;
end
$$;

-- Insert a new ROI.
-- Signature changed (added p_name): drop the old one first so a re-run
-- replaces it instead of creating a second overload.
drop function if exists create_roi(text, uuid, text, jsonb, text);
create or replace function create_roi(
  p_token text,
  p_section_id uuid,
  p_color_key text,
  p_name text,
  p_poly_msi jsonb,
  p_created_by text
) returns rois
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r record;
  v rois;
begin
  select * into r from _resolve_token(p_token);
  if not exists (select 1 from sections
                  where id = p_section_id and project_id = r.project_id) then
    raise exception 'section not in this project';
  end if;
  insert into rois(project_id, section_id, color_key, name, poly_msi, created_by)
       values (r.project_id, p_section_id, p_color_key, p_name, p_poly_msi, p_created_by)
    returning * into v;
  return v;
end
$$;

-- Rename / re-shape (rare) an ROI with optimistic lock.
-- Signature changed (added p_name): drop the old one first so a re-run
-- replaces it instead of creating a second overload. The mutable fields
-- default to null + coalesce so a rename can pass only p_name (leaving
-- color_key / poly_msi untouched) and a re-shape can pass only those.
drop function if exists update_roi(text, uuid, int, text, jsonb);
create or replace function update_roi(
  p_token text,
  p_id uuid,
  p_expected_version int,
  p_color_key text default null,
  p_poly_msi jsonb default null,
  p_name text default null
) returns rois
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r record;
  v rois;
begin
  select * into r from _resolve_token(p_token);
  update rois
     set color_key  = coalesce(p_color_key, color_key),
         poly_msi   = coalesce(p_poly_msi,  poly_msi),
         name       = coalesce(p_name,      name),
         updated_at = now(),
         version    = version + 1
   where id = p_id
     and project_id = r.project_id
     and version = p_expected_version
   returning * into v;
  if v.id is null then
    raise exception 'stale_version' using errcode = '40001';
  end if;
  return v;
end
$$;

-- Delete a single ROI (any viewer can delete any ROI per spec).
create or replace function delete_roi(p_token text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r record;
begin
  select * into r from _resolve_token(p_token);
  delete from rois where id = p_id and project_id = r.project_id;
end
$$;

-- Admin-only: wipe all ROIs of the project.
create or replace function clear_all_rois(p_token text)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r record;
  v_count int;
begin
  select * into r from _resolve_token(p_token);
  if r.role <> 'admin' then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  delete from rois where project_id = r.project_id;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Issue a short-lived signed URL for a Storage object inside the
-- `atlases` bucket. Path must be relative to the bucket root.
-- NOTE (Phase 1): we host the bucket as public read, so the frontend
-- builds the URL directly. This RPC is kept dropped on purpose — it
-- referenced a non-existent storage helper and is not called anywhere.
drop function if exists get_signed_url(text, text, int);

-- ---------------------------------------------------------------------------
-- Grants — make the public RPCs callable from the anon key, hide internals
-- ---------------------------------------------------------------------------

grant execute on function unlock_project(text, text)         to anon, authenticated;
grant execute on function get_project_doc(text)              to anon, authenticated;
grant execute on function list_rois(text, uuid)              to anon, authenticated;
grant execute on function create_roi(text, uuid, text, text, jsonb, text) to anon, authenticated;
grant execute on function update_roi(text, uuid, int, text, jsonb, text)  to anon, authenticated;
grant execute on function delete_roi(text, uuid)             to anon, authenticated;
grant execute on function clear_all_rois(text)               to anon, authenticated;

-- Internals: keep callable only by the service_role (i.e. you in SQL editor).
revoke all on function _resolve_token(text)                from public, anon, authenticated;
revoke all on function set_project_password(text,text,text) from public, anon, authenticated;
revoke all on function import_rois_jsonb(text, jsonb)       from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage bucket
-- ---------------------------------------------------------------------------
-- Phase 1: served as public-read. The URL pattern is unguessable enough
-- (project slug + section ordinal) for our research use case, and it
-- avoids the complexity of signed URLs without a server.
insert into storage.buckets (id, name, public)
     values ('atlases', 'atlases', true)
on conflict (id) do update set public = true;

-- ===========================================================================
-- Optional teardown (commented out by default)
-- ===========================================================================
-- drop function if exists clear_all_rois(text);
-- drop function if exists delete_roi(text, uuid);
-- drop function if exists update_roi(text, uuid, int, text, jsonb, text);
-- drop function if exists create_roi(text, uuid, text, text, jsonb, text);
-- drop function if exists list_rois(text, uuid);
-- drop function if exists get_project_doc(text);
-- drop function if exists unlock_project(text, text);
-- drop function if exists import_rois_jsonb(text, jsonb);
-- drop function if exists set_project_password(text, text, text);
-- drop function if exists _resolve_token(text);
-- drop table if exists session_tokens;
-- drop table if exists rois;
-- drop table if exists sections;
-- drop table if exists project_credentials;
-- drop table if exists projects;
