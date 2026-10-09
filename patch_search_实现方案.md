# 补丁中心系统文档（cc-web + patch_search）

> 版本：2026-10-09。本文是系统的**全貌参考**：系统是什么、每个菜单干什么、数据库有哪些表、怎么部署、哪些机制和坑重要。
> 历史设计决策的详细推演（含代码注释里引用的"第十八章/第二十章/20.5"等章节）备份在
> `changelog/patch_search_实现方案-历史设计备份.md`。

---

## 一、系统是什么

一句话：**把"补丁包 → 分析入库 → 检索 → 合并进客开工程 → 产出新补丁"这条流水线搬到网页上**，
AI（Claude Code）在每台开发机上干活，服务器只做补丁库、字典、流程模板和账本。

```
每台开发机（每台各装一份）                 服务器 A（管理员维护）              数据库
┌────────────────────────────┐          ┌──────────────────────────┐     ┌──────────────┐
│ cc-web.exe (Rust) :3030    │  HTTP    │ patch_search :13587      │────▶│ MySQL        │
│  ├ 聊天页 /chat.html       │ ───────▶ │  补丁库/字典/流程/账本    │     │ 10.4.122.21  │
│  ├ 补丁中心 15 个页签      │  摘要上报 │ patch_source MCP :13589  │     │ /patch       │
│  ├ claude CLI（每消息一进程│          │  （标品源码只读检索）     │     └──────────────┘
│  │  bypassPermissions）    │ ◀─────── │                          │
│  ├ java_compiler_mcp(stdio)│  下载补丁 │ data/ccweb-update/      │
│  │  （本机编译/打补丁）     │          │  （cc-web 新版本发布目录）│
│  └ ~/.cc-web/*.json 清单   │          └──────────────────────────┘
└────────────────────────────┘
```

| 进程 | 语言/框架 | 端口 | 部署位置 |
|---|---|---|---|
| cc-web.exe | Rust + Actix-Web（单文件，静态资源 `include_str!` 内嵌） | 3030 | **每台开发机** |
| patch_search | Python FastAPI + aiomysql（可打包 exe） | 13587 | 服务器 A |
| patch_source MCP | 随 patch_search 起的第二个监听（官方 MCP SDK） | 13589 | 服务器 A |
| java_compiler_mcp | Python（PyInstaller，stdio） | 无（子进程） | 每台开发机 |

**为什么 cc-web 必须每台机器一份**：claude 会话、客开工程、JDK、编译 MCP 都是本机的东西，
换台机器记录还在也点不动；所以"本机清单是事实来源，服务器只是影子账本"贯穿全系统。

---

## 二、cc-web（客户端）

### 2.1 核心事实

- **Rust + Actix-Web 单 exe**，前端原生 JS 无构建步骤；`index.html / patches.html / app.js / patches.js / sidenav.js / copybox.js / folderpick.js` 全部**编译期内嵌**（`static_files.rs`）——**改前端必须重新 cargo build**，浏览器靠 ETag 自动取新
- 数据目录 `~/.cc-web/`，三份本机清单：
  | 文件 | 内容 | 对应服务器表 |
  |---|---|---|
  | sessions.json | 聊天会话与消息 | 无 |
  | node_runs.json | 智能开发运行清单（cc-web 不解释字段） | problem_run |
  | adapt_runs.json | 补丁适配运行 | patch_adapt_run/item |
  另有 mcp-servers.resolved.json（解析后的 MCP 配置）、logs/（按天轮转）
- **claude 的调用方式**：每条消息起一个 `claude --print --output-format stream-json --verbose --permission-mode bypassPermissions --model <m> [--resume <sid>] --mcp-config <resolved.json>` 进程；事件经 broadcast channel 分给 SSE（前端实时）、event saver（落盘会话）两路
- `--resume` 与 **cwd 强绑定**：换目录就 `No conversation found`。所以智能开发两阶段、适配多补丁共用会话都靠"同一 cwd + 同一会话 id"

### 2.2 地址与凭据体系（改地址前必看）

| 东西 | 在哪 | 改动生效方式 |
|---|---|---|
| patch_search 直连地址 | `src/patch_servers.json`（**编译进 exe**，当前两条隧道） | 改完必须重编译 |
| patch_source MCP 地址+token | 分发包 `mcp-servers.json`（http 型） | 改文件 + 重启即可 |
| java_compiler_mcp 路径 | 分发包 `mcp-servers.json`（stdio 型，相对 exe 目录） | 同上 |
| 数据库 | patch_search 的 `config.yaml` | 重启 patch_search |
| 登录 token | 浏览器 localStorage `patch-search-access-token`（JWT，默认 120 分钟） | — |

---

## 三、patch_search（服务器）

- FastAPI + aiomysql；所有接口 JWT Bearer（`PATCH_SEARCH_JWT_SECRET` ≥32 字符）；日志含 SQL 模板与脱敏参数
- 三类**只写账本**（服务器不驱动执行、不反向覆盖本地）：`problem_run`、`patch_adapt_run/item`、`problem_run_session`——上报幂等（ON DUPLICATE KEY UPDATE），失败不阻塞干活，页面会自动补报
- 流程引擎：模板步骤**实时读取**（改提示词立即生效），状态机 `running → waiting_confirmation → success/failed/cancelled`；本地步骤靠 `execution_token` 认领（claim-local 原子保证单客户端执行）
- 用户隔离有两种口径，别混：
  - workflows 系（flow/prompt/template/directory）：**admin 创建 = 全员共享**，个人创建 = 仅自己
  - project_env / problem_run / patch_adapt / 会话存档写入：**严格按人**，admin 也只看自己的

---

## 四、两个 MCP

| MCP | 形态 | 作用 | 备注 |
|---|---|---|---|
| java_compiler_mcp | stdio，cc-web 每次调 claude 都挂上 | 编译 Java / 打补丁 zip（八个工具） | 依赖 `java_home`（来自产品环境变量）；exe 与 `_internal` 必须同级 |
| patch_source | http（Bearer 静态 token） | 服务器上标品源码**只读检索**（grep/read_file/glob/stat_path/list_roots） | **path 必须写包级相对路径**（如 `nc/impl/tb`），全树扫 20s+，包级 <0.5s；root 按 `<产品>/<版本>` 挂；审计日志 mcp_audit.log 记"读了搜了什么" |

**口径注意**：智能开发的提示词要求用它查标品；**补丁适配默认禁用**（对照物=补丁 vs 客开工程），只有工程里找不到该类时才允许查标品参考——标品是 CFR 反编译产物，当 diff 基线会引入假改动。

---

## 五、菜单（页面）逐一介绍

登录后默认进补丁中心。15 个页签 + 聊天页 + 3 个详情页；侧边栏/页签显隐由登录时服务器下发的
`menus` 决定（admin 全集；`menus`/`sessions` 两项前端专属仅 admin），四个页面共用一份定义（`sidenav.js`）。

### 智能开发（node）—— 问题解决节点
两阶段跑在**同一个 claude 会话**里，cwd=客开工程根：
- **阶段一（分析）**：只读分析客开工程（改动只写 `<out_dir>\work` 暂存目录）、可补详细日志、
  走 java-compiler-mcp 打补丁 zip、生成 diff-report 对比报告；产物按步隔离在 `out_dir\step01、step02…`
- **待判定** → 用户点「问题已解决」进**阶段二（合并）**：把暂存目录同步回客开工程，
  打**去日志的干净补丁**（`patch_<产品版本>_<时间>_<简述>_znkf.zip`），成败以 `合并说明.md` 首行判定
- 未解决 → 补日志/信息重跑阶段一（下一步目录递增）
- 事实来源本机 `node_runs.json`；服务器 `problem_run` 只是摘要；已解决时完整会话存档到
  `problem_run_session`（仅 admin 可查）
- 「查看会话」= 聊天页**只读围观**（不新建会话）；适配/智能开发的会话在聊天页一律只读

### 智能分析（smart）—— 可配置流程
选流程模板 → 填业务需求 → 启动；每步完成要点「确认下一步」；本地步骤由浏览器认领执行权后
交给本机 claude 跑（cc-web `/api/local-claude/execute`，幂等）；服务器步骤由服务器 A 的 claude 跑。
每步都要求写 `结论.md / 摘要.md` 入库。

### 普通检索（search）
补丁库检索（名称/产品/版本/关键词/类名/描述，状态过滤）。操作列：**详情**（含分析结果与复制按钮）、
**下载**（多地址探测+进度条）、**适配**（直接发起该补丁的适配）、编辑/删除（仅 admin）。

### 补丁上传（upload）
拖拽/多选 zip/rar，填名称/产品/版本/描述/关键词，批量上传。上传后 status=0，**需管理员分析**才进结果。

### 我的补丁（mine）
自己上传的补丁，可编辑（保存后重置为待分析）。

### 补丁适配（adapt）
把已有补丁包**合并进客开工程**：
- 入口两个：本页拖拽/选文件（多补丁）；普通检索列表点「适配」（cc-web 直连补丁中心下载，带进度条）
- 弹窗填：每个补丁的问题描述（必填）+ 产品环境变量（按产品/版本自动预选，带出客开工程目录）
- 开始前检查客开工程 git 状态并强确认（适配**直接改工程、无法自动恢复**）
- **多补丁逐个跑、每个跑完停在「待确认」**：详情页点「继续下一步」（同一 claude 会话 --resume 延续上下文）、
  「一键跑完剩余」（自动连跑，聊天页可全程实时看）、「重试失败的补丁」、「中止适配」、「删除记录」（本机+服务器一起删）
- 提示词口径：**对照物 = 补丁包源码 vs 客开工程源码**，先判是否已合入（重复投递很常见），
  冲突/无源码如实回报，不许反编译、不许动 .git
- 产物：`结论.md/摘要.md` 入库展示；补丁解压在 `<cc-web目录>\temp\adapt\<runId>\<seq>\`

### 流程设置 / 提示词设置 / 流程模板设置（flow / prompt / template）
管理员维护的流程引擎三件套（admin 建=共享）。模板步骤引用流程+提示词；被运行引用的不可删；模板可克隆。

### 待分析补丁（analysis，admin）
选 status≠2 的补丁批量分析（服务器 A 的 claude，并发由 `analysis.concurrency` 定）；
命令行批量工具 `analyze_pending.py`（绕开单次 1000 个上限）。

### 产品版本管理（product，admin）
产品/版本字典，**逻辑删除**（历史记录按 ID 反查名称不受影响）。

### 工作目录（directory）
内置目录=服务器 A 路径（给 server ClaudeCode 步骤）；个人目录=本机路径（给本地步骤运行时绑定）。

### 产品环境变量（project_env）
每用户一套"这台机器的环境"：客开代码目录、home/war包地址、本地 JDK（必填）、
本机 skill 库（可选）、数据库连接（只读）、远程调试地址（仅线程级）。智能开发/适配都从这里取环境。

### 菜单可见性（menus，admin）
角色默认 + 用户覆盖，控制普通用户能看到哪些页签（接口同步拦截）。

### 会话存档（sessions，admin）
查看已解决智能开发 run 的完整会话（`problem_run_session`，含 thinking 可选）。

### 聊天页（/chat.html）
通用 AI 会话（多助手切换、分屏、队列）；「继续会话」只读围观；**后台任务（智能开发/适配）创建的会话一律只读**。

### 三个详情页
`node_run.html`（智能开发运行详情）、`adapt_run.html`（适配详情：逐补丁状态/结论/摘要/改动文件/冲突详情/说明，
五个结果框自适应高度、markdown 渲染、右上角复制图标）、`workflow_run.html`（流程运行详情）。

### 全局小功能
所有只读内容框右上角有**复制图标**（悬停显示，`copybox.js`）；所有本机路径输入框旁有 **📁 目录选择按钮**
（弹系统原生对话框，`/api/pick-folder`）；顶栏**检查更新**（登录后自动查一次）。

---

## 六、数据库表（MySQL `patch` @ 10.4.122.21，共 17 张）

### 用户与权限
| 表 | 用途 | 要点 |
|---|---|---|
| user_account | 账号 | role: admin/user；token_version 可吊销已发 JWT |
| menu_permission | 角色级菜单默认可见性 | 键见 MENU_CATALOG（13 个） |
| user_menu_permission | 用户级覆盖 | 优先于角色配置 |

### 补丁库
| 表 | 用途 | 要点 |
|---|---|---|
| patch_info | 补丁主表 | status 0待分析/1分析中/2完成/3失败；analysis_result(JSON)+class_name+keyword 为 claude 分析产物；产品/版本存**文本快照**不存字典 ID |

### 字典
| 表 | 用途 | 要点 |
|---|---|---|
| product / product_version | 产品与版本 | **逻辑删除**（is_deleted），无唯一键，唯一性应用层保证；产品删则版本一并不可选 |

### 流程引擎
| 表 | 用途 | 要点 |
|---|---|---|
| workflow_flow | 流程（调用位置 local/server + 建议目录） | 被 template_step 引用不可删 |
| workflow_prompt | 提示词 | 同上；被引用的提示词改完即生效（无快照） |
| workflow_template / workflow_template_step | 模板与步骤 | 就地更新按 step_order 复用行 ID；被 run 引用不可删，可克隆 |
| workflow_run / workflow_run_step | 运行与步骤 | run.id 是 uuid；步骤存 execution_token（本地步骤认领）、local_session_id（--resume 用）、output_conclusion/summary（结论摘要入库） |

### 环境与账本（三类账本同口径：按人隔离、幂等上报、服务器不驱动）
| 表 | 用途 | 要点 |
|---|---|---|
| project_environment | 产品环境变量 | 产品/版本存**字典 ID**（与 patch_info 相反）；local_jdk_path 必填 |
| problem_run | 智能开发运行摘要 | 唯一键 local_run_id（本机清单的 id）；status: running/awaiting_decision/solved/unsolved/merge_failed/aborted |
| problem_run_session | 已解决 run 的完整会话存档 | LONGTEXT conversation_json，写入按人隔离、**读取仅 admin** |
| patch_adapt_run / patch_adapt_item | 适配任务与逐补丁结果 | run 状态多一个 awaiting_confirmation；item 状态 done/conflict/nosource/failed/skipped |

---

## 七、部署

### 7.1 cc-web：编译与分发（管理员机器上）

```bat
cd D:\project\AgentHub-web-merge
cargo build --release
:: 编译产物覆盖两处：仓库根 + 分发包（分发包里的 exe 就是给各台机器的）
copy /Y target\release\cc-web.exe D:\project\AgentHub-web-merge\cc-web.exe
copy /Y target\release\cc-web.exe D:\project\cc-web-dist\cc-web.exe
```
- **改了前端（static/ 下任何文件）同样要重新编译**——静态资源是内嵌的
- `src\patch_servers.json`（补丁中心地址）也是编译进 exe 的，改它要重编

### 7.2 cc-web：每台开发机安装

前置：Claude Code CLI（PATH）、Git for Windows、JDK（版本按工程）、Python 3（差异报告用，可选）、Node（前端补丁构建，可选）。
1. 整个 `cc-web-dist\` 拷到本机任意目录（内部全相对路径）
2. 装 skill 到用户级 `~/.claude/skills/`：`java-compiler-mcp`（必装）、`diff-report`（建议）
3. 配模型凭证：`claude-settings.example.json → ~/.claude/settings.json` 填网关与 token
   （不配则模型下拉为空、发消息失败）
4. **双击 `start.bat` 启动**（别直接双击 exe——它设置 `CC_WEB_MCP_CONFIG`，直开会导致 MCP 静默不加载）
5. 登录后到「产品环境变量」页签登记本机环境（客开目录/home/JDK/skill 库）

### 7.3 patch_search：源码运行（开发）

```powershell
conda activate patch
cd D:\project\patch_search
$env:PATCH_SEARCH_JWT_SECRET = "长度≥32的随机串"
python -m uvicorn app.main:app --host 0.0.0.0 --port 13587
```

### 7.4 patch_search：打包与服务器部署

```powershell
conda activate patch
cd D:\project\patch_search
python -m PyInstaller --noconfirm patch_search.spec
```
- ⚠️ **不要用 build.bat**——它会清掉 dist 里的 `config.yaml / data / logs`
- 产物 `dist\patch_search.exe`（onefile）；服务器上按序号放 `patch_searchNN.exe`，与 `config.yaml / data / logs` 同级
- 服务器需设 `PATCH_SEARCH_JWT_SECRET`（用户级环境变量）后启动

### 7.5 数据库初始化与迁移

新库按序执行 `schema/001_workflow.sql → 002_auth.sql → 005_workflow_directory.sql`；
已有库按需执行 `schema/migration_*.sql`（执行前核对线上表名/索引名）。当前全量表结构见 `schema/current_schema.sql`。

### 7.6 发布 cc-web 新版本（管理员网页发版，按版本号 + 平台）

**在网页上发**：管理员登录补丁中心 → 左侧「版本发布」页签（仅管理员可见）→ 点「发布」→
填版本号 + 更新说明 + 选文件 → 「上传发布」。**服务器自己写进发布目录**，不需要 U 盘 / 共享盘 / 本地工具。

发布目录布局：
```
<发布目录>/                     (= patch_search config.yaml 的 ccweb_update.dir)
├── latest.json                 {"latest":"1.0.2"}  ← 管理员维护的「最新版本号」
├── 1.0.0/{meta.json, windows/cc-web.exe, macos-arm64/…, macos-x64/…}
└── 1.0.2/{meta.json, macos-arm64/cc-web-macos-arm64}
```

**判断更新的口径：版本号**（本机版本号 ≠ 最新版本号 → 提示有新版）。
所以 **发版前必须先改 `Cargo.toml` 的 `version` 再编译** —— 客户端在编译期把自己"是谁"写进程序里
（另有哨兵串 `CCWEB-VERSION:<版本>` 供服务器核对）。发布时服务器会扫这个哨兵：

- 找不到 → 回一条醒目警告：「可能忘了把 Cargo.toml 的 version 改成 X 就编译了，那批客户端会一直提示更新」
- 该版本缺平台 → 回警告：这些平台的客户端会提示「最新版本 X 暂无本平台安装包」
- 警告**不拦提交**（有时就是要先发一个平台），但页面会红字显示

**补发某个平台**：点「发布」→ 填**同一个版本号** → 只选那个平台的文件 → 提交，其余平台不受影响。

**设为最新 / 回滚**：版本表格里每个非最新版本都有「设为最新」按钮（`POST /api/ccweb/latest`）。
回滚就是把旧版本重新设为最新 —— 版本号回到旧值，各机器会提示"有新版本"（其实是在降到旧版）。

**客户端**：登录后自动查一次 + 顶栏「检查更新」。有新版 → 横幅 + 「立即更新」：
- Windows：下载 → 校验 sha256 → `update-cc-web.bat` 在进程退出后替换并重启（自动设 `CC_WEB_MCP_CONFIG`，留 `.bak`）
- macOS：下载校验后**不自动替换**，提示手动替换（新文件已加执行权限，落 `<原名>.new`）
- 最新版本没有本平台的包 → 提示「暂无本平台安装包，请联系管理员」，不给「立即更新」按钮
- **只替换 cc-web 程序**，不动 mcp-servers.json / java_compiler_mcp / start.bat
- **发布本身不打断任何人**；只有某台机器点了「立即更新」才会重启那台 cc-web
  （正在跑的智能开发/适配会中断，停在「待确认」的不受影响）
- 前提：服务器上的 patch_search 必须是含 `/api/ccweb/*` 路由的版本（旧版返回 404）

---

## 八、重要机制速查

| 机制 | 一句话口径 |
|---|---|
| 会话延续 | `--resume` 与 cwd 强绑定；智能开发两阶段、适配多补丁、流程"继续会话"全靠同 cwd+同会话 id |
| 只读围观 | 后台任务创建的会话在聊天页一律只读（隐藏输入区）；「继续会话」不新建会话 |
| 适配暂停流 | 每补丁跑完 → awaiting_confirmation → 详情页「继续下一步 / 一键跑完 / 重试失败 / 中止」 |
| 自动补报 | JWT 过期后后台上报会 401；页面打开时发现本机与服务器不一致就用当前 token 补报（服务器没有的行**不复活**） |
| 事件落盘 | event saver 把流式过程边收边写进会话（含 thinking/工具调用），跑到一半打开「查看会话」也能看到已产出内容 |
| 适配实时 | 适配 run 期间会话标记 streaming → 聊天页自动挂 SSE；补丁间连播靠后端 `adapt_paused/adapt_finished` 事件收尾 |
| 更新判据 | sha256 不同（版本号长期 1.0.0、时间戳跨机不可靠） |
| MCP 检索性能 | path 写包级相对路径；全树 grep 20s+ 是目录项 I/O 的天花板，不是 MCP 的问题 |
| 列宽记忆 | 检索表列宽存 localStorage（v4，按角色分 key）；改按钮数量要同步 actionMin 并升版本号 |

---

## 九、常见坑（都实际踩过）

1. **必须走 start.bat**，直双击 exe → MCP 静默不加载（只在日志留一行）
2. `java_compiler_mcp` 文件夹整体拷，exe 与 `_internal` 保持同级
3. 找不到 git-bash → 设 `CLAUDE_CODE_GIT_BASH_PATH`；找不到 claude → 设 `CLAUDE_CMD`
4. **改前端必须重编译**（静态资源内嵌）；改 `src/patch_servers.json` 同理
5. 服务器账本"少了行"：先想 JWT 过期补报机制，再怀疑网络；删服务器行不算删除（本机清单还在，但**不会**再复活它）
6. 智能开发/适配跑完停在"待确认"，重启 cc-web 后仍可继续（claude 会话在磁盘上）
7. skill 目录别套多层：应为 `skills\java-compiler-mcp\SKILL.md`
8. `~/.claude.json` 里已有的 MCP 会一起加载，属正常
9. cc-web 每条消息起一个 claude 进程，首次响应略慢属正常
10. 局域网 http 下复制按钮走 execCommand 兜底（无 navigator.clipboard），控制台安全提示可忽略

---

## 十、安全注意

- cc-web 监听 `0.0.0.0:3030` 且以 **bypassPermissions** 调 claude：同网段任何机器都能操作你本机——
  不在不受信网络开着他；不用就关
- `~/.claude/settings.json`（含网关 token）、`mcp-servers.json`（含 MCP token）不入分发包、不外传
- patch_search 生产应收紧 CORS（当前 `[*]`）、JWT 密钥 ≥32 字符随机串
- 数据库连接与远程调试口只允许只读/线程级操作（提示词已约束，但这是提示词级约束）
