//! Portable rule-only configuration. Import is additive and atomic; history is immutable.
use crate::{
    api::{ApiError, ApiResult, conflict, missing},
    domain::Rule,
    store::{AppState, Play, audit},
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::types::Json as DbJson;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortablePlay {
    pub rule: Rule,
    pub enabled: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlayFile {
    pub format: String,
    pub schema: u32,
    pub plays: Vec<PortablePlay>,
}
impl PlayFile {
    fn validate(&self) -> Result<(), String> {
        if self.format != "marksix-play-rules" || self.schema != 1 {
            return Err("不是支持的 MarkSix 玩法文件（schema 1）".into());
        }
        if self.plays.is_empty() || self.plays.len() > 1000 {
            return Err("每个文件须包含 1–1000 条玩法".into());
        }
        for (i, p) in self.plays.iter().enumerate() {
            p.rule
                .validate()
                .map_err(|e| format!("第 {} 条玩法：{e}", i + 1))?;
        }
        Ok(())
    }
}
#[derive(Deserialize)]
pub struct ExportQuery {
    id: Option<i64>,
}
pub async fn export(
    State(state): State<AppState>,
    Query(query): Query<ExportQuery>,
) -> ApiResult<Json<PlayFile>> {
    let rows: Vec<Play> = sqlx::query_as("SELECT id,version,rule,enabled FROM plays WHERE deleted_at IS NULL AND (? IS NULL OR id=?) ORDER BY id")
        .bind(query.id).bind(query.id).fetch_all(&state.pool).await?;
    if query.id.is_some() && rows.is_empty() {
        return Err(missing());
    }
    Ok(Json(PlayFile {
        format: "marksix-play-rules".into(),
        schema: 1,
        plays: rows
            .into_iter()
            .map(|p| PortablePlay {
                rule: p.rule.0,
                enabled: p.enabled,
            })
            .collect(),
    }))
}
pub async fn import(
    State(state): State<AppState>,
    Json(file): Json<PlayFile>,
) -> ApiResult<Json<Value>> {
    file.validate()?;
    let mut tx = state.pool.begin().await?;
    // Administrator row serializes imports and creation, avoiding capacity races.
    sqlx::query("SELECT id FROM administrators WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plays WHERE deleted_at IS NULL")
        .fetch_one(&mut *tx)
        .await?;
    if count + file.plays.len() as i64 > 1000 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "玩法总数不能超过 1000 条".into(),
        ));
    }
    let mut ids = vec![];
    for p in file.plays {
        let result = sqlx::query("INSERT INTO plays(version,rule,enabled) VALUES(1,?,?)")
            .bind(DbJson(&p.rule))
            .bind(p.enabled)
            .execute(&mut *tx)
            .await?;
        let id = result.last_insert_id() as i64;
        sqlx::query("INSERT INTO play_versions(play_id,version,rule) VALUES(?,1,?)")
            .bind(id)
            .bind(DbJson(&p.rule))
            .execute(&mut *tx)
            .await?;
        audit(
            &mut tx,
            None,
            "play_imported",
            json!({"id":id,"rule":p.rule,"enabled":p.enabled}),
        )
        .await?;
        ids.push(id);
    }
    tx.commit().await?;
    Ok(Json(json!({"ids":ids,"imported":ids.len()})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeletePlay {
    version: i64,
}
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<DeletePlay>,
) -> ApiResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let play: Play = sqlx::query_as(
        "SELECT id,version,rule,enabled FROM plays WHERE id=? AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(missing)?;
    if play.version != input.version {
        return Err(conflict("玩法已变化，请刷新后重新删除"));
    }
    sqlx::query("UPDATE plays SET deleted_at=UTC_TIMESTAMP(6),enabled=false WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        None,
        "play_deleted",
        json!({"id":id,"version":play.version,"rule":play.rule.0}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
