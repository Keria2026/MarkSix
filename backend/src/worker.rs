use crate::{
    domain::*,
    risk::{self, RiskError},
    store::*,
};
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{Value, json};
use sqlx::{Row, types::Json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub async fn recover(state: &AppState) -> anyhow::Result<()> {
    sqlx::query("UPDATE periods SET risk_status='queued',risk_requested_at=UTC_TIMESTAMP(6),risk_error=NULL,risk_task_id=NULL WHERE risk_status='computing' AND state='pending'").execute(&state.pool).await?;
    Ok(())
}
pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if let Err(e) = tick(&state).await {
            tracing::error!(error=%e,"background task failed; will retry");
        }
    }
}
pub async fn tick(state: &AppState) -> anyhow::Result<()> {
    let active = crate::hosted::require(state).await.is_ok();
    if !active {
        for flag in state.cancellations.lock().await.values() {
            flag.store(true, Ordering::Relaxed);
        }
        if state.hosted.is_none() {
            return Ok(());
        }
    }
    if let Some(policy) = &state.hosted
        && !crate::hosted::background_allowed(policy)
            .await
            .map_err(|e| anyhow::anyhow!(e.1))?
    {
        return Ok(());
    }
    if active {
        ensure_period(state, state.now().date()).await?;
    }
    let settling: Vec<String> = sqlx::query_scalar("SELECT id FROM periods WHERE state='settling'")
        .fetch_all(&state.pool)
        .await?;
    for id in settling {
        settle_period(state, &id).await?;
    }
    recover_risk_tasks(state).await?;
    if active {
        start_risk(state).await?;
    }
    let now = state.now();
    let periods: Vec<Period> =
        sqlx::query_as("SELECT * FROM periods WHERE state='pending' ORDER BY business_date")
            .fetch_all(&state.pool)
            .await?;
    let mut eligible = vec![];
    for p in periods {
        let start = p.business_date.and_hms_opt(21, 34, 0).unwrap();
        let end = start + ChronoDuration::days(1);
        if now >= end {
            mark_missing(state, &p.id, "抓取窗口结束，未取得本期有效开奖").await?;
            continue;
        }
        if now >= start
            && p.last_fetch_at
                .is_none_or(|last| Utc::now().naive_utc() - last >= ChronoDuration::seconds(60))
        {
            eligible.push(p);
        }
    }
    if eligible.is_empty() {
        return Ok(());
    }
    for p in &eligible {
        sqlx::query(
            "UPDATE periods SET last_fetch_at=UTC_TIMESTAMP(6) WHERE id=? AND state='pending'",
        )
        .bind(&p.id)
        .execute(&state.pool)
        .await?;
    }
    let response = fetch(state).await;
    for p in eligible {
        match &response {
            Ok(values) => process_response(state, &p, values).await?,
            Err(e) => {
                sqlx::query("UPDATE periods SET error=? WHERE id=? AND state='pending'")
                    .bind(format!("开奖获取失败：{e}"))
                    .bind(&p.id)
                    .execute(&state.pool)
                    .await?;
            }
        }
    }
    Ok(())
}
async fn fetch(state: &AppState) -> anyhow::Result<Vec<Value>> {
    if let Some(cache) = &state.draw_cache {
        let mut cache = cache.lock().await;
        if let Some((time, values)) = cache.as_ref()
            && time.elapsed() < Duration::from_secs(30)
        {
            return values.clone().map_err(anyhow::Error::msg);
        }
        let values = fetch_uncached(state).await.map_err(|e| e.to_string());
        *cache = Some((std::time::Instant::now(), values.clone()));
        return values.map_err(anyhow::Error::msg);
    }
    fetch_uncached(state).await
}
async fn fetch_uncached(state: &AppState) -> anyhow::Result<Vec<Value>> {
    let mut response = state
        .client
        .get(&state.draw_url)
        .send()
        .await?
        .error_for_status()?;
    if response.content_length().is_some_and(|n| n > 1_048_576) {
        anyhow::bail!("接口响应超过 1 MB");
    }
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 1_048_576 {
            anyhow::bail!("接口响应超过 1 MB");
        }
        bytes.extend_from_slice(&chunk);
    }
    let values: Vec<Value> = serde_json::from_slice(&bytes)?;
    Ok(values)
}
pub async fn process_response(
    state: &AppState,
    p: &Period,
    values: &[Value],
) -> anyhow::Result<()> {
    let mut errors = vec![];
    let mut valid = vec![];
    for v in values {
        match parse_draw(v) {
            Ok(draw) if draw.open_time <= state.now() => valid.push((draw, v)),
            Ok(_) => errors.push("接口开奖时间晚于当前时间".to_string()),
            Err(e) => errors.push(e),
        }
    }
    let matching: Vec<_> = valid
        .iter()
        .filter(|(d, _)| d.expect == p.id && d.open_time.date() == p.business_date)
        .collect();
    if !matching.is_empty() {
        for (draw, raw) in matching {
            accept_draw(state, draw, raw).await?;
        }
        return Ok(());
    }
    if valid
        .iter()
        .any(|(d, _)| d.open_time.date() > p.business_date)
    {
        mark_missing(state, &p.id, "接口已返回更晚期次，停止旧期抓取").await?;
        return Ok(());
    }
    let error = if errors.is_empty() {
        "接口尚未提供本期结果，将每 60 秒重试".into()
    } else {
        format!(
            "数据异常：{}；保留投注并继续重试",
            errors.join("；").chars().take(400).collect::<String>()
        )
    };
    sqlx::query("UPDATE periods SET error=? WHERE id=? AND state='pending'")
        .bind(error)
        .bind(&p.id)
        .execute(&state.pool)
        .await?;
    Ok(())
}
async fn mark_missing(state: &AppState, id: &str, reason: &str) -> anyhow::Result<()> {
    let mut tx = state.pool.begin().await?;
    let updated=sqlx::query("UPDATE periods SET state='missing',risk_status='stale',error=? WHERE id=? AND state='pending'").bind(reason).bind(id).execute(&mut *tx).await?;
    if updated.rows_affected() > 0 {
        audit(&mut tx, Some(id), "draw_missing", json!({"reason":reason})).await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn accept_draw(state: &AppState, draw: &Draw, raw: &Value) -> anyhow::Result<()> {
    let mut tx = state.pool.begin().await?;
    let Some(p): Option<Period> = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR UPDATE")
        .bind(&draw.expect)
        .fetch_optional(&mut *tx)
        .await?
    else {
        return Ok(());
    };
    if draw.open_time.date() != p.business_date {
        anyhow::bail!("目标期次日期不匹配");
    }
    if let Some(existing) = p.draw {
        if existing.0 != *draw {
            audit(
                &mut tx,
                Some(&p.id),
                "draw_conflict",
                json!({"received":raw,"preserved":existing}),
            )
            .await?;
            sqlx::query("UPDATE periods SET error='同一期出现不同开奖结果，已保留首次接受的结果' WHERE id=?").bind(&p.id).execute(&mut *tx).await?;
            tx.commit().await?;
            return Ok(());
        }
    } else if p.state == "pending" {
        sqlx::query("UPDATE periods SET draw=?,raw_draw=?,draw_accepted_at=UTC_TIMESTAMP(6),mapping_warning=?,state='settling',risk_status='stale',error=NULL WHERE id=?").bind(Json(draw)).bind(Json(raw)).bind(draw.differs_from(&p.mapping)).bind(&p.id).execute(&mut *tx).await?;
        audit(&mut tx, Some(&p.id), "draw_accepted", json!({"draw":draw})).await?;
    } else {
        tx.commit().await?;
        return Ok(());
    }
    tx.commit().await?;
    if let Some(flag) = state.cancellations.lock().await.get(&draw.expect) {
        flag.store(true, Ordering::Relaxed);
    }
    settle_period(state, &draw.expect).await?;
    Ok(())
}
pub async fn settle_period(state: &AppState, id: &str) -> anyhow::Result<()> {
    let mut tx = state.pool.begin().await?;
    let Some(p): Option<Period> = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
    else {
        return Ok(());
    };
    if p.state != "settling" {
        tx.commit().await?;
        return Ok(());
    }
    let draw = p
        .draw
        .ok_or_else(|| anyhow::anyhow!("结算期次缺少开奖快照"))?;
    // Both ledgers commit with the period, so reports never observe half a settlement.
    for table in ["bets", "layoffs"] {
        let rows = sqlx::query(&format!(
            "SELECT id,atoms FROM {table} WHERE period_id=? AND status='pending' FOR UPDATE"
        ))
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let bet_id: String = row.try_get("id")?;
            let atoms: Json<Vec<Atom>> = row.try_get("atoms")?;
            let results = settle(&atoms, &draw);
            let sum = |values: Vec<i64>| checked_sum(values).map_err(anyhow::Error::msg);
            let payout = sum(results.iter().map(|r| r.payout).collect())?;
            let rebate = sum(results.iter().map(|r| r.rebate).collect())?;
            let winning = sum(atoms
                .iter()
                .zip(&results)
                .filter(|(_, r)| r.won)
                .map(|(a, _)| a.stake)
                .collect())?;
            let refunded = sum(atoms
                .iter()
                .zip(&results)
                .filter(|(_, r)| r.voided)
                .map(|(a, _)| a.stake)
                .collect())?;
            let void_units = results.iter().filter(|r| r.voided).count() as i32;
            sqlx::query(&format!("UPDATE {table} SET status='settled',payout=?,rebate=?,winning_stake=?,void_stake=?,void_units=?,results=? WHERE id=?"))
                .bind(payout).bind(rebate).bind(winning).bind(refunded).bind(void_units).bind(Json(results)).bind(bet_id).execute(&mut *tx).await?;
        }
    }
    sqlx::query("UPDATE periods SET state='settled',settled_at=UTC_TIMESTAMP(6) WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        Some(id),
        "period_settled",
        json!({"version":p.bet_version}),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

// A missing in-memory owner can result from a panic or exhausted persistence
// retries. Never publish its result; converge to a visible failure on the next tick.
async fn recover_risk_tasks(state: &AppState) -> anyhow::Result<()> {
    let rows: Vec<(String, Option<String>, bool)> = sqlx::query_as(
        "SELECT id,risk_task_id,COALESCE(risk_started_at < DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 75 SECOND),TRUE) AS expired FROM periods WHERE risk_status='computing' AND state='pending'",
    ).fetch_all(&state.pool).await?;
    for (id, task, expired) in rows {
        let owned = {
            let flags = state.cancellations.lock().await;
            if expired && let Some(flag) = flags.get(&id) {
                flag.store(true, Ordering::Relaxed);
            }
            flags.contains_key(&id)
        };
        if !owned || expired {
            sqlx::query("UPDATE periods SET risk_status='failed',risk_result=NULL,risk_error='计算任务中断或结果保存失败，请重新计算',risk_finished_at=UTC_TIMESTAMP(6),risk_task_id=NULL WHERE id=? AND risk_task_id <=> ? AND risk_status='computing' AND state='pending'")
                .bind(&id).bind(task).execute(&state.pool).await?;
        }
    }
    Ok(())
}

struct RiskWrite<'a> {
    period: &'a str,
    version: i64,
    task_id: &'a str,
    status: &'a str,
    data: Option<&'a Json<risk::RiskResult>>,
    error: Option<&'a str>,
}
async fn persist_risk(state: &AppState, write: RiskWrite<'_>) -> bool {
    for retry in 0..3 {
        let saved = sqlx::query("UPDATE periods SET risk_status=?,risk_result=?,risk_error=?,risk_finished_at=UTC_TIMESTAMP(6),risk_task_id=NULL WHERE id=? AND bet_version=? AND risk_task_id=? AND state='pending' AND risk_status='computing'")
                .bind(write.status).bind(write.data).bind(write.error).bind(write.period).bind(write.version).bind(write.task_id).execute(&state.pool).await;
        match saved {
            Ok(result) => return result.rows_affected() == 1,
            Err(e) => {
                tracing::error!(error=%e,attempt=retry+1,"risk persistence failed");
                if retry < 2 {
                    tokio::time::sleep(Duration::from_millis(250 * (retry + 1))).await;
                }
            }
        }
    }
    false
}

pub async fn start_risk(state: &AppState) -> anyhow::Result<()> {
    let Ok(permit) = state.risk_gate.clone().try_acquire_owned() else {
        return Ok(());
    };
    let mut tx = state.pool.begin().await?;
    let Some(p)=sqlx::query_as::<_,Period>("SELECT * FROM periods WHERE risk_status='queued' AND state='pending' ORDER BY risk_requested_at LIMIT 1 FOR UPDATE SKIP LOCKED").fetch_optional(&mut *tx).await? else {tx.commit().await?;return Ok(());};
    let rows: Vec<Json<Vec<Atom>>> =
        sqlx::query_scalar("SELECT atoms FROM bets WHERE period_id=? AND status='pending'")
            .bind(&p.id)
            .fetch_all(&mut *tx)
            .await?;
    let mut atoms: Vec<Atom> = rows.into_iter().flat_map(|j| j.0).collect();
    let outgoing: Vec<Json<Vec<Atom>>> =
        sqlx::query_scalar("SELECT atoms FROM layoffs WHERE period_id=? AND status='pending'")
            .bind(&p.id)
            .fetch_all(&mut *tx)
            .await?;
    atoms.extend(outgoing.into_iter().flat_map(|j| j.0).map(|mut a| {
        a.position = -1;
        a
    }));
    let task_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("UPDATE periods SET risk_status='computing',risk_started_at=UTC_TIMESTAMP(6),risk_version=?,risk_task_id=? WHERE id=?").bind(p.bet_version).bind(&task_id).bind(&p.id).execute(&mut *tx).await?;
    let cancel = Arc::new(AtomicBool::new(false));
    // Commit and register under the same owner lock used by the watchdog.
    let mut owners = state.cancellations.lock().await;
    tx.commit().await?;
    owners.insert(p.id.clone(), cancel.clone());
    drop(owners);
    let state = state.clone();
    tokio::spawn(async move {
        let elapsed = (Utc::now().naive_utc() - p.risk_requested_at)
            .to_std()
            .unwrap_or_default();
        let budget = Duration::from_secs(60).saturating_sub(elapsed);
        let flag = cancel.clone();
        let mapping = p.mapping.0;
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            risk::solve(&atoms, &mapping, budget, &flag)
        })
        .await;
        let (status, data, error) = match result {
            Ok(Ok(result)) => ("complete", Some(Json(result)), None),
            Ok(Err(RiskError::Timeout)) => ("timeout", None, Some(RiskError::Timeout.to_string())),
            Ok(Err(RiskError::Cancelled)) => {
                ("stale", None, Some(RiskError::Cancelled.to_string()))
            }
            Ok(Err(e)) => ("failed", None, Some(e.to_string())),
            Err(e) => ("failed", None, Some(format!("计算任务异常：{e}"))),
        };
        persist_risk(
            &state,
            RiskWrite {
                period: &p.id,
                version: p.bet_version,
                task_id: &task_id,
                status,
                data: data.as_ref(),
                error: error.as_deref(),
            },
        )
        .await;
        let mut flags = state.cancellations.lock().await;
        if flags.get(&p.id).is_some_and(|f| Arc::ptr_eq(f, &cancel)) {
            flags.remove(&p.id);
        }
    });
    Ok(())
}

#[cfg(test)]
mod hosted_fetch_tests {
    use super::*;
    #[tokio::test]
    async fn shared_failure_cache_prevents_per_customer_retry_storms() {
        use axum::{Router, http::StatusCode, routing::get};
        use std::sync::atomic::AtomicUsize;
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = requests.clone();
        let app = Router::new().route(
            "/draw",
            get(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    StatusCode::SERVICE_UNAVAILABLE
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .connect_lazy("mysql://unused:unused@127.0.0.1/unused")
            .unwrap();
        let mut state = AppState::new(pool).unwrap();
        state.draw_url = format!("http://{address}/draw");
        state.client = reqwest::Client::builder().no_proxy().build().unwrap();
        state.draw_cache = Some(Arc::default());
        let (a, b) = tokio::join!(fetch(&state), fetch(&state));
        assert!(a.is_err() && b.is_err());
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        server.abort();
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    async fn wait_idle(state: &AppState) -> Result<(), tokio::time::error::Elapsed> {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !state.cancellations.lock().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
    }

    #[tokio::test]
    #[ignore = "requires disposable TEST_DATABASE_URL and TEST_PROVISION_DATABASE_URL ending in /marksix_test"]
    async fn risk_persistence_failure_orphan_timeout_and_fencing() {
        let url = std::env::var("TEST_DATABASE_URL").unwrap();
        assert!(url.ends_with("/marksix_test"));
        let pool = connect(&url).await.unwrap();
        let ddl_url = std::env::var("TEST_PROVISION_DATABASE_URL").unwrap();
        assert!(ddl_url.ends_with("/marksix_test"));
        let ddl = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(1)
            .connect(&ddl_url)
            .await
            .unwrap();
        initialize(&pool, "test-admin", Some("disposable-test-password"))
            .await
            .unwrap();
        let mut state = AppState::new(pool.clone()).unwrap();
        let date = chrono::NaiveDate::from_ymd_opt(2040, 11, 16).unwrap();
        state.clock = Arc::new(move || date.and_hms_opt(12, 0, 0).unwrap());
        let period = ensure_period(&state, date).await.unwrap();
        let id = period.id;
        // Isolate the pending fixture from older test periods.
        sqlx::query("UPDATE periods SET risk_status='stale' WHERE id<>?")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE periods SET risk_status='queued',state='pending',risk_requested_at=UTC_TIMESTAMP(6),bet_version=1 WHERE id=?").bind(&id).execute(&pool).await.unwrap();
        sqlx::raw_sql("DROP TRIGGER IF EXISTS marksix_test_risk_failure")
            .execute(&ddl)
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TRIGGER marksix_test_risk_failure BEFORE UPDATE ON periods FOR EACH ROW BEGIN IF OLD.risk_status='computing' AND NEW.risk_status='complete' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected result write failure'; END IF; END").execute(&ddl).await.unwrap();
        let started = start_risk(&state).await;
        let completed = wait_idle(&state).await;
        // Remove the fault before assertions, so retries never poison later tests.
        sqlx::raw_sql("DROP TRIGGER marksix_test_risk_failure")
            .execute(&ddl)
            .await
            .unwrap();
        started.unwrap();
        completed.unwrap();
        recover_risk_tasks(&state).await.unwrap();
        let failed: (String, Option<String>) =
            sqlx::query_as("SELECT risk_status,risk_error FROM periods WHERE id=?")
                .bind(&id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(failed.0, "failed");
        assert!(failed.1.unwrap().contains("保存失败"));
        // A fresh calculation succeeds after the storage fault has been removed.
        sqlx::query(
            "UPDATE periods SET risk_status='queued',risk_requested_at=UTC_TIMESTAMP(6) WHERE id=?",
        )
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
        start_risk(&state).await.unwrap();
        wait_idle(&state).await.unwrap();
        let complete: String = sqlx::query_scalar("SELECT risk_status FROM periods WHERE id=?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(complete, "complete");
        // A hung owner is bounded independently of its in-memory presence.
        let flag = Arc::new(AtomicBool::new(false));
        state
            .cancellations
            .lock()
            .await
            .insert(id.clone(), flag.clone());
        sqlx::query("UPDATE periods SET risk_status='computing',risk_task_id='orphan',risk_started_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 76 SECOND) WHERE id=?").bind(&id).execute(&pool).await.unwrap();
        recover_risk_tasks(&state).await.unwrap();
        assert!(flag.load(Ordering::Relaxed));
        // A result from an older task ID cannot overwrite a new same-version task.
        sqlx::query("UPDATE periods SET risk_status='computing',risk_task_id='new',risk_started_at=UTC_TIMESTAMP(6) WHERE id=?").bind(&id).execute(&pool).await.unwrap();
        let changed = persist_risk(
            &state,
            RiskWrite {
                period: &id,
                version: 1,
                task_id: "orphan",
                status: "complete",
                data: None,
                error: None,
            },
        )
        .await;
        assert!(!changed);
        let task: Option<String> =
            sqlx::query_scalar("SELECT risk_task_id FROM periods WHERE id=?")
                .bind(&id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(task.as_deref(), Some("new"));
        // Restart recovery discards task identity and queues an exact recomputation.
        recover(&state).await.unwrap();
        let recovered: (String, Option<String>) =
            sqlx::query_as("SELECT risk_status,risk_task_id FROM periods WHERE id=?")
                .bind(&id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(recovered, ("queued".into(), None));
        state.cancellations.lock().await.clear();
        sqlx::query("UPDATE periods SET risk_status='stale' WHERE id=?")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }
}
