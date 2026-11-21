-- SMS allowance for shops that use the platform's shared SMS account (USMS-GH).
-- Every shop gets a free number of SMS each calendar month (shared_sms.free, default 10).
-- A paid plan adds more: mt_shops.sms_plan SMS per month while mt_shops.sms_until is in the future.
-- Shops with their own USMS-GH token are not counted. Months follow Ghana time (= UTC).
-- Run once in the Supabase SQL editor (already applied to the renatel-shop project).

alter table mt_shops add column if not exists sms_plan integer not null default 0;
alter table mt_shops add column if not exists sms_until timestamptz;

create table if not exists mt_sms (
  shop_id uuid not null references mt_shops(id) on delete cascade,
  ym text not null,             -- 'YYYY-MM'
  used integer not null default 0,
  primary key (shop_id, ym)
);
alter table mt_sms enable row level security;

-- Free SMS per month, from the shared SMS settings.
create or replace function _mt_sms_free() returns integer language sql stable security definer set search_path = public, extensions as $$
  select greatest(0, coalesce(((select v from mt_kv where k = 'shared_sms')::jsonb->>'free')::integer, 10));
$$;
revoke all on function _mt_sms_free() from public, anon, authenticated;

-- Take p_n SMS from this month's allowance (all or nothing). A negative p_n gives SMS back (a send that failed).
-- Returns {ok, used, limit, free, plan, until}.
create or replace function mt_sms_take(p_token text, p_shop uuid, p_n integer) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_ym text := to_char(now() at time zone 'UTC', 'YYYY-MM'); v_free int; v_plan int := 0; v_until timestamptz; v_lim int; v_used int; v_ok boolean := true;
begin
  perform _mt_check(p_token);
  v_free := _mt_sms_free();
  select case when sms_until > now() then sms_plan else 0 end, sms_until into v_plan, v_until from mt_shops where id = p_shop;
  if not found then return jsonb_build_object('ok', false, 'error', 'no shop'); end if;
  v_lim := v_free + coalesce(v_plan, 0);
  insert into mt_sms (shop_id, ym, used) values (p_shop, v_ym, 0) on conflict do nothing;
  select used into v_used from mt_sms where shop_id = p_shop and ym = v_ym for update;
  if coalesce(p_n, 0) > 0 and v_used + p_n > v_lim then v_ok := false;
  elsif coalesce(p_n, 0) <> 0 then
    update mt_sms set used = greatest(0, used + p_n) where shop_id = p_shop and ym = v_ym returning used into v_used;
  end if;
  return jsonb_build_object('ok', v_ok, 'used', v_used, 'limit', v_lim, 'free', v_free, 'plan', coalesce(v_plan, 0), 'until', v_until);
end $$;
revoke all on function mt_sms_take(text, uuid, integer) from public, anon, authenticated;
grant execute on function mt_sms_take(text, uuid, integer) to service_role;

-- This month's use for every shop (platform admin list).
create or replace function mt_sms_usage(p_token text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_ym text := to_char(now() at time zone 'UTC', 'YYYY-MM'); v_free int;
begin
  perform _mt_check(p_token);
  v_free := _mt_sms_free();
  return coalesce((select jsonb_object_agg(s.id, jsonb_build_object('used', coalesce(u.used, 0), 'plan', case when s.sms_until > now() then s.sms_plan else 0 end,
      'limit', v_free + case when s.sms_until > now() then s.sms_plan else 0 end, 'until', s.sms_until, 'planSet', s.sms_plan))
    from mt_shops s left join mt_sms u on u.shop_id = s.id and u.ym = v_ym), '{}'::jsonb);
end $$;
revoke all on function mt_sms_usage(text) from public, anon, authenticated;
grant execute on function mt_sms_usage(text) to service_role;

-- Shop settings: sms_plan and sms_until can now be set too.
create or replace function mt_shop_set(p_token text, p_id uuid, p_patch jsonb) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r mt_shops;
begin
  perform _mt_check(p_token);
  update mt_shops set
    status = case when p_patch ? 'status' then p_patch->>'status' else status end,
    trial_ends = case when p_patch ? 'trial_ends' then (p_patch->>'trial_ends')::timestamptz else trial_ends end,
    paid_until = case when p_patch ? 'paid_until' then (p_patch->>'paid_until')::timestamptz else paid_until end,
    note = case when p_patch ? 'note' then p_patch->>'note' else note end,
    sms_plan = case when p_patch ? 'sms_plan' then greatest(0, (p_patch->>'sms_plan')::integer) else sms_plan end,
    sms_until = case when p_patch ? 'sms_until' then (p_patch->>'sms_until')::timestamptz else sms_until end
  where id = p_id returning * into r;
  return to_jsonb(r);
end $$;

-- Shared SMS settings now also carry the free allowance and the paid plans.
create or replace function mt_shared_sms(p_token text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare cfg jsonb; tok text; snd text;
begin perform _mt_check(p_token);
  cfg := coalesce((select v::jsonb from mt_kv where k = 'shared_sms'), '{"on":false,"off":[]}'::jsonb);
  select value into tok from site_secrets where name = 'usms_token';
  select value into snd from site_secrets where name = 'usms_sender';
  return jsonb_build_object('on', coalesce((cfg->>'on')::boolean, false), 'off', coalesce(cfg->'off', '[]'::jsonb), 'sender', coalesce(snd, ''), 'ready', tok is not null and snd is not null,
    'free', _mt_sms_free(),
    'plans', coalesce(cfg->'plans', '[{"gh":30,"sms":300},{"gh":60,"sms":700},{"gh":120,"sms":1500}]'::jsonb),
    'token', case when coalesce((cfg->>'on')::boolean, false) then tok else null end);
end $$;

-- SMS plan orders: the shop pays by MoMo, enters the transaction ID in the POS, and the platform admin confirms or declines.
create table if not exists mt_sms_orders (
  id bigserial primary key,
  shop_id uuid not null references mt_shops(id) on delete cascade,
  gh numeric(10,2) not null, sms integer not null, months integer not null default 1,
  txid text not null, payer text not null default '', phone text not null default '', by_name text not null default '',
  status text not null default 'pending',  -- pending | approved | declined
  note text not null default '',
  at timestamptz not null default now(), done_at timestamptz
);
create index if not exists mt_sms_orders_shop on mt_sms_orders (shop_id, at desc);
alter table mt_sms_orders enable row level security;

create or replace function mt_sms_order_add(p_token text, p_shop uuid, p_o jsonb) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r mt_sms_orders;
begin
  perform _mt_check(p_token);
  if (select count(*) from mt_sms_orders where shop_id = p_shop and status = 'pending') >= 3 then return jsonb_build_object('error', 'You already have 3 orders waiting. Wait until they are confirmed.'); end if;
  if exists (select 1 from mt_sms_orders where lower(txid) = lower(p_o->>'txid') and status <> 'declined') then return jsonb_build_object('error', 'This transaction ID was already sent.'); end if;
  insert into mt_sms_orders (shop_id, gh, sms, months, txid, payer, phone, by_name)
  values (p_shop, (p_o->>'gh')::numeric, (p_o->>'sms')::integer, greatest(1, least(12, coalesce((p_o->>'months')::integer, 1))), left(p_o->>'txid', 60), left(coalesce(p_o->>'payer', ''), 80), left(coalesce(p_o->>'phone', ''), 20), left(coalesce(p_o->>'by', ''), 80))
  returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function mt_sms_order_add(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function mt_sms_order_add(text, uuid, jsonb) to service_role;

-- One shop's orders (p_shop given) or every shop's (p_shop null), newest first.
create or replace function mt_sms_order_list(p_token text, p_shop uuid) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _mt_check(p_token);
  return coalesce((select jsonb_agg(x order by x.at desc) from (
    select o.*, s.name as shop_name, s.slug, s.phone as shop_phone from mt_sms_orders o join mt_shops s on s.id = o.shop_id
    where (p_shop is null or o.shop_id = p_shop) and (p_shop is not null or o.status = 'pending' or o.at > now() - interval '60 days')
    order by o.at desc limit 200) x), '[]'::jsonb);
end $$;
revoke all on function mt_sms_order_list(text, uuid) from public, anon, authenticated;
grant execute on function mt_sms_order_list(text, uuid) to service_role;

-- Confirm or decline a pending order (only once).
create or replace function mt_sms_order_set(p_token text, p_id bigint, p_status text, p_note text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r mt_sms_orders;
begin
  perform _mt_check(p_token);
  if p_status not in ('approved', 'declined') then raise exception 'bad status'; end if;
  update mt_sms_orders set status = p_status, note = left(coalesce(p_note, ''), 200), done_at = now() where id = p_id and status = 'pending' returning * into r;
  if r.id is null then return jsonb_build_object('error', 'This order was already handled.'); end if;
  return to_jsonb(r);
end $$;
revoke all on function mt_sms_order_set(text, bigint, text, text) from public, anon, authenticated;
grant execute on function mt_sms_order_set(text, bigint, text, text) to service_role;
