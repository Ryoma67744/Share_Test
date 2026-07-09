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

-- ---- 6b. Instrument .exp template storage ------------------
-- Single-row table holding the MassLynx ".exp" template text. The instrument
-- is fixed lab-wide, so one template is reused for every export; only the
-- MRM/SIR channel block is substituted client-side at export time. Master-pw
-- gated like the rest of the library (it carries instrument settings).
create table if not exists public.mrm_exp_template (
    id         int primary key check (id = 1),
    content    text not null,
    updated_at timestamptz not null default now()
);
alter table public.mrm_exp_template enable row level security;
revoke all on public.mrm_exp_template from anon, authenticated;

create or replace function public.set_exp_template(_master_pw text, _content text)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    insert into public.mrm_exp_template(id, content)
         values (1, coalesce(_content, ''))
    on conflict (id) do update
         set content = excluded.content, updated_at = now();
end
$$;

create or replace function public.get_exp_template(_master_pw text)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare v_content text;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    select content into v_content from public.mrm_exp_template where id = 1;
    return v_content;  -- null when no template saved yet
end
$$;

-- ---- 6c. MRM method sets ("A先生セット") -------------------
-- A named, reusable measurement method = an ordered list of MRM channels.
-- Each item keeps BOTH a soft reference to the source transition (for
-- traceability; nulled if that transition is later deleted) AND a snapshot of
-- the channel values (name / precursor / product / ce / cv), so a set stays
-- self-contained and can always be exported to .exp even after the library
-- changes. Master-pw gated like the rest of the library.
create table if not exists public.mrm_sets (
    id                  uuid primary key default gen_random_uuid(),
    name                text not null unique,
    owner               text,
    description         text,
    source_project_slug text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
alter table public.mrm_sets enable row level security;
revoke all on public.mrm_sets from anon, authenticated;

create table if not exists public.mrm_set_items (
    id            uuid primary key default gen_random_uuid(),
    set_id        uuid not null references public.mrm_sets(id) on delete cascade,
    position      int  not null,
    transition_id uuid references public.mrm_transitions(id) on delete set null,
    name          text,
    precursor     numeric,
    product       numeric,
    ce            numeric,
    cv            numeric,
    note          text,
    unique (set_id, position)
);
alter table public.mrm_set_items enable row level security;
revoke all on public.mrm_set_items from anon, authenticated;
create index if not exists mrm_set_items_set_idx on public.mrm_set_items(set_id);

-- Create or fully replace a set (and its ordered items). Pass _id to update an
-- existing set (incl. rename); null _id = create new (or update same-name).
-- _items: jsonb array of {transition_id?, name, precursor, product, ce, cv, note?}
-- in display order. Items are replaced wholesale.
create or replace function public.upsert_mrm_set(
    _master_pw           text,
    _id                  uuid,
    _name                text,
    _owner               text default null,
    _description         text default null,
    _source_project_slug text default null,
    _items               jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_id uuid;
    it   jsonb;
    pos  int := 0;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    if _name is null or length(trim(_name)) = 0 then
        raise exception 'name required';
    end if;

    if _id is not null then
        update public.mrm_sets
           set name = trim(_name), owner = _owner, description = _description,
               source_project_slug = _source_project_slug, updated_at = now()
         where id = _id
        returning id into v_id;
    end if;
    if v_id is null then
        insert into public.mrm_sets(name, owner, description, source_project_slug)
             values (trim(_name), _owner, _description, _source_project_slug)
        on conflict (name) do update
             set owner = excluded.owner,
                 description = excluded.description,
                 source_project_slug = excluded.source_project_slug,
                 updated_at = now()
        returning id into v_id;
    end if;

    delete from public.mrm_set_items where set_id = v_id;
    for it in select * from jsonb_array_elements(coalesce(_items, '[]'::jsonb))
    loop
        insert into public.mrm_set_items(
                set_id, position, transition_id, name, precursor, product, ce, cv, note)
             values (
                v_id, pos,
                nullif(it->>'transition_id', '')::uuid,
                it->>'name',
                nullif(it->>'precursor', '')::numeric,
                nullif(it->>'product', '')::numeric,
                nullif(it->>'ce', '')::numeric,
                nullif(it->>'cv', '')::numeric,
                it->>'note');
        pos := pos + 1;
    end loop;
    return v_id;
end
$$;

-- Return all sets with their ordered items as one nested jsonb document:
-- [ { ...set, items:[ { ...item } ] } ].
create or replace function public.list_mrm_sets(_master_pw text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare v_doc jsonb;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    select coalesce(jsonb_agg(obj order by nm), '[]'::jsonb) into v_doc
    from (
        select s.name as nm,
               jsonb_build_object(
                   'id', s.id,
                   'name', s.name,
                   'owner', s.owner,
                   'description', s.description,
                   'source_project_slug', s.source_project_slug,
                   'created_at', s.created_at,
                   'updated_at', s.updated_at,
                   'items', coalesce((
                       select jsonb_agg(jsonb_build_object(
                                  'id', i.id,
                                  'position', i.position,
                                  'transition_id', i.transition_id,
                                  'name', i.name,
                                  'precursor', i.precursor,
                                  'product', i.product,
                                  'ce', i.ce,
                                  'cv', i.cv,
                                  'note', i.note
                              ) order by i.position)
                         from public.mrm_set_items i
                        where i.set_id = s.id
                   ), '[]'::jsonb)
               ) as obj
          from public.mrm_sets s
    ) q;
    return v_doc;
end
$$;

create or replace function public.delete_mrm_set(_master_pw text, _id uuid)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    delete from public.mrm_sets where id = _id;  -- cascades to mrm_set_items
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
grant execute on function public.set_exp_template(text, text)                                                    to anon, authenticated;
grant execute on function public.get_exp_template(text)                                                          to anon, authenticated;
grant execute on function public.upsert_mrm_set(text, uuid, text, text, text, text, jsonb)                       to anon, authenticated;
grant execute on function public.list_mrm_sets(text)                                                             to anon, authenticated;
grant execute on function public.delete_mrm_set(text, uuid)                                                      to anon, authenticated;

-- ---- 8. Read-only access path (for the ChatGPT / AI connector) -----------
-- A SEPARATE, read-only password (NOT the master pw) gates a read-only view of
-- the library so the hosted connector can expose registered MRMs (and the .exp
-- template) to a Custom GPT WITHOUT ever holding the write-capable master pw.
-- Mirrors the bcrypt pattern of share_locks.sql (set_master_password /
-- _verify_master_pw). Idempotent; reuses pgcrypto in the extensions schema.
create table if not exists public.mrm_read_credentials (
    id            int primary key check (id = 1),
    password_hash text not null,
    updated_at    timestamptz not null default now()
);
alter table public.mrm_read_credentials enable row level security;
revoke all on public.mrm_read_credentials from anon, authenticated;

-- BOOTSTRAP (run once in the Supabase SQL Editor after applying this file):
--     select public.set_mrm_read_password('<CHOOSE-A-READ-ONLY-PASSWORD>');
-- Use a value DIFFERENT from the master password. Re-running rotates it.
create or replace function public.set_mrm_read_password(_pw text)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if _pw is null or length(_pw) < 8 then
        raise exception 'mrm read password must be at least 8 characters';
    end if;
    insert into public.mrm_read_credentials(id, password_hash)
        values (1, crypt(_pw, gen_salt('bf', 12)))
    on conflict (id) do update
        set password_hash = excluded.password_hash, updated_at = now();
end
$$;
revoke all on function public.set_mrm_read_password(text) from public, anon, authenticated;

create or replace function public._verify_mrm_read_pw(_pw text)
returns boolean
language sql security definer set search_path = public, extensions
as $$
    select exists (
        select 1 from public.mrm_read_credentials
         where id = 1 and password_hash = crypt(_pw, password_hash)
    );
$$;
revoke all on function public._verify_mrm_read_pw(text) from public, anon, authenticated;

-- Read-only library snapshot for the connector. Same nested shape as
-- list_mrm_library, INCLUDING ce/cv (needed so the connector can assemble a
-- byte-accurate .exp). Gated by the read-only pw, NOT the master pw. Usage rows
-- are trimmed to non-sensitive fields (project_name / sample_types / source).
create or replace function public.list_mrm_library_ro(_read_pw text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_doc jsonb;
begin
    if not public._verify_mrm_read_pw(_read_pw) then
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
                                  'usages', coalesce((
                                      select jsonb_agg(jsonb_build_object(
                                                 'project_name', us.project_name,
                                                 'sample_types', to_jsonb(us.sample_types),
                                                 'source', us.source
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

-- Read-only .exp template fetch (read-pw gated) so the connector can assemble
-- the instrument file server-side with the same fixed template the app uses.
create or replace function public.get_exp_template_ro(_read_pw text)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare v_content text;
begin
    if not public._verify_mrm_read_pw(_read_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    select content into v_content from public.mrm_exp_template where id = 1;
    return v_content;  -- null when no template saved yet
end
$$;

grant execute on function public.list_mrm_library_ro(text) to anon, authenticated;
grant execute on function public.get_exp_template_ro(text)  to anon, authenticated;

-- ===========================================================================
-- Optional teardown (commented out by default)
-- ===========================================================================
-- drop function if exists public.get_exp_template_ro(text);
-- drop function if exists public.list_mrm_library_ro(text);
-- drop function if exists public._verify_mrm_read_pw(text);
-- drop function if exists public.set_mrm_read_password(text);
-- drop table if exists public.mrm_read_credentials;
-- drop function if exists public.delete_mrm_set(text, uuid);
-- drop function if exists public.list_mrm_sets(text);
-- drop function if exists public.upsert_mrm_set(text, uuid, text, text, text, text, jsonb);
-- drop table if exists public.mrm_set_items;
-- drop table if exists public.mrm_sets;
-- drop function if exists public.get_exp_template(text);
-- drop function if exists public.set_exp_template(text, text);
-- drop table if exists public.mrm_exp_template;
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
