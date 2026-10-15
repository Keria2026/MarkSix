use crate::{domain::*, risk, store::*};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::{NaiveDate, NaiveTime};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, types::Json as DbJson};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error=%e,"database operation failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "数据库操作失败，请重试；如持续出现请检查服务日志".into(),
        )
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error=%e,"operation failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "操作失败，请检查服务日志".into(),
        )
    }
}
impl From<String> for ApiError {
    fn from(e: String) -> Self {
        Self(StatusCode::UNPROCESSABLE_ENTITY, e)
    }
}
pub(crate) type ApiResult<T> = Result<T, ApiError>;
pub(crate) fn conflict(s: &str) -> ApiError {
    ApiError(StatusCode::CONFLICT, s.into())
}
pub(crate) fn missing() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "记录不存在".into())
}
pub(crate) fn digest(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
fn token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|s| s.trim().strip_prefix("marksix_session="))
}
fn cookie(state: &AppState, value: &str, max_age: u32) -> String {
    format!(
        "marksix_session={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{}",
        if state.secure_cookie { "; Secure" } else { "" }
    )
}

#[derive(Clone, Copy)]
pub(crate) struct ReceivedAt(pub chrono::NaiveDateTime);

pub fn router(state: AppState) -> Router {
    router_with_frontend(state, None)
}
pub fn router_with_frontend(state: AppState, frontend: Option<std::path::PathBuf>) -> Router {
    let private = Router::new()
        .route("/session", get(session))
        .route("/license", get(crate::license::status))
        .route("/license/activate", post(crate::license::activate))
        .route("/logout", post(logout))
        .route("/bootstrap", get(bootstrap))
        .route("/periods", get(periods))
        .route("/periods/{id}", get(period))
        .route("/bets", get(bets).post(create_bet))
        .route("/bets/{id}/amount", put(crate::ledger::change_amount))
        .route("/bets/{id}/layoffs", post(crate::ledger::fly_out))
        .route("/layoffs/{id}/cancel", post(crate::ledger::cancel_layoff))
        .route("/periods/{id}/statistics", get(crate::ledger::statistics))
        .route("/parties", get(crate::ledger::parties))
        .route("/bets/{id}", get(bet_detail))
        .route("/bets/{id}/cancel", post(cancel_bet))
        .route("/quote", post(quote))
        .route("/plays", post(create_play))
        .route(
            "/plays/{id}",
            put(update_play).delete(crate::configuration::delete),
        )
        .route("/plays/export", get(crate::configuration::export))
        .route("/plays/import", post(crate::configuration::import))
        .route("/settings", get(settings))
        .route("/settings/closing", put(update_closing))
        .route("/settings/mapping", put(update_mapping))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    let mut app = Router::new();
    if let Some(directory) = frontend {
        app = app.fallback_service(tower_http::services::ServeDir::new(directory));
    }
    app.nest(
        "/api",
        private
            .route("/login", post(login))
            .route("/health", get(health))
            .route("/internal/shutdown", post(shutdown))
            .fallback(|| async { (StatusCode::NOT_FOUND, "Unknown API endpoint") }),
    )
    .layer(DefaultBodyLimit::max(1024 * 1024))
    .layer(middleware::from_fn(security_headers))
    .layer(middleware::from_fn_with_state(state.clone(), receive_time))
    .layer(tower_http::trace::TraceLayer::new_for_http())
    .with_state(state)
}
async fn receive_time(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    req.extensions_mut().insert(ReceivedAt(state.now()));
    next.run(req).await
}
async fn security_headers(req: Request, next: Next) -> Response {
    if !matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    ) && req.headers().get("x-marksix").and_then(|v| v.to_str().ok()) != Some("1")
    {
        return ApiError(
            StatusCode::FORBIDDEN,
            "请求校验失败，请从本系统页面操作".into(),
        )
        .into_response();
    }
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    for (name, value) in [
        ("x-frame-options", "DENY"),
        ("referrer-policy", "same-origin"),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src https://macaujc.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        ),
    ] {
        response.headers_mut().insert(name, value.parse().unwrap());
    }
    response
}
async fn authenticate(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let valid = if let Some(value) = token(req.headers()).filter(|v| v.len() == 64) {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP(6)",
        )
        .bind(digest(value))
        .fetch_one(&state.pool)
        .await
        .map(|n| n == 1)
    } else {
        Ok(false)
    };
    match valid {
        Ok(true) => {
            if !matches!(
                req.uri().path(),
                "/api/session" | "/api/logout" | "/api/license" | "/api/license/activate"
            ) && let Err(e) = crate::license::require(&state).await
            {
                return e.into_response();
            }
            next.run(req).await
        }
        Ok(false) => ApiError(StatusCode::UNAUTHORIZED, "请先登录".into()).into_response(),
        Err(e) => ApiError::from(e).into_response(),
    }
}
#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
}
async fn verify_admin(state: &AppState, input: Login) -> ApiResult<()> {
    if input.password.len() > 256 || input.username.len() > 240 {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "账号或密码错误".into()));
    }
    {
        let mut attempts = state.login_attempts.lock().await;
        while attempts
            .front()
            .is_some_and(|t| t.elapsed() > Duration::from_secs(60))
        {
            attempts.pop_front();
        }
        if attempts.len() >= 12 {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "登录尝试过于频繁，请一分钟后重试".into(),
            ));
        }
        attempts.push_back(Instant::now());
    }
    let permit = state.auth_gate.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "正在验证登录，请稍后重试".into(),
        )
    })?;
    let row = sqlx::query("SELECT username,password_hash FROM administrators WHERE id=1")
        .fetch_one(&state.pool)
        .await?;
    let username: String = row.try_get("username")?;
    let hash: String = row.try_get("password_hash")?;
    let matches = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let password_ok = PasswordHash::new(&hash).is_ok_and(|hash| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &hash)
                .is_ok()
        });
        password_ok && input.username == username
    })
    .await
    .map_err(anyhow::Error::from)?;
    if !matches {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "账号或密码错误".into()));
    }
    Ok(())
}
async fn login(State(state): State<AppState>, Json(input): Json<Login>) -> ApiResult<Response> {
    verify_admin(&state, input).await?;
    let mut bytes = [0; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let value = hex::encode(bytes);
    sqlx::query("DELETE FROM sessions WHERE expires_at<=UTC_TIMESTAMP(6)")
        .execute(&state.pool)
        .await?;
    sqlx::query("INSERT INTO sessions(token_hash,expires_at) VALUES(?,DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 24 HOUR))").bind(digest(&value)).execute(&state.pool).await?;
    Ok((
        [(header::SET_COOKIE, cookie(&state, &value, 86400))],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(v) = token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=?")
            .bind(digest(v))
            .execute(&state.pool)
            .await?;
    }
    Ok((
        [(header::SET_COOKIE, cookie(&state, "", 0))],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn session(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let name: String = sqlx::query_scalar("SELECT username FROM administrators WHERE id=1")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(json!({"username":name})))
}
async fn health(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(
        json!({"status":"ok","version":env!("CARGO_PKG_VERSION")}),
    ))
}
async fn bootstrap(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let today = ensure_period(&state, state.now().date()).await?;
    let plays: Vec<Play> = sqlx::query_as(
        "SELECT id,version,rule,enabled FROM plays WHERE deleted_at IS NULL ORDER BY id",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        json!({"today":view(&state,today).await?,"plays":plays,"zodiacs":ZODIACS}),
    ))
}
#[derive(Deserialize, Default)]
struct Page {
    page: Option<u32>,
    search: Option<String>,
    period: Option<String>,
    play_id: Option<i64>,
    bettor: Option<String>,
    unassigned: Option<bool>,
    min_amount: Option<String>,
    max_amount: Option<String>,
}
async fn periods(State(state): State<AppState>, Query(q): Query<Page>) -> ApiResult<Json<Value>> {
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
        "SELECT COUNT(*) FROM periods WHERE id LIKE ? OR CAST(business_date AS CHAR) LIKE ?",
    )
    .bind(&search)
    .bind(&search)
    .fetch_one(&state.pool)
    .await?;
    let rows:Vec<Period>=sqlx::query_as("SELECT * FROM periods WHERE id LIKE ? OR CAST(business_date AS CHAR) LIKE ? ORDER BY business_date DESC LIMIT 20 OFFSET ?").bind(&search).bind(&search).bind((page-1)*20).fetch_all(&state.pool).await?;
    let mut items = vec![];
    for p in rows {
        items.push(view(&state, p).await?);
    }
    Ok(Json(
        json!({"items":items,"total":count,"page":page,"page_size":20}),
    ))
}
async fn period(
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
async fn bets(State(state): State<AppState>, Query(q): Query<Page>) -> ApiResult<Json<Value>> {
    let id = q.period.unwrap_or_else(|| period_id(state.now().date()));
    let page = q.page.unwrap_or(1).clamp(1, 100000);
    let play = q.play_id;
    let bettor = if q.unassigned == Some(true) {
        Some(String::new())
    } else {
        q.bettor.filter(|v| !v.is_empty())
    };
    let min = q.min_amount.as_deref().map(|v| scaled(v, 2)).transpose()?;
    let max = q.max_amount.as_deref().map(|v| scaled(v, 2)).transpose()?;
    if min.zip(max).is_some_and(|(a, b)| a > b) {
        return Err(conflict("金额下限不能超过上限"));
    }
    let predicate = "period_id=? AND (? IS NULL OR play_id=?) AND (? IS NULL OR bettor=?) AND (? IS NULL OR stake>=?) AND (? IS NULL OR stake<=?)";
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM bets WHERE {predicate}"))
        .bind(&id)
        .bind(play)
        .bind(play)
        .bind(&bettor)
        .bind(&bettor)
        .bind(min)
        .bind(min)
        .bind(max)
        .bind(max)
        .fetch_one(&state.pool)
        .await?;
    let items: Vec<BetSummary> = sqlx::query_as(&format!("SELECT {BET_COLUMNS} FROM bets WHERE {predicate} ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?"))
        .bind(&id).bind(play).bind(play).bind(&bettor).bind(&bettor).bind(min).bind(min).bind(max).bind(max).bind((page-1)*25).fetch_all(&state.pool).await?;
    Ok(Json(
        json!({"items":items,"total":count,"page":page,"page_size":25}),
    ))
}
async fn bet_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let summary: BetSummary = sqlx::query_as(&format!(
        "SELECT {BET_COLUMNS} FROM bets WHERE id=? FOR SHARE"
    ))
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(missing)?;
    let row = sqlx::query("SELECT atoms,results FROM bets WHERE id=?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    let atoms: DbJson<Vec<Atom>> = row.try_get("atoms")?;
    let results: Option<DbJson<Vec<AtomResult>>> = row.try_get("results")?;
    let layoffs: Vec<crate::ledger::Layoff> = sqlx::query_as(&format!(
        "SELECT {} FROM layoffs WHERE bet_id=? ORDER BY created_at DESC,id DESC",
        crate::ledger::LAYOFF_COLUMNS
    ))
    .bind(&id)
    .fetch_all(&mut *tx)
    .await?;
    let audit_rows = sqlx::query("SELECT event,detail,created_at FROM audit_events WHERE period_id=? AND JSON_UNQUOTE(JSON_EXTRACT(detail,'$.id'))=? ORDER BY id DESC LIMIT 100").bind(&summary.period_id).bind(&id).fetch_all(&mut *tx).await?;
    let events: Vec<Value> = audit_rows.into_iter().map(|r| Ok(json!({"event":r.try_get::<String,_>("event")?,"detail":r.try_get::<DbJson<Value>,_>("detail")?,"created_at":r.try_get::<chrono::NaiveDateTime,_>("created_at")?}))).collect::<Result<_,sqlx::Error>>()?;
    tx.commit().await?;
    Ok(Json(
        json!({"record":summary,"atoms":atoms,"results":results,"layoffs":layoffs,"events":events}),
    ))
}
async fn current_plan(state: &AppState, input: &BetInput) -> ApiResult<(Period, Play, BetPlan)> {
    let p = ensure_period(state, state.now().date()).await?;
    if input.period != p.id {
        return Err(conflict("期次已切换，请刷新后重新录入"));
    }
    let play: Play = sqlx::query_as(
        "SELECT id,version,rule,enabled FROM plays WHERE id=? AND deleted_at IS NULL",
    )
    .bind(input.play_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(missing)?;
    if play.version != input.play_version || !play.enabled {
        return Err(conflict("玩法配置已变更或停用，请刷新并确认最新规则"));
    }
    let plan = plan(&play.rule, input, &p.mapping)?;
    Ok((p, play, plan))
}
async fn create_bet(
    State(state): State<AppState>,
    Extension(ReceivedAt(received)): Extension<ReceivedAt>,
    Json(mut input): Json<BetInput>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&input.request_id).map_err(|_| {
        ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "提交标识不合法，请刷新页面".into(),
        )
    })?;
    input.bettor = crate::ledger::party(&input.bettor)?;
    let hash = digest(&serde_json::to_string(&input).map_err(anyhow::Error::from)?);
    if let Some(row) = sqlx::query("SELECT id,request_hash FROM bets WHERE request_id=?")
        .bind(&input.request_id)
        .fetch_optional(&state.pool)
        .await?
    {
        if row.try_get::<String, _>("request_hash")? != hash {
            return Err(conflict("同一提交标识不能用于不同投注"));
        }
        return Ok(Json(
            json!({"id":row.try_get::<String,_>("id")?,"replayed":true}),
        ));
    }
    let p = ensure_period(&state, received.date()).await?;
    if input.period != p.id {
        return Err(conflict("期次已切换，请刷新后重新录入"));
    }
    let mut tx = state.pool.begin().await?;
    let locked: Period = sqlx::query_as("SELECT * FROM periods WHERE id=? FOR UPDATE")
        .bind(&p.id)
        .fetch_one(&mut *tx)
        .await?;
    // Repeat idempotency under the period lock, including retries racing one another.
    if let Some(row) = sqlx::query("SELECT id,request_hash FROM bets WHERE request_id=?")
        .bind(&input.request_id)
        .fetch_optional(&mut *tx)
        .await?
    {
        if row.try_get::<String, _>("request_hash")? != hash {
            return Err(conflict("同一提交标识不能用于不同投注"));
        }
        let id: String = row.try_get("id")?;
        tx.commit().await?;
        return Ok(Json(json!({"id":id,"replayed":true})));
    }
    if locked.state != "pending"
        || !is_open_between(
            received,
            locked.business_date,
            &locked.open_time,
            &locked.close_time,
        )
    {
        return Err(conflict("当前不在投注时间内，或本期已经封盘／接受开奖"));
    }
    let play: Play = sqlx::query_as(
        "SELECT id,version,rule,enabled FROM plays WHERE id=? AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(input.play_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| conflict("玩法已删除，请刷新后重新选择"))?;
    if !play.enabled || play.version != input.play_version {
        return Err(conflict("玩法配置已变更，请刷新后确认"));
    }
    let p = plan(&play.rule, &input, &locked.mapping)?;
    let totals=sqlx::query("SELECT COUNT(*) records, CAST(COALESCE(SUM(unit_count),0) AS SIGNED) units, CAST(COALESCE(SUM(stake),0) AS SIGNED) stake, CAST(COALESCE(SUM(exposure),0) AS SIGNED) exposure FROM bets WHERE period_id=? AND status<>'cancelled'").bind(&locked.id).fetch_one(&mut *tx).await?;
    if totals.try_get::<i64, _>("records")? >= 1000
        || totals.try_get::<i64, _>("units")? + p.atoms.len() as i64 > 10000
    {
        return Err(conflict(
            "本期容量已满：最多 1000 条有效记录、10000 条基础注",
        ));
    }
    checked_sum([totals.try_get("stake")?, p.stake])?;
    let outgoing_budget: i64 = sqlx::query_scalar("SELECT CAST(COALESCE(SUM(stake+exposure),0) AS SIGNED) FROM layoffs WHERE period_id=? AND status<>'cancelled'").bind(&locked.id).fetch_one(&mut *tx).await?;
    checked_sum([
        totals.try_get("stake")?,
        totals.try_get("exposure")?,
        outgoing_budget,
        p.stake,
        p.exposure,
    ])?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO bets(id,request_id,request_hash,period_id,play_id,play_version,rule,selections,compound,amount,unit_count,stake,rebate,exposure,natal,atoms,bettor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&id).bind(&input.request_id).bind(hash).bind(&locked.id).bind(play.id).bind(play.version).bind(play.rule).bind(DbJson(&input.selections)).bind(input.compound).bind(p.atoms[0].stake).bind(p.atoms.len() as i32).bind(p.stake).bind(p.rebate).bind(p.exposure).bind(locked.mapping.natal as i8).bind(DbJson(&p.atoms)).bind(&input.bettor).execute(&mut *tx).await?;
    sqlx::query("UPDATE periods SET bet_version=bet_version+1,risk_status='queued',risk_requested_at=UTC_TIMESTAMP(6),risk_error=NULL WHERE id=?").bind(&locked.id).execute(&mut *tx).await?;
    audit(
        &mut tx,
        Some(&locked.id),
        "bet_created",
        json!({"id":id,"units":p.atoms.len()}),
    )
    .await?;
    tx.commit().await?;
    if let Some(flag) = state.cancellations.lock().await.get(&locked.id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(Json(json!({"id":id,"replayed":false})))
}
async fn cancel_bet(
    State(state): State<AppState>,
    Extension(ReceivedAt(received)): Extension<ReceivedAt>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
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
    let status: String = sqlx::query_scalar("SELECT status FROM bets WHERE id=? FOR UPDATE")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if status == "cancelled" {
        tx.commit().await?;
        return Ok(Json(json!({"ok":true})));
    }
    if p.state != "pending"
        || !is_open_between(received, p.business_date, &p.open_time, &p.close_time)
    {
        return Err(conflict("封盘后不能撤销投注"));
    }
    let outgoing: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM layoffs WHERE bet_id=? AND status<>'cancelled'")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
    if outgoing > 0 {
        return Err(conflict("请先撤销该投注关联的飞出记录，再作废原投注"));
    }
    sqlx::query("UPDATE bets SET status='cancelled',revision=revision+1,cancelled_at=UTC_TIMESTAMP(6) WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE periods SET bet_version=bet_version+1,risk_status='queued',risk_requested_at=UTC_TIMESTAMP(6),risk_error=NULL WHERE id=?").bind(&period).execute(&mut *tx).await?;
    audit(&mut tx, Some(&period), "bet_cancelled", json!({"id":id})).await?;
    tx.commit().await?;
    if let Some(flag) = state.cancellations.lock().await.get(&period) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(Json(json!({"ok":true})))
}
async fn quote(
    State(state): State<AppState>,
    Json(input): Json<BetInput>,
) -> ApiResult<Json<Value>> {
    let started = Instant::now();
    let (period, _, plan) = current_plan(&state, &input).await?;
    let permit = state.risk_gate.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "精确计算正在运行，稍后自动重试".into(),
        )
    })?;
    let atoms = plan.atoms.clone();
    let mapping = period.mapping.0;
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let result = risk::solve(
            &atoms,
            &mapping,
            Duration::from_secs(60).saturating_sub(started.elapsed()),
            &AtomicBool::new(false),
        )?;
        let max_return = if atoms.iter().any(|a| a.void_on_49) {
            let mut payout_only = atoms.clone();
            for a in &mut payout_only {
                a.rebate = 0;
            }
            risk::solve(
                &payout_only,
                &mapping,
                Duration::from_secs(60).saturating_sub(started.elapsed()),
                &AtomicBool::new(false),
            )?
            .max_payout
        } else {
            result.max_payout
        };
        Ok::<_, risk::RiskError>((result, max_return))
    })
    .await
    .map_err(anyhow::Error::from)?;
    let (result, max_return) =
        result.map_err(|e| ApiError(StatusCode::REQUEST_TIMEOUT, e.to_string()))?;
    Ok(Json(
        json!({"units":plan.atoms.len(),"stake":plan.stake,"rebate":plan.rebate,"max_return":max_return,"max_profit":-result.min_net.unwrap_or(0),"result":result}),
    ))
}
async fn create_play(
    State(state): State<AppState>,
    Json(rule): Json<Rule>,
) -> ApiResult<Json<Value>> {
    rule.validate()?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM administrators WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plays WHERE deleted_at IS NULL")
        .fetch_one(&mut *tx)
        .await?;
    if count >= 1000 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "玩法总数不能超过 1000 条".into(),
        ));
    }
    let result = sqlx::query("INSERT INTO plays(version,rule) VALUES(1,?)")
        .bind(DbJson(&rule))
        .execute(&mut *tx)
        .await?;
    let id = result.last_insert_id() as i64;
    sqlx::query("INSERT INTO play_versions(play_id,version,rule) VALUES(?,1,?)")
        .bind(id)
        .bind(DbJson(&rule))
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, None, "play_created", json!({"id":id,"rule":rule})).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}
#[derive(Deserialize)]
struct UpdatePlay {
    version: i64,
    rule: Rule,
    enabled: bool,
}
async fn update_play(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<UpdatePlay>,
) -> ApiResult<Json<Value>> {
    input.rule.validate()?;
    let mut tx = state.pool.begin().await?;
    let play: Play = sqlx::query_as(
        "SELECT id,version,rule,enabled FROM plays WHERE id=? AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(missing)?;
    if play.version != input.version {
        return Err(conflict("配置已被更新，请刷新后再保存"));
    }
    let version = play.version + 1;
    sqlx::query(
        "UPDATE plays SET version=?,rule=?,enabled=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?",
    )
    .bind(version)
    .bind(DbJson(&input.rule))
    .bind(input.enabled)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO play_versions(play_id,version,rule) VALUES(?,?,?)")
        .bind(id)
        .bind(version)
        .bind(DbJson(&input.rule))
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        None,
        "play_updated",
        json!({"id":id,"version":version,"rule":input.rule,"enabled":input.enabled}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"version":version})))
}
async fn settings(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows=sqlx::query("SELECT effective_date,open_time,close_time FROM closing_configs ORDER BY effective_date DESC LIMIT 50").fetch_all(&state.pool).await?;
    let closing:Vec<Value>=rows.into_iter().map(|r|Ok(json!({"effective_date":r.try_get::<NaiveDate,_>("effective_date")?,"close_time":r.try_get::<String,_>("close_time")?,"open_time":r.try_get::<String,_>("open_time")?}))).collect::<Result<_,sqlx::Error>>()?;
    let rows = sqlx::query(
        "SELECT effective_date,mapping FROM mapping_configs ORDER BY effective_date DESC LIMIT 50",
    )
    .fetch_all(&state.pool)
    .await?;
    let mappings:Vec<Value>=rows.into_iter().map(|r|Ok(json!({"effective_date":r.try_get::<NaiveDate,_>("effective_date")?,"mapping":r.try_get::<DbJson<Mapping>,_>("mapping")?}))).collect::<Result<_,sqlx::Error>>()?;
    Ok(Json(
        json!({"closing":closing,"mappings":mappings,"tomorrow":state.now().date().succ_opt()}),
    ))
}
#[derive(Deserialize)]
struct CloseInput {
    open_time: String,
    close_time: String,
    username: String,
    password: String,
}
async fn update_closing(
    State(state): State<AppState>,
    Json(input): Json<CloseInput>,
) -> ApiResult<Json<Value>> {
    verify_admin(
        &state,
        Login {
            username: input.username,
            password: input.password,
        },
    )
    .await
    .map_err(|e| {
        if e.0 == StatusCode::UNAUTHORIZED {
            ApiError(
                StatusCode::FORBIDDEN,
                "账号或密码错误，时间配置未修改".into(),
            )
        } else {
            e
        }
    })?;
    let open = NaiveTime::parse_from_str(&input.open_time, "%H:%M")
        .map_err(|_| conflict("开始时间格式应为 HH:MM"))?;
    let close = NaiveTime::parse_from_str(&input.close_time, "%H:%M")
        .map_err(|_| conflict("封盘时间格式应为 HH:MM"))?;
    if input.open_time.len() != 5 || input.close_time.len() != 5 || close <= open {
        return Err(conflict("封盘时间须晚于开始时间，不能跨日"));
    }
    let date = state.now().date().succ_opt().unwrap();
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM administrators WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO closing_configs(effective_date,open_time,close_time) VALUES(?,?,?) ON DUPLICATE KEY UPDATE open_time=VALUES(open_time),close_time=VALUES(close_time),created_at=UTC_TIMESTAMP(6)").bind(date).bind(&input.open_time).bind(&input.close_time).execute(&mut *tx).await?;
    audit(
        &mut tx,
        None,
        "closing_scheduled",
        json!({"date":date,"open_time":input.open_time,"close_time":input.close_time}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"effective_date":date})))
}
async fn update_mapping(
    State(state): State<AppState>,
    Json(input): Json<FutureMapping>,
) -> ApiResult<Json<Value>> {
    input.mapping.validate()?;
    if input.effective_date <= state.now().date() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "映射只能在未来业务日期生效".into(),
        ));
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM administrators WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO mapping_configs(effective_date,mapping) VALUES(?,?) ON DUPLICATE KEY UPDATE mapping=VALUES(mapping),created_at=UTC_TIMESTAMP(6)").bind(input.effective_date).bind(DbJson(&input.mapping)).execute(&mut *tx).await?;
    audit(
        &mut tx,
        None,
        "mapping_scheduled",
        json!({"date":input.effective_date,"mapping":input.mapping}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"effective_date":input.effective_date})))
}

async fn shutdown(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let supplied = headers
        .get("x-marksix-shutdown")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let allowed = state.shutdown_token.as_deref().is_some_and(|expected| {
        // Compare digests without prefix-dependent early returns.
        let a = digest(expected);
        let b = digest(supplied);
        a.bytes().zip(b.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
    });
    if !allowed {
        return Err(ApiError(StatusCode::FORBIDDEN, "停止请求未获授权".into()));
    }
    state.shutdown.notify_one();
    Ok(Json(json!({"ok":true})))
}
