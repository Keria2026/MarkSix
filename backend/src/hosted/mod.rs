//! Server-hosted accounts. Business state is selected only from a validated session.
mod accounts;
mod history;
mod management;
mod portal;
mod tenancy;
mod workspaces;

pub use management::serve as serve_management;
pub use portal::serve as serve_portal;

#[cfg(test)]
#[path = "../../tests/support/hosted.rs"]
mod tests;

// Constructed only after central session/account validation; never from headers.
#[derive(Clone)]
pub(crate) struct ValidatedCustomer(pub(crate) String);

#[derive(Clone)]
pub(crate) struct Policy {
    pub pool: sqlx::MySqlPool,
    pub account_id: String,
    pub workspace_id: Option<String>,
}
pub(crate) async fn require(state: &crate::store::AppState) -> crate::api::ApiResult<()> {
    // Only test examples construct an unbound state. Production always leases
    // a tenant from a centrally validated customer session.
    if let Some(policy) = &state.hosted {
        allowed(policy).await
    } else {
        Ok(())
    }
}
pub(crate) async fn allowed(p: &Policy) -> crate::api::ApiResult<()> {
    if let Some(workspace) = &p.workspace_id {
        let members = sqlx::query_as::<_, accounts::Account>(
            "SELECT * FROM hosted_accounts WHERE workspace_id=?",
        )
        .bind(workspace)
        .fetch_all(&p.pool)
        .await?;
        return if members.iter().any(|a| a.active(accounts::today())) {
            Ok(())
        } else {
            Err(crate::api::ApiError(
                axum::http::StatusCode::PAYMENT_REQUIRED,
                "协作账户均已到期或停用".into(),
            ))
        };
    }
    let a = sqlx::query_as::<_, accounts::Account>("SELECT * FROM hosted_accounts WHERE id=?")
        .bind(&p.account_id)
        .fetch_optional(&p.pool)
        .await?;
    if a.is_some_and(|a| a.active(accounts::today())) {
        Ok(())
    } else {
        Err(crate::api::ApiError(
            axum::http::StatusCode::PAYMENT_REQUIRED,
            "账号已到期、停用或删除".into(),
        ))
    }
}
pub(crate) async fn background_allowed(p: &Policy) -> crate::api::ApiResult<bool> {
    if let Some(workspace) = &p.workspace_id {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hosted_workspaces WHERE id=? AND state='ready' AND EXISTS(SELECT 1 FROM hosted_accounts WHERE workspace_id=hosted_workspaces.id AND state='ready')")
            .bind(workspace).fetch_one(&p.pool).await?;
        return Ok(n == 1);
    }
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM hosted_accounts WHERE id=? AND state='ready'")
            .bind(&p.account_id)
            .fetch_one(&p.pool)
            .await?;
    Ok(n == 1)
}
