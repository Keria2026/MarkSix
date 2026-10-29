pub mod domain;

pub mod api;
mod betting;
mod features;
mod queries;
mod records;
pub mod risk;
pub mod store;
mod text_entry;
pub mod worker;

pub mod ledger;

pub mod configuration;

pub mod hosted;
pub mod logging;
/// Docker stops the Ubuntu services with SIGTERM.
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Public build metadata contains no deployment secrets.
pub fn build_info(mode: &str) -> serde_json::Value {
    serde_json::json!({"mode": mode, "version": env!("CARGO_PKG_VERSION"),
        "commit": option_env!("MARKSIX_REVISION").unwrap_or("development")})
}
