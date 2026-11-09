-- Shared MSI coordinate groups. Apply after publish_safety_v2.sql.
-- Existing rows and legacy ROI envelopes are retained unchanged.
-- Re-running this migration is safe; do not reapply older base SQL afterward.
begin;

create or replace function public.spatial_group_capabilities_v1()
returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('version',1,'roiGeometry','msi-group-v1',
   'alignmentScope','group','protectDowngrade',true,'bulkRoi',true)
$$;
revoke all on function public.spatial_group_capabilities_v1() from public;
grant execute on function public.spatial_group_capabilities_v1() to anon,authenticated;

create or replace function public._spatial_group_v1(_meta jsonb,_id text)
returns jsonb language sql immutable set search_path=public as $$
 select g from jsonb_array_elements(case when jsonb_typeof(_meta#>'{spatialGroups,groups}')='array'
   then _meta#>'{spatialGroups,groups}' else '[]'::jsonb end) g
 where _meta#>>'{spatialGroups,version}'='1' and g->>'id'=_id limit 1
$$;

create or replace function public._assert_spatial_registry_v1(_meta jsonb)
returns void language plpgsql immutable set search_path=public as $$
declare registry jsonb:=_meta->'spatialGroups'; g jsonb; seen text[]:='{}';
begin
 if registry is null then return; end if;
 if jsonb_typeof(registry) is distinct from 'object' or registry->>'version' is distinct from '1'
   or jsonb_typeof(registry->'groups') is distinct from 'array' then
   raise exception 'invalid_spatial_groups' using errcode='22023';
 end if;
 for g in select * from jsonb_array_elements(registry->'groups') loop
   if jsonb_typeof(g) is distinct from 'object' or coalesce(g->>'id','')='' or coalesce(g->>'frameKey','')=''
     or g->>'frameVersion' is distinct from '1' or jsonb_typeof(g->'members') is distinct from 'array'
     or (g->>'id')=any(seen) then
     raise exception 'invalid_spatial_group' using errcode='22023';
   end if;
   seen:=array_append(seen,g->>'id');
 end loop;
end $$;

-- Coordinate frames are immutable. Adding a measurement updates membership,
-- not the meaning of already-saved HE transforms or ROI vertices.
create or replace function public._assert_spatial_registry_preserved_v1(_old jsonb,_new jsonb)
returns void language plpgsql immutable set search_path=public as $$
declare previous jsonb; current_group jsonb;
begin
 perform public._assert_spatial_registry_v1(_new);
 if _old->'spatialGroups' is null then return; end if;
 for previous in select * from jsonb_array_elements(coalesce(_old#>'{spatialGroups,groups}','[]'::jsonb)) loop
   current_group:=public._spatial_group_v1(_new,previous->>'id');
   if current_group is null or current_group->>'frameKey' is distinct from previous->>'frameKey'
     or current_group->>'frameVersion' is distinct from previous->>'frameVersion' then
     raise exception 'spatial_contract_downgrade: reload the current application' using errcode='0A000';
   end if;
 end loop;
end $$;

create or replace function public._assert_spatial_roi_v1(_payload jsonb,_section_id uuid,_section_meta jsonb)
returns void language plpgsql immutable set search_path=public as $$
declare geometry jsonb:=_payload->'geometry'; g jsonb;
begin
 if geometry->>'version' is distinct from 'msi-group-v1' then return; end if;
 g:=public._spatial_group_v1(_section_meta,geometry->>'groupId');
 if _payload->>'version' is distinct from 'msi-roi-polygon-v1'
   or jsonb_typeof(_payload->'vertices') is distinct from 'array'
   or geometry->>'scope' is distinct from 'group'
   or g is null or geometry->>'frameKey' is distinct from g->>'frameKey'
   or geometry->>'frameVersion' is distinct from g->>'frameVersion'
   or not (coalesce(geometry->>'sectionId','') in
     (coalesce(_section_meta->>'client_id',''),_section_id::text)) then
   raise exception 'invalid_spatial_roi: coordinate group or section changed' using errcode='22023';
 end if;
end $$;

create or replace function public._assert_spatial_alignment_v1(_payload jsonb,_meta jsonb)
returns void language plpgsql immutable set search_path=public as $$
declare layer record; item record; g jsonb;
begin
 if jsonb_typeof(_payload->'alignment') is distinct from 'object' then return; end if;
 for layer in select * from jsonb_each(_payload->'alignment') loop
   if layer.value->'byGroup' is null then continue; end if;
   if jsonb_typeof(layer.value->'byGroup') is distinct from 'object' then
     raise exception 'invalid_spatial_alignment' using errcode='22023';
   end if;
   for item in select * from jsonb_each(layer.value->'byGroup') loop
     g:=public._spatial_group_v1(_meta,item.key);
     if g is null or item.value->>'groupId' is distinct from item.key
       or item.value->>'scope' is distinct from 'group'
       or item.value->>'groupFrameKey' is distinct from g->>'frameKey'
       or item.value->>'groupFrameVersion' is distinct from g->>'frameVersion' then
       raise exception 'invalid_spatial_alignment: coordinate group changed' using errcode='22023';
     end if;
   end loop;
 end loop;
end $$;

create or replace function public._assert_spatial_alignment_preserved_v1(_old jsonb,_new jsonb)
returns void language plpgsql immutable set search_path=public as $$
declare layer record; item record;
begin
 if jsonb_typeof(_old->'alignment') is distinct from 'object' then return; end if;
 for layer in select * from jsonb_each(_old->'alignment') loop
   if jsonb_typeof(layer.value->'byGroup') is distinct from 'object' then continue; end if;
   for item in select * from jsonb_each(layer.value->'byGroup') loop
     if _new#>array['alignment',layer.key,'byGroup',item.key] is null then
       raise exception 'spatial_alignment_downgrade: reload the current application' using errcode='0A000';
     end if;
   end loop;
 end loop;
end $$;

create or replace function public._guard_spatial_section_v1()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform public._assert_spatial_registry_v1(new.meta);
 if tg_op='UPDATE' then
   perform public._assert_spatial_registry_preserved_v1(old.meta,new.meta);
   perform public._assert_spatial_alignment_preserved_v1(old.meta,new.meta);
 end if;
 perform public._assert_spatial_alignment_v1(new.meta,new.meta);
 return new;
end $$;
drop trigger if exists guard_spatial_section_v1 on public.sections;
create trigger guard_spatial_section_v1 before insert or update of meta on public.sections
 for each row execute function public._guard_spatial_section_v1();

create or replace function public._guard_spatial_roi_v1()
returns trigger language plpgsql security definer set search_path=public as $$
declare section_meta jsonb;
begin
 if tg_op='UPDATE' and old.poly_msi#>>'{geometry,version}'='msi-group-v1'
   and new.poly_msi#>>'{geometry,version}' is distinct from 'msi-group-v1' then
   raise exception 'spatial_roi_downgrade: create a separate individual ROI' using errcode='0A000';
 end if;
 select meta into section_meta from public.sections where id=new.section_id and project_id=new.project_id;
 perform public._assert_spatial_roi_v1(new.poly_msi,new.section_id,section_meta);
 return new;
end $$;
drop trigger if exists guard_spatial_roi_v1 on public.rois;
create trigger guard_spatial_roi_v1 before insert or update of poly_msi,section_id on public.rois
 for each row execute function public._guard_spatial_roi_v1();

-- Convert a reviewed set in one transaction. Existing update_roi supplies
-- project authorization and optimistic versions; any failure rolls all back.
create or replace function public.convert_rois_to_spatial_group_v1(p_token text,p_updates jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare item jsonb; updated public.rois; ids text[]:='{}'; result jsonb:='[]'::jsonb;
begin
 perform public._resolve_token(p_token);
 if jsonb_typeof(p_updates) is distinct from 'array' then
   raise exception 'invalid_spatial_roi_updates' using errcode='22023';
 end if;
 if jsonb_array_length(p_updates)<1 or jsonb_array_length(p_updates)>1000 then
   raise exception 'invalid_spatial_roi_update_count' using errcode='22023';
 end if;
 for item in select * from jsonb_array_elements(p_updates) loop
   if coalesce(item->>'id','')='' or coalesce(item->>'expectedVersion','') !~ '^[1-9][0-9]*$'
     or item#>>'{poly_msi,geometry,version}' is distinct from 'msi-group-v1'
     or (item->>'id')=any(ids) then
     raise exception 'invalid_spatial_roi_update' using errcode='22023';
   end if;
   ids:=array_append(ids,item->>'id');
   updated:=public.update_roi(p_token,(item->>'id')::uuid,(item->>'expectedVersion')::integer,
     null,item->'poly_msi',null);
   result:=result||jsonb_build_array(jsonb_build_object('id',updated.id,'version',updated.version));
 end loop;
 return result;
end $$;
revoke all on function public.convert_rois_to_spatial_group_v1(text,jsonb) from public;
grant execute on function public.convert_rois_to_spatial_group_v1(text,jsonb) to anon,authenticated;

create or replace function public._guard_spatial_share_alignment_v1()
returns trigger language plpgsql security definer set search_path=public as $$
declare section_meta jsonb;
begin
 select meta into section_meta from public.sections where id=new.section_id and project_id=new.project_id;
 perform public._assert_spatial_alignment_v1(new.payload,section_meta);
 if tg_op='UPDATE' then perform public._assert_spatial_alignment_preserved_v1(old.payload,new.payload); end if;
 return new;
end $$;
drop trigger if exists guard_spatial_share_alignment_v1 on public.share_alignments;
create trigger guard_spatial_share_alignment_v1 before insert or update of payload on public.share_alignments
 for each row execute function public._guard_spatial_share_alignment_v1();

-- A modern publisher explicitly marks its write. The marker is request-only,
-- so an old tab cannot acquire it merely by loading project metadata.
do $$ begin
 if to_regprocedure('public._publish_doc_write_before_spatial_v1(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)') is null then
   alter function public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)
     rename to _publish_doc_write_before_spatial_v1;
 end if;
end $$;
create or replace function public._publish_doc_write_v2(
 _master_pw text,_slug text,_display_name text,_meta jsonb,_viewer_pw text,
 _admin_pw text default null,_sections jsonb default '[]'::jsonb,
 _rois jsonb default '[]'::jsonb,_is_public boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare needs_spatial boolean; sec jsonb; roi jsonb; old_section public.sections%rowtype; old_roi public.rois%rowtype;
begin
 if not public._verify_master_pw(_master_pw) then raise exception 'unauthorized' using errcode='28000'; end if;
 select exists(select 1 from public.sections s join public.projects p on p.id=s.project_id
   where p.slug=_slug and s.meta ? 'spatialGroups') into needs_spatial;
 for sec in select * from jsonb_array_elements(coalesce(_sections,'[]'::jsonb)) loop
   if sec->'meta' ? 'spatialGroups' then needs_spatial:=true; end if;
   perform public._assert_spatial_registry_v1(sec->'meta');
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(_rois,'[]'::jsonb)) r
   where r#>>'{polyMsi,geometry,version}'='msi-group-v1') then needs_spatial:=true; end if;
 if needs_spatial and _meta->>'spatialWriteProtocol' is distinct from '1' then
   raise exception 'spatial_publish_upgrade_required: reload the current application' using errcode='0A000';
 end if;
 -- Preflight replacement before the original publisher deletes master ROIs.
 -- Explicit deletions remain possible; an in-place downgrade with the same
 -- section/color identity is refused even for a modern publisher.
 for roi in select * from jsonb_array_elements(coalesce(_rois,'[]'::jsonb)) loop
   select s.* into old_section from public.sections s join public.projects p on p.id=s.project_id
     where p.slug=_slug and s.meta->>'client_id'=roi->>'sectionId' limit 1;
   if old_section.id is null then continue; end if;
   select r.* into old_roi from public.rois r where r.section_id=old_section.id
     and r.color_key=coalesce(roi->>'colorKey','default') and coalesce(r.created_by,'')<>'viewer' limit 1;
   if old_roi.poly_msi#>>'{geometry,version}'='msi-group-v1'
     and roi#>>'{polyMsi,geometry,version}' is distinct from 'msi-group-v1' then
     raise exception 'spatial_roi_downgrade: create a separate individual ROI' using errcode='0A000';
   end if;
 end loop;
 return public._publish_doc_write_before_spatial_v1(_master_pw,_slug,_display_name,
   coalesce(_meta,'{}'::jsonb)-'spatialWriteProtocol',_viewer_pw,_admin_pw,_sections,_rois,_is_public);
end $$;
revoke all on function public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean) from public,anon,authenticated;
revoke all on function public._publish_doc_write_before_spatial_v1(text,text,text,jsonb,text,text,jsonb,jsonb,boolean) from public,anon,authenticated;
-- Invalidate cached PL/pgSQL plans that may still point at the renamed writer's
-- OID. The public publisher's signature, authorization and body are unchanged.
do $$ declare definition text; begin
 select pg_get_functiondef('public.publish_project_doc_v2(text,text,uuid,bigint,boolean,text,text,jsonb,text,text,jsonb,jsonb,boolean)'::regprocedure)
   into definition;
 execute definition;
end $$;
revoke all on function public._spatial_group_v1(jsonb,text),public._assert_spatial_registry_v1(jsonb),
 public._assert_spatial_registry_preserved_v1(jsonb,jsonb),public._assert_spatial_roi_v1(jsonb,uuid,jsonb),
 public._assert_spatial_alignment_v1(jsonb,jsonb),public._assert_spatial_alignment_preserved_v1(jsonb,jsonb),
 public._guard_spatial_section_v1(),public._guard_spatial_roi_v1(),public._guard_spatial_share_alignment_v1()
 from public,anon,authenticated;
commit;
