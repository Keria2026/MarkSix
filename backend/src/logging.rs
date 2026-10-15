//! Operational logs contain errors only; financial audit events live in MySQL.
pub fn init() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::ERROR)
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .init();
}
