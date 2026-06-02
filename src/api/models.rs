use actix_web::{web, HttpResponse};
use std::collections::HashMap;
use crate::models::{ModelsResponse, ModelInfo, DefaultModel};
use crate::AppState;

/// Get available models from the default assistant
pub async fn get_models(data: web::Data<AppState>) -> HttpResponse {
    let registry = data.registry.lock().unwrap();
    let assistant = registry.get_default();
    
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

/// List all registered assistants
pub async fn list_assistants(data: web::Data<AppState>) -> HttpResponse {
    let registry = data.registry.lock().unwrap();
    let assistants = registry.list();
    
    HttpResponse::Ok().json(serde_json::json!({
        "assistants": assistants
    }))
}
