# 前端测试说明

这里的 `*_smoke.js` 是针对 **旧版原生 JS 前端**（`static/app.js`、`static/patches.js`、
`static/novice.js` 等）的 DOM 桩测试，通过 `node xxx_smoke.js` 直接执行。

2026-11 前端迁移到 `frontend/`（React + TypeScript）后，这些脚本不再覆盖当前实现；
`static_files.rs` 也不再服务旧页面。保留它们仅用于对照旧行为。

新前端的检查方式：

```bash
cd frontend
npx tsc --noEmit     # 类型检查
npm run build        # 生产构建
```

如需浏览器级冒烟测试，建议后续引入 Playwright，针对以下路由做基本断言：

- `/chat.html`：会话列表、消息流、输入框、SSE 连接
- `/`：补丁中心各页签、登录卡片
- `/login`：登录/错误提示
- `/node_run.html`、`/adapt_run.html`、`/workflow_run.html`、`/server_replay.html`
