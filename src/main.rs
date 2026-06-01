use actix_web::{web, App, HttpServer, middleware};
use actix_cors::Cors;
use std::sync::Mutex;
use tokio::sync::broadcast;

mod api;
mod ai;
mod models;
mod static_files;

use ai::{AssistantRegistry, AiAssistant};
use ai::claude::ClaudeAssistant;
use ai::pi::PiAssistant;

pub struct AppState {
    pub registry: Mutex<AssistantRegistry>,
    pub sessions: Mutex<std::collections::HashMap<String, models::Session>>,
    pub events_tx: Mutex<std::collections::HashMap<String, broadcast::Sender<String>>>,
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    println!("🚀 Starting CC-Web server...");
    println!("📍 Open http://localhost:3030 in your browser");

    // Initialize AI assistant registry
    let mut registry = AssistantRegistry::new();
    
    // Register Claude Code assistant
    let claude = ClaudeAssistant::new();
    println!("✅ Claude Code registered (default model: {})", claude.default_model());
    registry.register(Box::new(claude));

    // Register Pi Agent assistant
    let pi = PiAssistant::new();
    println!("✅ Pi Agent registered (default model: {})", pi.default_model());
    registry.register(Box::new(pi));

    let data = web::Data::new(AppState {
        registry: Mutex::new(registry),
        sessions: Mutex::new(std::collections::HashMap::new()),
        events_tx: Mutex::new(std::collections::HashMap::new()),
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
            .route("/api/assistants", web::get().to(api::models::list_assistants))
            .route("/api/sessions", web::get().to(api::sessions::list_sessions))
            .route("/api/sessions/{id}", web::get().to(api::sessions::get_session))
            .route("/api/sessions/{id}", web::delete().to(api::sessions::delete_session))
            .route("/api/agent/new", web::post().to(api::agent::new_session))
            .route("/api/agent/{id}/start", web::post().to(api::agent::start_prompt))
            .route("/api/agent/{id}/switch", web::post().to(api::agent::switch_assistant))
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
