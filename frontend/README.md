# CC-Web 前端（React + TypeScript + Tailwind）

2026-11 起，原 `static/` 下的原生 JS 前端整体迁移到这里。构建产物固定文件名输出到
`static/dist/`，再由 `src/static_files.rs` 用 `include_str!` 内嵌进 exe，保持单文件分发。

## 技术栈

- **Vite 4**（兼容 Node 14.18+，构建产物不使用 hash 文件名）
- **React 18 + TypeScript 5**
- **Tailwind CSS 3** + CSS 变量设计系统（默认深色，可切浅色）
- **Zustand** 状态管理
- **marked + DOMPurify** 渲染模型输出的 Markdown
- **lucide-react** 图标

## 开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

开发服务器把 `/api` 代理到 `http://127.0.0.1:3030`（开发版）。调试实施版时：

```bash
# 先启动 implCon 版后端（端口 3031）
VITE_PROXY_TARGET=http://127.0.0.1:3031 npm run dev
```

实施版需要登录 token。开发时可访问
`http://localhost:5173/__set-token?t=任意值&next=/` 写入一个临时 token 后预览外壳
（真实登录仍走 `/login` 与 patch_search）。

## 构建

```bash
npm run build
# 等价于 tsc && vite build，产物：
#   ../static/dist/index.html
#   ../static/dist/app.js      （单文件，fixed name）
#   ../static/dist/app.css
```

构建后重新执行 `cargo build --release`，Rust 会把新产物编进 exe。CI 和 `build.bat`
都已经在 cargo 之前自动执行前端构建；`static/dist/` 也提交在仓库里，方便只改 Rust 时直接编译。

## 路由

React Router 接管以下路径（`src/static_files.rs` 中全部返回同一个 SPA 外壳）：

| 路径 | 页面 |
|---|---|
| `/`、`/patches.html` | 开发版：补丁中心；实施版：统一工作台（智能开发） |
| `/chat.html`、`/index.html` | 聊天（实施版落到统一工作台） |
| `/login`、`/login.html` | 登录 |
| `/node_run.html` | 智能开发运行详情 |
| `/adapt_run.html` | 补丁适配详情 |
| `/workflow_run.html` | 流程运行详情 |
| `/server_replay.html` | 服务器会话回放 |
| `/help` | 帮助 |

版本差异不在构建期区分：运行时读取 `GET /api/version` 的 `edition`（`dev` / `novice`）。

## 代码结构

```
src/
├── main.tsx / App.tsx        # 入口、路由、版本初始化、登录守卫
├── styles.css                # 设计 token、基础样式、Markdown 样式
├── lib/
│   ├── api.ts                # cc-web 接口、SSE、patch_search 鉴权/多地址回退
│   ├── patch.ts              # 补丁中心接口（解包 {code,data}、下载、上传）
│   ├── types.ts              # 会话/消息/补丁/环境/流程等类型
│   ├── theme.ts              # 深色/浅色主题（Zustand）
│   └── utils.ts
├── store/
│   ├── chat.ts               # 聊天状态机：会话、SSE、队列、中止、分屏
│   ├── nodeRuns.ts           # 智能开发运行：创建、提示词、决策、上报
│   ├── auth.ts               # 补丁中心登录态
│   └── app.ts                # 版本 / edition 初始化
├── pages/                    # 各路由页面
└── components/
    ├── chat/                 # 消息流、内容块、输入框、会话列表、文件浏览、分屏
    ├── patches/              # 补丁中心各页签
    ├── novice/               # 实施版创建任务、环境检查
    ├── files/                # 独立资源管理器
    ├── layout/AppShell.tsx   # 左侧导航 + 会话 + 文件 + 主题/设置
    └── ui/                   # Button/Dialog/Select/Toast 等
```

## 关键行为

- **模型**：前端不提供模型选择；新建会话和切换助手时由后端使用对应助手的默认模型。
- **SSE**：先建 EventSource，收到 `connected` 后才 `POST /api/agent/{id}/start`；
  事件类型 `connected/heartbeat/start/thinking/tool_call/tool_result/chunk/result/error`。
  超时保护：15 秒无事件查后端状态、10 秒心跳检查、120 秒无活动兜底。
- **消息队列**：正在流式时发送会入队，`result/error` 后自动发送下一条。
- **会话批量管理**：侧边栏「批量管理」进入多选模式，支持全选当前列表和批量删除；开发版与实施版共用。
- **会话视图**：视图选项支持按项目 / 按工作区（仅开发版）/ 单列表分组，以及最近更新 / 手动排序。
  分组（含日期分组）可点击标题折叠/展开，折叠状态保存在 localStorage。
  手动排序可拖拽会话和分组标题，顺序保存在 localStorage；删除分组只把当前会话归入「未分组」，
  不删除会话记录或工作目录。
- **分屏**：支持 1×1 / 2×1 / 1×2 / 2×2 / 3×2 / 3×3，同步模式把一条消息发给所有面板。
- **实施版登录**：token 存在 `localStorage['patch-search-access-token']`，由 patch_search 校验；
  cc-web 自身没有登录接口。
- **文件接口**：`/api/files/raw/...` 保留目录层级、逐段编码，兼容 Windows 盘符与反斜杠。

## 旧版文件

`static/*.html`、`static/app.js`、`static/patches.js` 等原生页面仍保留在仓库中用于对照，
但 `src/static_files.rs` 已不再服务它们；`tests/frontend/` 下的冒烟测试针对的是旧版 DOM 桩，
不适用于本目录。
