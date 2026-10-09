use actix_web::{web, HttpResponse, http::header};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ListFilesQuery {
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct RevealRequest {
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct PickFolderQuery {
    /// 输入框当前值：是个目录就从它接着浏览（rfd 的 set_directory）
    pub start: Option<String>,
}

/// 在运行 cc-web 的机器上弹出系统原生「选择文件夹」对话框，返回选中的绝对路径。
///
/// 为什么在后端弹：浏览器出于安全不把绝对路径给网页（webkitdirectory 只有相对路径），
/// 而 cc-web 就跑在使用者本机——localhost 使用时对话框正好弹在用户面前。
/// 与 reveal_file（弹资源管理器定位文件）是同一设计模式。
///
/// GET /api/pick-folder?start=<输入框当前值>
/// - 返回 {success:true, path:"D:\\xx"}；用户取消返回 {success:true, path:null}（前端不动输入框）
/// - 同时只允许一个对话框（对话框会阻塞到用户操作，期间再请求直接 409）
///
/// 平台实现（见 pick_folder_blocking）：
/// - Windows/Linux：rfd 的 IFileDialog（任意线程可用）
/// - macOS：rfd 要求主线程+应用事件循环，服务器线程里用不了 → 改调系统自带的
///   osascript `choose folder`，同样是原生对话框，且不需要 GUI 应用环境
#[allow(unused_variables)]
pub async fn pick_folder(query: web::Query<PickFolderQuery>) -> HttpResponse {
    use std::sync::atomic::{AtomicBool, Ordering};
    static PICKING: AtomicBool = AtomicBool::new(false);
    if PICKING.swap(true, Ordering::SeqCst) {
        return HttpResponse::Conflict().json(serde_json::json!({
            "success": false,
            "error": "已有目录选择窗口打开，请先处理它"
        }));
    }

    let start = query
        .start
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && std::path::Path::new(value).is_dir());
    let picked = tokio::task::spawn_blocking(move || pick_folder_blocking(start.as_deref())).await;
    // 无论成功/取消/panic 都复位，对话框窗口随之关闭
    PICKING.store(false, Ordering::SeqCst);

    match picked {
        Ok(Ok(Some(path))) => HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "path": path
        })),
        Ok(Ok(None)) => HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "path": null   // 用户点了取消
        })),
        Ok(Err(error)) => HttpResponse::InternalServerError().json(serde_json::json!({
            "success": false,
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "success": false,
            "error": format!("打开目录选择窗口失败: {error}")
        })),
    }
}

/// 阻塞式弹目录选择框（跑在 spawn_blocking 线程里）：Ok(Some(绝对路径)) / Ok(None)=取消 / Err=失败
#[cfg(target_os = "macos")]
fn pick_folder_blocking(start: Option<&str>) -> Result<Option<String>, String> {
    // AppleScript 源码里嵌路径：转义反斜杠和双引号
    let escape = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");
    let mut script = String::from("POSIX path of (choose folder with prompt \"选择文件夹\"");
    if let Some(dir) = start {
        script.push_str(&format!(" default location POSIX file \"{}\"", escape(dir)));
    }
    script.push(')');

    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|error| format!("调用 osascript 失败: {error}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().trim_end_matches('/').to_string();
        if path.is_empty() {
            return Err("目录选择返回了空路径".to_string());
        }
        Ok(Some(path))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 用户点取消：AppleScript 报错 -128 "User canceled"（中文系统是「用户取消」）
        let lowered = stderr.to_lowercase();
        if lowered.contains("user canceled") || stderr.contains("用户取消") || lowered.contains("cancelled") {
            return Ok(None);
        }
        Err(format!("目录选择失败: {}", stderr.trim()))
    }
}

#[cfg(not(target_os = "macos"))]
fn pick_folder_blocking(start: Option<&str>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new().set_title("选择文件夹");
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    Ok(dialog.pick_folder().map(|path| path.to_string_lossy().to_string()))
}

pub async fn list_files(query: web::Query<ListFilesQuery>) -> HttpResponse {
    let dir_path = query.path.as_deref().unwrap_or(".");

    let path = std::path::Path::new(dir_path);

    if !path.exists() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "success": false,
            "error": "Path does not exist"
        }));
    }

    if !path.is_dir() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "success": false,
            "error": "Path is not a directory"
        }));
    }

    let mut files: Vec<serde_json::Value> = Vec::new();

    match std::fs::read_dir(path) {
        Ok(entries) => {
            for entry in entries {
                if let Ok(entry) = entry {
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    // Skip hidden files
                    if file_name.starts_with('.') {
                        continue;
                    }
                    let file_path = entry.path().to_string_lossy().to_string();
                    let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                    let size = if is_dir {
                        0
                    } else {
                        entry.metadata().map(|m| m.len()).unwrap_or(0)
                    };

                    files.push(serde_json::json!({
                        "name": file_name,
                        "path": file_path,
                        "is_dir": is_dir,
                        "size": size,
                    }));
                }
            }
        }
        Err(e) => {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "success": false,
                "error": format!("Failed to read directory: {}", e)
            }));
        }
    }

    // Sort: directories first, then files alphabetically
    files.sort_by(|a, b| {
        let a_is_dir = a.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
        let b_is_dir = b.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let a_name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let b_name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                a_name.to_lowercase().cmp(&b_name.to_lowercase())
            }
        }
    });

    let parent = path.parent().map(|p| p.to_string_lossy().to_string());

    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "path": dir_path,
        "parent": parent,
        "files": files
    }))
}

pub async fn read_file(path: web::Path<String>) -> HttpResponse {
    let file_path = path.into_inner();
    let path = std::path::Path::new(&file_path);

    if !path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "success": false,
            "error": "File not found"
        }));
    }

    if path.is_dir() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "success": false,
            "error": "Path is a directory"
        }));
    }

    // Limit file size to 1MB
    match path.metadata() {
        Ok(meta) if meta.len() > 1_048_576 => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "success": false,
                "error": "File too large (max 1MB)"
            }));
        }
        _ => {}
    }

    match std::fs::read_to_string(path) {
        Ok(content) => {
            HttpResponse::Ok().json(serde_json::json!({
                "success": true,
                "path": file_path,
                "content": content
            }))
        }
        Err(e) => {
            HttpResponse::InternalServerError().json(serde_json::json!({
                "success": false,
                "error": format!("Failed to read file: {}", e)
            }))
        }
    }
}

/// 按扩展名给原始文件一个合适的 Content-Type（html 让浏览器直接渲染，文本/代码给 text/plain）。
fn content_type_for(file_path: &str) -> &'static str {
    let ext = std::path::Path::new(file_path)
        .extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "md" | "markdown" | "txt" | "log" | "sql" | "java" | "xml" | "json"
        | "yaml" | "yml" | "properties" | "csv" | "bat" | "sh" | "cfg" | "ini" => "text/plain; charset=utf-8",
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "ico" | "bmp" => {
            match ext.as_str() {
                "png" => "image/png", "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif", "svg" => "image/svg+xml",
                "webp" => "image/webp", "ico" => "image/x-icon", _ => "image/bmp",
            }
        }
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// 原始字节服务：给浏览器在**新标签里直接打开/渲染**（html 渲染、txt/md 直接看）。
/// 不设 Content-Disposition: attachment，否则会变成下载而不是打开。
pub async fn read_file_raw(path: web::Path<String>) -> HttpResponse {
    let file_path = path.into_inner();
    let path = std::path::Path::new(&file_path);

    if !path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "success": false,
            "error": "File not found"
        }));
    }
    if path.is_dir() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "success": false,
            "error": "Path is a directory"
        }));
    }

    // 原始字节服务的上限放宽到 20MB（html 报告/大文本够用；zip 不从这里下）
    match path.metadata() {
        Ok(meta) if meta.len() > 20 * 1024 * 1024 => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "success": false,
                "error": "File too large (max 20MB)"
            }));
        }
        _ => {}
    }

    match std::fs::read(path) {
        Ok(bytes) => HttpResponse::Ok()
            .insert_header((header::CONTENT_TYPE, content_type_for(&file_path)))
            .body(bytes),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "success": false,
            "error": format!("Failed to read file: {}", e)
        })),
    }
}

/// 在系统文件管理器里定位该文件（Windows explorer /select、macOS open -R、Linux xdg-open 父目录）。
/// cc-web 就运行在产物所在机器上，所以能弹出本机资源管理器并选中该文件。
pub async fn reveal_file(body: web::Json<RevealRequest>) -> HttpResponse {
    let file_path = body.path.as_deref().unwrap_or("");
    let path = std::path::Path::new(file_path);
    if file_path.is_empty() || !path.exists() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "success": false,
            "error": "File not found"
        }));
    }

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(format!("/select,{}", file_path))
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg("-R").arg(file_path).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let result = {
        let dir = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };

    match result {
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({ "success": true })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "success": false,
            "error": format!("Failed to open file manager: {}", e)
        })),
    }
}
