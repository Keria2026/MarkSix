pub mod domain;

pub mod api;
pub mod risk;
pub mod store;
pub mod worker;

pub mod ledger;

pub mod configuration;

pub mod license;
/// SIGTERM is how Docker stops the server; Windows also uses a local authenticated shutdown request.
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
