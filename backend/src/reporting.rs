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
    pub creator: Option<uuid::Uuid>,
}
impl Scope {
    pub fn bets(&self) -> String {
        let base = if self.combined {
            "entry_date=?"
        } else {
            "period_id=?"
        };
        format!("{base} AND {}", creator_predicate(self.creator))
    }
    pub fn layoffs(&self) -> String {
        format!("bet_id IN (SELECT id FROM bets WHERE {})", self.bets())
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
            creator: None,
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
        creator: None,
    })
}
pub(crate) async fn visible_scope(
    state: &AppState,
    tx: &mut Transaction<'_, MySql>,
    id: &str,
    combined: bool,
) -> ApiResult<Scope> {
    let mut value = scope(tx, id, combined).await?;
    value.creator = state.visible_creator;
    Ok(value)
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
    let scope = visible_scope(state, &mut tx, id, true).await?;
    let pending: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM bets WHERE {} AND status='pending'",
        scope.bets()
    ))
    .bind(&scope.key)
    .fetch_one(&mut *tx)
    .await?;
    let count: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM bets WHERE {} AND status<>'cancelled'",
        scope.bets()
    ))
    .bind(&scope.key)
    .fetch_one(&mut *tx)
    .await?;
    let settled = pending == 0 && (count > 0 || scope.periods.iter().all(|p| p.state == "settled"));
    let totals = totals_where(
        &mut tx,
        &scope.bets(),
        &scope.layoffs(),
        &scope.key,
        settled,
    )
    .await?;
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

#[derive(Serialize)]
pub(crate) struct ReceivedDistribution {
    special: Vec<i64>,
    zodiac: Vec<i64>,
    tail: Vec<i64>,
}
impl ReceivedDistribution {
    fn empty() -> Self {
        Self {
            special: vec![0; 49],
            zodiac: vec![0; 12],
            tail: vec![0; 10],
        }
    }
    fn add(&mut self, atom: &Atom) -> RuleResult<()> {
        if atom.options.len() != 1 || atom.condition != Condition::All {
            return Ok(());
        }
        let option = atom.options[0] as usize;
        let bucket = match (atom.kind, atom.scope) {
            (Kind::Number, crate::domain::Scope::Special) if (1..=49).contains(&option) => {
                &mut self.special[option - 1]
            }
            (Kind::Zodiac, crate::domain::Scope::All) if option < 12 => &mut self.zodiac[option],
            (Kind::Tail, crate::domain::Scope::All) if option < 10 => &mut self.tail[option],
            _ => return Ok(()),
        };
        *bucket = checked_sum([*bucket, atom.stake])?;
        Ok(())
    }
}
#[derive(Deserialize, Default)]
pub(crate) struct ReceivedQuery {
    #[serde(default)]
    combined: bool,
    market: Option<crate::market::Market>,
}
pub(crate) async fn received_distribution(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ReceivedQuery>,
) -> ApiResult<Json<ReceivedDistribution>> {
    let mut tx = state.pool.begin().await?;
    let scope = visible_scope(&state, &mut tx, &id, query.combined).await?;
    let rows: Vec<(String, sqlx::types::Json<Vec<Atom>>)> = sqlx::query_as(&format!(
        "SELECT period_id,atoms FROM bets WHERE {} AND (? IS NULL OR market=?) AND status<>'cancelled' AND JSON_UNQUOTE(JSON_EXTRACT(rule,'$.kind')) IN ('number','zodiac','tail') AND JSON_UNQUOTE(JSON_EXTRACT(rule,'$.condition'))='all'",scope.bets()
    )).bind(&scope.key)
        .bind(query.market.map(crate::market::Market::as_str))
        .bind(query.market.map(crate::market::Market::as_str))
        .fetch_all(&mut *tx).await?;
    let mut distribution = ReceivedDistribution::empty();
    for (period_id, atoms) in rows {
        let draw = scope
            .periods
            .iter()
            .find(|p| p.id == period_id)
            .and_then(|p| p.draw.as_ref());
        for atom in &atoms.0 {
            if !draw.is_some_and(|d| is_void(atom, d)) {
                distribution.add(atom)?;
            }
        }
    }
    // The response remains within the same exact integer range as ledger money.
    checked_sum(distribution.special.iter().copied())?;
    checked_sum(distribution.zodiac.iter().copied())?;
    checked_sum(distribution.tail.iter().copied())?;
    tx.commit().await?;
    Ok(Json(distribution))
}

#[cfg(test)]
#[path = "../tests/support/received.rs"]
mod received_contracts;
