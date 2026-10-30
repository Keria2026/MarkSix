#[path = "../test_support/database.rs"]
mod database;
use marksix::{api, store};
use std::sync::Arc;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let pool = database::reset().await?;
    let mut state = store::AppState::new(pool)?;
    state.clock = Arc::new(|| {
        chrono::NaiveDate::from_ymd_opt(2040, 1, 1)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    });
    let app = api::router(state).route(
        "/api/license",
        axum::routing::get(|| async {
            axum::Json(serde_json::json!({"active":true,"hosted":true,"permanent":true}))
        }),
    );
    axum::serve(tokio::net::TcpListener::bind("127.0.0.1:8081").await?, app)
        .with_graceful_shutdown(marksix::shutdown_signal())
        .await?;
    Ok(())
}
