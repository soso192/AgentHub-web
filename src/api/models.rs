use actix_web::{web, HttpResponse, HttpRequest};
use std::collections::HashMap;
use crate::models::{ModelsResponse, ModelInfo, DefaultModel};
use crate::AppState;

/// Get available models, optionally filtered by assistant name.
/// GET /api/models                → models from default assistant
/// GET /api/models?assistant=pi   → models from the "pi" assistant
pub async fn get_models(data: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let assistant_name = req.query_string()
        .split('&')
        .find_map(|p| {
            let mut parts = p.splitn(2, '=');
            if parts.next()? == "assistant" {
                parts.next().map(|v| v.to_string())
            } else {
                None
            }
        });

    let handle = {
        let registry = data.registry.read().unwrap();
        match assistant_name {
            Some(ref name) => registry.get_handle(name),
            None => registry.get_default_handle(),
        }
    };
    let handle = match handle {
        Some(h) => h,
        None => return HttpResponse::BadRequest().json(serde_json::json!({"error": "Assistant not found"})),
    };
    let assistant = handle.read().unwrap();

    let models_list = assistant.available_models();
    let default_model_id = assistant.default_model().to_string();
    let provider = assistant.name().to_string();
    
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
            provider,
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
