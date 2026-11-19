use super::model::{BatchRecord, Config, SavedServiceCommands};
use super::util::{read_json, write_json_atomic};
use anyhow::{Context, Result};
use chrono::{Duration, NaiveDateTime};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

pub struct PatchDeployState {
    pub data_dir: PathBuf,
    pub config: Mutex<Config>,
    pub batches: Mutex<Vec<BatchRecord>>,
    pub busy: AtomicBool,
}

impl PatchDeployState {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&data_dir)
            .with_context(|| format!("创建数据目录失败：{}", data_dir.display()))?;
        fs::create_dir_all(data_dir.join("staging"))?;
        fs::create_dir_all(data_dir.join("batches"))?;
        fs::create_dir_all(data_dir.join("logs"))?;

        let mut config: Config = read_json(&data_dir.join("config.json")).unwrap_or_default();
        let mut batches: Vec<BatchRecord> =
            read_json(&data_dir.join("batches.json")).unwrap_or_default();
        // 旧版本批次时间使用 UTC 写入，统一一次性迁移到北京时间。
        if !config.timezone_migrated {
            for batch in &mut batches {
                shift_beijing(&mut batch.created_at);
                if let Some(value) = &mut batch.rolled_back_at {
                    shift_beijing(value);
                }
            }
            config.timezone_migrated = true;
            let _ = write_json_atomic(&data_dir.join("config.json"), &config);
            let _ = write_json_atomic(&data_dir.join("batches.json"), &batches);
        }
        Ok(Self {
            data_dir,
            config: Mutex::new(config),
            batches: Mutex::new(batches),
            busy: AtomicBool::new(false),
        })
    }

    pub fn save_config(&self) -> Result<()> {
        let config = self.config.lock().unwrap().clone();
        write_json_atomic(&self.data_dir.join("config.json"), &config)
    }

    pub fn save_batches(&self) -> Result<()> {
        let batches = self.batches.lock().unwrap().clone();
        write_json_atomic(&self.data_dir.join("batches.json"), &batches)
    }

    pub fn staging_dir(&self, batch_id: &str) -> PathBuf {
        self.data_dir.join("staging").join(batch_id)
    }

    pub fn batch_dir(&self, batch_id: &str) -> PathBuf {
        self.data_dir.join("batches").join(batch_id)
    }

    pub fn log_path(&self, batch_id: &str) -> PathBuf {
        self.data_dir
            .join("logs")
            .join(format!("deploy-{batch_id}.log"))
    }

    pub fn next_seq(&self) -> u64 {
        let batches = self.batches.lock().unwrap();
        batches.iter().map(|b| b.seq).max().unwrap_or(0) + 1
    }

    pub fn remember_target(&self, target: &str, edition: &str) -> Result<()> {
        {
            let mut config = self.config.lock().unwrap();
            config.last_target = target.to_string();
            config.edition = edition.to_string();
            config.recent_targets.retain(|item| item != target);
            config.recent_targets.insert(0, target.to_string());
            config.recent_targets.truncate(10);
        }
        self.save_config()
    }

    pub fn remember_form(
        &self,
        target: &str,
        edition: &str,
        product_name: &str,
        product_version: &str,
    ) -> Result<()> {
        {
            let mut config = self.config.lock().unwrap();
            config.last_target = target.to_string();
            config.edition = edition.to_string();
            config.product_name = product_name.to_string();
            config.product_version = product_version.to_string();
            config.recent_targets.retain(|item| item != target);
            config.recent_targets.insert(0, target.to_string());
            config.recent_targets.truncate(10);
        }
        self.save_config()
    }

    pub fn service_commands(&self, service_key: &str) -> Option<SavedServiceCommands> {
        self.config
            .lock()
            .unwrap()
            .service_commands
            .get(service_key)
            .cloned()
    }

    pub fn save_service_commands(
        &self,
        service_key: String,
        commands: SavedServiceCommands,
    ) -> Result<()> {
        self.config
            .lock()
            .unwrap()
            .service_commands
            .insert(service_key, commands);
        self.save_config()
    }

    pub fn cleanup_staging(&self) {
        let dir = self.data_dir.join("staging");
        let Ok(entries) = fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let _ = remove_dir_all_if_old(&path);
            }
        }
    }
}

fn shift_beijing(value: &mut String) {
    if let Ok(time) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        *value = (time + Duration::hours(8))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
    }
}

fn remove_dir_all_if_old(path: &Path) -> Result<()> {
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified()?;
    if modified.elapsed().unwrap_or_default() > std::time::Duration::from_secs(24 * 3600) {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}
