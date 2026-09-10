# 课壳 (kebiao-ucas)

国科大人自己的课表工具：粘贴课程代码，3 秒生成整学期课表；笔记 / 作业 DDL / 考试一站管理，每日消息提醒，云同步互通，可安装成手机 App。一校三地（校本部 · 杭高院 · 海洋学院青岛基地）。

**线上入口**
- 主站（国内直连）：https://kebiao-ucas.netlify.app
- 备用：https://jiad88376-coder.github.io/kebiao-ucas/
- 宣传域名：https://kebiao.courseshell.cloud （301 跳转）

## 📖 完整文档

**[项目使用说明.md](./项目使用说明.md)** —— 用户上手 / 维护者指南 / 版本记录（随版本迭代更新）

## 开发速查

```bash
python -m http.server 8080   # 本地预览 http://localhost:8080
node test/test.js            # 单元测试（94 项）
```

- 无构建、原生 JS；`app.js` 是唯一业务文件（导出纯逻辑函数供 node 单测）
- 课程库由 `scripts/*.py` 从教务 xlsx 生成，勿手改 `data/schools/*-catalog.json`
- 缓存策略：核心文件网络优先（发版即时生效）；**只有课程库/图标/vendor 变更才升 sw.js `CACHE` 版本**

## 部署

- Netlify（主入口）：连接仓库 main 分支自动部署
- GitHub Pages（备用）：Settings → Pages → main / (root)
- Cloudflare Worker（反代主线路）：`functions/cloudflare/worker.js`，绑定 `api.courseshell.cloud`
- 消息提醒投递：Netlify 定时函数（`netlify/functions/push-sender.mjs`），需在 Netlify 配置环境变量：`SUPABASE_SERVICE_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`（详见使用说明 6）
