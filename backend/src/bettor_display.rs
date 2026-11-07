//! Shared bettor names and percentages affect the home presentation only.
use crate::{api::ApiResult, domain::scaled, ledger::party, store::AppState};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Input {
    bettor: String,
    percent: String,
}

pub(crate) async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, i32)> =
        sqlx::query_as("SELECT bettor,ratio FROM bettor_display_ratios ORDER BY bettor")
            .fetch_all(&state.pool)
            .await?;
    Ok(Json(
        json!({"items": rows.into_iter().map(|(bettor, ratio)| json!({"bettor":bettor,"ratio":ratio})).collect::<Vec<_>>()}),
    ))
}
pub(crate) async fn save(
    State(state): State<AppState>,
    Json(input): Json<Input>,
) -> ApiResult<Json<Value>> {
    let bettor = party(&input.bettor)?;
    let ratio = scaled(input.percent.trim(), 2)?;
    if ratio > 10000 {
        return Err("比例须在 0% 至 100% 之间".to_string().into());
    }
    sqlx::query("INSERT INTO bettor_display_ratios(bettor,ratio) VALUES(?,?) ON DUPLICATE KEY UPDATE ratio=VALUES(ratio)")
        .bind(&bettor).bind(ratio).execute(&state.pool).await?;
    Ok(Json(json!({"bettor":bettor,"ratio":ratio})))
}
pub(crate) async fn remove(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    let bettor = party(&name)?;
    sqlx::query("DELETE FROM bettor_display_ratios WHERE bettor=?")
        .bind(bettor)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"ok":true})))
}
