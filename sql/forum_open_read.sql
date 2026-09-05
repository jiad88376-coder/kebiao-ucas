-- ============================================================
-- 论坛浏览权限调整（在已执行 forum_setup.sql 的项目上运行一次）
-- 目标：未登录可浏览公开内容；发言/下载文件必须登录
-- 1) 三张表 SELECT 策略从 "仅登录" 放宽为 "所有人（仍排除已删除）"
-- 2) 文件桶从公开改私有：只有登录用户（带 token）能读取 → 未登录下载被服务端拒绝
-- ============================================================

drop policy if exists "forum posts read" on public.forum_posts;
create policy "forum posts read" on public.forum_posts
  for select using (not is_deleted);

drop policy if exists "forum replies read" on public.forum_replies;
create policy "forum replies read" on public.forum_replies
  for select using (not is_deleted);

drop policy if exists "course posts read" on public.course_posts;
create policy "course posts read" on public.course_posts
  for select using (not is_deleted);

-- 文件桶转私有（公开 URL 立即失效，未登录无法下载）
update storage.buckets set public = false where id = 'forum-files';

drop policy if exists "forum files read" on storage.objects;
create policy "forum files read" on storage.objects
  for select to authenticated using (bucket_id = 'forum-files');
