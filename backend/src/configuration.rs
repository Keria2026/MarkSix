//! Versioned rule configuration. Imports and batch changes are atomic; bet snapshots are immutable.
use crate::{
    api::{ApiResult, conflict, missing},
    domain::Rule,
    store::{AppState, Play, audit},
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::types::Json as DbJson;
use std::collections::{HashMap, HashSet};

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
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.format != "marksix-play-rules" || self.schema != 1 {
            return Err(String::from("不是支持的 MarkSix 玩法文件（schema 1）"));
        }
        if self.plays.is_empty() || self.plays.len() > 1000 {
            return Err(String::from("每个文件须包含 1–1000 条玩法"));
        }
        let mut names = HashSet::new();
        for (i, p) in self.plays.iter().enumerate() {
            if !names.insert(p.rule.name.trim()) {
                return Err(format!("文件包含重复玩法名称：{}", p.rule.name.trim()));
            }
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
    let rows: Vec<Play> = sqlx::query_as("SELECT id,version,rule,enabled FROM plays WHERE deleted_at IS NULL AND (? IS NULL OR id=?) ORDER BY sort_order,id")
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
    let existing: Vec<Play> = sqlx::query_as(
        "SELECT id,version,rule,enabled FROM plays WHERE deleted_at IS NULL ORDER BY id FOR UPDATE",
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut by_name: HashMap<String, Vec<&Play>> = HashMap::new();
    for play in &existing {
        by_name
            .entry(play.rule.name.trim().to_string())
            .or_default()
            .push(play);
    }
    let added = file
        .plays
        .iter()
        .filter(|p| !by_name.contains_key(p.rule.name.trim()))
        .count();
    if existing.len() + added > 1000 {
        return Err(String::from("玩法总数不能超过 1000 条").into());
    }
    let mut ids = vec![];
    let mut updated = 0;
    for p in file.plays {
        if let Some(matches) = by_name.get(p.rule.name.trim()) {
            if matches.len() != 1 {
                return Err(conflict(&format!(
                    "现有玩法「{}」重名，请先重命名或删除重复项后导入",
                    p.rule.name
                )));
            }
            let play = matches[0];
            let version = play.version + 1;
            sqlx::query("UPDATE plays SET version=?,rule=?,enabled=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?")
                .bind(version).bind(DbJson(&p.rule)).bind(p.enabled).bind(play.id).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO play_versions(play_id,version,rule) VALUES(?,?,?)")
                .bind(play.id)
                .bind(version)
                .bind(DbJson(&p.rule))
                .execute(&mut *tx)
                .await?;
            audit(
                &mut tx,
                None,
                "play_import_updated",
                json!({"id":play.id,"version":version,"rule":p.rule,"enabled":p.enabled}),
            )
            .await?;
            ids.push(play.id);
            updated += 1;
        } else {
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
    }
    tx.commit().await?;
    Ok(Json(
        json!({"ids":ids,"imported":ids.len(),"created":added,"updated":updated}),
    ))
}

pub fn bundled() -> Result<PlayFile, String> {
    let file: PlayFile =
        serde_json::from_str(include_str!("default-plays.json")).map_err(|e| e.to_string())?;
    file.validate()?;
    Ok(file)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchTarget {
    id: i64,
    version: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlayOrder {
    plays: Vec<BatchTarget>,
}
pub async fn reorder(
    State(state): State<AppState>,
    Json(input): Json<PlayOrder>,
) -> ApiResult<Json<Value>> {
    if input.plays.is_empty() || input.plays.len() > 1000 {
        return Err("排序须包含 1–1000 条玩法".to_string().into());
    }
    let mut ids = HashSet::new();
    if input.plays.iter().any(|p| p.id <= 0 || !ids.insert(p.id)) {
        return Err("排序包含重复或无效玩法".to_string().into());
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM administrators WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let existing: Vec<Play> = sqlx::query_as(
        "SELECT id,version,rule,enabled FROM plays WHERE deleted_at IS NULL ORDER BY id FOR UPDATE",
    )
    .fetch_all(&mut *tx)
    .await?;
    if existing.len() != input.plays.len()
        || existing.iter().any(|p| {
            !input
                .plays
                .iter()
                .any(|target| target.id == p.id && target.version == p.version)
        })
    {
        return Err(conflict("玩法列表已变化，请刷新后重新排序"));
    }
    for (position, p) in input.plays.iter().enumerate() {
        sqlx::query("UPDATE plays SET sort_order=? WHERE id=?")
            .bind(position as i64)
            .bind(p.id)
            .execute(&mut *tx)
            .await?;
    }
    audit(
        &mut tx,
        None,
        "plays_reordered",
        json!({"ids":input.plays.iter().map(|p|p.id).collect::<Vec<_>>()}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct BatchInput {
    targets: Vec<BatchTarget>,
    #[serde(flatten)]
    change: BatchChange,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum BatchChange {
    Delete,
    Update {
        odds: Option<String>,
        rebate_percent: Option<String>,
        enabled: Option<bool>,
        #[serde(default)]
        rule: serde_json::Map<String, Value>,
    },
}
pub async fn batch(
    State(state): State<AppState>,
    Json(input): Json<BatchInput>,
) -> ApiResult<Json<Value>> {
    if input.targets.is_empty() || input.targets.len() > 1000 {
        return Err(String::from("请选择 1–1000 条玩法").into());
    }
    let mut targets = input.targets;
    targets.sort_by_key(|p| p.id);
    if targets.windows(2).any(|p| p[0].id == p[1].id) {
        return Err(String::from("批量操作包含重复玩法").into());
    }
    if let BatchChange::Update {
        odds,
        rebate_percent,
        enabled,
        rule,
    } = &input.change
    {
        if odds.is_none() && rebate_percent.is_none() && enabled.is_none() && rule.is_empty() {
            return Err(String::from("请至少设置一个批量修改字段").into());
        }
        const FIELDS: &[&str] = &[
            "kind",
            "scope",
            "condition",
            "relation",
            "quantity",
            "combination_size",
            "compound_enabled",
            "selection_limit",
            "zodiac_count",
            "special_hit_odds",
            "minimum_hits",
            "special_odds",
            "zero_tail_odds",
            "special_rebate_percent",
        ];
        if rule.keys().any(|key| !FIELDS.contains(&key.as_str())) {
            return Err(String::from("批量规则包含不支持的字段；名称不可批量修改").into());
        }
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM administrators WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    for target in &targets {
        let mut play: Play = sqlx::query_as("SELECT id,version,rule,enabled FROM plays WHERE id=? AND deleted_at IS NULL FOR UPDATE")
            .bind(target.id).fetch_optional(&mut *tx).await?.ok_or_else(missing)?;
        if play.version != target.version {
            return Err(conflict("所选玩法已变化，请刷新后重新选择；整批尚未保存"));
        }
        match &input.change {
            BatchChange::Delete => {
                sqlx::query(
                    "UPDATE plays SET deleted_at=UTC_TIMESTAMP(6),enabled=false WHERE id=?",
                )
                .bind(play.id)
                .execute(&mut *tx)
                .await?;
                audit(
                    &mut tx,
                    None,
                    "play_deleted",
                    json!({"id":play.id,"version":play.version,"batch":true}),
                )
                .await?;
            }
            BatchChange::Update {
                odds,
                rebate_percent,
                enabled,
                rule,
            } => {
                let mut merged = serde_json::to_value(&play.rule.0).map_err(anyhow::Error::from)?;
                merged.as_object_mut().unwrap().extend(rule.clone());
                play.rule.0 = serde_json::from_value(merged).map_err(|_| {
                    format!(
                        "{}：批量设置的字段类型或值不合法；整批尚未保存",
                        play.rule.name
                    )
                })?;
                if let Some(value) = odds {
                    play.rule.odds = value.clone();
                }
                if let Some(value) = rebate_percent {
                    play.rule.rebate_percent = value.clone();
                }
                play.rule
                    .validate()
                    .map_err(|message| format!("{}：{message}；整批尚未保存", play.rule.name))?;
                let version = play.version + 1;
                let enabled = enabled.unwrap_or(play.enabled);
                sqlx::query("UPDATE plays SET version=?,rule=?,enabled=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?")
                    .bind(version).bind(DbJson(&play.rule.0)).bind(enabled).bind(play.id).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO play_versions(play_id,version,rule) VALUES(?,?,?)")
                    .bind(play.id)
                    .bind(version)
                    .bind(DbJson(&play.rule.0))
                    .execute(&mut *tx)
                    .await?;
                audit(&mut tx,None,"play_updated",json!({"id":play.id,"version":version,"rule":play.rule.0,"enabled":enabled,"batch":true})).await?;
            }
        }
    }
    tx.commit().await?;
    Ok(Json(json!({"changed":targets.len()})))
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
