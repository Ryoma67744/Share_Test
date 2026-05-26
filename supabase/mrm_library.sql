-- ============================================================
-- MRM Management Library  --  lab-wide master MRM registry
-- ------------------------------------------------------------
-- Apply AFTER schema.sql AND share_locks.sql in the Supabase
-- SQL Editor. Idempotent: safe to re-run.
--
-- Adds a cross-project "MRM library": validated MRM transitions
-- (precursor / fragment(product) / CE / CV) organised by free-form
-- tags (神経伝達物質 / アミノ酸 / ポリアミン …), plus a usage history
-- that links each transition back to the project + sample it was
-- measured in (so a past measurement can be traced back).
--
-- Security model mirrors share_locks.sql: every table has RLS on and
-- is unreachable from the anon key directly; all access goes through
-- SECURITY DEFINER RPCs. Writes AND the library read are gated by the
-- single-row master password (_verify_master_pw, defined in
-- share_locks.sql) because CE / CV are admin-only data (hidden from
-- share viewers). Reuses _verify_master_pw — does not redefine it.
-- ============================================================

-- ---- 1. Tables ---------------------------------------------
create table if not exists public.mrm_compounds (
    id          uuid primary key default gen_random_uuid(),
    name        text not null unique,
    tags        text[] not null default '{}',     -- tag-style categories (multiple per compound)
    polarity    text,
    note        text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists mrm_compounds_tags_idx on public.mrm_compounds using gin (tags);

create table if not exists public.mrm_transitions (
    id             uuid primary key default gen_random_uuid(),
    compound_id    uuid not null references public.mrm_compounds(id) on delete cascade,
    precursor      numeric,
    product        numeric,              -- UI label: "Fragment"
    ce             numeric,
    cv             numeric,
    role           text,                 -- e.g. 定量 / 確認
    is_recommended boolean not null default false,
    intensity_note text,                 -- e.g. 強いが非特異 / 特異的だが弱い
    note           text,
    created_at     timestamptz not null default now(),
    -- One row per distinct transition of a compound; re-registering the
    -- same transition only appends a usage row (see register_from_result).
    unique (compound_id, precursor, product, ce, cv)
);
create index if not exists mrm_transitions_compound_idx on public.mrm_transitions(compound_id);

create table if not exists public.mrm_usages (
    id            uuid primary key default gen_random_uuid(),
    transition_id uuid not null references public.mrm_transitions(id) on delete cascade,
    project_slug  text,                  -- nullable: a local-only / unpublished project has no slug
    project_name  text,                  -- denormalised so the row survives project deletion
    sample_name   text,
    source        text not null default 'manual' check (source in ('manual','from-result')),
    created_at    timestamptz not null default now()
);
create index if not exists mrm_usages_transition_idx on public.mrm_usages(transition_id);

alter table public.mrm_compounds   enable row level security;
alter table public.mrm_transitions enable row level security;
alter table public.mrm_usages      enable row level security;
-- All access goes through the SECURITY DEFINER RPCs below.
revoke all on public.mrm_compounds   from anon, authenticated;
revoke all on public.mrm_transitions from anon, authenticated;
revoke all on public.mrm_usages      from anon, authenticated;

-- ---- 1b. Phase-2 columns (idempotent; tables may pre-date this) ----
-- (1) serial_no: a user-facing running number used to recognise the SAME
--     compound under name drift (e.g. GABA vs POS_GABA). Same number = same
--     compound (consolidated in the management UI). Auto-assigned on create,
--     editable so two name variants can be set to the same number.
alter table public.mrm_compounds add column if not exists serial_no integer;
-- Backfill rows with a null serial_no, continuing past any existing max so we
-- never collide. No-op once every row has a number (idempotent).
update public.mrm_compounds c
   set serial_no = s.rn
  from (
      select id,
             coalesce((select max(serial_no) from public.mrm_compounds), 0)
               + row_number() over (order by created_at, id) as rn
        from public.mrm_compounds
       where serial_no is null
  ) s
 where c.id = s.id and c.serial_no is null;

-- (2) sample_types: structured multi-select sample categories (脳/肝臓/腎臓/
--     胎児 …) of the project that used a transition, for the MRM-management
--     sample-type filter. Replaces the single free-text sample_name (kept for
--     back-compat).
alter table public.mrm_usages add column if not exists sample_types text[] not null default '{}';
-- Migrate any legacy single sample_name into the array (idempotent).
update public.mrm_usages
   set sample_types = array[sample_name]
 where sample_name is not null and sample_name <> '' and sample_types = '{}';

-- ---- 2. Read RPC (master-pw gated) -------------------------
-- Returns the whole library as one nested jsonb document:
-- [ { ...compound, transitions:[ { ...transition, usages:[...] } ] } ].
-- Gated by the master pw (NOT the public verify_master_pw wrapper)
-- because CE / CV are admin-only.
create or replace function public.list_mrm_library(_master_pw text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_doc jsonb;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    select coalesce(jsonb_agg(obj order by nm), '[]'::jsonb) into v_doc
    from (
        select co.name as nm,
               jsonb_build_object(
                   'id', co.id,
                   'serial_no', co.serial_no,
                   'name', co.name,
                   'tags', to_jsonb(co.tags),
                   'polarity', co.polarity,
                   'note', co.note,
                   'created_at', co.created_at,
                   'updated_at', co.updated_at,
                   'transitions', coalesce((
                       select jsonb_agg(jsonb_build_object(
                                  'id', tr.id,
                                  'precursor', tr.precursor,
                                  'product', tr.product,
                                  'ce', tr.ce,
                                  'cv', tr.cv,
                                  'role', tr.role,
                                  'is_recommended', tr.is_recommended,
                                  'intensity_note', tr.intensity_note,
                                  'note', tr.note,
                                  'created_at', tr.created_at,
                                  'usages', coalesce((
                                      select jsonb_agg(jsonb_build_object(
                                                 'id', us.id,
                                                 'project_slug', us.project_slug,
                                                 'project_name', us.project_name,
                                                 'sample_name', us.sample_name,
                                                 'sample_types', to_jsonb(us.sample_types),
                                                 'source', us.source,
                                                 'created_at', us.created_at
                                             ) order by us.created_at desc)
                                        from public.mrm_usages us
                                       where us.transition_id = tr.id
                                  ), '[]'::jsonb)
                              ) order by tr.is_recommended desc, tr.created_at)
                         from public.mrm_transitions tr
                        where tr.compound_id = co.id
                   ), '[]'::jsonb)
               ) as obj
          from public.mrm_compounds co
    ) s;
    return v_doc;
end
$$;

-- ---- 3. Compound write RPCs --------------------------------
-- Create (or update fields of an existing same-name) compound. Returns
-- the id so the viewer's "register from result" can auto-create by name.
-- Phase 2 added _serial_no (auto-assigned next integer when null); drop the
-- old 5-arg signature so CREATE OR REPLACE doesn't leave an overload behind.
drop function if exists public.upsert_compound(text, text, text[], text, text);
create or replace function public.upsert_compound(
    _master_pw text,
    _name      text,
    _tags      text[] default '{}',
    _polarity  text default null,
    _note      text default null,
    _serial_no integer default null
) returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare v_id uuid;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    if _name is null or length(trim(_name)) = 0 then
        raise exception 'name required';
    end if;
    insert into public.mrm_compounds(name, tags, polarity, note, serial_no)
         values (trim(_name), coalesce(_tags, '{}'), _polarity, _note,
                 coalesce(_serial_no, (select coalesce(max(serial_no), 0) + 1 from public.mrm_compounds)))
    on conflict (name) do update
         set tags       = excluded.tags,
             polarity   = excluded.polarity,
             note       = excluded.note,
             updated_at = now()
    returning id into v_id;
    return v_id;
end
$$;

-- Update an existing compound by id (allows rename + serial_no change so two
-- name variants can be grouped under one number). Drop old 6-arg signature.
drop function if exists public.update_compound(text, uuid, text, text[], text, text);
create or replace function public.update_compound(
    _master_pw text,
    _id        uuid,
    _name      text,
    _tags      text[] default '{}',
    _polarity  text default null,
    _note      text default null,
    _serial_no integer default null
) returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    update public.mrm_compounds
       set name       = coalesce(nullif(trim(_name), ''), name),
           tags       = coalesce(_tags, '{}'),
           polarity   = _polarity,
           note       = _note,
           serial_no  = coalesce(_serial_no, serial_no),
           updated_at = now()
     where id = _id;
end
$$;

create or replace function public.delete_compound(_master_pw text, _id uuid)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    delete from public.mrm_compounds where id = _id;  -- cascades to transitions + usages
end
$$;

-- ---- 4. Transition write RPCs ------------------------------
-- Add a transition (idempotent on the 5-tuple). On conflict, updates the
-- annotation fields (role / recommended / notes) — used by manual "add".
create or replace function public.upsert_transition(
    _master_pw      text,
    _compound_id    uuid,
    _precursor      numeric default null,
    _product        numeric default null,
    _ce             numeric default null,
    _cv             numeric default null,
    _role           text default null,
    _is_recommended boolean default false,
    _intensity_note text default null,
    _note           text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare v_id uuid;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    insert into public.mrm_transitions(
            compound_id, precursor, product, ce, cv,
            role, is_recommended, intensity_note, note)
         values (
            _compound_id, _precursor, _product, _ce, _cv,
            _role, coalesce(_is_recommended, false), _intensity_note, _note)
    on conflict (compound_id, precursor, product, ce, cv) do update
         set role           = excluded.role,
             is_recommended = excluded.is_recommended,
             intensity_note = excluded.intensity_note,
             note           = excluded.note
    returning id into v_id;
    return v_id;
end
$$;

-- Update an existing transition by id (lets the user edit m/z too).
create or replace function public.update_transition(
    _master_pw      text,
    _id             uuid,
    _precursor      numeric default null,
    _product        numeric default null,
    _ce             numeric default null,
    _cv             numeric default null,
    _role           text default null,
    _is_recommended boolean default false,
    _intensity_note text default null,
    _note           text default null
) returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    update public.mrm_transitions
       set precursor      = _precursor,
           product        = _product,
           ce             = _ce,
           cv             = _cv,
           role           = _role,
           is_recommended = coalesce(_is_recommended, false),
           intensity_note = _intensity_note,
           note           = _note
     where id = _id;
end
$$;

create or replace function public.delete_transition(_master_pw text, _id uuid)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    delete from public.mrm_transitions where id = _id;  -- cascades to usages
end
$$;

-- ---- 5. Usage write RPC ------------------------------------
-- Phase 2 added _sample_types (structured sample categories); drop old 6-arg
-- signature so CREATE OR REPLACE doesn't leave an overload behind.
drop function if exists public.record_usage(text, uuid, text, text, text, text);
create or replace function public.record_usage(
    _master_pw     text,
    _transition_id uuid,
    _project_slug  text default null,
    _project_name  text default null,
    _sample_name   text default null,
    _source        text default 'manual',
    _sample_types  text[] default '{}'
) returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare v_id uuid;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    insert into public.mrm_usages(transition_id, project_slug, project_name, sample_name, sample_types, source)
         values (
            _transition_id, _project_slug, _project_name, _sample_name, coalesce(_sample_types, '{}'),
            case when _source in ('manual','from-result') then _source else 'manual' end)
    returning id into v_id;
    return v_id;
end
$$;

-- ---- 6. Bulk register from a measurement result ------------
-- Deduped union of two text[] — used to merge tags on re-register without
-- referencing `excluded` inside a sub-select (which is brittle across PG
-- versions). Internal helper; only reached from the SECURITY DEFINER RPC.
create or replace function public._mrm_array_union(a text[], b text[])
returns text[]
language sql immutable
as $$
    select coalesce(array_agg(distinct x), '{}'::text[])
      from unnest(coalesce(a, '{}') || coalesce(b, '{}')) as x;
$$;
revoke all on function public._mrm_array_union(text[], text[]) from public, anon, authenticated;

-- One transactional call per selected Method-table row: upsert the
-- compound (auto-create by name, merge tags), upsert the transition
-- (no clobber of role/recommended on re-register), then append a usage
-- row tagged 'from-result'. Mirrors upsert_project_doc's single-call
-- multi-table style.
-- Phase 2 added _sample_types + serial_no auto-assign; drop the old 12-arg
-- signature so CREATE OR REPLACE doesn't leave an overload behind.
drop function if exists public.register_from_result(text, text, text[], text, numeric, numeric, numeric, numeric, text, text, text, text);
create or replace function public.register_from_result(
    _master_pw     text,
    _name          text,
    _tags          text[] default '{}',
    _polarity      text default null,
    _precursor     numeric default null,
    _product       numeric default null,
    _ce            numeric default null,
    _cv            numeric default null,
    _role          text default null,
    _project_slug  text default null,
    _project_name  text default null,
    _sample_name   text default null,
    _sample_types  text[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_cid uuid;
    v_tid uuid;
    v_uid uuid;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    if _name is null or length(trim(_name)) = 0 then
        raise exception 'name required';
    end if;
    -- 1. compound: create if missing (auto-assign next serial_no); merge tags
    --    (union); keep existing polarity unless it was empty.
    insert into public.mrm_compounds(name, tags, polarity, serial_no)
         values (trim(_name), coalesce(_tags, '{}'), _polarity,
                 (select coalesce(max(serial_no), 0) + 1 from public.mrm_compounds))
    on conflict (name) do update
         set tags       = public._mrm_array_union(mrm_compounds.tags, excluded.tags),
             polarity   = coalesce(mrm_compounds.polarity, excluded.polarity),
             updated_at = now()
    returning id into v_cid;
    -- 2. transition: create if missing; do NOT clobber an existing
    --    transition's role on re-register.
    insert into public.mrm_transitions(compound_id, precursor, product, ce, cv, role)
         values (v_cid, _precursor, _product, _ce, _cv, _role)
    on conflict (compound_id, precursor, product, ce, cv) do update
         set role = coalesce(mrm_transitions.role, excluded.role)
    returning id into v_tid;
    -- 3. usage: always append (with structured sample types).
    insert into public.mrm_usages(transition_id, project_slug, project_name, sample_name, sample_types, source)
         values (v_tid, _project_slug, _project_name, _sample_name, coalesce(_sample_types, '{}'), 'from-result')
    returning id into v_uid;
    return jsonb_build_object('ok', true,
                              'compound_id', v_cid,
                              'transition_id', v_tid,
                              'usage_id', v_uid);
end
$$;

-- ---- 7. Grants ---------------------------------------------
grant execute on function public.list_mrm_library(text)                                                          to anon, authenticated;
grant execute on function public.upsert_compound(text, text, text[], text, text, integer)                        to anon, authenticated;
grant execute on function public.update_compound(text, uuid, text, text[], text, text, integer)                  to anon, authenticated;
grant execute on function public.delete_compound(text, uuid)                                                     to anon, authenticated;
grant execute on function public.upsert_transition(text, uuid, numeric, numeric, numeric, numeric, text, boolean, text, text) to anon, authenticated;
grant execute on function public.update_transition(text, uuid, numeric, numeric, numeric, numeric, text, boolean, text, text) to anon, authenticated;
grant execute on function public.delete_transition(text, uuid)                                                   to anon, authenticated;
grant execute on function public.record_usage(text, uuid, text, text, text, text, text[])                        to anon, authenticated;
grant execute on function public.register_from_result(text, text, text[], text, numeric, numeric, numeric, numeric, text, text, text, text, text[]) to anon, authenticated;

-- ===========================================================================
-- Optional teardown (commented out by default)
-- ===========================================================================
-- drop function if exists public.register_from_result(text, text, text[], text, numeric, numeric, numeric, numeric, text, text, text, text, text[]);
-- drop function if exists public.record_usage(text, uuid, text, text, text, text, text[]);
-- drop function if exists public.delete_transition(text, uuid);
-- drop function if exists public.update_transition(text, uuid, numeric, numeric, numeric, numeric, text, boolean, text, text);
-- drop function if exists public.upsert_transition(text, uuid, numeric, numeric, numeric, numeric, text, boolean, text, text);
-- drop function if exists public.delete_compound(text, uuid);
-- drop function if exists public.update_compound(text, uuid, text, text[], text, text, integer);
-- drop function if exists public.upsert_compound(text, text, text[], text, text, integer);
-- drop function if exists public.list_mrm_library(text);
-- drop table if exists public.mrm_usages;
-- drop table if exists public.mrm_transitions;
-- drop table if exists public.mrm_compounds;
