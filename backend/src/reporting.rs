//! Reporting follows immutable entry dates; settlement still follows market periods.
use crate::{
    api::{ApiResult, missing},
    domain::*,
    store::*,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{MySql, Transaction};

#[derive(Deserialize, Default)]
pub(crate) struct ReportQuery {
    #[serde(default)]
    pub combined: bool,
}
pub(crate) struct Scope {
    pub key: String,
    pub combined: bool,
    pub periods: Vec<Period>,
}
impl Scope {
    pub fn bets(&self) -> &'static str {
        if self.combined {
            "entry_date=?"
        } else {
            "period_id=?"
        }
    }
    pub fn layoffs(&self) -> &'static str {
        if self.combined {
            "bet_id IN (SELECT id FROM bets WHERE entry_date=?)"
        } else {
            "period_id=?"
        }
    }
    pub fn settled(&self, bets: &[BetSummary]) -> bool {
        let active: Vec<_> = bets.iter().filter(|b| b.status != "cancelled").collect();
        if active.is_empty() {
            self.periods.iter().all(|p| p.state == "settled")
        } else {
            active.iter().all(|b| b.status == "settled")
        }
    }
}
pub(crate) async fn scope(
    tx: &mut Transaction<'_, MySql>,
    id: &str,
    combined: bool,
) -> ApiResult<Scope> {
    // Macau anchor sorts before HK periods, matching every mixed-slip writer.
    let anchor: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR SHARE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(missing)?;
    if !combined {
        return Ok(Scope {
            key: id.into(),
            combined,
            periods: vec![anchor],
        });
    }
    if anchor.market != "macau" {
        return Err(missing());
    }
    let date = anchor.business_date;
    let mut periods = vec![anchor];
    let linked:Vec<Period>=sqlx::query_as("SELECT * FROM periods WHERE market='hk' AND id IN (SELECT period_id FROM bets WHERE entry_date=?) ORDER BY id FOR SHARE")
        .bind(date).fetch_all(&mut **tx).await?;
    periods.extend(linked);
    Ok(Scope {
        key: date.to_string(),
        combined,
        periods,
    })
}
#[derive(Serialize)]
pub(crate) struct BusinessDay {
    pub id: String,
    pub business_date: NaiveDate,
    pub state: String,
    pub phase: String,
    pub totals: Totals,
    pub periods: Vec<Period>,
}
pub(crate) async fn view(state: &AppState, id: &str) -> ApiResult<BusinessDay> {
    let mut tx = state.pool.begin().await?;
    let scope = scope(&mut tx, id, true).await?;
    let pending: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM bets WHERE entry_date=? AND status='pending'")
            .bind(&scope.key)
            .fetch_one(&mut *tx)
            .await?;
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM bets WHERE entry_date=? AND status<>'cancelled'")
            .bind(&scope.key)
            .fetch_one(&mut *tx)
            .await?;
    let settled = pending == 0 && (count > 0 || scope.periods.iter().all(|p| p.state == "settled"));
    let totals = totals_where(&mut tx, scope.bets(), scope.layoffs(), &scope.key, settled).await?;
    let date = scope.periods[0].business_date;
    let phase = if settled {
        "settled"
    } else if state.now() >= draw_fetch_start(date) {
        "fetching"
    } else {
        "open"
    };
    tx.commit().await?;
    Ok(BusinessDay {
        id: id.into(),
        business_date: date,
        state: if settled { "settled" } else { "pending" }.into(),
        phase: phase.into(),
        totals,
        periods: scope.periods,
    })
}
pub(crate) async fn day(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<BusinessDay>> {
    Ok(Json(view(&state, &id).await?))
}
#[derive(Deserialize, Default)]
pub(crate) struct DayQuery {
    page: Option<u32>,
    search: Option<String>,
}
pub(crate) async fn days(
    State(state): State<AppState>,
    Query(q): Query<DayQuery>,
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
    let predicate = "market='macau' AND (id LIKE ? OR CAST(business_date AS CHAR) LIKE ? OR EXISTS(SELECT 1 FROM bets b JOIN periods draw ON draw.id=b.period_id WHERE b.entry_date=periods.business_date AND JSON_UNQUOTE(JSON_EXTRACT(draw.draw,'$.expect')) LIKE ?))";
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM periods WHERE {predicate}"))
        .bind(&search)
        .bind(&search)
        .bind(&search)
        .fetch_one(&state.pool)
        .await?;
    let ids: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT id FROM periods WHERE {predicate} ORDER BY business_date DESC LIMIT 20 OFFSET ?"
    ))
    .bind(&search)
    .bind(&search)
    .bind(&search)
    .bind((page - 1) * 20)
    .fetch_all(&state.pool)
    .await?;
    let mut items = vec![];
    for id in ids {
        items.push(view(&state, &id).await?);
    }
    Ok(Json(
        json!({"items":items,"total":count,"page":page,"page_size":20}),
    ))
}
