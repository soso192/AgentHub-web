use actix_web::{web, HttpResponse};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ListFilesQuery {
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
