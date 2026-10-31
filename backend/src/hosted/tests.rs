use super::{accounts::*, management, portal, tenancy::Registry};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
) -> (StatusCode, Value, String) {
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("x-marksix", "1")
                .header("cookie", cookie)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let s = r.status();
    let c = r
        .headers()
        .get("set-cookie")
        .map(|h| h.to_str().unwrap().split(';').next().unwrap().to_owned())
        .unwrap_or_default();
    (
        s,
        serde_json::from_slice(&to_bytes(r.into_body(), 2_000_000).await.unwrap())
            .unwrap_or(Value::Null),
        c,
    )
}
async fn ok(app: &Router, method: &str, path: &str, body: Value, cookie: &str) -> Value {
    let (s, v, _) = call(app, method, path, body, cookie).await;
    assert_eq!(s, StatusCode::OK, "{method} {path}: {v}");
    v
}
async fn login(app: &Router, name: &str, password: &str) -> String {
    let (s, v, c) = call(
        app,
        "POST",
        "/api/login",
        json!({"username":name,"password":password}),
        "",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    c
}
#[tokio::test]
async fn busy_auth_and_unknown_accounts_do_not_bypass_limits() {
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .connect_lazy("mysql://unused:unused@127.0.0.1/unused")
        .unwrap();
    let c = Control::new(pool, None, true, std::path::PathBuf::new())
        .await
        .unwrap();
    let permit = c.gate.clone().acquire_owned().await.unwrap();
    for _ in 0..10 {
        assert_eq!(
            c.verify("sample", "unused".into(), None)
                .await
                .unwrap_err()
                .0,
            StatusCode::TOO_MANY_REQUESTS
        );
    }
    assert!(c.attempts.lock().await.is_empty());
    drop(permit);
    assert_eq!(
        c.verify("sample", "unused".into(), None)
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    let header = cookie(&c, "marksix_session", "sample", 60);
    assert!(
        header.contains("Secure") && header.contains("HttpOnly") && !header.contains("Domain=")
    );
}
#[tokio::test]
#[ignore = "requires isolated marksix_test and provision database identity"]
async fn hosted_tenant_and_credential_contract() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    let provision_url = std::env::var("TEST_PROVISION_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test") && provision_url.ends_with("/marksix_test"));
    let pool = crate::store::connect(&url).await.unwrap();
    let provision = sqlx::MySqlPool::connect(&provision_url).await.unwrap();
    // Reap only identities recorded in this isolated control database.
    for a in sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts")
        .fetch_all(&pool)
        .await
        .unwrap()
    {
        management::identifiers(&a).unwrap();
        sqlx::query(&format!("DROP DATABASE IF EXISTS `{}`", a.database_name))
            .execute(&provision)
            .await
            .unwrap();
        sqlx::query(&format!("DROP USER IF EXISTS '{}'@'%'", a.database_user))
            .execute(&provision)
            .await
            .unwrap();
    }
    for table in [
        "hosted_sessions",
        "hosted_codes",
        "authority_audit",
        "hosted_accounts",
        "authority_sessions",
        "authority_administrators",
        "hosted_deletions",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let root = std::env::temp_dir().join(format!("marksix-contract-{}", uuid::Uuid::new_v4()));
    let c = Control::new(pool.clone(), Some(provision.clone()), false, root.clone())
        .await
        .unwrap();
    let password = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO authority_administrators(id,username,password_hash) VALUES(?,'contract-owner',?)").bind(uuid::Uuid::new_v4().to_string()).bind(hash_password(password.clone()).await.unwrap()).execute(&pool).await.unwrap();
    let admin = management::router(c.clone());
    let owner = login(&admin, "contract-owner", &password).await;
    let mut customers = vec![];
    for name in ["contract-a", "contract-b"] {
        let a = ok(
            &admin,
            "POST",
            "/api/accounts",
            json!({"username":name,"password":password}),
            &owner,
        )
        .await;
        assert!(a.get("database_password").is_none());
        customers.push(a["id"].as_str().unwrap().to_owned());
    }
    let r = Registry::new(c.clone()).unwrap();
    let app = portal::router(r.clone());
    let ca = login(&app, "contract-a", &password).await;
    assert_eq!(
        call(&app, "GET", "/api/bootstrap", json!({}), &ca).await.0,
        StatusCode::PAYMENT_REQUIRED
    );
    let code = ok(
        &admin,
        "POST",
        &format!("/api/accounts/{}/codes", customers[0]),
        json!({"days":7,"redeem_through":today().succ_opt().unwrap()}),
        &owner,
    )
    .await;
    let redemption = json!({"code":code["code"],"request_id":uuid::Uuid::new_v4().to_string()});
    let first = ok(
        &app,
        "POST",
        "/api/license/activate",
        redemption.clone(),
        &ca,
    )
    .await;
    let repeat = ok(&app, "POST", "/api/license/activate", redemption, &ca).await;
    assert_eq!(first["authorized_through"], repeat["authorized_through"]);
    ok(
        &admin,
        "PUT",
        &format!("/api/accounts/{}", customers[1]),
        json!({"action":"permanent","enabled":true}),
        &owner,
    )
    .await;
    let cb = login(&app, "contract-b", &password).await;
    let boot = ok(&app, "GET", "/api/bootstrap", json!({}), &ca).await;
    let p = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let body = json!({"period":boot["today"]["id"],"bettor":"sample","request_id":uuid::Uuid::new_v4().to_string(),"items":[{"play_id":p["id"],"play_version":p["version"],"selections":[7],"compound":false,"amount":"100"}]});
    let slip = ok(&app, "POST", "/api/slips", body, &ca).await;
    let path = format!("/api/slips/{}", slip["id"].as_str().unwrap());
    assert_eq!(
        call(&app, "GET", &path, json!({}), &cb).await.0,
        StatusCode::NOT_FOUND
    );
    let accounts = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts ORDER BY username")
        .fetch_all(&pool)
        .await
        .unwrap();
    let lease = r.lease(&accounts[0]).await.unwrap();
    assert!(
        sqlx::query(&format!(
            "SELECT * FROM `{}`.bets",
            accounts[1].database_name
        ))
        .fetch_all(&lease.pool)
        .await
        .is_err()
    );
    drop(lease);
    // Historical erasure is password-confirmed, idempotent and leaves today's ledger intact.
    let lease = r.lease(&accounts[0]).await.unwrap();
    let old_date = today().pred_opt().unwrap();
    let old = crate::store::ensure_period(&lease, old_date).await.unwrap();
    sqlx::query("UPDATE bets SET period_id=?")
        .bind(&old.id)
        .execute(&lease.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE bet_slips SET period_id=?")
        .bind(&old.id)
        .execute(&lease.pool)
        .await
        .unwrap();
    let current_body = json!({"period":boot["today"]["id"],"bettor":"preserve-today","request_id":uuid::Uuid::new_v4().to_string(),"items":[{"play_id":p["id"],"play_version":p["version"],"selections":[8],"compound":false,"amount":"20"}]});
    ok(&app, "POST", "/api/slips", current_body, &ca).await;
    let backup = root.join("tenants").join(&accounts[0].id);
    std::fs::create_dir_all(&backup).unwrap();
    std::fs::write(backup.join("old.sql.gz"), b"synthetic").unwrap();
    let clear = json!({"password":password,"confirmation":"永久清空历史记录","request_id":uuid::Uuid::new_v4().to_string()});
    for (field, value, status) in [
        ("confirmation", "wrong", StatusCode::UNPROCESSABLE_ENTITY),
        ("request_id", "bad", StatusCode::UNPROCESSABLE_ENTITY),
        ("password", "incorrect", StatusCode::FORBIDDEN),
    ] {
        let mut invalid = clear.clone();
        invalid[field] = value.into();
        assert_eq!(
            call(&admin, "POST", "/api/customer/history/clear", invalid, &ca)
                .await
                .0,
            status
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets")
                .fetch_one(&lease.pool)
                .await
                .unwrap(),
            2
        );
    }
    for _ in 0..2 {
        ok(
            &admin,
            "POST",
            "/api/customer/history/clear",
            clear.clone(),
            &ca,
        )
        .await;
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets")
            .fetch_one(&lease.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM history_clear_requests")
            .fetch_one(&lease.pool)
            .await
            .unwrap(),
        1
    );
    assert!(!backup.exists());
    assert!(
        root.join("erasures")
            .join(format!("{}.json", accounts[0].id))
            .is_file()
    );
    // These erasure cases represent a later operator session; advance only the
    // test rate-limit window, without weakening production authentication.
    for (started, _) in c.attempts.lock().await.values_mut() {
        *started = std::time::Instant::now() - std::time::Duration::from_secs(61);
    }
    // A pending HK leg protects its mixed-slip parent and its Macau sibling.
    let mixed = json!({"period":boot["today"]["id"],"bettor":"synthetic-preserve-hk","request_id":uuid::Uuid::new_v4().to_string(),"items":[{"play_id":p["id"],"play_version":p["version"],"selections":[8],"compound":false,"amount":"20"},{"market":"hk","play_id":p["id"],"play_version":p["version"],"selections":[9],"compound":false,"amount":"30"}]});
    let mixed_receipt = ok(&app, "POST", "/api/slips", mixed, &ca).await;
    let mixed_id = mixed_receipt["id"].as_str().unwrap();
    let old = crate::store::ensure_period(&lease, old_date).await.unwrap();
    sqlx::query("UPDATE bets SET period_id=? WHERE slip_id=? AND market='macau'")
        .bind(&old.id)
        .bind(mixed_id)
        .execute(&lease.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE bet_slips SET period_id=? WHERE id=?")
        .bind(&old.id)
        .bind(mixed_id)
        .execute(&lease.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE periods SET business_date=? WHERE market='hk'")
        .bind(old_date)
        .execute(&lease.pool)
        .await
        .unwrap();
    let mut clear_again = clear.clone();
    clear_again["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    ok(
        &admin,
        "POST",
        "/api/customer/history/clear",
        clear_again.clone(),
        &ca,
    )
    .await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets WHERE slip_id=?")
            .bind(mixed_id)
            .fetch_one(&lease.pool)
            .await
            .unwrap(),
        2
    );
    // Once the HK period has an archived draw, both sides may be removed together.
    let archived_draw = crate::domain::Draw {
        expect: "2026116".into(),
        open_time: old_date.and_hms_opt(22, 0, 0).unwrap(),
        numbers: [1, 2, 3, 4, 5, 6, 7],
        zodiac: [0, 1, 2, 3, 4, 5, 6],
        waves: [0, 0, 1, 1, 2, 2, 0],
    };
    sqlx::query("UPDATE periods SET state='settled',draw=? WHERE market='hk'")
        .bind(sqlx::types::Json(archived_draw))
        .execute(&lease.pool)
        .await
        .unwrap();
    clear_again["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    ok(
        &admin,
        "POST",
        "/api/customer/history/clear",
        clear_again,
        &ca,
    )
    .await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets WHERE slip_id=?")
            .bind(mixed_id)
            .fetch_one(&lease.pool)
            .await
            .unwrap(),
        0
    );
    drop(lease);
    for route in [
        "/api/accounts",
        "/api/codes",
        "/api/administrators",
        "/api/audit",
    ] {
        let listed = ok(&admin, "GET", route, json!({}), &owner).await;
        assert!(!listed.to_string().contains("password_hash"));
        assert!(!listed["items"].as_array().unwrap().is_empty());
    }
    ok(
        &admin,
        "POST",
        "/api/administrators",
        json!({"username":"synthetic-second-owner","password":password}),
        &owner,
    )
    .await;
    let other_owner = login(&admin, "synthetic-second-owner", &password).await;
    ok(&admin, "GET", "/api/session", json!({}), &other_owner).await;
    ok(&admin, "POST", "/api/logout", json!({}), &other_owner).await;
    assert_eq!(
        call(&admin, "GET", "/api/session", json!({}), &other_owner)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let account_path = format!("/api/accounts/{}", customers[1]);
    for change in [
        json!({"action":"disable"}),
        json!({"action":"enable"}),
        json!({"action":"password","password":password}),
        json!({"action":"rename","username":"contract-renamed"}),
        json!({"action":"rename","username":"contract-b"}),
        json!({"action":"revoke"}),
        json!({"action":"permanent","enabled":false}),
    ] {
        ok(&admin, "PUT", &account_path, change, &owner).await;
    }
    let issued = ok(
        &admin,
        "POST",
        &format!("{account_path}/codes"),
        json!({"days":1,"redeem_through":today()}),
        &owner,
    )
    .await;
    let code_id: String = sqlx::query_scalar("SELECT id FROM hosted_codes WHERE token_hash=?")
        .bind(crate::api::digest(issued["code"].as_str().unwrap()))
        .fetch_one(&pool)
        .await
        .unwrap();
    let revoke_path = format!("/api/codes/{code_id}/revoke");
    ok(&admin, "POST", &revoke_path, json!({}), &owner).await;
    assert_eq!(
        call(&admin, "POST", &revoke_path, json!({}), &owner)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for app in [&admin, &app] {
        ok(app, "GET", "/api/health", json!({}), "").await;
    }
    let new_ca = login(&app, "contract-a", &password).await;
    assert_eq!(
        call(&app, "GET", "/api/session", json!({}), &ca).await.0,
        StatusCode::UNAUTHORIZED
    );
    let new_password = uuid::Uuid::new_v4().to_string();
    ok(
        &admin,
        "POST",
        "/api/customer/password",
        json!({"old_password":password,"new_password":new_password}),
        &new_ca,
    )
    .await;
    assert_eq!(
        call(&app, "GET", "/api/session", json!({}), &new_ca)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let renewed = login(&app, "contract-a", &new_password).await;
    sqlx::query("UPDATE hosted_accounts SET authorized_through=DATE_SUB(CURDATE(),INTERVAL 2 DAY),permanent=FALSE WHERE id=?").bind(&customers[0]).execute(&pool).await.unwrap();
    assert_eq!(
        call(&app, "GET", "/api/bootstrap", json!({}), &renewed)
            .await
            .0,
        StatusCode::PAYMENT_REQUIRED
    );
    for a in &accounts {
        ok(
            &admin,
            "PUT",
            &format!("/api/accounts/{}", a.id),
            json!({"action":"delete","confirmation":format!("永久删除 {}",a.username)}),
            &owner,
        )
        .await;
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name=?",
        )
        .bind(&a.database_name)
        .fetch_one(&provision)
        .await
        .unwrap();
        assert_eq!(exists, 0);
    }
    assert_eq!(
        call(&app, "GET", "/api/session", json!({}), &cb).await.0,
        StatusCode::UNAUTHORIZED
    );
    drop(r);
    drop(app);
    drop(admin);
    pool.close().await;
    provision.close().await;
    if root.exists() {
        std::fs::remove_dir_all(root).unwrap();
    }
}
