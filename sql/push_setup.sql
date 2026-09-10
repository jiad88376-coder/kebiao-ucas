-- ============================================================
-- 消息提醒（Web Push）建表脚本（在 Supabase SQL Editor 执行一次）
-- 1) push_subscriptions 设备订阅（endpoint 即秘密，只有浏览器的推送服务知道）
-- 2) push_jobs          到点待发的提醒任务（由前端按本地课表算好写入）
-- 3) RPC                前端只经 RPC 读写，两张表对 anon/authenticated 全锁
-- 发送端：GitHub Actions（scripts/push_sender.mjs）用 service_role key 读取并投递
-- ============================================================

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid references auth.users(id) on delete set null,
  did text,
  p256dh text not null,
  auth text not null,
  prefs jsonb not null default '{"morning":true,"ddl":true,"weekly":true}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.push_jobs (
  id bigint generated always as identity primary key,
  endpoint text not null references public.push_subscriptions(endpoint) on delete cascade,
  due_at timestamptz not null,
  title text not null,
  body text not null default '',
  url text not null default './',
  tag text not null default '',
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  unique (endpoint, tag, due_at)
);
create index if not exists idx_push_jobs_due on public.push_jobs (due_at);

-- 两张表：开启 RLS 且不建任何策略 → anon/authenticated 一律不可直接读写；
-- service_role（发送端）绕过 RLS。前端只能通过下面的 SECURITY DEFINER 函数操作。
alter table public.push_subscriptions enable row level security;
alter table public.push_jobs enable row level security;

-- 注册/更新本设备的订阅（endpoint 是随机的推送服务地址，天然作为凭证）
create or replace function public.push_upsert_sub(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_did text default null,
  p_prefs jsonb default '{}'::jsonb,
  p_user uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_endpoint is null or length(p_endpoint) < 20 or length(p_endpoint) > 800 then
    raise exception 'bad endpoint';
  end if;
  if p_p256dh is null or p_auth is null or length(p_p256dh) > 200 or length(p_auth) > 100 then
    raise exception 'bad keys';
  end if;
  insert into push_subscriptions (endpoint, user_id, did, p256dh, auth, prefs, updated_at)
  values (p_endpoint, p_user, left(coalesce(p_did, ''), 64), p_p256dh, p_auth, coalesce(p_prefs, '{}'::jsonb), now())
  on conflict (endpoint) do update set
    user_id = coalesce(excluded.user_id, push_subscriptions.user_id),
    did = excluded.did,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    prefs = excluded.prefs,
    updated_at = now();
end $$;

-- 注销本设备（订阅删除时任务级联删除）
create or replace function public.push_remove_sub(p_endpoint text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from push_subscriptions where endpoint = p_endpoint;
end $$;

-- 重算提醒任务：先清空该设备未来任务，再批量写入（前端课表变化后调用）
-- p_jobs 数组元素：{due_at, title, body, url, tag}，最多 400 条
create or replace function public.push_replace_jobs(p_endpoint text, p_jobs jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_endpoint is null or not exists (select 1 from push_subscriptions where endpoint = p_endpoint) then
    raise exception 'unknown endpoint';
  end if;
  delete from push_jobs where endpoint = p_endpoint;
  insert into push_jobs (endpoint, due_at, title, body, url, tag)
  select p_endpoint,
         (j->>'due_at')::timestamptz,
         left(coalesce(j->>'title', '课壳提醒'), 120),
         left(coalesce(j->>'body', ''), 400),
         left(coalesce(j->>'url', './'), 200),
         left(coalesce(j->>'tag', ''), 80)
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) as j
  where (j->>'due_at') is not null
    and (j->>'due_at')::timestamptz > now() - interval '1 hour'
  limit 400;
end $$;

revoke all on function public.push_upsert_sub(text, text, text, text, jsonb, uuid) from public;
revoke all on function public.push_remove_sub(text) from public;
revoke all on function public.push_replace_jobs(text, jsonb) from public;
grant execute on function public.push_upsert_sub(text, text, text, text, jsonb, uuid) to anon, authenticated;
grant execute on function public.push_remove_sub(text) to anon, authenticated;
grant execute on function public.push_replace_jobs(text, jsonb) to anon, authenticated;
