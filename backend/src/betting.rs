//! Atomic, idempotent submissions. A slip never changes the independent bet snapshots.
use crate::{
    api::{ApiError, ApiResult, ReceivedAt, conflict},
    domain::*,
    ledger,
    store::*,
};
use axum::{Extension, Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, types::Json as DbJson};
use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SlipLine {
    #[serde(default, skip_serializing_if = "crate::market::Market::is_macau")]
    pub market: crate::market::Market,
    pub play_id: i64,
    pub play_version: i64,
    pub selections: Vec<u8>,
    pub compound: bool,
    pub amount: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub package_zodiacs: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drag: Option<DragInput>,
}
impl SlipLine {
    pub(crate) fn as_bet_input(&self, period: &str, bettor: &str, request_id: &str) -> BetInput {
        BetInput {
            market: self.market,
            period: period.to_owned(),
            bettor: bettor.to_owned(),
            request_id: request_id.to_owned(),
            play_id: self.play_id,
            play_version: self.play_version,
            selections: self.selections.clone(),
            compound: self.compound,
            amount: self.amount.clone(),
            package_zodiacs: self.package_zodiacs.clone(),
            drag: self.drag.clone(),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SlipInput {
    pub period: String,
    pub bettor: String,
    pub request_id: String,
    pub items: Vec<SlipLine>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub text_preferences: Vec<crate::text_entry::Preference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bettor_preference: Option<crate::text_entry::BettorPreference>,
    #[serde(default, skip_serializing_if = "crate::features::EntryMode::is_manual")]
    pub entry_mode: crate::features::EntryMode,
}
pub(crate) async fn single(
    State(state): State<AppState>,
    Extension(ReceivedAt(received)): Extension<ReceivedAt>,
    Json(mut input): Json<BetInput>,
) -> ApiResult<Json<Value>> {
    input.bettor = ledger::party(&input.bettor)?;
    // Retain the persisted single-bet request hash contract for committed retries.
    let hash = crate::api::digest(&serde_json::to_string(&input).map_err(anyhow::Error::from)?);
    let slip = SlipInput {
        text_preferences: vec![],
        bettor_preference: None,
        entry_mode: crate::features::EntryMode::Manual,
        period: input.period.clone(),
        bettor: input.bettor.clone(),
        request_id: input.request_id.clone(),
        items: vec![SlipLine {
            market: input.market,
            play_id: input.play_id,
            play_version: input.play_version,
            selections: input.selections,
            compound: input.compound,
            amount: input.amount,
            package_zodiacs: input.package_zodiacs,
            drag: input.drag,
        }],
    };
    submit(&state, received, slip, hash, false).await.map(Json)
}
pub(crate) async fn slip(
    State(state): State<AppState>,
    Extension(ReceivedAt(received)): Extension<ReceivedAt>,
    Json(mut input): Json<SlipInput>,
) -> ApiResult<Json<Value>> {
    input.bettor = ledger::party(&input.bettor)?;
    let hash = crate::api::digest(&serde_json::to_string(&input).map_err(anyhow::Error::from)?);
    submit(&state, received, input, hash, true).await.map(Json)
}
async fn replay(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    request: &str,
    hash: &str,
    grouped: bool,
) -> ApiResult<Option<Value>> {
    let table = if grouped { "bet_slips" } else { "bets" };
    let row = sqlx::query(&format!(
        "SELECT id,request_hash FROM {table} WHERE request_id=?"
    ))
    .bind(request)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(row) = row {
        if row.try_get::<String, _>("request_hash")? != hash {
            return Err(conflict("同一提交标识不能用于不同投注"));
        }
        return Ok(Some(
            json!({"id":row.try_get::<String,_>("id")?,"replayed":true}),
        ));
    }
    Ok(None)
}
async fn submit(
    state: &AppState,
    received: chrono::NaiveDateTime,
    input: SlipInput,
    hash: String,
    grouped: bool,
) -> ApiResult<Value> {
    uuid::Uuid::parse_str(&input.request_id).map_err(|_| {
        ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "提交标识不合法，请刷新页面".into(),
        )
    })?;
    if input.items.is_empty() || input.items.len() > 100 {
        return Err("一张组合单须包含 1–100 个分项".to_string().into());
    }
    let mut tx = state.pool.begin().await?;
    if let Some(result) = replay(&mut tx, &input.request_id, &hash, grouped).await? {
        return Ok(result);
    }
    // Creating the period uses its own administrator transaction; release this connection first.
    tx.rollback().await?;
    let current = ensure_period(state, business_date(received)).await?;
    let mut targets = std::collections::BTreeMap::new();
    if input
        .items
        .iter()
        .any(|l| l.market == crate::market::Market::Hk)
    {
        let hk = crate::market::ensure_hk(state).await?;
        targets.insert(crate::market::Market::Hk, hk);
    }
    if input.period != current.id && !targets.values().any(|p| p.id == input.period) {
        return Err(conflict("期次已切换，请刷新后重新录入"));
    }
    if input.items.iter().any(|l| l.market.is_macau()) {
        targets.insert(crate::market::Market::Macau, current.clone());
    }
    let mut tx = state.pool.begin().await?;
    // Every writer takes period locks in the same id order before locking bets.
    let mut ids: Vec<_> = targets.values().map(|p| p.id.clone()).collect();
    ids.sort();
    for id in ids {
        let mut p: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        if p.market == "hk" && p.draw.is_none() {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM bets WHERE period_id=? AND status<>'cancelled'",
            )
            .bind(&p.id)
            .fetch_one(&mut *tx)
            .await?;
            if count == 0 && p.business_date != business_date(received) {
                p.business_date = business_date(received);
                p.mapping = current.mapping.clone();
                p.last_fetch_at = None;
                p.error = None;
                sqlx::query("UPDATE periods SET business_date=?,mapping=?,last_fetch_at=NULL,error=NULL WHERE id=?")
                    .bind(p.business_date)
                    .bind(&p.mapping)
                    .bind(&p.id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        if !crate::market::accepts(&p, received) {
            return Err(conflict("分项所属期次已归档，整单未保存"));
        }
        targets.insert(
            if p.market == "hk" {
                crate::market::Market::Hk
            } else {
                crate::market::Market::Macau
            },
            p,
        );
    }
    if let Some(result) = replay(&mut tx, &input.request_id, &hash, grouped).await? {
        return Ok(result);
    }
    crate::features::require_entry(&mut tx, input.entry_mode).await?;
    let ids: BTreeSet<i64> = input.items.iter().map(|line| line.play_id).collect();
    let mut plays = HashMap::new();
    for id in ids {
        let play: Play = sqlx::query_as("SELECT id,version,rule,enabled FROM plays WHERE id=? AND deleted_at IS NULL FOR UPDATE")
            .bind(id).fetch_optional(&mut *tx).await?.ok_or_else(|| conflict("玩法已删除，请刷新后重新选择"))?;
        plays.insert(id, play);
    }
    let mut plans = Vec::with_capacity(input.items.len());
    let mut units = 0_usize;
    for (index, line) in input.items.iter().enumerate() {
        let play = &plays[&line.play_id];
        if !play.enabled || play.version != line.play_version {
            return Err(conflict(&format!(
                "第 {} 项玩法已变更或停用，请刷新后确认",
                index + 1
            )));
        }
        let period = &targets[&line.market];
        let bet = line.as_bet_input(&period.id, &input.bettor, &input.request_id);
        let planned = plan(&play.rule, &bet, &period.mapping).map_err(|e| {
            ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("第 {} 项：{e}；整单未保存", index + 1),
            )
        })?;
        units += planned.atoms.len();
        if units > MAX_UNITS {
            return Err("一张投注单合计最多 1000 条基础注，整单未保存"
                .to_string()
                .into());
        }
        plans.push(planned);
    }
    // The full mixed slip is also displayed and exported as one financial total.
    // Separate market budgets must not let its combined principal/exposure overflow.
    checked_sum(plans.iter().flat_map(|p| [p.stake, p.exposure]))?;
    for (market, period) in &targets {
        let incoming: Vec<_> = input
            .items
            .iter()
            .zip(&plans)
            .filter(|(l, _)| l.market == *market)
            .map(|(_, p)| p)
            .collect();
        let incoming_stake = checked_sum(incoming.iter().map(|p| p.stake))?;
        let incoming_exposure = checked_sum(incoming.iter().map(|p| p.exposure))?;
        let totals=sqlx::query("SELECT COUNT(*) records,CAST(COALESCE(SUM(unit_count),0) AS SIGNED) units,CAST(COALESCE(SUM(stake),0) AS SIGNED) stake,CAST(COALESCE(SUM(exposure),0) AS SIGNED) exposure FROM bets WHERE period_id=? AND status<>'cancelled'").bind(&period.id).fetch_one(&mut *tx).await?;
        if totals.try_get::<i64, _>("records")? + incoming.len() as i64 > 1000
            || totals.try_get::<i64, _>("units")?
                + incoming.iter().map(|p| p.atoms.len() as i64).sum::<i64>()
                > 10000
        {
            return Err(conflict("分项所属期次容量已满，整单未保存"));
        }
        let outgoing:i64=sqlx::query_scalar("SELECT CAST(COALESCE(SUM(stake+exposure),0) AS SIGNED) FROM layoffs WHERE period_id=? AND status<>'cancelled'").bind(&period.id).fetch_one(&mut *tx).await?;
        checked_sum([
            totals.try_get("stake")?,
            totals.try_get("exposure")?,
            outgoing,
            incoming_stake,
            incoming_exposure,
        ])?;
    }
    let slip_id = grouped.then(|| uuid::Uuid::new_v4().to_string());
    if let Some(id) = &slip_id {
        sqlx::query(
            "INSERT INTO bet_slips(id,request_id,request_hash,period_id,bettor) VALUES(?,?,?,?,?)",
        )
        .bind(id)
        .bind(&input.request_id)
        .bind(&hash)
        .bind(&input.period)
        .bind(&input.bettor)
        .execute(&mut *tx)
        .await?;
    }
    let mut created = Vec::with_capacity(plans.len());
    for (position, (line, planned)) in input.items.iter().zip(&plans).enumerate() {
        let period = &targets[&line.market];
        let play = &plays[&line.play_id];
        let id = uuid::Uuid::new_v4().to_string();
        let request = if grouped {
            uuid::Uuid::new_v4().to_string()
        } else {
            input.request_id.clone()
        };
        sqlx::query("INSERT INTO bets(id,request_id,request_hash,period_id,play_id,play_version,rule,selections,compound,amount,unit_count,stake,rebate,exposure,natal,atoms,bettor,slip_id,slip_position,package_zodiacs,drag,market) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&id).bind(request).bind(&hash).bind(&period.id).bind(play.id).bind(play.version).bind(&play.rule)
            .bind(DbJson(&line.selections)).bind(line.compound).bind(entry_amount(&line.amount)?).bind(planned.atoms.len() as i32)
            .bind(planned.stake).bind(planned.rebate).bind(planned.exposure).bind(period.mapping.natal as i8)
            .bind(DbJson(&planned.atoms)).bind(&input.bettor).bind(&slip_id).bind(grouped.then_some(position as i32)).bind(DbJson(&line.package_zodiacs)).bind(line.drag.as_ref().map(DbJson)).bind(line.market.as_str()).execute(&mut *tx).await?;
        audit(
            &mut tx,
            Some(&period.id),
            "bet_created",
            json!({"id":id,"slip_id":slip_id,"units":planned.atoms.len()}),
        )
        .await?;
        created.push(id);
    }
    if let Some(id) = &slip_id {
        audit(
            &mut tx,
            Some(&input.period),
            "slip_created",
            json!({"id":id,"items":created}),
        )
        .await?;
    }
    crate::text_entry::learn(&mut tx, &input.text_preferences, &input.items).await?;
    if let Some(preference) = &input.bettor_preference {
        if input.entry_mode != crate::features::EntryMode::Text {
            return Err("投注人费率习惯只用于文本录注".to_owned().into());
        }
        crate::text_entry::learn_bettor(&mut tx, &input.bettor, preference, &input.items).await?;
    }
    for period in targets.values() {
        ledger::invalidate(&mut tx, &period.id).await?;
        crate::worker::settle_recorded(&mut tx, period).await?;
    }
    tx.commit().await?;
    for period in targets.values() {
        ledger::cancel_calculation(state, &period.id).await;
    }
    Ok(json!({"id":slip_id.unwrap_or_else(||created[0].clone()),"replayed":false}))
}
