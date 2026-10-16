use super::accounts::{Account, Control};
use crate::{api::ApiResult, store::AppState};
use sqlx::{
    ConnectOptions, MySqlPool,
    mysql::{MySqlConnectOptions, MySqlPoolOptions},
};
use std::{
    collections::HashMap,
    ops::Deref,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};

// Every tenant uses a separate MySQL principal with grants only on its own
// schema. No request header or URL can choose an arbitrary database.
pub(super) async fn pool(a: &Account, max: u32) -> anyhow::Result<MySqlPool> {
    let host = std::env::var("TENANT_DB_HOST").unwrap_or_else(|_| "db".into());
    let port = std::env::var("TENANT_DB_PORT")
        .unwrap_or_else(|_| "3306".into())
        .parse()?;
    let options = MySqlConnectOptions::new()
        .host(&host)
        .port(port)
        .username(&a.database_user)
        .password(&a.database_password)
        .database(&a.database_name)
        .disable_statement_logging();
    let settings = MySqlPoolOptions::new()
        .max_connections(max)
        .min_connections(0)
        .idle_timeout(Duration::from_secs(1))
        .max_lifetime(Duration::from_secs(30))
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET time_zone='+00:00'")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        });
    Ok(settings.connect_lazy_with(options))
}
struct Entry {
    state: AppState,
    router: axum::Router,
    users: Arc<AtomicUsize>,
    touched: Instant,
}
impl Entry {
    fn borrow(&mut self) -> TenantLease {
        self.users.fetch_add(1, Ordering::AcqRel);
        self.touched = Instant::now();
        TenantLease {
            state: self.state.clone(),
            router: self.router.clone(),
            users: self.users.clone(),
        }
    }
    fn evictable(&self) -> bool {
        self.users.load(Ordering::Acquire) == 0
            && self
                .state
                .cancellations
                .try_lock()
                .is_ok_and(|flags| flags.is_empty())
    }
}
pub(super) struct TenantLease {
    state: AppState,
    pub router: axum::Router,
    users: Arc<AtomicUsize>,
}
impl Deref for TenantLease {
    type Target = AppState;
    fn deref(&self) -> &AppState {
        &self.state
    }
}
impl Drop for TenantLease {
    fn drop(&mut self) {
        self.users.fetch_sub(1, Ordering::AcqRel);
    }
}
const WARM_TENANTS: usize = 12;
#[derive(Clone)]
pub(super) struct Registry {
    pub control: Control,
    states: Arc<Mutex<HashMap<String, Entry>>>,
    cold_load: Arc<Mutex<()>>,
    pub work_gate: Arc<Semaphore>,
    risk_gate: Arc<Semaphore>,
    draw_cache: crate::store::DrawCache,
    client: reqwest::Client,
    pub(super) clock: Arc<dyn Fn() -> chrono::NaiveDateTime + Send + Sync>,
}
impl Registry {
    pub fn new(control: Control) -> anyhow::Result<Self> {
        Ok(Self {
            control,
            states: Arc::default(),
            cold_load: Arc::default(),
            work_gate: Arc::new(Semaphore::new(8)),
            risk_gate: Arc::new(Semaphore::new(1)),
            draw_cache: Arc::default(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent(concat!(
                    "MarkSix/",
                    env!("CARGO_PKG_VERSION"),
                    " (+hosted statistics)"
                ))
                .build()?,
            clock: Arc::new(|| {
                chrono::Utc::now()
                    .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
                    .naive_local()
            }),
        })
    }
    pub async fn lease(&self, a: &Account) -> ApiResult<TenantLease> {
        if let Some(entry) = self.states.lock().await.get_mut(&a.id) {
            return Ok(entry.borrow());
        }
        // SQL and pool close never hold the state-map lock used by warm requests.
        let _cold = self.cold_load.lock().await;
        let mut states = self.states.lock().await;
        if let Some(entry) = states.get_mut(&a.id) {
            return Ok(entry.borrow());
        }
        // Bound *all* live pools, not just each customer's pool. In-flight
        // requests and risk jobs pin their context; idle LRU contexts can close.
        // 12 pools x 2 connections = at most 24 customer connections per process.
        let evicted = if states.len() >= WARM_TENANTS {
            let oldest = states
                .iter()
                .filter(|(_, entry)| entry.evictable())
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(id, _)| id.clone());
            let id = oldest.ok_or_else(|| {
                crate::api::ApiError(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "服务器正在完成已有任务，请稍后重试".into(),
                )
            })?;
            Some(states.remove(&id).unwrap())
        } else {
            None
        };
        drop(states);
        if let Some(old) = evicted {
            old.state.pool.close().await;
        }
        let pool = pool(a, 2).await?;
        // Tenant migrations are applied by the authority, never by customer requests.
        let mut state = AppState::with_client(pool, self.client.clone());
        state.clock = self.clock.clone();
        state.secure_cookie = self.control.secure;
        state.risk_gate = self.risk_gate.clone();
        state.auth_gate = self.control.gate.clone();
        state.draw_cache = Some(self.draw_cache.clone());
        state.hosted = Some(super::Policy {
            pool: self.control.pool.clone(),
            account_id: a.id.clone(),
        });
        crate::worker::recover(&state).await?;
        let mut entry = Entry {
            router: crate::api::router(state.clone()),
            state,
            users: Arc::new(AtomicUsize::new(0)),
            touched: Instant::now(),
        };
        let lease = entry.borrow();
        self.states.lock().await.insert(a.id.clone(), entry);
        Ok(lease)
    }
    #[cfg(test)]
    pub async fn state(&self, a: &Account) -> ApiResult<AppState> {
        Ok(self.lease(a).await?.state.clone())
    }
    #[cfg(test)]
    pub async fn cached(&self) -> usize {
        self.states.lock().await.len()
    }
    pub async fn synchronize_admin(&self, a: &Account, state: &AppState) -> ApiResult<()> {
        sqlx::query("UPDATE administrators SET username=?,password_hash=? WHERE id=1")
            .bind(&a.username)
            .bind(&a.password_hash)
            .execute(&state.pool)
            .await?;
        Ok(())
    }
    pub async fn run(self) {
        let mut timer = tokio::time::interval(Duration::from_secs(15));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if let Err(e) = self.sweep().await {
                tracing::error!(error=%e,"hosted worker sweep failed");
            }
        }
    }
    async fn sweep(&self) -> anyhow::Result<()> {
        let accounts = sqlx::query_as::<_, Account>(
            "SELECT * FROM hosted_accounts WHERE state='ready' ORDER BY id",
        )
        .fetch_all(&self.control.pool)
        .await?;
        let ids: std::collections::HashSet<_> = accounts.iter().map(|a| a.id.as_str()).collect();
        let removed = {
            let mut states = self.states.lock().await;
            let keys: Vec<_> = states
                .keys()
                .filter(|id| !ids.contains(id.as_str()))
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|k| states.remove(&k))
                .collect::<Vec<_>>()
        };
        for entry in removed {
            let state = entry.state;
            for flag in state.cancellations.lock().await.values() {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            state.pool.close().await;
        }
        for account in accounts {
            let _permit = self.work_gate.acquire().await?;
            match self.lease(&account).await {
                Ok(state) => {
                    if let Err(e) = crate::worker::tick(&state).await {
                        tracing::error!(account_id=%account.id,error=%e,"tenant worker failed");
                    }
                }
                Err(e) => tracing::error!(account_id=%account.id,error=%e.1,"tenant unavailable"),
            }
            tokio::task::yield_now().await;
        }
        Ok(())
    }
}
