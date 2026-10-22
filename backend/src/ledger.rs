//! Audited amount corrections and outgoing positions. The period row is always
//! locked before a bet, matching submission and settlement lock order.
use crate::{
    api::{ApiError, ApiResult, ReceivedAt, conflict, digest, missing},
    domain::*,
    store::*,
};
use axum::{
    Extension, Json,
    extract::{Path, Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, Row, types::Json as DbJson};
use std::{collections::BTreeMap, sync::atomic::Ordering};

pub fn party(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err("投注人／受注方须为 1–80 个字符，不能包含控制字符"
            .to_string()
            .into());
    }
    Ok(value.to_string())
}
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Layoff {
    pub id: String,
    pub bet_id: String,
    pub period_id: String,
    pub receiver: String,
    pub amount: i64,
    pub unit_count: i32,
    pub stake: i64,
    pub rebate: i64,
    pub status: String,
    pub payout: Option<i64>,
    pub winning_stake: Option<i64>,
    pub void_stake: i64,
    pub void_units: i32,
    pub created_at: chrono::NaiveDateTime,
    pub cancelled_at: Option<chrono::NaiveDateTime>,
}
pub const LAYOFF_COLUMNS: &str = "id,bet_id,period_id,receiver,amount,unit_count,stake,rebate,status,payout,winning_stake,void_stake,void_units,created_at,cancelled_at";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Mutation {
    pub request_id: String,
    pub revision: i64,
    pub amount: String,
    pub receiver: Option<String>,
}
fn reprice(
    atoms: &[Atom],
    amount: i64,
    rule: &Rule,
    packages: &[u8],
    mapping: &Mapping,
) -> RuleResult<BetPlan> {
    let mut atoms = atoms.to_vec();
    for a in &mut atoms {
        if a.rebate_percent.is_empty() {
            a.rebate_percent = rule.rebate_percent.clone();
        }
    }
    if packages.is_empty() {
        for a in &mut atoms {
            price_atom(a, amount)?;
        }
    } else {
        price_package(&mut atoms, packages, mapping, amount)?;
    }
    total_plan(atoms)
}
pub(crate) async fn invalidate(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    period: &str,
) -> ApiResult<()> {
    sqlx::query("UPDATE periods SET bet_version=bet_version+1,risk_status=IF(state='pending','queued','stale'),risk_requested_at=UTC_TIMESTAMP(6),risk_error=NULL WHERE id=?").bind(period).execute(&mut **tx).await?;
    Ok(())
}
pub(crate) async fn cancel_calculation(state: &AppState, period: &str) {
    if let Some(flag) = state.cancellations.lock().await.get(period) {
        flag.store(true, Ordering::Relaxed);
    }
}
pub(crate) async fn change_amount(
    State(state): State<AppState>,
    Extension(ReceivedAt(received)): Extension<ReceivedAt>,
    Path(id): Path<String>,
    Json(input): Json<Mutation>,
) -> ApiResult<Json<Value>> {
    mutate(state, received, id, input, false).await
}
pub(crate) async fn fly_out(
    State(state): State<AppState>,
    Extension(ReceivedAt(received)): Extension<ReceivedAt>,
    Path(id): Path<String>,
    Json(input): Json<Mutation>,
) -> ApiResult<Json<Value>> {
    mutate(state, received, id, input, true).await
}
async fn mutate(
    state: AppState,
    received: chrono::NaiveDateTime,
    id: String,
    mut input: Mutation,
    fly: bool,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&input.request_id).map_err(|_| conflict("提交标识不合法"))?;
    let amount = if fly {
        scaled(&input.amount, 2)?
    } else {
        entry_amount(&input.amount)?
    };
    if amount <= 0 {
        return Err(conflict("飞出金额最少一分钱"));
    }
    if fly {
        input.receiver = Some(party(input.receiver.as_deref().unwrap_or(""))?);
    } else if input.receiver.is_some() {
        return Err(conflict("金额纠正不能同时指定飞出受注方"));
    }
    let hash = digest(&json!({"bet":id,"fly":fly,"input":input}).to_string());
    let period: String = sqlx::query_scalar("SELECT period_id FROM bets WHERE id=?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(missing)?;
    let mut tx = state.pool.begin().await?;
    let p: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR UPDATE")
        .bind(&period)
        .fetch_one(&mut *tx)
        .await?;
    if let Some(row) =
        sqlx::query("SELECT request_hash,response FROM bet_mutations WHERE request_id=?")
            .bind(&input.request_id)
            .fetch_optional(&mut *tx)
            .await?
    {
        if row.try_get::<String, _>("request_hash")? != hash {
            return Err(conflict("同一提交标识不能用于不同操作"));
        }
        return Ok(Json(row.try_get::<DbJson<Value>, _>("response")?.0));
    }
    if !accepts_entries(received, p.business_date) {
        return Err(conflict("本期已归档，不能修改金额或飞出"));
    }
    let bet: BetSummary = sqlx::query_as(&format!(
        "SELECT {BET_COLUMNS} FROM bets WHERE id=? FOR UPDATE"
    ))
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    if bet.status == "cancelled" || bet.revision != input.revision {
        return Err(conflict("投注已变更或作废，请刷新后重试"));
    }
    let flown: i64 = sqlx::query_scalar("SELECT CAST(COALESCE(SUM(amount),0) AS SIGNED) FROM layoffs WHERE bet_id=? AND status<>'cancelled'").bind(&id).fetch_one(&mut *tx).await?;
    if (fly && checked_sum([flown, amount])? > bet.amount) || (!fly && amount < flown) {
        return Err(conflict(
            "飞出金额不能超过原注金额；原注金额不能小于已飞出金额",
        ));
    }
    let atoms: DbJson<Vec<Atom>> = sqlx::query_scalar("SELECT atoms FROM bets WHERE id=?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    let plan = reprice(&atoms, amount, &bet.rule, &bet.package_zodiacs, &p.mapping)?;
    if !bet.package_zodiacs.is_empty() {
        let previous: Vec<DbJson<Vec<Atom>>> =
            sqlx::query_scalar("SELECT atoms FROM layoffs WHERE bet_id=? AND status<>'cancelled'")
                .bind(&id)
                .fetch_all(&mut *tx)
                .await?;
        if previous.iter().any(|row| row.len() != atoms.len()) {
            return Err(conflict("飞出基础注快照不一致，请检查记录"));
        }
        for (i, original) in atoms.iter().enumerate() {
            let already = checked_sum(previous.iter().map(|row| row[i].stake))?;
            let limit = if fly {
                original.stake
            } else {
                plan.atoms[i].stake
            };
            let used = checked_sum([already, if fly { plan.atoms[i].stake } else { 0 }])?;
            if used > limit {
                return Err(conflict(
                    "包肖逐号飞出金额超过原注，请调整金额（含分配余分）",
                ));
            }
        }
    }
    let totals = sqlx::query("SELECT CAST(COALESCE(SUM(stake),0) AS SIGNED) stake,CAST(COALESCE(SUM(exposure),0) AS SIGNED) exposure FROM bets WHERE period_id=? AND status<>'cancelled'").bind(&period).fetch_one(&mut *tx).await?;
    let fly_totals = sqlx::query("SELECT COUNT(*) records,CAST(COALESCE(SUM(unit_count),0) AS SIGNED) units,CAST(COALESCE(SUM(stake+exposure),0) AS SIGNED) exposure FROM layoffs WHERE period_id=? AND status<>'cancelled'").bind(&period).fetch_one(&mut *tx).await?;
    if fly
        && (fly_totals.try_get::<i64, _>("records")? >= 1000
            || fly_totals.try_get::<i64, _>("units")? + i64::from(bet.unit_count) > 10000)
    {
        return Err(conflict(
            "本期飞出容量已满：最多 1000 条有效飞出、10000 条基础注",
        ));
    }
    let old_exposure: i64 = sqlx::query_scalar("SELECT exposure FROM bets WHERE id=?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    checked_sum([
        totals.try_get("stake")?,
        if fly { 0 } else { plan.stake - bet.stake },
    ])?;
    checked_sum([
        totals.try_get::<i64, _>("stake")? + totals.try_get::<i64, _>("exposure")?
            - if fly { 0 } else { bet.stake + old_exposure },
        fly_totals.try_get("exposure")?,
        plan.stake,
        plan.exposure,
    ])?;
    let response = if fly {
        let fly_id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO layoffs(id,bet_id,period_id,receiver,amount,unit_count,stake,rebate,exposure,atoms) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .bind(&fly_id).bind(&id).bind(&period).bind(&input.receiver).bind(amount).bind(bet.unit_count).bind(plan.stake).bind(plan.rebate).bind(plan.exposure).bind(DbJson(&plan.atoms)).execute(&mut *tx).await?;
        audit(&mut tx,Some(&period),"bet_flown",json!({"id":id,"layoff_id":fly_id,"receiver":input.receiver,"amount":amount,"stake":plan.stake,"revision":bet.revision+1})).await?;
        json!({"id":fly_id,"revision":bet.revision+1})
    } else {
        sqlx::query("UPDATE bets SET amount=?,stake=?,rebate=?,exposure=?,atoms=?,status='pending',payout=NULL,winning_stake=NULL,void_stake=0,void_units=0,results=NULL WHERE id=?")
            .bind(amount)
            .bind(plan.stake)
            .bind(plan.rebate)
            .bind(plan.exposure)
            .bind(DbJson(&plan.atoms))
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        audit(&mut tx,Some(&period),"bet_amount_changed",json!({"id":id,"before_amount":bet.amount,"after_amount":amount,"before_stake":bet.stake,"after_stake":plan.stake,"revision":bet.revision+1})).await?;
        json!({"id":id,"revision":bet.revision+1})
    };
    sqlx::query("UPDATE bets SET revision=revision+1 WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO bet_mutations(request_id,bet_id,request_hash,response) VALUES(?,?,?,?)",
    )
    .bind(&input.request_id)
    .bind(&id)
    .bind(hash)
    .bind(DbJson(&response))
    .execute(&mut *tx)
    .await?;
    invalidate(&mut tx, &period).await?;
    crate::worker::settle_recorded(&mut tx, &p).await?;
    tx.commit().await?;
    cancel_calculation(&state, &period).await;
    Ok(Json(response))
}
pub(crate) async fn cancel_layoff(
    State(state): State<AppState>,
    Extension(ReceivedAt(received)): Extension<ReceivedAt>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let period: String = sqlx::query_scalar("SELECT period_id FROM layoffs WHERE id=?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(missing)?;
    let mut tx = state.pool.begin().await?;
    let p: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR UPDATE")
        .bind(&period)
        .fetch_one(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT bet_id,status FROM layoffs WHERE id=? FOR UPDATE")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if row.try_get::<String, _>("status")? == "cancelled" {
        return Ok(Json(json!({"ok":true})));
    }
    if !accepts_entries(received, p.business_date) {
        return Err(conflict("本期已归档，不能撤销飞出"));
    }
    sqlx::query("UPDATE layoffs SET status='cancelled',cancelled_at=UTC_TIMESTAMP(6) WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let bet: String = row.try_get("bet_id")?;
    sqlx::query("UPDATE bets SET revision=revision+1 WHERE id=?")
        .bind(&bet)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        Some(&period),
        "layoff_cancelled",
        json!({"id":bet,"layoff_id":id}),
    )
    .await?;
    invalidate(&mut tx, &period).await?;
    crate::worker::settle_recorded(&mut tx, &p).await?;
    tx.commit().await?;
    cancel_calculation(&state, &period).await;
    Ok(Json(json!({"ok":true})))
}
#[derive(Default, Clone, Serialize)]
pub struct LedgerTotals {
    pub records: i64,
    pub units: i64,
    pub stake: i64,
    pub rebate: i64,
    pub payout: i64,
    pub refunded: i64,
    pub net: Option<i64>,
}
impl LedgerTotals {
    pub(crate) fn add(
        &mut self,
        amounts: (i32, i64, i64, Option<i64>, i64),
        settled: bool,
        outgoing: bool,
    ) -> ApiResult<()> {
        let (units, stake, rebate, payout, refunded) = amounts;
        if units > 0 {
            self.records += 1;
        }
        self.units += i64::from(units);
        self.stake = checked_sum([self.stake, stake - refunded])?;
        self.rebate = checked_sum([self.rebate, rebate])?;
        self.refunded = checked_sum([self.refunded, refunded])?;
        self.payout = checked_sum([self.payout, payout.unwrap_or(0) - refunded])?;
        if settled {
            let net = stake - payout.unwrap_or(0) - rebate;
            self.net = Some(checked_sum([
                self.net.unwrap_or(0),
                if outgoing { -net } else { net },
            ])?);
        }
        Ok(())
    }
}
#[derive(Deserialize, Default)]
pub struct StatisticsPage {
    page: Option<u32>,
}
pub async fn statistics(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<StatisticsPage>,
) -> ApiResult<Json<Value>> {
    let page = query.page.unwrap_or(1).clamp(1, 100000);
    let mut tx = state.pool.begin().await?;
    let p: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR SHARE")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(missing)?;
    let bets: Vec<BetSummary> = sqlx::query_as(&format!(
        "SELECT {BET_COLUMNS} FROM bets WHERE period_id=? AND status<>'cancelled'"
    ))
    .bind(&id)
    .fetch_all(&mut *tx)
    .await?;
    let layoffs: Vec<Layoff> = sqlx::query_as(&format!(
        "SELECT {LAYOFF_COLUMNS} FROM layoffs WHERE period_id=? AND status<>'cancelled'"
    ))
    .bind(&id)
    .fetch_all(&mut *tx)
    .await?;
    let settled = p.state == "settled";
    let empty = LedgerTotals {
        net: settled.then_some(0),
        ..Default::default()
    };
    let mut incoming = empty.clone();
    let mut outgoing = empty.clone();
    let mut bettors = BTreeMap::<String, LedgerTotals>::new();
    let mut receivers = BTreeMap::<String, LedgerTotals>::new();
    for b in &bets {
        let name = if b.bettor.is_empty() {
            "未登记（旧记录）"
        } else {
            &b.bettor
        };
        for total in [
            &mut incoming,
            bettors
                .entry(name.to_string())
                .or_insert_with(|| empty.clone()),
        ] {
            total.add(
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
    }
    for b in layoffs.iter().filter(|l| l.status != "cancelled") {
        for total in [
            &mut outgoing,
            receivers
                .entry(b.receiver.clone())
                .or_insert_with(|| empty.clone()),
        ] {
            total.add(
                (
                    b.unit_count - b.void_units,
                    b.stake,
                    b.rebate,
                    b.payout,
                    b.void_stake,
                ),
                settled,
                true,
            )?;
        }
    }
    let retained = json!({"stake":incoming.stake-outgoing.stake,"rebate":incoming.rebate-outgoing.rebate,"payout":incoming.payout-outgoing.payout,"net":if settled {Some(checked_sum([incoming.net.unwrap_or(0),outgoing.net.unwrap_or(0)])?)} else {None}});
    let layoffs_total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layoffs WHERE period_id=?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    let layoffs: Vec<Layoff> = sqlx::query_as(&format!("SELECT {LAYOFF_COLUMNS} FROM layoffs WHERE period_id=? ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?"))
        .bind(&id).bind((page-1)*20).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let groups = |map: BTreeMap<String, LedgerTotals>| {
        map.into_iter()
            .map(|(name, totals)| json!({"name":name,"totals":totals}))
            .collect::<Vec<_>>()
    };
    Ok(Json(
        json!({"period":id,"settled":settled,"incoming":incoming,"outgoing":outgoing,"retained":retained,"bettors":groups(bettors),"receivers":groups(receivers),"layoffs":layoffs,"layoffs_total":layoffs_total,"layoffs_page":page}),
    ))
}
pub async fn parties(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let bettors: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT bettor FROM bets WHERE bettor<>'' ORDER BY bettor LIMIT 1000",
    )
    .fetch_all(&state.pool)
    .await?;
    let receivers: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT receiver FROM layoffs ORDER BY receiver LIMIT 1000")
            .fetch_all(&state.pool)
            .await?;
    Ok(Json(json!({"bettors":bettors,"receivers":receivers})))
}
