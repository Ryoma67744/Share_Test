-- Versioned HE/IF -> MSI alignment writes. Apply before the matching viewer.
-- Existing JSONB data is not rewritten. No table columns or data backfill.
-- Requires publish-v2 and the section-ordinal fix; existing spatial guards
-- remain in their original function bodies behind the additional wrapper.
-- Request-only alignmentWriteProtocol=2 is removed before storing metadata.
-- See ../docs/ALIGNMENT_CONTRACT_V2.md. Do not reapply older base SQL afterward.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '45s';

-- Preserve the actual endpoint owners/ACLs, including deliberately restricted
-- deployments. A newly created SECURITY DEFINER must not inherit PUBLIC access.
create temporary table alignment_contract_install_acl_v2 (
 signature text, owner_id oid, privileges aclitem[]
) on commit drop;
insert into alignment_contract_install_acl_v2
 select signature, p.proowner, coalesce(p.proacl,acldefault('f',p.proowner))
 from (values
  ('public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)'),
  ('public.upsert_share_alignment(text,uuid,jsonb,integer,text)')
 ) target(signature) join pg_proc p on p.oid=to_regprocedure(signature);

do $install$
declare
 writer regprocedure:=to_regprocedure('public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)');
 saved_writer regprocedure:=to_regprocedure('public._publish_doc_write_before_alignment_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)');
 shared regprocedure:=to_regprocedure('public.upsert_share_alignment(text,uuid,jsonb,integer,text)');
 saved_shared regprocedure:=to_regprocedure('public._upsert_share_alignment_before_contract_v2(text,uuid,jsonb,integer,text)');
 spatial_base regprocedure:=to_regprocedure('public._publish_doc_write_before_spatial_v1(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)');
 source_hash text;
begin
 if writer is null or shared is null
   or to_regprocedure('public.publish_project_doc_v2(text,text,uuid,bigint,boolean,text,text,jsonb,text,text,jsonb,jsonb,boolean)') is null then
   raise exception 'alignment_contract_prerequisite: publish-v2 and shared alignments must be installed' using errcode='0A000';
 end if;
 if (saved_writer is null) is distinct from (saved_shared is null) then
   raise exception 'alignment_contract_unexpected_installation: review the existing wrappers' using errcode='0A000';
 end if;
 if saved_writer is not null then
   select md5(replace(prosrc,E'\r\n',E'\n')) into source_hash from pg_proc where oid=writer;
   if source_hash<>'87f3eaa39e1009d2b3e93710256166e8' then
     raise exception 'alignment_contract_unexpected_publisher: no changes committed' using errcode='0A000';
   end if;
   select md5(replace(prosrc,E'\r\n',E'\n')) into source_hash from pg_proc where oid=shared;
   if source_hash<>'fbd9b20adb944cc66f25cf4a707bf55f' then
     raise exception 'alignment_contract_unexpected_shared_writer: no changes committed' using errcode='0A000';
   end if;
 end if;
 select md5(replace(prosrc,E'\r\n',E'\n')) into source_hash from pg_proc where oid=coalesce(saved_writer,writer);
 if spatial_base is not null then
   if source_hash<>'cfe41d7f3a3ecb145222fe98105730c4' then
     raise exception 'alignment_contract_unexpected_spatial_wrapper: no changes committed' using errcode='0A000';
   end if;
   select md5(replace(prosrc,E'\r\n',E'\n')) into source_hash from pg_proc where oid=spatial_base;
 end if;
 if source_hash<>'8e4bf0b44161cae2480323ce21c240b4' then
   raise exception 'alignment_contract_prerequisite: apply the reviewed section_ordinal_hotfix.sql first; unexpected writer left unchanged' using errcode='0A000';
 end if;
 select md5(replace(prosrc,E'\r\n',E'\n')) into source_hash from pg_proc where oid=coalesce(saved_shared,shared);
 if source_hash<>'e0507ec4c2c4675fbb7b05620aff3082' then
   raise exception 'alignment_contract_unexpected_shared_base: verify conflict_error_hotfix.sql and review the deployed function' using errcode='0A000';
 end if;
 if saved_writer is null then
   alter function public._publish_doc_write_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)
     rename to _publish_doc_write_before_alignment_v2;
   alter function public.upsert_share_alignment(text,uuid,jsonb,integer,text)
     rename to _upsert_share_alignment_before_contract_v2;
 end if;
end $install$;

-- Include the historical layer-level fallback as well as every managed scope.
-- Paths are retained for downgrade checks; arrays/landmark points are not records.
create or replace function public._alignment_records_v2(_payload jsonb)
returns table(record_path text[], record_value jsonb)
language sql immutable set search_path=pg_catalog,public as $$
 with layers as (
   select key,value from jsonb_each(case when jsonb_typeof(_payload->'alignment')='object'
     then _payload->'alignment' else '{}'::jsonb end)
 )
 select array['alignment',key],value from layers
 union all
 select array['alignment',layer.key,scope.key,item.key],item.value
 from layers layer cross join (values ('byFrame'),('bySource'),('byGroup'),('sharedByCoordinate')) scope(key)
 cross join lateral jsonb_each(case when jsonb_typeof(layer.value->scope.key)='object'
   then layer.value->scope.key else '{}'::jsonb end) item
$$;

create or replace function public._alignment_record_has_contract_v2(_record jsonb)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(_record ? 'alignmentContractVersion' or _record ? 'renderContract'
   or (_record#>>'{frame,version}' is not null
     and _record#>>'{frame,version}'<>'msi-alignment-frame-v1'),false)
$$;

create or replace function public._alignment_has_contract_v2(_payload jsonb)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
 select exists(select 1 from public._alignment_records_v2(_payload)
   where public._alignment_record_has_contract_v2(record_value))
$$;

create or replace function public._alignment_valid_affine_v2(_matrix jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog,public as $$
declare row_value jsonb; cell jsonb; n double precision; determinant double precision;
begin
 if jsonb_typeof(_matrix) is distinct from 'array' then return false; end if;
 if jsonb_array_length(_matrix)<>3 then return false; end if;
 for row_value in select value from jsonb_array_elements(_matrix) loop
   if jsonb_typeof(row_value) is distinct from 'array' then return false; end if;
   if jsonb_array_length(row_value)<>3 then return false; end if;
   for cell in select value from jsonb_array_elements(row_value) loop
     if jsonb_typeof(cell) is distinct from 'number' then return false; end if;
     n:=(cell#>>'{}')::double precision;
     if not (n>'-Infinity'::double precision and n<'Infinity'::double precision) then return false; end if;
   end loop;
 end loop;
 if _matrix->2 is distinct from '[0,0,1]'::jsonb then return false; end if;
 determinant:=(_matrix#>>'{0,0}')::double precision*(_matrix#>>'{1,1}')::double precision
   -(_matrix#>>'{0,1}')::double precision*(_matrix#>>'{1,0}')::double precision;
 return determinant>'-Infinity'::double precision and determinant<'Infinity'::double precision
   and abs(determinant)>=1e-12;
exception when numeric_value_out_of_range or invalid_text_representation then
 return false;
end $$;

create or replace function public._assert_alignment_contract_v2(_payload jsonb)
returns void language plpgsql immutable set search_path=pg_catalog,public as $$
declare layer record; scope text; item record; r jsonb;
begin
 if _payload is null then return; end if;
 if jsonb_typeof(_payload) is distinct from 'object' then
   raise exception 'invalid_alignment_contract: payload must be an object' using errcode='22023';
 end if;
 if _payload->'alignment' is null or _payload->'alignment'='null'::jsonb then return; end if;
 if jsonb_typeof(_payload->'alignment') is distinct from 'object' then
   raise exception 'invalid_alignment_contract: alignment must be an object' using errcode='22023';
 end if;
 for layer in select * from jsonb_each(_payload->'alignment') loop
   if layer.value='null'::jsonb then continue; end if;
   if jsonb_typeof(layer.value) is distinct from 'object' then
     raise exception 'invalid_alignment_contract: layer must be an object' using errcode='22023';
   end if;
   foreach scope in array array['byFrame','bySource','byGroup','sharedByCoordinate'] loop
     if layer.value->scope is not null and layer.value->scope<>'null'::jsonb
       and jsonb_typeof(layer.value->scope) is distinct from 'object' then
       raise exception 'invalid_alignment_contract: record collection must be an object' using errcode='22023';
     end if;
   end loop;
 end loop;
 for item in select * from public._alignment_records_v2(_payload) loop
   r:=item.record_value;
   if not public._alignment_record_has_contract_v2(r) then continue; end if;
   if r->'alignmentContractVersion' is distinct from '2'::jsonb
     or r->>'renderContract' is distinct from 'msi-shared-display-v1'
     or r->>'alignment_raster_basis' is distinct from 'legacy-msi-pixel-edges-v1'
     or r#>>'{frame,version}' is distinct from 'msi-alignment-frame-v2'
     or jsonb_typeof(r#>'{frame,key}') is distinct from 'string'
     or coalesce(r#>>'{frame,key}','')=''
     or not public._alignment_valid_affine_v2(r->'T_he_to_msi') then
     raise exception 'invalid_alignment_contract: unsupported version, frame, basis, or affine at %',array_to_string(item.record_path,'.')
       using errcode='22023';
   end if;
 end loop;
end $$;

create or replace function public._assert_alignment_preserved_v2(_old jsonb,_new jsonb)
returns void language plpgsql immutable set search_path=pg_catalog,public as $$
declare item record; replacement jsonb;
begin
 for item in select * from public._alignment_records_v2(_old) loop
   if not public._alignment_record_has_contract_v2(item.record_value) then continue; end if;
   replacement:=_new#>item.record_path;
   -- Modern explicit removal/re-scope is allowed. A retained record cannot
   -- silently revert to slider-only/legacy interpretation, even in protocol 2.
   if replacement is not null and not public._alignment_record_has_contract_v2(replacement) then
     raise exception 'alignment_contract_downgrade: retained record lost its version at %',array_to_string(item.record_path,'.')
       using errcode='0A000';
   end if;
 end loop;
end $$;

create or replace function public._guard_alignment_section_v2()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare alignment_changed boolean:=true;
begin
 -- Metadata writers unrelated to registration may retain this subtree
 -- verbatim. Do not require a registration protocol for those updates.
 if tg_op='UPDATE' then alignment_changed:=new.meta->'alignment' is distinct from old.meta->'alignment'; end if;
 if alignment_changed and (public._alignment_has_contract_v2(new.meta)
     or (tg_op='UPDATE' and public._alignment_has_contract_v2(old.meta)))
   and current_setting('share_test.alignment_write_protocol',true) is distinct from '2' then
   raise exception 'alignment_upgrade_required: reload the current application' using errcode='0A000';
 end if;
 perform public._assert_alignment_contract_v2(new.meta);
 if tg_op='UPDATE' then perform public._assert_alignment_preserved_v2(old.meta,new.meta); end if;
 return new;
end $$;
drop trigger if exists guard_alignment_section_v2 on public.sections;
create trigger guard_alignment_section_v2 before insert or update of meta on public.sections
 for each row execute function public._guard_alignment_section_v2();

create or replace function public._guard_alignment_shared_v2()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (public._alignment_has_contract_v2(new.payload)
     or (tg_op='UPDATE' and public._alignment_has_contract_v2(old.payload)))
   and current_setting('share_test.alignment_write_protocol',true) is distinct from '2' then
   raise exception 'alignment_upgrade_required: reload the current application' using errcode='0A000';
 end if;
 perform public._assert_alignment_contract_v2(new.payload);
 if tg_op='UPDATE' then perform public._assert_alignment_preserved_v2(old.payload,new.payload); end if;
 return new;
end $$;
drop trigger if exists guard_alignment_shared_v2 on public.share_alignments;
create trigger guard_alignment_shared_v2 before insert or update of payload on public.share_alignments
 for each row execute function public._guard_alignment_shared_v2();

create or replace function public._publish_doc_write_v2(
 _master_pw text,_slug text,_display_name text,_meta jsonb,_viewer_pw text,
 _admin_pw text default null,_sections jsonb default '[]'::jsonb,
 _rois jsonb default '[]'::jsonb,_is_public boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare modern boolean:=coalesce(_meta->'alignmentWriteProtocol'='2'::jsonb,false);
 needs_contract boolean; sec jsonb; previous_protocol text; result jsonb;
begin
 if not public._verify_master_pw(_master_pw) then raise exception 'unauthorized' using errcode='28000'; end if;
 if _meta ? 'alignmentWriteProtocol' and not modern then
   raise exception 'invalid_alignment_write_protocol' using errcode='22023';
 end if;
 select exists(select 1 from public.projects p join public.sections s on s.project_id=p.id
   where p.slug=_slug and (public._alignment_has_contract_v2(s.meta)
     or exists(select 1 from public.share_alignments a where a.section_id=s.id
       and a.project_id=p.id and public._alignment_has_contract_v2(a.payload)))) into needs_contract;
 for sec in select * from jsonb_array_elements(coalesce(_sections,'[]'::jsonb)) loop
   if public._alignment_has_contract_v2(sec->'meta') then needs_contract:=true; end if;
   perform public._assert_alignment_contract_v2(sec->'meta');
 end loop;
 if needs_contract and not modern then
   raise exception 'alignment_upgrade_required: reload the current application before publishing' using errcode='0A000';
 end if;
 previous_protocol:=current_setting('share_test.alignment_write_protocol',true);
 perform set_config('share_test.alignment_write_protocol',case when modern then '2' else '0' end,true);
 begin
   result:=public._publish_doc_write_before_alignment_v2(_master_pw,_slug,_display_name,
     _meta-'alignmentWriteProtocol',_viewer_pw,_admin_pw,_sections,_rois,_is_public);
   perform set_config('share_test.alignment_write_protocol',coalesce(previous_protocol,''),true);
   return result;
 exception when others then
   perform set_config('share_test.alignment_write_protocol',coalesce(previous_protocol,''),true);
   raise;
 end;
end $$;

create or replace function public.upsert_share_alignment(
 p_token text,p_section_id uuid,p_payload jsonb,p_expected_version integer default null,p_created_by text default 'viewer')
returns public.share_alignments language plpgsql security definer set search_path=pg_catalog,public as $$
declare pid uuid; section_meta jsonb; existing_payload jsonb; previous_protocol text;
 modern boolean:=coalesce(p_payload->'alignmentWriteProtocol'='2'::jsonb,false);
 clean_payload jsonb:=p_payload-'alignmentWriteProtocol'; result public.share_alignments;
begin
 pid:=public._project_from_token(p_token);
 if pid is null then raise exception 'invalid or expired token' using errcode='28000'; end if;
 select meta into section_meta from public.sections where id=p_section_id and project_id=pid;
 if not found then raise exception 'section not in this project' using errcode='22023'; end if;
 if p_payload ? 'alignmentWriteProtocol' and not modern then
   raise exception 'invalid_alignment_write_protocol' using errcode='22023';
 end if;
 -- Hold the existing row while checking its contract and the original CAS.
 select payload into existing_payload from public.share_alignments
   where project_id=pid and section_id=p_section_id for update;
 if (public._alignment_has_contract_v2(section_meta) or public._alignment_has_contract_v2(existing_payload)
     or public._alignment_has_contract_v2(clean_payload)) and not modern then
   raise exception 'alignment_upgrade_required: reload the current application before saving alignment' using errcode='0A000';
 end if;
 perform public._assert_alignment_contract_v2(clean_payload);
 previous_protocol:=current_setting('share_test.alignment_write_protocol',true);
 perform set_config('share_test.alignment_write_protocol',case when modern then '2' else '0' end,true);
 begin
   result:=public._upsert_share_alignment_before_contract_v2(p_token,p_section_id,clean_payload,p_expected_version,p_created_by);
   perform set_config('share_test.alignment_write_protocol',coalesce(previous_protocol,''),true);
   return result;
 exception when others then
   perform set_config('share_test.alignment_write_protocol',coalesce(previous_protocol,''),true);
   raise;
 end;
end $$;

create or replace function public.alignment_contract_capabilities_v2()
returns jsonb language sql stable set search_path=pg_catalog,public as $$
 select jsonb_build_object('version',2,'renderContract','msi-shared-display-v1','protectDowngrade',true)
$$;

-- Keep the complete public publication body, including request hashes, locks,
-- sessions, revision checks and receipts. Recompile only to invalidate cached
-- PL/pgSQL name bindings to the renamed writer's old OID.
do $$ declare definition text; begin
 select pg_get_functiondef('public.publish_project_doc_v2(text,text,uuid,bigint,boolean,text,text,jsonb,text,text,jsonb,jsonb,boolean)'::regprocedure)
   into definition;
 execute definition;
end $$;

do $permissions$
declare target record; entry record; grantee_name text; signature text; helper text; owner_role text;
 helpers text[]:=array[
  'public._alignment_records_v2(jsonb)','public._alignment_record_has_contract_v2(jsonb)',
  'public._alignment_has_contract_v2(jsonb)','public._alignment_valid_affine_v2(jsonb)',
  'public._assert_alignment_contract_v2(jsonb)','public._assert_alignment_preserved_v2(jsonb,jsonb)',
  'public._guard_alignment_section_v2()','public._guard_alignment_shared_v2()'];
begin
 for target in select * from alignment_contract_install_acl_v2 loop
   execute format('alter function %s owner to %I',target.signature,pg_get_userbyid(target.owner_id));
   for entry in select distinct a.grantee from pg_proc p
     cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where p.oid=target.signature::regprocedure and a.grantee<>p.proowner loop
     grantee_name:=case when entry.grantee=0 then 'public' else quote_ident(pg_get_userbyid(entry.grantee)) end;
     execute format('revoke all on function %s from %s',target.signature,grantee_name);
   end loop;
   for entry in select * from aclexplode(target.privileges) where privilege_type='EXECUTE' loop
     grantee_name:=case when entry.grantee=0 then 'public' else quote_ident(pg_get_userbyid(entry.grantee)) end;
     execute format('grant execute on function %s to %s%s',target.signature,grantee_name,
       case when entry.is_grantable then ' with grant option' else '' end);
   end loop;
 end loop;
 foreach signature in array array[
   'public._publish_doc_write_before_alignment_v2(text,text,text,jsonb,text,text,jsonb,jsonb,boolean)',
   'public._upsert_share_alignment_before_contract_v2(text,uuid,jsonb,integer,text)'] loop
   for entry in select distinct a.grantee from pg_proc p
     cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where p.oid=signature::regprocedure and a.grantee<>p.proowner loop
     grantee_name:=case when entry.grantee=0 then 'public' else quote_ident(pg_get_userbyid(entry.grantee)) end;
     execute format('revoke all on function %s from %s',signature,grantee_name);
   end loop;
 end loop;
 foreach helper in array helpers loop
   execute format('revoke all on function %s from public,anon,authenticated',helper);
   for owner_role in select distinct pg_get_userbyid(owner_id) from alignment_contract_install_acl_v2 loop
     execute format('grant execute on function %s to %I',helper,owner_role);
   end loop;
 end loop;
end $permissions$;
revoke all on function public.alignment_contract_capabilities_v2() from public;
grant execute on function public.alignment_contract_capabilities_v2() to anon,authenticated;

notify pgrst,'reload schema';
commit;
