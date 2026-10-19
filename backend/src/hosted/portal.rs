use super::{accounts::*, tenancy::Registry};
use crate::api::{ApiError, ApiResult, digest};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{Days, TimeZone};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::{path::PathBuf, time::Duration};
use tower::ServiceExt;

pub async fn serve(pool: MySqlPool, address: &str) -> anyhow::Result<()> {
    let c = Control::new(
        pool,
        None,
        std::env::var("SECURE_COOKIE").is_ok_and(|s| s == "true"),
        PathBuf::new(),
    )
    .await?;
    let registry = Registry::new(c)?;
    let background = tokio::spawn(registry.clone().run());
    let result = axum::serve(
        tokio::net::TcpListener::bind(address).await?,
        router(registry),
    )
    .with_graceful_shutdown(crate::shutdown_signal())
    .await;
    background.abort();
    result?;
    Ok(())
}
pub(super) fn router(r: Registry) -> Router {
    Router::new()
        .route(
            "/api/site",
            get(|| async { Json(crate::build_info("hosted")) }),
        )
        .route("/api/health", get(health))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/session", get(session))
        .route("/api/license", get(status))
        .route("/api/license/activate", post(activate))
        .route("/api/history/clear", post(clear_history))
        .route("/api/account/password", post(change_password))
        .fallback(dispatch)
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn(crate::api::security_headers))
        .layer(middleware::from_fn_with_state(r.clone(), received_at))
        .with_state(r)
}
async fn received_at(State(r): State<Registry>, mut request: Request, next: Next) -> Response {
    request
        .extensions_mut()
        .insert(crate::api::ReceivedAt((r.clock)()));
    next.run(request).await
}
async fn health(State(r): State<Registry>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1").execute(&r.control.pool).await?;
    Ok(Json(
        json!({"status":"ok","version":env!("CARGO_PKG_VERSION"),"commit":option_env!("MARKSIX_REVISION").unwrap_or("development")}),
    ))
}
async fn login(State(r): State<Registry>, Json(input): Json<Login>) -> ApiResult<Response> {
    username(&input.username)?;
    let first = sqlx::query_as::<_, Account>(
        "SELECT * FROM hosted_accounts WHERE username=? AND disabled=FALSE AND state='ready'",
    )
    .bind(&input.username)
    .fetch_optional(&r.control.pool)
    .await?;
    r.control
        .verify(
            &input.username,
            input.password,
            first.as_ref().map(|a| a.password_hash.clone()),
        )
        .await?;
    let first = first.unwrap();
    let _permit = tokio::time::timeout(Duration::from_secs(10), r.work_gate.acquire())
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "服务器繁忙，请稍后重试".into(),
            )
        })?
        .map_err(anyhow::Error::from)?;
    let state = r.lease(&first).await?;
    let value = random_token();
    let hash = digest(&value);
    let mut tx = r.control.pool.begin().await?;
    let a = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=? FOR UPDATE")
        .bind(&first.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(unauthorized)?;
    if a.disabled
        || a.state != "ready"
        || a.password_hash != first.password_hash
        || a.credential_version != first.credential_version
    {
        return Err(unauthorized());
    }
    r.synchronize_admin(&a, &state).await?;
    // The central UNIQUE(account_id) is the authoritative single-session gate.
    sqlx::query("DELETE FROM hosted_sessions WHERE account_id=? OR expires_at<=UTC_TIMESTAMP(6)")
        .bind(&a.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO hosted_sessions(token_hash,account_id,credential_version,expires_at) VALUES(?,?,?,DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 24 HOUR))").bind(&hash).bind(&a.id).bind(a.credential_version).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sessions")
        .execute(&state.pool)
        .await?;
    sqlx::query("INSERT INTO sessions(token_hash,expires_at) VALUES(?,DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 24 HOUR))").bind(&hash).execute(&state.pool).await?;
    tx.commit().await?;
    Ok((
        [(
            header::SET_COOKIE,
            cookie(&r.control, "marksix_session", &value, 86400),
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn logout(State(r): State<Registry>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(value) = token(&headers, "marksix_session") {
        sqlx::query("DELETE FROM hosted_sessions WHERE token_hash=?")
            .bind(digest(&value))
            .execute(&r.control.pool)
            .await?;
    }
    Ok((
        [(
            header::SET_COOKIE,
            cookie(&r.control, "marksix_session", "", 0),
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn session(State(r): State<Registry>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let a = customer(&r.control, &headers).await?;
    Ok(Json(json!({"username":a.username})))
}
async fn clear_history(
    State(r): State<Registry>,
    headers: HeaderMap,
    Json(input): Json<super::history::ClearHistory>,
) -> ApiResult<Response> {
    customer(&r.control, &headers).await?;
    // Fixed internal destination. Customer input can never choose a server URL.
    let url =
        std::env::var("INTERNAL_AUTHORITY_URL").unwrap_or_else(|_| "http://authority:8090".into());
    // Internal customer credentials must never go through an outbound proxy.
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(anyhow::Error::from)?
        .post(format!(
            "{}/api/customer/history/clear",
            url.trim_end_matches('/')
        ))
        .header(
            header::COOKIE,
            headers.get(header::COOKIE).ok_or_else(unauthorized)?,
        )
        .header("X-MarkSix", "1")
        .json(&input)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(anyhow::Error::from)?;
    let status = response.status();
    let value: Value = response.json().await.map_err(anyhow::Error::from)?;
    Ok((status, Json(value)).into_response())
}
async fn change_password(
    State(r): State<Registry>,
    headers: HeaderMap,
    Json(input): Json<PasswordChange>,
) -> ApiResult<Response> {
    customer(&r.control, &headers).await?;
    let url =
        std::env::var("INTERNAL_AUTHORITY_URL").unwrap_or_else(|_| "http://authority:8090".into());
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(anyhow::Error::from)?
        .post(format!(
            "{}/api/customer/password",
            url.trim_end_matches('/')
        ))
        .header(
            header::COOKIE,
            headers.get(header::COOKIE).ok_or_else(unauthorized)?,
        )
        .header("X-MarkSix", "1")
        .json(&input)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(anyhow::Error::from)?;
    let status = response.status();
    let value: Value = response.json().await.map_err(anyhow::Error::from)?;
    let mut result = (status, Json(value)).into_response();
    if status.is_success() {
        result.headers_mut().insert(
            header::SET_COOKIE,
            cookie(&r.control, "marksix_session", "", 0)
                .parse()
                .map_err(anyhow::Error::from)?,
        );
    }
    Ok(result)
}
async fn status(State(r): State<Registry>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let a = customer(&r.control, &headers).await?;
    Ok(Json(license_status(&a)))
}
fn license_status(a: &Account) -> Value {
    let now = chrono::Utc::now().timestamp();
    let end = a
        .authorized_through
        .and_then(|d| d.checked_add_days(Days::new(1)))
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .and_then(|d| {
            chrono::FixedOffset::east_opt(8 * 3600)
                .unwrap()
                .from_local_datetime(&d)
                .single()
        })
        .map(|d| d.timestamp());
    json!({"hosted":true,"active":a.active(today()),"permanent":a.permanent,"authorized_through":a.authorized_through,"expires_at":end.map(|n|n-1),"server_time":now,"remaining_seconds":end.map(|n|(n-now).max(0)),"message":"请输入运营方为当前账号签发的激活码；授权截止日当期可用。"})
}
async fn activate(
    State(r): State<Registry>,
    headers: HeaderMap,
    Json(input): Json<Activate>,
) -> ApiResult<Json<Value>> {
    redeem(&r.control, &headers, input).await?;
    let a = customer(&r.control, &headers).await?;
    Ok(Json(license_status(&a)))
}
async fn dispatch(State(r): State<Registry>, mut request: Request) -> ApiResult<Response> {
    let path = request.uri().path();
    if !path.starts_with("/api/")
        || path.starts_with("/api/internal/")
        || path.starts_with("/api/license/")
    {
        return Err(crate::api::missing());
    }
    let a = customer(&r.control, request.headers()).await?;
    if !a.active(today()) {
        return Err(ApiError(
            StatusCode::PAYMENT_REQUIRED,
            "授权已到期，请使用新的激活码续期；之前已接受的投注继续结算".into(),
        ));
    }
    let _permit = tokio::time::timeout(Duration::from_secs(10), r.work_gate.acquire())
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "服务器繁忙，请稍后重试".into(),
            )
        })?
        .map_err(anyhow::Error::from)?;
    let state = r.lease(&a).await?;
    request
        .extensions_mut()
        .insert(super::ValidatedCustomer(a.id));
    Ok(state
        .router
        .clone()
        .oneshot(request)
        .await
        .unwrap_or_else(|never| match never {}))
}
