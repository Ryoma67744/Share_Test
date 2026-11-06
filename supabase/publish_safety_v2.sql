-- Publish protocol v2. Apply AFTER schema.sql and share_locks.sql.
-- Deployment is fail-closed: stop legacy writers, retain every existing object.
-- Do not reapply an older share_locks.sql after this migration.
-- Deterministic revision conflicts use PT409 (HTTP 409), never 40001:
-- older PostgREST versions retry serialization failures inside one RPC.
begin;
alter table public.projects add column if not exists publish_revision bigint not null default 0;
alter table public.publish_sessions add column if not exists protocol integer not null default 1;
alter table public.publish_sessions add column if not exists request_id uuid;
alter table public.publish_sessions add column if not exists base_revision bigint;
alter table public.publish_sessions add column if not exists create_only boolean;
alter table public.publish_sessions add column if not exists object_prefix text;
create table if not exists public.publish_receipts (
 slug text not null, request_id uuid not null, project_id uuid not null references public.projects(id) on delete cascade,
 request_hash text not null, server_revision bigint not null, committed_at timestamptz not null default now(),
 receipt jsonb not null, primary key(slug,request_id)
);
alter table public.publish_receipts enable row level security;
revoke all on public.publish_receipts from public,anon,authenticated;
-- Old tickets cannot authorize writes, including tickets issued before deployment.
delete from public.publish_sessions where protocol <> 2;

create or replace function public._publish_doc_write_v2(
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
    v_client_ids text[];
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

    -- projects.meta stores the master's project-level view settings so recipients
    -- open the share the way the master left it. It used to be hardcoded to
    -- `memo` only, which silently DROPPED every other key the client sent —
    -- `colormap` was published by the viewer (and read back on hydrate) but never
    -- survived the round trip, so recipients on another browser always got the
    -- default colour scheme. Pass `_meta` through instead of enumerating keys, so
    -- a new view setting round-trips without another SQL migration (the viewer's
    -- share-hydrate already carries project meta forward wholesale for the same
    -- reason). `anatomyPalette` is excluded because projects.anatomy_palette is
    -- its authoritative home — keeping a copy in meta would be two sources of
    -- truth. jsonb_strip_nulls drops keys the client sent as null, so "master
    -- has no value for this" leaves whatever is already stored alone rather than
    -- overwriting it with null.
    insert into public.projects(slug, display_name, anatomy_palette, meta, is_public)
        values (
            _slug,
            coalesce(_display_name, _slug),
            coalesce(_meta->'anatomyPalette', '{}'::jsonb),
            jsonb_strip_nulls(coalesce(_meta, '{}'::jsonb) - 'anatomyPalette'),
            coalesce(_is_public, false)
        )
        on conflict (slug) do update
        set display_name    = excluded.display_name,
            anatomy_palette = excluded.anatomy_palette,
            -- Merge (not replace): `||` is a shallow right-wins union, so keys the
            -- master just sent take effect while keys absent from this publish keep
            -- their stored value. `memo` is a single object key, so it is replaced
            -- wholesale exactly as the previous jsonb_set did.
            meta            = coalesce(public.projects.meta, '{}'::jsonb) || excluded.meta,
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

    -- Merge sections by client_id (do NOT delete-all). Preserving each
    -- section's UUID keeps its ROIs — including collaborator ('viewer') ROIs
    -- added on the shared copy — from being cascade-deleted on every master
    -- auto-publish (schema.sql rois.section_id ON DELETE CASCADE).
    v_client_ids := (
        select array_agg(s->>'id')
          from jsonb_array_elements(coalesce(_sections, '[]'::jsonb)) s
         where s->>'id' is not null
    );
    -- Remove only sections the master no longer has (their client_id is absent
    -- from the incoming doc). If the doc carries no sections, leave existing
    -- ones untouched (degenerate case — never wipe everything).
    if v_client_ids is not null and array_length(v_client_ids, 1) is not null then
        delete from public.sections
            where project_id = v_pid
              and (meta->>'client_id' is null
                   or not (meta->>'client_id' = any(v_client_ids)));
    end if;
    for sec in select * from jsonb_array_elements(coalesce(_sections, '[]'::jsonb))
    loop
        v_sec_id := null;
        select id into v_sec_id from public.sections
            where project_id = v_pid
              and meta->>'client_id' = (sec->>'id')
            limit 1;
        if v_sec_id is null then
            insert into public.sections(project_id, ordinal, display_name, meta, storage_paths)
                values (
                    v_pid,
                    coalesce((sec->>'ordinal')::int, 0),
                    coalesce(sec->>'displayName', 'Section'),
                    jsonb_set(coalesce(sec->'meta', '{}'::jsonb), '{client_id}', to_jsonb(sec->>'id')),
                    coalesce(sec->'storagePaths', '{}'::jsonb)
                );
        else
            update public.sections set
                ordinal       = coalesce((sec->>'ordinal')::int, 0),
                display_name  = coalesce(sec->>'displayName', 'Section'),
                meta          = jsonb_set(coalesce(sec->'meta', '{}'::jsonb), '{client_id}', to_jsonb(sec->>'id')),
                storage_paths = coalesce(sec->'storagePaths', '{}'::jsonb)
             where id = v_sec_id;
        end if;
    end loop;

    -- Replace only master-authored ROIs; preserve collaborator ('viewer')
    -- ROIs added on the shared copy so an auto-publish doesn't wipe them.
    -- (Master's own local deletions still propagate: a removed master ROI is
    -- simply not re-inserted below.)
    delete from public.rois where project_id = v_pid and coalesce(created_by, '') <> 'viewer';
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
revoke all on function public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean) from public,anon,authenticated;

create or replace function public.upsert_project_doc(
 _master_pw text,_slug text,_display_name text,_meta jsonb,_viewer_pw text,
 _admin_pw text default null,_sections jsonb default '[]',_rois jsonb default '[]',_is_public boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
begin raise exception 'publish_protocol_upgrade_required: reload the current application' using errcode='0A000'; end $$;
-- Remove any ancient overloads as well: PostgREST must never find a fallback.
drop function if exists public.upsert_project_doc(text,text,jsonb,text,text,jsonb,jsonb);
drop function if exists public.upsert_project_doc(text,text,text,jsonb,text,text,jsonb,jsonb);
create or replace function public.request_publish_session(_master_pw text,_slug text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin raise exception 'publish_protocol_upgrade_required: reload the current application' using errcode='0A000'; end $$;

create or replace function public.get_publish_state_v2(_master_pw text,_slug text,_request_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.projects%rowtype; r jsonb;
begin
 if not public._verify_master_pw(_master_pw) then raise exception 'unauthorized' using errcode='28000'; end if;
 select * into p from public.projects where slug=_slug;
 if _request_id is not null then select receipt into r from public.publish_receipts where slug=_slug and request_id=_request_id; end if;
 return jsonb_build_object('protocol',2,'exists',p.id is not null,'server_revision',p.publish_revision,'receipt',r);
end $$;

create or replace function public.request_publish_session_v2(
 _master_pw text,_slug text,_request_id uuid,_expected_revision bigint,_create_only boolean)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare p public.projects%rowtype; r jsonb; t text; expires timestamptz;
begin
 if not public._verify_master_pw(_master_pw) then raise exception 'unauthorized' using errcode='28000'; end if;
 if _slug is null or _slug !~ '^[A-Za-z0-9_-]+$' or _request_id is null then raise exception 'invalid_publish_request' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('publish-v2:'||_slug,0));
 select receipt into r from public.publish_receipts where slug=_slug and request_id=_request_id;
 if r is not null then return jsonb_build_object('protocol',2,'committed',true,'receipt',r); end if;
 select * into p from public.projects where slug=_slug for update;
 if _expected_revision is null or _expected_revision<0 then raise exception 'publish_baseline_unknown' using errcode='22023'; end if;
 if coalesce(_create_only,false) then
   if p.id is not null or _expected_revision<>0 then raise exception 'publish_conflict: slug already exists' using errcode='PT409'; end if;
 elsif p.id is null or p.publish_revision<>_expected_revision then
   raise exception 'publish_conflict: reload and compare the shared copy' using errcode='PT409';
 end if;
 t:=encode(gen_random_bytes(24),'hex'); expires:=now()+interval '1 hour';
 insert into public.publish_sessions(token,slug,expires_at,protocol,request_id,base_revision,create_only,object_prefix)
 values(t,_slug,expires,2,_request_id,_expected_revision,_create_only,_slug||'/publish-v2/'||_request_id::text||'/');
 return jsonb_build_object('protocol',2,'token',t,'expires_at',expires,'object_prefix',_slug||'/publish-v2/'||_request_id::text||'/');
end $$;

create or replace function public._publish_session_valid_for_path(p_token text,p_path text)
returns boolean language sql security definer set search_path=public as $$
 select exists(select 1 from public.publish_sessions ps where ps.token=p_token and ps.protocol=2
 and ps.expires_at>now() and ps.object_prefix is not null
 and left(p_path,length(ps.object_prefix))=ps.object_prefix
 and length(p_path)>length(ps.object_prefix) and p_path !~ '(^|/)\.\.(/|$)'
 and not exists(select 1 from public.publish_receipts pr where pr.slug=ps.slug and pr.request_id=ps.request_id));
$$;
revoke all on function public._publish_session_valid_for_path(text,text) from public;
grant execute on function public._publish_session_valid_for_path(text,text) to anon,authenticated;

-- Restrictive policies close permissive policies left by earlier deployments.
-- Existing objects are readable; neither old publish nor shared-image sessions
-- can UPDATE/DELETE their bytes. Cleanup of unreachable objects is administrative.
drop policy if exists "atlases publish v2 insert guard" on storage.objects;
create policy "atlases publish v2 insert guard" on storage.objects as restrictive for insert to anon,authenticated
 with check(bucket_id<>'atlases' or public._publish_session_valid_for_path(
 nullif(current_setting('request.headers',true),'')::jsonb->>'x-publish-token',name)
 or public._share_session_valid_for_shared_path(nullif(current_setting('request.headers',true),'')::jsonb->>'x-share-token',name));
drop policy if exists "atlases immutable update guard" on storage.objects;
create policy "atlases immutable update guard" on storage.objects as restrictive for update to anon,authenticated
 using(bucket_id<>'atlases') with check(bucket_id<>'atlases');
drop policy if exists "atlases immutable delete guard" on storage.objects;
create policy "atlases immutable delete guard" on storage.objects as restrictive for delete to anon,authenticated
 using(bucket_id<>'atlases');

create or replace function public.publish_project_doc_v2(
 _master_pw text,_publish_token text,_request_id uuid,_expected_revision bigint,_create_only boolean,
 _slug text,_display_name text,_meta jsonb,_viewer_pw text,_admin_pw text default null,
 _sections jsonb default '[]',_rois jsonb default '[]',_is_public boolean default false)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare p public.projects%rowtype; ticket public.publish_sessions%rowtype; old public.publish_receipts%rowtype;
 h text; result jsonb; r jsonb; rev bigint; t timestamptz; objpath text; sec jsonb;
begin
 if not public._verify_master_pw(_master_pw) then raise exception 'unauthorized' using errcode='28000'; end if;
 if _slug is null or _slug !~ '^[A-Za-z0-9_-]+$' or _request_id is null or _expected_revision is null or _expected_revision<0 or _create_only is null then raise exception 'invalid_publish_request' using errcode='22023'; end if;
 if jsonb_typeof(_sections) is distinct from 'array' or jsonb_typeof(_rois) is distinct from 'array' or jsonb_typeof(_meta) is distinct from 'object' then raise exception 'invalid_publish_document' using errcode='22023'; end if;
 h:=encode(digest(jsonb_build_array(_slug,_expected_revision,_create_only,_display_name,_meta,_viewer_pw,_admin_pw,_sections,_rois,_is_public)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended('publish-v2:'||_slug,0));
 select * into old from public.publish_receipts where slug=_slug and request_id=_request_id;
 if found then
   if old.request_hash<>h then raise exception 'publish_request_reused_with_different_document' using errcode='22023'; end if;
   return old.receipt;
 end if;
 select * into ticket from public.publish_sessions where token=_publish_token and slug=_slug and protocol=2
 and request_id=_request_id and expires_at>now() and base_revision=_expected_revision and create_only=_create_only;
 if not found then raise exception 'publish_session_expired_or_invalid' using errcode='28000'; end if;
 select * into p from public.projects where slug=_slug for update;
 if coalesce(_create_only,false) then
   if p.id is not null or _expected_revision<>0 then raise exception 'publish_conflict: slug already exists' using errcode='PT409'; end if;
 elsif p.id is null or p.publish_revision<>_expected_revision then
   raise exception 'publish_conflict: reload and compare the shared copy' using errcode='PT409';
 end if;
 -- Validate the complete document before any project/section/ROI write.
 if exists(select 1 from jsonb_array_elements(_sections) s where coalesce(s->>'id','')='' or jsonb_typeof(s->'storagePaths') is distinct from 'object' or exists(select 1 from jsonb_each(s->'storagePaths') field where field.key in ('images','msiSeries','msiFiles') and jsonb_typeof(field.value) is distinct from 'object'))
 or (select count(*) from jsonb_array_elements(_sections))<>(select count(distinct s->>'id') from jsonb_array_elements(_sections) s)
 then raise exception 'invalid_section_identity' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(_rois) r0 where not exists(select 1 from jsonb_array_elements(_sections) s where s->>'id'=r0->>'sectionId')) then raise exception 'roi_section_missing' using errcode='22023'; end if;
 if _meta ? 'roiMedia' and (jsonb_typeof(_meta->'roiMedia') is distinct from 'object' or jsonb_typeof(_meta->'roiMedia'->'items') is distinct from 'array') then raise exception 'invalid_roi_media' using errcode='22023'; end if;
 for objpath in
   select v->>'path' from jsonb_array_elements(_sections) s
     cross join lateral (select value as v from jsonb_each(coalesce(s->'storagePaths'->'images','{}')) union all select value from jsonb_each(coalesce(s->'storagePaths'->'msiSeries','{}')) union all select value from jsonb_each(coalesce(s->'storagePaths'->'msiFiles','{}'))) item
   union all select item->>'storagePath' from jsonb_array_elements(coalesce(_meta->'roiMedia'->'items','[]')) item
 loop
   if objpath is null or left(objpath,length(_slug)+1)<>_slug||'/'
     or not exists(select 1 from storage.objects where bucket_id='atlases' and name=objpath)
   then raise exception 'publish_source_missing_or_wrong_project: %',coalesce(objpath,'(missing path)') using errcode='22023'; end if;
 end loop;
 result:=public._publish_doc_write_v2(_master_pw,_slug,_display_name,_meta,_viewer_pw,_admin_pw,_sections,_rois,_is_public);
 if result->>'ok'<>'true' then raise exception 'publish_rejected: %',result->>'reason' using errcode='22023'; end if;
 -- Empty projects are valid and explicitly remove old sections too.
 if jsonb_array_length(_sections)=0 then delete from public.sections where project_id=(result->>'project_id')::uuid; end if;
 update public.projects set publish_revision=publish_revision+1,updated_at=now() where id=(result->>'project_id')::uuid returning publish_revision,updated_at into rev,t;
 r:=jsonb_build_object('ok',true,'protocol',2,'project_id',result->>'project_id','slug',_slug,'request_id',_request_id,'server_revision',rev,'committed_at',t);
 insert into public.publish_receipts(slug,request_id,project_id,request_hash,server_revision,committed_at,receipt)
 values(_slug,_request_id,(result->>'project_id')::uuid,h,rev,t,r);
 return r;
end $$;
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
    'publish_revision', p.publish_revision, 'updated_at', p.updated_at, 'is_public', p.is_public,
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
revoke all on function public.get_publish_state_v2(text,text,uuid) from public;
revoke all on function public.request_publish_session_v2(text,text,uuid,bigint,boolean) from public;
revoke all on function public.publish_project_doc_v2(text,text,uuid,bigint,boolean,text,text,jsonb,text,text,jsonb,jsonb,boolean) from public;
grant execute on function public.get_publish_state_v2(text,text,uuid), public.request_publish_session_v2(text,text,uuid,bigint,boolean),
 public.publish_project_doc_v2(text,text,uuid,bigint,boolean,text,text,jsonb,text,text,jsonb,jsonb,boolean) to anon,authenticated;
commit;
