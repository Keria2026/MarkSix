//! Small stable calculation fixtures, independent of customer-facing defaults.
use marksix::domain::*;
include!("rules.rs");

pub async fn calculation_rules(pool: &sqlx::MySqlPool) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM play_versions")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM plays").execute(pool).await?;
    for rule in defaults() {
        let id = sqlx::query("INSERT INTO plays(version,rule) VALUES(1,?)")
            .bind(sqlx::types::Json(&rule))
            .execute(pool)
            .await?
            .last_insert_id();
        sqlx::query("INSERT INTO play_versions(play_id,version,rule) VALUES(?,1,?)")
            .bind(id)
            .bind(sqlx::types::Json(&rule))
            .execute(pool)
            .await?;
    }
    Ok(())
}
