use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Edition {
    #[serde(rename = "8.1")]
    Fbip81,
    #[serde(rename = "8.2")]
    Fbip82,
}

impl Edition {
    pub fn as_str(self) -> &'static str {
        match self {
            Edition::Fbip81 => "8.1",
            Edition::Fbip82 => "8.2",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Edition::Fbip81 => "FBIP 8.1",
            Edition::Fbip82 => "FBIP 8.2",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceInfo {
    pub kind: String,
    pub root: String,
    pub stop_script: Option<String>,
    pub force_script: Option<String>,
    pub start_script: Option<String>,
    /// 可单独配置的重启脚本；有它时直接执行重启，否则停止+启动
    #[serde(default)]
    pub restart_script: Option<String>,
    /// FBIP 8.1 的 bin/deploy.sh：复制文件后、启动前执行
    pub deploy_script: Option<String>,
    pub can_restart: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvInfo {
    pub edition: Edition,
    pub edition_label: String,
    pub input_path: String,
    /// 8.1 = FBIP 根目录（modules/hotwebs 所在目录）；8.2 = fbip 应用根目录
    pub target_root: String,
    /// 8.1 = <target_root>/hotwebs/fbip；8.2 = target_root
    pub app_root: String,
    /// 服务身份键（按部署目录区分；Windows 下大小写不敏感），前后端按它分服务
    pub service_key: String,
    pub service: ServiceInfo,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlanEntry {
    pub archive: String,
    /// 压缩包内原始路径，用于展示和排查
    pub archive_path: String,
    /// 映射后的目标相对路径；忽略/错误项可能为空
    pub target_rel: String,
    /// add / replace / ignored / error
    pub status: String,
    pub ignore_reason: Option<String>,
    /// 非阻断性提示，例如目标目录未登记、源码被忽略等
    pub warning: Option<String>,
    pub size: u64,
    pub sha256: Option<String>,
    /// 目标文件原本的 SHA256（replace 时用于部署前二次校验）
    pub target_sha256: Option<String>,
    /// 目标 class 同时存在于哪个 jar 中
    pub shadow_jar: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArchivePlan {
    pub name: String,
    pub entries: Vec<PlanEntry>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PlanStats {
    pub total: usize,
    pub add: usize,
    pub replace: usize,
    pub shadow: usize,
    pub ignored: usize,
    pub errors: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PreflightResult {
    pub success: bool,
    pub batch_id: String,
    pub created_at: String,
    pub product_name: String,
    pub product_version: String,
    pub env: EnvInfo,
    pub archives: Vec<ArchivePlan>,
    pub stats: PlanStats,
    pub has_conflicts: bool,
    pub can_deploy: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeployMeta {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_name: Option<String>,
    #[serde(default)]
    pub operator: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredPlan {
    pub batch_id: String,
    pub created_at: String,
    pub product_name: String,
    pub product_version: String,
    pub env: EnvInfo,
    pub archives: Vec<ArchivePlan>,
    pub stats: PlanStats,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_name: Option<String>,
    #[serde(default)]
    pub operator: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchFile {
    pub target_rel: String,
    /// add / replace
    pub action: String,
    pub backup_rel: Option<String>,
    pub sha256: String,
    pub size: u64,
    pub shadow_jar: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchRecord {
    pub id: String,
    pub seq: u64,
    pub created_at: String,
    #[serde(default)]
    pub product_name: String,
    #[serde(default)]
    pub product_version: String,
    pub edition: String,
    pub target_root: String,
    pub app_root: String,
    pub archives: Vec<String>,
    pub files: Vec<BatchFile>,
    /// deployed / rolled_back / rollback_failed / deploy_failed
    pub status: String,
    pub rolled_back_at: Option<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_name: Option<String>,
    #[serde(default)]
    pub operator: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchSummary {
    #[serde(flatten)]
    pub batch: BatchRecord,
    pub later_deployed: usize,
    /// 服务身份键；由后端计算，保证和回滚范围使用同一套规则
    pub service_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeployResult {
    pub success: bool,
    pub batch_id: String,
    pub message: String,
    pub applied: usize,
    pub replaced: usize,
    pub added: usize,
    pub service_restarted: bool,
    pub warnings: Vec<String>,
    pub log_tail: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub last_target: String,
    #[serde(default = "default_auto")]
    pub edition: String,
    #[serde(default = "default_true")]
    pub restart: bool,
    #[serde(default)]
    pub product_name: String,
    #[serde(default)]
    pub product_version: String,
    #[serde(default)]
    pub recent_targets: Vec<String>,
    /// 用户手工修改后的服务命令，按 service_key 持久化。
    #[serde(default)]
    pub service_commands: HashMap<String, SavedServiceCommands>,
    /// 历史批次时间是否已从 UTC 迁移到北京时间（一次性迁移）。
    #[serde(default)]
    pub timezone_migrated: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SavedServiceCommands {
    #[serde(default)]
    pub start_script: Option<String>,
    #[serde(default)]
    pub stop_script: Option<String>,
    #[serde(default)]
    pub restart_script: Option<String>,
}

fn default_auto() -> String {
    "auto".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            last_target: String::new(),
            edition: "auto".to_string(),
            restart: true,
            product_name: String::new(),
            product_version: String::new(),
            recent_targets: Vec::new(),
            service_commands: HashMap::new(),
            timezone_migrated: false,
        }
    }
}
