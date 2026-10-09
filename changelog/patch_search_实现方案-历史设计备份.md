# 补丁包检索系统完整实现方案

> 版本：v3.2 ｜ 日期：2026-09-11  
> 状态：核心功能已实现并部署（前后端联调完成），本版按当前代码与数据库表结构同步更新  
> 说明：本文档汇总补丁检索、上传、分析、登录认证、提示词管理、可配置智能检索流程、运行记录和部署约束。智能检索步骤不固定写死，由流程模板配置决定。  
> v3.2 更新：新增「运行时工作目录绑定（方案 A）」——`local` 步骤的工作目录改为启动流程时由使用者逐步骤选择已有目录或手填本机路径；工作目录管理新增「删除」（物理删除，区别于「停用」软删除）；修正 `local` 步骤执行期间整条流程的状态显示（显示"执行中"而非"待确认"）。

---

## 一、建设目标

在服务器 A 上部署 `patch_search` 服务，管理补丁包并提供普通检索、补丁上传、用户登录认证、管理员分析和可配置智能检索能力。现有 `cc-web` 作为前端页面；智能检索流程中的 `local` 流程需要由 cc-web Rust 后端调用其所在客户端机器上的 ClaudeCode，`server` 流程由 patch_search 在服务器 A 上调用 ClaudeCode。

系统包含：

1. **登录认证与用户隔离**：JWT Bearer Token 登录，`user_account` 用户表，普通用户/管理员角色，按用户隔离流程、模板、提示词和运行记录。
2. **普通检索**：按补丁名称、描述、用户关键词、分析关键词和类名检索数据库，只返回分析完成的补丁；管理员在操作列额外提供"编辑/删除"，编辑时可直接修改补丁状态。
3. **补丁包上传**：支持 zip/rar、多文件、拖拽、选择文件、上传确认弹窗和逐文件进度。
4. **我的补丁**：查看、编辑、删除自己上传的补丁；编辑保存后补丁重置为“待分析”状态并清空旧分析结果。
5. **管理员分析**：管理员在“待分析补丁”页批量分析，或通过命令行脚本 `scripts/analyze_batch.py` 分析，调用 ClaudeCode 分析补丁并更新数据库。
6. **可配置智能检索**：管理员配置流程、提示词、流程模板和执行步骤；用户执行时每步完成后手动点击“下一步”继续。
7. **工作目录管理**：按用户隔离工作目录。`server` 流程只保存工作目录 `code`，执行前按当前用户 ID 解析实际目录；`local` 流程的工作目录为运行时参数，启动流程时由使用者在弹窗中逐步骤选择自己的目录或手填本机绝对路径。管理员可维护内置目录，普通用户只能查看和使用内置目录。目录支持「停用」（软删除，`status=0`）和「删除」（物理删除）。
8. **流程/提示词/模板所有权模型**：管理员创建的配置对所有用户共享（只读），普通用户可创建和管理自己的配置；运行记录严格按创建用户隔离，管理员运行不对普通用户共享。
9. **管理员补丁管理**：管理员在"普通检索"操作列对任意补丁提供"编辑/删除"按钮；编辑弹窗可直接修改补丁状态（0 待分析 / 1 分析中 / 2 分析完成 / 3 分析失败）。普通用户不可见这些按钮，也不能编辑、删除他人补丁。

---

## 二、总体架构和部署

```text
浏览器
  └── cc-web 页面
       ├── Chat 页面：现有聊天功能
       └── Patches 页面：登录 / 普通检索 / 上传 / 我的补丁 / 智能开发 / 配置管理
              │ 前端 JS 直接 HTTP 调用，CORS，Authorization: Bearer <JWT>
              ▼
服务器 A
  └── patch_search（FastAPI，0.0.0.0:13587）
       ├── 认证 API（login / me / profile / change-password / logout）
       ├── 普通检索、详情、下载、上传、我的补丁 API
       ├── 管理员批量分析 API + 命令行脚本
       ├── 仪表盘统计 API
       ├── 流程、提示词、模板、工作目录管理 API
       ├── 可配置流程执行引擎 + SSE 事件
       ├── server ClaudeCode 调用适配器
       ├── 产品源码和补丁库
       └── MySQL

运行 cc-web 的客户端机器
  └── cc-web Rust 后端
       └── local ClaudeCode 调用适配器（调用客户端机器上的 ClaudeCode）
```

| 项目 | 约定 |
|---|---|
| patch_search | Python/FastAPI，监听 13587 |
| cc-web | Rust + 原生 JS，部署位置不固定 |
| 通信 | 浏览器 JS 直接访问 patch_search，启用 CORS；local ClaudeCode 调用通过 cc-web Rust 后端 |
| cc-web Rust 后端 | 提供受控的 local ClaudeCode 调用接口；不负责流程编排和数据库读写 |
| 数据库 | MySQL，`patch` 库；patch_search 负责读写，表结构以 `schema/current_schema.sql` 为准 |
| 补丁库存储 | 服务器 A 本地目录 |
| 产品源码 | 服务器 A 本地目录，供 server ClaudeCode 使用 |
| local ClaudeCode | 运行 cc-web 的客户端机器上的 ClaudeCode，由 cc-web Rust 后端调用 |
| server ClaudeCode | 服务器 A 上 patch_search 调用的 ClaudeCode |
| 前端 API 地址 | cc-web 编译期内嵌（`src/patch_servers.json`，可配多条，一般对应同一服务的内网穿透多隧道），经 `GET /api/patch-config` 下发前端；前端按地址轮询，连不上/超时自动切换下一条 |

补丁中心连接地址的配置方式（区别于上表 6.1 中 patch_search 自身的 `config.yaml`）：patch_search 服务地址在 `src/patch_servers.json` 中**配置多条**（编译期内嵌），通过 `include_str!` 打进 cc-web.exe，部署后不可修改。当前示例（内网穿透 4 条隧道，均指向同一 patch_search 服务）：

```json
{
  "patch_search_servers": [
    "http://fast9.shenzhuo.vip:22664",
    "http://quick9.shenzhuo.vip:13272",
    "http://quick9.shenzhuo.vip:26073",
    "http://quick9.shenzhuo.vip:10545"
  ]
}
```

- 修改只需改该文件并重新编译 cc-web（`build.bat`），不依赖运行时 `patch_config.json`（原 exe 旁运行时配置文件机制已移除）。
- `GET /api/patch-config` 返回 `{ "patch_search_servers": [...] }`。补丁中心页面启动时先拉取它取地址列表。
- 前端轮询/故障切换语义（`patches.js` 与 `workflow_run.html` 相同）：每个请求从轮询游标处取一条起始地址（游标后移实现轮询）；**连不上或请求超时**就自动切换下一条，**全部地址都失败（均超时/无法连接）才报错**；只要收到了 HTTP 响应（无论状态码）就视为该地址可达、应答权威，不再切换（避免把服务端真实报错误判成隧道故障去重发）。
- 下载、补丁上传（XHR）、流程 SSE 建流也接入同一切换逻辑：建流/下载/上传在某条地址上连不上或超时则换下一条。超时仅覆盖“建立连接、等首个响应”，拿到响应头即停止计时，不影响长时间 SSE 流程与本地 Claude 执行。

---

## 三、cc-web 页面设计

### 3.1 页面入口和整体导航

- 页面入口：
  - `/`：Chat（聊天页），无补丁左侧固定菜单。
  - `/patches.html`：补丁中心主页面。未登录时显示登录卡片，登录成功后进入功能区（左侧固定菜单 + 功能 Tab）。
  - `/workflow_run.html?run_id=…`：智能开发流程运行详情页。从智能开发的"启动流程"或运行记录"查看"进入，要求已登录（未提供登录/退出入口）。
- 各补丁页顶栏（`.patch-topbar`）右侧有「聊天 / 补丁」模式切换：聊天 → `/`，补丁 → 补丁页（workflow_run.html 的「补丁」回到 `/patches.html?tab=smart`）。按钮仅负责页面切换，不修改现有聊天业务逻辑。
- 登录态与偏好同一站点各页共享：token 存 `localStorage['patch-search-access-token']`；主题复用 `cc-web-theme`；左侧菜单折叠状态存 `cc-web-patch-sidenav`。
- 左侧固定菜单出现在 `patches.html` 与 `workflow_run.html`；只在登录态（`html.patch-auth`）显示，退出登录/会话失效后隐藏；Chat 页（`/`）不展示。

### 3.2 页面结构（登录卡 + 左侧固定菜单 + 功能 Tab）

`patches.html` 打开后先按是否已登录切换两类视图：

- **未登录**：`<html>` 无 `patch-auth` 类 → 左侧固定菜单整段隐藏（`html:not(.patch-auth) .patch-sidenav{display:none}`，内容区 `margin-left` 归零），居中显示登录卡片（用户名 / 密码 / 登录按钮），登录成功后进入功能区。
- **已登录**：显示左侧固定菜单与功能区，隐藏登录卡片。会话失效（401）时回到登录卡状态并提示重新登录。

**左侧固定菜单（`.patch-sidenav`）**——两侧补丁页共用同一套结构与逻辑：

- 固定于视口左侧，宽 `--patch-sidenav-w`（196px），右侧内容区 `.patch-page` 用 `margin-left` 让位；可折叠为纯图标栏（60px，`html.sidenav-collapsed`），状态持久化到 `cc-web-patch-sidenav`，head 内联脚本提前应用避免刷新闪烁。
- 菜单项与功能区顶部 Tab **一一对应**，文案、顺序完全一致（图标 + 文字），共 10 项：search 普通检索 → upload 补丁上传 → mine 我的补丁 → smart 智能开发 → flow 流程设置 → prompt 提示词设置 → template 流程模板设置 → analysis 待分析补丁 → product 产品版本管理 → directory 工作目录。
- 点击菜单项：若本页存在对应且可见的 Tab（已登录）则在页内切换并同步 URL `?tab=`；否则走超链接跳到 `/patches.html?tab=…`（如从运行详情页进入）。当前项高亮 `active`。
- 可见性联动（`patchSyncSidenavVisibility()`）：菜单项 `hidden` 与其对应 Tab 的 `hidden` 一致，Tab 由登录/角色决定（见下表）；workflow_run.html 无 Tab 条，单独在拉取 `/api/auth/me` 后按 `role === 'admin'` 控制 analysis / product 两项。

**功能区（登录后）**——`.patch-auth-layout` 为两栏网格（主区 `.patch-main-fill` 全宽）：

- 左栏 `.patch-user-sidebar`（sticky）：个人统计「我的数据」、贡献榜 TOP 10、活跃榜 TOP 10。
- 右栏 `.patch-auth-content`：顶部为 `.patch-tabs` 功能 Tab 条（横向可滚动，是菜单可见性的依据），下方为各 `.patch-tab-panel` 内容面板。

功能 Tab 列表（登录后按角色显示/隐藏，左侧菜单自动同步）：

| Tab | 名称 | 权限 |
|---|---|---|
| search | 普通检索 | 登录用户 |
| upload | 补丁上传 | 登录用户 |
| mine | 我的补丁 | 登录用户 |
| smart | 智能开发 | 登录用户 |
| flow | 流程设置 | 登录用户（各自管理自有配置；管理员创建的共享只读） |
| prompt | 提示词设置 | 登录用户（各自管理自有配置；管理员创建的共享只读） |
| template | 流程模板设置 | 登录用户（各自管理自有配置；管理员创建的共享只读） |
| analysis | 待分析补丁 | 仅管理员 |
| product | 产品版本管理 | 仅管理员 |
| directory | 工作目录 | 登录用户 |

非管理员登录时强制落到 search Tab；普通用户即便手动带 `?tab=analysis|product` 也会被重置回 search。

### 3.3 普通检索

使用表格展示结果，固定只显示分析完成（`status=2`）的补丁：

```text
名称 | 产品名称 | 版本号 | 格式 | 大小 | 分析时间 | 操作
```

- 关键词匹配 `name`、`description`、`user_keyword`、`class_name`、`keyword`。
- 分页：默认每页 10 条，可切换 20/50。
- 操作：详情、下载（所有登录用户）。
- **管理员额外显示"编辑/删除"按钮**（普通用户不可见）：
  - 编辑：打开"修改补丁信息"弹窗，可修改名称、产品名称、版本号、描述、关键词，并可**直接修改补丁状态**（0 待分析 / 1 分析中 / 2 分析完成 / 3 分析失败）。
  - 删除：确认后删除补丁库文件与数据库记录。
  - 状态语义：`status=0` 时清空 `class_name`、`keyword`、`analysis_result`、`analyzed_at` 重置为待分析；置为 2 时若 `analyzed_at` 为空则补齐当前时间，保证可被检索到；其他状态保留已有分析结果。

```sql
SELECT * FROM patch_info
WHERE status = 2
  AND (name LIKE ? OR description LIKE ? OR user_keyword LIKE ?
       OR class_name LIKE ? OR keyword LIKE ?)
ORDER BY analyzed_at DESC, uploaded_at DESC
LIMIT ? OFFSET ?;
```

### 3.4 补丁上传

- 拖拽上传、点击选择文件、多选 zip/rar。
- 选择文件后展示上传确认弹窗，逐行列出文件，每个文件可填名称、产品名称、版本号、描述、关键词。
- 产品名称为单选下拉（来源产品字典），版本号为可输入下拉（选择产品后联动过滤其版本）；`patch_info` 保存所选文本快照。详见第十七章。
- “开始上传”后逐文件显示上传进度条、成功/失败原因。
- 上传成功写入 `patch_info`，`status=0`，不自动分析。
- 上传结果区域展示成功/失败文件，不刷新普通检索列表。

### 3.5 我的补丁

展示当前用户上传的所有补丁（不受 `status=2` 限制）：

```text
名称 | 产品名称 | 版本号 | 格式 | 大小 | 状态 | 操作
```

- 操作：编辑、删除；`status=2` 时额外显示详情、下载。
- 编辑弹窗字段：名称、产品名称、版本号、描述、关键词；管理员额外可见并可修改"状态"字段。
- 普通用户（本人补丁）**编辑保存后补丁重置为 `status=0`（待分析），并清空 `class_name`、`keyword`、`analysis_result`、`analyzed_at`**；需要管理员重新分析后才会再次出现在普通检索结果中。管理员编辑可显式指定状态（见 3.3）。
- 删除会删除补丁库中对应文件并移除数据库记录。

### 3.6 智能开发

- 选择启用的流程模板（含管理员共享模板）。
- 输入业务需求。
- 提交后展示动态步骤列表（步骤数量/顺序由模板决定）。
- 第一步自动开始执行；每步完成后暂停，展示本步结果。
- 用户点击“下一步”才执行后续步骤；点击“结束流程”取消运行。
- 运行中通过 SSE 接收步骤事件，页面随事件更新状态。
- 进入智能开发 Tab 时自动恢复当前用户未结束的运行。
- 运行历史列表展示当前用户创建的所有运行记录，可查看步骤详情、单步结果。

### 3.7 流程设置

流程是可被多个流程模板复用的通用定义，支持新增、查询、编辑和删除。

表单字段：

- 流程名称。
- 流程唯一 `code`（创建后禁止修改）。
- 描述。
- 调用目标：客户端本地 ClaudeCode / 服务器 A ClaudeCode。
- 是否保存上下文。
- 工作目录 `directory_code`：只保存逻辑 code，不保存某个用户的实际 path。`server` 目标必填；`local` 目标可留空（表单提示"本地 ClaudeCode 可留空，启动流程时由使用者逐步骤选择或手动填写本机路径"），启动时由使用者绑定。

删除约束：被任一流程模板步骤引用（`workflow_template_step.flow_id`）的流程不能删除；`code` 作为模板变量和历史运行记录快照的稳定引用，不可修改。

所有权：管理员创建的流程对所有用户可见并可使用（只读）；普通用户创建的流程仅自己可见和管理。

### 3.8 提示词设置

支持提示词增删改查、启用/停用。

表单字段：

- 名称。
- `content` 正文。
- 描述。
- 状态（0 停用、1 启用）。

模板配置时只展示启用的提示词。被模板步骤引用（`prompt_id`）的提示词不能删除。管理员创建的提示词共享只读；普通用户管理自己的提示词。

### 3.9 流程模板设置

流程模板由多个有序步骤组成，每一步配置：

- 选择流程。
- 选择提示词，可选。
- 用户提示词。
- 是否覆盖流程默认的上下文保存设置。
- 步骤顺序。

支持步骤新增、删除、排序、编辑和复制。已有运行记录（`workflow_run`）的模板禁止编辑和删除，只能新建模板（保证历史运行可追溯）。

### 3.10 待分析补丁（管理员）

管理员专属 Tab：

- 列出所有 `status != 2`（未分析/分析中/分析失败）的补丁。
- 勾选多个补丁后点击“开始分析”。
- 创建后台分析任务，页面轮询任务状态并显示进度。
- 成功后 `status=2` 并写入分析字段；失败 `status=3`；同批次其他补丁继续处理。

### 3.11 工作目录管理

- 普通用户可创建、编辑、停用、删除自己创建的非内置目录。
- 管理员可创建内置目录（`is_builtin=1`）；内置目录对所有用户可见可用，只读（普通用户操作列显示"只读"）。
- 目录字段：编码、名称、路径、类型、状态。
- 目录路径：**内置目录**（仅管理员）必须是服务器 A 上真实存在的绝对目录路径；**个人目录**（普通用户）指向运行 cc-web 的**客户端机器**上的绝对路径，服务端**只校验非空与绝对路径**、不校验存在性，实际存在性在执行 `local` 步骤时由 cc-web 校验。
- 操作列按钮（非只读行）：`编辑`、`停用`、`删除`。
  - `停用`：软删除，`DELETE /api/workflows/directories/{id}` → `status=0`；记录保留，被模板/历史运行按 `code` 引用时仍可解析（启用状态过滤下不可选）。
  - `删除`：物理删除，`DELETE /api/workflows/directories/{id}/permanent`；点击后弹确认框（`patchConfirm`）提示"删除后无法恢复。若有流程模板或运行记录引用该目录，相关流程将无法再解析此工作目录"，确认后才执行。
- 目录列表同时展示内置目录和当前用户自己的目录（`is_builtin=1 OR created_by_user_id=当前用户`），不过滤 `status`，停用目录仍以"停用"状态显示。

### 3.12 用户设置

- 查看当前用户资料（用户名、显示名称、角色、注册时间、最近登录时间）。
- 修改密码（校验旧密码，新密码不能与旧密码相同，成功后递增 `token_version` 使旧 Token 失效）。

---

## 四、数据库设计

数据库为 `patch`，当前完整结构见 `schema/current_schema.sql`。以下按该文件列出各表。增量迁移脚本见 `schema/migration_runtime_directory_binding.sql`（运行时工作目录绑定，见第十九章）。

### 4.1 补丁表 `patch_info`

```sql
CREATE TABLE `patch_info` (
  `id` varchar(64) NOT NULL COMMENT '补丁唯一 ID，上传时生成 UUID',
  `name` varchar(255) NOT NULL COMMENT '补丁展示名称，未填写时使用去扩展名的文件名',
  `description` text COMMENT '用户填写的补丁描述',
  `file_name` varchar(255) NOT NULL COMMENT '原始上传文件名，包含 zip 或 rar 扩展名',
  `storage_path` varchar(1024) NOT NULL COMMENT '相对补丁库根目录的受控存储路径',
  `file_size` bigint(20) NOT NULL DEFAULT '0' COMMENT '压缩包大小，单位为字节',
  `file_format` varchar(10) NOT NULL DEFAULT 'zip' COMMENT '压缩包格式，仅允许 zip 或 rar',
  `status` tinyint(4) NOT NULL DEFAULT '0' COMMENT '分析状态：0 未分析、1 分析中、2 分析完成、3 分析失败',
  `user_keyword` varchar(2048) DEFAULT NULL COMMENT '用户填写的关键词，使用逗号分隔',
  `class_name` text COMMENT '分析得到的类名，使用逗号分隔',
  `keyword` varchar(2048) DEFAULT NULL COMMENT '分析得到的功能关键词，使用逗号分隔',
  `analysis_result` json DEFAULT NULL COMMENT '分析得到的结构化结果',
  `uploaded_by_user_id` bigint(20) unsigned DEFAULT NULL COMMENT '上传用户 ID，由服务端根据 JWT 确定',
  `uploaded_at` datetime DEFAULT NULL COMMENT '上传完成时间',
  `analyzed_at` datetime DEFAULT NULL COMMENT '最近一次分析完成或失败时间',
  `created_at` datetime DEFAULT NULL COMMENT '记录创建时间',
  `updated_at` datetime DEFAULT NULL COMMENT '记录最后更新时间',
  `product_name` varchar(128) NOT NULL DEFAULT '' COMMENT '产品名称',
  `product_version` varchar(64) NOT NULL DEFAULT '' COMMENT '产品版本号',
  PRIMARY KEY (`id`),
  KEY `idx_name` (`name`),
  KEY `idx_status` (`status`),
  KEY `idx_patch_info_uploaded_by_user` (`uploaded_by_user_id`),
  CONSTRAINT `fk_patch_info_uploaded_by_user` FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `user_account` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='补丁包信息及分析结果表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | VARCHAR(64) | 否 | 补丁唯一 ID，上传时生成 UUID，主键。 |
| `name` | VARCHAR(255) | 否 | 补丁展示名称；用户可填，未填则使用去扩展名文件名。 |
| `description` | TEXT | 是 | 用户上传时填写的补丁说明。 |
| `file_name` | VARCHAR(255) | 否 | 原始上传文件名，含 `.zip` 或 `.rar` 扩展名。 |
| `storage_path` | VARCHAR(1024) | 否 | 相对补丁库根目录的受控存储路径，不接收用户直接指定。 |
| `file_size` | BIGINT | 否 | 文件大小，单位为字节，默认 0。 |
| `file_format` | VARCHAR(10) | 否 | 压缩格式，仅允许 `zip` 或 `rar`。 |
| `status` | TINYINT | 否 | 分析状态：0 未分析、1 分析中、2 分析完成、3 分析失败。普通检索仅查询 2。 |
| `user_keyword` | VARCHAR(2048) | 是 | 上传用户填写的关键词，逗号分隔且不含空格。 |
| `class_name` | TEXT | 是 | 管理员分析得到的类名，逗号分隔且不含空格。 |
| `keyword` | VARCHAR(2048) | 是 | 管理员分析得到的功能关键词，逗号分隔且不含空格。 |
| `analysis_result` | JSON | 是 | 管理员分析得到的结构化结果。 |
| `uploaded_by_user_id` | BIGINT UNSIGNED | 是 | 上传用户 ID，外键关联 `user_account.id`，由服务端从 JWT 解析确定。 |
| `uploaded_at` | DATETIME | 是 | 上传完成时间。 |
| `analyzed_at` | DATETIME | 是 | 最近一次分析完成或失败时间。 |
| `created_at` / `updated_at` | DATETIME | 是 | 记录创建/更新时间。 |
| `product_name` | VARCHAR(128) | 否 | 产品名称，上传必填，默认空串。 |
| `product_version` | VARCHAR(64) | 否 | 产品版本号，上传必填，默认空串。 |

> 编辑补丁（`PUT /api/patches/{id}`）：普通用户（本人补丁）重置 `status=0` 并清空 `class_name`、`keyword`、`analysis_result`、`analyzed_at`，使补丁回到待分析状态；管理员可编辑任意补丁并显式指定 `status`（0~3），`status=0` 时同样清空分析结果，`status=2` 时补齐 `analyzed_at`。

### 4.2 用户表 `user_account`

```sql
CREATE TABLE `user_account` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '用户唯一 ID，也是 JWT sub 和运行归属用户 ID 的来源',
  `username` varchar(128) NOT NULL COMMENT '登录用户名',
  `password_hash` varchar(255) NOT NULL COMMENT 'Argon2id 或 bcrypt 密码哈希，禁止保存明文密码',
  `display_name` varchar(255) NOT NULL COMMENT '页面展示名称',
  `role` varchar(32) NOT NULL DEFAULT 'user' COMMENT '用户角色：user 或 admin',
  `status` tinyint(4) NOT NULL DEFAULT '1' COMMENT '账号状态：0 禁用、1 启用',
  `token_version` int(10) unsigned NOT NULL DEFAULT '0' COMMENT 'JWT 撤销版本，递增后旧 Token 全部失效',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '账号创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '账号最后更新时间',
  `last_login_at` datetime DEFAULT NULL COMMENT '最近一次成功登录时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_account_username` (`username`),
  KEY `idx_user_account_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='patch_search 用户账号表';
```

管理员账号由部署方预先写入（密码只保存安全哈希）。当前代码不提供引导式创建管理员逻辑。

### 4.3 工作目录表 `workflow_directory`

```sql
CREATE TABLE `workflow_directory` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '工作目录主键',
  `code` varchar(128) NOT NULL COMMENT '工作目录业务编码，流程配置保存此值',
  `name` varchar(255) NOT NULL COMMENT '工作目录显示名称',
  `path` varchar(1024) NOT NULL COMMENT '服务端实际路径或受控目录 key',
  `created_by_user_id` bigint(20) unsigned DEFAULT NULL COMMENT '创建人 ID，NULL 表示管理员内置目录',
  `is_builtin` tinyint(4) NOT NULL DEFAULT '0' COMMENT '是否内置目录：0 否、1 是',
  `status` tinyint(4) NOT NULL DEFAULT '1' COMMENT '目录状态：0 停用、1 启用',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_workflow_directory_owner` (`created_by_user_id`),
  KEY `idx_workflow_directory_lookup` (`created_by_user_id`,`code`,`status`),
  CONSTRAINT `fk_workflow_directory_owner` FOREIGN KEY (`created_by_user_id`) REFERENCES `user_account` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户工作目录和管理员内置工作目录';
```

目录规则：

- `created_by_user_id IS NULL` 且 `is_builtin=1` 表示管理员内置目录，对所有用户可见可用、只读。
- 普通用户只能编辑和停用自己创建的非内置目录；`is_builtin` 不能由普通用户伪造为 1。
- 管理员可以创建、编辑和停用内置目录及普通目录。
- 查询时优先匹配当前用户自己的启用目录，再匹配管理员内置启用目录。
- `path` 必须是服务器上存在的绝对目录路径，经 `Path.resolve()` 标准化；拒绝空路径、相对路径、不存在路径和文件路径。
- 停用使用 `status=0`（`DELETE /api/workflows/directories/{id}` 实际执行停用），不物理删除。
- 物理删除使用 `DELETE /api/workflows/directories/{id}/permanent`，直接 `DELETE FROM workflow_directory`；`workflow_run_step.directory_id` 外键为 `ON DELETE SET NULL`，历史运行记录保留但目录引用置空。权限与停用一致：个人目录仅本人、内置目录仅管理员。

### 4.4 流程表 `workflow_flow`

```sql
CREATE TABLE `workflow_flow` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '流程内部唯一 ID',
  `code` varchar(128) NOT NULL COMMENT '流程稳定唯一编码，供模板变量引用',
  `name` varchar(255) NOT NULL COMMENT '流程名称',
  `description` text COMMENT '流程用途说明',
  `claude_target` varchar(32) NOT NULL COMMENT 'ClaudeCode 调用目标：local 或 server',
  `directory_code` varchar(128) DEFAULT NULL COMMENT '工作目录业务编码，执行时按当前用户解析实际目录；local 目标可为空，运行时绑定',
  `save_context` tinyint(4) NOT NULL DEFAULT '1' COMMENT '是否保存该流程最近一次上下文快照：0 否、1 是',
  `context` longtext COMMENT '流程最近一次上下文快照，仅供查看',
  `result` longtext COMMENT '流程最近一次模型输出结果快照，仅供查看',
  `created_by_user_id` bigint(20) unsigned DEFAULT NULL COMMENT '流程创建用户 ID',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflow_flow_code` (`code`),
  KEY `idx_workflow_flow_owner` (`created_by_user_id`),
  CONSTRAINT `fk_workflow_flow_owner` FOREIGN KEY (`created_by_user_id`) REFERENCES `user_account` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='可复用流程定义表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | BIGINT UNSIGNED | 否 | 自增主键，流程内部唯一标识。 |
| `code` | VARCHAR(128) | 否 | 流程稳定唯一编码，供模板变量引用；创建后禁止修改。 |
| `name` | VARCHAR(255) | 否 | 流程展示名称。 |
| `description` | TEXT | 是 | 流程用途说明。 |
| `claude_target` | VARCHAR(32) | 否 | ClaudeCode 调用目标：`local` 或 `server`。 |
| `directory_code` | VARCHAR(128) | 是 | 工作目录业务编码；`server` 目标必填，执行时按当前用户解析实际目录；`local` 目标可为空，启动流程时由使用者逐步骤绑定（见第十九章「方案 A」）。 |
| `save_context` | TINYINT | 否 | 是否允许该步骤输出作为后续步骤上下文：0 否、1 是。 |
| `context` / `result` | LONGTEXT | 是 | 流程最近快照，仅供查看；当前代码运行时不会自动更新这两个字段，运行数据保存在 `workflow_run_step`。 |
| `created_by_user_id` | BIGINT UNSIGNED | 是 | 流程创建用户 ID，外键关联 `user_account.id`。 |
| `created_at` / `updated_at` | DATETIME | 否 | 创建/更新时间。 |

### 4.5 提示词表 `workflow_prompt`

```sql
CREATE TABLE `workflow_prompt` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '提示词内部唯一 ID',
  `name` varchar(255) NOT NULL COMMENT '提示词名称',
  `content` longtext NOT NULL COMMENT '可复用提示词正文',
  `description` text COMMENT '提示词用途说明',
  `status` tinyint(4) NOT NULL DEFAULT '1' COMMENT '使用状态：0 停用、1 启用',
  `created_by_user_id` bigint(20) unsigned DEFAULT NULL COMMENT '提示词创建用户 ID',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_workflow_prompt_status` (`status`),
  KEY `idx_workflow_prompt_owner_status` (`created_by_user_id`,`status`),
  CONSTRAINT `fk_workflow_prompt_owner` FOREIGN KEY (`created_by_user_id`) REFERENCES `user_account` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='可复用提示词表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | BIGINT UNSIGNED | 否 | 自增主键，提示词内部唯一标识。 |
| `name` | VARCHAR(255) | 否 | 提示词展示名称。 |
| `content` | LONGTEXT | 否 | 固定提示词正文，模板步骤通过 `{{prompt.content}}` 引用。 |
| `description` | TEXT | 是 | 提示词用途说明。 |
| `status` | TINYINT | 否 | 使用状态：0 停用、1 启用。模板选择时仅展示启用记录。 |
| `created_by_user_id` | BIGINT UNSIGNED | 是 | 提示词创建用户 ID，外键关联 `user_account.id`。 |
| `created_at` / `updated_at` | DATETIME | 否 | 创建/更新时间。 |

### 4.6 流程模板主表 `workflow_template`

```sql
CREATE TABLE `workflow_template` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '流程模板内部唯一 ID',
  `code` varchar(128) NOT NULL COMMENT '模板稳定唯一编码',
  `name` varchar(255) NOT NULL COMMENT '模板名称',
  `description` text COMMENT '模板用途和适用场景说明',
  `status` tinyint(4) NOT NULL DEFAULT '1' COMMENT '使用状态：0 停用、1 启用',
  `created_by_user_id` bigint(20) unsigned DEFAULT NULL COMMENT '流程模板创建用户 ID',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflow_template_code` (`code`),
  KEY `idx_workflow_template_status` (`status`),
  KEY `idx_workflow_template_owner_status` (`created_by_user_id`,`status`),
  CONSTRAINT `fk_workflow_template_owner` FOREIGN KEY (`created_by_user_id`) REFERENCES `user_account` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='智能检索流程模板主表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | BIGINT UNSIGNED | 否 | 自增主键，模板内部唯一标识。 |
| `code` | VARCHAR(128) | 否 | 模板稳定唯一编码。 |
| `name` | VARCHAR(255) | 否 | 模板展示名称。 |
| `description` | TEXT | 是 | 模板用途和适用场景说明。 |
| `status` | TINYINT | 否 | 使用状态：0 停用、1 启用；用户只能启动启用模板。 |
| `created_by_user_id` | BIGINT UNSIGNED | 是 | 模板创建用户 ID，外键关联 `user_account.id`。 |
| `created_at` / `updated_at` | DATETIME | 否 | 创建/更新时间。 |

### 4.7 流程模板步骤表 `workflow_template_step`

模板需要支持任意数量步骤，因此使用主表和步骤表，而不是把多个流程塞进一个字段。

```sql
CREATE TABLE `workflow_template_step` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '模板步骤内部唯一 ID',
  `template_id` bigint(20) unsigned NOT NULL COMMENT '所属流程模板 ID',
  `step_order` int(11) NOT NULL COMMENT '模板内执行顺序，从 1 开始且连续',
  `flow_id` bigint(20) unsigned NOT NULL COMMENT '关联的通用流程 ID',
  `prompt_id` bigint(20) unsigned DEFAULT NULL COMMENT '可选关联的可复用提示词 ID',
  `user_prompt` longtext COMMENT '第 1 步为空时执行时使用业务输入',
  `save_context_override` tinyint(4) DEFAULT NULL COMMENT '是否覆盖流程默认上下文保存设置：NULL 使用默认、0 否、1 是',
  `status` tinyint(4) NOT NULL DEFAULT '1' COMMENT '步骤状态：0 停用、1 启用',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_template_step_order` (`template_id`,`step_order`),
  KEY `idx_template_step_flow` (`template_id`,`flow_id`),
  KEY `fk_template_step_flow` (`flow_id`),
  KEY `fk_template_step_prompt` (`prompt_id`),
  CONSTRAINT `fk_template_step_flow` FOREIGN KEY (`flow_id`) REFERENCES `workflow_flow` (`id`),
  CONSTRAINT `fk_template_step_prompt` FOREIGN KEY (`prompt_id`) REFERENCES `workflow_prompt` (`id`),
  CONSTRAINT `fk_template_step_template` FOREIGN KEY (`template_id`) REFERENCES `workflow_template` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='流程模板步骤配置表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | BIGINT UNSIGNED | 否 | 自增主键，模板步骤唯一标识。 |
| `template_id` | BIGINT UNSIGNED | 否 | 所属模板 ID，外键关联 `workflow_template.id`。 |
| `step_order` | INT | 否 | 模板中的执行顺序；同一模板内唯一，从 1 开始。 |
| `flow_id` | BIGINT UNSIGNED | 否 | 引用的通用流程 ID，外键关联 `workflow_flow.id`。 |
| `prompt_id` | BIGINT UNSIGNED | 是 | 可选引用提示词 ID，外键关联 `workflow_prompt.id`。 |
| `user_prompt` | LONGTEXT | 是 | 用户提示词模板，支持业务输入和前置结果变量；第 1 步为空时执行使用业务输入。 |
| `save_context_override` | TINYINT | 是 | 上下文保存覆盖值：NULL 使用流程默认，0 不保存，1 保存。 |
| `status` | TINYINT | 否 | 模板步骤状态：0 停用、1 启用。 |
| `created_at` / `updated_at` | DATETIME | 否 | 创建/更新时间。 |

> 当前表结构没有独立的 `system_prompt` 字段。执行时把提示词正文和渲染后的用户提示词拼接为单个提示词串（见 8.4）。

### 4.8 流程运行表 `workflow_run`

每次用户启动流程创建一个独立运行实例，避免不同用户之间相互覆盖上下文和结果。

```sql
CREATE TABLE `workflow_run` (
  `id` char(36) NOT NULL COMMENT '本次流程运行 UUID',
  `template_id` bigint(20) unsigned NOT NULL COMMENT '启动时选择的流程模板 ID',
  `business_input` longtext NOT NULL COMMENT '用户提交的业务需求或问题',
  `status` varchar(32) NOT NULL DEFAULT 'pending' COMMENT '运行状态：pending、running、waiting_confirmation、success、failed、cancelled',
  `current_step` int(11) DEFAULT NULL COMMENT '当前执行或等待确认的步骤序号',
  `context` longtext COMMENT '本次运行的上下文汇总',
  `result` longtext COMMENT '本次运行的最终结果汇总',
  `error_message` text COMMENT '运行失败原因',
  `created_by_user_id` bigint(20) unsigned NOT NULL COMMENT '服务端从 JWT 解析得到的运行归属用户 ID',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '运行创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  `finished_at` datetime DEFAULT NULL COMMENT '运行结束时间',
  PRIMARY KEY (`id`),
  KEY `idx_workflow_run_status` (`status`),
  KEY `idx_workflow_run_template` (`template_id`),
  KEY `idx_workflow_run_owner_updated` (`created_by_user_id`,`updated_at`,`created_at`),
  CONSTRAINT `fk_workflow_run_owner` FOREIGN KEY (`created_by_user_id`) REFERENCES `user_account` (`id`),
  CONSTRAINT `fk_workflow_run_template` FOREIGN KEY (`template_id`) REFERENCES `workflow_template` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='流程运行汇总表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | CHAR(36) | 否 | 本次流程运行唯一 ID，使用 UUID，主键。 |
| `template_id` | BIGINT UNSIGNED | 否 | 启动时选择的流程模板 ID，外键关联 `workflow_template.id`。 |
| `business_input` | LONGTEXT | 否 | 用户提交的业务逻辑原始输入。 |
| `status` | VARCHAR(32) | 否 | 运行状态：`pending`、`running`、`waiting_confirmation`、`success`、`failed`、`cancelled`。 |
| `current_step` | INT | 是 | 当前正在执行或等待确认的步骤序号。 |
| `context` | LONGTEXT | 是 | 本次运行可传递的上下文汇总。 |
| `result` | LONGTEXT | 是 | 本次运行完成后的最终结果汇总。 |
| `error_message` | TEXT | 是 | 当前或最终失败原因。 |
| `created_by_user_id` | BIGINT UNSIGNED | 否 | 服务端从 JWT 解析并查库得到的运行归属用户 ID；运行隔离依据。 |
| `created_at` / `updated_at` | DATETIME | 否 | 创建/更新时间。 |
| `finished_at` | DATETIME | 是 | 成功、失败或取消结束时间。 |

> 当前表结构已无旧的 `created_by` 字段，运行归属只使用 `created_by_user_id`。

### 4.9 流程运行步骤表 `workflow_run_step`

```sql
CREATE TABLE `workflow_run_step` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '运行步骤内部唯一 ID',
  `run_id` char(36) NOT NULL COMMENT '所属流程运行 UUID',
  `template_step_id` bigint(20) unsigned DEFAULT NULL COMMENT '所属模板步骤 ID；模板步骤被删除时置空，运行中的流程跳过该步骤',
  `step_order` int(11) NOT NULL COMMENT '本次运行中的步骤顺序',
  `flow_code` varchar(128) NOT NULL COMMENT '本步骤使用的流程编码快照',
  `directory_code` varchar(128) DEFAULT NULL COMMENT '本步骤工作目录编码快照；local 手动填写路径时为空',
  `directory_id` bigint(20) unsigned DEFAULT NULL COMMENT '本步骤使用的用户目录 ID 快照；内置目录或手动路径为空',
  `directory_type` varchar(32) NOT NULL COMMENT '目录来源：user、builtin 或 manual（运行时手动填写路径）',
  `resolved_directory` varchar(1024) NOT NULL COMMENT '执行时解析出的目录路径或受控目录 key 快照',
  `status` varchar(32) NOT NULL DEFAULT 'pending' COMMENT '步骤状态：pending、running、waiting_confirmation、success、failed、cancelled',
  `rendered_user_prompt` longtext COMMENT '解析变量后的用户提示词快照',
  `input_context` longtext COMMENT '执行前汇总的输入上下文',
  `output_context` longtext COMMENT '允许后续步骤使用的输出上下文',
  `output_result` longtext COMMENT 'ClaudeCode 原始输出或结构化结果',
  `error_message` text COMMENT '当前步骤失败原因',
  `execution_token` varchar(255) DEFAULT NULL COMMENT 'local ClaudeCode 一次性结果回传令牌',
  `token_expires_at` datetime DEFAULT NULL COMMENT '一次性执行令牌过期时间',
  `execution_user_id` bigint(20) unsigned DEFAULT NULL COMMENT '允许使用该执行令牌的用户 ID',
  `token_used_at` datetime DEFAULT NULL COMMENT '执行令牌消费时间，用于防止重放',
  `local_session_id` varchar(128) DEFAULT NULL COMMENT '本地 ClaudeCode 会话 id，用于继续会话',
  `started_at` datetime DEFAULT NULL COMMENT '步骤开始执行时间',
  `finished_at` datetime DEFAULT NULL COMMENT '步骤完成、失败或取消时间',
  `confirmed_at` datetime DEFAULT NULL COMMENT '用户点击下一步确认的时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflow_run_step` (`run_id`,`step_order`) COMMENT '保证同一运行步骤顺序唯一',
  KEY `idx_workflow_run_step_status` (`run_id`,`status`) COMMENT '按运行和步骤状态查询',
  KEY `fk_workflow_run_step_template_step` (`template_step_id`),
  KEY `idx_workflow_run_step_execution_user` (`execution_user_id`),
  KEY `fk_workflow_run_step_directory` (`directory_id`),
  CONSTRAINT `fk_workflow_run_step_execution_user` FOREIGN KEY (`execution_user_id`) REFERENCES `user_account` (`id`),
  CONSTRAINT `fk_workflow_run_step_directory` FOREIGN KEY (`directory_id`) REFERENCES `workflow_directory` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_workflow_run_step_run` FOREIGN KEY (`run_id`) REFERENCES `workflow_run` (`id`),
  CONSTRAINT `fk_workflow_run_step_template_step` FOREIGN KEY (`template_step_id`) REFERENCES `workflow_template_step` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='流程运行步骤明细表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | BIGINT UNSIGNED | 否 | 自增主键，运行步骤唯一标识。 |
| `run_id` | CHAR(36) | 否 | 所属运行实例 ID，外键关联 `workflow_run.id`。 |
| `template_step_id` | BIGINT UNSIGNED | 是 | 所属模板步骤 ID，外键关联 `workflow_template_step.id`（`ON DELETE SET NULL`）；模板步骤被删除时置空，运行中的流程跳过该步骤。 |
| `step_order` | INT | 否 | 在本次运行中的执行顺序；同一运行内唯一。 |
| `flow_code` | VARCHAR(128) | 否 | 本步骤实际使用的流程 code 快照，支持按 code 引用结果。 |
| `directory_code` | VARCHAR(128) | 是 | 从流程配置继承的工作目录 code 快照；`local` 步骤运行时手填本机路径时为空。 |
| `directory_id` | BIGINT UNSIGNED | 是 | 运行时绑定的工作目录 ID（个人/内置目录）；手填路径时为空。外键关联 `workflow_directory.id`（`ON DELETE SET NULL`）。 |
| `directory_type` | VARCHAR(32) | 否 | 目录来源：`user`、`builtin` 或 `manual`（运行时手填本机路径）。 |
| `resolved_directory` | VARCHAR(1024) | 否 | 执行时解析出的实际目录路径或受控目录 key 快照。 |
| `status` | VARCHAR(32) | 否 | 步骤状态：`pending`、`running`、`waiting_confirmation`、`success`、`failed`、`cancelled`。确认后直接置为 `success`，无单独的 `confirmed` 状态。 |
| `rendered_user_prompt` | LONGTEXT | 是 | 本次实际解析变量后的用户提示词快照。 |
| `input_context` | LONGTEXT | 是 | 执行前从前置步骤、提示词和用户输入汇总出的上下文。 |
| `output_context` | LONGTEXT | 是 | 可供后续步骤使用的输出上下文。 |
| `output_result` | LONGTEXT | 是 | ClaudeCode 原始输出或规范化后的结构化模型结果。 |
| `error_message` | TEXT | 是 | 当前步骤失败原因。 |
| `execution_token` | VARCHAR(255) | 是 | local ClaudeCode 结果回传的一次性短期令牌，不是登录凭证。 |
| `token_expires_at` | DATETIME | 是 | local 结果令牌失效时间。 |
| `execution_user_id` | BIGINT UNSIGNED | 是 | 允许使用该 local 执行令牌的用户 ID，外键关联 `user_account.id`。 |
| `token_used_at` | DATETIME | 是 | 令牌成功消费时间，用于防止重放。 |
| `local_session_id` | VARCHAR(128) | 是 | 本地 ClaudeCode 会话 id，用于「继续会话」（见第十八章）。 |
| `started_at` / `finished_at` / `confirmed_at` | DATETIME | 是 | 开始、结束、确认时间。 |

> 当前表结构没有独立的 `rendered_system_prompt` 字段；系统提示词与用户提示词在 `input_context`/`rendered_user_prompt` 中体现。

### 4.10 所有权与共享模型

流程、提示词、模板、工作目录四类配置均通过 `created_by_user_id` 关联创建人（外键 `user_account.id`）：

- **管理员创建的配置**（`created_by_user_id` 对应 `role='admin'` 的用户）对所有用户共享：普通用户可见、可使用，但只读。
- **普通用户创建的配置**仅自己可见和可管理。
- **兼容旧数据**：`created_by_user_id IS NULL` 的历史记录同样视为管理员共享。
- 工作目录额外有 `is_builtin`：`created_by_user_id IS NULL AND is_builtin=1` 为管理员内置目录，对所有用户可见可用、只读。

运行记录 `workflow_run` 不参与共享：普通用户只能访问自己的运行，管理员运行不向普通用户开放。列表和详情查询均按 `created_by_user_id` 严格过滤。

### 4.11 产品字典表 `product`

```sql
CREATE TABLE `product` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) NOT NULL COMMENT '产品名称',
  `sort_order` int(11) NOT NULL DEFAULT '0' COMMENT '显示排序，越小越靠前',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='产品字典表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | BIGINT UNSIGNED | 否 | 自增主键，产品唯一标识。 |
| `name` | VARCHAR(128) | 否 | 产品名称，唯一。 |
| `sort_order` | INT | 否 | 显示排序，越小越靠前，默认 0。 |
| `created_at` / `updated_at` | DATETIME | 否 | 创建/更新时间。 |

### 4.12 产品版本字典表 `product_version`

```sql
CREATE TABLE `product_version` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `product_id` bigint(20) unsigned NOT NULL COMMENT '所属产品 ID',
  `version` varchar(64) NOT NULL COMMENT '版本号',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_version` (`product_id`,`version`),
  KEY `idx_product_version_product` (`product_id`),
  CONSTRAINT `fk_product_version_product` FOREIGN KEY (`product_id`) REFERENCES `product` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='产品版本字典表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | BIGINT UNSIGNED | 否 | 自增主键，版本唯一标识。 |
| `product_id` | BIGINT UNSIGNED | 否 | 所属产品 ID，外键关联 `product.id`，级联删除。 |
| `version` | VARCHAR(64) | 否 | 版本号，同一产品内唯一。 |
| `created_at` / `updated_at` | DATETIME | 否 | 创建/更新时间。 |

> 两张表仅作为补丁上传时的下拉选项来源（见第十七章），`patch_info.product_name / product_version` 仍保存上传时的文本快照，不引用本表 ID；删除字典记录不影响历史补丁。

---

## 五、patch_search 工程结构

```text
patch_search/
├── app/
│   ├── main.py                 # FastAPI 入口、中间件、路由注册
│   ├── config.py               # 配置加载
│   ├── db.py                   # 数据库连接池
│   ├── schemas.py              # Pydantic 请求/响应模型
│   ├── auth.py                 # JWT 签发/校验、当前用户、require_admin
│   ├── logging_config.py       # 日志配置
│   ├── routes/
│   │   ├── health.py           # GET /api/health
│   │   ├── auth.py             # login / me / profile / change-password / logout
│   │   ├── dashboard.py        # GET /api/dashboard 仪表盘统计
│   │   ├── search.py           # GET /api/patches 普通检索
│   │   ├── patches.py          # mine / pending-analysis / analyze / 详情 / 下载 / 编辑 / 删除
│   │   ├── upload.py           # POST /api/patches/upload
│   │   ├── products.py         # 产品 / 产品版本字典管理 + 上传下拉选项
│   │   ├── workflows.py        # 工作目录 / 流程 / 提示词 / 模板管理
│   │   └── workflow_runs.py    # 运行创建 / 列表 / 详情 / 下一步 / 取消 / 单步结果 / SSE
│   ├── workflow/
│   │   ├── engine.py           # 流程执行引擎
│   │   ├── context.py          # 提示词变量渲染
│   │   ├── events.py           # SSE 事件中心
│   │   └── handlers/
│   │       ├── base.py         # Handler 协议
│   │       ├── local_request.py    # local 流程：生成一次性执行令牌，等待前端回传
│   │       └── server_claude.py    # server 流程：调用服务器 A ClaudeCode
│   └── services/
│       ├── archive.py          # 压缩包完整性校验
│       ├── claude_service.py   # ClaudeCode CLI 调用
│       ├── analysis_service.py # 单补丁分析逻辑
│       ├── analysis_tasks.py   # 后台分析任务管理器
│       └── directory_service.py# 工作目录校验与解析
├── scripts/
│   └── analyze_batch.py        # 命令行批量分析
├── schema/
│   └── current_schema.sql      # 当前完整表结构
├── config.yaml
├── analyze_config.yaml
├── requirements.txt
└── README.md
```

cc-web Rust 工程提供受控的客户端 ClaudeCode 接口：

```text
src/api/local_claude.rs  # 接收浏览器请求并调用客户端机器上的 ClaudeCode
src/ai/claude.rs         # 复用现有 ClaudeCode 命令构造和进程处理
```

流程引擎只负责读取模板、解析上下文、调用步骤处理器和保存运行记录，不写死具体的“需求分析/补丁审查/置信度”等步骤名称。

---

## 六、配置文件

### 6.1 `config.yaml`

服务启动时由 `app/config.py` 读取；相对路径均相对于 `config.yaml` 所在目录解析。密码、Token 等敏感值不应提交到代码仓库。当前实际配置结构：

```yaml
server:
  host: "0.0.0.0"
  port: 13587

database:
  host: "10.4.122.21"
  port: 3306
  user: "admin"
  password: "******"
  db: "patch"
  minsize: 1
  maxsize: 10
  connect_timeout_seconds: 10

paths:
  library_root: 'D:\patch\patches'
  product_source: 'D:\project\FBIPV82-javasource'
  temp_dir: './data/temp'

claude:
  cli: 'C:\Users\Administrator\.local\bin\claude'
  permission_mode: "bypassPermissions"
  model: ""
  timeout_seconds: 1800
  git_bash_path: ""
  prompts:
    product_analysis:
      name: "product-analysis-prompt"
      path: 'D:\project\fbip-skill\fbip_claude_skills'
    confidence_guidance:
      name: "confidence-guidance-prompt"
      path: ""

workflow:
  prompt_max_length: 200000
  local_token_ttl_seconds: 900
  max_output_length: 1000000

upload:
  max_files: 20
  max_file_mb: 500
  allowed_extensions: [".zip", ".rar"]

cors:
  allow_origins: ["*"]

logging:
  level: "INFO"
  dir: "./logs"
  file: "patch_search.log"
  rotation: "midnight"
  backup_count: 30
  max_value_length: 512

auth:
  jwt_secret_env: "PATCH_SEARCH_JWT_SECRET"
  jwt_algorithm: "HS256"
  access_token_expire_minutes: 120
  issuer: "patch_search"
  audience: "patch_search_web"
```

### 6.1.1 `config.yaml` 参数详细说明

#### 服务器配置 `server`

| 参数 | 类型 | 含义和使用规则 |
|---|---|---|
| `server.host` | 字符串 | FastAPI/Uvicorn 监听地址。`0.0.0.0` 表示监听服务器所有网卡，便于浏览器从其他机器访问。 |
| `server.port` | 整数 | patch_search HTTP 服务端口。防火墙、安全组和前端连接地址（cc-web `src/patch_servers.json` 中配置的地址）必须一致。 |

#### 数据库配置 `database`

| 参数 | 类型 | 含义和使用规则 |
|---|---|---|
| `database.host` / `port` | 字符串 / 整数 | MySQL 地址和端口。 |
| `database.user` / `password` | 字符串 | 连接账号和密码；生产环境不应把真实密码写入版本库。 |
| `database.db` | 字符串 | 数据库名，当前为 `patch`。 |
| `database.minsize` / `maxsize` | 整数 | aiomysql 连接池最小/最大连接数。 |
| `database.connect_timeout_seconds` | 整数 | 建立连接超时时间（秒）。 |

#### 文件路径配置 `paths`

| 参数 | 类型 | 含义和使用规则 |
|---|---|---|
| `paths.library_root` | 路径 | 补丁压缩包实际存储根目录；上传文件保存到该目录，`storage_path` 是相对该根目录的受控路径。 |
| `paths.product_source` | 路径 | 产品源代码目录，供 server ClaudeCode 或批量分析作为参考。 |
| `paths.temp_dir` | 路径 | 解压补丁、执行分析和保存临时文件的目录。 |

#### ClaudeCode 配置 `claude`

| 参数 | 类型 | 含义和使用规则 |
|---|---|---|
| `claude.cli` | 字符串 | 服务器 A 上 ClaudeCode CLI 的命令或可执行文件路径。 |
| `claude.permission_mode` | 字符串 | 调用 ClaudeCode 时使用的权限模式，由服务器配置固定。 |
| `claude.model` | 字符串 | 可选模型名，空表示不额外传 `--model`。 |
| `claude.timeout_seconds` | 整数 | 单次服务器 ClaudeCode 调用的最大执行时间（秒）。 |
| `claude.git_bash_path` | 字符串 | Windows 环境下供 ClaudeCode 使用的 Git Bash 路径。 |
| `claude.prompts.product_analysis` | 对象 | 产品分析提示词的逻辑名称与路径；批量分析脚本每次运行读取一次。 |
| `claude.prompts.confidence_guidance` | 对象 | 置信度提示词的逻辑名称与路径。 |

#### 流程配置 `workflow`

| 参数 | 类型 | 含义和使用规则 |
|---|---|---|
| `workflow.prompt_max_length` | 整数 | 流程渲染后的提示词最大长度，超长直接失败。 |
| `workflow.local_token_ttl_seconds` | 整数 | local 一次性执行令牌的有效期（秒），默认 900。 |
| `workflow.max_output_length` | 整数 | 模型输出长度上限。 |

#### 上传配置 `upload`

| 参数 | 类型 | 含义和使用规则 |
|---|---|---|
| `upload.max_files` | 整数 | 单次 multipart 请求最多接收的文件数量。 |
| `upload.max_file_mb` | 整数 | 单个补丁包最大大小（MiB）。 |
| `upload.allowed_extensions` | 字符串数组 | 允许的扩展名，如 `[".zip", ".rar"]`。 |

#### 跨域配置 `cors`

| 参数 | 类型 | 含义和使用规则 |
|---|---|---|
| `cors.allow_origins` | 字符串数组 | 允许浏览器跨域访问的来源。开发环境可用 `["*"]`；生产环境建议配置为实际 cc-web 来源。 |

#### 认证配置 `auth`

| 参数 | 类型 | 含义和使用规则 |
|---|---|---|
| `auth.jwt_secret_env` | 字符串 | JWT 签名密钥所在环境变量名，当前为 `PATCH_SEARCH_JWT_SECRET`；密钥至少 32 字符。 |
| `auth.jwt_algorithm` | 字符串 | 签名算法，固定允许值。 |
| `auth.access_token_expire_minutes` | 整数 | Access Token 有效期（分钟）。 |
| `auth.issuer` | 字符串 | JWT `iss`。 |
| `auth.audience` | 字符串 | JWT `aud`。 |

#### 日志配置 `logging`

| 参数 | 类型 | 含义和使用规则 |
|---|---|---|
| `logging.level` | 字符串 | 日志级别。 |
| `logging.dir` / `file` | 字符串 | 日志目录和文件名。 |
| `logging.rotation` | 字符串 | 轮转策略，当前 `midnight`。 |
| `logging.backup_count` | 整数 | 保留的历史日志文件数。 |
| `logging.max_value_length` | 整数 | 日志中单个参数最大长度，超长截断；密码、Token 等敏感值脱敏。 |

### 6.2 管理员分析配置 `analyze_config.yaml`

```yaml
patch_ids:
  - "uuid-1"
  - "uuid-2"
```

命令行脚本 `scripts/analyze_batch.py config.yaml analyze_config.yaml` 按此 ID 集合逐个分析。

---

## 七、基础 API 设计

所有 API 默认返回：

```json
{"code": 0, "data": {}}
```

失败返回非 0 `code` 或 HTTP 错误状态（401/403/404/409/400）。

### 7.1 健康检查

```text
GET /api/health
```

### 7.2 认证 API

```text
POST   /api/auth/login            # 登录，返回 access_token 和用户信息
GET    /api/auth/me               # 当前用户信息（页面恢复登录态）
GET    /api/auth/profile          # 当前用户个人资料
POST   /api/auth/change-password  # 修改密码（递增 token_version）
POST   /api/auth/logout           # 注销（当前实现仅返回成功，前端删除本地 Token）
```

### 7.3 普通检索

```text
GET /api/patches?keyword=&page=1&size=10
```

`keyword` 匹配五个字段：`name`、`description`、`user_keyword`、`class_name`、`keyword`。固定 `status=2`，按 `analyzed_at`、`uploaded_at` 倒序。

### 7.4 补丁详情和下载

```text
GET /api/patches/{id}
GET /api/patches/{id}/download
```

- 详情和下载仅允许 `status=2` 的补丁。
- 下载只根据数据库 `storage_path` 读取文件，并校验路径在 `library_root` 内，禁止使用用户传入路径。

### 7.5 我的补丁

```text
GET  /api/patches/mine?page=1&size=10    # 当前用户上传的所有补丁
PUT  /api/patches/{id}                   # 编辑：普通用户仅本人补丁，更新元数据并重置 status=0、清空分析字段；管理员可编辑任意补丁并指定 status（0~3）
DELETE /api/patches/{id}                 # 删除补丁文件和记录：普通用户仅本人补丁，管理员可删除任意补丁
```

### 7.6 批量上传

```text
POST /api/patches/upload
Content-Type: multipart/form-data
```

字段（数组与 `files[]` 按索引对应）：

```text
files[]
file_names[]
product_names[]
product_versions[]
descriptions[]
user_keywords[]
```

流程：

1. 校验扩展名、数量、大小。
2. 校验产品名称和版本号必填。
3. 生成 UUID 文件名，保存到补丁库目录。
4. 使用 `zipfile`/`rarfile` 做压缩包完整性校验。
5. 插入 `patch_info`，`status=0`，`uploaded_by_user_id` 由服务端从 JWT 解析。
6. 不提取包内文件清单，不自动分析。

### 7.7 补丁分析（管理员）

```text
GET  /api/patches/pending-analysis            # status != 2 的补丁列表
POST /api/patches/analyze                     # 创建后台分析任务
GET  /api/patches/analyze/{task_id}           # 查询任务状态
```

`POST /api/patches/analyze` 请求体：

```json
{"patch_ids": ["uuid-1", "uuid-2"]}
```

后台任务在进程内维护（`AnalysisTaskManager`），服务重启后任务不会恢复。单个补丁失败置 `status=3`，同批次其他补丁继续处理。

### 7.8 仪表盘

```text
GET /api/dashboard
```

返回近 30 天个人统计（上传数、贡献值、活跃度、流程次数）、贡献榜 TOP10、活跃榜 TOP10。仅登录用户可访问。

### 7.9 工作目录管理 API

```text
GET    /api/workflows/directories
POST   /api/workflows/directories
PUT    /api/workflows/directories/{id}
DELETE /api/workflows/directories/{id}              # 停用（软删除），实际执行 status=0
DELETE /api/workflows/directories/{id}/permanent    # 物理删除，直接删除记录

GET    /api/workflows/templates/{template_id}/directory-requirements   # 模板的 local 步骤 + 当前用户可用目录选项
```

- 停用与物理删除权限一致：个人目录仅本人、内置目录仅管理员，越权返回 403；目录不存在返回 404。
- 物理删除后 `workflow_run_step.directory_id` 被外键 `ON DELETE SET NULL` 置空，历史运行记录保留。
- `GET /api/workflows/templates/{template_id}/directory-requirements` 返回该模板所有 `claude_target='local'` 且启用的步骤，以及当前用户自己的启用目录选项，供"启动流程"弹窗渲染：

```json
{
  "template_id": 1,
  "steps": [
    {"step_order": 1, "flow_id": 3, "flow_code": "req_analysis", "flow_name": "需求分析",
     "suggested_directory_code": null, "default_directory_id": 12}
  ],
  "options": [
    {"id": 12, "code": "my_proj", "name": "我的工程", "path": "D:\\project\\my-app"}
  ]
}
```

### 7.10 流程/提示词/模板管理 API

```text
GET    /api/workflows/flows
POST   /api/workflows/flows
PUT    /api/workflows/flows/{id}
DELETE /api/workflows/flows/{id}         # 被模板引用时返回 409

GET    /api/workflows/prompts
POST   /api/workflows/prompts
PUT    /api/workflows/prompts/{id}
DELETE /api/workflows/prompts/{id}       # 被模板引用时返回 409

GET    /api/workflows/templates
GET    /api/workflows/templates/{id}
POST   /api/workflows/templates
PUT    /api/workflows/templates/{id}
DELETE /api/workflows/templates/{id}
```

列表接口返回每条记录的 `can_edit` 权限标记：管理员创建的共享配置对普通用户只读，普通用户可编辑删除自己的配置。

### 7.11 流程运行 API

```text
POST   /api/workflows/runs                                   # 创建运行
GET    /api/workflows/runs?page=1&size=10                    # 当前用户运行列表
GET    /api/workflows/runs/active                            # 当前用户最近一个未结束运行
GET    /api/workflows/runs/{run_id}                          # 运行详情（含步骤）
POST   /api/workflows/runs/{run_id}/next                     # 下一步
POST   /api/workflows/runs/{run_id}/cancel                   # 结束流程
GET    /api/workflows/runs/{run_id}/steps/{step_order}/result  # 单步结果
POST   /api/workflows/runs/{run_id}/steps/{step_order}/local-result  # local 结果回传
GET    /api/workflows/runs/{run_id}/stream                   # SSE
```

创建运行请求体：

```json
{
  "template_id": 1,
  "business_input": "用户输入的业务逻辑",
  "directory_bindings": [
    {"step_order": 1, "directory_id": 12},
    {"step_order": 2, "path": "D:\\project\\my-app"}
  ]
}
```

- `directory_bindings` 可选，用于 `local` 步骤的运行时工作目录绑定：每个本地步骤一条，`directory_id`（选择自己已有的目录）与 `path`（手填本机绝对路径）**二选一**，`step_order` 不可重复。
- 未提供绑定的 `local` 步骤回退使用流程配置的 `directory_code`；`server` 步骤始终按目录 `code` 解析，忽略绑定。
- `path` 是**客户端机器**上的路径，服务端不做存在性校验。

创建成功后第一步自动开始执行，返回运行快照。

### 7.12 产品/版本字典管理 API

```text
GET    /api/products                                   # 产品及版本列表（上传下拉选项）
POST   /api/products                                   # 新增产品（admin）
PUT    /api/products/{id}                              # 修改产品名称/排序（admin）
DELETE /api/products/{id}                              # 删除产品，级联删版本（admin）
POST   /api/products/{id}/versions                     # 新增版本（admin）
PUT    /api/products/{id}/versions/{vid}               # 修改版本名（admin）
DELETE /api/products/{id}/versions/{vid}               # 删除版本（admin）
```

`GET /api/products` 返回：

```json
{"code":0,"data":[{"id":1,"name":"产品A","sort_order":0,"versions":[{"id":1,"version":"1.0"}]}]}
```

新增/修改均校验产品名、版本号唯一性，冲突返回 400。产品名/版本为空或超长由 Pydantic 校验。

---

## 八、可配置智能检索执行流程

### 8.1 流程模板示例

```json
{
  "code": "patch_retrieval_v1",
  "name": "补丁智能检索流程",
  "steps": [
    {
      "step_order": 1,
      "flow_id": 1,
      "prompt_id": 2,
      "user_prompt": "",
      "save_context_override": true
    },
    {
      "step_order": 2,
      "flow_id": 2,
      "prompt_id": null,
      "user_prompt": "请根据上一步结果检索补丁：{{flow:requirement_analysis.context}}，业务输入：{{business_input}}",
      "save_context_override": true
    }
  ]
}
```

- 第 1 步 `user_prompt` 为空时，执行时直接使用用户业务输入。
- 第 2 步起 `user_prompt` 可引用前置步骤的 `{{flow:流程code.context}}`、`{{flow:流程code.result}}`、`{{step.N.context}}`、`{{step.N.result}}`、`{{business_input}}`、`{{prompt.content}}`。
- 步骤数量、顺序完全由模板决定，代码不写死固定步骤名。

### 8.2 执行引擎状态机

运行状态 `workflow_run.status`：

```text
pending
  → running
  → waiting_confirmation
  → success / failed / cancelled
```

步骤状态 `workflow_run_step.status`：

```text
pending
  → running
  → waiting_confirmation
  → success / failed / cancelled
```

- 创建运行后 `status=running`、`current_step=1`，立刻启动第一步执行任务。
- 非最后一步成功完成后步骤为 `waiting_confirmation`，运行暂停等待用户确认。
- `local` 步骤提交给客户端执行期间（已推送 `local_call_required`、尚未回传结果），整条运行与步骤均保持 `running`（对外显示"执行中"）；只有结果回传进入 `finish_step` 后才置为 `waiting_confirmation`。运行列表/详情页据此显示：整条流程执行中显示"执行中"，某步骤待确认显示"待确认"，全部完成显示"已完成"，取消显示"已取消"，失败显示"失败"。
- 用户点击“下一步”后，当前步骤置为 `success` 并写入 `confirmed_at`，然后启动下一步。
- 最后一步成功完成后运行置为 `success`；失败置为 `failed`；用户结束流程置为 `cancelled`。

“下一步”采用状态条件更新，防止重复点击重复调用 ClaudeCode：

```sql
UPDATE workflow_run_step
SET status = 'success', confirmed_at = NOW()
WHERE run_id = ?
  AND step_order = ?
  AND status = 'waiting_confirmation';
```

只有更新成功的请求才允许启动下一步骤。

### 8.3 创建运行时的校验

`create_run(db, template_id, business_input, created_by_user_id, user_role, directory_bindings)` 执行：

1. 校验模板存在、启用，且对当前用户可见（管理员共享或本人所有）。
2. 读取模板步骤，校验每个步骤关联的流程、提示词对当前用户可见。
3. 按步骤解析工作目录（`directory_bindings` 归一化为 `{step_order: {directory_id, path}}`）：
   - `claude_target='local'` 且提供了 `path`：记为 `directory_type='manual'`、`directory_code=NULL`、`directory_id=NULL`，`resolved_directory=path`（**客户端机器**路径，服务端不做存在性校验）。
   - `claude_target='local'` 且提供了 `directory_id`：校验该目录属于当前用户且启用，取 `code/id/type/path`。
   - 其余情况（`local` 未绑定、或 `server` 目标）：回退按流程 `directory_code` 解析，优先当前用户的启用目录、再管理员内置目录。
   - 任一必需目录缺失则拒绝创建运行，一次性返回所有缺失项。
4. 创建 `workflow_run`，将模板步骤复制为 `workflow_run_step`（含 `directory_code`、`directory_id`、`directory_type`、`resolved_directory`、`flow_code`、`template_step_id` 引用）。
5. 推送 `workflow_started`，启动第一步。

> **模板修改与运行中的流程（就地更新，实时生效）**：修改模板按 `step_order` 复用既有行 ID 做 UPDATE（新增步骤才 INSERT），**被删除的步骤做真实 DELETE**（不软删）。`workflow_run_step.template_step_id` 为可空外键（`ON DELETE SET NULL`），模板步骤被删除时该引用自动置空；运行中的流程把 `template_step_id` 为 NULL 的步骤标记为 `cancelled` 并跳过，**不再执行**，做到"删除某步立即响应"。流程运行到某一步时**实时读取**模板最新步骤定义（`ts.user_prompt`、`p.content`、`f.claude_target`、`f.save_context`、`ts.save_context_override`），即"修改模板中下一步的提示词后，运行到该步立即生效"，**不做提示词快照**。新建运行从当前模板步骤创建（沿用 `ts.status=1` 过滤，列保留）。

### 8.4 提示词渲染

执行某一步时：

1. 读取当前模板步骤和流程定义。
2. 读取模板选择的提示词 `content`。
3. 第 1 步：渲染后的用户提示词直接使用业务输入。
4. 第 2 步起：按 `user_prompt` 替换变量，变量值来自同一个 `run_id` 的前置步骤输出；若上一个步骤 `save_context` 为真，附加 `[Previous Step Output]`。
5. 拼接为单个提示词串：

```text
[Prompt]
{提示词正文}

[User Prompt]
{渲染后的用户提示词}
```

6. 按流程 `claude_target` 选择执行通道：
   - `server`：patch_search 在服务器 A 直接调用 ClaudeCode。
   - `local`：patch_search 生成一次性 `execution_token`，将已渲染提示词和调用参数通过 SSE `local_call_required` 返回前端；前端调用本机 cc-web Rust 后端启动客户端 ClaudeCode，再把结果回传 patch_search。
7. patch_search 保存实际渲染后的用户提示词、输入上下文和模型输出。

支持变量：

```text
{{business_input}}
{{prompt.content}}
{{flow:流程code.context}}
{{flow:流程code.result}}
{{step.N.context}}
{{step.N.result}}
```

> 系统提示词与用户提示词不再分列两个数据库字段。提示词正文作为 `[Prompt]` 段、用户提示词作为 `[User Prompt]` 段拼接，再一起发给 ClaudeCode。

### 8.5 上下文和结果保存

- `workflow_run_step.output_context/output_result` 保存本步骤实际输出，是后续步骤读取的唯一来源。
- `workflow_run.context/result` 保存本次运行汇总。
- `workflow_flow.context/result` 是流程最近快照，仅供管理页查看；当前代码运行时不会自动更新它。
- `save_context=1`（或被 `save_context_override` 覆盖）时，输出可作为后续步骤上下文；否则仅保留审计记录，不注入后续上下文。

### 8.6 SSE 事件

前端用带 Authorization Header 的 `fetch` 读取 SSE（原生 `EventSource` 无法可靠设置 Header）。事件按 `run_id` 隔离，连接前必须通过运行归属校验。

事件名：

```text
event: workflow_started
event: step_started
event: local_call_required     # 携带 execution_token、prompt、cwd
event: step_completed
event: step_confirmed
event: workflow_advanced
event: workflow_completed
event: workflow_error
event: workflow_cancelled
```

前端收到 `local_call_required` 时调用本机 cc-web Rust 接口执行 local ClaudeCode，结果提交回 patch_search；收到其他事件时更新步骤界面。

### 8.7 local 结果提交

```text
POST /api/workflows/runs/{run_id}/steps/{step_order}/local-result
```

请求体：

```json
{
  "execution_token": "一次性令牌",
  "text": "客户端 ClaudeCode 原始输出",
  "result": {},
  "error": null
}
```

patch_search 验证运行归属、步骤状态、执行令牌（绑定 `run_id`、`step_order`、`execution_user_id`、未过期未消费）后，原子写入 `token_used_at` 并清空令牌，保存输出，将步骤置为 `waiting_confirmation`，推送 `step_completed`。客户端断开或执行失败时也提交错误结果，流程不会自动推进到下一步。

---

## 九、本地和服务端 ClaudeCode

### 9.1 客户端本地 ClaudeCode

“local”明确指运行 cc-web 的客户端机器。patch_search 不能直接启动客户端进程，由 cc-web Rust 后端通过受控的 `local_claude` API 执行。典型命令：

```text
claude --print --output-format text --permission-mode bypassPermissions [--model model]
```

- 提示词通过 stdin 传入。
- 根据流程设置 cwd。
- Windows 配置 `CLAUDE_CODE_GIT_BASH_PATH`。
- 使用配置的超时时间，记录进程 ID 支持取消。

### 9.2 服务器 A ClaudeCode

“server”明确指部署 patch_search 的服务器 A。patch_search 直接启动 ClaudeCode，调用参数和执行目录来自服务器配置，用户不能通过页面指定任意命令、路径或 URL。

服务器 ClaudeCode 是通用执行器，输出格式由提示词决定，不固定返回 `patches`、`final_patches`、`plan` 等字段。

server 流程执行细节（`app/services/claude_service.py` + `app/workflow/handlers/server_claude.py`）：

- **stream-json 全量收集**：以 `--verbose --output-format stream-json` 模式收集全部助手轮次文本并 `\n\n` 拼接后返回。ClaudeCode 是智能体，可能在输出结果后因后台任务通知继续对话，裸模式下只渲染最后一条消息，会丢失更早输出的完整 JSON 交付物（如补丁证据包）。因此 server 流程固定 `collect_messages=True`。
- **超时杀进程树**：超时后终止整个进程树（Windows 用 `taskkill /F /T /PID`），防止 claude 派生的 bash/grep/iconv 等子进程继续存活并持有 stdout/stderr 管道造成资源泄漏。
- **异常落库**：步骤处理器执行抛异常也会写回数据库并标记步骤失败（`finish_step`），避免步骤永久停留在"执行中"且结果无法落库。

统一 Handler 接口：

```python
class StepHandler(Protocol):
    async def execute(self, prompt: str, run_id: str, step_order: int) -> dict[str, Any]: ...
```

`LocalRequestHandler`（生成执行令牌、等待前端回传）和 `ServerClaudeHandler`（调用服务器 ClaudeCode）都实现该接口，流程引擎不依赖具体实现。

---

## 十、管理员批量分析

提供两种方式：页面批量分析和命令行脚本。

### 10.1 页面批量分析（管理员）

- 管理员进入“待分析补丁”Tab，选择多个 `status != 2` 的补丁，点击“开始分析”。
- `POST /api/patches/analyze` 创建后台任务，页面轮询 `GET /api/patches/analyze/{task_id}` 显示进度。
- 单个补丁成功写入 `analysis_result`、`class_name`、`keyword` 并置 `status=2`；失败置 `status=3`，同批次其他补丁继续。
- 后台任务保存在进程内，服务重启后不恢复。

### 10.2 命令行脚本

```bash
conda activate patch
cd D:\project\patch_search
python scripts\analyze_batch.py config.yaml analyze_config.yaml
```

`analyze_config.yaml`：

```yaml
patch_ids:
  - "uuid-1"
  - "uuid-2"
```

流程：

1. 读取配置中的补丁 ID 集合。
2. 启动时读取一次产品分析提示词。
3. 逐个查询 `patch_info.storage_path`，将状态更新为 1（分析中）。
4. 解压补丁到临时目录。
5. 调用 ClaudeCode 分析补丁代码。
6. 按提示词要求输出结构化结果，写入 `analysis_result`、`class_name`、`keyword`，成功置 `status=2`、失败置 `status=3`。
7. 单个补丁失败不影响其他补丁；提示词读取失败则终止整个批次。

---

## 十一、智能检索中的补丁业务流程示例

以下只是默认业务模板，不是代码固定流程：

```text
加载产品分析提示词
  ↓
业务需求分析
  ↓
根据类名/关键词检索 status=2 的补丁
  ↓
审查候选补丁代码
  ↓
生成补丁匹配结果和置信度
  ↓
生成实现方案和代码
```

每个箭头对应一个可配置流程。最终输出由模板实际配置决定，不强制要求所有步骤都存在。

---

## 十二、错误处理和安全约束

### 12.1 流程错误

- ClaudeCode 超时：当前步骤失败，允许页面重试或结束流程。
- 模板明确要求 JSON 而模型输出不是合法 JSON：保存原始文本，结构化结果为空，按模板配置决定步骤是否失败。
- 提示词不存在或停用：模板启动前校验并拒绝执行。
- 流程/提示词被模板引用：删除时返回 409。
- 模板已有运行记录：禁止编辑和删除，只能新建。
- 工作目录 code 缺失：模板执行前按当前用户和内置目录统一校验，缺失则拒绝创建运行。
- 前置上下文缺失：当前步骤失败，不使用其他运行实例的数据兜底。
- 重复点击下一步：状态条件更新失败，不重复执行。
- 用户断开 SSE：流程状态保存在数据库，重连后继续查看；不会因断开自动执行下一步。

### 12.2 安全约束

- 数据库全部使用参数化 SQL。
- 用户输入不直接进入 Shell 命令、文件路径和 SQL。
- 下载路径只能来自数据库记录并限制在补丁库根目录内。
- 服务端 ClaudeCode 由服务器配置固定，用户不能提交任意 URL。
- 文件扩展名、大小和压缩包完整性必须校验。
- 工作目录路径必须是绝对路径并保存前标准化：内置目录还必须在服务器上存在且为目录；个人目录是客户端机器路径，服务端不校验存在性，由 local 执行端（cc-web）校验。
- 普通用户只能管理自己的配置和目录；管理员共享配置/内置目录对普通用户只读。
- 运行记录、SSE、下一步、取消、local-result 都按 `created_by_user_id` 严格隔离，越权统一返回 404。
- JWT 不放入 URL 查询参数、SSE URL、下载 URL、日志或错误信息。
- 用户身份只能由服务端从 JWT 和 `user_account` 解析，客户端提交的 `uploaded_by`、`created_by` 一律不信任。

---

## 十三、JWT 登录认证与用户隔离

### 13.1 认证目标

patch_search 使用 JWT 作为登录后的访问令牌，不增加 `user_session`、`client_id` 等其他会话表。同一个用户在不同浏览器/客户端上创建的运行实例归属于同一账号；不同用户之间通过 `created_by_user_id` 隔离。

认证链路：

```text
登录名 + 密码
  ↓
查询 user_account 并校验密码哈希
  ↓
签发 JWT
  ↓
浏览器保存访问令牌（localStorage）
  ↓
Authorization: Bearer <JWT>
  ↓
patch_search 校验签名、有效期、issuer、audience、token_version
  ↓
再次查询 user_account 当前 status/role/token_version
  ↓
按当前用户 ID 和角色执行 API
```

### 13.2 JWT 内容和校验

```json
{
  "sub": "123",
  "username": "alice",
  "iat": 1760000000,
  "exp": 1760007200,
  "iss": "patch_search",
  "aud": "patch_search_web",
  "token_version": 0,
  "typ": "access"
}
```

服务端：

1. 只允许配置中的算法，不信任 JWT Header 的算法选择。
2. 校验签名、`exp`、`iat`、`iss`、`aud`、`typ` 和 `sub`。
3. 根据 `sub` 查询 `user_account`，比较当前 `status` 和 `token_version`，使用当前 `role` 授权。
4. JWT secret 通过环境变量 `PATCH_SEARCH_JWT_SECRET` 注入，不能提交真实密钥。

使用 `PyJWT` 签发/校验 JWT，使用 `pwdlib[argon2]` 校验密码哈希。

### 13.3 认证 API

#### 登录

```text
POST /api/auth/login
```

```json
{
  "username": "alice",
  "password": "用户密码"
}
```

成功返回 `access_token`、`token_type`、`expires_in` 和 `user`。失败统一返回 401，避免用户名枚举。密码哈希和 JWT 不写入日志。

#### 注销

```text
POST /api/auth/logout
```

当前实现返回成功并保留服务端状态；前端删除本地 Token。密码修改会递增 `token_version`，使该用户已签发的 Token 全部失效。

#### 当前用户 / 资料 / 修改密码

```text
GET  /api/auth/me
GET  /api/auth/profile
POST /api/auth/change-password
```

`change-password` 校验旧密码、新密码不得与旧密码相同，成功后 `token_version+1`。

### 13.4 API 权限矩阵

| API 范围 | 未登录 | 普通用户 | 管理员 |
|---|---:|---:|---:|
| `/api/health` | 允许 | 允许 | 允许 |
| 登录 | 允许 | 允许 | 允许 |
| 普通检索、详情、下载 | 401 | 允许 | 允许 |
| 补丁上传、我的补丁（增删改查） | 401 | 允许（仅自己上传的） | 允许（任意补丁，可编辑并直接修改状态） |
| 待分析补丁、发起分析 | 401 | 403 | 允许 |
| 产品/版本字典读取（上传下拉选项） | 401 | 允许 | 允许 |
| 产品/版本字典新增、修改、删除 | 401 | 403 | 允许 |
| 流程/提示词/模板/工作目录列表 | 401 | 允许（共享 + 自己） | 允许 |
| 流程/提示词/模板/目录新增、修改、删除 | 401 | 允许（仅自己的） | 允许 |
| 创建自己的 `workflow_run` | 401 | 允许 | 允许 |
| 读取、下一步、取消自己的运行 | 401 | 允许 | 允许 |
| 访问其他用户的运行 | 401 | 404 | 404 |
| 其他用户运行的 SSE / local-result | 401 | 404 | 404 |

> 说明：普通用户可以创建和管理自己的流程、提示词、模板和目录；管理员创建的共享配置/内置目录对普通用户只读。运行记录不共享，管理员也不能查看普通用户的运行。

### 13.5 `workflow_run` 用户归属

```sql
created_by_user_id BIGINT UNSIGNED NOT NULL,
KEY idx_workflow_run_owner_updated (created_by_user_id, updated_at, created_at)
```

- 创建运行时 `created_by_user_id = current_user.id`，创建请求不携带创建人字段。
- 普通用户和管理员查询运行均按 `created_by_user_id=当前用户` 过滤；越权统一返回 404。
- `next`、`cancel`、`local-result`、单步结果和 SSE 建立前必须执行相同归属校验。

### 13.6 local execution token 与 JWT 的关系

`workflow_run_step.execution_token` 用于绑定一次 local ClaudeCode 结果回传，不是登录凭证。生成和校验时绑定 `run_id`、`step_order`、`execution_user_id`、`token_expires_at`、`token_used_at`。提交结果必须同时满足：JWT 有效、有权访问该 run、步骤状态为 `running`、令牌匹配且未过期未消费；成功后原子写入 `token_used_at` 并清空令牌，防止重放。

### 13.7 前端认证和 SSE

- 前端用 `localStorage` 保存 `access_token`，所有请求统一带 `Authorization: Bearer <JWT>`。
- 收到 401 清除 Token 并显示登录界面；收到 403 显示权限不足。
- SSE 和下载使用带 Authorization Header 的 `fetch`，JWT 不放入 URL。
- 切换用户或登出时重置工作流运行状态，避免残留上一个用户的运行界面。

### 13.8 配置项

```yaml
auth:
  jwt_secret_env: "PATCH_SEARCH_JWT_SECRET"
  jwt_algorithm: "HS256"
  access_token_expire_minutes: 120
  issuer: "patch_search"
  audience: "patch_search_web"
```

| 参数 | 含义 |
|---|---|
| `jwt_secret_env` | JWT secret 所在环境变量名；密钥至少 32 字符。 |
| `jwt_algorithm` | 签名算法，服务端固定允许值。 |
| `access_token_expire_minutes` | Access Token 有效期，过期后重新登录。 |
| `issuer` / `audience` | JWT `iss` / `aud`。 |

### 13.9 认证验收测试

至少测试：

- 正确登录签发 JWT；错误密码和不存在用户统一返回 401。
- JWT 签名错误、过期、issuer/audience/algorithm 不匹配均被拒绝。
- 用户禁用或 `token_version` 变化后，旧 Token 立即失效。
- 数据库角色变化后，下一次请求按新角色授权。
- `/api/health` 可匿名访问，其他受保护 API 无 Token 返回 401。
- 普通用户只能管理自己的流程/提示词/模板/目录；管理员创建的共享配置只读。
- 客户端提交的 `uploaded_by`、`created_by` 不会覆盖服务端身份。
- 创建运行时 `created_by_user_id` 等于 JWT 对应用户 ID。
- 不同用户的运行、SSE、下一步、取消和 local-result 互相隔离。
- local execution token 过期、错 run、错 step、重复提交均失败。
- Fetch、XHR、SSE 和下载均携带 JWT，JWT 不出现在 URL 或日志中。

---

## 十四、依赖和运行环境

### patch_search

```text
fastapi
uvicorn[standard]
aiomysql
cryptography
PyJWT
pwdlib[argon2]
python-multipart
pyyaml
rarfile
httpx
pytest
pytest-asyncio
```

### patch_search 启动命令

在 `D:\project\patch_search` 目录下，使用已安装依赖的 Python 环境启动：

```powershell
conda activate patch
cd D:\project\patch_search
$env:PATCH_SEARCH_JWT_SECRET = "替换为长度不少于 32 个字符的安全随机密钥"
python -m uvicorn app.main:app --host 0.0.0.0 --port 13587
```

如果 `PATCH_SEARCH_JWT_SECRET` 已配置为系统或用户环境变量，可直接执行：

```powershell
conda activate patch
cd D:\project\patch_search
python -m uvicorn app.main:app --host 0.0.0.0 --port 13587
```

也可以读取 `config.yaml` 中的监听配置：

```powershell
python -m app.main
```

启动成功检查：

```powershell
Invoke-WebRequest http://127.0.0.1:13587/api/health
```

**打包为 exe（PyInstaller onefile，可选）**

```text
D:\project\patch_search\build.bat
```

`build.bat` 使用 `D:\Downloads\Software\Miniconda\envs\patch\python.exe`，入口 `run_server.py`（双击后读取 exe 同目录的 `config.yaml` 再启动 uvicorn），产物为 `dist\patch_search.exe`。

> 注意：`build.bat` 中含 `rmdir /s /q dist`，会一并删除 `dist\` 下的 `config.yaml`、`data\`、`logs\`、`patch_search.zip` 等运行时资源。若这些文件重要，先备份；或改用直接执行 `python -m PyInstaller --clean --noconfirm patch_search.spec`（不清空 dist，仅覆盖 `patch_search.exe`）。

**运行 exe**

```text
1. 确保 PATCH_SEARCH_JWT_SECRET 环境变量已配置（长度 ≥ 32 个字符）
2. 把 config.yaml 放到 patch_search.exe 同目录（与 exe 一起分发）
3. 双击 patch_search.exe 或命令行运行，监听 0.0.0.0:13587
```

### 服务器 A

- Python 3.11+
- MySQL
- 服务器 A 上的 ClaudeCode CLI 或服务端 ClaudeCode 接口（`server` 流程调用）

### cc-web 客户端机器

- 客户端机器上的 ClaudeCode CLI（`local` 流程调用）
- cc-web Rust 后端的受控本地 ClaudeCode 接口
- 产品分析提示词、置信度提示词等内容
- git、unrar（rar 支持需要）

### cc-web

- 不新增第三方前端依赖，使用原生 HTML/CSS/JavaScript。
- 所有 HTML/CSS/JS 通过 `include_str!` **编译期内嵌**进单个二进制；改动前端后必须重新编译并替换 exe 才会生效（不能只改 `static/` 下的文件）。

**编译**

```text
cargo build --release
```

产物：`target\release\cc-web.exe`。

**部署 / 启动**

```text
1. 把 target\release\cc-web.exe 复制到仓库根目录（与 start.bat 同级），覆盖旧的 cc-web.exe
2. 双击 start.bat，或直接运行 cc-web.exe
3. 浏览器打开 cc-web 页面（补丁中心 /patches.html）
```

前端调用的 patch_search 地址在 `src\patch_servers.json` 中配置（编译期内嵌，见第二章），修改后需重新编译。

> 提示：重新编译前先停掉正在运行的 `cc-web.exe`，否则 cargo 会因目标文件被占用报 `failed to remove file target\release\cc-web.exe`（os error 5）。



---

## 十五、落地阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 需求确认、通信方式、部署方式、数据库边界 | 已完成 |
| 1 | patch_search 骨架、配置加载、数据库连接、健康检查 | 已实现并部署 |
| 2 | 普通检索、详情、下载 API | 已实现并部署 |
| 3 | 批量上传、压缩包校验、入库、前端进度条 | 已实现并部署 |
| 4 | JWT 登录认证、用户表、权限矩阵、用户隔离 | 已实现并部署 |
| 5 | 我的补丁（编辑重置待分析）、补丁编辑/删除 | 已实现并部署 |
| 6 | 管理员批量分析（页面 + 命令行脚本） | 已实现并部署 |
| 7 | 仪表盘统计 | 已实现并部署 |
| 8 | 流程、提示词、模板、工作目录管理和所有权共享模型 | 已实现并部署 |
| 9 | 流程运行记录、动态流程引擎、上下文解析、SSE、人工下一步和结束流程 | 已实现并部署 |
| 10 | local / server ClaudeCode Handler、前端智能开发页面（server 步骤 stream-json 全量收集 + 超时杀进程树 + 异常落库） | 已实现并部署 |
| 11 | 产品/版本字典管理 + 上传下拉（方案 B） | 已实现并部署 |
| 12 | 流程步骤继续本地 ClaudeCode 会话（继续会话，含历史消息展示） | 已实现，待重启部署 |
| 13 | 普通检索管理员编辑/删除 + 直接修改补丁状态 | 已实现，待重启部署 |
| 14 | 运行时工作目录绑定（方案 A）：`local` 步骤启动流程时逐步骤选择已有目录或手填本机路径 | 已实现，待部署（需执行迁移 SQL） |
| 15 | 工作目录「删除」（物理删除，区别于「停用」软删除）+ `local` 步骤执行期间状态显示修复 | 已实现，待部署 |

智能检索的具体业务步骤通过流程模板配置，不需要修改流程引擎代码。

---

## 十六、设计结论

1. `patch_search` 负责数据库、流程编排、server ClaudeCode 和运行状态；cc-web 负责页面展示，并通过 Rust 后端调用客户端机器上的 local ClaudeCode。
2. 普通检索、上传、我的补丁和管理员分析围绕唯一的 `patch_info` 表实现。
3. `class_name`、`keyword`、`user_keyword` 使用逗号分隔字符串，查询类名使用 `FIND_IN_SET`。
4. 上传后只入库，不自动分析；管理员通过页面或命令行脚本分析。
5. 编辑补丁后重置为待分析状态并清空旧分析结果，需要重新分析。
6. 智能检索不采用固定步骤，使用流程、提示词、模板和运行记录驱动。
7. 管理员创建的流程/提示词/模板/内置目录对所有用户共享（只读）；普通用户可创建和管理自己的配置。
8. 每次流程执行独立保存运行上下文和结果，避免并发覆盖；运行记录按 `created_by_user_id` 严格隔离。
9. 每个步骤完成后必须等待用户点击“下一步”，否则不执行后续步骤。
10. 前端通过 SSE 获取动态步骤和结果，步骤数量、顺序由模板决定。
11. `local` 明确表示 cc-web 所在客户端机器的 ClaudeCode；`server` 明确表示服务器 A 上 patch_search 使用的 ClaudeCode。
12. 每个步骤的输出最终保存到服务器 A 的 `workflow_run_step`，上下文和结果不会只保存在浏览器内存中。
13. 登录使用 JWT Bearer Token，不增加用户会话表；修改密码递增 `token_version` 使旧 Token 失效。
14. 用户身份只能从服务端校验后的 JWT 和 `user_account` 得到，不能信任客户端提交的创建人字段。
15. SSE 使用带 Authorization Header 的 Fetch 流式读取，JWT 不出现在 URL 中；local execution token 只负责一次步骤结果防重放，不替代用户认证。
16. `local` 步骤的工作目录是运行时参数（方案 A）：启动流程时由使用者逐步骤选择已有目录或手填本机路径，运行步骤记录 `directory_id`/`directory_type`/`resolved_directory`；`server` 步骤仍按流程 `directory_code` 解析。
17. 工作目录「停用」是软删除（`status=0`，记录保留），「删除」是物理删除；物理删除不影响历史运行记录（`workflow_run_step.directory_id` 外键置空），但会使引用该目录的模板无法启动。
18. `local` 步骤在客户端执行期间整条运行显示"执行中"，结果回传后才进入"待确认"，避免执行中被误显示为待确认。

---

## 十七、产品/版本字典与上传下拉（方案 B）

> 状态：已实现并部署（产品/版本字典管理页、上传与编辑弹窗下拉均已落地）。
> 需求：补丁上传时，产品名称改为单选下拉，版本号改为可输入下拉（combobox），产品与版本为一对多联动。采用方案 B：新增产品/版本字典表 + 管理员维护。

### 17.1 需求

- **产品名称**：单选下拉，选项来自产品字典。
- **版本号**：可输入的下拉（`<input list>` + `<datalist>`），既能选择已有版本也能手输新值。
- **一对多联动**：选择产品后，版本下拉只展示该产品的版本。
- **产品/版本字典需要管理员维护**（新增、改名、排序、删除）。

### 17.2 核心设计决策：`patch_info` 保存文本快照，不存字典 ID

字典表**只作为下拉选项来源**，`patch_info.product_name / product_version` 仍是上传时的自由文本快照。**不把字典 ID 存进 `patch_info`**，理由：

1. **版本号要求"可以自己输入"，与存版本 ID 矛盾**。若存 `product_version_id`，手输的新版本要么被拒绝（违背需求），要么自动插入字典（污染管理员维护的版本列表，失去管理意义）。
2. **存 ID 后无法"删除产品不影响历史"**。现在删除字典产品 = 只删下拉选项，历史补丁照常显示；存 ID 则受外键约束（RESTRICT 删不掉 / SET NULL 历史变空 / CASCADE 连历史一起删），只能改用软删。
3. **迁移与全链路改动大**。历史补丁需回填 ID，且列表、检索（按产品名搜索）、分析、编辑等所有读 `product_name/product_version` 的地方都要改成 join 取名字。

结论：**字典表管"下拉选项"，`patch_info` 管"快照"**，两套解耦。产品改名只影响之后的补丁，历史补丁保留上传时的名字（快照语义）；如需"改名同步历史"，可另行批量 `UPDATE patch_info SET product_name=? WHERE product_name=?`，与字典 FK 无关。

### 17.3 数据库：新增两张表

在 `schema/current_schema.sql` 中新增：

```sql
CREATE TABLE `product` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) NOT NULL COMMENT '产品名称',
  `sort_order` int(11) NOT NULL DEFAULT '0' COMMENT '显示排序，越小越靠前',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='产品字典表';

CREATE TABLE `product_version` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `product_id` bigint(20) unsigned NOT NULL COMMENT '所属产品 ID',
  `version` varchar(64) NOT NULL COMMENT '版本号',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_version` (`product_id`,`version`),
  KEY `idx_product_version_product` (`product_id`),
  CONSTRAINT `fk_product_version_product` FOREIGN KEY (`product_id`) REFERENCES `product` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='产品版本字典表';
```

约束说明：

- `ON DELETE CASCADE`：删除产品时自动删除其版本。
- 唯一约束：产品名唯一、`(product_id, version)` 唯一，避免重复选项。
- 不影响 `patch_info`：删除产品只移除下拉选项，历史补丁的文本快照保持不变。

### 17.4 后端接口（`app/routes/products.py`）

新增路由文件，写入产品/版本字典，注册到 `app/main.py`：

| 接口 | 权限 | 说明 |
|---|---|---|
| `GET /api/products` | 任意登录用户 | 返回 `[{id,name,sort_order,versions:[{id,version}]}]`，按 `sort_order,id` 排序；上传下拉与管理员维护页共用 |
| `POST /api/products` | admin | `{name, sort_order?}`，产品名冲突返回 400 |
| `PUT /api/products/{id}` | admin | 改名 / 改排序 |
| `DELETE /api/products/{id}` | admin | 级联删版本；历史补丁不受影响 |
| `POST /api/products/{id}/versions` | admin | `{version}`，`(product,version)` 冲突返回 400 |
| `PUT /api/products/{id}/versions/{vid}` | admin | 版本改名 |
| `DELETE /api/products/{id}/versions/{vid}` | admin | 删除版本 |

配套改动：

- `app/schemas.py`：新增 `ProductCreate`、`ProductUpdate`、`ProductVersionCreate`（产品名 1~128、版本 1~64，必填）。
- `app/main.py`：导入并注册 `products.router`。

**上传接口 `POST /api/patches/upload` 不改**：`product_names / product_versions` 仍按文本接收写入 `patch_info`，不做字典强校验，与"版本可手输"和历史数据兼容。

### 17.5 前端上传弹窗改造（`static/patches.js` + `static/patches.html`）

`showUploadModal()` 改造：

1. 打开弹窗前若缓存未加载则 `GET /api/products`，缓存到 `patchState.products`。
2. 每个文件条目的产品框渲染为 `<select class="patch-file-product">`（含"请选择产品"空选项），严格单选。
3. 版本框渲染为 `<input class="patch-file-version" list="patchProductVersions-{index}">` + `<datalist id="patchProductVersions-{index}">`，原生可输入下拉。
4. 产品 `change` 事件：重建该条目 datalist 为该产品版本；当前版本值若不在新列表则清空。
5. `startUpload()` 校验/取值逻辑不变（select 和 input 均通过 `.value` 读取）。
6. 上传成功后刷新 `patchState.products` 缓存。

多文件互不影响：datalist id 按文件索引唯一。

### 17.6 前端产品/版本管理页（管理员）

- 页签栏新增 `<button id="patchProductTab" data-tab="product" hidden>产品版本管理</button>`，在 `patchSetAuthenticated()` 中 `hidden = !isAdmin` 同步。
- 面板 `#patchTabProduct`（仿"待分析补丁"）：表头"新增产品"按钮 + 表格列 `名称/排序/版本数/操作`。
- 新增/编辑产品弹窗 `#patchProductModal`（仿工作目录弹窗：名称、排序）。
- 版本管理弹窗 `#patchProductVersionModal`：展示某产品版本列表（每条带删除）+ 底部输入框"新增版本"。
- JS：`patchState.admin.products`、`patchState.admin.currentProduct`；`loadProducts()`、`renderProducts()`、`openProductForm()`、`saveProductForm()`、`openProductVersions()`、`addProductVersion()`、`deleteProductVersion()`；全局 click 委托加 `data-product-edit / data-product-delete / data-product-versions / data-version-delete` 分支；删除走 `patchConfirm`，错误走 `adminMessage`。
- 样式复用现有 `.patch-table / .patch-admin-modal / .patch-admin-form`，仅需少量 `.patch-upload-item` 内 select 的统一样式。

### 17.7 历史数据初始化（可选）

把历史补丁的产品/版本一键灌入字典，避免部署后下拉为空：

```sql
INSERT IGNORE INTO product (name)
SELECT DISTINCT product_name FROM patch_info WHERE product_name <> '';
INSERT IGNORE INTO product_version (product_id, version)
SELECT p.id, pi.product_version FROM patch_info pi JOIN product p ON p.name = pi.product_name
WHERE pi.product_version <> '';
```

也可选择在管理页手工录入。

### 17.8 验证

- 建表 SQL 执行后重启 patch_search。
- admin 新增产品/版本 → 上传页产品下拉出现该产品，选产品后版本下拉只显示其版本、且可手输新值。
- 非 admin 看不到"产品版本管理"页签。
- 删除产品 → 历史补丁详情/列表不受影响，上传下拉中该产品消失。
- 上传成功后再打开上传弹窗，新填版本仍在 datalist 中（缓存刷新）。
- 前端需 `cargo build --release --target-dir target-new` 后重启 cc-web。

### 17.9 落地说明

- 方案 B 已实现并部署：产品/版本字典管理页、上传弹窗与"我的补丁"编辑弹窗均改为下拉 + 可输入 combobox（选择产品后版本联动过滤）。
- 17.7 历史数据初始化是否执行（SQL 灌入）还是手工录入，视部署现场数据情况决定。

---

## 十八、流程步骤继续本地 ClaudeCode 会话（继续会话）

> 状态：已实现（含历史消息展示），待重启部署。
> 需求：当流程某个步骤使用本地 claude code（`claude_target = local`）执行完成之后，在"查看摘要"按钮左侧显示一个"继续会话"按钮。点击后在聊天页面恢复与该本地 claude code 会话的上下文继续对话。

### 18.1 目标与交互

- 仅对 `local` 目标步骤生效，`server` 目标步骤不显示按钮。
- 步骤完成（状态为 `success` / `failed` / `waiting_confirmation`）且成功捕获到本地 claude 会话 id 时，在"查看摘要"左侧渲染"继续会话"按钮。
- 点击按钮 → 跳转聊天页并自动新建一个 cc-web 会话，该会话首次消息通过 claude CLI `--resume <session_id>` 恢复同一个 claude 会话。
- **恢复后不自动发送消息**：只打开会话、保留完整历史上下文，由用户继续输入。避免"继续会话"一词被误理解为自动续写。
- **会话窗口直接展示历史消息**：新建会话时把该 claude 会话 `~/.claude/projects/*/<sid>.jsonl` 中的历史解析填充到窗口（用户提问 + 助手回复 + 折叠的工具调用，不含思考过程），无需等用户发首条消息。见 18.9。

### 18.2 数据流

```text
workflow_run.html 收到 SSE local_call_required
  → POST cc-web /api/local-claude/execute
        body: { execution_id, system_prompt, user_prompt, cwd }
        cc-web 以 claude --print --output-format stream-json --verbose 启动一次独立进程
          解析 stdout：system/init 事件 → session_id；result 事件 → 结果文本
        → 返回 { execution_id, text, error, session_id }
  → workflow_run.html POST /api/workflows/runs/{run_id}/steps/{n}/local-result
        body: { execution_token, text, error, session_id }
        patch_search 原子消费执行令牌，并在同一条 UPDATE 里写入 local_session_id
        → workflow_run_step.local_session_id 持久化
  → run_snapshot 的 steps 新增 rs.local_session_id + f.claude_target
      → 前端渲染步骤行：local 且 local_session_id 非空且步骤已完成 → 显示"继续会话"
  → 点击 → location.href = 'index.html?resume=1&sid=<session_id>&cwd=<resolved_directory>'
      → app.js init() 解析 URL 参数 → POST /api/agent/new { cwd, resume_session_id: sid }
      → agent.rs 把 resume_session_id 写入 Session.agent_session_id
      → 用户在聊天页发第一条消息 → stream_session 自动带 --resume <sid>，上下文恢复
```

### 18.3 会话 ID 精确捕获方案

**问题**：同一个工作目录下可能运行多个不同的 claude 会话，各有不同 session id。若通过"读取 `~/.claude/projects/<slug>/` 下最新 jsonl"来推断会话，会与同目录其他会话混淆，取错消息。

**方案**：不依赖 jsonl 目录扫描，而是从**本次 claude CLI 进程自身**的 `stream-json --verbose` 输出中捕获 `system/init` 事件的 `session_id`。每次 `/api/local-claude/execute` 都是独立子进程，其 stdout 只包含本次会话的 init 事件，无歧义。这正是聊天页 `stream_session` 已经在用的机制（`src/ai/streaming.rs` `process_stream_line` 第 69-71 行：`"system" if subtype == Some("init")` → 取 `event.session_id`）。

| 维度 | 现状 `execute_once` | 新增 `execute_once_with_session` |
|---|---|---|
| claude 参数 | `--print --output-format text` | `--print --output-format stream-json --verbose` |
| 结果文本 | stdout 文本 + 最新 jsonl 兜底 | 解析 `result` 事件（带 `is_error`） |
| 会话 id | 拿不到 | `system/init` 事件的 `session_id`，与结果同一次进程拿到 |
| 是否受同目录其他会话影响 | 是（jsonl 兜底可能误取） | 否（只读本次进程输出） |

改造后结果文本不再依赖 jsonl 目录扫描，顺带消除同目录多会话误取问题。

### 18.4 cc-web 改动

**`src/ai/mod.rs`** — `AiAssistant` trait 新增方法（默认返回错误，未实现的助手不受影响）：

```rust
/// 执行一次性提示词并捕获底层会话 id（用于后续 --resume）。
/// 返回 (结果文本, 可选 agent 会话 id)。
async fn execute_once_with_session(
    &self,
    _system_prompt: &str,
    _user_prompt: &str,
    _cwd: &str,
    _model: Option<&str>,
) -> Result<(String, Option<String>), String> {
    Err("independent execution is not supported".to_string())
}
```

**`src/ai/claude.rs`** — 实现 `execute_once_with_session`：拼装提示词 → 以 `--print --output-format stream-json --verbose --permission-mode bypassPermissions --model <model>` 启动子进程 → 逐行解析 stdout：`system/init` 捕获 session_id、`result` 事件取结果文本（`is_error` 为真则返回 Err）。让现有 `execute_once` 委托给它并丢弃会话 id，保持其他调用方行为不变。

**`src/api/local_claude.rs`** — `LocalClaudeResponse` 增加 `session_id: Option<String>`；把 `execute_once` 调用换成 `execute_once_with_session`，成功与失败分支都带出 `session_id`（进程报错时也可能已创建会话）。

**`src/models.rs`** — `NewSessionRequest` 增加：

```rust
pub resume_session_id: Option<String>,
```

**`src/api/agent.rs`** — `new_session` 创建 `Session` 时：

```rust
agent_session_id: req.resume_session_id.clone(),
```

（原来固定为 `None`。）首次 `stream_session` 调用即带 `--resume <id>`，恢复上下文。该字段已有 `--resume` 支持，无需改 `stream_session`。

### 18.5 patch_search 改动

**`app/schemas.py`** — `LocalResult` 增加字段：

```python
class LocalResult(BaseModel):
    execution_token: str = Field(min_length=1, max_length=256)
    text: str = ""
    result: Any | None = None
    error: str | None = None
    session_id: str | None = None
```

**`app/routes/workflow_runs.py`** — 两处：

1. `run_snapshot` 的步骤 SELECT（第 12 行）增加 `rs.local_session_id, f.claude_target`，前端据此判断是否渲染按钮。
2. `local_result` 路由的原子消费 UPDATE（第 133 行）把 `local_session_id` 与 token 消费放同一条 SQL：

```sql
UPDATE workflow_run_step
SET token_used_at=NOW(), execution_token=NULL, local_session_id=%s
WHERE run_id=%s AND step_order=%s AND execution_user_id=%s AND status='running'
  AND execution_token=%s AND token_used_at IS NULL
  AND (token_expires_at IS NULL OR token_expires_at>NOW())
```

**数据库迁移**：

```sql
ALTER TABLE workflow_run_step
  ADD COLUMN `local_session_id` varchar(128) DEFAULT NULL
  COMMENT '本地 ClaudeCode 会话 id，用于继续会话' AFTER `token_used_at`;
```

同步更新 `schema/current_schema.sql` 中 `workflow_run_step` 建表语句。

**rerun 清空**：`workflow_runs.py` 的 rerun 重置 UPDATE（第 79-85 行）增加 `local_session_id=NULL`，重新执行后会捕获新的会话 id。

### 18.6 前端改动

**`static/workflow_run.html`**：

1. `renderWorkflowStepMarkup`（第 228 行）在"查看摘要"按钮左侧插入：

```html
${step.claude_target === 'local' && step.local_session_id && ['success','failed','waiting_confirmation'].includes(step.status)
  ? `<button type="button" class="patch-secondary-btn workflow-result-btn" data-workflow-resume-step="${patchEscape(step.step_order)}">继续会话</button>` : ''}
```

2. `local-result` POST（第 398 行）body 增加 `session_id: result.session_id || null`。
3. click 委托新增 `data-workflow-resume-step` 分支：从 `patchState.workflow.steps` 取该步骤，用 `step.local_session_id` + `step.resolved_directory` 拼接跳转：

```js
location.href = `index.html?resume=1&sid=${encodeURIComponent(sid)}&cwd=${encodeURIComponent(cwd)}`;
```

**`static/app.js`** — `init()`（第 120 行）开头解析 `location.search`：当 `resume=1` 时读取 `sid`/`cwd`，调 `POST /api/agent/new`（body 带 `resume_session_id`），成功后 `selectSession` 并 `history.replaceState` 清理 URL；不自动发送消息，用户继续输入即可。新建会话时后端按 `resume_session_id` 从 claude jsonl 填充历史消息（见 18.9），前端渲染逻辑无需改动。

### 18.7 已知限制

- 会话 id 依赖 claude CLI `--verbose` stream-json 输出；CLI 版本过旧或未安装时不返回 id → 按钮不显示，功能静默退化。
- `--resume` 只在同一台客户端机器有效（会话文件在 `~/.claude/projects/<slug>/` 本地磁盘），换机器无法恢复。
- 恢复目录取步骤 `resolved_directory`，若与执行时 cwd 不一致，claude 会在错误目录恢复。
- 仅 `local` 步骤显示按钮；`server` 步骤、非本用户运行、已删除的运行不显示。

### 18.8 验证

- cc-web 需 `cargo build --release --target-dir target-new` 后重启；patch_search 执行迁移 SQL 后重启。
- 配置一个 `local` 步骤的模板并运行 → 步骤完成 → `SELECT local_session_id FROM workflow_run_step` 有值。
- 步骤行"查看摘要"左侧出现"继续会话"；点击 → 聊天页打开该会话，历史上下文保留（问"上一步你输出了什么"能回答）。
- 同一目录并发两个不同的 claude 会话，继续会话恢复的是执行该步骤的那一个（不是最新 jsonl 对应的那个）。
- `server` 步骤不显示按钮；CLI 未返回 session_id 时不显示按钮。
- rerun 后 `local_session_id` 被清空，重新执行后重新捕获。
- 点击"继续会话"后聊天窗口直接显示历史：用户提问 + 助手回复 + 折叠的工具调用，无思考过程；发新消息后 `--resume` 正常续聊、能引用此前上下文，历史消息不被重复注入给 claude。
- sid 对应的 jsonl 缺失或解析失败时，会话正常创建（窗口为空），不报错。

### 18.9 继续会话的历史消息展示

> 需求补充：点击"继续会话"后，cc-web 会话窗口直接展示该 claude 会话的历史消息（此前窗口为空，需用户发首条消息后才可见）。仅改后端，前端渲染零改动。

**`src/claude_history.rs`**（新增）：

- `find_session_file(sid)`：在 `~/.claude/projects/*/<sid>.jsonl` 中按全局唯一 sid 遍历定位会话文件，规避路径编码（`:`→`--`、`\`→`-`）差异问题。
- `load_history(sid, assistant)`：解析 jsonl 为 cc-web `Message` 列表，展示粒度"折中"——用户提问 + 助手回复文本 + 工具调用（前端默认折叠），跳过思考块。
- 过滤非真实用户内容：`isSidechain` / `isMeta`、`<` 开头的命令/输出回显、上下文压缩摘要（"This session is being continued..."）、恢复会话注入提示（"When applied to an existing project..."）。
- `tool_result` 事件按 `tool_use_id` 追加到对应的上一条助手消息，前端按 `data-tool-id` 注入折叠块。
- 时间戳解析 ISO8601（`chrono::DateTime::parse_from_rfc3339`），失败用当前时间。

**`src/api/agent.rs`** — `new_session`：`req.resume_session_id` 存在时 `messages = claude_history::load_history(sid, &assistant_name)`，再追加 `req.message`（如有）；`agent_session_id` 仍记录 resume_session_id，保证 `--resume` 与 `start_prompt` 跳过 auto_history 生效，历史不会重复注入给 claude。

**`src/main.rs`** — 注册 `mod claude_history;`。

历史仅用于展示；claude 的上下文仍由 `--resume` 自带。jsonl 缺失/解析失败返回空列表，会话正常创建，不报错。

---

## 十九、运行时工作目录绑定与目录删除（v3.2）

> 状态：已实现。数据库变更需要执行迁移脚本 `schema/migration_runtime_directory_binding.sql`（在 MySQL 上手动执行一次）。

### 19.1 背景与目标（方案 A）

`local` 步骤在"运行 cc-web 的客户端机器"上执行 ClaudeCode，工作目录是**使用者本机**的路径。原先工作目录是流程的固定属性（`workflow_flow.directory_code`），同一个流程交给不同使用者执行时，无法对应到各自本机的路径。

方案 A 把 `local` 步骤的工作目录从"流程固定属性"改为**运行时参数**：启动流程时逐步骤绑定。`server` 步骤不变——始终在服务器 A 上执行，按目录 `code` 解析。

### 19.2 数据模型

- `workflow_flow.directory_code` 改为可空（`DEFAULT NULL`）：`local` 流程可留空；`server` 流程由表单强制必填。
- `workflow_run_step` 新增 `directory_id`（`bigint(20) unsigned`，可空，外键 → `workflow_directory.id`，`ON DELETE SET NULL`）；`directory_code` 改为可空；`directory_type` 增加取值 `manual`。
  - `directory_type` 语义：`user` = 本人目录；`builtin` = 管理员内置目录；`manual` = 运行时手填本机路径（此时 `directory_code` 与 `directory_id` 均为 NULL，仅 `resolved_directory` 有值）。
- 迁移脚本 `schema/migration_runtime_directory_binding.sql` 内容：两张表 `directory_code` 改可空、`workflow_run_step` 新增 `directory_id` 列、`directory_type` 注释改 `user/builtin/manual`、新增 `KEY fk_workflow_run_step_directory` 与 `CONSTRAINT ... ON DELETE SET NULL`。`schema/current_schema.sql` 已同步。

### 19.3 接口

- `GET /api/workflows/templates/{template_id}/directory-requirements`：返回该模板的 `local` 步骤清单 + 当前用户可用目录选项（响应结构见 7.9）。模板不可见时 404。
- `POST /api/workflows/runs`：请求体新增可选 `directory_bindings`（结构见 7.11）。

### 19.4 执行引擎

`WorkflowEngine.create_run` 新增 `directory_bindings` 形参，按步骤解析 `directory_code` / `directory_id` / `directory_type` / `resolved_directory` 并写入 `workflow_run_step`（解析规则见 8.3）。`local` 手填路径为客户端路径，服务端不做存在性校验。

### 19.5 cc-web 前端

- **流程设置表单**（`static/patches.js` → `openAdminForm` flow 分支）：`local` 目标时工作目录可留空，字段下方提示"本地 ClaudeCode 可留空，启动流程时由使用者逐步骤选择或手动填写本机路径"；切换为 `server` 时该字段 `required`。保存时 `directory_code` 允许发送 `null`。
- **启动流程**（`startWorkflow` → `openWorkflowDirDialog` / `confirmWorkflowDirDialog`）：
  1. 先请求 `directory-requirements`；
  2. 若模板存在 `local` 步骤，弹出"选择本地工作目录"对话框（`patches.html` 的 `patchWorkflowDirModal`），每个本地步骤一行：`已有目录`下拉（当前用户自己的启用目录）/ 勾选"改用手动填写的路径"后输入本机绝对路径（两者互斥切换）；
  3. 每步选择记忆到 `localStorage['cc-web-wf-dir:<template_id>:<step_order>']`（`id:<目录ID>` 或 `path:<路径>`），下次打开自动回填；若该用户没有任何可用目录则默认转入手动填写；
  4. 确认后 `POST /api/workflows/runs` 携带 `directory_bindings`，创建成功跳转 `workflow_run.html?run_id=…`；
  5. 若模板没有 `local` 步骤，跳过弹窗直接创建运行。
- **工作目录管理页**：非只读行的操作列为 `编辑 | 停用 | 删除`（内置目录对普通用户显示"只读"）；`删除` 调用物理删除接口，点击前先用 `patchConfirm` 二次确认（文案见 19.7）。

### 19.6 local 步骤状态显示修复

- 现象：`local` 步骤在客户端执行期间，运行列表外面仍显示"待确认"。
- 原因：`engine.execute_step` 在 `pending_local` 分支把整条 `workflow_run` 置为 `waiting_confirmation`；`workflow_run.html` 收到 `local_call_required` 也把 run/step 置为 `waiting_confirmation`——但此时步骤仍在执行。
- 修复：`local` 调起期间运行保持 `running`（仅更新 `execution_token`/`token_expires_at`），步骤在结果回传 `finish_step` 后才置 `waiting_confirmation`；前端收到 `local_call_required` 时保持/置为 `running`；`workflow_error` 事件映射为"失败"。
- 状态映射（`patches.js` `workflowStatusLabel`）：`pending` 待执行、`running` 执行中、`waiting_confirmation` 待确认、`success` 已完成、`failed` 失败、`cancelled` 已取消。

### 19.7 目录软删除 vs 物理删除

| 操作 | 前端按钮 | 接口 | 行为 | 影响 |
|---|---|---|---|---|
| 停用 | `停用` | `DELETE /api/workflows/directories/{id}` | `UPDATE ... SET status=0` | 记录保留，列表仍显示"停用"；启用过滤下被模板选择处不可选 |
| 删除 | `删除` | `DELETE /api/workflows/directories/{id}/permanent` | `DELETE FROM workflow_directory` | 记录移除；`workflow_run_step.directory_id` 外键置空；引用该目录的流程模板将无法再解析 |

权限两者一致：个人目录（`is_builtin=0`）仅本人可操作，内置目录仅管理员可操作；越权 403、不存在 404。`删除` 的前端确认文案："删除后无法恢复。若有流程模板或运行记录引用该目录「名称（code）」，相关流程将无法再解析此工作目录。"

### 19.8 验收

- 选择已有目录启动 `local` 流程：`workflow_run_step` 写入对应 `directory_id`，`directory_type` 为 `user`/`builtin`，客户端在 `resolved_directory` 目录执行。
- 手填本机路径启动：`directory_type='manual'`，`directory_code`/`directory_id` 为 NULL，`resolved_directory` 为所填路径。
- `server` 流程忽略 `directory_bindings`。
- `local` 步骤执行期间运行列表显示"执行中"，结果回传后显示"待确认"，点击"下一步"后下一步显示"执行中"，全部完成显示"已完成"。
- 删除个人目录需二次确认，确认后从列表消失；停用仅状态变为“停用”。

---

## 二十、问题解决节点（本地 ClaudeCode 分析 + 补丁合并）

> 状态：方案已定，**未实现**。
> 定位：在**智能开发**页签内新增一个本地执行的「问题解决」节点。不走聊天页，也不走 patch_search 的流程引擎。
> 关联功能：表单项之一的「关联的产品环境变量」来自既有功能 `project_environment`（本文档尚未收录该表，见 `app/routes/project_env.py` 与 `schema/current_schema.sql`）。

### 20.1 需求

表单项四项：

| 表单项 | 说明 |
|---|---|
| 问题/需求描述 | 必填。要解决的问题或要实现的需求 |
| 关联的产品环境变量 | 必填。下拉，取自当前用户的 `project_environment` 条目，选中后带出 `product/version`、`code_directory`、`package_path`、`local_jdk_path` |
| 补丁输出路径 | 必填。本机绝对目录，产物（补丁 zip / SQL / 说明）写到这里 |
| 相关日志信息 | 选填。粘贴的报错栈/日志文本 |

点「开始执行」→ 调用**本机** ClaudeCode，拼接提示词，分析**产品源码 + 客开代码** → 产出修改方案：

- 代码相关问题 → 直接给出补丁包（`java_compiler_mcp` 的 zip 补丁包）
- 数据库/配置问题 → 给出对应 SQL 或实现方案，写进 txt 文档

执行结束后页面出现两个按钮：**问题未解决** / **问题已解决**。点「问题已解决」→ 把改动**合并回客开工程**，这一步同样由 ClaudeCode 执行，且**与给出方案在同一个会话中**。

### 20.2 路线选择：路线 A（cc-web 会话复用），不新建服务端流程

| 维度 | 路线 A：复用 cc-web 会话 | 路线 B：接进 patch_search 流程引擎 |
|---|---|---|
| 执行体 | cc-web 的 `/api/agent/*`，一个会话连续两次 start | `workflow_run` + `local_call_required` 轮询认领 |
| **同一会话** | **天然满足**（见 20.4） | 需绕开 `/api/local-claude/execute` 无 `--resume` 的限制 |
| 交互形态 | 表单 + 流式过程 + 两个判定按钮，可自定义 | 受流程模板的「步骤 + 下一步 + 待确认」形态约束 |
| 改动面 | 只加 cc-web 的 `static/*` 与一个 `node_runs.json` 接口 | 需新增模板/步骤语义，且要部署 patch_search |
| 结论 | **选 A** | 否 |

**读法二**（已确认）：合并 = 把改动**合并回客开代码目录**（`code_directory`，即仓库根）；`java_generate_patch` 产出的 zip 是**部署用的副产品**，不参与合并。

### 20.3 为什么能放在「智能开发」里而不必进聊天页

`patches.html` 与 `index.html` 是**同源**的（同一个 cc-web 进程、同一个 3030 端口）：

- 调 cc-web 自己的 `/api/agent/*`、`/api/sessions/*`、`/api/node/*` 用普通 `fetch` 即可，**不涉及 CORS**
- 调 patch_search 仍走既有的 `patchRequest`（跨域，`main.rs:228-235` 的 `allow_any_origin` 已放开）
- 页签机制可直接复用：
  - `data-tab="node"` 自动对应面板 id `patchTabNode`（`patches.js:1176/1191` 的 `patchTab${tab[0].toUpperCase()}${tab.slice(1)}` 推导）
  - `patchSwitchTab` 末尾按 `tab === ...` 触发首次加载（`patches.js:1195-1203`），新增一行 `if (tab === 'node' ...) loadProblemRuns();`
  - 左侧导航项照 `patches.html:18-64` 的 `<a class="patch-sidenav-item" data-sidenav-tab="node">` 结构加一条，`patchSyncSidenavVisibility()`（`patches.js:120`）会自动同步显隐

### 20.4 会话复用：为什么不需要改 `claude.rs` / `agent.rs`

这是路线 A 成立的核心：

1. `POST /api/agent/new` 建会话 → `POST /api/agent/{id}/start` 发提示词（`agent.rs:67` / `:155`）。
2. cc-web 从 claude CLI 的 `system/init` 事件拿到真实 session id，写进 `Session.agent_session_id`，并持久化到 `~/.cc-web/sessions.json`（`main.rs:57-101`）。
3. **从第二次 start 起自动带 `--resume`**（`claude.rs:806-809`），上下文延续——这就是「同一个会话」。
4. `session.cwd` 每次 start 都被复用（`claude.rs:813-819`），两阶段天然同目录。

→ 所以两个阶段只是**对同一个 cc-web 会话连续 start 两次**，`claude.rs` 与 `agent.rs` 零改动。

**落地时唯一的 cc-web 后端改动（1 行，additive）**：`src/ai/streaming.rs` 的 `start` 事件多带一个字段

```rust
"agentSessionId": agent_session_id.clone()   // 非 claude 助手为 null
```

原因：`agent_session_id` 第 2 步只写进了 `Session` 并落盘到 `sessions.json`，`GET /api/sessions/{id}` **不返回**它，SSE 也没有别的地方带它 → 前端拿不到「claude 会话 id」，就没法上报 `claude_session_id`，也没法拼 20.15 的「继续会话」链接。加到已有的 `start` 事件上是最小代价（不改接口签名、不改落盘格式、不影响既有消费方）。

**反面**（为什么不能用 `/api/local-claude/execute`）：那条路走 `execute_once_with_session`，是唯一的**无 `--resume`** 分支（`LocalClaudeRequest` 也没有 resume 字段），每次都是全新进程 → 无法满足「同一个会话」。

### 20.5 ⚠️ `--resume` 与 cwd 强绑定（已实测）

实测：同一目录 `--resume` 正常返回；换一个目录报 `No conversation found with session ID: a0a5c23d-...`。

三条推论：

1. 两阶段的 cwd **必须一致** → 靠 `/api/agent/{id}/start` 复用 `session.cwd` 天然满足，不需要额外机制。
2. 「让 Claude 只读、不许改客开工程」**不能靠临时换目录实现**（换目录就 resume 不上）。
3. 所以约束不能加在 cwd 上，只能加在「**改动写到哪**」上。

**结论（已定稿）**：cwd 两个阶段都是 `code_directory`（客开工程，仓库根）——**claude 就在客开工程里干活**，全量读、grep、分析；但**不许就地改**，任何修改都先落到 `<补丁输出路径>/<runId>/work` 这个**暂存目录**里，点「问题已解决」后才同步回 `code_directory`。

```text
cwd       = code_directory（客开工程根）        ← 两个阶段都是它，resume 才成立
outDir    = <补丁输出路径>/<runId>              ← 产物：zip / 方案.txt / changes.txt / 结论.md
stageDir  = <outDir>/work                       ← 只放"被改过的那几个文件"，镜像 src/<type>/... 结构
阶段一：在 code_directory 里只读分析。要改某文件 → 先按同样相对路径把它复制到 stageDir，再在 stageDir 里改
阶段二：把 stageDir 里的文件复制回 code_directory 的对应相对路径
```

**为什么不是"复制整份工程"**：不需要。补丁包的编译只需要「改动的那几个文件 + 一份能提供其余类的 classpath」，而这份 classpath 正好由环境里的 `package_path`（"home/war包地址"）提供。

**已读源码验证（`D:\project\mcpadd\java_compiler_mcp.py`）**：

- files 模式**只编译传入的 `.java`**：`java_generate_patch` → `_compile_java_files(files, java_home, params.home, ...)`（`:1144`）。
- classpath = 本次已编译产物 + `_scan_home_directory(params.home)` 递归扫出的 `classes` 目录与 `*.jar`（`_compile_java_files` 在 `:796`，扫描器在 `:137`）。**所以 `home` 要传环境里的 `package_path`**——它正是"含 jar 和 class 的依赖根"，`java_generate_patch` 的 `home` 参数文档写的就是这个意思。
- 按 `src/public → src/private → src/client → other` 顺序**分组编译**，前一组的产物加到后一组 classpath 最前面（`:1132-1147`）→ 同批改动的跨文件引用能解析。
- 目标路径由 `_get_target_path(相对 module_path 的路径, module_name)` 推出（`:1159`）→ **stageDir 必须镜像 `src/<type>/...` 的相对结构**，并且调用时要给出 `module_name`。

**好处（相对复制整仓）**：不复制仓库（大工程省掉一次全仓拷贝）；cwd 是真实工程，claude 能全量分析客开代码——这正是"在客开工程干活"的意思；补丁 zip 只含改动的 class，更小更准。

**代价与安全网**：

- **"只读"是提示词约束，不是技术隔离**（cwd 就是真实工程，且 cc-web 是 `bypassPermissions`）。所以必须配校验：阶段一每次 claude 回合结束后，在 `code_directory` 跑 `git status --porcelain`，非空即说明越界改了真实文件 → 在页面上报警。客开工程多数是 git 仓库，这也是 20.14 里"用户能自己核对/回退"的前提。
- **越界了不自动回滚**：此时用户自己可能也在改同一个工程，自动 `git checkout` 会误伤。只报警，由用户判断。
- 非 git 仓库：跳过该校验，只靠提示词约束，并在表单旁提示"建议在 git 仓库内使用"。

### 20.6 存储分层（「永久保存」的答案）

一条 run 里有三种寿命完全不同的东西，必须分三层放：

| 层 | 存什么 | 放在哪 | 寿命 |
|---|---|---|---|
| 运行态 | 跑到哪一步、cc-web 会话 id、claude 会话 id、cwd、stageDir、产物清单 | 本机 `~/.cc-web/node_runs.json` | 跟机器走；重启/重装 cc-web 不丢；**换机不可用** |
| 产物态 | 补丁 zip、SQL、方案.txt、changes.txt、结论.md、`run.json` | `outDir`（补丁输出路径） | 跟目录走；**建议放在客开工程内 → 跟着 git 走，异地多份，真正永久** |
| 摘要态 | 问题描述、产品/版本、状态、结论摘要、操作人、机器名 | patch_search 的 `problem_run` 表 | 服务器寿命；团队可见、可统计 |

关键判断（解释为什么不需要把运行态搬进数据库）：

- **合并成功那一刻，补丁包的使命就结束了**——按读法二，它的内容已经变成客开工程源码的一部分，而客开工程（大多）是 git 仓库。所以「补丁包永久保存」不是真需求；把**合并**做对，永久保存就自动完成。
- **运行态搬进数据库也换不到能力**：claude 的会话文件在 `~/.claude/projects/*/` 本机磁盘、按 cwd 索引，换机后 `--resume` 必然 `No conversation found`，输出目录的绝对路径也不存在。「已解决」按钮在新机器上点不动。存在服务器上只能让这条记录在别处**可见**，而它 100% 的价值在**能动**。可见 ≠ 可用。
- **数据库存不下产物本身**（BLOB 不现实），所以服务器那份「永久」本来就是半截的——真东西仍在某台机器磁盘上。多一层索引救不了产物。
- 因此服务器表是**只写摘要的账本**，不是运行的事实来源（见 20.8 的措辞约束）。

一句话：**永久保存靠的不是「存在哪」，是「有没有一份跟着工程走」**。

### 20.7 本地运行清单 `~/.cc-web/node_runs.json`

照搬 `sessions.json` 的既有做法（`main.rs:62` 的 `data_dir.join("sessions.json")`、`:66` 读、`:86/:101` 写）：

- `src/main.rs`：新增 `node_runs.json` 路径 + `load/save_node_runs_to_disk`，启动时载入（对照 `:200`）、变更后异步落盘。
- `src/api/node_runs.rs`（新增）：

| 接口 | 说明 |
|---|---|
| `GET /api/node/runs` | 返回全部 run（本机清单，无需分页）。**额外带一个 `host`**（本机机器名） |
| `PUT /api/node/runs/{id}` | **upsert**：整对象覆盖式写入，不存在则创建。前端每阶段结束/每次状态变化都 PUT |
| `DELETE /api/node/runs/{id}` | 从清单移除（**不删** outDir 里的产物，也不删 cc-web 会话） |

**`host` 为什么在 `GET` 上而不是 run 对象里**：浏览器读不到本机机器名（`navigator` 里没有可信来源），而 `client_host` 要上报给服务器（见 20.17"换机后显示原机器名"）。所以由 cc-web 读环境变量（`COMPUTERNAME` → `HOSTNAME` → `"unknown"`，取不到不报错）随列表一起下发，前端在**新建 run** 时把它写进 run 的 `client_host`。存进 run 而不是每次上报现取，是为了让「这台机器」在换机后仍可解释（本机清单是全机共享的一份，换用户也不该漂移）。

run 对象（前端持有，cc-web 只做透明存取，**不解释字段**）：

```json
{
  "id": "uuid",
  "problem_desc": "…",
  "env_id": 3,
  "env_snapshot": { "project_name": "…", "product_id": 7, "version_id": 12,
                    "product_name": "…", "product_version": "…",
                    "code_directory": "D:\\repo", "package_path": "D:\\home",
                    "local_jdk_path": "D:\\Software\\jdk-17",
                    "db_connection": "jdbc:mysql://10.4.122.21:3306/patch?user=…&password=…",
                    "debug_address": "10.4.122.21:5005" },
  "patch_output_path": "D:\\patch-runs\\20260920-1",
  "out_dir": "<patch_output_path>\\<id>",
  "stage_dir": "<outDir>\\work",
  "log_info_inline": "短日志原文",
  "session_id": "cc-web 会话 id",
  "agent_session_id": "claude 会话 id",
  "phase": "analyzing | awaiting_decision | merging | done | failed",
  "verdict": null,
  "failure": null,
  "report": "claude 最终结论文本",
  "artifacts": ["<outDir>\\patch.zip", "<outDir>\\方案.txt", "<outDir>\\changes.txt"],
  "client_host": "本机机器名",
  "reported": false,
  "created_at": "…", "finished_at": "…", "updated_at": "…"
}
```

- `env_snapshot` 存**快照**而不是只存 `env_id`：环境条目事后再被编辑/删除时，这条 run 仍然自解释。
- `env_snapshot` 里的 `db_connection` / `debug_address` / `local_skill_path` 是**选填**的（环境条目里没登记就没有这个键、提示词里也没有这一行）：`db_connection` 只在提示词里给 claude 当**只读**查询用（约束见 20.13 第 7 条），`debug_address` 只是把远程调试口告诉它，`local_skill_path` 是**本机 skill 库根目录**（第二十二章），提示词按它点名让 claude 去读 `<库>/java-compiler-mcp/SKILL.md`。⚠️ `db_connection` 通常含账号口令，落进本机 `node_runs.json` 就是**明文存了一份凭据**——可接受的理由：它本来就等价地存在 patch_search 库里、且浏览器每次都要取；但它**不参与上报**（`patchNodePushReport` 是白名单，只送 20.8 那几列），也**不在 UI 上展示**。若不希望本机落盘，可改为只在建 run 时内存里传给提示词、不进快照（代价是 run 不再自解释）。
- 日志（`log_info`）**不落盘**（2026-09-20 拍板）：它的定位是"用户提供给 claude 的定位输入"，全文进提示词即可；短日志（≤8KB）在清单里留一份 `log_info_inline` 备查，超过 8KB 的**哪里都不存**。原先那套"让 claude 抄一份到 `<outDir>/logs.txt`、清单只留路径"的做法已去掉——理由见 20.13 第 6 条（浏览器写不了文件 → 只能靠 claude 抄，几万行的日志既费输出 token 又可能抄走样）。
- `out_dir` 是 `patch_output_path`（用户填的父目录）与 `id` 拼出来的，**必须落进 run**：它决定了产物在哪、`stage_dir` 在哪。只在内存里拼、不落盘的话「继续查看」就指不出产物。
- 相比 20.7 早期草稿多带的字段：`out_dir`、`client_host`、`failure`、`env_snapshot.product_id/version_id`（前两个见上；`failure` 区分"合并失败"与"中断"，因为服务器 `status` 两个值不同；`product_id/version_id` 是为了上报 `problem_run` 的外键列，而 `env_snapshot` 又是 run 里唯一自解释的来源）。

### 20.8 服务器表 `problem_run`（patch_search）

> 措辞约束：**本表是本机 `node_runs.json` 的只写摘要账本，不是运行的事实来源。**任何执行/判定逻辑都不得以本表状态为驱动依据。

> **以迁移文件为准**：`schema/migration_problem_run.sql`（幂等，可重复执行）。下面这段与它逐字一致，改一处请同步另一处。

```sql
CREATE TABLE IF NOT EXISTS `problem_run` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `local_run_id` varchar(64) NOT NULL COMMENT '客户端生成的运行标识（uuid），幂等上报的唯一键',
  `problem_desc` text NOT NULL COMMENT '问题/需求描述',
  `env_id` bigint(20) unsigned DEFAULT NULL COMMENT '关联的产品环境变量 ID（无外键；仅追溯用，展示不 JOIN）',
  `env_project_name` varchar(255) DEFAULT NULL COMMENT '环境快照：项目名称（环境改名/删除后本记录仍可读）',
  `product_id` bigint(20) unsigned DEFAULT NULL COMMENT '产品字典 ID（无外键无索引，展示时 LEFT JOIN product 取名称）',
  `version_id` bigint(20) unsigned DEFAULT NULL COMMENT '版本字典 ID（无外键无索引，展示时 LEFT JOIN product_version 取版本号）',
  `code_directory` varchar(1024) DEFAULT NULL COMMENT '环境快照：客开代码目录（客户端本机路径；服务器不校验不访问）',
  `patch_output_path` varchar(1024) DEFAULT NULL COMMENT '环境快照：补丁输出路径（客户端本机路径；服务器不校验不访问）',
  `status` varchar(32) NOT NULL DEFAULT 'running' COMMENT '运行状态：running 执行中、awaiting_decision 待用户判定、solved 已解决、unsolved 未解决、merge_failed 合并失败、aborted 已中断',
  `conclusion` text COMMENT '结论摘要（改动说明 / 方案要点）；不存日志正文',
  `claude_session_id` varchar(128) DEFAULT NULL COMMENT 'claude 会话 id；仅生成它的那台客户端机器能用于「继续会话」',
  `client_host` varchar(128) DEFAULT NULL COMMENT '执行该运行的客户端机器名，用于解释换机后为何不可继续',
  `started_at` datetime DEFAULT NULL COMMENT '开始执行时间（客户端上报）',
  `finished_at` datetime DEFAULT NULL COMMENT '结束时间（客户端上报，用于统计耗时）',
  `created_by_user_id` bigint(20) unsigned NOT NULL COMMENT '归属用户 ID；每个用户只能看到/改到自己的行',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_problem_run_local_id` (`local_run_id`),
  KEY `idx_problem_run_owner_time` (`created_by_user_id`,`id`),
  CONSTRAINT `fk_problem_run_owner` FOREIGN KEY (`created_by_user_id`) REFERENCES `user_account` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='问题解决节点运行摘要表（本地 node_runs.json 的只写账本）';
```

**两处与本文档早期草稿的偏差（落地时改的，以迁移文件为准）：**

| 早期草稿 | 实际落地 | 理由 |
|---|---|---|
| `KEY idx_problem_run_status (status)` | **去掉** | 现有查询恒为按 `created_by_user_id` 过滤 + `ORDER BY id DESC`，没有按状态过滤的场景；`status` 只有 6 个取值，低基数索引基本不会被选中，白占写入开销。将来真出现按状态过滤再加。 |
| `CONSTRAINT fk_problem_run_env FOREIGN KEY (env_id) REFERENCES project_environment (id) ON DELETE SET NULL` | **去掉** | 与 `project_environment` 自己的口径一致——那张表连自己都没有任何外键（隔离全靠应用层）。而且本表展示时不 JOIN `project_environment`（用 `env_project_name` 快照），外键约束不到任何实际用途，反而会给环境删除带来额外锁与失败面。`product_id / version_id` 同样无外键。`created_by_user_id` 的外键保留，与 `workflow_flow / workflow_directory / patch_info` 一致。 |

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | BIGINT UNSIGNED | 否 | 自增主键。 |
| `local_run_id` | VARCHAR(64) | 否 | 客户端生成的 uuid，**唯一键即幂等键**：上报天然可重试，不需要"先查后插"。 |
| `problem_desc` | TEXT | 否 | 问题/需求描述。 |
| `env_id` | BIGINT UNSIGNED | 是 | 关联的产品环境变量 ID，**只留列、无外键**（见上方偏差表）。环境被删后本列成为悬空引用，但展示用的是 `env_project_name` 快照，所以历史记录照样可读。 |
| `env_project_name` | VARCHAR(255) | 是 | 环境快照。环境改名/删除后本记录仍可读。 |
| `product_id` / `version_id` | BIGINT UNSIGNED | 是 | 产品/版本字典 ID。与 `project_environment` 的做法一致：**只存 ID、不存名称文本**，展示时 `LEFT JOIN product` / `product_version` 取名称；字典是逻辑删除、行永远在，所以历史记录永远显示得出名字，且管理员改名后自动跟随。 |
| `code_directory` / `patch_output_path` | VARCHAR(1024) | 是 | 环境快照，本机绝对路径，**仅供看懂"在哪台机器、哪个目录"**，服务端不校验、不访问。 |
| `status` | VARCHAR(32) | 否 | 见下方状态表。 |
| `conclusion` | TEXT | 是 | 结论摘要，供团队检索/回顾。**不存日志正文**（体积不可控，且可能含敏感信息）；需要原文时读本机 `outDir`。 |
| `claude_session_id` | VARCHAR(128) | 是 | claude 会话 id。仅用于列表页「继续会话」（第十八章的 `?resume=1&sid=&cwd=` 机制），**只在原机器有效**。 |
| `client_host` | VARCHAR(128) | 是 | 客户端机器名，用于解释"为什么这条记录在我这不能继续会话"。 |
| `started_at` / `finished_at` | DATETIME | 是 | 用于统计耗时；由客户端上报。 |
| `created_by_user_id` | BIGINT UNSIGNED | 否 | 创建用户，外键关联 `user_account.id`。 |
| `created_at` / `updated_at` | DATETIME | 否 | 创建/更新时间。 |

状态流转：

```text
running ──(阶段一结束)──> awaiting_decision ──┬─(点已解决，合并成功)─> solved
                                              ├─(点已解决，合并失败)─> merge_failed
                                              └─(点未解决)──────────> unsolved
running ──(用户点中断)──> aborted
```

**本地 `phase`/`verdict`/`failure` → 服务器 `status` 的实际映射**（前端 `patchNodeServerStatus`，本地是事实来源、服务器只是摘要）：

| 本地 | 服务器 | 说明 |
|---|---|---|
| `analyzing` / `merging` | `running` | 两个阶段都在跑 |
| `awaiting_decision` | `awaiting_decision` | |
| `done` + `verdict=solved` | `solved` | |
| `done` + `verdict=unsolved` | `unsolved` | 含"点未解决"和"阶段二合并未成功"两种来路 |
| `failed` + `failure=merge` | `merge_failed` | 合并冲突/未成功（20.14） |
| `failed` + `failure=abort` | `aborted` | 只有用户点「中断」 |

**与早期草稿的一处语义修正**：草稿写的是「阶段一失败 → aborted」，实际实现里**阶段一执行出错（claude 进程报错、spawn 失败、会话建不起来）也落到 `awaiting_decision`**，不落 `aborted`。
理由：出错后用户仍然有唯一的收尾入口（未解决 / 已解决 / 删除记录），此时把状态说成"已中断"会误导人以为是用户主动停的；`aborted` 只留给**用户真的点了中断**这一种情况。同理，服务器上不存在"阶段一失败"这个状态——**不是漏了，是刻意不引入**。

**刻意不做的设计**（避免误用）：

- 不加 `workflow_run_id` / 不接流程引擎：本节点与流程模板是两套东西，混在一起会让「步骤」语义污染。
- 不存 `log_info` 正文、不存 `env_snapshot` 整体 JSON：前者体积不可控，后者把本机会变的东西搬上服务器。
- 不做运行态字段（不存 `phase`、`session_id` 之外的进度）：一旦服务器上出现了"进度"，就会有人想用它来驱动执行。

### 20.9 服务器接口（`app/routes/problem_runs.py`，新增并注册到 `app/main.py`）

| 接口 | 权限 | 说明 |
|---|---|---|
| `POST /api/problem-runs` | 任意登录用户 | 上报/更新一条运行摘要。按 `local_run_id` 做 `INSERT ... ON DUPLICATE KEY UPDATE`，**只允许写自己创建的行**（命中他人行返回 403） |
| `GET /api/problem-runs` | 任意登录用户 | 本人运行摘要列表，按 `id DESC`；`LEFT JOIN product/product_version` 带出名称 |
| `GET /api/problem-runs/{local_run_id}` | 本人 | 单条详情 |
| `DELETE /api/problem-runs/{local_run_id}` | 本人 | 删除记录（**不回删**本机产物与 cc-web 会话） |

- 用户隔离照 `project_env.py` 的做法：所有读写带 `WHERE created_by_user_id=%s`，**admin 也只看自己**（不能复用 `workflows.py` 的 `visible_where`，那套会把管理员创建的行当共享行泄露出去）。
- **不做管理员查看全部**（已拍板）：不提供 `?all=1`，也没有"团队视图"。本表就是每个用户自己的运行账本。
- 是否加菜单权限：本节点在 cc-web 侧是**默认可见**（见 20.13 第 3 条），因此本表**不需要**进 `menu_service.MENU_CATALOG`。

### 20.10 上报策略（服务器不可用不能阻塞干活）

- 上报是 **fire-and-forget**：`POST /api/problem-runs` 无论成功失败都不打断流程，不弹错误提示（失败只在日志里记一行）。
- 失败时本地 run 保持 `reported: false`；进入「问题解决」页签、或下一次状态变化时**补报**。
- 上报内容永远来自本地 `node_runs.json`（本地是事实来源），服务器**不反向覆盖**本地。

### 20.11 页面与表单（`static/patches.html` + `static/patches.js`）

**表单**（实现为 `#patchNodeFormModal`，照 `patchProjectEnvModal` 的既有写法）：

| 字段 | 控件 | 说明 |
|---|---|---|
| 问题/需求描述 | textarea（`problem_desc`），必填 | 前端 trim 后判空 |
| 关联的产品环境变量 | select（`env_id`），必填 | 选项来自 `GET /api/project-envs`（既有接口），显示 `项目名称（产品名 版本号）`；选中后把 `code_directory/package_path/local_jdk_path` 以及**选填的 `db_connection`/`debug_address`/`local_skill_path`** 一起存进 `env_snapshot`，并在下方提示行显示前三个值（JDK 没登记时提示"编译前需要补"） |
| 补丁输出路径 | input（`patch_output_path`），必填 | 本机绝对路径（父目录，`<outDir>` = 它 + `/<runId>`）。**不设默认值**（已拍板），每次由用户自己填；只做"非空 + 绝对路径"的前端校验 |
| 相关日志信息 | textarea（`log_info`），选填 | 全文**整段内联**进阶段一提示词（给 claude 定位用）；≤8KB 时在清单里另存一份 `log_info_inline` 备查，超过就不存（见 20.7 / 20.13 第 6 条）。**不落盘、不让 claude 抄** |

注：编译依赖根（`home`）不单独填，取所选环境的 `package_path`（"home/war包地址"）；JDK 取环境的 `local_jdk_path`；数据库连接、远程调试口、skill 库根目录分别取环境的 `db_connection` / `debug_address` / `local_skill_path`（**三者都选填**）。这些值都进 `env_snapshot` 并在提示词里给 claude。

**流程区**（执行中/结束后的展示）：

- 执行中：流式输出区 + 「中断」按钮（调 `POST /api/agent/{id}/abort`，`agent.rs:930`）
- 结束后：**问题未解决** / **问题已解决** 两个按钮 + 产物清单（zip / 方案.txt / changes.txt / 结论.md / 合并说明.md，`GET /api/files?path=<outDir>` 列目录得到）+ 「继续会话」（就是 20.15 那条跳转，**没有**另做一个"查看完整会话"按钮）
- 产物按钮点一下把**文本**产物内容读进输出区（`GET /api/files/{path}`）；zip 之类读不了，提示"到该路径自行打开"
- 点「问题已解决」前先把 `<outDir>/changes.txt` 展示给用户（见 20.14 的风险说明），再二次确认；`changes.txt` 也读不到时照常弹确认，但把失败原因写在确认框里

**运行列表**（合并视图 = 本机 `node_runs.json` ∪ 服务器 `problem_run`，按 `local_run_id` 去重、**本地优先**）：

| 列 | 说明 |
|---|---|
| 时间 | `created_at` |
| 问题/需求描述 | 截断显示 |
| 产品·版本 | 名称 |
| 状态 | `phase` / `status` 映射为中文：执行中、待判定、已解决、未解决、合并失败、已中断 |
| 结论 | `report` / `conclusion` 摘要 |
| 操作 | **本地有** → `继续查看`（打开该 run 的流程区，流式区不重放、只显示已存结果）/ 未解决 / 已解决（未判定时）/ `继续会话`（跳聊天页，见 20.15）/ `删除记录`；**仅服务器有**（换机后）→ 不渲染任何按钮，只显示一行文字 `仅存档 · <client_host>`（**没有单独的"机器名"列**，机器名就写在这行提示里），`title` 里解释为什么点不动。**不做「重跑」**（已拍板）：失败或未解决后要再做一次，就新建一个 run |

### 20.12 两阶段提示词（v1 硬编码在 cc-web）

**阶段一（分析 + 出方案）**，拼成一个 user prompt：

```text
【问题 / 需求】
{problem_desc}

【相关日志】
{log_info}

【环境】
产品：{product_name} {product_version}
产品源码：通过 patch_source MCP 检索（root: src）
客开工程根（你现在的工作目录）：{code_directory}
暂存目录（改动只能写到这里）：{stageDir}
补丁输出目录：{outDir}
工程 home / war 包地址（编译依赖根）：{package_path}
JDK：{local_jdk_path}
[本机 skill 库（FBIP 领域 skill 库根目录，可按需读取）：{local_skill_path}]                  ← 仅当环境登记了 local_skill_path（2026-09-21 新增）
[数据库连接：{db_connection}（**只读**，见【约束】里关于数据库的那条）]        ← 仅当环境登记了 db_connection
[远程调试端口：{debug_address}（**只做线程级调试**，见【约束】里关于远程调试的那条）] ← 仅当环境登记了 debug_address

【任务】
1. 结合产品源码与客开代码定位问题根因，先给出简短分析；如果证据不足以下结论，如实说明还缺什么，
   并按第 4 条先补日志。可行的方案有多个时，**你自己挑一个你认为最合适的往下做**，不要停下来等用户选；
   在结论里写一句你选的是哪个、为什么选它，以及被你放弃的方案是什么。
2. 动手前先读工具说明书（编译补丁必做；**仅当环境登记了 skill 库时出现，没登记整条换成"跳过这一步"**）：
   a) 读 {local_skill_path}/java-compiler-mcp/SKILL.md —— 编译 MCP 七个工具（java_compile / java_run / java_scan_home /
      java_clear_cache / java_generate_patch / java_apply_patch / frontend_build_patch）的参数、路径映射表、
      GBK 回退与常见错误都在里面。**照它调用，不要自己猜参数**。
   b) 定位根因/写代码时，还可以读 {local_skill_path}/fbip-skill-router/SKILL.md（L1 路由）与它指到的领域 skill
      （新建 VO/Action/ServiceImpl 这类代码按 fbip-nc-codegen 的规范写）。
      若某个 skill 要求的前置 skill 本机不存在（例如 fbip-code-index-analysis），**跳过那条要求继续**，
      不要卡在这一步，把缺的东西写进结论。
   c) skill 文档里出现的 D:\ 之类绝对路径只是它成文时的示例：**本机环境一律以【环境】段为准**，
      与它冲突时以【环境】为准，并把冲突写进结论。
3. 代码类问题：
   a) **先只读地看清工程结构，再决定文件放哪一层**：在 {code_directory} 里找到本次的「模块根」
      —— 含 src/client、src/private、src/public 的那一层（不是客开工程根，也不是模块下的某个子目录），
      并确认要改/新增的每个文件属于这三类里的哪一类。把它们（模块根的绝对路径 + module_name +
      每个文件的 source type）写进结论.md。**层级不要猜**：补丁 zip 里每个 class 的目标路径完全由
      暂存目录里的相对路径推出来 ——
      src/client/*.java → hotwebs/fbip/WEB-INF/classes/…、src/private → modules/<module_name>/META-INF/classes/…、
      src/public → modules/<module_name>/classes/…、src/client 下的非 java 文件 → hotwebs/fbip/WEB-INF/extend/…。
      写错一层，class 就会被打进补丁里错误的位置，部署后加载不到，等于白改。
   b) 要改的文件已在客开工程里：从 {code_directory} 只读地读出它，在 {stageDir} 下按**与工程逐层一致**的
      相对路径建副本（原样保留 src/<client|private|public>/… 这几层，不要自创、不要省掉、不要改名）
      （例如 {code_directory}/src/client/ncbs/x/Foo.java → {stageDir}/src/client/ncbs/x/Foo.java）；
      若工程里同一个类有多份同名文件，以和本次问题同一条调用链上的那份为准，并在结论里说明你选的是哪一份。
   c) 要改的文件在客开工程里**并不存在**（你在新增类/新增文件）：不要去 {code_directory} 找它，
      直接在 {stageDir} 下按它将来在工程里的相对路径新建（目录不存在就一并建出）
      （例如新增 {stageDir}/src/client/ncbs/x/NewHandler.java）；
      相对路径要与工程里**同类既有文件**逐层一致（先去只读地看一眼同类文件摆在哪个包下），
      Java 文件的 package 声明必须与这条路径匹配（javac 与补丁目标路径都看它）。
      若工程里找不到同类先例：把你要放的那一层和判断依据写进结论，不要换一个"看起来更合理"的层级。
   d) 无论改还是新建，都只往 {stageDir} 里写，不要动 {code_directory} 下的任何东西；
   e) 调用 java_compiler_mcp 的 java_generate_patch 生成补丁 zip（参数见第 2a 条那份 SKILL.md）：
      module_path = {stageDir}
      module_name = <你在第 3a 步确定的模块名>
      home        = {package_path}
      files       = 你改过或新建的那些文件（相对 module_path 的路径）
      java_home   = {local_jdk_path}
      产物输出到 {outDir}。打包完**把 zip 里的条目列出来自查一遍**（对照第 3a 条的目标路径），
      发现层级不对就重打包，不要带着错路径交付。
4. 不要求一次就把问题改到位。如果还不能确定根因，或想先看清运行时的实际走向，就在你认为相关的
   代码位置补上详细的日志输出（打印关键入参、分支走向、耗时、捕获到的异常栈等），把下次复现时要看的
   信息打全；这时第 1 步的结论就写"已补日志、待复现反馈"，不要猜一个根因糊弄过去。
   加日志同样算本次改动：文件照 3b/3c 落到暂存目录、并写进 changes.txt，之后会随补丁同步回客开工程。
   日志写法沿用工程自己已有的 logger 与级别约定，不要引入新的日志框架或依赖。
5. 数据库/配置类问题：把对应 SQL 或实现方案写进 {outDir}/方案.txt。
6. 把本次改动的文件清单（每行一个，相对 {code_directory} 的路径；**新增的文件同样要列**）写进 {outDir}/changes.txt。
7. 把结论、模块根路径、module_name、每个文件所属的 source type，以及补丁 zip 的条目清单，
   写进 {outDir}/结论.md。

【约束】
- **绝对不要修改 {code_directory} 下的任何文件**，也不要新建/删除它下面的任何东西。
  （新增的类也一样先建在暂存目录里；阶段二经用户确认后才会把改动同步过去。）
- 不要改动 .git 目录，不要执行 git commit / push / checkout。
- 分析源码走 patch_source MCP，不要试图遍历全树（性能原因，见相关记录）。
- 收尾前在 {code_directory} 执行 git status --porcelain：若输出非空，说明该工程被改动过
  （可能是你、也可能是别的进程），把输出原样贴进结论并说明，**不要自行回滚**。
[数据库**只允许执行查询语句**（SELECT / SHOW / DESC / EXPLAIN 之类只读语句）。     ← 仅当环境登记了
  INSERT / UPDATE / DELETE / DDL / 存储过程 / 加解锁语句**一律禁止**；拿不准算不算写操作就不要执行。   db_connection
  能开只读事务就用 START TRANSACTION READ ONLY 把查询包起来，多一层保险。
  连库优先用本机已有的客户端或驱动（mysql 客户端、带 pymysql 的 python 等）；**不要为此安装任何依赖**，
  连不上就停手，把你要跑的 SQL 原样写进结论，让用户自己执行。
  连接串里通常带账号口令：**不要**把它抄进结论.md / changes.txt / 方案.txt 或任何要上报的文字里。]
[远程调试**只允许线程级**：只挂起/单步你正在看的那一个线程（jdb 用 `suspend <thread-id>`，          ← 仅当环境登记了
  IDE 里把断点的挂起策略设成 Thread / 事件线程），**绝不要挂起整个进程**                              debug_address
  （裸 `suspend`、Suspend All 策略、或不带 suspend=n 重启目标服务）。
  看完就 resume 并断开连接，不要把调试器挂着不放——那台环境可能有人在用。]
```

> **2026-09-21 的三处改动**（用户提的"根据 skill 来编译" + "新增或修改后的代码要按客开工程的结构构建"）：①【环境】多一行 skill 库（选填，登记了才有）；②新增任务第 2 条"先读工具说明书"——编译 MCP 的用法本来就在 `<库>/java-compiler-mcp/SKILL.md` 里写着，此前是在提示词里重造那份文档；③任务第 3 条 a~e 重排，把"按客开工程的结构构建"写死：先只读地定出**模块根**与每个文件的 source type，暂存目录里的相对路径必须与工程**逐层一致**（它决定 `_get_target_path` 推出的补丁内目标路径，写错一层 = class 打进错位置、部署后不生效），新增文件的 `package` 声明要与路径匹配，打完包还要自己列一遍 zip 条目自查。第 2 条的 b 还带了一句防护：**某个 skill 要求的前置 skill 本机不存在时跳过那条要求继续**——`fbip-skill-router` 就硬依赖一个不存在的 `fbip-code-index-analysis`，写成"从 L1 开始跑"会让它卡死在这一步（详见第二十二章）。

数据库那一段（2026-09-20 用户要求补）值得单独说一句：**它是提示词级的"只读"约束，跟 20.13 第 5 条
（越界校验）是同一类东西——没有技术隔离**。真正能兜住的是"用只读账号连"这种环境侧措施，提示词里给的
`START TRANSACTION READ ONLY` 只能算第二层；所以这一段同时写了"连不上就别硬来、把 SQL 交给用户"，把
"宁可不查"作为默认退路。没登记 `db_connection` 的环境整段不出现——否则 claude 会去追问一个不存在的库。

日志原文在提示词里是**整段内联**的，且**不因长度被摘掉**——即使超过 8KB（后端阈值）会把它从
`log_info_inline` 里去掉、导致它在任何地方都不留副本，也必须完整出现在提示词里：它本来就是给 claude
定位问题用的输入。原先还有个"第 7 步：把日志原文保存到 {outDir}/logs.txt"的归档动作，2026-09-20 用户
拍板**去掉**了——那是让 claude 把日志再抄一遍，几万行的日志既费输出 token 又可能抄走样，而它的唯一价值
只是"产物目录里留一份现场"，不如不做（理由详见 20.13 第 6 条）。

第 2b 与第 3 条是 2026-09-20 补的（用户提出）：**要改的文件不一定在客开工程里**（可能是新增类），原来的
写法只覆盖"把已有文件复制到暂存目录再改"，新增类会被卡在"读不到源文件"；**也不要求一次改到位**——定位不
到根因时允许先补详细日志、等用户拿着日志复现反馈，所以第 1 条的"先给出简短分析"后面跟了"证据不足就如实
说明"。补日志产出的文件同样是改动，照 2a/2b 落暂存目录并进 `changes.txt`，否则下次合并会把它漏在暂存目录里。

第 1 条后半段"**方案有多个就自己挑一个最合适的**、不要停下来等用户选"也是 2026-09-20 加的用户要求：这是一条
**减少往返**的指令——阶段一是无人值守跑完的（用户不在旁边答问题），让 claude 停在"请问您想用哪种方案"就是
白等一轮；配套要求它在结论里写清"选了哪个、为什么、放弃了什么"，避免选择变成黑箱。

**阶段二（同步回客开工程，仍在该会话）**，另发一个 user prompt：

```text
用户已确认问题已解决。
1. 读取 {outDir}/changes.txt。
2. 把其中列出的文件，从 {stageDir} 复制回 {code_directory} 的对应相对路径（覆盖）。
   清单里在客开工程中还不存在的（新增的类/文件）同样按相对路径建出来，目录不存在就一并建出。
3. 若某个**已存在**的目标文件在此期间被改动，导致内容与 {stageDir} 中的基线不一致，**停止并报告**，
   不要覆盖，也不要尝试自动合并；新增文件若该路径已被别人创建出来，同样停止并报告。
4. 把同步结果写入 {outDir}/合并说明.md，并且**第一行固定写成**「结果：成功」或「结果：冲突」，
   后面再写详细清单。
```

第 4 步那个"固定第一行"是**判据**，不是文风要求：cc-web 不参与搬运，唯一的成功/冲突信号就是 claude 写的这份文件，
前端用正则 `/结果\s*[:：]\s*(成功|冲突)/` 解析它 → 落 `verdict=solved|unsolved`、`status=solved|merge_failed`。
解析不到（文件没写/写错/读不到）**一律按未成功处理**，让用户用 `git status/diff` 自己核对——宁可漏报成功，不可谎报已解决。

**模块根与 `module_name`**（`java_generate_patch` 的 `module_path` 要的是**模块根**——含 `src/client|private|public` 的那一层，不是仓库根；`module_name` 对 `src/private`、`src/public` 的目标路径映射是必需的，见 `_get_target_path`）：

- v1 方案：表单不加这两个字段，由 claude 在 `code_directory` 内自行判断，并把它用的 `module_name` / 模块根路径写进 `结论.md`；判断错时用户可在下一条消息里纠正（会话延续，不需要重跑）。

### 20.13 七个必须处理的实现约束

1. **SSE 无重放**：`/api/agent/{id}/events` 只做 `tx.subscribe()`，没有历史回放（`agent.rs:1113-1203`）。所以顺序必须是**先建 `EventSource` 并等到 `connected` 事件，再调 `/api/agent/{id}/start`**；反过来会丢开头的事件。
2. **`/start` 无并发保护 → 要加守卫（已拍板）**：`start_prompt` 无条件往 `streaming_sessions` 插入（`agent.rs:404`），连点两次会**在同一个 stageDir 上跑两个 claude 进程**，两边同时改同一批文件。两层防护一起做：
   - 前端：发起的瞬间 disable 按钮，直到收到 `result`/`error` 事件或用户点「中断」才恢复；
   - 后端：在 `start_prompt` 进入流式之前先查 `data.streaming_sessions.read().unwrap().contains(&session_id)`，命中则直接返回 **409**（该会话正在执行中），不 spawn。收益是防御一切并发入口（含用户手工重放请求、多标签页）。
3. **菜单不走 patch_search**：把 `node` 加进 `PATCH_MENU_KEYS`（`patches.js:91`）就会需要服务端下发 `menus`，即要改 `menu_service.MENU_CATALOG` 并**部署 patch_search**。v1 直接**默认可见**、**不进 `PATCH_MENU_KEYS`**——参照 `menus` 页签的先例（它是硬编码 admin-only、刻意不进清单，`patches.js:89/:113`）。这样前端可独立发布，零服务端依赖。
4. **`java_generate_patch` 要模块根 + 只编译改动文件**：`module_path` 传 **stageDir**（它镜像的是模块结构），不是仓库根；`home` 必须传环境的 `package_path` 否则类解析不了；产物是编译后的 `.class`（zip 内含 `hotwebs/fbip/WEB-INF/classes/...` 或 `modules/<module_name>/...` 结构），不是源码——别把它当成"源码补丁"来解析。
5. **越界校验由 claude 自己跑（已拍板）**：**浏览器跑不了 shell 命令**，cc-web 也没有"在某个目录执行 git"的接口。所以不新增后端接口，而是把这条写进**阶段一的提示词**（20.12 最后一条约束）：claude 收尾前在 `code_directory` 执行 `git status --porcelain`，非空就把输出原样贴进结论并说明，**不自行回滚**（见 20.5；用户此时可能也在改同一个工程）。代价是"校验由被监督者自己执行"——它是提示词级约束，与 20.16 说的"没有技术级隔离"是同一件事，不是新增缺口；好处是零后端改动。
6. **浏览器不能写文件**：`合并说明.md`（阶段二第 4 步）必须由 **claude 落盘**，前端只负责事后用 `GET /api/files/{path}` 读回来展示。同理，`changes.txt` 在点「已解决」前是前端**读出来给用户看**（20.11 的二次确认），不是前端写的。

   这条对**日志**的结论（2026-09-20 拍板）：日志原件是用户粘进表单的文本，它**在提示词里已经整段给了 claude**，那就是它定位问题用的形态；**不再要求 claude 抄一份到 `<outDir>\logs.txt`**。原因：cc-web 全库只有 `/api/files*`（只读 GET）与 `/api/node/runs/{id}`（只写它自己的 `~/.cc-web/node_runs.json` 账本）两个端点，**没有任何通用写文件接口**，所以"日志在补丁输出目录里留个原件"这件事只能借 claude 的手写——而 claude 抄写要付与日志长度同阶的输出 token，几万行的日志还可能抄截断/抄走样，换来的只是"产物目录自解释"这一点边际价值，不值。**后果要认**：日志除提示词外只剩 `log_info_inline` 一份（≤8KB 才有），**超 8KB 的日志哪里都不存**；要留档请用户自己存原始日志文件。

7. **数据库"只读"没有技术隔离（2026-09-20 用户要求提供 DB / 调试口）**：环境条目里登记了 `db_connection` 时，提示词会把连接串给 claude 并**要求它只执行 SELECT/SHOW/DESC/EXPLAIN 一类只读语句**，同时建议用 `START TRANSACTION READ ONLY` 包住查询。但这跟第 5 条一样是**提示词级约束，不是技术隔离**——claude 手里是 `bypassPermissions` 的 shell，真要写库没人拦得住。真正兜得住的只有环境侧措施：**给一个只读账号**（`GRANT SELECT ON ...`）。所以这一段同时写了"**不要为此安装任何依赖**"（避免它 pip install 一堆东西）和"**连不上就停手、把 SQL 原样交给用户**"（宁可少查，不可乱写）。`debug_address` 那条则是**线程级调试**约束（2026-09-20 用户要求）：只挂起/单步正在看的那一个线程，**绝不允许挂起整个进程**（裸 `suspend`、Suspend All 策略、或不带 `suspend=n` 重启目标服务），看完 resume 并断开。理由是那台环境**可能有人在用**——挂起整个 JVM 等于把别人的环境停了。这同样是提示词级约束，技术侧没有拦截。

   两个字段都**只在环境里登记了才出现**，且**都不参与上报**：`patchNodePushReport` 是白名单（20.8 那几列），`env_snapshot` 整体不发送；`db_connection` 含账号口令，唯一多出来的副本是本机 `node_runs.json`（见 20.7 的说明）。

### 20.14 「已解决」阶段的合并语义（读法二）

- 合并**由 ClaudeCode 执行**（阶段二提示词），cc-web 不做文件搬运。
- 合并内容 = `stageDir` 里被改动的文件 → 复制回 `code_directory` 对应相对路径；**zip 补丁包不参与合并**，它是给部署用的（只含改动的 class）。
- 冲突处理：目标文件在阶段一之后被改动过 → 停止并报告，**不覆盖、不自动合并**（提示词已约束）。
- **已知风险**：`changes.txt` 由 claude 自己在阶段一写出，理论上可能漏写或写错文件。
  缓解措施：
  1. 点「问题已解决」前把 `changes.txt` **展示给用户确认**；
  2. 合并完成后在 `合并说明.md` 里列出实际复制的文件；
  3. 读法二下被改的是**客开工程源码**（多数是 git 仓库），所以**用户可用 `git status/diff` 直接核对与回退**——这是读法二相对"直接覆盖打包目录"的最大安全垫。
- 合并失败（含冲突）→ 本地 `phase=failed`、服务器 `status=merge_failed`，产物与 stageDir 全部保留，可手工处理（或按 20.19 的说法：暂不做重跑）。

### 20.15 与「继续会话」的复用（第十八章）

运行列表的「继续会话」直接复用第十八章已有的跳转协议：

```js
location.href = `index.html?resume=1&sid=${encodeURIComponent(agent_session_id)}&cwd=${encodeURIComponent(code_directory)}`;
```

注意 `cwd` **必须传 `code_directory`**（就是阶段一/阶段二的 cwd，不要传 stageDir 或 outDir）——因为 `--resume` 与 cwd 强绑定（20.5），传错目录会 `No conversation found`。这也是服务器表里 `claude_session_id` 只能在**原机器**使用的原因。

### 20.16 已知限制

- 换机后：运行态不可用（「已解决」点不动、「继续会话」失效），只有服务器摘要与 `outDir` 产物可读。这是设计取舍，不是缺陷（见 20.6）。
- `outDir` **由用户必填、没有默认值**（已拍板），所以它放在工程外时产物就不随 git 走。页面需在输入框下方给一句提示："填在客开工程目录内可随 git 一起保存"，但**不代为选址、不自动填**。
- 「只读」是提示词约束 + 事后 `git status` 校验，**没有技术级隔离**（cwd 必须是真实工程，换 cwd 会破坏 resume，是硬约束）。越界修改只报警、不自动回滚（用户可能同时在改）。
- 编译只能验证"改动的这几个文件能过 javac"，**不能验证跨文件运行时语义**，也不跑单测。

### 20.17 验收

- 新建 run → `~/.cc-web/node_runs.json` 出现该条，`phase=analyzing`；`GET /api/problem-runs` 能查到对应行（`status=running`）。
- 流式区能实时看到过程；执行结束后出现两个按钮，`phase=awaiting_decision`。
- 产物齐备：`outDir` 下有 zip（代码类）或 `方案.txt`（配置类）、`changes.txt`、`结论.md`。
- 点「问题未解决」→ 本地 `verdict` 落定、服务器 `status=unsolved`；`outDir` 不被改动。
- 点「问题已解决」→ **同一个 claude 会话**继续（能引用阶段一的上下文，问"你上一步改了什么"答得出）→ `code_directory` 下对应文件内容更新、`outDir/合并说明.md` 生成、服务器 `status=solved`。
- 冲突场景：合并前手工改动目标文件 → claude 停止并报告，`status=merge_failed`，目标文件**未被覆盖**。
- **阶段一期间 `code_directory` 始终干净**：run 跑到 `awaiting_decision` 时，在 `code_directory` 跑 `git status --porcelain` 应无输出；改动只出现在 `stageDir`。
- **越界报警**：手工制造一次越界（让 claude 直接改 `code_directory` 里的文件）→ 流式输出区能看到 `git status --porcelain` 的非空输出与说明，且**没有**发生自动回滚（见 20.13 第 5 条：这条校验由 claude 自己执行并报告）。
- zip 只含改动文件：解压补丁包，里面的 class 应当只有 `changes.txt` 列出的那几个（不是整模块）。
- 把 patch_search 停掉：仍能完整跑完一个 run（上报失败静默），`reported:false`；恢复后进入页签自动补报成功。
- 换一台机器打开同一账号：列表能看到服务器摘要行，显示「仅存档」，操作列禁用，`client_host` 显示原机器名。
- 连点两次「开始执行」不会起两个进程：按钮已 disable；后端守卫命中时第二次请求返回 409（用 `curl` 手工重放 `/api/agent/{id}/start` 验一次）。
- 回归：`智能开发`/`普通检索` 等既有页签不受影响；`GET /api/project-envs` 等既有接口行为不变。

### 20.18 已拍板的取舍

| 事项 | 结论 |
|---|---|
| `outDir` 默认值 | **不设默认值**，用户必填（只校验非空 + 绝对路径） |
| `/api/agent/{id}/start` 并发守卫 | **加**（前端 disable + 后端 409，见 20.13 第 2 条） |
| 「重跑」按钮 | **不做**（要再做一次就新建 run） |
| 管理员查看全部 | **不做**，本表只有"自己看自己" |
| cwd / 改动落点 | cwd = `code_directory`（claude 就在客开工程干活）；**不复制整仓**，改动只落 `stageDir`，已解决才同步回 `code_directory`（见 20.5） |

### 20.19 仍需确认的一点

**`module_name` 与模块根的判定**（20.12 末尾）：v1 让 claude 自己判断、写进 `结论.md`。如果实际用起来发现它经常判错，再考虑把"模块根相对路径 + module_name"加成产品环境变量的字段（那是改 `project_environment` 表，要部署后端）。**开工前不需要拍板，跑一轮看结果即可。**

### 20.20 落地顺序

1. **patch_search**：新建 `schema/migration_problem_run.sql`（照 `migration_*.sql` 的 `information_schema` 判存在 + `PREPARE/EXECUTE/DEALLOCATE` 幂等写法），同步 `schema/current_schema.sql`；新增 `app/routes/problem_runs.py` + 注册；在库上手工执行迁移；按既定方式**直调 PyInstaller** 重新打包（**不要用 `build.bat`**，它会删掉 `dist` 里的 `config.yaml`/`data`/`logs`）并部署。
2. **cc-web**：`src/main.rs` 加 `node_runs.json` 载入/落盘；新增 `src/api/node_runs.rs` 三个接口（`GET` 附带本机 `host`，见 20.7）；`src/api/agent.rs` 的 `start_prompt` 加并发守卫（20.13 第 2 条）；`src/ai/streaming.rs` 的 `start` 事件补 `agentSessionId`（1 行，见 20.4）；`static/patches.html` 加左侧导航项 + `data-tab="node"` 页签 + `patchTabNode` 面板（表单/流程区/运行列表）；`static/patches.js` 加 `loadProblemRuns`、`patchSwitchTab` 的分支、两阶段提示词与 `fetch('/api/agent/*')` 调用、`EventSource` 时序（先 connected 再 start）。
3. **构建与分发**：`cargo build --release`（先停掉正在运行的 `cc-web.exe`，否则 os error 5）→ 覆盖 `D:\project\cc-web-dist\cc-web.exe`。`static/*` 是 `include_str!` 编译期内嵌，**改前端必须重编**。
4. 建议拆两批：先做「本地 run 清单 + 单机全流程（含合并）」，跑通后再接服务器上报；上报是纯加法，可后置。

**落地状态（截至 2026-09-20）**：上面第 2、3 步已完成——cc-web 全部改动已落盘、`cargo build --release` 通过、`cc-web-dist\cc-web.exe` 已覆盖（4,751,872 字节，2026-09-20 11:24）。
本机冒烟已过：`GET /api/node/runs` 回 `{"code":0,"data":[],"host":"DESKTOP-KNK159N"}`（`host` 生效）；`PUT`/`GET`/`DELETE` 往返一致，`~/.cc-web/node_runs.json` 落盘并回空；`/patches.html` 与 `/patches.js` 内嵌版本均为新版（含 `data-tab="node"`、`patchNodeRunForm`、`本地jdk路径`，`colspan` 与 10 个 `<th>` 对齐）。

剩下的都在你的部署动作里：

1. ✅ **已在库上执行完（2026-09-20）**：`schema/migration_problem_run.sql` 已在 `10.4.122.21:3306/patch`（MySQL 8.0.12）执行，`problem_run` 已建（18 列 / PRIMARY + `uk_problem_run_local_id` + `idx_problem_run_owner_time` + `fk_problem_run_owner → user_account(id)`），`SHOW CREATE TABLE` 与 `schema/current_schema.sql` 的块**逐行一致**（规范化空白/反引号后 23 行全等），幂等重跑无报错，表内 0 行。另用一个 `INSERT` + `ROLLBACK` 的事务验证过路由要写的全部字段（含默认 `status=running`、`created_at`/`updated_at` 自动值、外键）能落得进去，没有留下任何数据。
2. `local_jdk_path` 那个迁移 `schema/migration_project_environment_local_jdk.sql` **2026-09-18 已经在库上执行并验证过**——本次复查确认该列存在（`varchar(1024) NULL`，位置在 `local_skill_path` 之后），**不用再跑**。它缺的不是 DDL，而是**服务端代码还没上线**：本次新打的包里已带这列，上线后 `GET /api/project-envs` 才会开始返回它。
3. ✅ **新 exe 已打好（2026-09-20 14:17，第二次重打）**：`dist\patch_search.exe`（27,522,778 字节，md5 `92d9f7b8a51904957ee212f32f5e8062`）。第一次（13:50，md5 `b79bf695…`）之后你又把 `local_jdk_path` 改成了**必填**（`app/schemas.py` 的 `local_jdk_path: str = Field(min_length=1, max_length=1024)` + `project_env.py` 的 `REQUIRED_LABELS` 多一项 + `patches.html` 表单加 `required`），所以重打了一次。旧 exe 备份为 `patch_search.exe.bak-20260920`。**`dist\patch_search.zip` 按既定约定没动**（仍是 9-18 那份、里面是旧 exe），`dist\config.yaml`/`data`/`logs` 也一个字节没动——走的是直调 PyInstaller + 临时 `--distpath`，没碰 `build.bat`。**本机冒烟已过**（起的是打好的 exe）：`/openapi.json` 里 `/api/problem-runs`(GET/POST) 与 `/api/problem-runs/{local_run_id}`(GET/DELETE) 都在、POST 的 body 引用 `ProblemRunUpsert`，`ProjectEnvCreate`/`ProjectEnvUpdate` 的 required 里含 `local_jdk_path`，`/api/health` 200。
4. **剩下只有上线**：把新包换到服务器上重启。不换的话 `POST/GET /api/problem-runs` 不存在——页面仍能跑，但上报会静默失败（20.10），列表只剩本机清单。
   顺带一个**与本次改动无关**的观察：仓库里的 `dist\config.yaml`（8-12 那份，1.5 KB）**没有 `mcp:` 段**，用它起包时 13589 端口不会监听。若服务器上那份配置也是这个，MCP 源码检索就是没开的——按需自查，我没动这个文件。
5. 前端节点页签**刻意没进 `PATCH_MENU_KEYS`**（20.13 第 3 条），所以**默认可见**、不需要 patch_search 下发菜单；若将来要把它做成可授权菜单，那时才需要改 `menu_service.MENU_CATALOG`。

## 二十一、macOS：编译 MCP 怎么用（patch_search 部分仅作参考）

> **范围（2026-09-21 明确）**：patch_search 与源码检索 MCP **只部署在一台 Windows 服务器上，不在 Mac 上跑** —— 所以 **21.1~21.3 的 patch_search mac 打包暂时不用做**，留在本章只作参考（哪天真要搬再用）。当前唯一要落地的是 **21.4：让编译 MCP（`java_compiler_mcp`）在 macOS 上可用**。为什么是它：编译 MCP 跑在**每个开发者自己的机器**上（它要调本机 JDK 编译客开工程），而 Windows 打包出来的 `.exe` 在 Mac 上跑不了，PyInstaller 又不能交叉编译 —— 只能在 Mac 上重新打一份，或让那台 Mac 直接跑源码。**想直接看怎么做，跳到 21.4。**

### 21.1 为什么单开一章（下三节都只针对 patch_search）

- **PyInstaller 不能交叉编译**：Windows 上打不出 mac 包、mac 上也打不出 exe。要在 Mac 上跑，就得在 Mac（或用 GitHub Actions 的 macOS runner）上打。
- 仓库里**已经有 mac 的三件套**（2026-09-01 加的）：`patch_search_mac.spec`、`build_mac.sh`、`.github/workflows/build-mac.yml`。但它们是**在 MCP 源码检索并进 patch_search 之前写的**（MCP 是 9-17 才进来，Windows 的 `patch_search.spec` 里那套 `collect_all("mcp")` 就是那时补的），所以 **mac spec 缺 MCP 的收集项**：照它直接打出来的包，一旦 `mcp.enabled: true`，`app.mcp.server` 导入会失败（`run_server.py` 只打印"MCP 服务构建失败，已跳过"），**MCP 静默不可用**。21.3 第 2 步必须先补这一块。
- 另外 mac spec **不带 ripgrep**（`binaries=[]`），Windows spec 会带上 `vendor/rg.exe`。Mac 上要么 `brew install ripgrep` 再在 config 里指 `mcp.rg_path`，要么也往 spec 里加几行（21.3 第 2 步给了代码）。

### 21.2 前置条件

| 项 | 要求 / 命令 | 说明 |
|---|---|---|
| macOS | Apple Silicon 或 Intel | **打出来的包只跑同架构**：arm64 包在 Intel Mac 上跑不了（反向也一样）。目标机是哪种就在哪种上打；CI 那套已经拆了 `macos-14`(arm64) / `macos-15-intel`(x86_64) 两个 runner |
| Python | 3.11（最低 3.10） | `brew install python@3.11`。`build_mac.sh` 会校验 `<3.10` 直接退出 |
| 编译链 | `xcode-select --install` | PyInstaller 需要 clang/gcc 链 |
| ripgrep（只有用 MCP 才要） | `brew install ripgrep` | 见 21.3 第 2 步 |
| 7-Zip（只有要解 RAR5 补丁才要） | `brew install sevenzip` | 纯 Python 的 rarfile 解不了 RAR5；配 `archive.rar_tool_path`（Apple Silicon 是 `/opt/homebrew/bin/7zz`，Intel 是 `/usr/local/bin/7zz`） |
| claude CLI（只有管理员补丁分析才要） | 装好并在 PATH 里 | 配 `claude.cli`，Apple Silicon 上通常就是 `claude` |

> ⚠️ **一个 venv 装不下两个包**：patch_search 要 `mcp==2.2.0`（`requirements.txt`），而**编译 MCP 要 `mcp>=1.30,<2`**（它 import 的是 `mcp.server.fastmcp`，2.x 已改名成 `mcp.server.mcpserver`）。同一台 Mac 上要打这两样，就用**两个 venv**，别混装。

### 21.3 patch_search 打包步骤（命令级）

**第 1 步：取代码**

```bash
git clone <仓库地址> patch_search && cd patch_search   # 或直接 scp 一份过去
```

**第 2 步：先把 mac spec 补上 MCP 收集项（否则白打）**

打开 `patch_search_mac.spec`，把头部的 `hiddenimports` 段改成下面这样（新增的都是照 `patch_search.spec` 抄的，注释在那边有详细理由）：

```python
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

hiddenimports = []
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("argon2")
hiddenimports += collect_submodules("aiomysql")
hiddenimports += ["pymysql", "pymysql.converters", "pymysql.cursors"]

# 新增：MCP 源码检索（app/mcp/）的收集项。下面两处必须在收集时挡掉，否则一 import 就把整个打包炸掉：
#   mcp.cli              —— 依赖 typer（mcp 的 [cli] extra），导入失败会 sys.exit(1)
#   mcp.server.fastmcp   —— mcp 2.x 里这个模块名已废弃，导入时故意抛 ModuleNotFoundError
def _keep_submodule(name: str) -> bool:
    return name not in ("mcp.cli", "mcp.server.fastmcp")

datas = []
binaries = []
for package in ("mcp", "mcp_types"):
    package_datas, package_binaries, package_hidden = collect_all(
        package, filter_submodules=_keep_submodule, on_error="ignore"
    )
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden
hiddenimports += collect_submodules("sse_starlette")
hiddenimports += collect_submodules("jsonschema")
hiddenimports += collect_submodules("opentelemetry")

# ripgrep：MCP 的检索引擎。mac 上先 brew install ripgrep，再把二进制拷一份到 vendor/rg：
#   cp "$(which rg)" vendor/rg
# 不想让它进包就删掉这几行，改为在 config.yaml 里配 mcp.rg_path。
rg_path = os.path.join(SPECPATH, "vendor", "rg")
if os.path.isfile(rg_path):
    binaries.append((rg_path, "vendor"))
```

并把下面 `Analysis(...)` 里的两处接上（原值是 `binaries=[]` / `datas=[]`）：

```python
a = Analysis(
    ["run_server.py"],
    pathex=[os.path.abspath(SPECPATH)],   # 注意：Windows 的 spec 这里写死了 "D:\\project\\patch_search"，mac 上必须用 SPECPATH
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    ...
)
```

**第 3 步：建 venv、装依赖**

```bash
cd patch_search
python3.11 -m venv .venv-mac
source .venv-mac/bin/activate
python -m pip install --upgrade pip
# --prefer-binary：尽量用预编译 wheel；cryptography 之类一旦走源码编译要 Rust+OpenSSL，很慢还可能失败
python -m pip install --prefer-binary -r requirements.txt pyinstaller
```

**第 4 步：清旧产物后打包**

```bash
rm -rf build dist
python -m PyInstaller --clean --noconfirm patch_search_mac.spec
```

> `build_mac.sh` 就是把第 3、4 步合起来跑，并且开头会 `rm -rf build dist`。**别把 config.yaml / data / logs 放进 `dist/`**——那个 `rm -rf` 会一起删掉（与 Windows 上不要用 `build.bat` 是同一个坑）。
> 只有在需要**同时支持 Intel 与 Apple Silicon** 时才加 `--target-arch universal2`（要求 Python 本身是 universal2 版，Homebrew 默认不是）；一般不必。

**第 5 步：冒烟（别跳过；先在终端里跑一次，不要双击）**

```bash
cd dist
cp ../config.mac.example.yaml ./config.yaml   # 改成真实数据库/路径/token
./patch_search.app/Contents/MacOS/patch_search     # 直接跑二进制，日志就在这个终端里
# 另开一个终端：
curl -s http://localhost:13587/api/health
curl -s http://localhost:13587/openapi.json | python3 -c "import sys,json;print('/api/problem-runs' in sys.stdin.read())"
# 用到 MCP 时确认第二个监听起来了（没起会有 "[patch_search] MCP 服务构建失败，已跳过：…" 这一行）
curl -s http://localhost:13589/mcp -H 'Authorization: Bearer <mcp.token>' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**第 6 步：过 Gatekeeper（未签名一定会被拦）**

```bash
xattr -dr com.apple.quarantine patch_search.app
# 或 Finder 里右键 → 打开 → 再点「打开」
```

**第 7 步：放 config.yaml（查找顺序要记住）**

`find_config_path()`（`app/config.py:21`）在**打包后（frozen）**且 `sys.platform == "darwin"` 时的顺序：

1. **`.app` 所在的外层文件夹**（`Path(sys.executable).parents[3]`，即 `patch_search.app` 的上一级）—— 推荐放这里，与 Windows「config 放 exe 旁边」的体验一致
2. `~/patch_search/config.yaml`
3. `Contents/MacOS/`（`sys.executable` 所在目录，用户不便编辑）
4. 当前工作目录

也可用 `PATCH_SEARCH_CONFIG=/绝对路径/config.yaml` 显式指定。

**第 8 步：打包分发 zip**

```bash
cd ..
# -y 必须加：.app 里的 Framework 目录带符号链接，不加会把链接解引用、包就坏了
zip -r -y -X patch_search-mac-arm64.zip patch_search.app config.mac.example.yaml
```

分发时提醒对方：mac 那份 `config.mac.example.yaml` **没有 `mcp:` 段**（截至 2026-09-21）——要用源码检索 MCP，就照 Windows 的 `config.yaml` 补上 `enabled/host/port/path/token/rg_path/roots/limits` 整段，否则 13589 不监听。

**（可选）不本机打，用 CI**：`.github/workflows/build-mac.yml` 已就绪（`workflow_dispatch` 手动触发，或推 `v*` tag），产出两个架构的 zip artifact；它跑的就是 `patch_search_mac.spec`，所以**第 2 步的 spec 补丁必须先提交上去**，否则打出来的包没有 MCP。

### 21.4 编译 MCP（java_compiler_mcp）在 macOS 上可用 —— 当前唯一要做的事

Windows 侧是 `build-mcp.ps1` 打出 `dist_onedir/java_compiler_mcp/java_compiler_mcp.exe`。那个 exe 在 Mac 上跑不了（PE 二进制），而 PyInstaller **不能交叉编译** → 必须在 Mac 上重新打一份。两条路任选：

- **路线 A：Mac 上装 Python，直接跑源码。** 最省事（开发机本来就要装 JDK，多一个 Python 不难），冷启动和手工跑 `.py` 一样快，改代码也不用重打包。
- **路线 B：打成 onedir 可执行文件。** 那台机器不想留 Python、或要把包分发给别人时用。

**仓库里已经备好两样（2026-09-21）**，都在 `D:\project\mcpadd\`：

| 文件 | 是什么 |
|---|---|
| `java_compiler_mcp_mac.py` | macOS/Linux 移植版，74,615 字节，md5 `f2b3f4f17baaf09d8facafa0cf187cd6`。与 Windows 那份 `java_compiler_mcp.py`（78,116 字节）是**同一份代码的两个平台移植，七个工具与参数语义完全一致**；差别只在：javac 走 `bin/javac`（无 `.exe`）、用 `os.access(X_OK)` 判可执行、坏链接按 symlink 判、npm 用 `shutil.which` 找、默认 JDK 候选路径换成 `/Library/Java/...` 与 Homebrew 那几个。**别用 Windows 那份** —— 它找 `javac.exe`、用 `GetFileAttributesW` 判 junction，在 mac 上直接失败。 |
| `build-mcp-mac.sh` | `build-mcp.ps1` 的 macOS 版，一条命令做完「建 venv → 装依赖 → onedir 打包 → MCP 握手冒烟 → 清 quarantine」。 |

**路线 B：跑打包脚本**

```bash
# 把 mcpadd 整个目录拷到 Mac（拷之前先删掉 Windows 留下的 .venv、build*、dist*，
# 免得把 Windows 的解释器和陈旧产物一起带过去）
cd mcpadd
chmod +x build-mcp-mac.sh
./build-mcp-mac.sh
# 想指定解释器：PYTHON=/opt/homebrew/bin/python3.12 ./build-mcp-mac.sh
```

脚本做的事（与 PowerShell 那份逐条对应）：

1. **选解释器**：`$PYTHON` → 否则 `.venv-mac/bin/python3` → 都没有就用 `python3 -m venv .venv-mac` **现建一个**（这样就避开了新版 macOS / Homebrew 往系统 Python 装包被拒的 `externally-managed-environment`；Windows 那份用的是 `.venv/Scripts/`，所以 mac 版另起 `.venv-mac`，两个环境不会互相踩）
2. `pip install --quiet "mcp>=1.30,<2" pyinstaller` —— **版本必须 `<2`**：2.x 把 `mcp.server.fastmcp` 改名成了 `mcp.server.mcpserver`，而这个脚本 import 的是老路径。（patch_search 要的正好相反 `mcp==2.2.0`，所以要用两个 venv，见 21.2 那个提示。）
3. `python -m PyInstaller --onedir --console --name java_compiler_mcp --distpath dist_onedir --workpath build_onedir --specpath build_onedir --noconfirm java_compiler_mcp_mac.py`
   —— `--name` 与源文件名**故意不同**：源是 `_mac` 那份，产物仍叫 `java_compiler_mcp`，两个平台的目录布局就一致了。
4. **冒烟**：起进程做 `initialize` + `tools/list` 握手，**应回 7 个工具**（java_compile / java_run / java_scan_home / java_clear_cache / java_generate_patch / java_apply_patch / frontend_build_patch）；不是 7 个就中止，不打这个包。
5. `xattr -dr com.apple.quarantine` + `chmod +x`，最后把注册命令打印出来。

理由与 Windows 完全一样，**onedir 不要 onefile**：onefile 每次启动都要把整个 bundle 解压到临时目录，冷启动 4~6s；onedir 不用解压，1.1~1.3s。而 Claude Code 每个 claude 进程起一个 MCP 子进程，cc-web 又是每条用户消息起一个 claude 进程 —— 这笔开销每条消息都付一遍。产物是 `dist_onedir/java_compiler_mcp/`（可执行文件 `java_compiler_mcp` + `_internal/`），**必须整个文件夹一起拷**。

> ⚠️ **产物的架构 = 用来打包的那个 Python 的架构**（arm64 的 python 出 arm64 包）。要在 Apple Silicon 上分发，就别在 Rosetta 的 x86_64 python 里打。

**注册进 Claude Code**

Claude Code 自己用（不经过 cc-web 时）：

```bash
# 路线 B：注册打出来的可执行文件
claude mcp add java_compiler_mcp "/绝对路径/dist_onedir/java_compiler_mcp/java_compiler_mcp"
```

**路线 A：直接跑 `mcpadd/add_mcp.sh`** 就行（2026-09-21 改过：mac/Linux 上它会自动挑 `java_compiler_mcp_mac.py`、解释器优先用 `.venv-mac/bin/python3` 再退到 `python3`；Windows/Cygwin 上仍用 `java_compiler_mcp.py` + `python`）。手工等价的命令：

```bash
claude mcp add java_compiler_mcp python3 "/绝对路径/mcpadd/java_compiler_mcp_mac.py"
```

若这台 Mac 上也跑 cc-web，就登记进 `mcp-servers.json` —— 相对路径的基准是 **cc-web 可执行文件所在目录**（`mcp_config.rs` 的 `base_dir()`），保持与 Windows 相同的相对布局，只是 mac 上没有 `.exe` 后缀：

```json
{
  "mcpServers": {
    "java_compiler_mcp": { "type": "stdio", "command": "java_compiler_mcp/java_compiler_mcp" }
  }
}
```

（前提是把 `dist_onedir/java_compiler_mcp/` 放到 cc-web 可执行文件旁边。`patch_source` 那条 HTTP + Bearer token 的写法不变。）

> ⚠️ 未签名的可执行文件被 Gatekeeper 拦时，**表现是 cc-web 起来后 MCP 静默不加载**，界面上完全看不出来（与 Windows 上不设 `CC_WEB_MCP_CONFIG` 那个坑同类）。装完先在终端里手动跑一次那个可执行文件，确认不弹「无法打开」。

**别忘了 `java_home` 要指到 Mac 上的 JDK**：`java_home` 是**每次工具调用的入参**、不是配置文件里的项 —— 就是产品环境变量里「本地jdk路径」那一列（`local_jdk_path`，见 20.11 的节点表单与 20.12 的提示词）。mac 上是 `/Library/Java/JavaVirtualMachines/<jdk>.jdk/Contents/Home`（用 `/usr/libexec/java_home -V` 列出来）。Apple Silicon 上要用 arm64 的 JDK。

### 21.5 验收清单（mac）

**编译 MCP（本次要做的）**

- [ ] `build-mcp-mac.sh` 跑完最后一行是 7 个工具（`tools -> 7: java_compile, java_run, …`）
- [ ] 手动跑一次 `dist_onedir/java_compiler_mcp/java_compiler_mcp`，不弹「无法打开」（= Gatekeeper 已放行）
- [ ] `claude mcp list` 里有 `java_compiler_mcp`；真跑一次 `claude -p "调用 mcp__java_compiler_mcp__java_scan_home 扫一遍 <某个 home> 并原样输出"` 能回真结果
- [ ] 若走 cc-web：`~/.cc-web/mcp-servers.resolved.json` 里拼出来的路径是对的（点开看一眼，别只看日志）
- [ ] `java_home` 在产品环境变量「本地jdk路径」里登记了，且指向的是**这台 Mac 上**的 JDK 根目录

**patch_search（仅参考，当前不用做）**

- [ ] `patch_search.app` 在目标架构的 Mac 上能起，窗口里有 `[patch_search] 补丁检索服务 … 监听地址 http://0.0.0.0:13587`
- [ ] `curl -s localhost:13587/api/health` 200；`/openapi.json` 里能看到 `/api/problem-runs`
- [ ] `mcp.enabled: true` 时**没有** `MCP 服务构建失败，已跳过` 这行；13589 的 `tools/list` 能回 6 个工具
- [ ] 直接跑 `./patch_search.app/Contents/MacOS/patch_search` 时，日志里的 `配置文件:` 指到你想要的那份（位置放对了）
- [ ] 从 Finder 双击（不是终端跑）也起得来（= Gatekeeper 已放行）

### 21.6 mac 特有的坑（都踩得上）

**打包/分发编译 MCP 时**

1. **架构不匹配是第一高频失败**：包能起但立刻崩，或报 `mach-o file, but is an incompatible architecture` —— 在 Rosetta / x86_64 python 下打的包在 Apple Silicon 上跑不了（反之亦然）。产物的架构取决于**用来打包的那个 Python**，用 `python3 -c "import platform;print(platform.machine())"` 确认。
2. **单个文件拷过去 = 打开就崩**：onedir 的可执行文件与同目录的 `_internal/` 是一体的，必须**整个文件夹**压缩分发。只拷那个可执行文件是最常见的错。
3. **解压后丢掉可执行位 / 被杀**：`killed: 9` 或「无法验证开发者」。先 `xattr -dr com.apple.quarantine <文件夹>`；还不行就在目标机上 `codesign --force --deep --sign - <文件夹>/java_compiler_mcp` 做一次 ad-hoc 重签（PyInstaller 打的包本来带 ad-hoc 签名，经压缩/解压/某些拷贝工具后签名可能失效）。
4. **`mcp` 版本必须 `<2`**：这个 MCP import 的是 `mcp.server.fastmcp`，2.x 已改成 `mcp.server.mcpserver`，升上去直接 `ModuleNotFoundError`；而 patch_search 要 `mcp==2.2.0` —— 一台机器两个 venv，别混装。
5. **`java_home` 是每次调用的入参**，不会从别处读配置：Mac 上的 JDK 路径必须逐台登记在产品环境变量的「本地jdk路径」里，Apple Silicon 上要用 arm64 的 JDK。

**打包/分发 patch_search 时（本章 21.1~21.3 若启用才相关）**

6. **mac spec 与 windows spec 不同步**：MCP 的 `collect_all` 只在 windows spec 里、ripgrep 的 `binaries` 只在 windows spec 里、`pathex` 在 windows spec 里是写死的 `D:\project\patch_search`。改任何一处都要问一句"另一份要不要跟"。
7. **`rm -rf build dist`**：`build_mac.sh` 里有，先确认 `dist/` 里没有你要留的东西。
8. **`zip` 不带 `-y`** 会把 `.app` 里的符号链接解引用，包直接损坏。
9. **`.app` 里的 `sys.executable` 在 `Contents/MacOS/`**：所有"exe 同目录"的直觉都要换成"`.app` 外一层"，见 21.3 第 7 步。

## 二十二、FBIP skill 库的安装与提示词接入

### 22.1 这套 skill 库是什么

- **本体**：FBIP 领域 skill 库（`D:\project\fbip-skill\` 是它的一面：`README.md` 写着 210+ skills、L1/L2 两级路由、各域 CODEGEN 规范；`D:\tmp\.claude(1)\.claude\skills\` 那份副本规模更大——**731 个目录 / 722 个 SKILL.md / 5,430 个 md**）。
- **格式**：`<库>/.claude/skills/<skill 名>/SKILL.md`；frontmatter 是 `name` / `tier`(frontend|backend|fullstack) / `description`(中文 + 触发关键词) / `version` / `tools`；正文固定章节：功能边界 → 前后端 Action 对照表 → 核心实现 → **Bug 模式库** → 关联 Skills → **AI 生成代码注意事项（❌/✅）** → References（按需加载）。`references/` 里是生成的文档（`DB_TABLE_REF.md` 268 个 skill / `PAGE_TEMPLATE_REF.md` 567 个 / `BIZ_RELATION_REF.md` 26 个）。
- **路由**：`fbip-skill-router`(L1，判 tier/domain/entryPoint) → `fbip-{domain}-router`(L2) → 业务 skill(L3)。
- **与本节点的关系**：`local_skill_path` 这个环境变量登记的就是**这份库在本机的根目录**。装上它 = 让节点的 claude 用这套领域知识，而不是我们在提示词里手写。

### 22.2 安装：三种装法，推荐 A + B 一起

Claude Code 发现 skill 的路径（**只认一层**：`skills/<skill 名>/SKILL.md`，再深一层静默忽略）：

| 级别 | 路径 |
|---|---|
| 用户级 | `~/.claude/skills/`（Windows 是 `%USERPROFILE%\.claude\skills`） |
| 项目级 | `<cwd>/.claude/skills/`（会向上找到仓库根） |
| 额外目录 | `--add-dir <path>` 会加载 `<path>/.claude/skills/`（`permissions.additionalDirectories` **不会**，它只给文件权限） |

**A. 用户级联接（推荐，零改代码、每台机一次）**

```powershell
:: Windows（Junction 不需要管理员权限）
mklink /J "%USERPROFILE%\.claude\skills" "D:\fbip-skill\.claude\skills"
```

```bash
# macOS / Linux
ln -s "/Users/you/fbip-skill/.claude/skills" ~/.claude/skills
```

装完**这台机器上的每一次 claude 调用**（含节点——cc-web 不传 `--bare`，cwd 是不是项目根都不影响）都能看到。⚠️ **若 `~/.claude/skills` 已存在**（本机就有一个 `mobile-portal-extend`），不要直接联接覆盖：先把已有的挪进库里，或改为逐个 skill 建联接。

**B. 登记 `local_skill_path` + 提示词点名绝对路径（本次已做，见 22.3）**

不依赖"自动发现"，最稳。**这条必须做**，理由见 22.4。

**C. `--add-dir`（要改 cc-web，v1 不做）**

cc-web 目前只传 `--mcp-config`（`claude.rs` 的 `mcp_flags()`）。要让"某一次运行只挂某个 skill 目录"，就得在 `claude.rs` 里给 `claude` 加 `--add-dir <path>`。等真有"按 run 挑 skill 库"的需求再说。

### 22.3 提示词怎么接入（本次已改）

改动都在 `static/patches.js`（v1 提示词硬编码在 cc-web，见 20.12）：

1. **建 run 时**：`env_snapshot` 新增 `local_skill_path`（取自产品环境变量，选填；只落本机 `node_runs.json`，**不上报**）。
2. **阶段一【环境】段**：登记了才多一行「本机 skill 库（FBIP 领域 skill 库根目录，可按需读取）：…」。
3. **阶段一【任务】新增第 2 条"先读工具说明书"**（登记了才出现；没登记整条退化成"跳过这一步"）：
   - 读 `<库>/java-compiler-mcp/SKILL.md` —— 编译 MCP 七个工具的参数、路径映射表、GBK 回退、常见错误，**照它调用、不要自己猜参数**；
   - 需要领域知识时读 `<库>/fbip-skill-router/SKILL.md` 与它指到的 skill；**某个 skill 要求的前置 skill 本机不存在就跳过那条继续**（见 22.4）；
   - skill 文档里的 `D:\…` 绝对路径只是它成文时的示例，**本机环境一律以【环境】段为准**。
4. **阶段一【任务】第 3 条**（"按客开工程的结构构建"，见 20.12 的 2026-09-21 说明）：先只读地定出模块根与每个文件的 source type → 暂存目录里逐层照抄 → 目录层级不许猜 → 打完包列 zip 条目自查。

### 22.4 为什么不靠"自动发现"、为什么还要点名

两条硬限制（决定了 22.2 里 B 必须做）：

1. **skill 列表有预算**：所有 skill 的 `name` + `description` 会进 system prompt，预算约为上下文窗口的 **2%**，**超出的部分被静默丢弃、没有任何报错**。731 个 skill 的描述远超这个预算 —— 装是装上了，但**不能指望"装上就会被自动路由到"**。库里 `description` 越短越有利；真要给自动路由用，只能靠"L1 router 当唯一入口"的设计。
2. **L1 router 有一个硬缺失**：`fbip-skill-router`（以及 `fbip-jira-solver`、`fbip-jira-search`、`fbip-skill-generator`、`fbip-erm-loan-offset`）**硬性要求一个不存在的 `fbip-code-index-analysis`**（已确认无此目录）。所以提示词里**不要**写"从 L1 开始按路由执行"——那会让它卡在第一步；本次改成"按需读，遇到不存在的前置就跳过并写进结论"。

另外这份库里有**大量机器绝对路径硬编码**（`D:/Tools/jdk1.8.0_201`、`D:/work/ideaworkspace/fbipaihome/home/gl`、`D:/home/hotwebs/hotwebs` 等）。这正是产品环境变量里 `package_path` / `local_jdk_path` 要替代的东西 —— 所以第 2 条 c 明确写了"以【环境】为准"。

### 22.5 落地动作（每台开发机）

1. 把 skill 库放到本机固定位置（建议 `<盘>:\fbip-skill`，与 `D:\project\fbip-skill` 一致）。
2. 到「产品环境变量」里把该产品的 **本地skill路径** 填成库根目录（例如 `D:\fbip-skill\.claude\skills`）——它只登记、服务器不校验。
3. （可选，但推荐）按 22.2 A 做用户级联接，让交互式 claude 也能用这套 skill。
4. 重编 cc-web 并分发（本次已做，见 22.6）。

### 22.6 本次落地状态（2026-09-21）

- `static/patches.js`：`env_snapshot.local_skill_path`、阶段一【环境】新增 skill 库行、【任务】新增第 2 条并重排第 3 条（a~e）——均已改完，`node --check` 通过，提示词用脱机渲染核对过（登记 / 未登记两种形态）。
- **cc-web 已重编并分发**：`cargo build --release` → 4,765,696 字节（2026-09-21 08:55），已覆盖 `target/release/cc-web.exe`、仓库根 `cc-web.exe`、`D:\project\cc-web-dist\cc-web.exe`（三份都验过二进制里含新提示词串）。
- **待用户动作**：重启正在跑的 cc-web（当时那个进程还是 9-20 19:09 的版本）；把 skill 库路径登记进产品环境变量。
- **没做的**：cc-web 不加 `--add-dir`；`fbip-code-index-analysis` 的缺失不补（属 skill 库自身的问题）；skill 库不下发/不自动安装（v1 由各机自己放）。

## 二十三、源码检索 MCP 的审计日志

### 23.1 需求与边界

源码检索 MCP（`app/mcp/`，随 patch_search 同进程、第二个监听端口 13589，见 21.3 的收集项说明）是给**开发者的 Claude Code** 用的：模型拿它去服务器上的源码树里翻东西。问题是翻完之后没人知道它**翻过哪些文件** —— 主日志里只有一行光秃秃的摘要（`app/mcp/server.py` 的 `_timed()`，:53）：

```
INFO [patch_search.mcp] [request_id=-] mcp tool name=read_file elapsed_ms=0.7 bytes=337
```

没有参数、没有文件名。于是要做一份**审计日志：这次分析到底读了/搜了哪些源码文件**，用来核对模型是不是查对了地方。

四条已拍板的取舍（2026-09-21）：

| 问题 | 决定 |
|---|---|
| 记哪些工具 | **六个全记**（list_roots / grep / glob / read_file / list_dir / stat_path），grep 与 glob 连命中的文件列表一起记 |
| 写到哪 | **单独一个 `logs/mcp_audit.log`**，不混进主日志 |
| 怎么把一次分析串起来 | 每行带 **`session=` 短号**（MCP 的 `mcp-session-id` 前 12 位） |
| 模型给的搜索词要不要记 | **记 `pattern`**（见 23.6 的取舍说明） |

硬边界：**只记路径与计数，绝不记文件内容、也绝不记命中的行文本** —— 与 `README.md` 里「日志不会记录查询结果内容」的口径一致。唯一的例外是 `pattern` / `include`，它们属于**模型输入**而非源码内容。

### 23.2 为什么单开一个 `mcp_audit.log`

主日志是给运维看服务运行的；这份是给「这次分析到底翻了哪些源码」用的。混在一起的后果是主日志被 grep / read_file 的流水淹掉 —— 一次分析动辄几十上百行。所以：

- 独立的 `TimedRotatingFileHandler`、独立的 `backup_count`（默认 30 天）
- **`propagate = False`**：不关掉的话审计行会冒泡进 `patch_search.log`，变成静默双写
- 格式里**不掺 main log 的那几列**（没有 `[name]`、没有 `[request_id=…]`，MCP 请求本来也没有 request_id）：

```
%(asctime)s %(levelname)s %(message)s
```

### 23.3 日志格式

行前缀固定 `mcp audit `，值与主日志同款 `key=value`。**字符串值一律 `json.dumps(..., ensure_ascii=False)`** —— 一举解决换行/空格/引号，模型给的 `pattern` 是任意文本也不怕；数字/布尔/null 裸值；列表渲染成 `["a","b"]`，超过 `max_items` 折叠成 `(+M more)`。

键序是稳定的：先是 `tool=` / `session=`，然后是这次调用传进来的**原始参数**（按定义顺序），最后是工具执行中 `merge()` 进来的**结果字段**。空值照常输出（不省略键），便于 grep。

实测样例（真实跑出来的，见 23.7）：

```
mcp audit event=ready file="…/logs/mcp_audit.log" enabled=true max_items=20
mcp audit event=session_start session=3e871d8ccbe0
mcp audit tool=list_roots session=3e871d8ccbe0 count=1 names=["src"] ok=true
mcp audit tool=grep session=3e871d8ccbe0 root="src" path="a" pattern="NEEDLE" include="" cursor=0 target="src/a" files=25 hits=25 truncated=false list=["src/a/F11.java(1)",…] (+5 more) ok=true
mcp audit tool=grep session=3e871d8ccbe0 root="src" path="a" pattern="zzzznope" include="*.java" cursor=0 target="src/a" files=0 hits=0 truncated=false list=[] ok=true
mcp audit tool=glob session=3e871d8ccbe0 root="src" path="a" pattern="**/*.java" cursor=0 target="src/a" files=26 truncated=false list=["src/a/Foo.java",…] (+6 more) ok=true
mcp audit tool=read_file session=3e871d8ccbe0 root="src" path="src/a/Foo.java" start_line=5 max_lines=4 lines="5-8" returned=4 eof=false ok=true
mcp audit tool=read_file session=3e871d8ccbe0 root="src" path="src/a/blob.bin" start_line=1 max_lines=0 ok=false error="错误：src/a/blob.bin 看起来是二进制文件，已拒绝读取。"
mcp audit tool=read_file session=3e871d8ccbe0 root="src" path="../escape.txt" start_line=1 max_lines=0 ok=false error="错误：路径不在允许的目录范围内：../escape.txt"
mcp audit tool=list_dir session=3e871d8ccbe0 root="src" path="src/a" max_entries=0 dirs=0 files=27 shown=27 capped=false ok=true
mcp audit tool=stat_path session=3e871d8ccbe0 root="src" path="src/a/Foo.java" type="file" size_bytes=603 is_binary=false line_count=31 ok=true
```

每个工具记什么：

| 工具 | 原始参数 | 结果字段（`merge` 进来的） |
|---|---|---|
| `list_roots` | — | `count`、`names`（白名单名字列表） |
| `grep` | `root` `path` `pattern` `include` `cursor` | `target`（解析后的归一化路径）、`files`、`hits`、`truncated`、`list=["路径(条数)",…]` |
| `glob` | `root` `path` `pattern` `cursor` | `target`、`files`、`truncated`、`list=["路径",…]` |
| `read_file` | `root` `path` `start_line` `max_lines` | `path`（归一化）、`lines="首-末"`、`returned`、`eof` |
| `list_dir` | `root` `path` `max_entries` | `path`、`dirs`、`files`、`shown`、`capped` |
| `stat_path` | `root` `path` | `path`、`type`、`size_bytes`、`is_binary`、`line_count` |

两点说明：

- **`path` 与 `target` 会同时出现**，故意保留：前者是模型**写的**（可能写成 `a` 或 `src/a` 两种写法），后者是我们**解析成的**。核对"模型是不是查错了地方"时，这一对差异往往就是线索。
- **`stat_path` 不记 `absolute_path`**。工具返回体里有它，但审计里 `path`（`<root 名字>/<相对路径>`）已经足够定位，少一处多余的服务器路径暴露。

### 23.4 配置项（`config.yaml` 的 `mcp.audit`）

```yaml
mcp:
  audit:
    enabled: true
    file: "mcp_audit.log"
    dir: ""                  # 留空 = 跟随 logging.dir
    level: "INFO"
    rotation: "midnight"
    backup_count: 30
    max_items: 20            # 列表类字段最多列几项，其余折叠成 (+M more)
    max_value_length: 512    # 单值截断长度，标记与主日志一致 ...<truncated>
    session_tag_length: 12   # 完整 session id 是 32 位 hex，取前 N 位做短标签
```

- 目录解析复用 `app/logging_config.py` 的 **`resolve_log_dir()`**（本次从 `configure_logging` 里抽出来的）。抽出来就是为了让两份日志**同口径**：config 放在哪日志就落到它旁边的 `logs/`，打包成 exe 后也是 exe 同目录 —— 两边各写一份解析逻辑迟早会走偏。
- 默认值在 `app/config.py` 的 `MCP_AUDIT_DEFAULTS`，`Settings.mcp_audit` 按 `mcp_limits` 同款写法回落。**没配 `mcp.audit` 也能工作**（`config.mac.example.yaml` 至今整个没有 `mcp:` 段，不改也不会缺键）。
- `dir` 留空 / `file` 改名 / `enabled: false` 都是就地生效的开关，不需要动代码。

### 23.5 怎么用：按会话捞一次分析

会话号就是 MCP 的 `mcp-session-id`（客户端 `initialize` 时服务端新发的那串 32 位 hex），从工具函数的 `Context.headers` 里取。一次分析的所有读取靠 `session=` 串起来：

```bash
grep 'session=3e871d8ccbe0' logs/mcp_audit.log
```

- **`event=session_start`** 是这个会话**第一次真正干活**时补的一行（不是 `initialize` 时刻 —— initialize 的请求头里还没有 session id，值是响应里新发的）。用来在日志里一眼看出一次分析的起点。实现是「本进程首次见到该 id 时打一行」，用一个有界 `deque(maxlen=4096)` + `set` 去重，进程长跑不会无限涨。
- **不做 `event=session_end`**：只有客户端显式 `DELETE` 才判别得出，idle 超时拿不到。加了会让人误以为日志是完整的，宁缺毋滥。

要统计「这次分析一共碰了多少个文件」，直接数 `tool=read_file` 的 `path=` 和 `tool=grep` 的 `list=` 就行。

### 23.6 实现要点（都是踩过的坑）

1. **不用自己加 ASGI 中间件。** MCP SDK 2.2.0 支持给工具函数加一个 `Context` 类型注解的形参，SDK 自动注入，`ctx.headers` 就是当前 HTTP 请求头。本方案最初打算用「中间件 + ContextVar」，实测可行，但既然 SDK 有第一方入口，就用第一方的，省掉一层 ASGI 包装和 `lifespan` 透传的顾虑。相关 API 已逐条在装好的 SDK 里核对：`Context.headers`（`mcpserver/context.py:282`）、`MCP_SESSION_ID_HEADER`（`streamable_http.py:54`，审计模块直接 import 这个常量而不是写死字面量）。
2. ⚠️ **`Context` 必须是 `app/mcp/server.py` 顶部的运行时 import。** 该文件有 `from __future__ import annotations`，注解是字符串，SDK 靠 `typing.get_type_hints()` 从模块全局解析；而 SDK 在解析失败时**静默返回 None** —— 于是 `ctx` 会退化成工具的一个**必填参数**出现在 `inputSchema` 里，模型开始瞎传，而运行时没有任何报错提示。写进 `TYPE_CHECKING` 或只在函数体内 import 都会踩这个坑。**改动 `server.py` 顶部 import 之后，务必重跑 23.7 的"ctx 不进 inputSchema"断言。**
3. **`ctx: Context` 必须是 wrapper 的第一个形参**（不能跟在带默认值的形参后面）。
4. **`ok` 靠返回串是否以 `错误：` 开头判断。** 这是 `tools.py` 的既有约定（17 处失败返回全部这么写，已 grep 确认 17/17），好处是 `tools.py` 的错误路径一个都不用改。**这个约定是脆的**：将来新增错误返回时若不按这个前缀写，`ok` 会失真（行不会丢，只是标错）。改动时要么照样用这个前缀，要么把 `_ERROR_PREFIX` 换成共享常量。
5. **审计轨迹不能挂在 `SourceTools` 实例上。** 它是跨请求共享的单例，并发两个 `tools/call` 会互相覆盖。做法是每个 wrapper 新建一个 `AuditTrail`，外面套 `try/finally`，`finally` 里 `trail.finish(result).emit()` —— 成功、失败、抛异常都**恰好一行**（抛异常时 `result` 还是 None，`finish(None)` 记 `ok=false`）。
6. **埋点只在成功路径上 `merge()`**，而且可以**无条件**调用：`tools.py` 六个方法各加一个形参 `audit: AuditTrail = NOOP_TRAIL`（模块级 noop 实例，不存 per-call 状态，共享安全），不用到处 `if audit`。失败返回时由 `finish(text)` 自己判 `ok=false`。
7. **审计 logger 必须在 build 期装好**，不能在 `app/main.py` 的 lifespan 里装：`run_server.py` 是先 `create_task(mcp_server.serve())` 再 `await main_server.serve()`，后者的 lifespan 里才连 MySQL —— 这期间 MCP 端口已经在收请求了。所以调用点在 `build_mcp_asgi_app()` 的**第一行**。顺带也让「只跑 MCP」的场景有审计。
8. **`configure_mcp_audit()` 绝不能抛异常。** 它的调用点被 `run_server.py` 包在 try/except 里，抛出去会让 **MCP 整体不启动**，而不是只丢审计。所以目录建不出来、文件开不出来，都只在主日志留一条 warning 后退化成 `NullHandler`。
9. **`grep` 的 `files`/`hits` 是"当前这一页"**（`cursor` 之后），而且 `hits` **含上下文行**。所以审计行里 `cursor=` 与 `truncated=` 必须一起看 —— 单看数字对不上不是 bug，这点写进了代码注释。
10. `pattern` 会落盘（用户已确认接受）：模型搜的自由文本进审计文件，可能含 `password` 之类字样。与 `app/db.py` 记录 SQL 模板同级信任域。

**日志格式的细节**：所有字符串值都 JSON 编码，所以 `stat_path` 的 `type="file"` 是带引号的（不是裸 `file`）。这是刻意的统一 —— 一条规则比"某些字段特殊处理"更可预测。

### 23.7 验证（2026-09-21 已跑）

不碰 DB 的独立冒烟（起临时 config + 临时源码树 + 空端口 13599，走完 `initialize` → `notifications/initialized` → `tools/list` → 六个工具若干次）：

1. ✅ `python -m compileall -q app` 全过。
2. ✅ **`ctx` 没有泄漏进 `inputSchema`**：六个工具的 `properties` 分别是 `[]` / `[pattern,root,path,include,fixed_strings,case_sensitive,word,context_lines,include_hidden,max_matches,cursor]` / `[pattern,root,path,include_hidden,max_results,cursor]` / `[path,root,start_line,max_lines]` / `[path,root,max_entries]` / `[path,root]` —— 无 `ctx`。**这条是上面坑 2 的唯一兜底。**
3. ✅ 每个工具**恰好一行**，`session=` 六次相同（`3e871d8ccbe0`），首次调用前有一行 `event=session_start`。
4. ✅ 覆盖到的边界：grep 零命中（`files=0 hits=0 list=[]`）、越界 path（`ok=false error="错误：路径越界…"`）、二进制文件（`ok=false error="错误：…二进制文件…"`）、`read_file` 分段（`lines="5-8" returned=4 eof=false`）。
5. ✅ **列表折叠**：25 个 java 的 grep 与 26 个文件的 glob 都正确折叠成 `(+5 more)` / `(+6 more)`（`max_items: 20`）。
6. ✅ **主日志没被污染**：同一进程里先 `configure_logging()` 再跑工具，`patch_search.log` 里有 9 行 `mcp tool name=…`（原有格式一字不变），**`mcp audit` 一次都没出现**（证明 `propagate=False` 生效）。
7. ✅ 审计文件是**合法 UTF-8、无 BOM**，中文错误信息原样落盘（控制台里看到的乱码只是 Windows 终端 cp936 的显示问题）。

**还没做的验证**：真服务端到端（`python run_server.py` 连 `10.4.122.21` + 真源码根，跑 `mcptest.ps1`）；`build.bat` 出包后确认 exe 同目录能建出 `logs/mcp_audit.log`。这两条留到下次部署时顺带看。

### 23.8 明确不做的

- **不把 session 号回写进 `list_roots` 的返回**，也不在节点提示词里要求 Claude 把 session 写进 `结论.md` —— 用户选了"先不做"。本次改动**纯 patch_search 服务端**：不重编 cc-web、不动提示词、不动数据库。
- 不做 `session_end`、不记文件内容、不记命中行文本。
- **不更新 `README.md`**：它到现在都没有 `mcp:` 段的说明（是 MCP 并入前的版本），单独补一段 `mcp.audit` 反而突兀。

### 23.9 改动清单

| 文件 | 改动 |
|---|---|
| `app/mcp/audit.py` | **新增**。`configure_mcp_audit()` / `AuditTrail` / `session_tag()` / `NOOP_TRAIL`，以及格式化与 `event=session_start` 去重 |
| `app/mcp/tools.py` | 六个方法各加 `audit: AuditTrail = NOOP_TRAIL` 形参，成功路径上 `merge()` |
| `app/mcp/server.py` | 顶部运行时 import `Context`；六个 wrapper 加 `ctx` 形参与 `try/finally`；`build_mcp_asgi_app()` 第一行调 `configure_mcp_audit()`。`_timed()` 与 `BearerAuth(...)` 一行未动 |
| `app/logging_config.py` | 抽出 `resolve_log_dir()`，`configure_logging` 改用它（行为不变） |
| `app/config.py` | 新增 `MCP_AUDIT_DEFAULTS` 与 `Settings.mcp_audit` |
| `config.yaml` | `mcp:` 下新增 `audit:` 段 |

