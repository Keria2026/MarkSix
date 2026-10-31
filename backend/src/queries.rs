//! Read-only period, record and filter queries. Bet searches use typed JSON bodies.
use crate::{
    api::{ApiResult, conflict, missing},
    domain::*,
    store::*,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

#[derive(Deserialize, Default)]
pub(crate) struct PeriodQuery {
    page: Option<u32>,
    search: Option<String>,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct BetQuery {
    pub period: Option<String>,
    pub page: Option<u32>,
    pub min_amount: Option<String>,
    pub max_amount: Option<String>,
    #[serde(default)]
    pub bettors: Vec<String>,
    #[serde(default)]
    pub play_ids: Vec<i64>,
    pub order: Option<String>,
}
impl BetQuery {
    pub(crate) fn validate(&self) -> ApiResult<(Option<i64>, Option<i64>)> {
        let min = self
            .min_amount
            .as_deref()
            .map(|v| scaled(v, 2))
            .transpose()?;
        let max = self
            .max_amount
            .as_deref()
            .map(|v| scaled(v, 2))
            .transpose()?;
        if min.zip(max).is_some_and(|(a, b)| a > b) {
            return Err(conflict("金额下限不能超过上限"));
        }
        if self.bettors.len() > 1000
            || self.play_ids.len() > 1000
            || self.bettors.iter().any(|s| s.chars().count() > 80)
            || self.play_ids.iter().any(|n| *n <= 0)
        {
            return Err(conflict("筛选条件超出范围"));
        }
        if !matches!(
            self.order.as_deref().unwrap_or("newest"),
            "newest" | "amount_asc" | "amount_desc"
        ) {
            return Err(conflict("排序方式不合法"));
        }
        Ok((min, max))
    }
}
pub(crate) async fn periods(
    State(state): State<AppState>,
    Query(q): Query<PeriodQuery>,
) -> ApiResult<Json<Value>> {
    let page = q.page.unwrap_or(1).clamp(1, 100000);
    let search = format!(
        "%{}%",
        q.search
            .unwrap_or_default()
            .chars()
            .take(32)
            .collect::<String>()
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM periods WHERE id LIKE ? OR CAST(business_date AS CHAR) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(draw,'$.expect')) LIKE ?",
    )
    .bind(&search)
    .bind(&search)
    .bind(&search)
    .fetch_one(&state.pool)
    .await?;
    let rows:Vec<Period>=sqlx::query_as("SELECT * FROM periods WHERE id LIKE ? OR CAST(business_date AS CHAR) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(draw,'$.expect')) LIKE ? ORDER BY business_date DESC LIMIT 20 OFFSET ?").bind(&search).bind(&search).bind(&search).bind((page-1)*20).fetch_all(&state.pool).await?;
    let mut items = vec![];
    for p in rows {
        items.push(view(&state, p).await?);
    }
    Ok(Json(
        json!({"items":items,"total":count,"page":page,"page_size":20}),
    ))
}
pub(crate) async fn period(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<PeriodView>> {
    let p = sqlx::query_as("SELECT * FROM periods WHERE id=?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(missing)?;
    Ok(Json(view(&state, p).await?))
}
pub(crate) async fn search_bets(
    State(state): State<AppState>,
    Json(q): Json<BetQuery>,
) -> ApiResult<Json<Value>> {
    let (min, max) = q.validate()?;
    let id = q
        .period
        .unwrap_or_else(|| period_id(business_date(state.now())));
    let page = q.page.unwrap_or(1).clamp(1, 100000);
    let bettors = q.bettors;
    let plays = q.play_ids;
    let order = match q.order.as_deref().unwrap_or("newest") {
        "newest" => "created_at DESC,id DESC",
        "amount_asc" => "stake ASC,created_at DESC,id DESC",
        "amount_desc" => "stake DESC,created_at DESC,id DESC",
        _ => return Err(conflict("排序方式不合法")),
    };
    // JSON_CONTAINS is parameterized: names and IDs never become SQL text.
    let bettors_json = serde_json::to_string(&bettors).map_err(anyhow::Error::from)?;
    let plays_json = serde_json::to_string(&plays).map_err(anyhow::Error::from)?;
    let predicate = "period_id=? AND (? IS NULL OR stake>=?) AND (? IS NULL OR stake<=?) AND (JSON_LENGTH(?)=0 OR JSON_CONTAINS(?,JSON_QUOTE(bettor))) AND (JSON_LENGTH(?)=0 OR JSON_CONTAINS(?,CAST(play_id AS JSON)))";
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM bets WHERE {predicate}"))
        .bind(&id)
        .bind(min)
        .bind(min)
        .bind(max)
        .bind(max)
        .bind(&bettors_json)
        .bind(&bettors_json)
        .bind(&plays_json)
        .bind(&plays_json)
        .fetch_one(&state.pool)
        .await?;
    let items: Vec<BetSummary> = sqlx::query_as(&format!(
        "SELECT {BET_COLUMNS} FROM bets WHERE {predicate} ORDER BY {order} LIMIT 25 OFFSET ?"
    ))
    .bind(&id)
    .bind(min)
    .bind(min)
    .bind(max)
    .bind(max)
    .bind(&bettors_json)
    .bind(&bettors_json)
    .bind(&plays_json)
    .bind(&plays_json)
    .bind((page - 1) * 25)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        json!({"items":items,"total":count,"page":page,"page_size":25}),
    ))
}
pub(crate) async fn bet_filters(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let bettors: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT bettor FROM bets WHERE period_id=? ORDER BY bettor")
            .bind(&id)
            .fetch_all(&state.pool)
            .await?;
    // Snapshot names remain discoverable after a play is renamed or deleted.
    let rows = sqlx::query("SELECT play_id,CAST(MAX(JSON_UNQUOTE(JSON_EXTRACT(rule,'$.name'))) AS CHAR CHARACTER SET utf8mb4) name FROM bets WHERE period_id=? GROUP BY play_id ORDER BY name,play_id")
        .bind(&id).fetch_all(&state.pool).await?;
    let plays: Vec<Value> = rows
        .iter()
        .map(|row| Ok(json!({"id":row.try_get::<i64,_>("play_id")?,"name":row.try_get::<String,_>("name")?})))
        .collect::<Result<_, sqlx::Error>>()?;
    Ok(Json(json!({"period":id,"bettors":bettors,"plays":plays})))
}
