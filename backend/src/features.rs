//! Customer-local module availability and the last selected entry method.
use crate::{
    api::{ApiError, ApiResult, conflict},
    store::{AppState, audit},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{MySql, Transaction};

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EntryMode {
    #[default]
    Manual,
    Text,
}
impl EntryMode {
    pub(crate) fn is_manual(&self) -> bool {
        *self == Self::Manual
    }
    fn name(self) -> &'static str {
        if self == Self::Manual {
            "manual"
        } else {
            "text"
        }
    }
}
#[derive(Clone, Serialize, sqlx::FromRow)]
pub(crate) struct Features {
    pub layoffs: bool,
    pub manual_entry: bool,
    pub text_entry: bool,
    pub entry_mode: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FeatureInput {
    layoffs: bool,
    manual_entry: bool,
    text_entry: bool,
}
pub(crate) async fn read(pool: &sqlx::MySqlPool) -> Result<Features, sqlx::Error> {
    sqlx::query_as(
        "SELECT layoffs,manual_entry,text_entry,entry_mode FROM module_features WHERE id=1",
    )
    .fetch_one(pool)
    .await
}
pub(crate) async fn update(
    State(state): State<AppState>,
    Json(input): Json<FeatureInput>,
) -> ApiResult<Json<Features>> {
    let mut tx = state.pool.begin().await?;
    let current: Features = sqlx::query_as("SELECT layoffs,manual_entry,text_entry,entry_mode FROM module_features WHERE id=1 FOR UPDATE").fetch_one(&mut *tx).await?;
    let entry_mode = match (
        current.entry_mode.as_str(),
        input.manual_entry,
        input.text_entry,
    ) {
        ("text", _, true) => "text",
        (_, true, _) => "manual",
        (_, _, true) => "text",
        _ => current.entry_mode.as_str(),
    };
    sqlx::query(
        "UPDATE module_features SET layoffs=?,manual_entry=?,text_entry=?,entry_mode=? WHERE id=1",
    )
    .bind(input.layoffs)
    .bind(input.manual_entry)
    .bind(input.text_entry)
    .bind(entry_mode)
    .execute(&mut *tx)
    .await?;
    audit(&mut tx,None,"module_features_changed",json!({"layoffs":input.layoffs,"manual_entry":input.manual_entry,"text_entry":input.text_entry})).await?;
    tx.commit().await?;
    Ok(Json(read(&state.pool).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ModeInput {
    entry_mode: EntryMode,
}
pub(crate) async fn select_mode(
    State(state): State<AppState>,
    Json(input): Json<ModeInput>,
) -> ApiResult<Json<Features>> {
    let mut tx = state.pool.begin().await?;
    let row: Features=sqlx::query_as("SELECT layoffs,manual_entry,text_entry,entry_mode FROM module_features WHERE id=1 FOR UPDATE").fetch_one(&mut *tx).await?;
    if !available(&row, input.entry_mode) {
        return Err(conflict("该录注方式已关闭，请选择已开启的方式"));
    }
    sqlx::query("UPDATE module_features SET entry_mode=? WHERE id=1")
        .bind(input.entry_mode.name())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(read(&state.pool).await?))
}
fn available(features: &Features, mode: EntryMode) -> bool {
    match mode {
        EntryMode::Manual => features.manual_entry,
        EntryMode::Text => features.text_entry,
    }
}
async fn locked(tx: &mut Transaction<'_, MySql>) -> ApiResult<Features> {
    Ok(sqlx::query_as("SELECT layoffs,manual_entry,text_entry,entry_mode FROM module_features WHERE id=1 FOR SHARE").fetch_one(&mut **tx).await?)
}
pub(crate) async fn require_entry(
    tx: &mut Transaction<'_, MySql>,
    mode: EntryMode,
) -> ApiResult<()> {
    if !available(&locked(tx).await?, mode) {
        return Err(ApiError(StatusCode::FORBIDDEN, "该录注方式已关闭".into()));
    }
    Ok(())
}
pub(crate) async fn require_layoffs(tx: &mut Transaction<'_, MySql>) -> ApiResult<()> {
    if !locked(tx).await?.layoffs {
        return Err(ApiError(StatusCode::FORBIDDEN, "飞出投注功能已关闭".into()));
    }
    Ok(())
}
