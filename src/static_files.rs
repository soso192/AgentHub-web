use actix_web::{HttpRequest, HttpResponse, http::header};

const INDEX_HTML: &str = include_str!("../static/index.html");
const STYLE_CSS: &str = include_str!("../static/style.css");
const APP_JS: &str = include_str!("../static/app.js");

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
    
    let (content, content_type) = match path {
        "/" | "/index.html" => (INDEX_HTML, "text/html; charset=utf-8"),
        "/style.css" => (STYLE_CSS, "text/css; charset=utf-8"),
        "/app.js" => (APP_JS, "application/javascript; charset=utf-8"),
        _ => {
            return HttpResponse::NotFound().body("Not Found");
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
