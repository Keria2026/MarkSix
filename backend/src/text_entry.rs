//! Read-only slip planning and explicitly confirmed, tenant-local vocabulary.
use crate::{
    api::{ApiResult, ReceivedAt, conflict},
    betting::SlipLine,
    domain::*,
    ledger,
    store::{AppState, Period, Play},
};
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{MySql, Transaction};
use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub(crate) struct Preference {
    pub alias: String,
    pub play_id: i64,
    pub play_version: i64,
    pub amount_mode: String,
}

pub(crate) async fn preferences(State(state): State<AppState>) -> ApiResult<Json<Vec<Preference>>> {
    // Return stale entries too so the customer can remove them. Parsing only reuses
    // an entry when its bound play is enabled and the version still matches.
    let rows = sqlx::query_as::<_, Preference>(
        "SELECT CONVERT(alias USING utf8mb4) COLLATE utf8mb4_0900_as_cs AS alias,play_id,play_version,amount_mode FROM text_entry_preferences ORDER BY alias",
    ).fetch_all(&state.pool).await?;
    Ok(Json(rows))
}

pub(crate) async fn forget(
    State(state): State<AppState>,
    Path(alias): Path<String>,
) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM text_entry_preferences WHERE alias=?")
        .bind(alias)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"ok":true})))
}

pub(crate) async fn learn(
    tx: &mut Transaction<'_, MySql>,
    preferences: &[Preference],
    items: &[SlipLine],
) -> ApiResult<()> {
    if preferences.len() > 100 {
        return Err("一张单最多确认 100 个词条".to_owned().into());
    }
    let mut names = BTreeSet::new();
    for p in preferences {
        if p.alias.is_empty()
            || p.alias.chars().count() > 40
            || !p.alias.chars().all(char::is_alphanumeric)
            || !["auto", "each", "package", "total"].contains(&p.amount_mode.as_str())
            || !names.insert(&p.alias)
            || !items
                .iter()
                .any(|item| item.play_id == p.play_id && item.play_version == p.play_version)
        {
            return Err("学习词条必须绑定本单已确认的玩法，且名称和金额方式有效"
                .to_owned()
                .into());
        }
        sqlx::query("INSERT INTO text_entry_preferences(alias,play_id,play_version,amount_mode) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE play_id=VALUES(play_id),play_version=VALUES(play_version),amount_mode=VALUES(amount_mode)")
            .bind(&p.alias).bind(p.play_id).bind(p.play_version).bind(&p.amount_mode).execute(&mut **tx).await?;
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM text_entry_preferences")
        .fetch_one(&mut **tx)
        .await?;
    if count > 200 {
        return Err("最多记住 200 个词条，请先移除不再使用的习惯"
            .to_owned()
            .into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewInput {
    period: String,
    bettor: String,
    items: Vec<SlipLine>,
}

pub(crate) async fn preview(
    State(state): State<AppState>,
    Extension(ReceivedAt(received)): Extension<ReceivedAt>,
    Json(input): Json<PreviewInput>,
) -> ApiResult<Json<Value>> {
    ledger::party(&input.bettor)?;
    if input.items.is_empty() || input.items.len() > 100 {
        return Err("一张投注单须包含 1–100 个分项".to_owned().into());
    }
    let mut tx = state.pool.begin().await?;
    // Bootstrap creates the period. Preview itself never creates or mutates rows.
    let period: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR SHARE")
        .bind(&input.period)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| conflict("期次不存在，请刷新后重新预览"))?;
    if !accepts_entries(received, period.business_date) {
        return Err(conflict("期次已切换，请重新识别和预览"));
    }
    let mut plays = HashMap::new();
    for id in input
        .items
        .iter()
        .map(|i| i.play_id)
        .collect::<BTreeSet<_>>()
    {
        let play: Option<Play> = sqlx::query_as(
            "SELECT id,version,rule,enabled FROM plays WHERE id=? AND deleted_at IS NULL FOR SHARE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        plays.insert(id, play);
    }
    let mut results = Vec::new();
    let mut units = 0;
    let mut stake = 0_i64;
    let mut valid = true;
    for line in &input.items {
        let result = match plays.get(&line.play_id).and_then(Option::as_ref) {
            Some(play) if play.enabled && play.version == line.play_version => plan(
                &play.rule,
                &line.as_bet_input(&input.period, &input.bettor, ""),
                &period.mapping,
            ),
            _ => Err("玩法已变更、删除或停用，请重新确认".to_owned()),
        };
        match result {
            Ok(plan) => {
                units += plan.atoms.len();
                stake = stake
                    .checked_add(plan.stake)
                    .ok_or_else(|| conflict("整单金额超出范围"))?;
                results.push(json!({"units":plan.atoms.len(),"stake":plan.stake,"error":null}));
            }
            Err(error) => {
                valid = false;
                results.push(json!({"units":0,"stake":0,"error":error}));
            }
        }
    }
    let error = if units > MAX_UNITS {
        valid = false;
        Some("整单最多 1000 条基础注")
    } else {
        None
    };
    tx.rollback().await?;
    Ok(Json(
        json!({"valid":valid,"items":results,"units":units,"stake":stake,"error":error}),
    ))
}
