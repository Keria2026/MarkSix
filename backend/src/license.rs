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

const REFRESH_SECONDS: i64 = 60;
#[derive(Clone)]
pub struct Client {
    pub device: String,
    pub key: VerifyingKey,
    pub gate: Arc<Mutex<Option<(Instant, String)>>>,
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
            gate: Arc::default(),
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
    let Some(client) = &state.license else {
        return Err(activation_error("此测试实例未启用授权"));
    };
    let mut guard = client.gate.lock().await;
    let binding = binding(state, client).await?;
    let row =
        sqlx::query("SELECT certificate,authority_url,last_seen_at FROM client_license WHERE id=1")
            .fetch_one(&state.pool)
            .await?;
    let certificate: Option<DbJson<Certificate>> = row.try_get("certificate")?;
    let certificate = certificate
        .ok_or_else(|| activation_error("请使用授权码激活此设备"))?
        .0;
    let mut claims = certificate
        .verify(&client.key, &binding)
        .map_err(|_| activation_error("授权签名或设备、账号密码绑定不符，请重新激活"))?;
    let now = Utc::now().timestamp();
    if claims.expires_at <= now {
        return Err(activation_error("授权已到期，请使用新的授权码续期"));
    }
    let rollback = now + 120 < row.try_get::<i64, _>("last_seen_at")?;
    if force
        || rollback
        || claims.checked_at > now + 120
        || now - claims.checked_at >= REFRESH_SECONDS
    {
        let url: Option<String> = row.try_get("authority_url")?;
        let url = url
            .or_else(|| client.default_url.clone())
            .ok_or_else(|| activation_error("请设置授权服务地址"))?;
        if !force
            && let Some((when, message)) = &*guard
            && when.elapsed() < Duration::from_secs(10)
        {
            return Err(activation_error(message.clone()));
        }
        let nonce = random_hex();
        let fresh = call(
            &url,
            "refresh",
            json!({"certificate":certificate,"binding":binding,"nonce":nonce}),
        )
        .await;
        let fresh = match fresh {
            Ok(value) => {
                *guard = None;
                value
            }
            Err(e) => {
                let message = format!("授权校验失败：{e}");
                *guard = Some((Instant::now(), message.clone()));
                return Err(activation_error(message));
            }
        };
        claims = fresh
            .verify(&client.key, &binding)
            .map_err(|_| activation_error("授权服务签名无效"))?;
        if claims.nonce != nonce
            || claims.expires_at <= now
            || (claims.checked_at - now).abs() > 120
        {
            return Err(activation_error("授权响应已失效或系统时间有误，请校准时间"));
        }
        sqlx::query("UPDATE client_license SET certificate=?,last_seen_at=GREATEST(last_seen_at,?) WHERE id=1").bind(DbJson(&fresh)).bind(now).execute(&state.pool).await?;
    }
    Ok(claims)
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
    server_url: String,
}
pub async fn activate(
    State(state): State<AppState>,
    Json(input): Json<Activate>,
) -> ApiResult<Json<Value>> {
    let client = state
        .license
        .as_ref()
        .ok_or_else(|| activation_error("测试实例不支持激活"))?;
    let mut guard = client.gate.lock().await;
    let url = authority_url(&input.server_url)
        .map_err(|e| ApiError(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;
    let code = input.code.trim().replace('-', "").to_ascii_lowercase();
    if code.len() != 48 || !code.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "授权码格式不正确".into(),
        ));
    }
    let binding = binding(&state, client).await?;
    let nonce = random_hex();
    let certificate = call(
        &url,
        "redeem",
        json!({"code":code,"binding":binding,"nonce":nonce}),
    )
    .await
    .map_err(|e| activation_error(e.to_string()))?;
    let claims = certificate
        .verify(&client.key, &binding)
        .map_err(|_| activation_error("授权服务签名与本安装包不匹配"))?;
    let now = Utc::now().timestamp();
    if claims.nonce != nonce || claims.expires_at <= now || (claims.checked_at - now).abs() > 120 {
        return Err(activation_error("授权响应无效，请校准时间后重试"));
    }
    sqlx::query(
        "UPDATE client_license SET certificate=?,authority_url=?,last_seen_at=? WHERE id=1",
    )
    .bind(DbJson(certificate))
    .bind(url)
    .bind(now)
    .execute(&state.pool)
    .await?;
    *guard = None;
    Ok(Json(json!({"active":true,"expires_at":claims.expires_at})))
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
    if !hex64(&input.binding)
        || input.code.len() != 48
        || !input.code.bytes().all(|b| b.is_ascii_hexdigit())
        || input.nonce.len() != 48
    {
        return Err(activation_error("授权请求格式错误"));
    }
    let id = digest(&input.code);
    let mut tx = state.pool.begin().await?;
    let row=sqlx::query("SELECT valid_days,redeem_before,redeemed_at,binding,certificate FROM license_codes WHERE code_hash=? FOR UPDATE").bind(&id).fetch_optional(&mut *tx).await?.ok_or_else(||activation_error("授权码无效"))?;
    let now = Utc::now().timestamp();
    // Retry from the same binding is idempotent, allowing recovery after a lost response.
    // A redeemed code can never create a second license, extend time or change its binding.
    let claims = if row.try_get::<Option<i64>, _>("redeemed_at")?.is_some() {
        if row.try_get::<Option<String>, _>("binding")?.as_deref() != Some(&input.binding) {
            return Err(activation_error("授权码已使用，不能绑定其他设备或账号"));
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
        Claims {
            schema: 1,
            id: id.clone(),
            binding: input.binding.clone(),
            issued_at: now,
            expires_at: now + i64::from(row.try_get::<i32, _>("valid_days")?) * 86400,
            checked_at: now,
            nonce: input.nonce,
        }
    };
    let certificate = sign(&claims, &state.key)?;
    sqlx::query("UPDATE license_codes SET redeemed_at=COALESCE(redeemed_at,?),binding=?,certificate=? WHERE code_hash=?").bind(now).bind(&input.binding).bind(DbJson(&certificate)).bind(id).execute(&mut *tx).await?;
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
        sqlx::query("UPDATE client_license SET certificate=NULL,authority_url=NULL,last_seen_at=0 WHERE id=1").execute(&pool).await.unwrap();
        let mut state = AppState::new(pool.clone()).unwrap();
        state.license = Some(Client {
            device: digest("device-one"),
            key: key.verifying_key(),
            gate: Arc::default(),
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
            json!({"code":code,"binding":binding,"nonce":random_hex()}),
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
                        json!({"code":code,"server_url":address}).to_string(),
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
        // A retry recovers the same license without extending its expiry.
        let _ = activate(
            State(state.clone()),
            Json(Activate {
                code,
                server_url: address.clone(),
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
        assert!(require(&state).await.is_err());
        let new_code = issue(&pool, 2).await.unwrap();
        let _ = activate(
            State(state.clone()),
            Json(Activate {
                code: new_code,
                server_url: address.clone(),
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
        sqlx::query("UPDATE client_license SET certificate=NULL,authority_url=NULL,last_seen_at=0 WHERE id=1").execute(&pool).await.unwrap();
        server.abort();
        pool.close().await;
    }
}
