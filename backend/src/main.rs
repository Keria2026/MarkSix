use marksix::{api, license, store, worker};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s == "--help" || s == "-h") {
        println!(
            "MarkSix {}\nServer: marksix [--serve]\nOwner: --license-keygen NEW_FILE | --license-public-key | --license-issue DAYS [--bind BINDING] | --license-until RFC3339 [--bind BINDING] | --license-route REVISION | --license-revoke LICENSE_ID | --license-authority\nAuthority requires AUTHORITY_DATABASE_URL and LICENSE_SIGNING_KEY_FILE. Never distribute the private key.",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--license-public-key") {
        println!("{}", license::public_key()?);
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--license-route") {
        anyhow::ensure!(args.len() == 3, "Usage: --license-route REVISION");
        let url = std::env::var("PUBLIC_AUTHORITY_URL")?;
        let discovery = std::env::var("LICENSE_DISCOVERY_URL")
            .ok()
            .filter(|s| !s.is_empty());
        println!(
            "{}",
            serde_json::to_string_pretty(&license::route_document(
                &url,
                discovery.as_deref(),
                args[2].parse()?
            )?)?
        );
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--license-keygen") {
        license::keygen(std::path::Path::new(args.get(2).ok_or_else(|| {
            anyhow::anyhow!("Usage: marksix --license-keygen NEW_PRIVATE_KEY_FILE")
        })?))?;
        return Ok(());
    }
    if args.get(1).is_some_and(|s| {
        s == "--license-authority"
            || s == "--license-issue"
            || s == "--license-until"
            || s == "--license-revoke"
    }) {
        let pool = store::connect(&std::env::var("AUTHORITY_DATABASE_URL").map_err(|_| {
            anyhow::anyhow!("Set AUTHORITY_DATABASE_URL to the separate authority database")
        })?)
        .await?;
        if args[1] == "--license-revoke" {
            let id = args
                .get(2)
                .ok_or_else(|| anyhow::anyhow!("Usage: --license-revoke LICENSE_ID"))?;
            anyhow::ensure!(
                id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()),
                "License ID must be 64 hex characters"
            );
            let result = sqlx::query("DELETE FROM license_codes WHERE code_hash=?")
                .bind(id)
                .execute(&pool)
                .await?;
            println!("Revoked records: {}", result.rows_affected());
        } else if args[1] == "--license-issue" || args[1] == "--license-until" {
            anyhow::ensure!(
                args.len() == 3 || (args.len() == 5 && args[3] == "--bind"),
                "Usage: --license-issue DAYS [--bind BINDING] | --license-until RFC3339 [--bind BINDING]"
            );
            let (days, expiry) = if args[1] == "--license-issue" {
                (args[2].parse()?, None)
            } else {
                (
                    1,
                    Some(chrono::DateTime::parse_from_rfc3339(&args[2])?.timestamp()),
                )
            };
            println!(
                "{}",
                license::issue_activation(&pool, days, expiry, args.get(4).map(String::as_str))
                    .await?
            );
        } else {
            license::authority(
                pool,
                &std::env::var("AUTHORITY_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8090".into()),
            )
            .await?;
        }
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--authority-healthcheck") {
        reqwest::Client::new()
            .get("http://127.0.0.1:8090/health")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
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
    state.license = Some(license::Client::production()?);
    state.shutdown_token = std::env::var("SHUTDOWN_TOKEN")
        .ok()
        .filter(|s| s.len() >= 48);
    state.secure_cookie = std::env::var("SECURE_COOKIE").is_ok_and(|v| v == "true");
    worker::recover(&state).await?;
    let task = tokio::spawn(worker::run(state.clone()));
    let address = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address,"MarkSix is running");
    let shutdown = state.shutdown.clone();
    let cancellations = state.cancellations.clone();
    axum::serve(listener, api::router_with_frontend(state, frontend))
        .with_graceful_shutdown(async move {
            tokio::select! { _=marksix::shutdown_signal()=>{}, _=shutdown.notified()=>{} }
            for flag in cancellations.lock().await.values() {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        })
        .await?;
    task.abort();
    Ok(())
}
