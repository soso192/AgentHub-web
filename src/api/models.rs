use actix_web::{web, HttpResponse};
use std::collections::HashMap;
use crate::models::{ModelsResponse, ModelInfo, DefaultModel};
use crate::AppState;

/// Get available models from the default assistant
pub async fn get_models(data: web::Data<AppState>) -> HttpResponse {
    let handle = {
        let registry = data.registry.read().unwrap();
        registry.get_default_handle()
    };
    let handle = match handle {
        Some(h) => h,
        None => return HttpResponse::InternalServerError().json(serde_json::json!({"error": "No default assistant"})),
    };
    let assistant = handle.read().unwrap();

    let models_list = assistant.available_models();
    let default_model_id = assistant.default_model().to_string();
    
    let mut models = HashMap::new();
    let model_list: Vec<ModelInfo> = models_list.iter().map(|m| {
        models.insert(m.id.clone(), m.name.clone());
        ModelInfo {
            id: m.id.clone(),
            name: m.name.clone(),
            provider: m.provider.clone(),
        }
    }).collect();

    let response = ModelsResponse {
        models,
        model_list,
        default_model: DefaultModel {
            provider: "anthropic".to_string(),
            model_id: default_model_id,
        },
    };

    HttpResponse::Ok().json(response)
}

/// List all registered assistants with availability status
pub async fn list_assistants(data: web::Data<AppState>) -> HttpResponse {
    let mut registry = data.registry.write().unwrap();
    let assistants = registry.list_available().await;

    HttpResponse::Ok().json(serde_json::json!({
        "assistants": assistants
    }))
}
