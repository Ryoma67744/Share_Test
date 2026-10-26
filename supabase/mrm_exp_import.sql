-- Apply AFTER mrm_library.sql and (when installed) mrm_reconcile.sql.
-- Idempotent. This migration does not rewrite existing MRM metadata or usage.
-- New browser features use these RPCs; no direct table access is granted.

-- Existing installations need the same allocator lock as new installations.
-- Patch only the known, master-password-gated allocation functions. Keep their
-- signatures, privileges, and bodies intact apart from this shared lock.
do $$
declare
    v_signature text;
    v_oid regprocedure;
    v_source text;
    v_definition text;
    v_auth text := E'    if not public._verify_master_pw(_master_pw) then\n        raise exception ''unauthorized'' using errcode = ''28000'';\n    end if;';
begin
    foreach v_signature in array array[
        'public.upsert_compound(text,text,text[],text,text,integer,text,text)',
        'public.update_compound(text,uuid,text,text[],text,text,integer,text,text)',
        'public.register_from_result(text,text,text[],text,numeric,numeric,numeric,numeric,text,text,text,text,text[])',
        'public.register_measured_compound(text,text,text[],text,numeric,numeric,numeric,numeric,text,text)'
    ] loop
        v_oid := to_regprocedure(v_signature);
        if v_oid is null then continue; end if;
        select prosrc, pg_get_functiondef(oid) into v_source, v_definition from pg_proc where oid = v_oid;
        if position('pg_advisory_xact_lock' in v_source) = 0 then
            if position(v_auth in v_source) = 0 then
                raise exception 'Unexpected authentication body in %; review allocator locking before applying', v_signature;
            end if;
            execute replace(v_definition, v_source, replace(v_source, v_auth,
                v_auth || E'\n    perform pg_advisory_xact_lock(hashtext(''public.mrm_compounds.serial_no''));'));
        end if;
    end loop;
end $$;

-- Numeric strings are accepted without losing precision in JSON/JavaScript.
-- Deliberately reject empty strings, non-finite PostgreSQL numeric values,
-- excess exponents, booleans and partial numeric strings.
create or replace function public._mrm_exp_number(_value jsonb, _field text)
returns numeric language plpgsql immutable set search_path = public
as $$
declare v_text text; v_number numeric;
begin
    if _value is null or jsonb_typeof(_value) not in ('number','string') then
        raise exception 'Invalid numeric field: %', _field using errcode = '22023';
    end if;
    v_text := trim(_value #>> '{}');
    if length(v_text) > 80 or v_text !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' then
        raise exception 'Invalid numeric field: %', _field using errcode = '22023';
    end if;
    v_number := v_text::numeric;
    if abs(v_number) > 1e100 or (v_number <> 0 and abs(v_number) < 1e-100) then
        raise exception 'Numeric field outside supported range: %', _field using errcode = '22023';
    end if;
    return v_number;
end $$;
revoke all on function public._mrm_exp_number(jsonb,text) from public, anon, authenticated;

create or replace function public.register_from_exp_batch(_master_pw text, _rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_row jsonb;
    v_expected jsonb;
    v_current jsonb;
    v_expected_transitions jsonb;
    v_compound public.mrm_compounds%rowtype;
    v_name text;
    v_polarity text;
    v_tags text[];
    v_precursor numeric;
    v_product numeric;
    v_ce numeric;
    v_cv numeric;
    v_cid uuid;
    v_tid uuid;
    v_serial integer;
    v_found boolean;
    v_action text;
    v_results jsonb := '[]'::jsonb;
begin
    if not public._verify_master_pw(_master_pw) then
        raise exception 'unauthorized' using errcode = '28000';
    end if;
    if _rows is null or jsonb_typeof(_rows) <> 'array' or jsonb_array_length(_rows) not between 1 and 2048 or octet_length(_rows::text) > 2097152 then
        raise exception 'Expected 1 to 2048 rows (maximum 2 MiB)' using errcode = '22023';
    end if;
    -- Same order as all existing automatic number allocators. Table writer
    -- locks also exclude manual edits/deletions until snapshot checks and the
    -- complete atomic batch finish. Reads remain available.
    perform pg_advisory_xact_lock(hashtext('public.mrm_compounds.serial_no'));
    lock table public.mrm_compounds, public.mrm_transitions in share row exclusive mode;

    -- Validate every row against the unchanged library first. Repeated source
    -- channels may target the same compound and share the same preview snapshot.
    for v_row in select value from jsonb_array_elements(_rows) loop
        if jsonb_typeof(v_row) <> 'object' or not (v_row ? 'expected') then
            raise exception 'Row and preview snapshot required' using errcode = '22023';
        end if;
        v_name := trim(coalesce(v_row->>'name',''));
        v_polarity := v_row->>'polarity';
        if length(v_name) not between 1 and 500 or v_name ~ '[[:cntrl:]]' or jsonb_typeof(v_row->'name') <> 'string' then
            raise exception 'Invalid compound name' using errcode = '22023';
        end if;
        if v_polarity is null or v_polarity not in ('+','-') then
            raise exception 'Explicit polarity required: %', v_name using errcode = '22023';
        end if;
        v_precursor := public._mrm_exp_number(v_row->'precursor','precursor');
        v_product := public._mrm_exp_number(v_row->'product','product');
        v_ce := public._mrm_exp_number(v_row->'ce','ce');
        v_cv := public._mrm_exp_number(v_row->'cv','cv');
        if v_precursor <= 0 or v_product <= 0 then
            raise exception 'Mass must be positive: %', v_name using errcode = '22023';
        end if;
        if jsonb_typeof(v_row->'tags') is distinct from 'array' or jsonb_array_length(v_row->'tags') > 50 then
            raise exception 'Tags must be an explicit array: %', v_name using errcode = '22023';
        end if;
        if exists(select 1 from jsonb_array_elements(v_row->'tags') t where jsonb_typeof(t) <> 'string' or length(trim(t #>> '{}')) not between 1 and 100 or (t #>> '{}') ~ '[[:cntrl:]]') then
            raise exception 'Invalid tag: %', v_name using errcode = '22023';
        end if;
        select * into v_compound from public.mrm_compounds where name = v_name;
        v_found := found;
        v_expected := v_row->'expected';
        if not v_found then
            if v_expected <> 'null'::jsonb then raise exception 'Library changed; refresh preview: %', v_name using errcode = '40001'; end if;
            if (v_row->>'shelf') is null or (v_row->>'shelf') not in ('main','archive') then
                raise exception 'Explicit destination required: %', v_name using errcode = '22023';
            end if;
        else
            if jsonb_typeof(v_expected) <> 'object' or (v_expected->>'id') is distinct from v_compound.id::text
                or (v_expected->>'updated_at')::timestamptz is distinct from v_compound.updated_at then
                raise exception 'Library changed; refresh preview: %', v_name using errcode = '40001';
            end if;
            if v_compound.polarity is distinct from v_polarity then
                raise exception 'Polarity conflict: %', v_name using errcode = '22023';
            end if;
            if jsonb_typeof(v_expected->'transitions') is distinct from 'array' then
                raise exception 'Transition snapshot required: %', v_name using errcode = '22023';
            end if;
            select coalesce(jsonb_agg(jsonb_build_object('id', t.id,
                'precursor', trim_scale(t.precursor)::text, 'product', trim_scale(t.product)::text,
                'ce', trim_scale(t.ce)::text, 'cv', trim_scale(t.cv)::text) order by t.id), '[]'::jsonb)
                into v_current from public.mrm_transitions t where t.compound_id = v_compound.id;
            select coalesce(jsonb_agg(t order by t->>'id'), '[]'::jsonb)
                into v_expected_transitions from jsonb_array_elements(v_expected->'transitions') t;
            if v_current <> v_expected_transitions then
                raise exception 'Transitions changed; refresh preview: %', v_name using errcode = '40001';
            end if;
            if not exists(select 1 from public.mrm_transitions where compound_id = v_compound.id and precursor = v_precursor and product = v_product and ce = v_ce and cv = v_cv)
                and v_row->'allow_new_condition' is distinct from 'true'::jsonb then
                raise exception 'Acknowledge new condition: %', v_name using errcode = '22023';
            end if;
        end if;
    end loop;
    -- An absent compound cannot acquire conflicting polarities in one batch.
    if exists(select 1 from jsonb_array_elements(_rows) r group by trim(r->>'name') having count(distinct r->>'polarity') > 1) then
        raise exception 'Conflicting polarities within import' using errcode = '22023';
    end if;
    if exists(select 1 from jsonb_array_elements(_rows) r where r->'expected' = 'null'::jsonb group by trim(r->>'name') having count(distinct r->>'shelf') > 1) then
        raise exception 'Conflicting destinations within import' using errcode = '22023';
    end if;
    select coalesce(max(serial_no),0) into v_serial from public.mrm_compounds;
    for v_row in select value from jsonb_array_elements(_rows) loop
        v_name := trim(v_row->>'name');
        select coalesce(array_agg(distinct trim(t)), '{}') into v_tags from jsonb_array_elements_text(v_row->'tags') t;
        select id into v_cid from public.mrm_compounds where name = v_name;
        if v_cid is null then
            v_serial := v_serial + 1;
            insert into public.mrm_compounds(name,tags,polarity,serial_no,check_level,shelf)
                values(v_name,v_tags,v_row->>'polarity',v_serial,'unchecked',v_row->>'shelf') returning id into v_cid;
        else
            update public.mrm_compounds set tags = public._mrm_array_union(tags,v_tags), updated_at = clock_timestamp()
                where id = v_cid and not tags @> v_tags;
        end if;
        v_precursor := public._mrm_exp_number(v_row->'precursor','precursor');
        v_product := public._mrm_exp_number(v_row->'product','product');
        v_ce := public._mrm_exp_number(v_row->'ce','ce');
        v_cv := public._mrm_exp_number(v_row->'cv','cv');
        select id into v_tid from public.mrm_transitions where compound_id = v_cid and precursor = v_precursor and product = v_product and ce = v_ce and cv = v_cv;
        v_action := 'reused';
        if v_tid is null then
            insert into public.mrm_transitions(compound_id,precursor,product,ce,cv) values(v_cid,v_precursor,v_product,v_ce,v_cv) returning id into v_tid;
            v_action := 'created';
        end if;
        v_results := v_results || jsonb_build_object('row_id',v_row->>'row_id','name',v_name,'compound_id',v_cid,'transition_id',v_tid,'action',v_action);
    end loop;
    return jsonb_build_object('ok_count',jsonb_array_length(v_results),'results',v_results);
end $$;
revoke all on function public.register_from_exp_batch(text,jsonb) from public;
grant execute on function public.register_from_exp_batch(text,jsonb) to anon, authenticated;

create table if not exists public.mrm_exp_documents (
    id uuid primary key default gen_random_uuid(),
    name text not null check(length(trim(name)) between 1 and 200),
    revision integer not null default 1 check(revision > 0),
    source_sha256 text not null,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
alter table public.mrm_exp_documents enable row level security;
revoke all on public.mrm_exp_documents from public, anon, authenticated;

create or replace function public.save_mrm_exp_document(
    _master_pw text, _name text, _payload jsonb,
    _id uuid default null, _expected_revision integer default null
) returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_bytes bytea;
    v_doc public.mrm_exp_documents%rowtype;
    v_row jsonb;
    v_hash text;
begin
    if not public._verify_master_pw(_master_pw) then raise exception 'unauthorized' using errcode = '28000'; end if;
    if _name is null or length(trim(_name)) not between 1 and 200 or _name ~ '[[:cntrl:]]' then
        raise exception 'Invalid document name' using errcode = '22023';
    end if;
    if _payload is null or jsonb_typeof(_payload) <> 'object' or octet_length(_payload::text) > 2097152
        or _payload->'version' is distinct from '1'::jsonb or jsonb_typeof(_payload->'parserVersion') is distinct from 'string'
        or _payload->>'parserVersion' is distinct from '1'
        or _payload->>'profile' is distinct from 'flat-mrm-v1'
        or jsonb_typeof(_payload->'filename') is distinct from 'string' or length(_payload->>'filename') not between 1 and 4096
        or jsonb_typeof(_payload->'encoding') is distinct from 'string' or (_payload->>'encoding') not in ('utf-8','utf-16le','utf-16be','windows-1252','shift_jis')
        or jsonb_typeof(_payload->'originalBase64') is distinct from 'string'
        or jsonb_typeof(_payload->'rows') is distinct from 'array' then
        raise exception 'Invalid version 1 document payload (maximum 2 MiB)' using errcode = '22023';
    end if;
    if (_payload->>'originalBase64') !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' then
        raise exception 'Invalid base64 source' using errcode = '22023';
    end if;
    v_bytes := decode(_payload->>'originalBase64','base64');
    if octet_length(v_bytes) not between 1 and 1048576 or jsonb_array_length(_payload->'rows') not between 1 and 2048 then
        raise exception 'Source or row count exceeds supported limits' using errcode = '22023';
    end if;
    for v_row in select value from jsonb_array_elements(_payload->'rows') loop
        if jsonb_typeof(v_row) <> 'object' or jsonb_typeof(v_row->'id') is distinct from 'string'
            or length(v_row->>'id') not between 1 and 200 or jsonb_typeof(v_row->'name') is distinct from 'string'
            or length(v_row->>'name') > 1024 or (v_row->>'name') ~ '[[:cntrl:]]' then
            raise exception 'Invalid saved row' using errcode = '22023';
        end if;
        if public._mrm_exp_number(v_row->'precursor','precursor') <= 0 or public._mrm_exp_number(v_row->'product','product') <= 0 then
            raise exception 'Invalid saved mass' using errcode = '22023';
        end if;
        perform public._mrm_exp_number(v_row->'ce','ce');
        perform public._mrm_exp_number(v_row->'cv','cv');
    end loop;
    if (select count(distinct r->>'id') from jsonb_array_elements(_payload->'rows') r) <> jsonb_array_length(_payload->'rows') then
        raise exception 'Duplicate saved row IDs' using errcode = '22023';
    end if;
    v_hash := encode(sha256(v_bytes),'hex');
    if _id is null then
        if _expected_revision is not null then raise exception 'New documents must not specify a revision' using errcode = '22023'; end if;
        insert into public.mrm_exp_documents(name,source_sha256,payload) values(trim(_name),v_hash,_payload) returning * into v_doc;
    else
        update public.mrm_exp_documents set name = trim(_name), source_sha256 = v_hash, payload = _payload,
            revision = revision + 1, updated_at = clock_timestamp()
            where id = _id and revision = _expected_revision returning * into v_doc;
        if not found then raise exception 'Document changed or missing; reload before saving' using errcode = '40001'; end if;
    end if;
    return jsonb_build_object('id',v_doc.id,'name',v_doc.name,'revision',v_doc.revision,'source_sha256',v_doc.source_sha256,'updated_at',v_doc.updated_at);
end $$;

create or replace function public.list_mrm_exp_documents(_master_pw text)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare v_out jsonb;
begin
    if not public._verify_master_pw(_master_pw) then raise exception 'unauthorized' using errcode = '28000'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'revision',revision,'source_sha256',source_sha256,'created_at',created_at,'updated_at',updated_at) order by updated_at desc,id), '[]'::jsonb)
        into v_out from public.mrm_exp_documents;
    return v_out;
end $$;

create or replace function public.get_mrm_exp_document(_master_pw text, _id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare v_out jsonb;
begin
    if not public._verify_master_pw(_master_pw) then raise exception 'unauthorized' using errcode = '28000'; end if;
    select to_jsonb(d) into v_out from public.mrm_exp_documents d where id = _id;
    if v_out is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
    return v_out;
end $$;
revoke all on function public.save_mrm_exp_document(text,text,jsonb,uuid,integer) from public;
revoke all on function public.list_mrm_exp_documents(text) from public;
revoke all on function public.get_mrm_exp_document(text,uuid) from public;
grant execute on function public.save_mrm_exp_document(text,text,jsonb,uuid,integer) to anon, authenticated;
grant execute on function public.list_mrm_exp_documents(text) to anon, authenticated;
grant execute on function public.get_mrm_exp_document(text,uuid) to anon, authenticated;
