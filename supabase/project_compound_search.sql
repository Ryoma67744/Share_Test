-- ===========================================================================
-- Reverse lookup: molecule/compound name -> projects that measured it.
-- ---------------------------------------------------------------------------
-- Powers the AI connector question "which projects measured Acetylcholine?".
--
-- The measured compound list is ALREADY persisted per section, on every
-- publish, inside `sections.storage_paths -> 'msiSeries' -> <key> ->
-- 'compoundMeta' -> 'name'` (see viewer _publishCore / upsert_project_doc).
-- This function just makes that data queryable in the reverse direction,
-- across all projects, in one call — no new table, always current.
--
-- Access: gated by the read-only MRM password (_verify_mrm_read_pw, the same
-- secret the connector already holds), NOT the master password. SECURITY
-- DEFINER so it can read `sections` across RLS. It exposes ONLY slug /
-- display_name / is_public / the matched compound names — never CE/CV, raw
-- data, ROIs, or images.
--
-- Idempotent: safe to re-run (SQL Editor -> paste -> Run). Requires
-- mrm_library.sql (for _verify_mrm_read_pw) to have been applied first.
-- ===========================================================================

create or replace function public.search_projects_by_compound(
    _read_pw         text,
    _query           text,
    _include_private boolean default true
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_doc jsonb;
    v_q   text;
begin
    if not public._verify_mrm_read_pw(_read_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;

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

grant execute on function public.search_projects_by_compound(text, text, boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Optional teardown (commented out by default)
-- ---------------------------------------------------------------------------
-- drop function if exists public.search_projects_by_compound(text, text, boolean);
