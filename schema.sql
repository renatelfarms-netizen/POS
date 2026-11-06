-- Multi-shop database for the platform (run once in a NEW Supabase project, or the same one).
-- Every function checks the server token first, so only the website server can use them.
-- Data of each shop is kept apart by shop_id; no function reads across shops except the shop list.

create table if not exists mt_shops (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text not null,
  owner_name text not null,
  email text not null,
  phone text default '',
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  trial_ends timestamptz not null,
  paid_until timestamptz,
  note text default ''
);

create table if not exists mt_docs (
  shop_id uuid not null references mt_shops(id) on delete cascade,
  c text not null,
  id text not null,
  d jsonb,
  x boolean not null default false,
  rev bigint not null,
  primary key (shop_id, c, id)
);
create index if not exists mt_docs_rev on mt_docs (shop_id, rev);

create table if not exists mt_seq (shop_id uuid primary key references mt_shops(id) on delete cascade, rev bigint not null default 0, ids bigint not null default 100);

create table if not exists mt_backups (
  id bigserial primary key,
  shop_id uuid not null references mt_shops(id) on delete cascade,
  created_at timestamptz not null default now(),
  device text, device_name text, sha256 text, size_bytes bigint, counts jsonb, data jsonb
);
create index if not exists mt_backups_shop on mt_backups (shop_id, created_at desc);

alter table mt_shops enable row level security;
alter table mt_docs enable row level security;
alter table mt_seq enable row level security;
alter table mt_backups enable row level security;
-- No policies: the tables can't be read with the public key. Only the functions below reach them.

-- Server token check (the same secret as SUPABASE_BACKUP_TOKEN, stored as a SHA-256 fingerprint).
create table if not exists mt_secret (k text primary key, v text not null);
alter table mt_secret enable row level security;
-- insert into mt_secret values ('token_sha', '<sha256 hex of the Tessa server token>');
create or replace function _mt_check(p_token text) returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_token is null or encode(sha256(convert_to(p_token, 'UTF8')), 'hex') is distinct from (select v from mt_secret where k = 'token_sha') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end $$;

create or replace function _mt_rev(p_shop uuid) returns bigint language sql security definer set search_path = public as $$
  insert into mt_seq (shop_id, rev) values (p_shop, 1)
  on conflict (shop_id) do update set rev = mt_seq.rev + 1 returning rev;
$$;

-- ---- shops ----
create or replace function mt_shop_create(p_token text, p_slug text, p_name text, p_owner text, p_email text, p_phone text, p_trial_days int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r mt_shops;
begin
  perform _mt_check(p_token);
  if exists (select 1 from mt_shops where slug = p_slug) then return jsonb_build_object('error', 'taken'); end if;
  insert into mt_shops (slug, name, owner_name, email, phone, trial_ends)
  values (p_slug, p_name, p_owner, p_email, coalesce(p_phone, ''), now() + make_interval(days => greatest(1, least(p_trial_days, 365))))
  returning * into r;
  insert into mt_seq (shop_id) values (r.id);
  return to_jsonb(r);
end $$;

create or replace function mt_shop_by_slug(p_token text, p_slug text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); return (select to_jsonb(s) from mt_shops s where slug = p_slug); end $$;

create or replace function mt_shop_list(p_token text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); return coalesce((select jsonb_agg(to_jsonb(s) order by created_at desc) from mt_shops s), '[]'::jsonb); end $$;

create or replace function mt_shop_set(p_token text, p_id uuid, p_patch jsonb) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r mt_shops;
begin
  perform _mt_check(p_token);
  update mt_shops set
    status = case when p_patch ? 'status' then p_patch->>'status' else status end,
    trial_ends = case when p_patch ? 'trial_ends' then (p_patch->>'trial_ends')::timestamptz else trial_ends end,
    paid_until = case when p_patch ? 'paid_until' then (p_patch->>'paid_until')::timestamptz else paid_until end,
    note = case when p_patch ? 'note' then p_patch->>'note' else note end
  where id = p_id returning * into r;
  return to_jsonb(r);
end $$;

-- ---- documents of one shop ----
create or replace function mt_db_pull(p_token text, p_shop uuid, p_since bigint) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare L jsonb; n int; last bigint;
begin
  perform _mt_check(p_token);
  select coalesce(jsonb_agg(jsonb_build_object('c', c, 'id', id, 'd', case when x then null else d end, 'x', x, 'rev', rev) order by rev), '[]'::jsonb), count(*), max(rev)
    into L, n, last
    from (select * from mt_docs where shop_id = p_shop and rev > coalesce(p_since, 0) order by rev limit 500) q;
  return jsonb_build_object('docs', L, 'rev', coalesce(last, coalesce(p_since, 0)), 'more', n = 500);
end $$;

create or replace function mt_db_get(p_token text, p_shop uuid, p_col text, p_id text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); return (select d from mt_docs where shop_id = p_shop and c = p_col and id = p_id and not x); end $$;

create or replace function mt_db_put(p_token text, p_shop uuid, p_col text, p_id text, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare cur mt_docs; r bigint;
begin
  perform _mt_check(p_token);
  perform pg_advisory_xact_lock(hashtext(p_shop::text));
  select * into cur from mt_docs where shop_id = p_shop and c = p_col and id = p_id;
  if found and not cur.x and cur.d = p_data then return jsonb_build_object('ok', true, 'rev', cur.rev, 'same', true); end if;
  r := _mt_rev(p_shop);
  insert into mt_docs (shop_id, c, id, d, x, rev) values (p_shop, p_col, p_id, p_data, false, r)
  on conflict (shop_id, c, id) do update set d = excluded.d, x = false, rev = excluded.rev;
  return jsonb_build_object('ok', true, 'rev', r);
end $$;

create or replace function mt_db_del(p_token text, p_shop uuid, p_col text, p_id text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r bigint;
begin
  perform _mt_check(p_token);
  perform pg_advisory_xact_lock(hashtext(p_shop::text));
  if not exists (select 1 from mt_docs where shop_id = p_shop and c = p_col and id = p_id and not x) then return jsonb_build_object('ok', true, 'rev', null); end if;
  r := _mt_rev(p_shop);
  update mt_docs set x = true, d = null, rev = r where shop_id = p_shop and c = p_col and id = p_id;
  return jsonb_build_object('ok', true, 'rev', r);
end $$;

create or replace function mt_ids(p_token text, p_shop uuid, p_n int) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare top bigint; n int := greatest(1, least(coalesce(p_n, 1), 200));
begin
  perform _mt_check(p_token);
  update mt_seq set ids = ids + n where shop_id = p_shop returning ids into top;
  return (select jsonb_agg(v) from generate_series(top - n + 1, top) v);
end $$;

-- ---- backups of one shop ----
create or replace function mt_backup_save(p_token text, p_shop uuid, p_device text, p_name text, p_sha text, p_size bigint, p_counts jsonb, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare last text; nid bigint;
begin
  perform _mt_check(p_token);
  select sha256 into last from mt_backups where shop_id = p_shop and device = p_device order by created_at desc limit 1;
  if last = p_sha then return jsonb_build_object('ok', true, 'skipped', true); end if;
  insert into mt_backups (shop_id, device, device_name, sha256, size_bytes, counts, data) values (p_shop, p_device, p_name, p_sha, p_size, p_counts, p_data) returning id into nid;
  -- keep 2 days of everything, then the newest per day for 90 days
  delete from mt_backups b where b.shop_id = p_shop and b.created_at < now() - interval '2 days'
    and (b.created_at < now() - interval '90 days' or b.id <> (select id from mt_backups x where x.shop_id = p_shop and x.device = b.device and x.created_at::date = b.created_at::date order by created_at desc limit 1));
  return jsonb_build_object('ok', true, 'id', nid);
end $$;

create or replace function mt_backup_list(p_token text, p_shop uuid) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'device', device, 'device_name', device_name, 'sha256', sha256, 'size_bytes', size_bytes, 'counts', counts) order by created_at desc) from mt_backups where shop_id = p_shop), '[]'::jsonb);
end $$;

create or replace function mt_backup_get(p_token text, p_shop uuid, p_id bigint) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); return (select data from mt_backups where shop_id = p_shop and id = p_id); end $$;

-- Mail settings (shared mailbox) for the Tessa server.
create or replace function mt_secret_get(p_token text, p_name text) returns text language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); if p_name not in ('mail_api_token', 'mail_mailbox_id', 'mail_from') then return null; end if; return (select value from site_secrets where name = p_name); end $$;

revoke all on function _mt_check, _mt_rev, mt_shop_create, mt_shop_by_slug, mt_shop_list, mt_shop_set, mt_db_pull, mt_db_get, mt_db_put, mt_db_del, mt_ids, mt_backup_save, mt_backup_list, mt_backup_get, mt_secret_get from public, anon, authenticated;
grant execute on function mt_shop_create, mt_shop_by_slug, mt_shop_list, mt_shop_set, mt_db_pull, mt_db_get, mt_db_put, mt_db_del, mt_ids, mt_backup_save, mt_backup_list, mt_backup_get, mt_secret_get to anon;

-- Admin password (salted hash) after it is changed on /admin.
create table if not exists mt_kv (k text primary key, v text not null, updated_at timestamptz not null default now());
alter table mt_kv enable row level security;
create or replace function mt_kv_get(p_token text, p_k text) returns text language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); if p_k not in ('admin_pw') then return null; end if; return (select v from mt_kv where k = p_k); end $$;
create or replace function mt_kv_set(p_token text, p_k text, p_v text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); if p_k not in ('admin_pw') then raise exception 'unknown key'; end if;
  insert into mt_kv (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v, updated_at = now();
  return jsonb_build_object('ok', true); end $$;
revoke all on function mt_kv_get, mt_kv_set from public, anon, authenticated;
grant execute on function mt_kv_get, mt_kv_set to anon;
