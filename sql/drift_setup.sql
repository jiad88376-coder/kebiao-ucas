-- ============================================================
-- 漂流瓶（匿名话题作答 + 随机捞瓶）建表脚本（在 Supabase SQL Editor 执行一次）
-- 1) drift_bottles 投稿瓶：每设备每天 1 瓶，纯文本 ≤100 字
-- 2) drift_fished  捞取记录：同设备永不重复捞同一瓶；同时是每日额度的唯一计数来源
-- 3) drift_likes   共鸣记录：**独立成表**，绝不能写入 drift_fished
--
-- 为什么点赞要单独一张表：
--   额度 = 3 × 今日投稿数 − 今日捞取数。点赞若写进 drift_fished，
--   那么「在墙上给昨天的瓶子点赞」会凭空吃掉今天的 1 次捞瓶额度，
--   而且那个瓶子会被当成"已捞"从池子里消失。两件事必须解耦。
--
-- 三张表对 anon/authenticated 全锁（开 RLS 且不建任何策略），前端只能走下面的
-- SECURITY DEFINER 函数。匿名场景拿不到 auth.uid()，因此不建防伪造触发器，
-- 完整性由 RPC 内的参数校验 + 计数 + 唯一约束保证，不信任前端任何计数值。
--
-- 时区口径：服务端一律用 Asia/Shanghai 判定"今天"，越界即封盘。
-- ============================================================

create table if not exists public.drift_bottles (
  id         bigint generated always as identity primary key,
  topic_date date not null,
  did        text not null check (char_length(did) between 1 and 64),
  content    text not null check (char_length(content) between 1 and 100),
  likes      int  not null default 0,
  created_at timestamptz not null default now(),
  unique (did, topic_date)              -- 每设备每天只能投 1 瓶
);
create index if not exists idx_drift_bottles_topic on public.drift_bottles (topic_date, id);

create table if not exists public.drift_fished (
  did       text   not null check (char_length(did) between 1 and 64),
  bottle_id bigint not null references public.drift_bottles(id) on delete cascade,
  fished_at timestamptz not null default now(),
  primary key (did, bottle_id)          -- 同设备不重复捞
);

create table if not exists public.drift_likes (
  did       text   not null check (char_length(did) between 1 and 64),
  bottle_id bigint not null references public.drift_bottles(id) on delete cascade,
  liked_at  timestamptz not null default now(),
  primary key (did, bottle_id)          -- 同设备对同一瓶只计 1 次
);

alter table public.drift_bottles enable row level security;
alter table public.drift_fished  enable row level security;
alter table public.drift_likes   enable row level security;

-- ------------------------------------------------------------
-- 内部工具：算某设备今天的剩余捞瓶额度
-- 规则：3 × 今日投稿数，封顶 5，减去今日已捞数，不为负
-- 不 grant 给 anon（只由下面的 RPC 内部调用）
-- ------------------------------------------------------------
create or replace function public.drift_quota(
  p_did        text,
  p_topic_date date
) returns int
language sql stable security definer set search_path = public as $$
  select greatest(0, least(5, 3 * (
           select count(*) from drift_bottles b
            where b.did = p_did and b.topic_date = p_topic_date
         )) - (
           select count(*) from drift_fished f
            where f.did = p_did
              and (f.fished_at at time zone 'Asia/Shanghai')::date
                = (now() at time zone 'Asia/Shanghai')::date
         ));
$$;

-- ------------------------------------------------------------
-- 投稿：每设备每天 1 瓶；只能投"今天"（越过 24:00 自然封盘）
-- ------------------------------------------------------------
create or replace function public.drift_submit(
  p_did        text,
  p_topic_date date,
  p_content    text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_did is null or char_length(p_did) < 1 or char_length(p_did) > 64 then
    raise exception 'bad did';
  end if;
  if p_topic_date is null
     or p_topic_date <> (now() at time zone 'Asia/Shanghai')::date then
    raise exception 'not today';
  end if;
  if p_content is null or btrim(p_content) = '' then
    raise exception 'empty content';
  end if;

  begin
    insert into drift_bottles (topic_date, did, content)
    values (p_topic_date, p_did, left(btrim(p_content), 100));
  exception when unique_violation then
    raise exception 'already answered';
  end;
end $$;

-- ------------------------------------------------------------
-- 捞瓶：随机取一条今日话题下、别人投的、本设备没捞过的瓶子
-- 返回 egg=true 表示"没捞到"（额度为 0，或池子已空），前端据此显示彩蛋文案
-- ------------------------------------------------------------
create or replace function public.drift_fish(
  p_did        text,
  p_topic_date date
) returns table (bottle_id bigint, content text, likes int, egg boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_id    bigint;
  v_quota int;
  i       int;
begin
  if p_did is null or char_length(p_did) < 1 or char_length(p_did) > 64 then
    raise exception 'bad did';
  end if;
  if p_topic_date is null
     or p_topic_date <> (now() at time zone 'Asia/Shanghai')::date then
    raise exception 'not today';
  end if;

  v_quota := drift_quota(p_did, p_topic_date);
  if v_quota <= 0 then
    return query select null::bigint, null::text, null::int, true;
    return;
  end if;

  /* 最多重试 20 次：唯一约束冲突（并发竞态）时重选 */
  for i in 1..20 loop
    select b.id into v_id
      from drift_bottles b
     where b.topic_date = p_topic_date
       and b.did <> p_did                 -- 不捞自己投的
       and not exists (select 1 from drift_fished f
                        where f.did = p_did and f.bottle_id = b.id)
     order by random()
     limit 1;

    if v_id is null then
      return query select null::bigint, null::text, null::int, true;
      return;
    end if;

    begin
      insert into drift_fished (did, bottle_id) values (p_did, v_id);
      return query select b.id, b.content, b.likes, false
                     from drift_bottles b where b.id = v_id;
      return;
    exception when unique_violation then
      v_id := null;                       -- 被别人抢先：重选
    end;
  end loop;

  return query select null::bigint, null::text, null::int, true;
end $$;

-- ------------------------------------------------------------
-- 共鸣：幂等。同一设备对同一瓶只 +1 一次；不消耗也不影响捞瓶额度
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
  end if;

  select likes into v_new from drift_bottles where id = p_bottle_id;
  return coalesce(v_new, 0);
end $$;

-- ------------------------------------------------------------
-- 状态：额度 + 昨日最共鸣 Top3（上墙）
-- wall 只取前 3 名，不暴露长尾（写了没人共鸣的人不该被公开）
-- ------------------------------------------------------------
create or replace function public.drift_status(
  p_did        text,
  p_topic_date date
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_answered int;
  v_fished   int;
  v_wall     jsonb;
begin
  if p_did is null or char_length(p_did) < 1 or char_length(p_did) > 64 then
    raise exception 'bad did';
  end if;
  if p_topic_date is null then
    raise exception 'bad date';
  end if;

  select count(*) into v_answered
    from drift_bottles b
   where b.did = p_did and b.topic_date = p_topic_date;

  select count(*) into v_fished
    from drift_fished f
   where f.did = p_did
     and (f.fished_at at time zone 'Asia/Shanghai')::date
       = (now() at time zone 'Asia/Shanghai')::date;

  select coalesce(jsonb_agg(jsonb_build_object('content', t.content, 'likes', t.likes)
                            order by t.likes desc, t.created_at asc), '[]'::jsonb)
    into v_wall
    from (select content, likes, created_at
            from drift_bottles
           where topic_date = p_topic_date - 1
           order by likes desc, created_at asc
           limit 3) t;

  return jsonb_build_object(
    'answered', v_answered,
    'fished',   v_fished,
    'quota',    greatest(0, least(5, 3 * v_answered) - v_fished),
    'wall',     v_wall
  );
end $$;

-- ------------------------------------------------------------
-- 授权：先收回 public，再只把 4 个对外函数授予 anon/authenticated
-- （drift_quota 是内部工具，不授予）
-- ------------------------------------------------------------
revoke all on function public.drift_quota(text, date) from public;
revoke all on function public.drift_submit(text, date, text) from public;
revoke all on function public.drift_fish(text, date) from public;
revoke all on function public.drift_like(text, bigint) from public;
revoke all on function public.drift_status(text, date) from public;

grant execute on function public.drift_submit(text, date, text) to anon, authenticated;
grant execute on function public.drift_fish(text, date) to anon, authenticated;
grant execute on function public.drift_like(text, bigint) to anon, authenticated;
grant execute on function public.drift_status(text, date) to anon, authenticated;
