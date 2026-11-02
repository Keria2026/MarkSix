use marksix::store;
pub async fn reset() -> anyhow::Result<sqlx::MySqlPool> {
    let url = std::env::var("TEST_DATABASE_URL")?;
    anyhow::ensure!(
        url.ends_with("/marksix_test"),
        "Only marksix_test may be reset"
    );
    let pool = store::connect(&url).await?;
    for table in [
        "bettor_play_preferences",
        "text_entry_preferences",
        "audit_events",
        "bet_mutations",
        "layoffs",
        "bets",
        "bet_slips",
        "periods",
        "play_versions",
        "plays",
        "sessions",
        "closing_configs",
        "mapping_configs",
        "administrators",
        "module_features",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&pool)
            .await?;
    }
    store::initialize(
        &pool,
        "test-admin",
        Some(&std::env::var("TEST_ADMIN_PASSWORD")?),
    )
    .await?;
    Ok(pool)
}
