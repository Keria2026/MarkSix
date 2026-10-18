use crate::{domain::*, risk::RiskResult};
use anyhow::Context;
use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
use chrono::{Datelike, FixedOffset, NaiveDate, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{
    ConnectOptions, FromRow, MySqlPool, Row,
    mysql::{MySqlConnectOptions, MySqlPoolOptions},
    types::Json,
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};
use tokio::sync::{Mutex, Semaphore};

pub(crate) type DrawCache = Arc<Mutex<Option<(Instant, Result<Vec<serde_json::Value>, String>)>>>;

#[derive(Clone)]
pub struct AppState {
    pub pool: MySqlPool,
    pub clock: Arc<dyn Fn() -> NaiveDateTime + Send + Sync>,
    pub client: reqwest::Client,
    pub draw_url: String,
    pub secure_cookie: bool,
    pub risk_gate: Arc<Semaphore>,
    pub auth_gate: Arc<Semaphore>,
    pub cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub login_attempts: Arc<Mutex<VecDeque<Instant>>>,
    pub(crate) hosted: Option<crate::hosted::Policy>,
    pub(crate) draw_cache: Option<DrawCache>,
}
impl AppState {
    pub fn new(pool: MySqlPool) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent(concat!(
                "MarkSix/",
                env!("CARGO_PKG_VERSION"),
                " (+hosted statistics)"
            ))
            .build()?;
        Ok(Self::with_client(pool, client))
    }
    pub(crate) fn with_client(pool: MySqlPool, client: reqwest::Client) -> Self {
        Self {
            pool,
            clock: Arc::new(|| {
                Utc::now()
                    .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
                    .naive_local()
            }),
            client,
            draw_url: "https://macaumarksix.com/api/macaujc2.com".into(),
            secure_cookie: false,
            risk_gate: Arc::new(Semaphore::new(1)),
            auth_gate: Arc::new(Semaphore::new(1)),
            cancellations: Arc::default(),
            login_attempts: Arc::default(),
            hosted: None,
            draw_cache: None,
        }
    }
    pub fn now(&self) -> NaiveDateTime {
        (self.clock)()
    }
}
pub async fn connect(url: &str) -> anyhow::Result<MySqlPool> {
    let pool = MySqlPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET time_zone = '+00:00'")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(
            url.parse::<MySqlConnectOptions>()?
                .disable_statement_logging(),
        )
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
pub async fn initialize(
    pool: &MySqlPool,
    username: &str,
    password: Option<&str>,
) -> anyhow::Result<()> {
    let exists: Option<i8> = sqlx::query_scalar("SELECT id FROM administrators WHERE id=1")
        .fetch_optional(pool)
        .await?;
    if exists.is_some() {
        return Ok(());
    }
    let password = password.context("首次启动必须设置 ADMIN_PASSWORD（至少 12 个字符）")?;
    if password.chars().count() < 12
        || password.len() > 256
        || username.trim().is_empty()
        || username.chars().count() > 80
    {
        anyhow::bail!("管理员账号不合法或密码不足 12 个字符／超过 256 字节");
    }
    let password = password.to_owned();
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(
                password.as_bytes(),
                &SaltString::generate(&mut rand::rngs::OsRng),
            )
            .map(|s| s.to_string())
            .map_err(|e| anyhow::anyhow!(e.to_string()))
    })
    .await??;
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT IGNORE INTO administrators(id,username,password_hash) VALUES(1,?,?)")
        .bind(username)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    // Initialization is serialised by the single administrator row.
    sqlx::query("SELECT id FROM administrators WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT IGNORE INTO closing_configs(effective_date,close_time) VALUES('1970-01-01','21:28')").execute(&mut *tx).await?;
    sqlx::query(
        "INSERT IGNORE INTO mapping_configs(effective_date,mapping) VALUES('1970-01-01',?)",
    )
    .bind(Json(Mapping::default()))
    .execute(&mut *tx)
    .await?;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plays")
        .fetch_one(&mut *tx)
        .await?;
    if n == 0 {
        for play in crate::configuration::bundled()
            .map_err(anyhow::Error::msg)?
            .plays
        {
            let rule = play.rule;
            let result = sqlx::query("INSERT INTO plays(version,rule,enabled) VALUES(1,?,?)")
                .bind(Json(&rule))
                .bind(play.enabled)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO play_versions(play_id,version,rule) VALUES(?,1,?)")
                .bind(result.last_insert_id() as i64)
                .bind(Json(rule))
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Play {
    pub id: i64,
    pub version: i64,
    pub rule: Json<Rule>,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Period {
    pub id: String,
    pub business_date: NaiveDate,
    pub close_time: String,
    pub open_time: String,
    pub mapping: Json<Mapping>,
    pub state: String,
    pub bet_version: i64,
    pub draw: Option<Json<Draw>>,
    pub last_fetch_at: Option<NaiveDateTime>,
    pub error: Option<String>,
    pub mapping_warning: bool,
    pub settled_at: Option<NaiveDateTime>,
    pub risk_status: String,
    pub risk_task_id: Option<String>,
    pub risk_version: Option<i64>,
    pub risk_result: Option<Json<RiskResult>>,
    pub risk_error: Option<String>,
    pub risk_started_at: Option<NaiveDateTime>,
    pub risk_requested_at: NaiveDateTime,
    pub risk_finished_at: Option<NaiveDateTime>,
}
#[derive(Debug, Clone, Serialize, Default)]
pub struct Totals {
    pub records: i64,
    pub units: i64,
    pub stake: i64,
    pub rebate: i64,
    pub exposure: i64,
    pub payout: i64,
    pub winning_stake: i64,
    pub losing_stake: i64,
    pub gross: Option<i64>,
    pub net: Option<i64>,
    pub refunded: i64,
    pub flyout_stake: i64,
    pub flyout_net: Option<i64>,
    pub retained_net: Option<i64>,
}
#[derive(Debug, Clone, Serialize)]
pub struct PeriodView {
    #[serde(flatten)]
    pub period: Period,
    pub phase: String,
    pub totals: Totals,
    pub server_time: String,
}
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct BetSummary {
    pub slip_id: Option<String>,
    pub slip_position: Option<i32>,
    pub bettor: String,
    pub revision: i64,
    pub void_stake: i64,
    pub void_units: i32,
    pub id: String,
    pub period_id: String,
    pub play_id: i64,
    pub play_version: i64,
    pub rule: Json<Rule>,
    pub selections: Json<Vec<u8>>,
    pub compound: bool,
    pub amount: i64,
    pub unit_count: i32,
    pub stake: i64,
    pub rebate: i64,
    pub status: String,
    pub payout: Option<i64>,
    pub winning_stake: Option<i64>,
    pub created_at: NaiveDateTime,
    pub cancelled_at: Option<NaiveDateTime>,
    pub natal: i8,
}
pub const BET_COLUMNS: &str = "slip_id,slip_position,bettor,revision,void_stake,void_units,id,period_id,play_id,play_version,rule,selections,compound,amount,unit_count,stake,rebate,status,payout,winning_stake,created_at,cancelled_at,natal";
#[derive(Debug, Serialize, Deserialize)]
pub struct FutureMapping {
    pub effective_date: NaiveDate,
    pub mapping: Mapping,
}

pub async fn ensure_period(state: &AppState, date: NaiveDate) -> anyhow::Result<Period> {
    let id = period_id(date);
    if let Some(p) = sqlx::query_as::<_, Period>("SELECT * FROM periods WHERE id=?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
    {
        return Ok(p);
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM administrators WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let times = sqlx::query("SELECT open_time,close_time FROM closing_configs WHERE effective_date<=? ORDER BY effective_date DESC LIMIT 1").bind(date).fetch_one(&mut *tx).await?;
    let open: String = times.try_get("open_time")?;
    let close: String = times.try_get("close_time")?;
    let mapping: Option<Json<Mapping>> = sqlx::query_scalar("SELECT mapping FROM mapping_configs WHERE effective_date BETWEEN ? AND ? ORDER BY effective_date DESC LIMIT 1")
        .bind(NaiveDate::from_ymd_opt(date.year(),1,1).unwrap()).bind(date).fetch_optional(&mut *tx).await?;
    let mapping = mapping.unwrap_or_else(|| Json(Mapping::for_year(date.year())));
    sqlx::query("INSERT IGNORE INTO periods(id,business_date,open_time,close_time,mapping) VALUES(?,?,?,?,?)")
        .bind(&id).bind(date).bind(open).bind(close).bind(mapping).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(sqlx::query_as("SELECT * FROM periods WHERE id=?")
        .bind(id)
        .fetch_one(&state.pool)
        .await?)
}
pub async fn totals(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    id: &str,
    settled: bool,
) -> anyhow::Result<Totals> {
    let row=sqlx::query("SELECT CAST(COALESCE(SUM(IF(unit_count>void_units,1,0)),0) AS SIGNED) records, CAST(COALESCE(SUM(unit_count-void_units),0) AS SIGNED) units, CAST(COALESCE(SUM(stake-void_stake),0) AS SIGNED) stake, CAST(COALESCE(SUM(rebate),0) AS SIGNED) rebate, CAST(COALESCE(SUM(exposure),0) AS SIGNED) exposure, CAST(COALESCE(SUM(payout-void_stake),0) AS SIGNED) payout, CAST(COALESCE(SUM(winning_stake),0) AS SIGNED) winning, CAST(COALESCE(SUM(void_stake),0) AS SIGNED) refunded FROM bets WHERE period_id=? AND status<>'cancelled'").bind(id).fetch_one(&mut **tx).await?;
    let mut t = Totals {
        records: row.try_get("records")?,
        units: row.try_get("units")?,
        stake: row.try_get("stake")?,
        rebate: row.try_get("rebate")?,
        exposure: row.try_get("exposure")?,
        payout: row.try_get("payout")?,
        winning_stake: row.try_get("winning")?,
        refunded: row.try_get("refunded")?,
        ..Default::default()
    };
    if settled {
        t.losing_stake = t.stake - t.winning_stake;
        t.gross = Some(t.stake - t.payout);
        t.net = Some(t.stake - t.payout - t.rebate);
    }
    let fly = sqlx::query("SELECT CAST(COALESCE(SUM(stake-void_stake),0) AS SIGNED) stake, CAST(COALESCE(SUM(payout+rebate-stake),0) AS SIGNED) net FROM layoffs WHERE period_id=? AND status<>'cancelled'")
        .bind(id).fetch_one(&mut **tx).await?;
    t.flyout_stake = fly.try_get("stake")?;
    if settled {
        t.flyout_net = Some(fly.try_get("net")?);
        t.retained_net =
            Some(checked_sum([t.net.unwrap(), t.flyout_net.unwrap()]).map_err(anyhow::Error::msg)?);
    }
    Ok(t)
}
pub async fn view(state: &AppState, period: Period) -> anyhow::Result<PeriodView> {
    let mut tx = state.pool.begin().await?;
    let period: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR SHARE")
        .bind(&period.id)
        .fetch_one(&mut *tx)
        .await?;
    let now = state.now();
    let phase = if period.state != "pending" {
        period.state.clone()
    } else if now.date() < period.business_date
        || (now.date() == period.business_date
            && chrono::NaiveTime::parse_from_str(&period.open_time, "%H:%M")
                .is_ok_and(|open| now.time() < open))
    {
        "scheduled".into()
    } else if is_open_between(
        now,
        period.business_date,
        &period.open_time,
        &period.close_time,
    ) {
        "open".into()
    } else if now >= period.business_date.and_hms_opt(21, 34, 0).unwrap() {
        "fetching".into()
    } else {
        "closed".into()
    };
    let totals = totals(&mut tx, &period.id, period.state == "settled").await?;
    tx.commit().await?;
    Ok(PeriodView {
        period,
        phase,
        totals,
        server_time: format!("{}+08:00", now.format("%Y-%m-%dT%H:%M:%S")),
    })
}
pub async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    period: Option<&str>,
    event: &str,
    detail: serde_json::Value,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO audit_events(period_id,event,detail) VALUES(?,?,?)")
        .bind(period)
        .bind(event)
        .bind(Json(detail))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
