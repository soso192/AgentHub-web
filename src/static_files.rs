//! 内嵌前端静态资源。
//!
//! 2026-11 起前端整体迁移到 React（frontend/，Vite 构建）。构建产物固定文件名输出到
//! `static/dist/`：`index.html`、`app.js`、`app.css`，由 include_str! 编进 exe，保持单文件分发。
//!
//! 路由策略：
//! - 所有页面路径（含 /login、/chat.html、/patches.html、/novice.html 及运行详情页）
//!   都返回同一个 SPA 外壳，由 React Router 按 pathname 渲染对应页面；
//! - 开发版与实施版共用同一套前端，运行时通过 `GET /api/version` 的 edition 字段区分行为；
//! - 旧版原生页面文件仍保留在 static/ 目录，便于对照，但不再被服务。

use actix_web::{HttpRequest, HttpResponse, http::header};

const INDEX_HTML: &str = include_str!("../static/dist/index.html");
const APP_JS: &str = include_str!("../static/dist/app.js");
const APP_CSS: &str = include_str!("../static/dist/app.css");
const LOGO_PNG: &[u8] = include_bytes!("../static/dist/assets/logo.png");

/// 所有由 React Router 处理的页面路径。
const SPA_ROUTES: &[&str] = &[
    "/",
    "/index.html",
    "/chat.html",
    "/patches.html",
    "/novice.html",
    "/login",
    "/login.html",
    "/help",
    "/node_run.html",
    "/adapt_run.html",
    "/workflow_run.html",
    "/server_replay.html",
];

/// Generate ETag based on content hash for cache validation
fn generate_etag_bytes(content: &[u8]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("\"{:x}\"", hasher.finish())
}

/// Generate ETag based on content hash for cache validation
fn generate_etag(content: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("\"{:x}\"", hasher.finish())
}

pub async fn serve(req: HttpRequest) -> HttpResponse {
    let path = req.path();

    if path == "/assets/logo.png" {
        let etag = generate_etag_bytes(LOGO_PNG);
        if let Some(if_none_match) = req.headers().get("If-None-Match") {
            if if_none_match.to_str().unwrap_or("") == etag {
                return HttpResponse::NotModified().finish();
            }
        }
        return HttpResponse::Ok()
            .insert_header((header::CONTENT_TYPE, "image/png"))
            .insert_header((header::ETAG, etag))
            .insert_header(("Cache-Control", "no-cache, must-revalidate"))
            .body(LOGO_PNG);
    }

    let (content, content_type) = if SPA_ROUTES.contains(&path) {
        (INDEX_HTML, "text/html; charset=utf-8")
    } else {
        match path {
            "/app.js" => (APP_JS, "application/javascript; charset=utf-8"),
            "/app.css" => (APP_CSS, "text/css; charset=utf-8"),
            _ => return HttpResponse::NotFound().body("Not Found"),
        }
    };

    let etag = generate_etag(content);

    // Check if client has cached version (If-None-Match header)
    if let Some(if_none_match) = req.headers().get("If-None-Match") {
        if if_none_match.to_str().unwrap_or("") == etag {
            return HttpResponse::NotModified().finish();
        }
    }

    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, content_type))
        .insert_header((header::ETAG, etag))
        .insert_header(("Cache-Control", "no-cache, must-revalidate"))
        .body(content)
}
