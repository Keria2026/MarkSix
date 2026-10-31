use super::*;

#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn bounded_pools_pin_live_leases_evict_idle_entries_and_reap_deleted_tenants() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test"));
    let connection = reqwest::Url::parse(&url).unwrap();
    let pool = crate::store::connect(&url).await.unwrap();
    crate::store::initialize(
        &pool,
        "test-admin",
        Some(&std::env::var("TEST_ADMIN_PASSWORD").unwrap()),
    )
    .await
    .unwrap();
    let control = Control::new(pool.clone(), None, false, std::path::PathBuf::new())
        .await
        .unwrap();
    let registry = Registry::new(control).unwrap();
    let mut accounts = vec![];
    let mut leases = vec![];
    for i in 0..13 {
        accounts.push(Account {
            id: format!("synthetic-{i}"),
            username: "synthetic".into(),
            password_hash: "synthetic-hash".into(),
            credential_version: 1,
            permanent: true,
            authorized_through: None,
            disabled: false,
            state: "ready".into(),
            database_name: "marksix_test".into(),
            database_user: connection.username().into(),
            database_password: connection.password().unwrap().into(),
        });
    }
    for a in &accounts[..12] {
        leases.push(registry.lease(a).await.unwrap());
    }
    assert_eq!(registry.states.lock().await.len(), 12);
    let failure = registry.lease(&accounts[12]).await.err().unwrap();
    assert_eq!(failure.0, axum::http::StatusCode::SERVICE_UNAVAILABLE);
    let warm = registry.lease(&accounts[0]).await.unwrap();
    assert_eq!(warm.users.load(Ordering::Acquire), 2);
    drop(warm);
    drop(leases);
    let newest = registry.lease(&accounts[12]).await.unwrap();
    assert_eq!(registry.states.lock().await.len(), 12);
    assert!(!registry.states.lock().await.contains_key(&accounts[1].id));
    registry
        .synchronize_admin(&accounts[12], &newest)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT username FROM administrators WHERE id=1")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "synthetic"
    );
    assert!(!registry.states.lock().await[&accounts[12].id].evictable());
    drop(newest);
    registry.sweep().await.unwrap();
    assert!(
        registry
            .states
            .lock()
            .await
            .keys()
            .all(|id| !id.starts_with("synthetic-")),
        "deleted synthetic tenants must be reaped even when other ready tenants exist"
    );
    pool.close().await;
}
