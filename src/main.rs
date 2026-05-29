use actix_web::{web, App, HttpServer, middleware};
use actix_cors::Cors;
use std::sync::Mutex;
use std::collections::HashMap;

mod api;
mod claude;
mod models;
mod static_files;

use claude::ClaudeManager;

pub struct AppState {
    pub claude_manager: Mutex<ClaudeManager>,
    pub sessions: Mutex<HashMap<String, models::Session>>,
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    println!("🚀 Starting CC-Web server...");
    println!("📍 Open http://localhost:3030 in your browser");

    let data = web::Data::new(AppState {
        claude_manager: Mutex::new(ClaudeManager::new()),
        sessions: Mutex::new(HashMap::new()),
    });

    HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .max_age(3600);

        App::new()
            .wrap(cors)
            .wrap(middleware::Logger::default())
            .app_data(data.clone())
            // API routes
            .route("/api/models", web::get().to(api::models::get_models))
            .route("/api/sessions", web::get().to(api::sessions::list_sessions))
            .route("/api/sessions/{id}", web::get().to(api::sessions::get_session))
            .route("/api/sessions/{id}", web::delete().to(api::sessions::delete_session))
            .route("/api/agent/new", web::post().to(api::agent::new_session))
            .route("/api/agent/{id}", web::post().to(api::agent::send_command))
            .route("/api/agent/{id}", web::get().to(api::agent::get_state))
            .route("/api/agent/{id}/events", web::get().to(api::agent::events))
            // Static files (fallback)
            .default_service(web::route().to(static_files::serve))
    })
    .bind("127.0.0.1:3030")?
    .run()
    .await
}
