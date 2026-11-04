use actix_web::HttpResponse;

/// 补丁中心/源码搜索等外部服务地址配置。
///
/// 来源两层：
/// 1. **运行时外置**：cc-web.exe 同目录的 `patch_servers.json`（部署后可直接改，无需重编）；
/// 2. **编译期内嵌**：`src/patch_servers.json`（include_str! 随 exe 打包，外置文件不存在时的默认值）。
///
/// 可配字段：
/// - `patch_search_servers`: patch_search 补丁中心后端地址列表（多条用于内网穿透隧道）；
/// - `code_search_url`: 源码搜索 Web 工具地址（补丁中心「源码搜索」页签的 iframe 嵌入地址），
///   留空则前端隐藏该页签。
const PATCH_SERVERS_CONFIG: &str = include_str!("../patch_servers.json");

/// exe 同目录的外置 patch_servers.json（存在则整体覆盖内嵌默认）。
fn runtime_config() -> Option<String> {
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("patch_servers.json")))?;
    if !path.is_file() {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

/// 生效配置文本：外置优先，缺失/读失败回落内嵌。
fn effective_config() -> String {
    runtime_config().unwrap_or_else(|| PATCH_SERVERS_CONFIG.to_string())
}

#[derive(serde::Deserialize, Default)]
struct Config {
    #[serde(default)]
    patch_search_servers: Vec<String>,
    #[serde(default)]
    code_search_url: String,
}

fn parse_config() -> Config {
    serde_json::from_str::<Config>(&effective_config()).unwrap_or_default()
}

/// 解析得到去空白的地址列表（保持配置文件中的顺序）。
pub fn patch_search_servers() -> Vec<String> {
    parse_config()
        .patch_search_servers
        .into_iter()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

/// 源码搜索 Web 工具地址（空 = 未配置，前端隐藏页签）。
pub fn code_search_url() -> String {
    parse_config().code_search_url.trim().trim_end_matches('/').to_string()
}

/// GET /api/patch-config —— 向补丁中心前端下发外部服务地址。
pub async fn get_patch_config() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "patch_search_servers": patch_search_servers(),
        "code_search_url": code_search_url(),
    }))
}
