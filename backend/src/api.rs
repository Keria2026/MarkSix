use crate::{domain::*, store::*};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::NaiveDate;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, types::Json as DbJson};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if e.as_database_error()
            .is_some_and(|d| d.is_unique_violation())
        {
            return Self(
                StatusCode::CONFLICT,
                "账号或记录已经存在，请刷新后检查，避免重复提交".into(),
            );
        }
        tracing::error!(code=?e.as_database_error().and_then(|d|d.code()),"database operation failed");
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
    let private = Router::new()
        .route("/session", get(session))
        .route("/logout", post(logout))
        .route("/bootstrap", get(bootstrap))
        .route("/periods", get(crate::queries::periods))
        .route("/periods/{id}", get(crate::queries::period))
        .route("/bets", post(crate::betting::single))
        .route("/slips", post(crate::betting::slip))
        .route("/slips/preview", post(crate::text_entry::preview))
        .route(
            "/text-entry/preferences",
            get(crate::text_entry::preferences),
        )
        .route(
            "/text-entry/preferences/{alias}",
            axum::routing::delete(crate::text_entry::forget),
        )
        .route(
            "/text-entry/bettor-preference",
            post(crate::text_entry::bettor_preference),
        )
        .route("/records/search", post(crate::records::search))
        .route("/slips/{id}", get(crate::records::detail))
        .route(
            "/slips/submission/{request_id}",
            get(crate::records::submission),
        )
        .route("/slips/{id}/cancel", post(crate::records::cancel))
        .route("/periods/{id}/bettor-export", get(crate::records::export))
        .route("/bets/search", post(crate::queries::search_bets))
        .route("/bets/{id}/amount", put(crate::ledger::change_amount))
        .route("/bets/{id}/layoffs", post(crate::ledger::fly_out))
        .route("/layoffs/{id}/cancel", post(crate::ledger::cancel_layoff))
        .route("/days", get(crate::reporting::days))
        .route("/days/{id}", get(crate::reporting::day))
        .route("/periods/{id}/statistics", get(crate::ledger::statistics))
        .route(
            "/periods/{id}/bet-filters",
            get(crate::queries::bet_filters),
        )
        .route("/parties", get(crate::ledger::parties))
        .route("/bets/{id}", get(bet_detail))
        .route("/bets/{id}/cancel", post(cancel_bet))
        .route("/plays", post(create_play))
        .route(
            "/plays/{id}",
            put(update_play).delete(crate::configuration::delete),
        )
        .route("/plays/export", get(crate::configuration::export))
        .route("/plays/import", post(crate::configuration::import))
        .route("/plays/batch", post(crate::configuration::batch))
        .route("/plays/order", put(crate::configuration::reorder))
        .route("/settings", get(settings))
        .route("/settings/features", put(crate::features::update))
        .route("/settings/entry-mode", put(crate::features::select_mode))
        .route("/settings/mapping", put(update_mapping))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Router::new()
        .nest(
            "/api",
            private
                .route("/login", post(login))
                .route("/health", get(health))
                .route("/site", get(|| async { Json(json!({"mode":"hosted"})) }))
                .fallback(|| async { (StatusCode::NOT_FOUND, "Unknown API endpoint") }),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn_with_state(state.clone(), receive_time))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
async fn receive_time(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    if req.extensions().get::<ReceivedAt>().is_none() {
        req.extensions_mut().insert(ReceivedAt(state.now()));
    }
    next.run(req).await
}
pub(crate) async fn security_headers(req: Request, next: Next) -> Response {
    let mut response = if !matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    ) && req.headers().get("x-marksix").and_then(|v| v.to_str().ok())
        != Some("1")
    {
        ApiError(
            StatusCode::FORBIDDEN,
            "请求校验失败，请从本系统页面操作".into(),
        )
        .into_response()
    } else {
        next.run(req).await
    };
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
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        ),
    ] {
        response.headers_mut().insert(name, value.parse().unwrap());
    }
    response
}
async fn authenticate(State(state): State<AppState>, req: Request, next: Next) -> Response {
    // Reuse central validation within this request, after checking tenant binding.
    // Standalone test servers retain their independent session implementation.
    if let (Some(policy), Some(validated)) = (
        &state.hosted,
        req.extensions().get::<crate::hosted::ValidatedCustomer>(),
    ) && policy.account_id == validated.0
    {
        return next.run(req).await;
    }
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
            if !matches!(req.uri().path(), "/session" | "/logout")
                && let Err(e) = crate::hosted::require(&state).await
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
    let today = ensure_period(&state, business_date(state.now())).await?;
    let hk: Option<Period> = sqlx::query_as(
        "SELECT * FROM periods WHERE market='hk' ORDER BY business_date DESC LIMIT 1",
    )
    .fetch_optional(&state.pool)
    .await?;
    let hk = match hk {
        Some(p) => Some(view(&state, p).await?),
        None => None,
    };
    let plays: Vec<Play> = sqlx::query_as(
        "SELECT id,version,rule,enabled FROM plays WHERE deleted_at IS NULL ORDER BY sort_order,id",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        json!({"day":crate::reporting::view(&state,&today.id).await?,"today":view(&state,today).await?,"hk":hk,"plays":plays,"zodiacs":ZODIACS,"features":crate::features::read(&state.pool).await?}),
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
    if !crate::market::accepts(&p, received) {
        return Err(conflict("本期已归档，不能撤销投注"));
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
    sqlx::query("UPDATE periods SET bet_version=bet_version+1 WHERE id=?")
        .bind(&period)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, Some(&period), "bet_cancelled", json!({"id":id})).await?;
    crate::worker::settle_recorded(&mut tx, &p).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
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
    let rows = sqlx::query(
        "SELECT effective_date,mapping FROM mapping_configs ORDER BY effective_date DESC LIMIT 50",
    )
    .fetch_all(&state.pool)
    .await?;
    let mappings:Vec<Value>=rows.into_iter().map(|r|Ok(json!({"effective_date":r.try_get::<NaiveDate,_>("effective_date")?,"mapping":r.try_get::<DbJson<Mapping>,_>("mapping")?}))).collect::<Result<_,sqlx::Error>>()?;
    Ok(Json(
        json!({"features":crate::features::read(&state.pool).await?,"cutover_time":"06:00","mappings":mappings,"tomorrow":business_date(state.now()).succ_opt()}),
    ))
}
async fn update_mapping(
    State(state): State<AppState>,
    Json(input): Json<FutureMapping>,
) -> ApiResult<Json<Value>> {
    input.mapping.validate()?;
    if input.effective_date <= business_date(state.now()) {
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

#[cfg(test)]
#[path = "../test_support/api.rs"]
mod security_tests;
