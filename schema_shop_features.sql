-- Online shop, photos, SMS, one-time codes and credit reminders for every shop (run once, after schema.sql).
-- Same rules as schema.sql: only the website server (token checked) can use these, and every row belongs to one shop.
create table if not exists mt_photos (shop_id uuid not null references mt_shops(id) on delete cascade, key text not null, mime text not null, data text not null, created_at timestamptz not null default now(), primary key (shop_id, key));
create table if not exists mt_accounts (shop_id uuid not null references mt_shops(id) on delete cascade, phone text not null, data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key (shop_id, phone));
create table if not exists mt_ssecrets (shop_id uuid not null references mt_shops(id) on delete cascade, name text not null, value text not null, updated_at timestamptz not null default now(), primary key (shop_id, name));
create table if not exists mt_otp (shop_id uuid not null references mt_shops(id) on delete cascade, k text not null, h text not null, exp timestamptz not null, tries int not null default 0, sent timestamptz not null default now(), primary key (shop_id, k));
create table if not exists mt_jobs (shop_id uuid not null references mt_shops(id) on delete cascade, k text not null, at timestamptz not null default now(), primary key (shop_id, k));
alter table mt_photos enable row level security; alter table mt_accounts enable row level security; alter table mt_ssecrets enable row level security; alter table mt_otp enable row level security; alter table mt_jobs enable row level security;

create or replace function mt_photo_put(p_token text, p_shop uuid, p_key text, p_mime text, p_data text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token);
  if p_mime not in ('image/jpeg','image/png','image/webp') or length(p_data) > 1500000 then raise exception 'bad photo' using errcode = '22023'; end if;
  insert into mt_photos (shop_id, key, mime, data) values (p_shop, p_key, p_mime, p_data) on conflict do nothing;
  return jsonb_build_object('ok', true, 'key', p_key); end $$;
create or replace function mt_photo_get(p_token text, p_shop uuid, p_key text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); return (select jsonb_build_object('mime', mime, 'data', data) from mt_photos where shop_id = p_shop and key = p_key); end $$;

create or replace function mt_acct_get(p_token text, p_shop uuid, p_phone text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); return (select data from mt_accounts where shop_id = p_shop and phone = p_phone); end $$;
create or replace function mt_acct_put(p_token text, p_shop uuid, p_phone text, p_data jsonb, p_new boolean) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token);
  if p_new then
    insert into mt_accounts (shop_id, phone, data) values (p_shop, p_phone, p_data) on conflict do nothing;
    if not found then return jsonb_build_object('ok', false, 'exists', true); end if;
  else
    update mt_accounts set data = p_data, updated_at = now() where shop_id = p_shop and phone = p_phone;
    if not found then return jsonb_build_object('ok', false, 'missing', true); end if;
  end if;
  return jsonb_build_object('ok', true); end $$;
create or replace function mt_acct_list(p_token text, p_shop uuid) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('phone', phone, 'name', data->>'name', 'email', coalesce(data->>'email',''), 'region', coalesce(data->>'region',''),
    'branch', coalesce(data->>'branch',''), 'created', created_at, 'orders', coalesce(jsonb_array_length(data->'orders'),0), 'blocked', coalesce((data->>'blocked')::boolean, false)) order by created_at desc)
    from mt_accounts where shop_id = p_shop), '[]'::jsonb); end $$;

-- Each shop's own Paystack key and USMS-GH SMS account (pasted by the shop owner in the app).
create or replace function mt_ssecret_get(p_token text, p_shop uuid, p_name text) returns text language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); return (select value from mt_ssecrets where shop_id = p_shop and name = p_name); end $$;
create or replace function mt_ssecret_set(p_token text, p_shop uuid, p_name text, p_value text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token);
  if p_name not in ('paystack_secret','usms_token','usms_sender') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_value is null or p_value = '' then delete from mt_ssecrets where shop_id = p_shop and name = p_name;
  else
    if p_name = 'paystack_secret' and p_value !~ '^sk_(test|live)_[A-Za-z0-9]{20,100}$' then raise exception 'bad key' using errcode = '22023'; end if;
    if p_name = 'usms_token' and p_value !~ '^[0-9]+\|[A-Za-z0-9]{20,120}$' then raise exception 'bad token' using errcode = '22023'; end if;
    if p_name = 'usms_sender' and p_value !~ '^[A-Za-z0-9 ]{2,11}$' then raise exception 'bad sender' using errcode = '22023'; end if;
    insert into mt_ssecrets (shop_id, name, value) values (p_shop, p_name, p_value) on conflict (shop_id, name) do update set value = excluded.value, updated_at = now();
  end if;
  return jsonb_build_object('ok', true); end $$;

create or replace function mt_otp_set(p_token text, p_shop uuid, p_k text, p_h text, p_minutes int) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token);
  delete from mt_otp where exp < now() - interval '1 day';
  insert into mt_otp (shop_id, k, h, exp, tries, sent) values (p_shop, p_k, p_h, now() + make_interval(mins => greatest(1, least(p_minutes, 60))), 0, now())
  on conflict (shop_id, k) do update set h = excluded.h, exp = excluded.exp, tries = 0, sent = now();
  return jsonb_build_object('ok', true); end $$;
create or replace function mt_otp_get(p_token text, p_shop uuid, p_k text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v record;
begin perform _mt_check(p_token);
  select h, exp, tries, sent into v from mt_otp where shop_id = p_shop and k = p_k; if not found then return null; end if;
  return jsonb_build_object('h', v.h, 'exp', extract(epoch from v.exp) * 1000, 'tries', v.tries, 'sent', extract(epoch from v.sent) * 1000); end $$;
create or replace function mt_otp_mark(p_token text, p_shop uuid, p_k text, p_try boolean) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token);
  if p_try then update mt_otp set tries = tries + 1 where shop_id = p_shop and k = p_k; else delete from mt_otp where shop_id = p_shop and k = p_k; end if;
  return jsonb_build_object('ok', true); end $$;

-- Paid online orders: only one server process records each order, and stock never goes below zero.
create or replace function mt_order_claim(p_token text, p_shop uuid, p_ref text) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin perform _mt_check(p_token);
  perform pg_advisory_xact_lock(hashtext(p_shop::text));
  update mt_docs set d = jsonb_set(d, '{status}', '"processing"'), rev = _mt_rev(p_shop)
   where shop_id = p_shop and c = 'webOrders' and id = p_ref and not x and d->>'status' = 'pending';
  get diagnostics n = row_count; return n = 1; end $$;
create or replace function mt_stock_take(p_token text, p_shop uuid, p_col text, p_id text, p_qty numeric) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v jsonb;
begin perform _mt_check(p_token);
  if p_col not in ('products','accra_products') then raise exception 'bad collection' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext(p_shop::text));
  update mt_docs set d = jsonb_set(d, '{stock}', to_jsonb(coalesce((d->>'stock')::numeric, 0) - p_qty)), rev = _mt_rev(p_shop)
   where shop_id = p_shop and c = p_col and id = p_id and not x and (p_qty < 0 or coalesce((d->>'stock')::numeric, 0) >= p_qty)
  returning d into v;
  return v; end $$;

-- A job done once (e.g. one credit reminder per customer per day), even with several server processes.
create or replace function mt_job_once(p_token text, p_shop uuid, p_k text) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin perform _mt_check(p_token);
  if random() < 0.01 then delete from mt_jobs where at < now() - interval '120 days'; end if;
  insert into mt_jobs (shop_id, k) values (p_shop, left(p_k, 200)) on conflict do nothing;
  get diagnostics n = row_count; return n > 0; end $$;

revoke all on function mt_photo_put, mt_photo_get, mt_acct_get, mt_acct_put, mt_acct_list, mt_ssecret_get, mt_ssecret_set, mt_otp_set, mt_otp_get, mt_otp_mark, mt_order_claim, mt_stock_take, mt_job_once from public, anon, authenticated;
grant execute on function mt_photo_put, mt_photo_get, mt_acct_get, mt_acct_put, mt_acct_list, mt_ssecret_get, mt_ssecret_set, mt_otp_set, mt_otp_get, mt_otp_mark, mt_order_claim, mt_stock_take, mt_job_once to anon;

-- Shared SMS account (platform owner's USMS-GH, from site_secrets) for shops without their own; switch kept in mt_kv 'shared_sms'.
create or replace function mt_kv_get(p_token text, p_k text) returns text language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); if p_k not in ('admin_pw','shared_sms') then return null; end if; return (select v from mt_kv where k = p_k); end $$;
create or replace function mt_kv_set(p_token text, p_k text, p_v text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin perform _mt_check(p_token); if p_k not in ('admin_pw','shared_sms') then raise exception 'unknown key'; end if;
  insert into mt_kv (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v, updated_at = now();
  return jsonb_build_object('ok', true); end $$;
create or replace function mt_shared_sms(p_token text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare cfg jsonb; tok text; snd text;
begin perform _mt_check(p_token);
  cfg := coalesce((select v::jsonb from mt_kv where k = 'shared_sms'), '{"on":false,"off":[]}'::jsonb);
  select value into tok from site_secrets where name = 'usms_token';
  select value into snd from site_secrets where name = 'usms_sender';
  return jsonb_build_object('on', coalesce((cfg->>'on')::boolean, false), 'off', coalesce(cfg->'off', '[]'::jsonb), 'sender', coalesce(snd, ''), 'ready', tok is not null and snd is not null,
    'token', case when coalesce((cfg->>'on')::boolean, false) then tok else null end);
end $$;
revoke all on function mt_shared_sms from public, anon, authenticated;
grant execute on function mt_shared_sms to anon;
