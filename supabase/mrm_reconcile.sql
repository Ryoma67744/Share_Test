-- ===========================================================================
-- MRM reconciliation: register / ignore compounds that were MEASURED in
-- projects but are not yet in the MRM library.
-- ---------------------------------------------------------------------------
-- Feeds the mrm.html "実測棚卸し" (stock-take) modal: list every distinct
-- compound measured across all projects, tagged with whether it is already
-- registered, already ignored, or new — then let a master user bulk-register
-- the useful ones or mark the rest as "do not register" (ignored) so they
-- stop showing up next time.
--
-- Measured-compound data lives in sections.storage_paths -> 'msiSeries' ->
-- <key> -> 'compoundMeta' (name/base/precursor/product/ce/cv[/polarity]). Only
-- the name is reliably present; the rest are best-effort pre-fill.
--
-- Access: master password only (a master user already sees every project, so
-- exposing measured CE/CV here is fine — unlike the read-pw reverse lookup
-- which deliberately withholds CE/CV).
--
-- Depends on mrm_library.sql (mrm_compounds / mrm_transitions, _mrm_array_union)
-- and share_locks.sql (_verify_master_pw) being applied first.
-- Idempotent: safe to re-run (SQL Editor -> paste -> Run).
-- ===========================================================================

-- ---- Ignore list ("登録しない" decisions) ---------------------------------
create table if not exists public.mrm_ignored_compounds (
    name_norm  text primary key,        -- normalized name (lower, strip non-alnum)
    name       text not null,           -- a representative display name
    note       text,
    created_at timestamptz not null default now()
);
alter table public.mrm_ignored_compounds enable row level security;
revoke all on public.mrm_ignored_compounds from anon, authenticated;

-- ---- List every measured compound across all projects ---------------------
create or replace function public.list_measured_compounds(_master_pw text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare v_doc jsonb;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;

    with layers as (
        select
            p.id           as project_id,
            p.slug         as slug,
            p.display_name as display_name,
            e.key          as layer_key,
            coalesce(
                e.val->'compoundMeta'->>'name',
                e.val->'compoundMeta'->>'base',
                regexp_replace(e.key, '^MSI_', '')
            )              as cname,
            e.val->'compoundMeta' as meta
        from public.projects p
        join public.sections s on s.project_id = p.id
        cross join lateral jsonb_each(coalesce(s.storage_paths->'msiSeries', '{}'::jsonb)) as e(key, val)
        where e.key ~ '^MSI_'
    ),
    norm as (
        select *,
               regexp_replace(lower(coalesce(cname, '')), '[^a-z0-9]+', '', 'g') as name_norm
        from layers
        where cname is not null and cname <> ''
    ),
    agg as (
        select
            name_norm,
            (array_agg(cname order by cname))[1]                                                   as name,
            count(distinct project_id)                                                             as n_projects,
            (array_remove(array_agg(nullif(meta->>'precursor','') order by project_id), null))[1]  as precursor,
            (array_remove(array_agg(nullif(meta->>'product','')   order by project_id), null))[1]  as product,
            (array_remove(array_agg(nullif(meta->>'ce','')        order by project_id), null))[1]  as ce,
            (array_remove(array_agg(nullif(meta->>'cv','')        order by project_id), null))[1]  as cv,
            (array_remove(array_agg(
                coalesce(
                    nullif(meta->>'polarity', ''),
                    case
                        when lower(layer_key) ~ '(^|[_-])neg([_-]|$)' or lower(cname) ~ '(^|[_-])neg([_-]|$)' then '-'
                        when lower(layer_key) ~ '(^|[_-])pos([_-]|$)' or lower(cname) ~ '(^|[_-])pos([_-]|$)' then '+'
                        else null
                    end
                ) order by project_id), null))[1]                                                  as polarity,
            jsonb_agg(distinct jsonb_build_object('slug', slug, 'display_name', display_name))      as projects
        from norm
        group by name_norm
    )
    select coalesce(jsonb_agg(
        jsonb_build_object(
            'name',       a.name,
            'name_norm',  a.name_norm,
            'n_projects', a.n_projects,
            'projects',   a.projects,
            'precursor',  a.precursor,
            'product',    a.product,
            'ce',         a.ce,
            'cv',         a.cv,
            'polarity',   a.polarity,
            'status',     case
                when exists (select 1 from public.mrm_compounds c
                              where regexp_replace(lower(c.name), '[^a-z0-9]+', '', 'g') = a.name_norm)
                    then 'registered'
                when exists (select 1 from public.mrm_ignored_compounds ic where ic.name_norm = a.name_norm)
                    then 'ignored'
                else 'new'
            end
        ) order by a.name
    ), '[]'::jsonb) into v_doc
    from agg a;

    return v_doc;
end
$$;

grant execute on function public.list_measured_compounds(text) to anon, authenticated;

-- ---- Register one measured compound into the library ----------------------
-- Upserts the compound (by name, merging tags) and, when any transition value
-- is present, its transition. Does NOT append a usage row — the projects that
-- measured it are already shown by the 📁 測定PJ reverse lookup.
create or replace function public.register_measured_compound(
    _master_pw   text,
    _name        text,
    _tags        text[] default '{}',
    _polarity    text default null,
    _precursor   numeric default null,
    _product     numeric default null,
    _ce          numeric default null,
    _cv          numeric default null,
    _check_level text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare v_cid uuid; v_tid uuid;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    if _name is null or length(trim(_name)) = 0 then
        raise exception 'name required';
    end if;
    -- compound: create by name; merge tags; keep existing polarity/level unless empty.
    insert into public.mrm_compounds(name, tags, polarity, serial_no, check_level)
         values (trim(_name), coalesce(_tags, '{}'), _polarity,
                 (select coalesce(max(serial_no), 0) + 1 from public.mrm_compounds),
                 case when _check_level in ('std','lit','unchecked') then _check_level else 'unchecked' end)
    on conflict (name) do update
         set tags        = public._mrm_array_union(mrm_compounds.tags, excluded.tags),
             polarity    = coalesce(mrm_compounds.polarity, excluded.polarity),
             check_level = case when _check_level in ('std','lit','unchecked') then excluded.check_level else mrm_compounds.check_level end,
             updated_at  = now()
    returning id into v_cid;
    -- transition: only when there's at least one real value (avoid all-null rows).
    if _precursor is not null or _product is not null or _ce is not null or _cv is not null then
        insert into public.mrm_transitions(compound_id, precursor, product, ce, cv)
             values (v_cid, _precursor, _product, _ce, _cv)
        on conflict (compound_id, precursor, product, ce, cv) do update
             set role = coalesce(mrm_transitions.role, excluded.role)   -- no-op; enables RETURNING
        returning id into v_tid;
    end if;
    return jsonb_build_object('ok', true, 'compound_id', v_cid, 'transition_id', v_tid);
end
$$;

grant execute on function public.register_measured_compound(text, text, text[], text, numeric, numeric, numeric, numeric, text) to anon, authenticated;

-- ---- Ignore / un-ignore a measured compound -------------------------------
create or replace function public.ignore_measured_compound(_master_pw text, _name text)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare v_norm text;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    v_norm := regexp_replace(lower(coalesce(_name, '')), '[^a-z0-9]+', '', 'g');
    if v_norm = '' then return; end if;
    insert into public.mrm_ignored_compounds(name_norm, name)
         values (v_norm, coalesce(_name, ''))
    on conflict (name_norm) do nothing;
end
$$;

grant execute on function public.ignore_measured_compound(text, text) to anon, authenticated;

create or replace function public.unignore_measured_compound(_master_pw text, _name text)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    delete from public.mrm_ignored_compounds
     where name_norm = regexp_replace(lower(coalesce(_name, '')), '[^a-z0-9]+', '', 'g');
end
$$;

grant execute on function public.unignore_measured_compound(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Optional teardown (commented out by default)
-- ---------------------------------------------------------------------------
-- drop function if exists public.unignore_measured_compound(text, text);
-- drop function if exists public.ignore_measured_compound(text, text);
-- drop function if exists public.register_measured_compound(text, text, text[], text, numeric, numeric, numeric, numeric, text);
-- drop function if exists public.list_measured_compounds(text);
-- drop table if exists public.mrm_ignored_compounds;
