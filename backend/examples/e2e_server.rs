//! Test-only executable. Never compiled into the production image.
use marksix::{api, store, worker};
use std::sync::Arc;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::var("TEST_DATABASE_URL")?;
    anyhow::ensure!(
        url.ends_with("/marksix_test"),
        "Only the disposable marksix_test database may be reset"
    );
    let pool = store::connect(&url).await?;
    for table in [
        "audit_events",
        "bet_mutations",
        "layoffs",
        "bets",
        "periods",
        "play_versions",
        "plays",
        "sessions",
        "closing_configs",
        "mapping_configs",
        "administrators",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&pool)
            .await?;
    }
    let password = std::env::var("TEST_ADMIN_PASSWORD")?;
    store::initialize(&pool, "test-admin", Some(&password)).await?;
    let mut state = store::AppState::new(pool)?;
    state.clock = Arc::new(|| {
        chrono::NaiveDate::from_ymd_opt(2026, 10, 14)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    });
    tokio::spawn(worker::run(state.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8081").await?;
    axum::serve(
        listener,
        api::router(state).route(
            "/api/license",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({"active":true,"testing":true,"hosted":true}))
            }),
        ),
    )
    .await?;
    Ok(())
}
