use actix_web::{web, HttpResponse};
use std::collections::HashMap;
use crate::models::{ModelsResponse, ModelInfo, DefaultModel};
use crate::AppState;

pub async fn get_models(_data: web::Data<AppState>) -> HttpResponse {
    let mut models = HashMap::new();
    
    // Try to read Claude settings
    let settings = dirs::home_dir()
        .map(|h| h.join(".claude").join("settings.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

    let default_model = if let Some(ref settings) = settings {
        settings.get("env")
            .and_then(|e| e.get("ANTHROPIC_MODEL"))
            .and_then(|m| m.as_str())
            .unwrap_or("MiniMax-M2.7")
            .to_string()
    } else {
        "MiniMax-M2.7".to_string()
    };

    // Add models
    models.insert(default_model.clone(), default_model.clone());
    models.insert("claude-sonnet-4-20250514".to_string(), "Claude Sonnet 4".to_string());
    models.insert("claude-opus-4-20250514".to_string(), "Claude Opus 4".to_string());
    models.insert("claude-haiku-3-20240307".to_string(), "Claude Haiku 3".to_string());

    let model_list: Vec<ModelInfo> = models.iter().map(|(id, name)| {
        ModelInfo {
            id: id.clone(),
            name: name.clone(),
            provider: "anthropic".to_string(),
        }
    }).collect();

    let response = ModelsResponse {
        models,
        model_list,
        default_model: DefaultModel {
            provider: "anthropic".to_string(),
            model_id: default_model,
        },
    };

    HttpResponse::Ok().json(response)
}
