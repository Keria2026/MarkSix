use marksix::{api, store, worker};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|arg| arg == "--healthcheck") {
        reqwest::Client::new()
            .get("http://127.0.0.1:8080/api/health")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "marksix=info,tower_http=info".into()),
        )
        .init();
    let frontend = std::env::var_os("FRONTEND_DIR")
        .map(std::path::PathBuf::from)
        .map(std::fs::canonicalize)
        .transpose()?;
    if let Some(directory) = &frontend {
        anyhow::ensure!(
            directory.join("index.html").is_file(),
            "FRONTEND_DIR must contain index.html"
        );
    }
    let database_url =
        std::env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("请设置 DATABASE_URL"))?;
    let pool = store::connect(&database_url).await?;
    store::initialize(
        &pool,
        &std::env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".into()),
        std::env::var("ADMIN_PASSWORD").ok().as_deref(),
    )
    .await?;
    let mut state = store::AppState::new(pool)?;
    state.secure_cookie = std::env::var("SECURE_COOKIE").is_ok_and(|v| v == "true");
    worker::recover(&state).await?;
    let task = tokio::spawn(worker::run(state.clone()));
    let address = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address,"MarkSix is running");
    axum::serve(listener, api::router_with_frontend(state, frontend))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    task.abort();
    Ok(())
}
