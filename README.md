# 课壳 (kebiao-ucas)

国科大人自己的课表工具：粘贴课程代码，3 秒生成整学期课表；笔记 / 作业 DDL / 考试一站管理，每日消息提醒，云同步互通，可安装成手机 App。还带一个匿名话题漂流玩法「今日一漂」。一校三地（校本部 · 杭高院 · 海洋学院青岛基地）。

**线上入口**
- 当前可用：https://jiad88376-coder.github.io/kebiao-ucas/
- 暂停中：https://kebiao-ucas.netlify.app （免费额度用尽，站点被平台暂停，额度重置后自动恢复）
- 宣传域名：https://kebiao.courseshell.cloud （301 跳转到当前可用入口）

> ⚠️ Netlify 暂停期间：其静态站与 Functions 一起停摆。消息提醒投递已于 v51 迁到 GitHub Actions，不再受影响；反代当前为 CF 单源。详见 [项目使用说明.md](./项目使用说明.md) 的「在线入口」。

## 📖 完整文档

**[项目使用说明.md](./项目使用说明.md)** —— 用户上手 / 维护者指南 / 版本记录（随版本迭代更新）

## 开发速查

```bash
python -m http.server 8080   # 本地预览 http://localhost:8080
node test/test.js            # 单元测试（118 项）
```

- 无构建、原生 JS；`app.js` 是唯一业务文件（导出纯逻辑函数供 node 单测）
- 课程库由 `scripts/*.py` 从教务 xlsx 生成，勿手改 `data/schools/*-catalog.json`
- `data/topics.json` 是「今日一漂」的话题库，人工手改提交即可（**必须在 sw.js 的 `CORE` 名单里**，否则新话题取不到）
- 缓存策略：核心文件走**协商缓存**（条件请求，文件未变则 CDN 返回 304、正文 0 字节；发版即时生效，不依赖版本号）；**只有课程库/图标/vendor 变更才升 sw.js `CACHE` 版本**

## 部署

- GitHub Pages（当前入口）：Settings → Pages → main / (root)
- Netlify：连接仓库 main 分支自动部署。注意免费额度是**账户级共享池**，用尽即暂停整站（含 Functions），不只是停止部署
- Cloudflare Worker（反代 · 唯一线路）：`functions/cloudflare/worker.js`，绑定 `api.courseshell.cloud`；备胎已于 v50 摘除，`withFailover` 机制保留待接入
- 消息提醒投递：GitHub Actions 定时任务（`.github/workflows/push-sender.yml` + `.github/scripts/push-sender.mjs`），在仓库 Secrets 配 `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`（详见使用说明 §6）。⚠️ **workflow 文件必须用 git 手工提交** —— Contents API 推不了 `.github/workflows/*`
- 数据库：`sql/` 下按序执行 `user_data_setup.sql`、`forum_setup.sql`、`forum_open_read.sql`、`push_setup.sql`、「今日一漂」用 `drift_setup.sql`
