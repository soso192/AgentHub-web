use super::model::ServiceInfo;
use super::util::LogFile;
use anyhow::{bail, Context, Result};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const WINDOWS: bool = cfg!(windows);

fn build_command(script: &Path) -> Command {
    if WINDOWS {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(script);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.arg(script);
        cmd
    }
}

fn run_script_sync(script: &str, timeout: Duration, log: &mut LogFile) -> Result<()> {
    let path = Path::new(script);
    if !path.is_file() {
        bail!("脚本不存在：{script}");
    }
    log.line(format!("执行：{script}"));
    let mut cmd = build_command(path);
    if let Some(parent) = path.parent() {
        cmd.current_dir(parent);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .with_context(|| format!("启动脚本失败：{script}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    log.line(format!("完成：{script}"));
                    return Ok(());
                }
                bail!("脚本返回失败（{status}）：{script}");
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    bail!("脚本执行超时（{} 秒）：{script}", timeout.as_secs());
                }
                sleep(Duration::from_millis(300));
            }
            Err(error) => bail!("等待脚本结束失败：{error}"),
        }
    }
}

fn run_script_detached(script: &str, log: &mut LogFile) -> Result<()> {
    let path = Path::new(script);
    if !path.is_file() {
        bail!("脚本不存在：{script}");
    }
    log.line(format!("启动：{script}"));
    let mut cmd = build_command(path);
    if let Some(parent) = path.parent() {
        cmd.current_dir(parent);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()
        .with_context(|| format!("启动脚本失败：{script}"))?;
    Ok(())
}

/// 只停止，不启动；用于部署/回滚过程的细粒度控制。
pub fn stop(service: &ServiceInfo, log: &mut LogFile) -> Result<()> {
    let Some(stop) = service.stop_script.as_deref() else {
        bail!("没有配置停止脚本");
    };
    if let Err(error) = run_script_sync(stop, Duration::from_secs(180), log) {
        log.line(format!("停止脚本失败：{error}"));
        if let Some(force) = service.force_script.as_deref() {
            log.line("尝试强制停止");
            run_script_sync(force, Duration::from_secs(60), log)?;
            Ok(())
        } else {
            Err(error)
        }
    } else {
        sleep(Duration::from_secs(2));
        Ok(())
    }
}

/// FBIP 8.1 在复制补丁后、启动前需要执行 bin/deploy.sh。
pub fn run_deploy(service: &ServiceInfo, log: &mut LogFile) -> Result<()> {
    if let Some(script) = service.deploy_script.as_deref() {
        run_script_sync(script, Duration::from_secs(600), log)?;
    }
    Ok(())
}

pub fn start(service: &ServiceInfo, log: &mut LogFile) -> Result<()> {
    let Some(start) = service.start_script.as_deref() else {
        bail!("没有配置启动脚本");
    };
    run_script_detached(start, log)?;
    sleep(Duration::from_secs(2));
    Ok(())
}

/// 统一的服务命令提示文案。
pub fn service_message(service: &ServiceInfo) -> String {
    format!(
        "已识别到服务器启动命令：{}，停止命令：{}，重启命令：{}",
        service.start_script.as_deref().unwrap_or("未配置"),
        service.stop_script.as_deref().unwrap_or("未配置"),
        service.restart_script.as_deref().unwrap_or("未配置")
    )
}

/// 重启服务：
/// - 配置了重启脚本：直接执行重启脚本；
/// - 没配置重启脚本：停止后启动（`already_stopped=true` 时只启动，避免部署/回滚时重复停止）。
pub fn restart(service: &ServiceInfo, log: &mut LogFile, already_stopped: bool) -> Result<()> {
    if let Some(script) = service.restart_script.as_deref() {
        run_script_sync(script, Duration::from_secs(300), log)?;
        return Ok(());
    }
    if service.start_script.is_none() || service.stop_script.is_none() {
        bail!("未找到重启命令");
    }
    if !already_stopped {
        stop(service, log)?;
    }
    start(service, log)
}
