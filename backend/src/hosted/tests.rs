//! Real HTTP routers and separate least-privilege tenant databases. Never production.
use super::{accounts::*, management, portal, tenancy::Registry};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
) -> (StatusCode, Value, String) {
    let response = app
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
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|s| s.to_str().unwrap().split(';').next().unwrap().to_owned())
        .unwrap_or_default();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(json!({})),
        cookie,
    )
}
async fn ok(app: &Router, method: &str, path: &str, body: Value, cookie: &str) -> Value {
    let (status, value, _) = request(app, method, path, body, cookie).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
    value
}
async fn code(app: &Router, owner: &str, id: &str, days: i32) -> String {
    ok(
        app,
        "POST",
        &format!("/api/accounts/{id}/codes"),
        json!({"days":days,"redeem_through":today().succ_opt().unwrap()}),
        owner,
    )
    .await["code"]
        .as_str()
        .unwrap()
        .to_owned()
}
async fn login(app: &Router, name: &str, password: &str) -> String {
    let (status, body, cookie) = request(
        app,
        "POST",
        "/api/login",
        json!({"username":name,"password":password}),
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    cookie
}

#[tokio::test]
#[ignore = "requires disposable marksix_test and TEST_PROVISION_DATABASE_URL; see docs/getting-started/development.md"]
async fn hosted_isolation_activation_sessions_expiry_and_permanent_deletion() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test"));
    let pool = crate::store::connect(&url).await.unwrap();
    let provision = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&std::env::var("TEST_PROVISION_DATABASE_URL").unwrap())
        .await
        .unwrap();
    // Reap only tenant principals listed by this disposable test control DB.
    // This also makes a retry after a failed assertion leave no orphan schemas.
    for account in sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts")
        .fetch_all(&pool)
        .await
        .unwrap()
    {
        management::identifiers(&account).unwrap();
        sqlx::query(&format!(
            "DROP DATABASE IF EXISTS `{}`",
            account.database_name
        ))
        .execute(&provision)
        .await
        .unwrap();
        sqlx::query(&format!(
            "DROP USER IF EXISTS '{}'@'%'",
            account.database_user
        ))
        .execute(&provision)
        .await
        .unwrap();
    }
    for table in [
        "hosted_sessions",
        "hosted_codes",
        "hosted_accounts",
        "authority_sessions",
        "authority_administrators",
        "authority_audit",
        "hosted_deletions",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let root = std::env::temp_dir().join(format!("marksix-hosted-test-{}", uuid::Uuid::new_v4()));
    let c = Control::new(pool.clone(), Some(provision), false, root.clone())
        .await
        .unwrap();
    let password = uuid::Uuid::new_v4().to_string();
    let owner_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO authority_administrators(id,username,password_hash) VALUES(?,'owner',?)",
    )
    .bind(&owner_id)
    .bind(hash_password(password.clone()).await.unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let management = management::router(c.clone());
    let owner = login(&management, "owner", &password).await;
    let a = ok(
        &management,
        "POST",
        "/api/accounts",
        json!({"username":"客户甲","password":password}),
        &owner,
    )
    .await;
    let b = ok(
        &management,
        "POST",
        "/api/accounts",
        json!({"username":"客户乙","password":password}),
        &owner,
    )
    .await;
    let aid = a["id"].as_str().unwrap();
    let bid = b["id"].as_str().unwrap();
    assert!(a.get("password_hash").is_none() && a.get("database_password").is_none());
    let date = today();
    let clock = Arc::new(std::sync::RwLock::new(date.and_hms_opt(12, 0, 0).unwrap()));
    let clock_reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut registry = Registry::new(c.clone()).unwrap();
    let read_clock = clock.clone();
    let read_count = clock_reads.clone();
    registry.clock = Arc::new(move || {
        read_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *read_clock.read().unwrap()
    });
    let app = portal::router(registry.clone());
    let ca = login(&app, "客户甲", &password).await;
    let cb = login(&app, "客户乙", &password).await;
    assert_eq!(
        request(&app, "GET", "/api/bootstrap", json!({}), &ca)
            .await
            .0,
        StatusCode::PAYMENT_REQUIRED
    );
    let first_code = code(&management, &owner, aid, 1).await;
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/license/activate",
            json!({"code":first_code,"request_id":uuid::Uuid::new_v4()}),
            &cb
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let first_id = uuid::Uuid::new_v4();
    let second_id = uuid::Uuid::new_v4();
    let body1 = json!({"code":first_code,"request_id":first_id});
    let body2 = json!({"code":first_code,"request_id":second_id});
    let (r1, r2) = tokio::join!(
        request(&app, "POST", "/api/license/activate", body1.clone(), &ca),
        request(&app, "POST", "/api/license/activate", body2.clone(), &ca)
    );
    assert_eq!(
        [r1.0, r2.0]
            .iter()
            .filter(|s| **s == StatusCode::OK)
            .count(),
        1
    );
    let winning = if r1.0 == StatusCode::OK { body1 } else { body2 };
    ok(&app, "POST", "/api/license/activate", winning, &ca).await;
    let status = ok(&app, "GET", "/api/license", json!({}), &ca).await;
    assert_eq!(status["authorized_through"], today().to_string());
    assert_eq!(status["active"], true);
    let second_code = code(&management, &owner, aid, 30).await;
    ok(
        &app,
        "POST",
        "/api/license/activate",
        json!({"code":second_code,"request_id":uuid::Uuid::new_v4()}),
        &ca,
    )
    .await;
    let status = ok(&app, "GET", "/api/license", json!({}), &ca).await;
    assert_eq!(
        status["authorized_through"],
        today()
            .checked_add_days(chrono::Days::new(30))
            .unwrap()
            .to_string()
    );
    let aa = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=?")
        .bind(aid)
        .fetch_one(&pool)
        .await
        .unwrap();
    let bb = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=?")
        .bind(bid)
        .fetch_one(&pool)
        .await
        .unwrap();
    let sa = registry.state(&aa).await.unwrap();
    let sb = registry.state(&bb).await.unwrap();
    let pa: (i64, i64) = sqlx::query_as("SELECT id,version FROM plays WHERE enabled=TRUE LIMIT 1")
        .fetch_one(&sa.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO text_entry_preferences(alias,play_id,play_version,amount_mode) VALUES('隔离测试',?,?,'each')").bind(pa.0).bind(pa.1).execute(&sa.pool).await.unwrap();
    // A confirmed alias in account A must never appear in account B's database.
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM text_entry_preferences")
            .fetch_one(&sb.pool)
            .await
            .unwrap(),
        0
    );
    // A cold tenant blocked in SQL must not hold the warm-cache map lock.
    let isolated = Registry::new(c.clone()).unwrap();
    let _warm = isolated.lease(&aa).await.unwrap();
    let mut blocker = sb.pool.acquire().await.unwrap();
    sqlx::raw_sql("LOCK TABLES periods READ")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let cold_registry = isolated.clone();
    let cold_account = bb.clone();
    let cold = tokio::spawn(async move { cold_registry.lease(&cold_account).await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let warm = tokio::time::timeout(std::time::Duration::from_secs(1), isolated.lease(&aa)).await;
    sqlx::raw_sql("UNLOCK TABLES")
        .execute(&mut *blocker)
        .await
        .unwrap();
    drop(blocker);
    drop(cold.await.unwrap().unwrap());
    assert!(
        warm.is_ok(),
        "cold database wait blocked an already warm tenant"
    );
    drop(warm);

    assert!(
        sqlx::query(&format!(
            "SELECT username FROM `{}`.administrators",
            bb.database_name
        ))
        .fetch_one(&sa.pool)
        .await
        .is_err(),
        "tenant A MySQL principal must not access tenant B"
    );
    // Many distinct contexts must not multiply warm pools without bound. A
    // request pins its context; a saturated cache rejects instead of closing it.
    let bounded = Registry::new(c.clone()).unwrap();
    let mut pinned = Vec::new();
    for _ in 0..12 {
        let mut fake = aa.clone();
        fake.id = uuid::Uuid::new_v4().to_string();
        pinned.push(bounded.lease(&fake).await.unwrap());
    }
    let mut extra = aa.clone();
    extra.id = uuid::Uuid::new_v4().to_string();
    assert!(bounded.lease(&extra).await.is_err());
    pinned.pop();
    let replacement = bounded.lease(&extra).await.unwrap();
    assert_eq!(bounded.cached().await, 12);
    drop(replacement);
    drop(pinned);
    for _ in 0..30 {
        let mut fake = aa.clone();
        fake.id = uuid::Uuid::new_v4().to_string();
        drop(bounded.lease(&fake).await.unwrap());
    }
    assert_eq!(bounded.cached().await, 12);
    drop(bounded);

    let boot = ok(&app, "GET", "/api/bootstrap", json!({}), &ca).await;
    let period = boot["today"]["id"].as_str().unwrap();
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["kind"] == "number" && p["rule"]["quantity"] == 1)
        .unwrap();
    let bet=ok(&app,"POST","/api/bets",json!({"period":period,"play_id":play["id"],"play_version":play["version"],"selections":[6],"compound":false,"bettor":"账本隔离验收","amount":"100","request_id":uuid::Uuid::new_v4()}),&ca).await;
    let bet_id = bet["id"].as_str().unwrap();
    // Erasure can only address the authenticated customer's old periods.
    let yesterday = date.pred_opt().unwrap();
    let old = crate::store::ensure_period(&sa, yesterday).await.unwrap();
    crate::store::ensure_period(&sb, yesterday).await.unwrap();
    let old_bet = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO bets(id,request_id,request_hash,period_id,play_id,play_version,rule,selections,compound,amount,unit_count,stake,rebate,exposure,natal,atoms,bettor) SELECT ?,?,?,?,play_id,play_version,rule,selections,compound,amount,unit_count,stake,rebate,exposure,natal,atoms,bettor FROM bets WHERE id=?")
        .bind(&old_bet).bind(uuid::Uuid::new_v4().to_string()).bind("e".repeat(64)).bind(&old.id).bind(bet_id).execute(&sa.pool).await.unwrap();
    let historical_slip = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO bet_slips(id,request_id,request_hash,period_id,bettor) VALUES(?,?,?,?,?)",
    )
    .bind(&historical_slip)
    .bind(uuid::Uuid::new_v4().to_string())
    .bind("a".repeat(64))
    .bind(&old.id)
    .bind("历史客户")
    .execute(&sa.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE bets SET slip_id=?,slip_position=0 WHERE id=?")
        .bind(&historical_slip)
        .bind(&old_bet)
        .execute(&sa.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO layoffs(id,bet_id,period_id,receiver,amount,unit_count,stake,rebate,exposure,atoms) SELECT ?,id,period_id,'历史受注者',amount,unit_count,stake,rebate,exposure,atoms FROM bets WHERE id=?")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&old_bet).execute(&sa.pool).await.unwrap();
    sqlx::query("INSERT INTO bet_mutations(request_id,bet_id,request_hash,response) VALUES(?,?,?,JSON_OBJECT())")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&old_bet).bind("e".repeat(64)).execute(&sa.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO audit_events(period_id,event,detail) VALUES(?,'bet_created',JSON_OBJECT())",
    )
    .bind(&old.id)
    .execute(&sa.pool)
    .await
    .unwrap();
    for (account, value) in [(aid, "old-history"), (bid, "other-customer")] {
        let folder = root.join("tenants").join(account);
        tokio::fs::create_dir_all(&folder).await.unwrap();
        tokio::fs::write(folder.join("history.sql.gz"), value)
            .await
            .unwrap();
    }
    let clear = json!({"password":password,"confirmation":"永久清空历史记录","request_id":uuid::Uuid::new_v4()});
    assert_eq!(
        request(
            &management,
            "POST",
            "/api/customer/history/clear",
            clear.clone(),
            &owner
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(request(&management,"POST","/api/customer/history/clear",json!({"account_id":bid,"password":password,"confirmation":"永久清空历史记录","request_id":uuid::Uuid::new_v4()}),&ca).await.0,StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(request(&management,"POST","/api/customer/history/clear",json!({"password":"wrong","confirmation":"永久清空历史记录","request_id":uuid::Uuid::new_v4()}),&ca).await.0,StatusCode::FORBIDDEN);
    assert!(root.join("tenants").join(aid).exists());
    assert_eq!(
        request(
            &management,
            "POST",
            "/api/customer/history/clear",
            json!({"password":password,"confirmation":"wrong","request_id":uuid::Uuid::new_v4()}),
            &ca
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    ok(
        &management,
        "POST",
        "/api/customer/history/clear",
        clear.clone(),
        &ca,
    )
    .await;
    ok(
        &management,
        "POST",
        "/api/customer/history/clear",
        clear,
        &ca,
    )
    .await;
    for table in ["layoffs", "bet_mutations"] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&sa.pool)
                .await
                .unwrap(),
            0
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM audit_events WHERE period_id=?")
            .bind(&old.id)
            .fetch_one(&sa.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM periods WHERE id=?")
            .bind(&old.id)
            .fetch_one(&sa.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets WHERE id=?")
            .bind(bet_id)
            .fetch_one(&sa.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM periods WHERE id=?")
            .bind(&old.id)
            .fetch_one(&sb.pool)
            .await
            .unwrap(),
        1
    );
    assert!(!root.join("tenants").join(aid).exists());
    assert!(
        root.join("tenants")
            .join(bid)
            .join("history.sql.gz")
            .exists()
    );
    assert_eq!(std::fs::read_dir(root.join("erasures")).unwrap().count(), 1);
    // The current account/session/rules/authorization survive erasure.
    ok(&app, "GET", "/api/bootstrap", json!({}), &ca).await;
    // Multi-choice filters and amount sorting include only this period/tenant.
    for (name, amount) in [("筛选甲", "30"), ("筛选乙", "10"), ("筛选甲", "20")] {
        ok(&app,"POST","/api/bets",json!({"period":period,"play_id":play["id"],"play_version":play["version"],"selections":[8],"compound":false,"bettor":name,"amount":amount,"request_id":uuid::Uuid::new_v4()}),&ca).await;
    }
    let choices = ok(
        &app,
        "GET",
        &format!("/api/periods/{period}/bet-filters"),
        json!({}),
        &ca,
    )
    .await;
    assert_eq!(choices["bettors"].as_array().unwrap().len(), 3);
    for (order, amounts) in [
        ("amount_asc", vec![1000, 2000, 3000]),
        ("amount_desc", vec![3000, 2000, 1000]),
    ] {
        let records = ok(
            &app, "POST", "/api/bets/search",
            json!({"period":period,"bettors":["筛选甲", "筛选乙"],"play_ids":[play["id"]],"order":order}), &ca,
        )
        .await;
        assert_eq!(records["total"], 3);
        assert_eq!(
            records["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["stake"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            amounts
        );
    }
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/bets/search",
            json!({"order":"stake DESC;DROP TABLE bets"}),
            &ca
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut large_filter: Vec<String> = (0..500)
        .map(|i| format!("{}-{i}", "长名称".repeat(20)))
        .collect();
    large_filter.extend(["筛选甲".into(), "筛选乙".into()]);
    let filter = json!({"period":period,"bettors":large_filter,"order":"amount_asc"});
    assert!(filter.to_string().len() > 8000);
    let records = ok(&app, "POST", "/api/bets/search", filter, &ca).await;
    assert_eq!(records["total"], 3);
    assert_eq!(
        request(&app, "GET", "/api/bets", json!({}), &ca).await.0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/bets/search",
            json!({"bettor":"ignored alias"}),
            &ca
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // Arrival time must be captured before waiting for the shared work gate.
    *clock.write().unwrap() = date.succ_opt().unwrap().and_hms_opt(5, 59, 59).unwrap();
    let blocked = registry.work_gate.acquire_many(8).await.unwrap();
    let reads = clock_reads.load(std::sync::atomic::Ordering::SeqCst);
    let queued_app = app.clone();
    let queued_cookie = ca.clone();
    let queued_payload = json!({"period":period,"play_id":play["id"],"play_version":play["version"],"selections":[7],"compound":false,"bettor":"切期前到达的排队投注","amount":"100","request_id":uuid::Uuid::new_v4()});
    let queued = tokio::spawn(async move {
        request(
            &queued_app,
            "POST",
            "/api/bets",
            queued_payload,
            &queued_cookie,
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while clock_reads.load(std::sync::atomic::Ordering::SeqCst) == reads {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    *clock.write().unwrap() = date.succ_opt().unwrap().and_hms_opt(6, 0, 1).unwrap();
    drop(blocked);
    let queued = queued.await.unwrap();
    assert_eq!(
        queued.0,
        StatusCode::OK,
        "queue must not move receipt past the 06:00 period boundary: {}",
        queued.1
    );
    *clock.write().unwrap() = date.and_hms_opt(12, 0, 0).unwrap();

    let other_code = code(&management, &owner, bid, 1).await;
    ok(
        &app,
        "POST",
        "/api/license/activate",
        json!({"code":other_code,"request_id":uuid::Uuid::new_v4()}),
        &cb,
    )
    .await;
    assert_eq!(
        request(&app, "GET", &format!("/api/bets/{bet_id}"), json!({}), &cb)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bets")
        .fetch_one(&sb.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    // Login replaces the one central session; the old cookie cannot read even status.
    let new_ca = login(&app, "客户甲", &password).await;
    assert_eq!(
        request(&app, "GET", "/api/license", json!({}), &ca).await.0,
        StatusCode::UNAUTHORIZED
    );
    ok(&app, "GET", "/api/bootstrap", json!({}), &new_ca).await;
    // Expiry blocks new requests, while prior accepted bets can settle after expiry.
    sqlx::query("UPDATE hosted_accounts SET authorized_through=? WHERE id=?")
        .bind(today().pred_opt())
        .bind(aid)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, "GET", "/api/bootstrap", json!({}), &new_ca)
            .await
            .0,
        StatusCode::PAYMENT_REQUIRED
    );
    let mut draw =
        crate::domain::Draw::predicted([1, 2, 3, 4, 5, 7, 6], &crate::domain::Mapping::default());
    draw.expect = period.to_owned();
    draw.open_time = date.and_hms_opt(21, 34, 0).unwrap();
    crate::worker::accept_draw(&sa, &draw, &json!({"fixture":"hosted-expired-settlement"}))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM bets WHERE id=?")
            .bind(bet_id)
            .fetch_one(&sa.pool)
            .await
            .unwrap(),
        "settled"
    );
    // A fixed account/credential-bound unused code is invalid after reset; paid time stays.
    let unused = code(&management, &owner, aid, 10).await;
    let mut new_password = uuid::Uuid::new_v4().to_string();
    ok(
        &management,
        "PUT",
        &format!("/api/accounts/{aid}"),
        json!({"action":"password","password":new_password}),
        &owner,
    )
    .await;
    assert_eq!(
        request(&app, "GET", "/api/license", json!({}), &new_ca)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let reset_ca = login(&app, "客户甲", &new_password).await;
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/license/activate",
            json!({"code":unused,"request_id":uuid::Uuid::new_v4()}),
            &reset_ca
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let unused_self = code(&management, &owner, aid, 3).await;
    // Permanent accounts bypass expiry, never normal financial rules or disabling.
    ok(
        &management,
        "PUT",
        &format!("/api/accounts/{aid}"),
        json!({"action":"permanent","enabled":true}),
        &owner,
    )
    .await;
    let mut permanent_ca = login(&app, "客户甲", &new_password).await;
    assert_eq!(
        ok(&app, "GET", "/api/license", json!({}), &permanent_ca).await["permanent"],
        true
    );
    ok(&app, "GET", "/api/bootstrap", json!({}), &permanent_ca).await;
    // Self-service password changes use a fresh authority process attempt window.
    // The production limiter stays enabled; no credential is accepted on caller identity alone.
    let fresh = Control::new(pool.clone(), None, false, root.clone())
        .await
        .unwrap();
    let self_authority = management::router(fresh.clone());
    let self_portal = portal::router(Registry::new(fresh).unwrap());
    let old_grant: Option<chrono::NaiveDate> =
        sqlx::query_scalar("SELECT authorized_through FROM hosted_accounts WHERE id=?")
            .bind(aid)
            .fetch_one(&pool)
            .await
            .unwrap();

    let previous_password = new_password.clone();
    let self_password = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        request(
            &self_authority,
            "POST",
            "/api/customer/password",
            json!({"old_password":"wrong","new_password":self_password}),
            &permanent_ca
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    ok(&app, "GET", "/api/session", json!({}), &permanent_ca).await;
    assert_eq!(
        request(
            &self_authority,
            "POST",
            "/api/customer/password",
            json!({"old_password":new_password,"new_password":self_password,"account_id":bid}),
            &permanent_ca
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    ok(
        &self_authority,
        "POST",
        "/api/customer/password",
        json!({"old_password":new_password,"new_password":self_password}),
        &permanent_ca,
    )
    .await;
    assert_eq!(
        request(&app, "GET", "/api/session", json!({}), &permanent_ca)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &self_portal,
            "POST",
            "/api/login",
            json!({"username":"客户甲","password":new_password}),
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    new_password = self_password;
    permanent_ca = login(&self_portal, "客户甲", &new_password).await;
    assert_eq!(
        ok(
            &self_portal,
            "GET",
            "/api/license",
            json!({}),
            &permanent_ca
        )
        .await["permanent"],
        true
    );
    let grant: Option<chrono::NaiveDate> =
        sqlx::query_scalar("SELECT authorized_through FROM hosted_accounts WHERE id=?")
            .bind(aid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(grant, old_grant);
    assert_eq!(
        request(
            &self_portal,
            "POST",
            "/api/license/activate",
            json!({"code":unused_self,"request_id":uuid::Uuid::new_v4()}),
            &permanent_ca
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    ok(&app, "GET", "/api/session", json!({}), &cb).await;
    ok(
        &management,
        "PUT",
        &format!("/api/accounts/{aid}"),
        json!({"action":"disable"}),
        &owner,
    )
    .await;
    assert_eq!(
        request(&app, "GET", "/api/bootstrap", json!({}), &permanent_ca)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // Delete requires exact confirmation, removes tenant and control backups, and
    // preserves other customers' separate ledger backups.
    let case = ok(
        &management,
        "POST",
        "/api/accounts",
        json!({"username":"TenantCase","password":password,"permanent":true}),
        &owner,
    )
    .await;
    let case_id = case["id"].as_str().unwrap();
    let old_case = login(&app, "TenantCase", &password).await;
    ok(
        &management,
        "PUT",
        &format!("/api/accounts/{case_id}"),
        json!({"action":"rename","username":"tenantcase"}),
        &owner,
    )
    .await;
    assert_eq!(
        request(&app, "GET", "/api/session", json!({}), &old_case)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let _case_cookie = login(&app, "tenantcase", &password).await;
    let case_account = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=?")
        .bind(case_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let case_state = registry.state(&case_account).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT username FROM administrators WHERE id=1")
            .fetch_one(&case_state.pool)
            .await
            .unwrap(),
        "tenantcase"
    );
    let initializing = c.gate.acquire().await.unwrap();
    assert_eq!(
        request(
            &management,
            "PUT",
            &format!("/api/accounts/{case_id}"),
            json!({"action":"delete","confirmation":"永久删除 tenantcase"}),
            &owner
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(initializing);
    ok(
        &management,
        "PUT",
        &format!("/api/accounts/{case_id}"),
        json!({"action":"delete","confirmation":"永久删除 tenantcase"}),
        &owner,
    )
    .await;
    case_state.pool.close().await;
    tokio::fs::create_dir_all(root.join("tenants").join(aid))
        .await
        .unwrap();
    tokio::fs::create_dir_all(root.join("tenants").join(bid))
        .await
        .unwrap();
    tokio::fs::create_dir_all(root.join("control"))
        .await
        .unwrap();
    tokio::fs::write(root.join("tenants").join(aid).join("backup.sql"), b"a")
        .await
        .unwrap();
    tokio::fs::write(root.join("control").join("backup.sql"), b"accounts")
        .await
        .unwrap();
    assert_eq!(
        request(
            &management,
            "PUT",
            &format!("/api/accounts/{aid}"),
            json!({"action":"delete","confirmation":"wrong"}),
            &owner
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for (id, name) in [(aid, "客户甲"), (bid, "客户乙")] {
        ok(
            &management,
            "PUT",
            &format!("/api/accounts/{id}"),
            json!({"action":"delete","confirmation":format!("永久删除 {name}")}),
            &owner,
        )
        .await;
        assert!(!root.join("tenants").join(id).exists());
        if id == aid {
            assert!(root.join("tenants").join(bid).exists());
        }
    }
    assert!(!root.join("control").exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM hosted_accounts")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM hosted_codes")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM hosted_sessions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM hosted_deletions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        3
    );
    let names = sqlx::query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN (?,?)",
    )
    .bind(&aa.database_name)
    .bind(&bb.database_name)
    .fetch_all(c.provision.as_ref().unwrap())
    .await
    .unwrap();
    assert!(names.is_empty());
    sa.pool.close().await;
    sb.pool.close().await;
    tokio::fs::remove_dir_all(&root).await.unwrap();
    // No credentials, raw codes, passwords or deleted customer identifiers in audit.
    let audit = ok(&management, "GET", "/api/audit", json!({}), &owner)
        .await
        .to_string();
    for secret in [
        &password,
        &new_password,
        &previous_password,
        &unused,
        &first_code,
        aid,
        bid,
        "客户甲",
        "客户乙",
    ] {
        assert!(!audit.contains(secret));
    }
}
