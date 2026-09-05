-- ============================================================
-- 论坛功能建表脚本（Supabase SQL Editor 里执行一次）
-- 1) forum_posts   自由论坛主题帖
-- 2) forum_replies 自由论坛回帖
-- 3) course_posts  每门课的讨论/资料帖（可带附件）
-- 4) storage 桶 forum-files（公开读、登录用户按自己的 uid 目录上传）
-- ============================================================

create table if not exists public.forum_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  author text not null default '',
  title text not null check (char_length(title) between 1 and 80),
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now(),
  is_deleted boolean not null default false
);

create table if not exists public.forum_replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.forum_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  author text not null default '',
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now(),
  is_deleted boolean not null default false
);

create table if not exists public.course_posts (
  id uuid primary key default gen_random_uuid(),
  course_code text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  author text not null default '',
  content text not null default '' check (char_length(content) <= 2000),
  file_path text,
  file_name text,
  file_size bigint,
  created_at timestamptz not null default now(),
  is_deleted boolean not null default false
);

create index if not exists idx_forum_posts_created on public.forum_posts (created_at desc);
create index if not exists idx_forum_replies_post on public.forum_replies (post_id, created_at);
create index if not exists idx_course_posts_code on public.course_posts (course_code, created_at);

alter table public.forum_posts enable row level security;
alter table public.forum_replies enable row level security;
alter table public.course_posts enable row level security;

-- forum_posts（SELECT 对所有人开放：未登录可浏览；写操作仅登录本人）
drop policy if exists "forum posts read" on public.forum_posts;
create policy "forum posts read" on public.forum_posts
  for select using (not is_deleted);
drop policy if exists "forum posts insert" on public.forum_posts;
create policy "forum posts insert" on public.forum_posts
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "forum posts delete" on public.forum_posts;
create policy "forum posts delete" on public.forum_posts
  for delete to authenticated using (user_id = auth.uid());

-- forum_replies
drop policy if exists "forum replies read" on public.forum_replies;
create policy "forum replies read" on public.forum_replies
  for select using (not is_deleted);
drop policy if exists "forum replies insert" on public.forum_replies;
create policy "forum replies insert" on public.forum_replies
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "forum replies delete" on public.forum_replies
  ;
create policy "forum replies delete" on public.forum_replies
  for delete to authenticated using (user_id = auth.uid());

-- course_posts
drop policy if exists "course posts read" on public.course_posts;
create policy "course posts read" on public.course_posts
  for select using (not is_deleted);
drop policy if exists "course posts insert" on public.course_posts;
create policy "course posts insert" on public.course_posts
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "course posts delete" on public.course_posts;
create policy "course posts delete" on public.course_posts
  for delete to authenticated using (user_id = auth.uid());

-- 存储桶：forum-files（私有桶：仅登录用户可读取下载，匿名下载被服务端拒绝）
insert into storage.buckets (id, name, public)
values ('forum-files', 'forum-files', false)
on conflict (id) do update set public = false;

drop policy if exists "forum files read" on storage.objects;
create policy "forum files read" on storage.objects
  for select to authenticated using (bucket_id = 'forum-files');

drop policy if exists "forum files upload" on storage.objects;
create policy "forum files upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'forum-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "forum files delete" on storage.objects;
create policy "forum files delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'forum-files' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================
-- 防伪造触发器：作者/时间以服务端为准，防冒充与刷榜
-- 1) author 强制 = 登录邮箱（客户端传值无效，防冒充他人）
-- 2) created_at 强制 = now()（防伪造时间置顶刷屏）
-- 3) is_deleted 强制 = false
-- 4) course_posts.file_path 必须位于本人 uid 目录（防盗链他人文件冒充自己发布）
-- ============================================================
create or replace function public.enforce_post_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.author := coalesce(auth.email(), '');
  new.created_at := now();
  new.is_deleted := false;
  return new;
end;
$$;

create or replace function public.enforce_course_post_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.author := coalesce(auth.email(), '');
  new.created_at := now();
  new.is_deleted := false;
  if new.file_path is not null then
    if left(new.file_path, length(auth.uid()::text) + 1) <> auth.uid()::text || '/' then
      raise exception 'file_path must be under your own folder';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_forum_posts_integrity on public.forum_posts;
create trigger trg_forum_posts_integrity
  before insert on public.forum_posts
  for each row execute function public.enforce_post_integrity();

drop trigger if exists trg_forum_replies_integrity on public.forum_replies;
create trigger trg_forum_replies_integrity
  before insert on public.forum_replies
  for each row execute function public.enforce_post_integrity();

drop trigger if exists trg_course_posts_integrity on public.course_posts;
create trigger trg_course_posts_integrity
  before insert on public.course_posts
  for each row execute function public.enforce_course_post_integrity();

-- ============================================================
-- 清理安全审计用的探针账号（本次审计创建，保留无害，删掉干净）
-- ============================================================
delete from public.user_data where user_id = 'e3bbc988-18be-4e1f-b3f4-5a9422319b9b';
delete from auth.users where id = 'e3bbc988-18be-4e1f-b3f4-5a9422319b9b';
