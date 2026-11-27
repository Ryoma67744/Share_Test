-- Atomic folder-share publication for both fresh and existing deployments.
-- Apply after share_locks.sql. No existing tree, share, password or project is
-- changed by installing this migration. Re-applying it is safe.

create or replace function public._folder_share_index_shape(
    _node jsonb,
    _include_subfolders boolean
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
                children := children || jsonb_build_array(
                    jsonb_build_object('type', 'folder') || public._folder_share_index_shape(child, true));
            end if;
        elsif child->>'type' = 'project' then
            if jsonb_typeof(child->'slug') is distinct from 'string'
               or length(coalesce(child->>'slug', '')) = 0 then
                raise exception 'folder_share_unresolved' using errcode = '22023';
            end if;
            children := children || jsonb_build_array(jsonb_build_object('type', 'project', 'slug', child->>'slug'));
        else
            raise exception 'folder_share_invalid_index' using errcode = '22023';
        end if;
    end loop;
    return jsonb_build_object('name', _node->'name', 'children', children);
end
$$;
revoke all on function public._folder_share_index_shape(jsonb, boolean) from public, anon, authenticated;

create or replace function public.publish_folder_share_checked(
    _master_pw text,
    _folder_id text,
    _expected_tree jsonb,
    _tree jsonb,
    _index_doc jsonb,
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
    project_slugs text[];
    placement_count integer;
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

    -- The upsert handles a never-initialized workspace without a gap between
    -- checking absence and locking. All existing setters also lock this row.
    insert into public.workspace_tree(id, tree)
    values (1, '{"version":1,"children":[]}'::jsonb)
    on conflict (id) do nothing;
    select w.tree into current_tree from public.workspace_tree w where w.id = 1 for update;
    if current_tree is distinct from _expected_tree then
        -- This is a deterministic stale baseline, not a retryable SQL anomaly.
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
       or jsonb_typeof(folder->'shareIncludeSubfolders') is distinct from 'boolean' then
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
    expected_shape := public._folder_share_index_shape(folder, include_subfolders);
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
    if placement_count = 0 then
        raise exception 'folder_share_empty' using errcode = '22023';
    end if;

    -- Verify live membership even if paging raced with a project deletion.
    -- Keep those IDs alive until the share/tree commit. Sorting gives every
    -- caller the same lock order; ordinary title/metadata updates may proceed.
    perform p.slug from public.projects p where p.slug = any(project_slugs)
    order by p.slug for key share;
    get diagnostics locked_count = row_count;
    if locked_count <> cardinality(project_slugs) then
        raise exception 'folder_share_project_missing' using errcode = 'PT409';
    end if;

    -- Reuse the established slug/password/hash contract. Any failure below
    -- rolls back both this upsert and the workspace update in the same RPC.
    perform public.publish_folder_share(_master_pw, slug, folder->>'name', _index_doc, is_public, _password);
    update public.workspace_tree w set tree = _tree, updated_at = now() where w.id = 1;
    return jsonb_build_object('slug', slug, 'project_slugs', to_jsonb(project_slugs),
        'project_count', cardinality(project_slugs), 'placement_count', placement_count);
end
$$;
revoke all on function public.publish_folder_share_checked(text, text, jsonb, jsonb, jsonb, text) from public;
grant execute on function public.publish_folder_share_checked(text, text, jsonb, jsonb, jsonb, text) to anon, authenticated;
