//! Disposable localhost acceptance fixture. Never included in either release.
//! Runs the real HTTP API, MySQL transactions, draw parser and settlement worker.
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::NaiveDateTime;
use marksix::{api, domain::parse_draw, store, worker};
use serde_json::{Value, json};
use std::sync::{Arc, RwLock};

#[derive(Clone)]
struct Fixture {
    app: store::AppState,
    clock: Arc<RwLock<NaiveDateTime>>,
    feed: Arc<RwLock<Vec<Value>>>,
    token: String,
}
async fn source(State(f): State<Fixture>) -> Json<Vec<Value>> {
    Json(f.feed.read().unwrap().clone())
}
async fn control(
    State(f): State<Fixture>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if headers.get("x-fixture-token").and_then(|v| v.to_str().ok()) != Some(&f.token) {
        return Err((StatusCode::FORBIDDEN, "fixture token required".into()));
    }
    let result: anyhow::Result<()> = async {
        match v["action"].as_str() {
            Some("time") => {
                *f.clock.write().unwrap() = NaiveDateTime::parse_from_str(
                    v["time"].as_str().unwrap_or(""),
                    "%Y-%m-%dT%H:%M:%S",
                )?
            }
            Some("feed") => *f.feed.write().unwrap() = serde_json::from_value(v["values"].clone())?,
            Some("tick") => {
                if v["force_fetch"] == true {
                    sqlx::query("UPDATE periods SET last_fetch_at=NULL WHERE state='pending'")
                        .execute(&f.app.pool)
                        .await?;
                }
                worker::tick(&f.app).await?;
            }
            Some("replay") => {
                let raw = &v["draw"];
                let draw = parse_draw(raw).map_err(anyhow::Error::msg)?;
                anyhow::ensure!(draw.open_time <= f.app.now(), "future draw");
                worker::accept_draw(&f.app, &draw, raw).await?;
            }
            _ => anyhow::bail!("unknown fixture action"),
        }
        Ok(())
    }
    .await;
    result
        .map(|_| Json(json!({"ok":true})))
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::var("TEST_DATABASE_URL")?;
    anyhow::ensure!(
        url.ends_with("/marksix_test"),
        "Only disposable marksix_test is allowed"
    );
    let token = std::env::var("FIXTURE_TOKEN")?;
    anyhow::ensure!(token.len() >= 32, "fixture token too short");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8082").await?;
    let pool = store::connect(&url).await?;
    if std::env::var("RUNTIME_RESET").as_deref() == Ok("yes") {
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
    }
    let password = std::env::var("TEST_ADMIN_PASSWORD")?;
    store::initialize(&pool, "test-admin", Some(&password)).await?;
    let mut app = store::AppState::new(pool)?;
    let clock = Arc::new(RwLock::new(NaiveDateTime::parse_from_str(
        "2026-10-14T12:00:00",
        "%Y-%m-%dT%H:%M:%S",
    )?));
    let clock_reader = clock.clone();
    app.clock = Arc::new(move || *clock_reader.read().unwrap());
    app.draw_url = "http://127.0.0.1:8082/fixture/source".into();
    let f = Fixture {
        app: app.clone(),
        clock,
        feed: Arc::new(RwLock::new(vec![])),
        token,
    };
    let routes = Router::new()
        .route("/fixture/source", get(source))
        .route("/fixture/control", post(control))
        .with_state(f);
    println!("Runtime fixture ready on localhost:8082 (disposable database only)");
    axum::serve(listener, api::router(app.clone()).merge(routes))
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut terminate =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM");
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            for flag in app.cancellations.lock().await.values() {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        })
        .await?;
    Ok(())
}
