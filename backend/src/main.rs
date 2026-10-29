use marksix::store;
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s == "--hosted-healthcheck") {
        let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
        let port: u16 = bind.rsplit(':').next().unwrap_or("8080").parse()?;
        reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/health"))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
    if args
        .get(1)
        .is_some_and(|s| s == "--hosted" || s == "--hosted-authority")
    {
        marksix::logging::init();
        let url = std::env::var("CONTROL_DATABASE_URL")?;
        // Customer service has no schema creation or authority-administrator grants.
        let pool = if args[1] == "--hosted-authority" {
            store::connect(&url).await?
        } else {
            let pool = sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(4)
                .connect(&url)
                .await?;
            store::require_current_schema(&pool).await?;
            pool
        };
        let address = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
        return if args[1] == "--hosted" {
            marksix::hosted::serve_portal(pool, &address).await
        } else {
            marksix::hosted::serve_management(pool, &address).await
        };
    }
    if args.get(1).is_some_and(|s| s == "--help" || s == "-h") {
        println!(
            "MarkSix {}\nUsage: marksix --hosted | --hosted-authority | --hosted-healthcheck",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    anyhow::bail!(
        "Choose --hosted or --hosted-authority; local installations are no longer supported"
    )
}
