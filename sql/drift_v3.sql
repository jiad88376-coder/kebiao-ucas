-- ============================================================
-- 漂流瓶 v3 迁移：消息中心（我的瓶子 / 我捞过的 / 收到的共鸣）
-- 幂等，可重复执行；只加函数，不动表
--
-- 消息中心一个 RPC 拿全部数据（省请求）：
--   drift_mine(p_did) → { thrown:[…], fished:[…], likes_total:N }
--   thrown: 我投过的瓶子（含每瓶共鸣数、所属话题）
--   fished: 我捞过的瓶子（含内容、是否已共鸣）
--   likes_total: 我的瓶子累计收到的共鸣数
--
-- 数据口径与配额计数一致：一律按 did（设备）归属。
-- did 是 32 位随机串，等同于调用方身份令牌，只能查到自己的数据。
-- ============================================================

create or replace function public.drift_mine(p_did text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_thrown jsonb;
  v_fished jsonb;
  v_likes  int;
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
           'mine',       (b.did = p_did),   -- 理论上捞不到自己的，防御性保留
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

  select coalesce(sum(b.likes), 0) into v_likes
    from drift_bottles b where b.did = p_did;

  return jsonb_build_object(
    'thrown',      v_thrown,
    'fished',      v_fished,
    'likes_total', coalesce(v_likes, 0)
  );
end $$;

revoke all on function public.drift_mine(text) from public;
grant execute on function public.drift_mine(text) to anon, authenticated;
