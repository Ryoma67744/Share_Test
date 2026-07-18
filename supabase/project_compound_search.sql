-- ===========================================================================
-- Reverse lookup: molecule/compound name -> projects that measured it.
-- ---------------------------------------------------------------------------
-- Powers the AI connector question "which projects measured Acetylcholine?"
-- AND the MRM管理 UI "📁 測定PJ" popover (which projects used this MRM?).
--
-- The measured compound list is ALREADY persisted per section, on every
-- publish, inside `sections.storage_paths -> 'msiSeries' -> <key> ->
-- 'compoundMeta' -> 'name'` (see viewer _publishCore / upsert_project_doc).
-- This function just makes that data queryable in the reverse direction,
-- across all projects, in one call — no new table, always current.
--
-- Two public entry points share ONE query body (_..._core):
--   * search_projects_by_compound(_read_pw, ...)   — read-only MRM password,
--     used by the connector (which holds that secret).
--   * search_projects_by_compound_master(_master_pw, ...) — master password,
--     used by mrm.html (the browser holds only ANON_KEY + the master pw the
--     user types; it does NOT have the read-only secret). A master user can
--     already see every project, so returning private ones here is fine.
-- Both expose ONLY slug / display_name / is_public / matched compound names —
-- never CE/CV, raw data, ROIs, or images. SECURITY DEFINER so they can read
-- `sections` across RLS.
--
-- Idempotent: safe to re-run (SQL Editor -> paste -> Run). Requires
-- mrm_library.sql (for _verify_mrm_read_pw / _verify_master_pw) applied first.
-- ===========================================================================

-- ---- Shared query body (no auth; callers gate access) ---------------------
create or replace function public._search_projects_by_compound_core(
    _query           text,
    _include_private boolean default true
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_doc jsonb;
    v_q   text;
begin
    -- Normalise the query: lowercase, drop every non-alphanumeric char. This
    -- absorbs case, separators (-, _, space) and polarity drift (POS_/_NEG),
    -- while keeping distinct compounds distinct (e.g. pgd2 != pge2).
    v_q := regexp_replace(lower(coalesce(_query, '')), '[^a-z0-9]+', '', 'g');
    if v_q = '' then
        return '[]'::jsonb;
    end if;

    select coalesce(jsonb_agg(obj order by (obj->>'display_name')), '[]'::jsonb) into v_doc
    from (
        select jsonb_build_object(
                   'slug',         p.slug,
                   'display_name', p.display_name,
                   'is_public',    p.is_public,
                   'compounds',    jsonb_agg(distinct m.cname order by m.cname)
               ) as obj
          from public.projects p
          join public.sections s on s.project_id = p.id
          cross join lateral (
              -- one row per MSI layer; prefer the stored compound name.
              select coalesce(
                         e.val->'compoundMeta'->>'name',
                         e.val->'compoundMeta'->>'base',
                         regexp_replace(e.key, '^MSI_', '')
                     ) as cname
                from jsonb_each(coalesce(s.storage_paths->'msiSeries', '{}'::jsonb)) as e(key, val)
               where e.key ~ '^MSI_'
          ) m
         where (_include_private or p.is_public)
           and m.cname is not null
           and case
                   when length(v_q) <= 2
                       -- very short queries: require an exact normalised match
                       -- so "DA" doesn't substring-match unrelated names.
                       then regexp_replace(lower(m.cname), '[^a-z0-9]+', '', 'g') = v_q
                       else regexp_replace(lower(m.cname), '[^a-z0-9]+', '', 'g') like '%' || v_q || '%'
               end
         group by p.id, p.slug, p.display_name, p.is_public
    ) t;

    return v_doc;
end
$$;
-- Internal only: never callable directly by API roles; reached solely from the
-- two password-gated wrappers below.
revoke all on function public._search_projects_by_compound_core(text, boolean) from public, anon, authenticated;

-- ---- Public entry point 1: read-only MRM password (connector) -------------
create or replace function public.search_projects_by_compound(
    _read_pw         text,
    _query           text,
    _include_private boolean default true
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if not public._verify_mrm_read_pw(_read_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    return public._search_projects_by_compound_core(_query, _include_private);
end
$$;

grant execute on function public.search_projects_by_compound(text, text, boolean) to anon, authenticated;

-- ---- Public entry point 2: master password (mrm.html browser UI) ----------
create or replace function public.search_projects_by_compound_master(
    _master_pw       text,
    _query           text,
    _include_private boolean default true
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    return public._search_projects_by_compound_core(_query, _include_private);
end
$$;

grant execute on function public.search_projects_by_compound_master(text, text, boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Optional teardown (commented out by default)
-- ---------------------------------------------------------------------------
-- drop function if exists public.search_projects_by_compound_master(text, text, boolean);
-- drop function if exists public.search_projects_by_compound(text, text, boolean);
-- drop function if exists public._search_projects_by_compound_core(text, boolean);
