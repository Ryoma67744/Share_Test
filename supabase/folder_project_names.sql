create or replace function public.get_folder_index(_slug text, _password text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    r public.folder_shares;
    label record;
begin
    select * into r from public.folder_shares where slug = _slug;
    if r.slug is null then
        raise exception 'not_found' using errcode = 'P0002';
    end if;
    if not r.is_public then
        if _password is null or r.password_hash is null
           or r.password_hash <> crypt(_password, r.password_hash) then
            raise exception 'invalid credentials' using errcode = '28P01';
        end if;
    end if;
    -- Only resolve members of this already-authorized folder. Keep the saved
    -- label for a link whose project no longer exists.
    for label in
        with recursive nodes(path, node) as (
            select array[]::text[], r.index_doc
            union all
            select nodes.path || array['children', (c.ord - 1)::text], c.node
              from nodes
              cross join lateral jsonb_array_elements(
                  case when (cardinality(nodes.path) = 0 or nodes.node->>'type' = 'folder')
                             and jsonb_typeof(nodes.node->'children') = 'array'
                       then nodes.node->'children' else '[]'::jsonb end
              ) with ordinality as c(node, ord)
        )
        select nodes.path || array['displayName'] as path,
               coalesce(nullif(p.display_name, ''), p.slug) as name
          from nodes
          join public.projects p on p.slug = nodes.node->>'slug'
         where cardinality(nodes.path) > 0 and nodes.node->>'type' = 'project'
           and nodes.node->'displayName' is distinct from
               to_jsonb(coalesce(nullif(p.display_name, ''), p.slug))
    loop
        r.index_doc := jsonb_set(r.index_doc, label.path, to_jsonb(label.name));
    end loop;
    return jsonb_build_object('name', r.name, 'index_doc', r.index_doc, 'is_public', r.is_public);
end
$$;
