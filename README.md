# 课表 · 国科大课程表 (kebiao-ucas)

输入课程代码，自动生成个人周课表。支持上课笔记、课后作业、考试信息记录。

## 功能

- 粘贴课程代码 / 搜索课程名，自动生成 13 节 × 周一~周日 课表
- 时间冲突检测（精确到周次：补课周次不重叠不误报）
- 全校区课程库（H 怀柔 / Y 玉泉 / Z 中关村），2077 门课
- 每门课：上课笔记、课后作业（截止倒计时）、考试信息（倒计时）
- **云同步（v2）**：邮箱验证码登录（Supabase），课表/笔记/作业/考试自动同步，手机与电脑登录同一邮箱即互通；离线时数据自动存本机，联网后合并
- PWA：iPhone/安卓「添加到主屏幕」后全屏离线可用
- 分享：`?c=课程代码1,课程代码2` 链接一键导入

## 隐私说明

- 课程库（catalog.json）公开托管；登录后个人数据存入 Supabase 云端，按用户隔离（Row Level Security），互相不可见
- 未登录时数据仅存本机浏览器；建议登录使用以获得云同步与备份
- 数据仅供参考，以教务系统为准

## 目录结构

```
schedule-app/
├── index.html / app.js / style.css / manifest.json / sw.js
├── vendor/supabase.min.js     # supabase-js（本地化，离线可用）
├── data/catalog.json          # 课程库（由脚本生成，勿手改）
├── icons/                     # PWA 图标
├── scripts/export_catalog.py  # 课程库 xlsx → catalog.json
└── test/test.js               # 逻辑单元测试 (node)
```

## 数据库初始化（仅首次）

Supabase Dashboard → SQL Editor 执行：

```sql
create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  schedule jsonb not null default '{}'::jsonb,
  records jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.user_data enable row level security;
create policy user_data_select on public.user_data for select using (auth.uid() = user_id);
create policy user_data_insert on public.user_data for insert with check (auth.uid() = user_id);
create policy user_data_update on public.user_data for update using (auth.uid() = user_id);
```

## 更新课程库（每学期开学）

1. 把教务导出的全校课表 xlsx 放到本地，修改 `scripts/export_catalog.py` 中的 `SRC` 路径
2. 运行：`python scripts/export_catalog.py`
3. 提交并推送，Service Worker 会带上新版本缓存

## 本地预览

```bash
cd schedule-app
python -m http.server 8080
# 打开 http://localhost:8080
```

## 单元测试

```bash
node test/test.js
```

## 部署（GitHub Pages）

1. 在 GitHub 新建仓库 `kebiao-ucas`
2. 推送本目录内容到 main 分支
3. 仓库 Settings → Pages → Source 选 `main` 分支 / (root)
4. 访问 `https://<用户名>.github.io/kebiao-ucas/`

## 说明

- 数据仅供参考，以教务系统为准
- 课表与笔记只存在本机浏览器，换设备/清缓存前请先导出备份