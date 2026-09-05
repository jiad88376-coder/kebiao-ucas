-- ============================================================
-- 个人课表数据表（云同步基础表，首次部署时在 Supabase SQL Editor 执行一次）
-- 存储：user_id（关联登录账号）、schedule（课程代码列表）、records（笔记/作业/考试）
-- 安全：RLS 保证每人只能读写自己的行（已实测：登录后读全表仅见自身数据）
-- ============================================================

create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  schedule jsonb not null default '{}'::jsonb,
  records jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

drop policy if exists "user_data select own" on public.user_data;
create policy "user_data select own" on public.user_data
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "user_data insert own" on public.user_data;
create policy "user_data insert own" on public.user_data
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "user_data update own" on public.user_data;
create policy "user_data update own" on public.user_data
  for update to authenticated using (auth.uid() = user_id);

-- 无删除策略：谁（包括本人 App）都删不了行，防止误删云端数据；如需清库请在 Dashboard 操作
