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

#[tokio::test]
async fn fetch_validates_json_and_response_size_with_and_without_cache() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route(
            "/valid",
            axum::routing::get(|| async { axum::Json(json!([{"synthetic":true}])) }),
        )
        .route("/invalid", axum::routing::get(|| async { "not json" }))
        .route(
            "/large",
            axum::routing::get(|| async { "x".repeat(1_048_577) }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .connect_lazy("mysql://unused:unused@127.0.0.1/unused")
        .unwrap();
    let mut state = AppState::new(pool).unwrap();
    state.client = reqwest::Client::builder().no_proxy().build().unwrap();
    for cache in [false, true] {
        state.draw_cache = cache.then(Arc::default);
        state.draw_url = format!("http://{address}/valid");
        assert_eq!(
            fetch(&state).await.unwrap(),
            vec![json!({"synthetic":true})]
        );
        assert_eq!(fetch(&state).await.unwrap().len(), 1);
    }
    state.draw_cache = None;
    for (path, message) in [("invalid", "expected"), ("large", "1 MB")] {
        state.draw_url = format!("http://{address}/{path}");
        assert!(
            fetch(&state)
                .await
                .unwrap_err()
                .to_string()
                .contains(message)
        );
    }
    server.abort();
}

#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn worker_tick_settles_stops_old_fetches_and_finishes_risk() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test"));
    let pool = connect(&url).await.unwrap();
    for table in [
        "audit_events",
        "bet_mutations",
        "layoffs",
        "bets",
        "bet_slips",
        "periods",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    initialize(
        &pool,
        "test-admin",
        Some(&std::env::var("TEST_ADMIN_PASSWORD").unwrap()),
    )
    .await
    .unwrap();
    let mut state = AppState::new(pool.clone()).unwrap();
    state.clock = Arc::new(|| {
        chrono::NaiveDate::from_ymd_opt(2040, 1, 3)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    });
    let old = ensure_period(&state, chrono::NaiveDate::from_ymd_opt(2040, 1, 1).unwrap())
        .await
        .unwrap();
    let pending = ensure_period(&state, chrono::NaiveDate::from_ymd_opt(2040, 1, 2).unwrap())
        .await
        .unwrap();
    process_response(&state, &pending, &[]).await.unwrap();
    process_response(&state, &pending, &[json!({"invalid":true})])
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let response = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let served = response.clone();
    let app = axum::Router::new().route(
        "/draw",
        axum::routing::get(move || {
            let served = served.clone();
            async move { axum::Json(served.lock().unwrap().clone()) }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    state.client = reqwest::Client::builder().no_proxy().build().unwrap();
    state.draw_url = format!("http://{address}/draw");
    tick(&state).await.unwrap();
    let status: String = sqlx::query_scalar("SELECT state FROM periods WHERE id=?")
        .bind(&old.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "missing");
    for _ in 0..100 {
        if state.cancellations.lock().await.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(state.cancellations.lock().await.is_empty());
    let risk: String = sqlx::query_scalar("SELECT risk_status FROM periods WHERE id=?")
        .bind(&old.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(risk, "computing");
    let raw = json!({"expect":"2040002","openTime":"2040-01-02 21:34:00","openCode":"1,2,3,4,5,6,7","zodiac":"鼠,牛,虎,兔,龙,蛇,马","wave":"red,red,blue,blue,green,green,red"});
    *response.lock().unwrap() = vec![raw.clone()];
    sqlx::query("UPDATE periods SET last_fetch_at=NULL WHERE id=?")
        .bind(&pending.id)
        .execute(&pool)
        .await
        .unwrap();
    tick(&state).await.unwrap();
    let settled: String = sqlx::query_scalar("SELECT state FROM periods WHERE id=?")
        .bind(&pending.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(settled, "settled");
    let mut conflicting = parse_draw(&raw).unwrap();
    conflicting.numbers[6] = 8;
    accept_draw(&state, &conflicting, &raw).await.unwrap();
    let saved: Json<Draw> = sqlx::query_scalar("SELECT draw FROM periods WHERE id=?")
        .bind(&pending.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(saved.numbers[6], 7);
    conflicting.open_time = state.now();
    assert!(accept_draw(&state, &conflicting, &raw).await.is_err());
    conflicting.expect = "unknown".into();
    accept_draw(&state, &conflicting, &raw).await.unwrap();
    settle_period(&state, "unknown").await.unwrap();
    settle_period(&state, &old.id).await.unwrap();
    server.abort();
    for _ in 0..100 {
        if state.cancellations.lock().await.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    pool.close().await;
}
