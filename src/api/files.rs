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
