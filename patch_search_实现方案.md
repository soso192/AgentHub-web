# 补丁包检索系统完整实现方案

> 版本：v3.1 ｜ 日期：2026-08-14  
> 状态：核心功能已实现并部署（前后端联调完成），本版按当前代码与数据库表结构同步更新  
> 说明：本文档汇总补丁检索、上传、分析、登录认证、提示词管理、可配置智能检索流程、运行记录和部署约束。智能检索步骤不固定写死，由流程模板配置决定。

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
7. **工作目录管理**：按用户隔离工作目录，流程只保存工作目录 `code`，执行前按当前用户 ID 解析实际目录；管理员可维护内置目录，普通用户只能查看和使用内置目录。
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
| 前端 API 地址 | `patches.js` 顶部配置 `PATCH_SEARCH_API` |

---

## 三、cc-web 页面设计

### 3.1 页面入口和顶部切换

- 默认访问 `/` 进入 Chat。
- 点击 Patches 进入 `/patches.html`。
- `patches.html` 中点击 Chat 返回 `/`。
- Chat/Patches 按钮仅负责页面切换，不修改现有聊天业务逻辑。
- 主题复用现有 `localStorage['cc-web-theme']`，补丁页面读取相同 key。

### 3.2 页面结构（顶部 Tab + 左侧仪表盘）

`patches.html` 顶部为登录卡片，登录成功后展示 Tab 导航和左侧仪表盘（个人统计、贡献榜、活跃榜）。

Tab 列表（权限控制）：

| Tab | 名称 | 权限 |
|---|---|---|
| search | 普通检索 | 登录用户 |
| upload | 补丁上传 | 登录用户 |
| mine | 我的补丁 | 登录用户 |
| smart | 智能开发 | 登录用户 |
| flow | 流程设置 | 管理员（也可开放给普通用户管理自己的流程） |
| prompt | 提示词设置 | 管理员（也可开放给普通用户管理自己的提示词） |
| template | 流程模板设置 | 管理员（也可开放给普通用户管理自己的模板） |
| analysis | 待分析补丁 | 仅管理员 |
| directory | 工作目录 | 登录用户 |

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
- 工作目录 `directory_code`：只保存逻辑 code，不保存某个用户的实际 path。

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

- 普通用户可创建、编辑、停用自己创建的非内置目录。
- 管理员可创建内置目录（`is_builtin=1`）；内置目录对所有用户可见可用，只读。
- 目录字段：编码、名称、路径、类型、状态。
- 目录路径必须是服务器上存在的绝对目录路径。

### 3.12 用户设置

- 查看当前用户资料（用户名、显示名称、角色、注册时间、最近登录时间）。
- 修改密码（校验旧密码，新密码不能与旧密码相同，成功后递增 `token_version` 使旧 Token 失效）。

---

## 四、数据库设计

数据库为 `patch`，当前完整结构见 `schema/current_schema.sql`。以下按该文件列出各表。

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
- 停用使用 `status=0`，不物理删除（`DELETE` 接口实际执行停用）。

### 4.4 流程表 `workflow_flow`

```sql
CREATE TABLE `workflow_flow` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '流程内部唯一 ID',
  `code` varchar(128) NOT NULL COMMENT '流程稳定唯一编码，供模板变量引用',
  `name` varchar(255) NOT NULL COMMENT '流程名称',
  `description` text COMMENT '流程用途说明',
  `claude_target` varchar(32) NOT NULL COMMENT 'ClaudeCode 调用目标：local 或 server',
  `directory_code` varchar(128) NOT NULL COMMENT '工作目录业务编码，执行时按当前用户解析实际目录',
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
| `directory_code` | VARCHAR(128) | 否 | 工作目录业务编码；执行时按当前用户解析实际目录。 |
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
  `template_step_id` bigint(20) unsigned NOT NULL COMMENT '启动时采用的模板步骤 ID',
  `step_order` int(11) NOT NULL COMMENT '本次运行中的步骤顺序',
  `flow_code` varchar(128) NOT NULL COMMENT '本步骤使用的流程编码快照',
  `directory_code` varchar(128) NOT NULL COMMENT '本步骤工作目录编码快照',
  `directory_type` varchar(32) NOT NULL COMMENT '目录来源：user 或 builtin',
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
  `started_at` datetime DEFAULT NULL COMMENT '步骤开始执行时间',
  `finished_at` datetime DEFAULT NULL COMMENT '步骤完成、失败或取消时间',
  `confirmed_at` datetime DEFAULT NULL COMMENT '用户点击下一步确认的时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflow_run_step` (`run_id`,`step_order`),
  KEY `idx_workflow_run_step_status` (`run_id`,`status`),
  KEY `fk_workflow_run_step_template_step` (`template_step_id`),
  KEY `idx_workflow_run_step_execution_user` (`execution_user_id`),
  CONSTRAINT `fk_workflow_run_step_execution_user` FOREIGN KEY (`execution_user_id`) REFERENCES `user_account` (`id`),
  CONSTRAINT `fk_workflow_run_step_run` FOREIGN KEY (`run_id`) REFERENCES `workflow_run` (`id`),
  CONSTRAINT `fk_workflow_run_step_template_step` FOREIGN KEY (`template_step_id`) REFERENCES `workflow_template_step` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='流程运行步骤明细表';
```

字段说明：

| 字段 | 类型 | 可空 | 含义 / 约束 |
|---|---|---|---|
| `id` | BIGINT UNSIGNED | 否 | 自增主键，运行步骤唯一标识。 |
| `run_id` | CHAR(36) | 否 | 所属运行实例 ID，外键关联 `workflow_run.id`。 |
| `template_step_id` | BIGINT UNSIGNED | 否 | 启动时采用的模板步骤 ID，外键关联 `workflow_template_step.id`。 |
| `step_order` | INT | 否 | 在本次运行中的执行顺序；同一运行内唯一。 |
| `flow_code` | VARCHAR(128) | 否 | 本步骤实际使用的流程 code 快照，支持按 code 引用结果。 |
| `directory_code` | VARCHAR(128) | 否 | 从流程配置继承的工作目录 code 快照。 |
| `directory_type` | VARCHAR(32) | 否 | 目录来源：`user` 或 `builtin`。 |
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
| `server.port` | 整数 | patch_search HTTP 服务端口。防火墙、安全组和前端 `PATCH_SEARCH_API` 必须一致。 |

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
DELETE /api/workflows/directories/{id}   # 实际执行 status=0 停用
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
  "business_input": "用户输入的业务逻辑"
}
```

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

`create_run` 执行：

1. 校验模板存在、启用，且对当前用户可见（管理员共享或本人所有）。
2. 读取模板步骤，校验每个步骤关联的流程、提示词对当前用户可见。
3. 收集所有步骤的 `directory_code`，按当前用户 ID 优先查用户目录，再查管理员内置目录；任一缺失则拒绝创建运行，一次性返回所有缺失 code。
4. 创建 `workflow_run`，将模板步骤复制为 `workflow_run_step`（含解析出的目录路径、`flow_code`、`template_step_id` 引用）。
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
- 工作目录路径必须是绝对路径、存在且为目录，保存前标准化。
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
