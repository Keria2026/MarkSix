//! Home presentation only: accepted bets, settlement and exports never read these offsets.
use crate::{
    api::{ApiResult, ReceivedAt, conflict, digest},
    domain::{MONEY_LIMIT, RuleResult, business_date, checked_sum, scaled},
    market::Market,
    reporting::{ReceivedDistribution, read_distribution, visible_scope},
    store::AppState,
};
use axum::{
    Extension, Json,
    extract::{Path, Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::types::Json as DbJson;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DisplayKind {
    Special,
    Zodiac,
    Tail,
}
impl DisplayKind {
    fn values(self, distribution: &ReceivedDistribution) -> &[i64] {
        match self {
            Self::Special => &distribution.special,
            Self::Zodiac => &distribution.zodiac,
            Self::Tail => &distribution.tail,
        }
    }
    fn values_mut(self, distribution: &mut ReceivedDistribution) -> &mut Vec<i64> {
        match self {
            Self::Special => &mut distribution.special,
            Self::Zodiac => &mut distribution.zodiac,
            Self::Tail => &mut distribution.tail,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DisplayQuery {
    market: Market,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Item {
    index: usize,
    amount: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Change {
    Deduct { items: Vec<Item> },
    Reset,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Input {
    request_id: String,
    revision: i64,
    kind: DisplayKind,
    change: Change,
}
#[derive(Serialize)]
pub(crate) struct Display {
    received: ReceivedDistribution,
    deducted: ReceivedDistribution,
    display: ReceivedDistribution,
    revision: i64,
}
fn validate(value: &ReceivedDistribution) -> RuleResult<()> {
    for (kind, size) in [
        (DisplayKind::Special, 49),
        (DisplayKind::Zodiac, 12),
        (DisplayKind::Tail, 10),
    ] {
        let amounts = kind.values(value);
        if amounts.len() != size || amounts.iter().any(|n| *n < 0 || *n > MONEY_LIMIT) {
            return Err("首页减出数据不完整，请刷新重试".into());
        }
        checked_sum(amounts.iter().copied())?;
    }
    Ok(())
}
fn presentation(
    received: ReceivedDistribution,
    deducted: ReceivedDistribution,
    revision: i64,
) -> RuleResult<Display> {
    validate(&received)?;
    validate(&deducted)?;
    if revision < 0 {
        return Err("首页减出版本无效，请刷新重试".into());
    }
    let mut display = received.clone();
    for kind in [DisplayKind::Special, DisplayKind::Zodiac, DisplayKind::Tail] {
        for (amount, offset) in kind
            .values_mut(&mut display)
            .iter_mut()
            .zip(kind.values(&deducted))
        {
            *amount = (*amount - *offset).max(0);
        }
    }
    Ok(Display {
        received,
        deducted,
        display,
        revision,
    })
}
fn apply(
    received: &ReceivedDistribution,
    mut deducted: ReceivedDistribution,
    kind: DisplayKind,
    change: &Change,
) -> RuleResult<ReceivedDistribution> {
    validate(received)?;
    validate(&deducted)?;
    match change {
        Change::Reset => kind.values_mut(&mut deducted).fill(0),
        Change::Deduct { items } => {
            let limit = kind.values(received).len();
            let mut seen = HashSet::new();
            if items.is_empty() || items.len() > limit {
                return Err("请选择要减出的项目".into());
            }
            for item in items {
                if item.index >= limit || !seen.insert(item.index) {
                    return Err("减出项目超出范围或重复".into());
                }
                let amount = scaled(&item.amount, 2)?;
                if amount <= 0 {
                    return Err("减出金额须大于零，最多两位小数".into());
                }
                let available =
                    (kind.values(received)[item.index] - kind.values(&deducted)[item.index]).max(0);
                if amount > available {
                    return Err("减出金额超过当前首页显示金额，请刷新后确认".into());
                }
                let slot = &mut kind.values_mut(&mut deducted)[item.index];
                *slot = checked_sum([*slot, amount])?;
            }
        }
    }
    validate(&deducted)?;
    Ok(deducted)
}
fn creator(state: &AppState) -> String {
    state
        .visible_creator
        .map(|id| id.to_string())
        .unwrap_or_default()
}

pub(crate) async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<DisplayQuery>,
) -> ApiResult<Json<Display>> {
    let mut tx = state.pool.begin().await?;
    let scope = visible_scope(&state, &mut tx, &id, true).await?;
    let received = read_distribution(&mut tx, &scope, Some(query.market)).await?;
    let saved:Option<(i64,DbJson<ReceivedDistribution>)>=sqlx::query_as("SELECT revision,deductions FROM received_display_states WHERE period_id=? AND view_creator=? AND market=? FOR SHARE")
        .bind(&id).bind(creator(&state)).bind(query.market.as_str()).fetch_optional(&mut *tx).await?;
    let (revision, deducted) = saved
        .map(|(r, d)| (r, d.0))
        .unwrap_or((0, ReceivedDistribution::empty()));
    let result = presentation(received, deducted, revision)?;
    tx.commit().await?;
    Ok(Json(result))
}
pub(crate) async fn change(
    State(state): State<AppState>,
    Extension(ReceivedAt(received_at)): Extension<ReceivedAt>,
    Path(id): Path<String>,
    Query(query): Query<DisplayQuery>,
    Json(input): Json<Input>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&input.request_id).map_err(|_| conflict("提交标识无效，请刷新重试"))?;
    if input.revision < 0 {
        return Err("首页减出版本无效".to_string().into());
    }
    let view_creator = creator(&state);
    let actor = state
        .hosted
        .as_ref()
        .map(|policy| policy.account_id.as_str())
        .unwrap_or("");
    let hash=digest(&json!({"period":id,"market":query.market,"view_creator":view_creator,"actor":actor,"input":input}).to_string());
    let mut tx = state.pool.begin().await?;
    let scope = visible_scope(&state, &mut tx, &id, true).await?;
    // Serialize display changes after the ordinary period locks; no financial row changes.
    sqlx::query("INSERT INTO received_display_states(period_id,view_creator,market,deductions) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE revision=revision")
        .bind(&id).bind(&view_creator).bind(query.market.as_str()).bind(DbJson(ReceivedDistribution::empty())).execute(&mut *tx).await?;
    let (revision,deducted):(i64,DbJson<ReceivedDistribution>)=sqlx::query_as("SELECT revision,deductions FROM received_display_states WHERE period_id=? AND view_creator=? AND market=? FOR UPDATE")
        .bind(&id).bind(&view_creator).bind(query.market.as_str()).fetch_one(&mut *tx).await?;
    let replay: Option<(String, DbJson<Value>)> = sqlx::query_as(
        "SELECT request_hash,response FROM received_display_changes WHERE request_id=?",
    )
    .bind(&input.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((previous, response)) = replay {
        if previous != hash {
            return Err(conflict("同一提交标识包含不同内容，请刷新后确认"));
        }
        tx.commit().await?;
        return Ok(Json(response.0));
    }
    if scope.periods[0].business_date != business_date(received_at) {
        return Err(conflict("业务日期已切换，请刷新首页后重试"));
    }
    if input.revision != revision {
        return Err(conflict("首页减出记录已更新，请刷新后重新确认"));
    }
    let received = read_distribution(&mut tx, &scope, Some(query.market)).await?;
    let next = apply(&received, deducted.0.clone(), input.kind, &input.change)?;
    let next_revision = revision
        .checked_add(1)
        .ok_or_else(|| conflict("首页减出版本超出范围"))?;
    let response = json!({"ok":true,"revision":next_revision});
    sqlx::query("UPDATE received_display_states SET revision=?,deductions=? WHERE period_id=? AND view_creator=? AND market=?")
        .bind(next_revision).bind(DbJson(&next)).bind(&id).bind(&view_creator).bind(query.market.as_str()).execute(&mut *tx).await?;
    let snapshot = json!({"actor":actor,"view_creator":view_creator,"market":query.market,"input":input,"received":received,"previous_deductions":deducted.0,"deductions":next});
    sqlx::query("INSERT INTO received_display_changes(request_id,request_hash,period_id,snapshot,response) VALUES(?,?,?,?,?)")
        .bind(&input.request_id).bind(hash).bind(&id).bind(DbJson(snapshot)).bind(DbJson(&response)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(response))
}

#[cfg(test)]
#[path = "../tests/support/received_display.rs"]
mod contracts;
