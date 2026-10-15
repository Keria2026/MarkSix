//! Server-hosted accounts. Business state is selected only from a validated session.
mod accounts;
mod management;
mod portal;
mod tenancy;

pub use management::serve as serve_management;
pub use portal::serve as serve_portal;

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(crate) struct Policy {
    pub pool: sqlx::MySqlPool,
    pub account_id: String,
}
pub(crate) async fn allowed(p: &Policy) -> crate::api::ApiResult<()> {
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
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM hosted_accounts WHERE id=? AND state='ready'")
            .bind(&p.account_id)
            .fetch_one(&p.pool)
            .await?;
    Ok(n == 1)
}
