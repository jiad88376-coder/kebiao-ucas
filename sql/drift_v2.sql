-- ============================================================
-- 漂流瓶 v2 迁移：每天多话题 + 账户等级配额
-- 幂等，可重复执行；不删表、不丢数据（只加列与加表，不改既有行）
--
-- 1) drift_bottles 增加 topic_key（为空字符串 = 「不拘话题」）
--    并去掉 unique(did, topic_date)，因为现在同一天可以投多次
-- 2) 新建 drift_members：记录连续登录天数与最佳连续，用于判定账户等级
-- 3) 重写 3 个 RPC + 新增 drift_checkin
-- 4) **所有新增参数都带 DEFAULT** ⇒ 旧版前端不做任何改动也能继续调用
--    （旧前端不传 p_user 时按「临时账户」算，升级前端后自动按真实等级）
--
-- 等级与每日配额（服务端权威，前端只显示）：
--   临时账户（未注册）              3 次投 / 3 次捞
--   正式用户（已注册）              5 次投 / 5 次捞
--   高级用户（已注册且连续登录 ≥3 天） 10 次投 / 10 次捞
--
-- 连续登录规则（以「打开 App」为准，由 drift_checkin 维护）：
--   当天已记过 → 不变    昨天记过 → +1
--   间隔 2–3 天 → 宽限，连续天数不变（所以「连续 3 天未登录才掉级」）
--   间隔 > 3 天 → 重置为 1（连续中断，重头再来）
--
-- ⚠️ 「答了才能捞」这条规则在本版中被等级配额取代：投与捞现在互相独立。
--    （原规则是 3 × 今日投稿数 − 今日已捞数，上限 5）
-- ============================================================

-- ------------------------------------------------------------
-- 1) 多话题
-- ------------------------------------------------------------
alter table public.drift_bottles add column if not exists topic_key text not null default '';

-- 原「每设备每天 1 瓶」的唯一约束（名称由 Postgres 自动生成）
alter table public.drift_bottles drop constraint if exists drift_bottles_did_topic_date_key;

-- 便于按话题检索（捞瓶默认跨全部话题，此索引主要服务将来的筛选功能）
create index if not exists idx_drift_bottles_topic_key
  on public.drift_bottles (topic_date, topic_key);

-- ------------------------------------------------------------
-- 2) 成员表：连续登录与等级
-- ------------------------------------------------------------
create table if not exists public.drift_members (
  member_key  text primary key,      -- 'u:<uuid>'（已注册，跨设备保留）或 'd:<did>'（匿名）
  user_id     uuid,
  did         text,
  streak      int  not null default 0,   -- 当前连续登录天数
  best_streak int  not null default 0,   -- 历史最长，仅作展示
  last_day    date,                      -- 最近一次打开 App 的日期（北京时间）
  updated_at  timestamptz not null default now()
);
alter table public.drift_members enable row level security;

-- ------------------------------------------------------------
-- 内部工具（都不授予 anon，仅供下面的 RPC 调用）
-- ------------------------------------------------------------

-- 会员键：已注册按账号（连续天数跨设备保留），未注册按设备
create or replace function public.drift_mkey(p_did text, p_user uuid)
returns text language sql immutable as $$
  select case when p_user is not null
              then 'u:' || p_user::text
              else 'd:' || coalesce(p_did, '') end;
$$;

-- 等级 → 每日可投/可捞次数
create or replace function public.drift_quota_of(p_level int)
returns int language sql immutable as $$
  select case when p_level >= 2 then 10 when p_level = 1 then 5 else 3 end;
$$;

-- 当前等级：0 临时 / 1 正式 / 2 高级
create or replace function public.drift_level(p_did text, p_user uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_streak int;
  v_last   date;
  v_today  date;
begin
  if p_user is null then return 0; end if;          -- 未注册 → 临时账户
  select streak, last_day into v_streak, v_last
    from drift_members where member_key = drift_mkey(p_did, p_user);
  if v_streak is null or v_streak < 3 or v_last is null then return 1; end if;
  v_today := (now() at time zone 'Asia/Shanghai')::date;
  /* 连续 3 天未登录 → 掉级（宽限期 3 天） */
  if v_today - v_last > 3 then return 1; end if;
  return 2;
end $$;

-- ------------------------------------------------------------
-- 签到：每次打开 App 调一次，维护连续登录并返回等级与剩余额度
-- ------------------------------------------------------------
create or replace function public.drift_checkin(
  p_did  text,
  p_user uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_key    text;
  v_streak int;
  v_last   date;
  v_today  date;
  v_level  int;
  v_quota  int;
  v_thrown int;
  v_fished int;
begin
  if p_did is null or char_length(p_did) < 1 or char_length(p_did) > 64 then
    raise exception 'bad did';
  end if;

  v_key   := drift_mkey(p_did, p_user);
  v_today := (now() at time zone 'Asia/Shanghai')::date;

  insert into drift_members (member_key, user_id, did, streak, best_streak, last_day)
  values (v_key, p_user, p_did, 1, 1, v_today)
  on conflict (member_key) do nothing;

  select streak, last_day into v_streak, v_last
    from drift_members where member_key = v_key;

  if v_last is distinct from v_today then
    if v_last = v_today - 1 then
      v_streak := coalesce(v_streak, 0) + 1;        -- 连续
    elsif (v_today - v_last) <= 3 then
      v_streak := coalesce(v_streak, 1);            -- 宽限：连续天数不变
    else
      v_streak := 1;                                -- 断太久，重来
    end if;
  end if;

  update drift_members
     set streak      = v_streak,
         best_streak = greatest(coalesce(best_streak, 0), v_streak),
         last_day    = v_today,
         user_id     = coalesce(p_user, user_id),
         did         = coalesce(p_did, did),
         updated_at  = now()
   where member_key = v_key;

  v_level := drift_level(p_did, p_user);
  v_quota := drift_quota_of(v_level);

  select count(*) into v_thrown from drift_bottles b
   where b.did = p_did and b.topic_date = v_today;
  select count(*) into v_fished from drift_fished f
   where f.did = p_did
     and (f.fished_at at time zone 'Asia/Shanghai')::date = v_today;

  return jsonb_build_object(
    'level',      v_level,
    'streak',     v_streak,
    'quota',      v_quota,
    'thrown',     v_thrown,
    'fished',     v_fished,
    'throw_left', greatest(0, v_quota - v_thrown),
    'fish_left',  greatest(0, v_quota - v_fished)
  );
end $$;

-- ------------------------------------------------------------
-- 投稿：按等级配额限制每日投瓶数；可指定话题（'' = 不拘话题）
-- ------------------------------------------------------------
drop function if exists public.drift_submit(text, date, text);

create or replace function public.drift_submit(
  p_did        text,
  p_topic_date date,
  p_content    text,
  p_topic_key  text default '',
  p_user       uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_level  int;
  v_quota  int;
  v_thrown int;
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

  v_level := drift_level(p_did, p_user);
  v_quota := drift_quota_of(v_level);
  select count(*) into v_thrown from drift_bottles b
   where b.did = p_did and b.topic_date = p_topic_date;
  if v_thrown >= v_quota then
    raise exception 'throw quota used up';
  end if;

  insert into drift_bottles (topic_date, topic_key, did, content)
  values (p_topic_date, left(coalesce(p_topic_key, ''), 40), p_did,
          left(btrim(p_content), 100));
end $$;

-- ------------------------------------------------------------
-- 捞瓶：按等级配额限制每日捞取数；跨全部话题（含「不拘话题」）
-- ------------------------------------------------------------
drop function if exists public.drift_fish(text, date);

create or replace function public.drift_fish(
  p_did        text,
  p_topic_date date,
  p_user       uuid default null
) returns table (bottle_id bigint, content text, likes int, topic_key text, egg boolean)
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
    return query select null::bigint, null::text, null::int, null::text, true;
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
      return query select null::bigint, null::text, null::int, null::text, true;
      return;
    end if;

    begin
      insert into drift_fished (did, bottle_id) values (p_did, v_id);
      return query select b.id, b.content, b.likes, b.topic_key, false
                     from drift_bottles b where b.id = v_id;
      return;
    exception when unique_violation then
      v_id := null;
    end;
  end loop;

  return query select null::bigint, null::text, null::int, null::text, true;
end $$;

-- ------------------------------------------------------------
-- 状态：等级 + 连续天数 + 今日剩余额度 + 昨日最共鸣 Top3
-- ------------------------------------------------------------
drop function if exists public.drift_status(text, date);

create or replace function public.drift_status(
  p_did        text,
  p_topic_date date,
  p_user       uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_level   int;
  v_streak  int;
  v_quota   int;
  v_thrown  int;
  v_fished  int;
  v_wall    jsonb;
begin
  if p_did is null or char_length(p_did) < 1 or char_length(p_did) > 64 then
    raise exception 'bad did';
  end if;
  if p_topic_date is null then
    raise exception 'bad date';
  end if;

  v_level := drift_level(p_did, p_user);
  v_quota := drift_quota_of(v_level);

  select coalesce(m.streak, 0) into v_streak
    from (select 1) x
    left join drift_members m on m.member_key = drift_mkey(p_did, p_user);

  select count(*) into v_thrown from drift_bottles b
   where b.did = p_did and b.topic_date = p_topic_date;
  select count(*) into v_fished from drift_fished f
   where f.did = p_did
     and (f.fished_at at time zone 'Asia/Shanghai')::date
       = (now() at time zone 'Asia/Shanghai')::date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'content', t.content, 'likes', t.likes, 'topic_key', t.topic_key)
         order by t.likes desc, t.created_at asc), '[]'::jsonb)
    into v_wall
    from (select content, likes, topic_key, created_at
            from drift_bottles
           where topic_date = p_topic_date - 1
           order by likes desc, created_at asc
           limit 3) t;

  return jsonb_build_object(
    'level',      v_level,
    'streak',     coalesce(v_streak, 0),
    'quota',      v_quota,
    'thrown',     v_thrown,
    'fished',     v_fished,
    'throw_left', greatest(0, v_quota - v_thrown),
    'fish_left',  greatest(0, v_quota - v_fished),
    'wall',       v_wall
  );
end $$;

-- ------------------------------------------------------------
-- 授权：先收回 public，再只把对外函数授予 anon/authenticated
-- （drift_mkey / drift_quota_of / drift_level 是内部工具，不授予）
-- ------------------------------------------------------------
revoke all on function public.drift_mkey(text, uuid) from public;
revoke all on function public.drift_quota_of(int) from public;
revoke all on function public.drift_level(text, uuid) from public;
revoke all on function public.drift_checkin(text, uuid) from public;
revoke all on function public.drift_submit(text, date, text, text, uuid) from public;
revoke all on function public.drift_fish(text, date, uuid) from public;
revoke all on function public.drift_status(text, date, uuid) from public;

grant execute on function public.drift_checkin(text, uuid) to anon, authenticated;
grant execute on function public.drift_submit(text, date, text, text, uuid) to anon, authenticated;
grant execute on function public.drift_fish(text, date, uuid) to anon, authenticated;
grant execute on function public.drift_status(text, date, uuid) to anon, authenticated;
