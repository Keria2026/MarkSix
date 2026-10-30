use crate::api::{ApiError, ApiResult, digest};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
};
use chrono::{Datelike, Days, FixedOffset, NaiveDate, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, MySqlPool};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};

#[derive(Clone)]
pub(super) struct Control {
    pub pool: MySqlPool,
    pub provision: Option<MySqlPool>,
    pub secure: bool,
    pub gate: Arc<Semaphore>,
    pub attempts: Arc<Mutex<HashMap<String, (Instant, u16)>>>,
    pub dummy_hash: Arc<String>,
    pub backup_root: PathBuf,
}
impl Control {
    pub async fn new(
        pool: MySqlPool,
        provision: Option<MySqlPool>,
        secure: bool,
        backup_root: PathBuf,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            pool,
            provision,
            secure,
            gate: Arc::new(Semaphore::new(1)),
            attempts: Arc::default(),
            dummy_hash: Arc::new(hash_password(random_token()).await?),
            backup_root,
        })
    }
    pub async fn verify(
        &self,
        identity: &str,
        password: String,
        hash: Option<String>,
    ) -> ApiResult<()> {
        if password.len() > 256 || identity.chars().count() > 80 {
            return Err(unauthorized());
        }
        let permit = self.gate.clone().try_acquire_owned().map_err(|_| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "正在验证登录，请稍后重试".into(),
            )
        })?;
        {
            let mut attempts = self.attempts.lock().await;
            attempts.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(60));
            if attempts.len() >= 4096 && !attempts.contains_key(identity) {
                return Err(ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "登录尝试过多，请稍后重试".into(),
                ));
            }
            let entry = attempts
                .entry(identity.to_owned())
                .or_insert((Instant::now(), 0));
            if entry.1 >= 8 {
                return Err(ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "登录尝试过多，请一分钟后重试".into(),
                ));
            }
            entry.1 += 1;
        }
        let known = hash.is_some();
        let hash = hash.unwrap_or_else(|| self.dummy_hash.as_ref().clone());
        let valid = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            PasswordHash::new(&hash).is_ok_and(|h| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &h)
                    .is_ok()
            })
        })
        .await
        .map_err(anyhow::Error::from)?;
        if !known || !valid {
            return Err(unauthorized());
        }
        Ok(())
    }
}
#[derive(Clone, FromRow)]
pub(super) struct Account {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub credential_version: i64,
    pub permanent: bool,
    pub authorized_through: Option<NaiveDate>,
    pub disabled: bool,
    pub state: String,
    pub database_name: String,
    pub database_user: String,
    pub database_password: String,
}
impl Account {
    pub fn active(&self, date: NaiveDate) -> bool {
        self.state == "ready"
            && !self.disabled
            && (self.permanent || self.authorized_through.is_some_and(|d| d >= date))
    }
    pub fn public(&self) -> Value {
        json!({"id":self.id,"username":self.username,"permanent":self.permanent,"authorized_through":self.authorized_through,"disabled":self.disabled,"state":self.state,"active":self.active(today())})
    }
}
pub(super) fn today() -> NaiveDate {
    crate::domain::business_date(
        Utc::now()
            .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
            .naive_local(),
    )
}
pub(super) fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
pub(super) fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "账号、密码或登录状态无效".into())
}
pub(super) fn invalid(message: &str) -> ApiError {
    ApiError(StatusCode::UNPROCESSABLE_ENTITY, message.into())
}
pub(super) fn cookie(control: &Control, name: &str, value: &str, age: u32) -> String {
    // No Domain attribute: customer and management cookies never cross subdomains.
    format!(
        "{name}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}{}",
        if control.secure { "; Secure" } else { "" }
    )
}
pub(super) fn token(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name && value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
                .then(|| value.to_owned())
        })
}
pub(super) async fn hash_password(password: String) -> anyhow::Result<String> {
    anyhow::ensure!(
        password.chars().count() >= 12 && password.len() <= 256,
        "密码须至少 12 个字符且不超过 256 字节"
    );
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(
                password.as_bytes(),
                &SaltString::generate(&mut rand::rngs::OsRng),
            )
            .map(|h| h.to_string())
            .map_err(|e| anyhow::anyhow!(e.to_string()))
    })
    .await?
}
pub(super) fn username(name: &str) -> ApiResult<()> {
    if name.trim() != name
        || name.is_empty()
        || name.chars().count() > 80
        || name.chars().any(char::is_control)
    {
        return Err(invalid("账号须为 1–80 个字符，不能有首尾空格或控制字符"));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Login {
    pub username: String,
    pub password: String,
}

pub(super) async fn customer(control: &Control, headers: &HeaderMap) -> ApiResult<Account> {
    let token = token(headers, "marksix_session").ok_or_else(unauthorized)?;
    sqlx::query_as::<_,Account>("SELECT a.* FROM hosted_accounts a JOIN hosted_sessions s ON s.account_id=a.id AND s.credential_version=a.credential_version WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP(6) AND a.disabled=FALSE AND a.state='ready'")
        .bind(digest(&token)).fetch_optional(&control.pool).await?.ok_or_else(unauthorized)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PasswordChange {
    pub old_password: String,
    pub new_password: String,
}
pub(super) async fn change_password(
    State(c): State<Control>,
    headers: HeaderMap,
    Json(input): Json<PasswordChange>,
) -> ApiResult<Json<Value>> {
    let first = customer(&c, &headers).await?;
    c.verify(
        &first.username,
        input.old_password.clone(),
        Some(first.password_hash.clone()),
    )
    .await
    .map_err(|e| {
        if e.0 == StatusCode::UNAUTHORIZED {
            invalid("原密码不正确")
        } else {
            e
        }
    })?;
    if input.new_password.chars().count() < 12 || input.new_password.len() > 256 {
        return Err(invalid("新密码须至少 12 个字符且不超过 256 字节"));
    }
    if input.old_password == input.new_password {
        return Err(invalid("新密码不能与原密码相同"));
    }
    let permit = c.gate.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "正在验证账号，请稍后重试".into(),
        )
    })?;
    let hash = hash_password(input.new_password).await?;
    drop(permit);
    let mut tx = c.pool.begin().await?;
    let current =
        sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=? FOR UPDATE")
            .bind(&first.id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(unauthorized)?;
    if current.disabled
        || current.state != "ready"
        || current.credential_version != first.credential_version
        || current.password_hash != first.password_hash
    {
        return Err(unauthorized());
    }
    let live: Option<String> = sqlx::query_scalar("SELECT token_hash FROM hosted_sessions WHERE account_id=? AND token_hash=? AND credential_version=? AND expires_at>UTC_TIMESTAMP(6) FOR UPDATE")
        .bind(&first.id).bind(digest(&token(&headers, "marksix_session").ok_or_else(unauthorized)?))
        .bind(first.credential_version).fetch_optional(&mut *tx).await?;
    if live.is_none() {
        return Err(unauthorized());
    }
    sqlx::query("UPDATE hosted_accounts SET password_hash=?,credential_version=credential_version+1 WHERE id=?")
        .bind(hash).bind(&first.id).execute(&mut *tx).await?;
    sqlx::query("UPDATE hosted_codes SET revoked_at=UTC_TIMESTAMP(6) WHERE account_id=? AND redeemed_at IS NULL AND revoked_at IS NULL")
        .bind(&first.id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM hosted_sessions WHERE account_id=?")
        .bind(&first.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO authority_audit(account_id,event) VALUES(?,'customer_password_changed')",
    )
    .bind(&first.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CodeInput {
    pub days: u32,
    pub redeem_through: NaiveDate,
}
pub(super) async fn issue_code(
    control: &Control,
    account_id: &str,
    input: CodeInput,
    owner: &str,
) -> ApiResult<Value> {
    let now = today();
    if !(1..=3650).contains(&input.days)
        || input.redeem_through < now
        || input.redeem_through > now.checked_add_days(Days::new(3650)).unwrap()
    {
        return Err(invalid(
            "授权天数须为 1–3650，激活截止日须在未来 3650 天内（含今天）",
        ));
    }
    let code = format!("MSH1-{}", random_token());
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = control.pool.begin().await?;
    let a = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=? FOR UPDATE")
        .bind(account_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(crate::api::missing)?;
    if a.disabled || a.state != "ready" || a.permanent {
        return Err(invalid("仅可为正常、非永久授权客户签发激活码"));
    }
    sqlx::query("INSERT INTO hosted_codes(id,token_hash,account_id,credential_version,days,redeem_through) VALUES(?,?,?,?,?,?)").bind(&id).bind(digest(&code)).bind(account_id).bind(a.credential_version).bind(input.days).bind(input.redeem_through).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO authority_audit(administrator_id,account_id,event) VALUES(?,?,'issue_code')",
    )
    .bind(owner)
    .bind(account_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({"id":id,"code":code,"days":input.days,"redeem_through":input.redeem_through}))
}
#[derive(Deserialize)]
pub(super) struct Activate {
    pub code: String,
    pub request_id: String,
}
pub(super) async fn redeem(
    control: &Control,
    headers: &HeaderMap,
    input: Activate,
) -> ApiResult<()> {
    let a = customer(control, headers).await?;
    if input.code.len() != 69
        || !input.code.starts_with("MSH1-")
        || uuid::Uuid::parse_str(&input.request_id).is_err()
    {
        return Err(invalid("激活码或提交标识格式错误"));
    }
    let mut tx = control.pool.begin().await?;
    // All grant, password, session and deletion changes lock the account first.
    let a = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=? FOR UPDATE")
        .bind(&a.id)
        .fetch_one(&mut *tx)
        .await?;
    if a.disabled || a.state != "ready" {
        return Err(unauthorized());
    }
    let current = token(headers, "marksix_session").ok_or_else(unauthorized)?;
    let valid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hosted_sessions WHERE account_id=? AND token_hash=? AND credential_version=? AND expires_at>UTC_TIMESTAMP(6)").bind(&a.id).bind(digest(&current)).bind(a.credential_version).fetch_one(&mut *tx).await?;
    if valid != 1 {
        return Err(unauthorized());
    }
    use sqlx::Row;
    let row = sqlx::query("SELECT * FROM hosted_codes WHERE token_hash=? AND account_id=? AND credential_version=? AND revoked_at IS NULL FOR UPDATE").bind(digest(input.code.trim())).bind(&a.id).bind(a.credential_version).fetch_optional(&mut *tx).await?.ok_or_else(||invalid("激活码无效、已作废或不属于当前账号"))?;
    if row
        .try_get::<Option<chrono::NaiveDateTime>, _>("redeemed_at")?
        .is_some()
    {
        if row
            .try_get::<Option<String>, _>("redemption_id")?
            .as_deref()
            == Some(&input.request_id)
        {
            tx.commit().await?;
            return Ok(());
        }
        return Err(invalid("激活码已经使用，请获取新的激活码"));
    }
    let now = today();
    if row.try_get::<NaiveDate, _>("redeem_through")? < now {
        return Err(invalid("已超过激活截止日"));
    }
    let days = row.try_get::<i32, _>("days")?;
    let through = renewed_through(now, a.authorized_through, days)
        .ok_or_else(|| invalid("授权日期超出范围"))?;
    sqlx::query("UPDATE hosted_accounts SET authorized_through=? WHERE id=?")
        .bind(through)
        .bind(&a.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE hosted_codes SET redeemed_at=UTC_TIMESTAMP(6),redemption_id=?,granted_through=? WHERE id=?").bind(input.request_id).bind(through).bind(row.try_get::<String,_>("id")?).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO authority_audit(account_id,event) VALUES(?,'redeem_code')")
        .bind(&a.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
fn renewed_through(now: NaiveDate, old: Option<NaiveDate>, days: i32) -> Option<NaiveDate> {
    if !(1..=3650).contains(&days) {
        return None;
    }
    // A new/expired grant includes today's period as day one. An active grant
    // appends complete periods after the already-paid final period.
    let through = match old.filter(|d| *d >= now) {
        Some(old) => old.checked_add_days(Days::new(days as u64)),
        None => now.checked_add_days(Days::new((days - 1) as u64)),
    };
    through.filter(|d| d.year() <= 9999)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn login_accepts_the_same_unicode_name_boundary_as_account_creation() {
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .connect_lazy("mysql://unused:unused@127.0.0.1/unused")
            .unwrap();
        let control = Control::new(pool, None, false, PathBuf::new())
            .await
            .unwrap();
        let name = "😀".repeat(80);
        username(&name).unwrap();
        let password = "disposable-test-password".to_owned();
        let hash = hash_password(password.clone()).await.unwrap();
        control.verify(&name, password, Some(hash)).await.unwrap();
        assert!(username(&"😀".repeat(81)).is_err());
    }
    #[tokio::test]
    async fn busy_verification_does_not_consume_login_attempts() {
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .connect_lazy("mysql://unused:unused@127.0.0.1/unused")
            .unwrap();
        let control = Control::new(pool, None, false, PathBuf::new())
            .await
            .unwrap();
        let permit = control.gate.acquire().await.unwrap();
        for _ in 0..12 {
            let result = control
                .verify("customer", "valid-password".into(), None)
                .await;
            assert_eq!(result.unwrap_err().0, StatusCode::TOO_MANY_REQUESTS);
        }
        assert!(control.attempts.lock().await.is_empty());
        drop(permit);
        let password = "disposable-customer-password".to_string();
        let hash = hash_password(password.clone()).await.unwrap();
        control
            .verify("customer", password, Some(hash))
            .await
            .unwrap();
    }
    #[test]
    fn grants_count_periods_inclusively_and_preserve_prepaid_time() {
        let d = NaiveDate::from_ymd_opt(2026, 12, 31).unwrap();
        assert_eq!(renewed_through(d, None, 1), Some(d));
        assert_eq!(renewed_through(d, Some(d), 1), d.succ_opt());
        assert_eq!(
            renewed_through(d, d.pred_opt(), 30),
            d.checked_add_days(Days::new(29))
        );
        assert_eq!(renewed_through(d, None, 0), None);
    }
}
