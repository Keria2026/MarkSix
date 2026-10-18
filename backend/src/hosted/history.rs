//! Customer-owned erasure, executed by the authority that owns the backup mount.
use super::{accounts::*, management, tenancy};
use crate::api::{ApiResult, digest};
use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::types::Json as DbJson;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ClearHistory {
    pub password: String,
    pub confirmation: String,
    pub request_id: String,
}

pub(super) async fn clear(
    State(c): State<Control>,
    headers: HeaderMap,
    Json(input): Json<ClearHistory>,
) -> ApiResult<Json<Value>> {
    let first = customer(&c, &headers).await?;
    uuid::Uuid::parse_str(&input.request_id).map_err(|_| invalid("提交标识不合法"))?;
    if input.confirmation != "永久清空历史记录" {
        return Err(invalid("请输入“永久清空历史记录”进行确认"));
    }
    c.verify(
        &first.username,
        input.password,
        Some(first.password_hash.clone()),
    )
    .await
    .map_err(|e| {
        if e.0 == axum::http::StatusCode::UNAUTHORIZED {
            crate::api::ApiError(
                axum::http::StatusCode::FORBIDDEN,
                "登录密码不正确，未清空任何记录".into(),
            )
        } else {
            e
        }
    })?;
    let _permit = c.gate.clone().try_acquire_owned().map_err(|_| {
        crate::api::ApiError(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "正在处理账号或清空历史，请稍后重试".into(),
        )
    })?;
    // Lock order matches account deletion. Backup/restore cannot race erasure.
    let _lock = management::backup_lock(c.backup_root.clone()).await?;
    let mut control_tx = c.pool.begin().await?;
    let a = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=? FOR UPDATE")
        .bind(&first.id)
        .fetch_optional(&mut *control_tx)
        .await?
        .ok_or_else(unauthorized)?;
    let token = token(&headers, "marksix_session").ok_or_else(unauthorized)?;
    let valid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hosted_sessions WHERE token_hash=? AND account_id=? AND credential_version=? AND expires_at>UTC_TIMESTAMP(6)")
        .bind(digest(&token)).bind(&a.id).bind(a.credential_version).fetch_one(&mut *control_tx).await?;
    if valid != 1 || a.disabled || a.state != "ready" || a.password_hash != first.password_hash {
        return Err(unauthorized());
    }
    management::identifiers(&a)?;
    let pool = tenancy::pool(&a, 1).await?;
    let result = erase(&c, &a, &pool, &input.request_id).await;
    pool.close().await;
    result?;
    control_tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

async fn erase(
    c: &Control,
    a: &Account,
    pool: &sqlx::MySqlPool,
    request_id: &str,
) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    if sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM history_clear_requests WHERE request_id=?",
    )
    .bind(request_id)
    .fetch_one(&mut *tx)
    .await?
        != 0
    {
        return Ok(());
    }
    let cutoff = today();
    // Period locks serialize with settlement, amount correction and cancellations.
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM periods WHERE business_date<? ORDER BY id FOR UPDATE")
            .bind(cutoff)
            .fetch_all(&mut *tx)
            .await?;
    // Backups contain the original ledgers, so deleting only live rows is insufficient.
    // The durable opaque receipt also rejects old generations restored from a copy.
    let receipt = c.backup_root.join("erasures");
    tokio::fs::create_dir_all(&receipt)
        .await
        .map_err(anyhow::Error::from)?;
    let target = receipt.join(format!("{}.json", a.id));
    let partial = target.with_extension("partial");
    let content = json!({"account_id":a.id,"cleared_at_utc":chrono::Utc::now().to_rfc3339()});
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(anyhow::Error::from)?;
    file.write_all(content.to_string().as_bytes())
        .await
        .map_err(anyhow::Error::from)?;
    file.sync_all().await.map_err(anyhow::Error::from)?;
    drop(file);
    tokio::fs::rename(&partial, &target)
        .await
        .map_err(anyhow::Error::from)?;
    let root = c.backup_root.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        std::fs::File::open(receipt)?.sync_all()?;
        std::fs::File::open(root)?.sync_all()
    })
    .await
    .map_err(anyhow::Error::from)?
    .map_err(anyhow::Error::from)?;
    management::remove_tree(&c.backup_root.join("tenants").join(&a.id)).await?;
    for id in &ids {
        for statement in [
            "DELETE FROM bet_mutations WHERE bet_id IN (SELECT id FROM bets WHERE period_id=?)",
            "DELETE FROM layoffs WHERE period_id=?",
            "DELETE FROM bets WHERE period_id=?",
            "DELETE FROM bet_slips WHERE period_id=?",
            "DELETE FROM audit_events WHERE period_id=?",
            "DELETE FROM periods WHERE id=?",
        ] {
            sqlx::query(statement).bind(id).execute(&mut *tx).await?;
        }
    }
    sqlx::query("INSERT INTO history_clear_requests(request_id,cutoff,response) VALUES(?,?,?)")
        .bind(request_id)
        .bind(cutoff)
        .bind(DbJson(json!({"ok":true})))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
