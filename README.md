# 课表 · 国科大课程表 (kebiao-ucas)

输入课程代码，自动生成个人周课表。支持上课笔记、课后作业、考试信息记录。
课表数据仅保存在浏览器本地（localStorage），支持一键备份/恢复与链接分享。

## 功能

- 粘贴课程代码 / 搜索课程名，自动生成 13 节 × 周一~周日 课表
- 时间冲突检测（精确到周次：补课周次不重叠不误报）
- 全校区课程库（H 怀柔 / Y 玉泉 / Z 中关村），2077 门课
- 每门课：上课笔记、课后作业（截止倒计时）、考试信息（倒计时）
- PWA：iPhone/安卓 Safari/Chrome「添加到主屏幕」后全屏离线可用
- 分享：`?c=课程代码1,课程代码2` 链接一键导入

## 目录结构

```
schedule-app/
├── index.html / app.js / style.css / manifest.json / sw.js
├── data/catalog.json        # 课程库（由脚本生成，勿手改）
├── icons/                   # PWA 图标
├── scripts/export_catalog.py  # 课程库 xlsx → catalog.json
└── test/test.js             # 逻辑单元测试 (node)
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