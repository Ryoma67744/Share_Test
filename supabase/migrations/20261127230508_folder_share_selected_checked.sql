-- Publish only the exact project set reviewed by the caller. Apply after
-- 20261127114758_folder_share_checked.sql; the strict earlier RPC is unchanged.
-- Installation changes no workspace, share, password or project. Re-applying
-- this migration is safe.

create or replace function public._folder_share_selected_index_shape(
    _node jsonb,
    _include_subfolders boolean,
    _selected_project_slugs text[]
) returns jsonb
language plpgsql immutable set search_path = pg_catalog, public
as $$
declare
    child jsonb;
    children jsonb := '[]'::jsonb;
begin
    if jsonb_typeof(_node) is distinct from 'object'
       or jsonb_typeof(_node->'name') is distinct from 'string'
       or jsonb_typeof(_node->'children') is distinct from 'array' then
        raise exception 'folder_share_invalid_index' using errcode = '22023';
    end if;
    for child in select value from jsonb_array_elements(_node->'children') loop
        if child->>'type' = 'folder' then
            if _include_subfolders then
                -- Empty folders and folder order remain part of the reviewed
                -- hierarchy, including folders whose project links are excluded.
                children := children || jsonb_build_array(jsonb_build_object('type', 'folder')
                    || public._folder_share_selected_index_shape(child, true, _selected_project_slugs));
            end if;
        elsif child->>'type' = 'project' then
            if jsonb_typeof(child->'slug') = 'string'
               and child->>'slug' = any(_selected_project_slugs) then
                children := children || jsonb_build_array(jsonb_build_object('type', 'project', 'slug', child->>'slug'));
            end if;
            -- An unselected, unpublished or unknown placement is excluded from
            -- this index only. The workspace JSON is never filtered here.
        else
            raise exception 'folder_share_invalid_index' using errcode = '22023';
        end if;
    end loop;
    return jsonb_build_object('name', _node->'name', 'children', children);
end
$$;
revoke all on function public._folder_share_selected_index_shape(jsonb, boolean, text[]) from public, anon, authenticated;

create or replace function public.publish_folder_share_selected_checked(
    _master_pw text,
    _folder_id text,
    _expected_tree jsonb,
    _tree jsonb,
    _index_doc jsonb,
    _selected_project_slugs text[],
    _password text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, extensions
as $$
declare
    current_tree jsonb;
    original_folder jsonb;
    folder jsonb;
    folder_path text[];
    folder_count integer;
    expected_shape jsonb;
    actual_shape jsonb;
    selected_slugs text[];
    project_slugs text[];
    placement_count integer;
    scope_placement_count integer;
    locked_count integer;
    slug text;
    is_public boolean;
    include_subfolders boolean;
begin
    if public._verify_master_pw(_master_pw) is not true then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    if _folder_id is null or length(_folder_id) = 0
       or jsonb_typeof(_expected_tree) is distinct from 'object'
       or jsonb_typeof(_expected_tree->'children') is distinct from 'array'
       or jsonb_typeof(_tree) is distinct from 'object'
       or jsonb_typeof(_tree->'children') is distinct from 'array' then
        raise exception 'folder_share_invalid_tree' using errcode = '22023';
    end if;
    if _selected_project_slugs is null or cardinality(_selected_project_slugs) = 0 then
        raise exception 'folder_share_empty' using errcode = '22023';
    end if;
    if array_ndims(_selected_project_slugs) is distinct from 1
       or exists(select 1 from unnest(_selected_project_slugs) as s(value)
                 where s.value is null or length(trim(s.value)) = 0 or s.value is distinct from trim(s.value)) then
        raise exception 'folder_share_invalid_selection' using errcode = '22023';
    end if;
    select array_agg(distinct s.value order by s.value) into selected_slugs
    from unnest(_selected_project_slugs) as s(value);
    if cardinality(selected_slugs) <> cardinality(_selected_project_slugs) then
        raise exception 'folder_share_invalid_selection' using errcode = '22023';
    end if;

    insert into public.workspace_tree(id, tree)
    values (1, '{"version":1,"children":[]}'::jsonb)
    on conflict (id) do nothing;
    select w.tree into current_tree from public.workspace_tree w where w.id = 1 for update;
    if current_tree is distinct from _expected_tree then
        raise exception 'folder_tree_changed' using errcode = 'PT409';
    end if;

    with recursive nodes(path, node) as (
        select array[]::text[], current_tree
        union all
        select nodes.path || array['children', (c.ord - 1)::text], c.node
        from nodes cross join lateral jsonb_array_elements(
            case when (cardinality(nodes.path) = 0 or nodes.node->>'type' = 'folder')
                      and jsonb_typeof(nodes.node->'children') = 'array'
                 then nodes.node->'children' else '[]'::jsonb end
        ) with ordinality as c(node, ord)
    )
    select (count(*) over ())::integer, node, path
    into folder_count, original_folder, folder_path
    from nodes where node->>'type' = 'folder' and node->>'id' = _folder_id limit 1;
    if folder_count is distinct from 1 then
        raise exception 'folder_share_invalid_tree' using errcode = '22023';
    end if;

    folder := _tree #> folder_path;
    if folder->>'type' is distinct from 'folder' or folder->>'id' is distinct from _folder_id
       or jsonb_set(current_tree, folder_path, folder) is distinct from _tree
       or jsonb_typeof(folder->'shareSlug') is distinct from 'string'
       or jsonb_typeof(folder->'shareIsPublic') is distinct from 'boolean'
       or jsonb_typeof(folder->'shareIncludeSubfolders') is distinct from 'boolean'
       or jsonb_typeof(folder->'shareRevision') is distinct from 'string'
       or folder->>'shareRevision' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'folder_share_invalid_tree' using errcode = '22023';
    end if;
    slug := trim(folder->>'shareSlug');
    if slug = '' or slug is distinct from folder->>'shareSlug' then
        raise exception 'folder_share_invalid_tree' using errcode = '22023';
    end if;
    if coalesce(original_folder->>'shareSlug', '') <> ''
       and original_folder->>'shareSlug' is distinct from slug then
        raise exception 'folder_share_slug_changed' using errcode = 'PT409';
    end if;
    is_public := (folder->>'shareIsPublic')::boolean;
    include_subfolders := (folder->>'shareIncludeSubfolders')::boolean;
    expected_shape := public._folder_share_selected_index_shape(folder, include_subfolders, selected_slugs);
    actual_shape := public._folder_share_index_shape(_index_doc, true);
    if expected_shape is distinct from actual_shape then
        raise exception 'folder_share_invalid_index' using errcode = '22023';
    end if;

    with recursive nodes(node) as (
        select actual_shape
        union all
        select c.node from nodes cross join lateral jsonb_array_elements(
            case when jsonb_typeof(nodes.node->'children') = 'array'
                 then nodes.node->'children' else '[]'::jsonb end
        ) as c(node)
    )
    select count(*)::integer, array_agg(distinct node->>'slug' order by node->>'slug')
    into placement_count, project_slugs from nodes where node->>'type' = 'project';
    -- Neither shrink a reviewed set after deletion nor add a newly resolved
    -- project which the caller did not select.
    if project_slugs is distinct from selected_slugs then
        raise exception 'folder_share_selection_changed' using errcode = 'PT409';
    end if;

    with recursive nodes(node, depth) as (
        select folder, 0
        union all
        select c.node, nodes.depth + 1 from nodes cross join lateral jsonb_array_elements(
            case when (nodes.depth = 0 or include_subfolders) and nodes.node->>'type' = 'folder'
                      and jsonb_typeof(nodes.node->'children') = 'array'
                 then nodes.node->'children' else '[]'::jsonb end
        ) as c(node)
    )
    select count(*)::integer into scope_placement_count from nodes where node->>'type' = 'project';

    -- Key-share locks prevent target deletion/key changes until the atomic
    -- publication commits. Keep the same deterministic lock order as v1.
    perform p.slug from public.projects p where p.slug = any(project_slugs)
    order by p.slug for key share;
    get diagnostics locked_count = row_count;
    if locked_count <> cardinality(project_slugs) then
        raise exception 'folder_share_project_missing' using errcode = 'PT409';
    end if;

    -- Selection/password-only updates can otherwise leave the tree identical,
    -- making a second stale editor pass the tree CAS. Every checked publication
    -- consumes a fresh client UUID in the tree, including unchanged selections.
    if lower(folder->>'shareRevision') is not distinct from lower(original_folder->>'shareRevision') then
        raise exception 'folder_tree_changed' using errcode = 'PT409';
    end if;

    perform public.publish_folder_share(_master_pw, slug, folder->>'name', _index_doc, is_public, _password);
    -- Keep the reviewed candidate verbatim, including excluded old IDs. A
    -- caller may include an explicitly reviewed repair/remove inside this
    -- folder; this RPC never infers those edits from the selected slug set.
    update public.workspace_tree w set tree = _tree, updated_at = now() where w.id = 1;
    return jsonb_build_object('slug', slug, 'project_slugs', to_jsonb(project_slugs),
        'project_count', cardinality(project_slugs), 'placement_count', placement_count,
        'excluded_placement_count', scope_placement_count - placement_count);
end
$$;
revoke all on function public.publish_folder_share_selected_checked(text, text, jsonb, jsonb, jsonb, text[], text) from public;
grant execute on function public.publish_folder_share_selected_checked(text, text, jsonb, jsonb, jsonb, text[], text) to anon, authenticated;
