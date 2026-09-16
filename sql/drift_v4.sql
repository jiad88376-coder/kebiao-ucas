-- ============================================================
-- 漂流瓶 v4 迁移：接一句（回复）+ 事件通知（被接 / 被共鸣都推给瓶主）
-- 幂等，可重复执行；不删数据
--
-- 1) push_jobs 增加 kind 列：
--      'plan'  = 设备本地重算的计划任务（旧数据自动归此类）
--      'event' = 事件触发的即时通知（被接一句 / 被共鸣）
--    push_replace_jobs 只重写 'plan'，**事件任务不会被设备重算冲掉**
--    投递脚本 push-sender.mjs 按 due_at 扫描，不区分 kind，无需改动
-- 2) 新表 drift_replies：「接一句」——对捞到的瓶子留一句单向公开度受限的回应
--      unique(bottle_id, did)：同一设备对同一瓶只能接一句
-- 3) 新 RPC drift_reply：必须**捞到过**该瓶才能接一句（内容供给的门槛）；≤50 字
-- 4) drift_like 改造：给瓶主发「收到新的共鸣」通知（同一瓶未送达前只提醒一次）
-- 5) drift_mine 扩展：replies 明细 + 计数；thrown 每瓶带回复数
-- 6) drift_fish 返回加 replied（该设备是否已接过这句）
--
-- 通知路由：push_subscriptions.did = 瓶主的设备号 ⇒ 同一设备多个 endpoint 都会收到
-- ============================================================

-- ------------------------------------------------------------
-- 1) push_jobs.kind + push_replace_jobs 只重写计划任务
-- ------------------------------------------------------------
alter table public.push_jobs add column if not exists kind text not null default 'plan';

create or replace function public.push_replace_jobs(p_endpoint text, p_jobs jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_endpoint is null or not exists (select 1 from push_subscriptions where endpoint = p_endpoint) then
    raise exception 'unknown endpoint';
  end if;
  /* 只清计划任务；事件通知（被接一句/被共鸣）保留 */
  delete from push_jobs where endpoint = p_endpoint and kind = 'plan';
  insert into push_jobs (endpoint, due_at, title, body, url, tag, kind)
  select p_endpoint,
         (j->>'due_at')::timestamptz,
         left(coalesce(j->>'title', '课壳提醒'), 120),
         left(coalesce(j->>'body', ''), 400),
         left(coalesce(j->>'url', './'), 200),
         left(coalesce(j->>'tag', ''), 80),
         'plan'
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) as j
  where (j->>'due_at') is not null
    and (j->>'due_at')::timestamptz > now() - interval '1 hour'
  limit 400;
end $$;

-- ------------------------------------------------------------
-- 2) 回复表
-- ------------------------------------------------------------
create table if not exists public.drift_replies (
  id         bigint generated always as identity primary key,
  bottle_id  bigint not null references public.drift_bottles(id) on delete cascade,
  did        text   not null,
  content    text   not null,
  created_at timestamptz not null default now(),
  unique (bottle_id, did)
);
create index if not exists idx_drift_replies_bottle on public.drift_replies (bottle_id);
alter table public.drift_replies enable row level security;

-- ------------------------------------------------------------
-- 3) 接一句：必须捞到过该瓶；每设备每瓶一句；≤50 字；通知瓶主
-- ------------------------------------------------------------
create or replace function public.drift_reply(
  p_did       text,
  p_bottle_id bigint,
  p_content   text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  b     record;
  v_id  bigint;
begin
  if p_did is null or char_length(p_did) < 1 or char_length(p_did) > 64 then
    raise exception 'bad did';
  end if;
  if p_bottle_id is null then
    raise exception 'bad bottle';
  end if;
  if p_content is null or btrim(p_content) = '' then
    raise exception 'empty content';
  end if;

  select * into b from drift_bottles where id = p_bottle_id;
  if not found then
    raise exception 'bad bottle';
  end if;
  if b.did = p_did then
    raise exception 'own bottle';
  end if;
  /* 门槛：只有捞到过这个瓶子的人才能接一句（回答质量由「被随机捞到」筛选过） */
  if not exists (select 1 from drift_fished f
                  where f.did = p_did and f.bottle_id = p_bottle_id) then
    raise exception 'not fished';
  end if;

  insert into drift_replies (bottle_id, did, content)
  values (p_bottle_id, p_did, left(btrim(p_content), 50))
  returning id into v_id;

  /* 事件通知：投递脚本按 due_at 扫描，会被送达后删除；
     设备重算任务不会冲掉它（kind='event'） */
  insert into push_jobs (endpoint, due_at, title, body, url, tag, kind)
  select s.endpoint, now(),
         '漂流瓶 · 有人接了你一句',
         left(btrim(p_content), 50),
         './?view=msg',
         'r-' || v_id::text,
         'event'
    from push_subscriptions s
   where s.did = b.did
   on conflict (endpoint, tag, due_at) do nothing;
end $$;

-- ------------------------------------------------------------
-- 4) 共鸣通知：同一瓶「未送达前只提醒一次」，送达后新共鸣可再提醒
-- ------------------------------------------------------------
create or replace function public.drift_like(
  p_did       text,
  p_bottle_id bigint
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_rows int;
  v_new  int;
begin
  if p_did is null or char_length(p_did) < 1 or char_length(p_did) > 64 then
    raise exception 'bad did';
  end if;
  if p_bottle_id is null then
    raise exception 'bad bottle';
  end if;

  insert into drift_likes (did, bottle_id) values (p_did, p_bottle_id)
  on conflict (did, bottle_id) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    update drift_bottles set likes = likes + 1 where id = p_bottle_id;

    /* 通知瓶主（不是自己的瓶；同一瓶存在未送达通知时跳过，避免刷屏） */
    insert into push_jobs (endpoint, due_at, title, body, url, tag, kind)
    select s.endpoint, now(),
           '漂流瓶 · 收到新的共鸣',
           left(b.content, 40),
           './?view=msg',
           'l-' || b.id::text,
           'event'
      from drift_bottles b
      join push_subscriptions s on s.did = b.did
     where b.id = p_bottle_id
       and b.did <> p_did
       and not exists (select 1 from push_jobs j
                        where j.endpoint = s.endpoint
                          and j.tag = 'l-' || b.id::text)
    on conflict (endpoint, tag, due_at) do nothing;
  end if;

  select likes into v_new from drift_bottles where id = p_bottle_id;
  return coalesce(v_new, 0);
end $$;

-- ------------------------------------------------------------
-- 5) drift_mine 升级：加 replies 明细与计数；thrown 每瓶带回复数
-- ------------------------------------------------------------
create or replace function public.drift_mine(p_did text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_thrown      jsonb;
  v_fished      jsonb;
  v_replies     jsonb;
  v_likes       int;
  v_reply_total int;
begin
  if p_did is null or char_length(p_did) < 1 or char_length(p_did) > 64 then
    raise exception 'bad did';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',         b.id,
           'topic_date', b.topic_date,
           'topic_key',  b.topic_key,
           'content',    b.content,
           'likes',      b.likes,
           'replies',    (select count(*) from drift_replies r where r.bottle_id = b.id),
           'created_at', b.created_at
         ) order by b.created_at desc), '[]'::jsonb)
    into v_thrown
    from (select id, topic_date, topic_key, content, likes, created_at
            from drift_bottles
           where did = p_did
           order by created_at desc
           limit 200) b;

  select coalesce(jsonb_agg(jsonb_build_object(
           'bottle_id',  f.bottle_id,
           'fished_at',  f.fished_at,
           'content',    b.content,
           'topic_date', b.topic_date,
           'topic_key',  b.topic_key,
           'likes',      b.likes,
           'liked',      exists (select 1 from drift_likes l
                                       where l.did = p_did and l.bottle_id = f.bottle_id)
         ) order by f.fished_at desc), '[]'::jsonb)
    into v_fished
    from (select f.bottle_id, f.fished_at, f.did
            from drift_fished f
           where f.did = p_did
           order by f.fished_at desc
           limit 200) f
    join drift_bottles b on b.id = f.bottle_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'content',      r.content,
           'created_at',   r.created_at,
           'bottle_id',    b.id,
           'bottle_excerpt', left(b.content, 30),
           'topic_date',   b.topic_date,
           'topic_key',    b.topic_key
         ) order by r.created_at desc), '[]'::jsonb)
    into v_replies
    from (select r.bottle_id, r.content, r.created_at
            from drift_replies r
           where r.bottle_id in (select id from drift_bottles where did = p_did)
           order by r.created_at desc
           limit 100) r
    join drift_bottles b on b.id = r.bottle_id;

  select count(*) into v_reply_total
    from drift_replies r
   where r.bottle_id in (select id from drift_bottles where did = p_did);

  select coalesce(sum(b.likes), 0) into v_likes
    from drift_bottles b where b.did = p_did;

  return jsonb_build_object(
    'thrown',        v_thrown,
    'fished',        v_fished,
    'likes_total',   coalesce(v_likes, 0),
    'replies',       v_replies,
    'replies_total', coalesce(v_reply_total, 0)
  );
end $$;

-- ------------------------------------------------------------
-- 6) drift_fish 返回 replied（该设备是否已接过这句）
-- ------------------------------------------------------------
drop function if exists public.drift_fish(text, date, uuid);

create or replace function public.drift_fish(
  p_did        text,
  p_topic_date date,
  p_user       uuid default null
) returns table (bottle_id bigint, content text, likes int, topic_key text, replied boolean, egg boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_id     bigint;
  v_level  int;
  v_quota  int;
  v_fished int;
  i        int;
begin
  if p_did is null or char_length(p_did) < 1 or char_length(p_did) > 64 then
    raise exception 'bad did';
  end if;
  if p_topic_date is null
     or p_topic_date <> (now() at time zone 'Asia/Shanghai')::date then
    raise exception 'not today';
  end if;

  v_level := drift_level(p_did, p_user);
  v_quota := drift_quota_of(v_level);
  select count(*) into v_fished from drift_fished f
   where f.did = p_did
     and (f.fished_at at time zone 'Asia/Shanghai')::date
       = (now() at time zone 'Asia/Shanghai')::date;
  if v_fished >= v_quota then
    return query select null::bigint, null::text, null::int, null::text, null::boolean, true;
    return;
  end if;

  for i in 1..20 loop
    select b.id into v_id
      from drift_bottles b
     where b.topic_date = p_topic_date
       and b.did <> p_did
       and not exists (select 1 from drift_fished f
                        where f.did = p_did and f.bottle_id = b.id)
     order by random()
     limit 1;

    if v_id is null then
      return query select null::bigint, null::text, null::int, null::text, null::boolean, true;
      return;
    end if;

    begin
      insert into drift_fished (did, bottle_id) values (p_did, v_id);
      return query select b.id, b.content, b.likes, b.topic_key,
                          exists (select 1 from drift_replies r
                                   where r.bottle_id = b.id and r.did = p_did),
                          false
                     from drift_bottles b where b.id = v_id;
      return;
    exception when unique_violation then
      v_id := null;
    end;
  end loop;

  return query select null::bigint, null::text, null::int, null::text, null::boolean, true;
end $$;

-- ------------------------------------------------------------
-- 授权
-- ------------------------------------------------------------
revoke all on function public.drift_reply(text, bigint, text) from public;
grant execute on function public.drift_reply(text, bigint, text) to anon, authenticated;
