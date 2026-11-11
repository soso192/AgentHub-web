use actix_web::{HttpRequest, HttpResponse, http::header};

// ── 开发版静态文件 ──
#[cfg(not(feature = "implCon"))]
const INDEX_HTML: &str = include_str!("../static/index.html");
#[cfg(not(feature = "implCon"))]
const STYLE_CSS: &str = include_str!("../static/style.css");
#[cfg(not(feature = "implCon"))]
const APP_JS: &str = include_str!("../static/app.js");
#[cfg(not(feature = "implCon"))]
const PATCHES_HTML: &str = include_str!("../static/patches.html");
#[cfg(not(feature = "implCon"))]
const PATCHES_JS: &str = include_str!("../static/patches.js");
#[cfg(not(feature = "implCon"))]
const COMMON_JS: &str = include_str!("../static/common.js");
#[cfg(not(feature = "implCon"))]
const NODE_CORE_JS: &str = include_str!("../static/node_core.js");
// 小白版的内置提示词：开发版不调用，但 patches.html / index.html 两版共用一份、统一加载（缺失会 404）
#[cfg(not(feature = "implCon"))]
const PROMPTS_NOVICE_JS: &str = include_str!("../static/prompts_novice.js");
// 小白版聊天页增强：开发版加载后自动 no-op（edition 判断），但 index.html 两版共用必须能取到
#[cfg(not(feature = "implCon"))]
const NOVICE_CHAT_JS: &str = include_str!("../static/novice_chat.js");
// 聊天输入框附件（两版共用：📎 上传图片/文件）
#[cfg(not(feature = "implCon"))]
const CHAT_ATTACHMENTS_JS: &str = include_str!("../static/chat_attachments.js");
#[cfg(not(feature = "implCon"))]
const SIDENAV_JS: &str = include_str!("../static/sidenav.js");
#[cfg(not(feature = "implCon"))]
const COPYBOX_JS: &str = include_str!("../static/copybox.js");
#[cfg(not(feature = "implCon"))]
const FOLDERPICK_JS: &str = include_str!("../static/folderpick.js");
#[cfg(not(feature = "implCon"))]
const WORKFLOW_RUN_HTML: &str = include_str!("../static/workflow_run.html");
#[cfg(not(feature = "implCon"))]
const NODE_RUN_HTML: &str = include_str!("../static/node_run.html");
#[cfg(not(feature = "implCon"))]
const ADAPT_RUN_HTML: &str = include_str!("../static/adapt_run.html");
#[cfg(not(feature = "implCon"))]
const SERVER_REPLAY_HTML: &str = include_str!("../static/server_replay.html");

// ── 小白版静态文件 ──
// 2026-11-10 起「智能开发」与「聊天」合并进**统一外壳**（novice.html）：
// 左侧 = 菜单（智能开发/产品环境变量/环境检查）+ 会话列表；右侧 = 内容区。
// 智能开发视图复用 app.js 的聊天实现（聊天页的工具/资源管理器已去掉）。
// 独立的智能开发列表页（patches.html/patches.js）不再提供。
#[cfg(feature = "implCon")]
const NOVICE_HTML: &str = include_str!("../static/novice.html");
#[cfg(feature = "implCon")]
const NOVICE_LOGIN_HTML: &str = include_str!("../static/novice_login.html");
#[cfg(feature = "implCon")]
const NOVICE_LOGIN_JS: &str = include_str!("../static/novice_login.js");
#[cfg(feature = "implCon")]
const APP_JS: &str = include_str!("../static/app.js");
#[cfg(feature = "implCon")]
const STYLE_CSS: &str = include_str!("../static/style.css");
#[cfg(feature = "implCon")]
const FOLDERPICK_JS: &str = include_str!("../static/folderpick.js");
#[cfg(feature = "implCon")]
const COMMON_JS: &str = include_str!("../static/common.js");
#[cfg(feature = "implCon")]
const NODE_CORE_JS: &str = include_str!("../static/node_core.js");
#[cfg(feature = "implCon")]
const PROMPTS_NOVICE_JS: &str = include_str!("../static/prompts_novice.js");
#[cfg(feature = "implCon")]
const NOVICE_JS: &str = include_str!("../static/novice.js");
#[cfg(feature = "implCon")]
const NOVICE_CHAT_JS: &str = include_str!("../static/novice_chat.js");
#[cfg(feature = "implCon")]
const CHAT_ATTACHMENTS_JS: &str = include_str!("../static/chat_attachments.js");

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

    #[cfg(feature = "implCon")]
    let (content, content_type) = match path {
        // 小白版：根路径 = 统一外壳（菜单 + 会话 + 内容区，三个菜单项都是页内视图切换）
        "/" | "/chat.html" | "/index.html" | "/novice.html" => (NOVICE_HTML, "text/html; charset=utf-8"),
        // 独立登录页：未登录访问主界面会整页跳到这里，刷新不会闪出主界面
        "/login" | "/login.html" => (NOVICE_LOGIN_HTML, "text/html; charset=utf-8"),
        "/novice_login.js" => (NOVICE_LOGIN_JS, "application/javascript; charset=utf-8"),
        "/style.css" => (STYLE_CSS, "text/css; charset=utf-8"),
        "/app.js" => (APP_JS, "application/javascript; charset=utf-8"),
        "/folderpick.js" => (FOLDERPICK_JS, "application/javascript; charset=utf-8"),
        "/common.js" => (COMMON_JS, "application/javascript; charset=utf-8"),
        "/node_core.js" => (NODE_CORE_JS, "application/javascript; charset=utf-8"),
        "/prompts_novice.js" => (PROMPTS_NOVICE_JS, "application/javascript; charset=utf-8"),
        "/novice.js" => (NOVICE_JS, "application/javascript; charset=utf-8"),
        "/novice_chat.js" => (NOVICE_CHAT_JS, "application/javascript; charset=utf-8"),
        "/chat_attachments.js" => (CHAT_ATTACHMENTS_JS, "application/javascript; charset=utf-8"),
        _ => {
            return HttpResponse::NotFound().body("Not Found");
        }
    };

    #[cfg(not(feature = "implCon"))]
    let (content, content_type) = match path {
        // 根路径落到补丁中心 SPA（默认「智能开发」页签）；聊天页改用 /chat.html（/index.html 保留兼容）
        "/" | "/patches.html" => (PATCHES_HTML, "text/html; charset=utf-8"),
        "/chat.html" | "/index.html" => (INDEX_HTML, "text/html; charset=utf-8"),
        "/style.css" => (STYLE_CSS, "text/css; charset=utf-8"),
        "/app.js" => (APP_JS, "application/javascript; charset=utf-8"),
        "/patches.js" => (PATCHES_JS, "application/javascript; charset=utf-8"),
        "/common.js" => (COMMON_JS, "application/javascript; charset=utf-8"),
        "/node_core.js" => (NODE_CORE_JS, "application/javascript; charset=utf-8"),
        "/prompts_novice.js" => (PROMPTS_NOVICE_JS, "application/javascript; charset=utf-8"),
        "/novice_chat.js" => (NOVICE_CHAT_JS, "application/javascript; charset=utf-8"),
        "/chat_attachments.js" => (CHAT_ATTACHMENTS_JS, "application/javascript; charset=utf-8"),
        "/sidenav.js" => (SIDENAV_JS, "application/javascript; charset=utf-8"),
        "/copybox.js" => (COPYBOX_JS, "application/javascript; charset=utf-8"),
        "/folderpick.js" => (FOLDERPICK_JS, "application/javascript; charset=utf-8"),
        "/workflow_run.html" => (WORKFLOW_RUN_HTML, "text/html; charset=utf-8"),
        "/node_run.html" => (NODE_RUN_HTML, "text/html; charset=utf-8"),
        "/adapt_run.html" => (ADAPT_RUN_HTML, "text/html; charset=utf-8"),
        "/server_replay.html" => (SERVER_REPLAY_HTML, "text/html; charset=utf-8"),
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
