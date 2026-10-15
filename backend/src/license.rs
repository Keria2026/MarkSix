//! Ed25519 certificates: the application contains only a public trust anchor.
//! Activation codes are redeemed transactionally by an independently hosted authority.
use crate::{
    api::{ApiError, ApiResult, digest},
    store::AppState,
};
use anyhow::{Context, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::Utc;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row, types::Json as DbJson};
use std::{
    collections::VecDeque,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

mod clock;
mod routing;
use clock::{Lease, Runtime};
pub use routing::route_document;
#[derive(Clone)]
pub struct Client {
    pub device: String,
    pub key: VerifyingKey,
    runtime: Arc<Mutex<Runtime>>,
    monotonic: Arc<dyn Fn() -> anyhow::Result<Duration> + Send + Sync>,
    pub default_url: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Certificate {
    pub payload: String,
    pub signature: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    pub schema: u8,
    pub id: String,
    pub binding: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub checked_at: i64,
    pub nonce: String,
}
impl Certificate {
    fn verify(&self, key: &VerifyingKey, binding: &str) -> anyhow::Result<Claims> {
        ensure!(
            self.payload.len() <= 4096 && self.signature.len() == 128,
            "授权凭证格式错误"
        );
        let bytes = hex::decode(&self.payload)?;
        let signature = Signature::from_slice(&hex::decode(&self.signature)?)?;
        key.verify_strict(&bytes, &signature)
            .context("授权签名无效")?;
        let claims: Claims = serde_json::from_slice(&bytes)?;
        ensure!(
            claims.schema == 1 && claims.binding == binding && claims.expires_at > claims.issued_at,
            "授权绑定不符或凭证无效"
        );
        Ok(claims)
    }
}
fn sign(claims: &Claims, key: &SigningKey) -> anyhow::Result<Certificate> {
    let bytes = serde_json::to_vec(claims)?;
    Ok(Certificate {
        signature: hex::encode(key.sign(&bytes).to_bytes()),
        payload: hex::encode(bytes),
    })
}
fn random_hex() -> String {
    let mut bytes = [0; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn machine_id() -> anyhow::Result<String> {
    #[cfg(windows)]
    let source = {
        let output = std::process::Command::new("reg.exe")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()?;
        ensure!(output.status.success(), "无法读取 Windows 设备标识");
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .find(|s| s.contains("REG_SZ"))
            .and_then(|s| s.split_whitespace().last())
            .context("Windows MachineGuid 缺失")?
            .to_owned()
    };
    #[cfg(not(windows))]
    let source = std::fs::read_to_string("/run/marksix-machine-id")
        .or_else(|_| std::fs::read_to_string("/etc/machine-id"))
        .context("无法读取设备标识，请挂载 /etc/machine-id 到 /run/marksix-machine-id")?;
    ensure!(source.trim().len() >= 16, "设备标识为空或不完整");
    Ok(digest(&format!("marksix-device-v1:{}", source.trim())))
}
impl Client {
    pub fn production() -> anyhow::Result<Self> {
        let key: [u8; 32] = hex::decode(include_str!("../license-public-key.hex").trim())?
            .try_into()
            .map_err(|_| anyhow::anyhow!("授权公钥须为 32 字节"))?;
        Ok(Self {
            device: machine_id()?,
            key: VerifyingKey::from_bytes(&key)?,
            runtime: Arc::default(),
            monotonic: Arc::new(clock::boot_time),
            default_url: std::env::var("LICENSE_SERVER_URL")
                .ok()
                .filter(|s| !s.is_empty()),
        })
    }
}
async fn binding(state: &AppState, client: &Client) -> ApiResult<String> {
    let row = sqlx::query("SELECT username,password_hash FROM administrators WHERE id=1")
        .fetch_one(&state.pool)
        .await?;
    Ok(digest(&format!(
        "marksix-account-v1:{}:{}:{}",
        client.device,
        row.try_get::<String, _>("username")?,
        row.try_get::<String, _>("password_hash")?
    )))
}
fn authority_url(input: &str) -> anyhow::Result<String> {
    let url = reqwest::Url::parse(input.trim())?;
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "授权地址不能包含账号、查询参数或片段"
    );
    ensure!(
        url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))),
        "授权地址须使用 HTTPS；本机测试可使用 http://127.0.0.1"
    );
    ensure!(input.len() <= 500, "授权服务地址过长");
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
async fn call(url: &str, path: &str, body: Value) -> anyhow::Result<Certificate> {
    let url = authority_url(url)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?
        .post(format!("{url}/{path}"))
        .json(&body)
        .send()
        .await
        .context("无法连接授权服务")?;
    let status = response.status();
    let mut response = response;
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await? {
        ensure!(bytes.len() + chunk.len() <= 8192, "授权响应过大");
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v["error"].as_str().map(str::to_owned))
            .unwrap_or_else(|| format!("授权服务返回 {status}"));
        anyhow::bail!("{}", message.chars().take(200).collect::<String>());
    }
    Ok(serde_json::from_slice(&bytes)?)
}
fn activation_error(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::PAYMENT_REQUIRED, message.into())
}
async fn check(state: &AppState, force: bool) -> ApiResult<Claims> {
    let client = state
        .license
        .as_ref()
        .ok_or_else(|| activation_error("此测试实例未启用授权"))?;
    let mut runtime = client.runtime.lock().await;
    let binding = binding(state, client).await?;
    let row = sqlx::query("SELECT certificate,authority_url,last_seen_at,discovery_url FROM client_license WHERE id=1").fetch_one(&state.pool).await?;
    let certificate: Option<DbJson<Certificate>> = row.try_get("certificate")?;
    let certificate = certificate
        .ok_or_else(|| activation_error("请使用新授权码激活此设备"))?
        .0;
    let claims = certificate
        .verify(&client.key, &binding)
        .map_err(|_| activation_error("授权签名或设备、账号密码绑定不符，请重新激活"))?;
    let fingerprint = digest(&serde_json::to_string(&certificate).map_err(anyhow::Error::from)?);
    let now = (client.monotonic)().map_err(|e| activation_error(e.to_string()))?;
    if !force
        && let Some(lease) = &runtime.lease
        && lease.fingerprint == fingerprint
        && lease.binding == binding
    {
        match lease.remaining(now) {
            Ok(0) => return Err(activation_error("授权已到期，请使用新的授权码续期")),
            Ok(_) if lease.fresh(now) => return Ok(claims),
            _ => {}
        }
    }
    // Dropping the cached lease before any network attempt makes failures closed.
    // A process restart always has no lease, even if a certificate is on disk.
    runtime.lease = None;
    if !force
        && let Some((when, message)) = &runtime.failure
        && now
            .checked_sub(*when)
            .is_some_and(|elapsed| elapsed < Duration::from_secs(10))
    {
        return Err(activation_error(message.clone()));
    }
    let url: Option<String> = row.try_get("authority_url")?;
    let url = url
        .or_else(|| client.default_url.clone())
        .ok_or_else(|| activation_error("请设置授权服务地址"))?;
    let resolution =
        routing::resolve(state, client, &url, row.try_get("discovery_url")?, None).await?;
    let nonce = random_hex();
    let fresh = call(
        &resolution.url,
        "refresh",
        json!({"certificate":certificate,"binding":binding,"nonce":nonce}),
    )
    .await;
    let fresh = match fresh {
        Ok(value) => value,
        Err(e) => {
            let message = format!("授权校验失败：{e}");
            runtime.failure = Some(((client.monotonic)().unwrap_or(now), message.clone()));
            return Err(activation_error(message));
        }
    };
    let updated = fresh
        .verify(&client.key, &binding)
        .map_err(|_| activation_error("授权服务签名无效"))?;
    if updated.nonce != nonce
        || updated.id != claims.id
        || updated.issued_at != claims.issued_at
        || updated.expires_at != claims.expires_at
        || updated.checked_at < claims.checked_at
        || updated.checked_at >= updated.expires_at
        || updated.checked_at < updated.issued_at
    {
        return Err(activation_error("授权响应无效或授权服务器时间回退"));
    }
    let lease = Lease {
        fingerprint: digest(&serde_json::to_string(&fresh).map_err(anyhow::Error::from)?),
        binding,
        started: now,
        server_time: updated.checked_at,
        expires_at: updated.expires_at,
    };
    if !lease.fresh((client.monotonic)().map_err(|e| activation_error(e.to_string()))?)
        || lease
            .remaining((client.monotonic)().map_err(|e| activation_error(e.to_string()))?)
            .unwrap_or(0)
            == 0
    {
        return Err(activation_error("授权响应已失效，请重新联网核验"));
    }
    sqlx::query("UPDATE client_license SET certificate=?,last_seen_at=GREATEST(last_seen_at,?),authority_url=?,discovery_url=?,route_revision=?,route_certificate=? WHERE id=1").bind(DbJson(&fresh)).bind(updated.checked_at).bind(&resolution.url).bind(&resolution.discovery).bind(resolution.revision).bind(resolution.certificate.as_ref().map(DbJson)).execute(&state.pool).await?;
    runtime.failure = None;
    runtime.lease = Some(lease);
    Ok(updated)
}
pub async fn require(state: &AppState) -> ApiResult<()> {
    if state.license.is_some() {
        check(state, false).await?;
    }
    Ok(())
}
pub async fn status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let Some(client) = &state.license else {
        return Ok(Json(json!({"active":true,"testing":true})));
    };
    let row = sqlx::query("SELECT authority_url FROM client_license WHERE id=1")
        .fetch_one(&state.pool)
        .await?;
    let url: Option<String> = row.try_get("authority_url")?;
    let binding = binding(&state, client).await?;
    let base = json!({"device":client.device,"binding":binding,"server_url":url.or_else(||client.default_url.clone()).unwrap_or_default()});
    let mut value = base;
    match check(&state, false).await {
        Ok(claims) => {
            value["active"] = json!(true);
            value["expires_at"] = json!(claims.expires_at);
            let runtime = client.runtime.lock().await;
            let remaining = runtime
                .lease
                .as_ref()
                .and_then(|lease| lease.remaining((client.monotonic)().ok()?).ok())
                .unwrap_or(0);
            if remaining == 0 {
                value["active"] = json!(false);
                value["message"] = json!("授权已到期或需重新联网核验");
            }
            value["remaining_seconds"] = json!(remaining);
            value["server_time"] = json!(claims.expires_at.saturating_sub(remaining as i64));
            value["license_id"] = json!(claims.id);
        }
        Err(e) if e.0 == StatusCode::PAYMENT_REQUIRED => {
            value["active"] = json!(false);
            value["message"] = json!(e.1);
        }
        Err(e) => return Err(e),
    }
    Ok(Json(value))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Activate {
    code: String,
    #[serde(default)]
    server_url: String,
    #[serde(default = "activation_request_id")]
    request_id: String,
    #[serde(default)]
    migration: Option<Certificate>,
}
fn activation_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub async fn activate(
    State(state): State<AppState>,
    Json(input): Json<Activate>,
) -> ApiResult<Json<Value>> {
    let client = state
        .license
        .as_ref()
        .ok_or_else(|| activation_error("测试实例不支持激活"))?;
    let mut runtime = client.runtime.lock().await;
    uuid::Uuid::parse_str(&input.request_id).map_err(|_| activation_error("激活提交标识无效"))?;
    let text = input.code.trim();
    let (code, initial_url, discovery) = if text.starts_with("MSX1.") {
        let code = routing::decode_code(text, &client.key)
            .map_err(|_| activation_error("激活码签名或内容无效"))?;
        (code.token, code.authority_url, code.discovery_url)
    } else {
        let token = text.replace('-', "").to_ascii_lowercase();
        if token.len() != 48 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(activation_error("激活码格式不正确"));
        }
        (token, input.server_url.clone(), None)
    };
    let resolution =
        routing::resolve(&state, client, &initial_url, discovery, input.migration).await?;
    let binding = binding(&state, client).await?;
    let started = (client.monotonic)().map_err(|e| activation_error(e.to_string()))?;
    let nonce = random_hex();
    let certificate = call(
        &resolution.url,
        "redeem",
        json!({"code":code,"binding":binding,"nonce":nonce,"request_id":input.request_id}),
    )
    .await
    .map_err(|e| activation_error(e.to_string()))?;
    let claims = certificate
        .verify(&client.key, &binding)
        .map_err(|_| activation_error("授权服务签名与本安装包不匹配"))?;
    let lease = Lease {
        fingerprint: digest(&serde_json::to_string(&certificate).map_err(anyhow::Error::from)?),
        binding,
        started,
        server_time: claims.checked_at,
        expires_at: claims.expires_at,
    };
    let now = (client.monotonic)().map_err(|e| activation_error(e.to_string()))?;
    if claims.nonce != nonce
        || claims.checked_at < claims.issued_at
        || !lease.fresh(now)
        || lease.remaining(now).unwrap_or(0) == 0
    {
        return Err(activation_error("授权响应无效或已过期"));
    }
    sqlx::query(
        "UPDATE client_license SET certificate=?,authority_url=?,last_seen_at=?,discovery_url=?,route_revision=?,route_certificate=? WHERE id=1",
    )
    .bind(DbJson(certificate))
    .bind(&resolution.url)
    .bind(claims.checked_at)
    .bind(&resolution.discovery)
    .bind(resolution.revision)
    .bind(resolution.certificate.as_ref().map(DbJson))
    .execute(&state.pool)
    .await?;
    runtime.failure = None;
    runtime.lease = Some(lease);
    Ok(Json(json!({"active":true,"expires_at":claims.expires_at})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Migration {
    migration: Certificate,
}
pub async fn migrate(
    State(state): State<AppState>,
    Json(input): Json<Migration>,
) -> ApiResult<Json<Value>> {
    let client = state
        .license
        .as_ref()
        .ok_or_else(|| activation_error("测试实例不支持迁移"))?;
    {
        let mut runtime = client.runtime.lock().await;
        let supplied = routing::decode_route(&input.migration, &client.key)
            .map_err(|_| activation_error("迁移文件签名无效"))?;
        let row = sqlx::query("SELECT authority_url,discovery_url FROM client_license WHERE id=1")
            .fetch_one(&state.pool)
            .await?;
        let url: Option<String> = row.try_get("authority_url")?;
        let resolution = routing::resolve(
            &state,
            client,
            url.as_deref().unwrap_or(&supplied.authority_url),
            row.try_get("discovery_url")?,
            Some(input.migration),
        )
        .await?;
        sqlx::query("UPDATE client_license SET authority_url=?,discovery_url=?,route_revision=?,route_certificate=? WHERE id=1").bind(&resolution.url).bind(&resolution.discovery).bind(resolution.revision).bind(resolution.certificate.as_ref().map(DbJson)).execute(&state.pool).await?;
        runtime.lease = None;
        runtime.failure = None;
    }
    // Changing an address never redeems a code or extends an existing license.
    let _ = check(&state, true).await;
    status(State(state)).await
}

#[derive(Clone)]
struct Authority {
    pool: MySqlPool,
    key: Arc<SigningKey>,
    attempts: Arc<Mutex<VecDeque<Instant>>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Redeem {
    code: String,
    binding: String,
    nonce: String,
    #[serde(default = "activation_request_id")]
    request_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Refresh {
    certificate: Certificate,
    binding: String,
    nonce: String,
}
async fn rate_limit(state: &Authority) -> ApiResult<()> {
    let mut attempts = state.attempts.lock().await;
    while attempts
        .front()
        .is_some_and(|t| t.elapsed() > Duration::from_secs(60))
    {
        attempts.pop_front();
    }
    if attempts.len() >= 600 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "请求频繁，请稍后重试".into(),
        ));
    }
    attempts.push_back(Instant::now());
    Ok(())
}
async fn redeem(
    State(state): State<Authority>,
    Json(input): Json<Redeem>,
) -> ApiResult<Json<Certificate>> {
    rate_limit(&state).await?;
    if uuid::Uuid::parse_str(&input.request_id).is_err()
        || !hex64(&input.binding)
        || input.code.len() != 48
        || !input.code.bytes().all(|b| b.is_ascii_hexdigit())
        || input.nonce.len() != 48
    {
        return Err(activation_error("授权请求格式错误"));
    }
    let id = digest(&input.code);
    let mut tx = state.pool.begin().await?;
    let row=sqlx::query("SELECT valid_days,redeem_before,redeemed_at,binding,certificate,redemption_id,intended_binding,expires_at FROM license_codes WHERE code_hash=? FOR UPDATE").bind(&id).fetch_optional(&mut *tx).await?.ok_or_else(||activation_error("授权码无效"))?;
    let now = Utc::now().timestamp();
    // Retry from the same binding is idempotent, allowing recovery after a lost response.
    // A redeemed code can never create a second license, extend time or change its binding.
    let claims = if row.try_get::<Option<i64>, _>("redeemed_at")?.is_some() {
        if row.try_get::<Option<String>, _>("binding")?.as_deref() != Some(&input.binding)
            || row
                .try_get::<Option<String>, _>("redemption_id")?
                .as_deref()
                != Some(&input.request_id)
        {
            return Err(activation_error("授权码已使用，请使用新的激活码"));
        }
        let cert: DbJson<Certificate> = row.try_get("certificate")?;
        let mut claims = cert.verify(&state.key.verifying_key(), &input.binding)?;
        if claims.expires_at <= now {
            return Err(activation_error("此授权码已使用且授权已到期，请使用新码"));
        }
        claims.checked_at = now;
        claims.nonce = input.nonce;
        claims
    } else {
        if row.try_get::<i64, _>("redeem_before")? <= now {
            return Err(activation_error("授权码已超过激活期限"));
        }
        if row
            .try_get::<Option<String>, _>("intended_binding")?
            .is_some_and(|b| b != input.binding)
        {
            return Err(activation_error("激活码与预绑定设备、账号密码不符"));
        }
        let expiry = row
            .try_get::<Option<i64>, _>("expires_at")?
            .unwrap_or(now + i64::from(row.try_get::<i32, _>("valid_days")?) * 86400);
        if expiry <= now {
            return Err(activation_error("激活码指定的到期时间已过"));
        }
        Claims {
            schema: 1,
            id: id.clone(),
            binding: input.binding.clone(),
            issued_at: now,
            expires_at: expiry,
            checked_at: now,
            nonce: input.nonce,
        }
    };
    let certificate = sign(&claims, &state.key)?;
    sqlx::query("UPDATE license_codes SET redeemed_at=COALESCE(redeemed_at,?),binding=?,certificate=?,redemption_id=? WHERE code_hash=?").bind(now).bind(&input.binding).bind(DbJson(&certificate)).bind(&input.request_id).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(certificate))
}
async fn refresh(
    State(state): State<Authority>,
    Json(input): Json<Refresh>,
) -> ApiResult<Json<Certificate>> {
    rate_limit(&state).await?;
    if input.nonce.len() != 48 || !hex64(&input.binding) {
        return Err(activation_error("授权请求格式错误"));
    }
    let mut claims = input
        .certificate
        .verify(&state.key.verifying_key(), &input.binding)
        .map_err(|_| activation_error("授权凭证无效"))?;
    let row=sqlx::query("SELECT binding,certificate FROM license_codes WHERE code_hash=? AND redeemed_at IS NOT NULL").bind(&claims.id).fetch_optional(&state.pool).await?.ok_or_else(||activation_error("授权记录不存在或已撤销"))?;
    let stored: DbJson<Certificate> = row.try_get("certificate")?;
    let original = stored
        .verify(&state.key.verifying_key(), &input.binding)
        .map_err(|_| activation_error("授权绑定不符"))?;
    if row.try_get::<Option<String>, _>("binding")?.as_deref() != Some(&input.binding)
        || original.expires_at != claims.expires_at
        || original.issued_at != claims.issued_at
        || claims.expires_at <= Utc::now().timestamp()
    {
        return Err(activation_error("授权已到期或已撤销"));
    }
    claims.checked_at = Utc::now().timestamp();
    claims.nonce = input.nonce;
    Ok(Json(sign(&claims, &state.key)?))
}
pub fn public_key() -> anyhow::Result<String> {
    Ok(hex::encode(load_key()?.verifying_key().to_bytes()))
}
fn load_key() -> anyhow::Result<SigningKey> {
    let path = std::env::var("LICENSE_SIGNING_KEY_FILE")
        .context("请设置 LICENSE_SIGNING_KEY_FILE，私钥不可放入客户端包")?;
    let secret: [u8; 32] = hex::decode(std::fs::read_to_string(path)?.trim())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("签名私钥须为 32 字节"))?;
    Ok(SigningKey::from_bytes(&secret))
}
pub async fn authority(pool: MySqlPool, address: &str) -> anyhow::Result<()> {
    let state = Authority {
        pool,
        key: Arc::new(load_key()?),
        attempts: Arc::default(),
    };
    let app = Router::new()
        .route("/redeem", post(redeem))
        .route("/refresh", post(refresh))
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .layer(DefaultBodyLimit::max(8192))
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                let mut response = next.run(request).await;
                response
                    .headers_mut()
                    .insert("cache-control", "no-store".parse().unwrap());
                response
            },
        ))
        .with_state(state);
    axum::serve(tokio::net::TcpListener::bind(address).await?, app)
        .with_graceful_shutdown(crate::shutdown_signal())
        .await?;
    Ok(())
}
pub async fn issue(pool: &MySqlPool, days: i32) -> anyhow::Result<String> {
    ensure!((1..=3650).contains(&days), "授权期限须为 1–3650 天");
    let code = random_hex();
    sqlx::query("INSERT INTO license_codes(code_hash,valid_days,redeem_before) VALUES(?,?,?)")
        .bind(digest(&code))
        .bind(days)
        .bind(Utc::now().timestamp() + 30 * 86400)
        .execute(pool)
        .await?;
    Ok(code)
}
pub async fn issue_activation(
    pool: &MySqlPool,
    days: i32,
    expires_at: Option<i64>,
    intended_binding: Option<&str>,
) -> anyhow::Result<String> {
    let url = std::env::var("PUBLIC_AUTHORITY_URL")
        .context("请设置 PUBLIC_AUTHORITY_URL（客户可访问的 HTTPS 地址）")?;
    let discovery = std::env::var("LICENSE_DISCOVERY_URL")
        .ok()
        .filter(|s| !s.is_empty());
    let key = load_key()?;
    let token = random_hex();
    let encoded = routing::encode_code(&token, &url, discovery.as_deref(), &key)?;
    ensure!((1..=3650).contains(&days), "授权期限须为 1–3650 天");
    if let Some(expiry) = expires_at {
        ensure!(
            expiry > Utc::now().timestamp() && expiry <= Utc::now().timestamp() + 3650 * 86400,
            "指定到期时间须在未来 3650 天内"
        );
    }
    if let Some(binding) = intended_binding {
        ensure!(hex64(binding), "预绑定标识须为 64 位十六进制");
    }
    let intended_binding = intended_binding.map(str::to_ascii_lowercase);
    sqlx::query("INSERT INTO license_codes(code_hash,valid_days,redeem_before,intended_binding,expires_at) VALUES(?,?,?,?,?)").bind(digest(&token)).bind(days).bind(Utc::now().timestamp() + 30 * 86400).bind(intended_binding.as_deref()).bind(expires_at).execute(pool).await?;
    Ok(encoded)
}
pub fn keygen(path: &Path) -> anyhow::Result<()> {
    use std::io::Write;
    let key = SigningKey::generate(&mut rand::rngs::OsRng);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(hex::encode(key.to_bytes()).as_bytes())?;
    println!(
        "Public key: {}",
        hex::encode(key.verifying_key().to_bytes())
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_certificate_binds_device_account_and_detects_tampering() {
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        let claims = Claims {
            schema: 1,
            id: "id".into(),
            binding: digest("device+username+password-hash"),
            issued_at: 1,
            expires_at: 100,
            checked_at: 2,
            nonce: "nonce".into(),
        };
        let mut cert = sign(&claims, &key).unwrap();
        assert!(cert.verify(&key.verifying_key(), &claims.binding).is_ok());
        assert!(
            cert.verify(&key.verifying_key(), &digest("another device or password"))
                .is_err()
        );
        assert!(
            cert.verify(
                &SigningKey::generate(&mut rand::rngs::OsRng).verifying_key(),
                &claims.binding
            )
            .is_err()
        );
        cert.payload.push_str("00");
        assert!(cert.verify(&key.verifying_key(), &claims.binding).is_err());
    }
    #[test]
    fn authority_urls_require_tls_except_local_testing() {
        for url in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/?token=secret",
        ] {
            assert!(authority_url(url).is_err());
        }
        for url in ["https://license.example.com/api", "http://127.0.0.1:8090"] {
            assert!(authority_url(url).is_ok());
        }
    }
    #[tokio::test]
    #[ignore = "requires disposable TEST_DATABASE_URL ending in /marksix_test; run after workflow"]
    async fn online_activation_is_atomic_bound_expiring_and_restorable() {
        let url = std::env::var("TEST_DATABASE_URL").unwrap();
        assert!(url.ends_with("/marksix_test"));
        let pool = crate::store::connect(&url).await.unwrap();
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        let authority = Authority {
            pool: pool.clone(),
            key: Arc::new(key.clone()),
            attempts: Arc::default(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/redeem", post(redeem))
            .route("/refresh", post(refresh))
            .with_state(authority.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        sqlx::query("UPDATE client_license SET certificate=NULL,authority_url=NULL,last_seen_at=0,discovery_url=NULL,route_revision=0,route_certificate=NULL WHERE id=1").execute(&pool).await.unwrap();
        let mut state = AppState::new(pool.clone()).unwrap();
        use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
        let uptime = Arc::new(AtomicU64::new(1_000));
        let read_uptime = uptime.clone();
        state.license = Some(Client {
            device: digest("device-one"),
            key: key.verifying_key(),
            runtime: Arc::default(),
            monotonic: Arc::new(move || {
                Ok(Duration::from_secs(
                    read_uptime.load(AtomicOrdering::SeqCst),
                ))
            }),
            default_url: None,
        });
        assert!(require(&state).await.is_err());
        // Exercise the real nested router: Axum strips /api before route middleware.
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let session = random_hex();
        let session = format!("{session}{}", &random_hex()[..16]);
        sqlx::query("INSERT INTO sessions(token_hash,expires_at) VALUES(?,DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 HOUR))").bind(digest(&session)).execute(&pool).await.unwrap();
        let router = crate::api::router(state.clone());
        let cookie = format!("marksix_session={session}");
        for (path, expected) in [
            ("/api/license", StatusCode::OK),
            ("/api/session", StatusCode::OK),
            ("/api/bootstrap", StatusCode::PAYMENT_REQUIRED),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("cookie", &cookie)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "{path}");
        }
        let code = issue(&pool, 1).await.unwrap();
        let binding = binding(&state, state.license.as_ref().unwrap())
            .await
            .unwrap();
        // Two concurrent uses by different devices: exactly one may claim the code.
        let first = call(
            &address,
            "redeem",
            json!({"code":code,"binding":binding,"nonce":random_hex(),"request_id":activation_request_id()}),
        );
        let second = call(
            &address,
            "redeem",
            json!({"code":code,"binding":digest("device-two"),"nonce":random_hex()}),
        );
        let (a, b) = tokio::join!(first, second);
        assert_ne!(a.is_ok(), b.is_ok());
        // Use another fresh code to activate the real client irrespective of race winner.
        let code = issue(&pool, 1).await.unwrap();
        let activation_id = activation_request_id();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/license/activate")
                    .header("cookie", &cookie)
                    .header("x-marksix", "1")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"code":code,"server_url":address,"request_id":activation_id})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "Activation must remain reachable before activation"
        );
        let before = check(&state, true).await.unwrap();
        let _ = status(State(state.clone())).await.unwrap();
        // Altering persisted timestamps or the business wall clock cannot extend
        // a lease; expiry and refresh depend exclusively on signed time + uptime.
        sqlx::query("UPDATE client_license SET last_seen_at=0 WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        state.clock = Arc::new(|| {
            chrono::NaiveDate::from_ymd_opt(2000, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
        });
        uptime.fetch_add(15, AtomicOrdering::SeqCst);
        let view = status(State(state.clone())).await.unwrap().0;
        assert_eq!(
            view["remaining_seconds"],
            before.expires_at - before.checked_at - 15
        );
        assert!(view["server_time"].as_i64().unwrap() >= before.checked_at + 15);
        // A fresh operation with the same code is rejected even on the same device.
        assert!(
            activate(
                State(state.clone()),
                Json(Activate {
                    code: code.clone(),
                    server_url: address.clone(),
                    request_id: activation_request_id(),
                    migration: None
                })
            )
            .await
            .is_err()
        );

        // A retry recovers the same license without extending its expiry.
        let _ = activate(
            State(state.clone()),
            Json(Activate {
                code,
                server_url: address.clone(),
                request_id: activation_id.clone(),
                migration: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            check(&state, false).await.unwrap().expires_at,
            before.expires_at
        );
        let mut moved = state.clone();
        moved.license.as_mut().unwrap().device = digest("different device");
        assert!(require(&moved).await.is_err());
        let hash: String =
            sqlx::query_scalar("SELECT password_hash FROM administrators WHERE id=1")
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query("UPDATE administrators SET password_hash='changed' WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        assert!(require(&state).await.is_err());
        sqlx::query("UPDATE administrators SET password_hash=? WHERE id=1")
            .bind(hash)
            .execute(&pool)
            .await
            .unwrap();
        assert!(require(&state).await.is_ok());
        // A correctly signed but expired certificate must be rejected.
        let mut expired = before.clone();
        expired.expires_at = Utc::now().timestamp() - 1;
        expired.issued_at = expired.expires_at - 86400;
        sqlx::query("UPDATE client_license SET certificate=? WHERE id=1")
            .bind(DbJson(sign(&expired, &key).unwrap()))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE license_codes SET certificate=? WHERE code_hash=?")
            .bind(DbJson(sign(&expired, &key).unwrap()))
            .bind(&expired.id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(require(&state).await.is_err());
        let new_code = issue(&pool, 2).await.unwrap();
        let _ = activate(
            State(state.clone()),
            Json(Activate {
                code: new_code,
                server_url: address.clone(),
                request_id: activation_request_id(),
                migration: None,
            }),
        )
        .await
        .unwrap();
        let active = check(&state, false).await.unwrap();
        assert!(active.expires_at > before.expires_at);
        // Revocation is checked online, and no stale certificate bypasses it.
        sqlx::query("DELETE FROM license_codes WHERE code_hash=?")
            .bind(active.id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(check(&state, true).await.is_err());
        // Route migration: an old, unused signed code discovers the new server;
        // the original address is actually stopped, and the same DB/key are retained.
        use std::sync::RwLock;
        let target_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}", target_listener.local_addr().unwrap());
        let target_app = Router::new()
            .route("/redeem", post(redeem))
            .route("/refresh", post(refresh))
            .with_state(authority.clone());
        let target_server =
            tokio::spawn(async move { axum::serve(target_listener, target_app).await.unwrap() });
        let discovery_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let discovery_url = format!("http://{}", discovery_listener.local_addr().unwrap());
        let document = Arc::new(RwLock::new(
            routing::signed_route(&key, &address, Some(&discovery_url), 1).unwrap(),
        ));
        let document_reader = document.clone();
        let discovery_app = Router::new().route(
            "/",
            get(move || {
                let value = document_reader.read().unwrap().clone();
                async move { Json(value) }
            }),
        );
        let discovery_server = tokio::spawn(async move {
            axum::serve(discovery_listener, discovery_app)
                .await
                .unwrap()
        });
        let token = issue(&pool, 1).await.unwrap();
        let encoded = routing::encode_code(&token, &address, Some(&discovery_url), &key).unwrap();
        *document.write().unwrap() =
            routing::signed_route(&key, &target, Some(&discovery_url), 2).unwrap();
        server.abort();
        let activation = Activate {
            code: encoded.clone(),
            server_url: String::new(),
            request_id: activation_request_id(),
            migration: None,
        };
        let response = activate(State(state.clone()), Json(activation))
            .await
            .unwrap()
            .0;
        assert_eq!(response["active"], true);
        let stored_url: String =
            sqlx::query_scalar("SELECT authority_url FROM client_license WHERE id=1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored_url, target);
        let live = check(&state, false).await.unwrap();
        let now_uptime = uptime.load(AtomicOrdering::SeqCst);
        uptime.fetch_add(
            (live.expires_at - live.checked_at + 1) as u64,
            AtomicOrdering::SeqCst,
        );
        assert!(
            require(&state).await.is_err(),
            "monotonic expiry must not depend on wall time"
        );
        // Simulate a clock discontinuity: only a new authority response may
        // re-establish time; the cached lease is never trusted after rollback.
        uptime.store(now_uptime.saturating_sub(1), AtomicOrdering::SeqCst);
        assert!(require(&state).await.is_ok());
        // A copied installation with a different device cannot use this certificate.
        let mut copy = state.clone();
        copy.license.as_mut().unwrap().device = digest("copied machine");
        assert!(require(&copy).await.is_err());
        // Simulated suspend of more than 60 seconds forces a fresh signed response.
        uptime.fetch_add(61, AtomicOrdering::SeqCst);
        assert!(require(&state).await.is_ok());
        // Process restart cannot reuse a persisted lease while offline.
        let mut restarted = state.clone();
        restarted.license.as_mut().unwrap().runtime = Arc::default();
        target_server.abort();
        discovery_server.abort();
        assert!(require(&restarted).await.is_err());
        // Existing process is limited to its current 60-second lease offline.
        assert!(require(&state).await.is_ok());
        uptime.fetch_add(61, AtomicOrdering::SeqCst);
        assert!(require(&state).await.is_err());
        // Restoring a DB backup does not restore the in-memory monotonic lease.
        assert!(require(&restarted).await.is_err());
        assert!(live.expires_at > live.checked_at);
        // With both old addresses gone, a signed migration file repairs an
        // existing installation without reactivating or extending its license.
        let third_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let third = format!("http://{}", third_listener.local_addr().unwrap());
        let third_app = Router::new()
            .route("/redeem", post(redeem))
            .route("/refresh", post(refresh))
            .with_state(authority.clone());
        let third_server =
            tokio::spawn(async move { axum::serve(third_listener, third_app).await.unwrap() });
        let route = routing::signed_route(&key, &third, None, 3).unwrap();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/license/migrate")
                    .header("cookie", &cookie)
                    .header("x-marksix", "1")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"migration":route}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let repaired = check(&state, false).await.unwrap();
        assert_eq!(repaired.expires_at, live.expires_at);
        assert_eq!(repaired.id, live.id);
        assert!(
            migrate(
                State(state.clone()),
                Json(Migration {
                    migration: routing::signed_route(&key, &third, None, 2).unwrap()
                })
            )
            .await
            .is_err()
        );
        let wrong_key = SigningKey::generate(&mut rand::rngs::OsRng);
        assert!(
            migrate(
                State(state.clone()),
                Json(Migration {
                    migration: routing::signed_route(&wrong_key, &third, None, 4).unwrap()
                })
            )
            .await
            .is_err()
        );
        // Unused codes issued before migration still work through the saved
        // signed route; the new code can be pre-bound before it reaches a client.
        let token = issue(&pool, 1).await.unwrap();
        let encoded = routing::encode_code(&token, &address, Some(&discovery_url), &key).unwrap();
        sqlx::query("UPDATE license_codes SET intended_binding=? WHERE code_hash=?")
            .bind(&binding)
            .bind(digest(&token))
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            activate(
                State(copy),
                Json(Activate {
                    code: encoded.clone(),
                    server_url: String::new(),
                    request_id: activation_request_id(),
                    migration: None
                })
            )
            .await
            .is_err()
        );
        let _ = activate(
            State(state.clone()),
            Json(Activate {
                code: encoded,
                server_url: String::new(),
                request_id: activation_request_id(),
                migration: None,
            }),
        )
        .await
        .unwrap();
        third_server.abort();

        sqlx::query("UPDATE client_license SET certificate=NULL,authority_url=NULL,last_seen_at=0,discovery_url=NULL,route_revision=0,route_certificate=NULL WHERE id=1").execute(&pool).await.unwrap();
        server.abort();
        pool.close().await;
    }
}
