use super::*;
#[tokio::test]
async fn concurrent_draw_failures_share_one_cached_fetch() {
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = count.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new().route(
        "/draw",
        axum::routing::get(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                axum::http::StatusCode::BAD_GATEWAY
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .connect_lazy("mysql://unused:unused@127.0.0.1/unused")
        .unwrap();
    let mut state = AppState::new(pool).unwrap();
    state.client = reqwest::Client::builder().no_proxy().build().unwrap();
    state.draw_url = format!("http://{address}/draw");
    state.draw_cache = Some(Arc::default());
    let (a, b) = tokio::join!(fetch(&state), fetch(&state));
    assert!(a.is_err() && b.is_err());
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.abort();
}
#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn orphaned_risk_recovery_and_stale_result_fencing() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test"));
    let pool = connect(&url).await.unwrap();
    initialize(
        &pool,
        "test-admin",
        Some(&std::env::var("TEST_ADMIN_PASSWORD").unwrap()),
    )
    .await
    .unwrap();
    let state = AppState::new(pool.clone()).unwrap();
    let p = ensure_period(&state, chrono::NaiveDate::from_ymd_opt(2042, 1, 1).unwrap())
        .await
        .unwrap();
    sqlx::query("UPDATE periods SET risk_status='computing',risk_task_id='orphan',risk_version=0 WHERE id=?").bind(&p.id).execute(&pool).await.unwrap();
    recover_risk_tasks(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT risk_status FROM periods WHERE id=?")
            .bind(&p.id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "failed"
    );
    sqlx::query("UPDATE periods SET risk_status='computing',risk_task_id='new-owner',bet_version=2 WHERE id=?").bind(&p.id).execute(&pool).await.unwrap();
    assert!(
        !persist_risk(
            &state,
            RiskWrite {
                period: &p.id,
                version: 1,
                task_id: "orphan",
                status: "complete",
                data: None,
                error: None
            }
        )
        .await
    );
    recover(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT risk_status FROM periods WHERE id=?")
            .bind(&p.id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "queued"
    );
    pool.close().await;
}
