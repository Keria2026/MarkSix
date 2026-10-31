#[path = "../test_support/database.rs"]
mod database;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use marksix::{api, domain::*, market, store, worker};
use serde_json::{Value, json};
use std::sync::{Arc, RwLock};
use tower::ServiceExt;
async fn call(
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
        .map(|h| h.to_str().unwrap().split(';').next().unwrap().to_owned())
        .unwrap_or_default();
    let bytes = to_bytes(response.into_body(), 2_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cookie,
    )
}
async fn ok(app: &Router, method: &str, path: &str, body: Value, cookie: &str) -> Value {
    let (status, value, _) = call(app, method, path, body, cookie).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
    value
}
#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn daily_reports_keep_markets_together_without_moving_hk_bets_across_dates() {
    let pool = database::reset().await.unwrap();
    sqlx::query("UPDATE market_cursors SET expect='2026115',open_time='2026-10-27 21:32:32' WHERE market='hk'").execute(&pool).await.unwrap();
    let date = chrono::NaiveDate::from_ymd_opt(2026, 10, 31).unwrap();
    let time = Arc::new(RwLock::new(date.and_hms_opt(12, 0, 0).unwrap()));
    let clock = time.clone();
    let mut state = store::AppState::new(pool.clone()).unwrap();
    state.clock = Arc::new(move || *clock.read().unwrap());
    let app = api::router(state.clone());
    let (_, _, cookie) = call(
        &app,
        "POST",
        "/api/login",
        json!({"username":"test-admin","password":std::env::var("TEST_ADMIN_PASSWORD").unwrap()}),
        "",
    )
    .await;
    let boot = ok(&app, "GET", "/api/bootstrap", json!({}), &cookie).await;
    let day1 = boot["today"]["id"].as_str().unwrap();
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let macau = json!({"play_id":play["id"],"play_version":1,"selections":[7],"amount":"100","compound":false});
    let hk = json!({"market":"hk","play_id":play["id"],"play_version":1,"selections":[31],"amount":"200","compound":false});
    let mixed=ok(&app,"POST","/api/slips",json!({"period":day1,"bettor":"synthetic-day","request_id":uuid::Uuid::new_v4().to_string(),"items":[macau,hk]}),&cookie).await;
    let mixed_id = mixed["id"].as_str().unwrap();
    let hk_period = market::ensure_hk(&state).await.unwrap();
    let first = ok(
        &app,
        "GET",
        &format!("/api/days/{day1}"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(first["totals"]["stake"], 30000);
    assert_eq!(first["periods"].as_array().unwrap().len(), 2);
    let filters = ok(
        &app,
        "GET",
        &format!("/api/periods/{day1}/bet-filters?combined=true"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(filters["bettors"], json!(["synthetic-day"]));
    let found = ok(
        &app,
        "POST",
        "/api/records/search",
        json!({"period":day1,"combined":true,"min_amount":"300","max_amount":"300"}),
        &cookie,
    )
    .await;
    assert_eq!(found["total"], 1);
    assert_eq!(found["items"][0]["items"].as_array().unwrap().len(), 2);
    // UTC timestamps straddle Beijing 06:00. Standalone HK rows have no slip anchor.
    let next = date.succ_opt().unwrap();
    *time.write().unwrap() = next.and_hms_opt(5, 59, 59).unwrap();
    let mut before = hk.clone();
    before["period"] = json!(day1);
    before["bettor"] = json!("synthetic-day");
    before["amount"] = json!("25");
    before["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    let before = ok(&app, "POST", "/api/bets", before, &cookie).await;
    sqlx::query("UPDATE bets SET created_at='2026-10-31 21:59:59' WHERE id=?")
        .bind(before["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    *time.write().unwrap() = next.and_hms_opt(6, 0, 0).unwrap();
    let boot2 = ok(&app, "GET", "/api/bootstrap", json!({}), &cookie).await;
    let day2 = boot2["today"]["id"].as_str().unwrap();
    let mut after = hk.clone();
    after["period"] = json!(day2);
    after["bettor"] = json!("synthetic-day");
    after["amount"] = json!("75");
    after["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    let after = ok(&app, "POST", "/api/bets", after, &cookie).await;
    sqlx::query("UPDATE bets SET created_at='2026-10-31 22:00:00' WHERE id=?")
        .bind(after["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(market::ensure_hk(&state).await.unwrap().id, hk_period.id);
    // Recreate the pre-migration shape and verify backfill of both slip anchors
    // and standalone HK timestamps, without changing any financial row.
    sqlx::query("ALTER TABLE bets DROP INDEX ix_bets_entry_date, DROP COLUMN entry_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../migrations/0015_entry_business_date.sql"))
        .execute(&pool)
        .await
        .unwrap();
    for (day, stake, records) in [(day1, 32500, 3), (day2, 7500, 1)] {
        let summary = ok(&app, "GET", &format!("/api/days/{day}"), json!({}), &cookie).await;
        assert_eq!(summary["totals"]["stake"], stake);
        assert_eq!(summary["totals"]["records"], records);
        let stats = ok(
            &app,
            "GET",
            &format!("/api/periods/{day}/statistics?combined=true"),
            json!({}),
            &cookie,
        )
        .await;
        assert_eq!(stats["incoming"]["stake"], stake);
        assert_eq!(stats["bettors"][0]["totals"]["stake"], stake);
        assert!(stats["incoming"]["net"].is_null());
        let export = ok(
            &app,
            "GET",
            &format!("/api/periods/{day}/bettor-export?combined=true"),
            json!({}),
            &cookie,
        )
        .await;
        assert_eq!(
            export["bettors"][0]["bets"].as_array().unwrap().len(),
            records as usize
        );
        assert_eq!(export["bettors"][0]["totals"]["stake"], stake);
    }
    // Flying out on the second date still belongs to the original entry date.
    ok(
        &app,
        "PUT",
        "/api/settings/features",
        json!({"layoffs":true,"manual_entry":true,"text_entry":true}),
        &cookie,
    )
    .await;
    let fly = ok(&app, "POST", &format!("/api/bets/{}/layoffs",before["id"].as_str().unwrap()), json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":1,"amount":"25","receiver":"synthetic-receiver"}), &cookie).await;
    for (day, outgoing) in [(day1, 2500), (day2, 0)] {
        let stats = ok(
            &app,
            "GET",
            &format!("/api/periods/{day}/statistics?combined=true"),
            json!({}),
            &cookie,
        )
        .await;
        assert_eq!(stats["outgoing"]["stake"], outgoing);
        if outgoing > 0 {
            assert_eq!(stats["layoffs"][0]["market"], "hk");
            assert_eq!(stats["receivers"][0]["totals"]["stake"], outgoing);
            assert!(stats["receivers"][0]["totals"]["net"].is_null());
        }
    }
    // Macau settles first. Combined net stays unknown until HK has its own draw.
    *time.write().unwrap() = next.and_hms_opt(22, 0, 0).unwrap();
    let raw = json!({"expect":day1,"openTime":"2026-10-31 21:34:00","openCode":"1,2,3,4,5,6,7","zodiac":"鼠,牛,虎,兔,龙,蛇,马","wave":"red,red,blue,blue,green,green,red"});
    worker::accept_draw(&state, &parse_draw(&raw).unwrap(), &raw)
        .await
        .unwrap();
    let partial = ok(
        &app,
        "GET",
        &format!("/api/periods/{day1}/bettor-export?combined=true"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(partial["settled"], false);
    assert_eq!(partial["bettors"][0]["totals"]["payout"], 440000);
    assert!(partial["bettors"][0]["totals"]["net"].is_null());
    let hk_raw = json!({"expect":"2026116","openTime":"2026-11-01 21:45:00","openCode":"47,21,04,02,24,18,31","zodiac":"猴,狗,兔,蛇,羊,牛,鼠","wave":"blue,green,blue,red,red,red,blue"});
    worker::process_hk_response(&state, &hk_period, &[hk_raw])
        .await
        .unwrap();
    for (day, stake, payout, net) in [
        (day1, 32500, 1430000, -1400750),
        (day2, 7500, 330000, -323250),
    ] {
        let summary = ok(&app, "GET", &format!("/api/days/{day}"), json!({}), &cookie).await;
        assert_eq!(summary["totals"]["stake"], stake);
        assert_eq!(summary["totals"]["payout"], payout);
        assert_eq!(summary["totals"]["net"], net);
        assert_eq!(summary["state"], "settled");
        assert_eq!(
            summary["totals"]["flyout_stake"],
            if day == day1 { 2500 } else { 0 }
        );
        assert_eq!(
            summary["totals"]["retained_net"],
            net + if day == day1 { 107750 } else { 0 }
        );
        let stats = ok(
            &app,
            "GET",
            &format!("/api/periods/{day}/statistics?combined=true"),
            json!({}),
            &cookie,
        )
        .await;
        assert_eq!(stats["retained"]["net"], summary["totals"]["retained_net"]);
        let export = ok(
            &app,
            "GET",
            &format!("/api/periods/{day}/bettor-export?combined=true"),
            json!({}),
            &cookie,
        )
        .await;
        assert_eq!(export["settled"], true);
        assert_eq!(export["bettors"][0]["totals"]["net"], net);
        for entry in export["bettors"][0]["bets"].as_array().unwrap() {
            let r = &entry["record"];
            assert_eq!(
                r["expect"],
                if r["market"] == "hk" {
                    json!("2026116")
                } else {
                    json!(day1)
                }
            );
        }
    }
    let history = ok(
        &app,
        "GET",
        "/api/days?search=2026-10-31",
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(history["total"], 1);
    assert_eq!(history["items"][0]["id"], day1);
    let source_history = ok(&app, "GET", "/api/days?search=2026116", json!({}), &cookie).await;
    assert_eq!(source_history["total"], 2);
    let receipt = ok(
        &app,
        "GET",
        &format!("/api/slips/{mixed_id}"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(receipt["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        call(&app, "GET", "/api/days/missing", json!({}), &cookie)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/days/{}", hk_period.id),
            json!({}),
            &cookie
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    ok(
        &app,
        "POST",
        &format!("/api/layoffs/{}/cancel", fly["id"].as_str().unwrap()),
        json!({}),
        &cookie,
    )
    .await;
    let stats = ok(
        &app,
        "GET",
        &format!("/api/periods/{day1}/statistics?combined=true"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(stats["outgoing"]["stake"], 0);
    assert_eq!(stats["retained"]["net"], -1400750);
    assert_eq!(stats["layoffs_total"], 1);
    assert_eq!(stats["layoffs"][0]["status"], "cancelled");
    // Never emit rounded JavaScript money when legacy market totals exceed the
    // shared integer range after combination.
    sqlx::query("UPDATE bets SET stake=? WHERE entry_date=?")
        .bind(5_000_000_000_000_000_i64)
        .bind(date)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/days/{day1}"),
            json!({}),
            &cookie
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    pool.close().await;
}
