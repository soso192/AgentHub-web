//! 补丁部署工具（本地服务）。
//!
//! 直接把一个或多个 FBIP 补丁 ZIP 打到本机 FBIP 部署目录：
//! - 预检：解析补丁、检查目标环境已有文件、生成可折叠文件树
//! - 部署：停服务 → 备份 → 复制 → FBIP 8.1 bin/deploy.sh → 启动
//! - 批次：记录产品名称/版本/补丁/文件，支持逆序回滚和回滚到指定批次
//!
//! 这是智能开发平台内置的能力，不是 iframe；本地部署目录必须是 cc-web 所在机器可访问的路径。

pub mod archive;
pub mod deploy;
pub mod detect;
pub mod mapping;
pub mod model;
pub mod service;
pub mod state;
pub mod util;

mod handlers;

pub use handlers::{
    batch_detail, cancel, delete_batch, deploy_handler, detect, get_config, list_batches, preflight,
    preflight_by_path, reset_config_defaults, restart, rollback_handler, save_config,
    save_service_commands, session_artifacts,
};
pub use state::PatchDeployState;
