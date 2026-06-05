use actix_web::{web, HttpResponse, HttpRequest};
use std::collections::HashMap;
use crate::models::{ModelsResponse, ModelInfo, DefaultModel};
use crate::AppState;

/// Get available models, optionally filtered by assistant name.
///
/// Each AI assistant (Claude, Pi, Codex) has its own set of supported models.
/// This endpoint returns the model list for a specific assistant, or the
/// default assistant if no query parameter is provided.
///
/// # Query Parameters
/// - `assistant` (optional): The assistant name to filter by (e.g. "pi", "claude")
///
/// # Examples
/// - `GET /api/models`                → models from the default assistant (Claude)
/// - `GET /api/models?assistant=pi`   → models from the Pi Agent
/// - `GET /api/models?assistant=codex`→ models from Codex
pub async fn get_models(data: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    // Parse the `assistant` query parameter manually.
    // We avoid pulling in a full query-string crate for this single parameter.
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

    // Look up the assistant handle by name, or fall back to the default.
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

    // Query the assistant for its supported models and default model.
    let models_list = assistant.available_models();
    let default_model_id = assistant.default_model().to_string();
    let provider = assistant.name().to_string();  // e.g. "claude", "pi", "codex"
    
    // Build the response: a HashMap of id→name, a detailed model list,
    // and the default model info.
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
