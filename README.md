# 课表 · 国科大课程表 (kebiao-ucas)

输入课程代码，自动生成个人周课表。支持上课笔记、课后作业、考试信息记录与云同步。

线上入口：**https://kebiao-ucas.netlify.app** （国内直连）
备用：https://jiad88376-coder.github.io/kebiao-ucas/

## 功能

- 粘贴课程代码 / 搜索课程名，自动生成 13 节 × 周一~周日 课表
- **本周视图**：默认按当前日期显示本周课表（含日期、今日高亮），可切换任意周次或查看整学期
- **手机端按天聚焦**：默认只显示今天一列（单列大视图），星期切换条一键换天
- 时间冲突检测（精确到周次：补课周次不重叠不误报）
- 全校区课程库（H 怀柔 / Y 玉泉 / Z 中关村），2077 门课
- 每门课：上课笔记、课后作业（截止倒计时）、考试信息（倒计时）
- **云同步**：邮箱+密码登录（注册需邮箱验证码验证，Supabase），课表/笔记/作业/考试自动同步
- **论坛**：
  - 自由论坛：发帖、回帖（作者/时间由服务端强制，只能删自己的内容）
  - 课程区：每门课独立的「讨论与资料区」，支持上传附件（≤5MB，走 Netlify 代理）
- PWA：iPhone/安卓「添加到主屏幕」后全屏离线可用
- 分享：`?c=课程代码1,课程代码2` 链接一键导入

## 隐私与安全模型

- **私有数据**（课表、课程代码、笔记、作业、考试）：存 Supabase `user_data` 表，RLS 按用户隔离，登录后读全表也只能看到自己的行（已用探针账号实测验证）
- **公开数据**（论坛帖子、回帖、课程区讨论）：未登录可浏览；发言/上传/下载文件需登录；只能删除自己发布的内容
- 防伪造：帖子作者/时间/文件路径由数据库触发器以服务端为准，客户端伪造无效
- 未登录时一切数据仅存本机浏览器 localStorage
- 数据仅供参考，以教务系统为准

## 目录结构

```
schedule-app/
├── index.html / app.js / style.css / manifest.json / sw.js
├── vendor/supabase.min.js          # supabase-js（本地化，离线可用）
├── data/catalog.json               # 课程库（由脚本生成，勿手改）
├── icons/                          # PWA 图标
├── netlify/functions/supabase.js   # Supabase 反代（国内直连通道，含 /diag 诊断）
├── netlify.toml
├── sql/
│   ├── user_data_setup.sql         # 个人数据表 + RLS（首次部署执行）
│   └── forum_setup.sql             # 论坛三表 + 存储桶 + 防伪造触发器（首次执行）
├── scripts/export_catalog.py       # 课程库 xlsx → catalog.json
└── test/test.js                    # 逻辑单元测试 (node)
```

## 数据库初始化（仅首次）

Supabase Dashboard → SQL Editor，依次执行：

1. `sql/user_data_setup.sql`
2. `sql/forum_setup.sql`

## 云同步架构

- 国内直连不了 `*.supabase.co`（GFW），App 内所有云请求走 Netlify Function 反代：
  `/.netlify/functions/supabase/*` → Supabase（查询串透传，CORS 已处理）
- App 只内嵌 publishable key（公开钥）；一切权限由 RLS 保证，代理函数无法提权
- 本地改动防抖 800ms 自动上推；登录时拉取合并（双端都有数据时用户二选一）

## 更新课程库（每学期开学）

1. 把教务导出的全校课表 xlsx 放到本地，修改 `scripts/export_catalog.py` 中的 `SRC` 路径
2. 运行：`python scripts/export_catalog.py`
3. 提交并推送，**记得同步把 `sw.js` 里的 `CACHE` 版本号 +1**（否则老客户端拿不到新课程库）

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

## 部署

- **Netlify（主入口，国内直连）**：连接仓库 main 分支自动部署；Functions 自动启用
- **GitHub Pages（备用）**：仓库 Settings → Pages → Source 选 main / (root)

推送 main 分支后两边都会自动更新。Service Worker 策略：页面/JS/样式**网络优先**（在线打开即最新版，离线用缓存）；课程库等大文件缓存优先。因此只有改 `data/catalog.json`、`vendor/` 或图标时才需要把 `sw.js` 的 `CACHE` 版本号 +1。
