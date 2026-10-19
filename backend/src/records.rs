//! Paginated receipt groups and point-in-time bettor statements.
use crate::{
    api::{ApiResult, ReceivedAt, conflict, missing},
    domain::*,
    ledger::{self, LedgerTotals},
    queries::BetQuery,
    store::*,
};
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, types::Json as DbJson};
use std::collections::{BTreeMap, HashMap};

#[derive(Serialize)]
pub(crate) struct RecordGroup {
    pub id: String,
    pub period_id: String,
    pub bettor: String,
    pub created_at: chrono::NaiveDateTime,
    pub grouped: bool,
    pub status: String,
    pub stake: i64,
    pub unit_count: i64,
    pub totals: LedgerTotals,
    pub items: Vec<BetSummary>,
}
pub(crate) fn group(mut items: Vec<BetSummary>) -> ApiResult<RecordGroup> {
    let first = items.first().ok_or_else(missing)?;
    let id = first.slip_id.clone().unwrap_or_else(|| first.id.clone());
    let grouped = first.slip_id.is_some();
    let period_id = first.period_id.clone();
    let bettor = first.bettor.clone();
    let created_at = items.iter().map(|b| b.created_at).min().unwrap();
    items.sort_by_key(|b| (b.slip_position.unwrap_or(0), b.created_at, b.id.clone()));
    let active: Vec<_> = items.iter().filter(|b| b.status != "cancelled").collect();
    let settled = active.iter().all(|b| b.status == "settled");
    let status = if active.is_empty() {
        "cancelled"
    } else if settled {
        "settled"
    } else {
        "pending"
    };
    let mut totals = LedgerTotals {
        net: settled.then_some(0),
        ..Default::default()
    };
    for b in &active {
        totals.add(
            (
                b.unit_count - b.void_units,
                b.stake,
                b.rebate,
                b.payout,
                b.void_stake,
            ),
            settled,
            false,
        )?;
    }
    Ok(RecordGroup {
        id,
        period_id,
        bettor,
        created_at,
        grouped,
        status: status.into(),
        stake: checked_sum(active.iter().map(|b| b.stake))?,
        unit_count: active.iter().map(|b| i64::from(b.unit_count)).sum(),
        totals,
        items,
    })
}
pub(crate) async fn search(
    State(state): State<AppState>,
    Json(q): Json<BetQuery>,
) -> ApiResult<Json<Value>> {
    let (min, max) = q.validate()?;
    let period = q.period.unwrap_or_else(|| period_id(state.now().date()));
    let page = q.page.unwrap_or(1).clamp(1, 100000);
    let bettors = serde_json::to_string(&q.bettors).map_err(anyhow::Error::from)?;
    let plays = serde_json::to_string(&q.play_ids).map_err(anyhow::Error::from)?;
    let amount = "SUM(CASE WHEN status<>'cancelled' THEN stake ELSE 0 END)";
    let grouped = format!(
        "SELECT COALESCE(slip_id,id) record_id FROM bets WHERE period_id=? AND (JSON_LENGTH(?)=0 OR JSON_CONTAINS(?,JSON_QUOTE(bettor))) GROUP BY COALESCE(slip_id,id) HAVING (? IS NULL OR {amount}>=?) AND (? IS NULL OR {amount}<=?) AND (JSON_LENGTH(?)=0 OR SUM(JSON_CONTAINS(?,CAST(play_id AS JSON)))>0)"
    );
    let order = match q.order.as_deref().unwrap_or("newest") {
        "amount_asc" => format!("{amount} ASC,MIN(created_at) DESC,record_id DESC"),
        "amount_desc" => format!("{amount} DESC,MIN(created_at) DESC,record_id DESC"),
        _ => "MIN(created_at) DESC,record_id DESC".into(),
    };
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM periods WHERE id=? FOR SHARE")
        .bind(&period)
        .fetch_optional(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM ({grouped}) groups_count"))
        .bind(&period)
        .bind(&bettors)
        .bind(&bettors)
        .bind(min)
        .bind(min)
        .bind(max)
        .bind(max)
        .bind(&plays)
        .bind(&plays)
        .fetch_one(&mut *tx)
        .await?;
    let ids: Vec<String> =
        sqlx::query_scalar(&format!("{grouped} ORDER BY {order} LIMIT 25 OFFSET ?"))
            .bind(&period)
            .bind(&bettors)
            .bind(&bettors)
            .bind(min)
            .bind(min)
            .bind(max)
            .bind(max)
            .bind(&plays)
            .bind(&plays)
            .bind((page - 1) * 25)
            .fetch_all(&mut *tx)
            .await?;
    let encoded = serde_json::to_string(&ids).map_err(anyhow::Error::from)?;
    let rows: Vec<BetSummary> = sqlx::query_as(&format!("SELECT {BET_COLUMNS} FROM bets WHERE period_id=? AND JSON_CONTAINS(?,JSON_QUOTE(COALESCE(slip_id,id)))"))
        .bind(&period).bind(encoded).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let mut groups = HashMap::<String, Vec<BetSummary>>::new();
    for row in rows {
        groups
            .entry(row.slip_id.clone().unwrap_or_else(|| row.id.clone()))
            .or_default()
            .push(row);
    }
    let items = ids
        .iter()
        .map(|id| group(groups.remove(id).unwrap_or_default()))
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(
        json!({"items":items,"total":count,"page":page,"page_size":25}),
    ))
}
pub(crate) async fn detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<RecordGroup>> {
    let items = sqlx::query_as(&format!(
        "SELECT {BET_COLUMNS} FROM bets WHERE slip_id=? ORDER BY slip_position"
    ))
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(group(items)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CancelInput {
    versions: Vec<CancelVersion>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelVersion {
    id: String,
    revision: i64,
}
pub(crate) async fn cancel(
    State(state): State<AppState>,
    Extension(ReceivedAt(received)): Extension<ReceivedAt>,
    Path(id): Path<String>,
    Json(input): Json<CancelInput>,
) -> ApiResult<Json<Value>> {
    if input.versions.is_empty() || input.versions.len() > 100 {
        return Err(conflict("组合单分项版本不完整，请刷新"));
    }
    let period: String = sqlx::query_scalar("SELECT period_id FROM bet_slips WHERE id=?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(missing)?;
    let mut tx = state.pool.begin().await?;
    let p: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR UPDATE")
        .bind(&period)
        .fetch_one(&mut *tx)
        .await?;
    let items: Vec<BetSummary> = sqlx::query_as(&format!(
        "SELECT {BET_COLUMNS} FROM bets WHERE slip_id=? ORDER BY id FOR UPDATE"
    ))
    .bind(&id)
    .fetch_all(&mut *tx)
    .await?;
    if items.is_empty() {
        return Err(missing());
    }
    if items.iter().all(|b| b.status == "cancelled") {
        return Ok(Json(json!({"ok":true})));
    }
    if p.state != "pending"
        || !is_open_between(received, p.business_date, &p.open_time, &p.close_time)
    {
        return Err(conflict("封盘后不能撤销组合单"));
    }
    let versions: HashMap<_, _> = input.versions.iter().map(|v| (&v.id, v.revision)).collect();
    if versions.len() != items.len()
        || versions.len() != input.versions.len()
        || items
            .iter()
            .any(|b| versions.get(&b.id) != Some(&b.revision))
    {
        return Err(conflict("组合单已变化，请刷新后重新确认"));
    }
    let outgoing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layoffs WHERE bet_id IN (SELECT id FROM bets WHERE slip_id=?) AND status<>'cancelled'")
        .bind(&id).fetch_one(&mut *tx).await?;
    if outgoing > 0 {
        return Err(conflict("请先撤销组合单分项关联的飞出，再撤销整单"));
    }
    for b in items.iter().filter(|b| b.status != "cancelled") {
        sqlx::query("UPDATE bets SET status='cancelled',revision=revision+1,cancelled_at=UTC_TIMESTAMP(6) WHERE id=?")
            .bind(&b.id).execute(&mut *tx).await?;
        audit(
            &mut tx,
            Some(&period),
            "bet_cancelled",
            json!({"id":b.id,"slip_id":id}),
        )
        .await?;
    }
    audit(&mut tx, Some(&period), "slip_cancelled", json!({"id":id})).await?;
    ledger::invalidate(&mut tx, &period).await?;
    tx.commit().await?;
    ledger::cancel_calculation(&state, &period).await;
    Ok(Json(json!({"ok":true})))
}

pub(crate) async fn export(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    // All mutations and settlement lock the period first: the statement is one ledger version.
    let period: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR SHARE")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(missing)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bets WHERE period_id=?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if count > 10000 {
        return Err(conflict(
            "本期含撤销的分项超过 10000 条，无法一次导出；未截断任何记录",
        ));
    }
    let rows = sqlx::query(&format!("SELECT {BET_COLUMNS},atoms,results FROM bets WHERE period_id=? ORDER BY created_at,slip_id,slip_position,id"))
        .bind(&id).fetch_all(&mut *tx).await?;
    let mut bettors = BTreeMap::<String, (LedgerTotals, Vec<Value>)>::new();
    let mut units = 0;
    for row in rows {
        let b = <BetSummary as sqlx::FromRow<sqlx::mysql::MySqlRow>>::from_row(&row)?;
        let atoms: DbJson<Vec<Atom>> = row.try_get("atoms")?;
        let results: Option<DbJson<Vec<AtomResult>>> = row.try_get("results")?;
        units += atoms.len();
        if units > 50000 {
            return Err(conflict(
                "本期含撤销的基础注超过 50000 条，无法一次导出；未截断任何记录",
            ));
        }
        let (totals, bets) = bettors.entry(b.bettor.clone()).or_insert_with(|| {
            (
                LedgerTotals {
                    net: (period.state == "settled").then_some(0),
                    ..Default::default()
                },
                vec![],
            )
        });
        if b.status != "cancelled" {
            totals.add(
                (
                    b.unit_count - b.void_units,
                    b.stake,
                    b.rebate,
                    b.payout,
                    b.void_stake,
                ),
                period.state == "settled",
                false,
            )?;
        }
        bets.push(json!({"record":b,"atoms":atoms,"results":results}));
    }
    tx.commit().await?;
    if bettors.len() > 1000 {
        return Err(conflict(
            "本期投注人超过 1000 位，无法一次导出；未截断任何记录",
        ));
    }
    let groups: Vec<_> = bettors
        .into_iter()
        .map(|(name, (totals, bets))| json!({"name":name,"totals":totals,"bets":bets}))
        .collect();
    Ok(Json(
        json!({"period":id,"settled":period.state=="settled","draw":period.draw,"bet_version":period.bet_version,"generated_at":state.now().format("%Y-%m-%d %H:%M:%S").to_string(),"bettors":groups}),
    ))
}
