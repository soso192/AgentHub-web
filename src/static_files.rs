use actix_web::{HttpRequest, HttpResponse, http::header};
use mime_guess::from_path;

const INDEX_HTML: &str = include_str!("../static/index.html");
const STYLE_CSS: &str = include_str!("../static/style.css");
const APP_JS: &str = include_str!("../static/app.js");

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

    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, content_type))
        .body(content)
}
