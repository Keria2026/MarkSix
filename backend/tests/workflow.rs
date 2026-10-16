//! Run only against a disposable database named marksix_test.
#[path = "../test_support/seed.rs"]
mod seed;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use chrono::NaiveDate;
use marksix::{api, domain::*, store::*, worker};
include!("../test_support/rules.rs");
use serde_json::{Value, json};
use sqlx::types::Json;
use std::sync::{Arc, RwLock};
use tower::ServiceExt;

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    body: Value,
    cookie: &str,
) -> (StatusCode, Value, String) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-marksix", "1");
    if !cookie.is_empty() {
        req = req.header("cookie", cookie);
    }
    let resp = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let cookie = resp
        .headers()
        .get("set-cookie")
        .map(|c| c.to_str().unwrap().split(';').next().unwrap().to_string())
        .unwrap_or_default();
    let bytes = to_bytes(resp.into_body(), 2 * 1024 * 1024).await.unwrap();
    let json = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}));
    (status, json, cookie)
}
fn payload(period: &str, play_id: i64, version: i64) -> Value {
    json!({"period":period,"play_id":play_id,"play_version":version,"selections":[6,0,1,2,3,4,5],"compound":true,"bettor":"测试客户","amount":"100","request_id":uuid::Uuid::new_v4().to_string()})
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL ending in /marksix_test; see docs/DEVELOPMENT.md"]
async fn transactional_workflow_and_recovery() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::ERROR)
        .try_init();
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL required");
    assert!(
        url.ends_with("/marksix_test"),
        "Only the disposable marksix_test database may be reset"
    );
    let pool = connect(&url).await.unwrap();
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
            .await
            .unwrap();
    }
    let password = uuid::Uuid::new_v4().to_string();
    initialize(&pool, "test-admin", Some(&password))
        .await
        .unwrap();
    let seeded: Vec<(Json<Rule>, bool)> =
        sqlx::query_as("SELECT rule,enabled FROM plays ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let bundled = marksix::configuration::bundled().unwrap();
    assert_eq!(seeded.len(), bundled.plays.len());
    for ((rule, enabled), expected) in seeded.iter().zip(&bundled.plays) {
        assert_eq!(
            serde_json::to_value(&rule.0).unwrap(),
            serde_json::to_value(&expected.rule).unwrap()
        );
        assert_eq!(*enabled, expected.enabled);
    }
    // Stable calculation fixtures are independent of customer-facing presets.
    seed::calculation_rules(&pool).await.unwrap();
    sqlx::query("UPDATE plays SET rule=JSON_SET(rule,'$.compound_enabled',true)")
        .execute(&pool)
        .await
        .unwrap();
    let date = NaiveDate::from_ymd_opt(2026, 10, 14).unwrap();
    let clock = Arc::new(RwLock::new(date.and_hms_opt(12, 0, 0).unwrap()));
    let mut state = AppState::new(pool.clone()).unwrap();
    let test_clock = clock.clone();
    state.clock = Arc::new(move || *test_clock.read().unwrap());
    let app = api::router(state.clone());
    assert_eq!(
        request(&app, Method::GET, "/api/bootstrap", Value::Null, "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, _, cookie) = request(
        &app,
        Method::POST,
        "/api/login",
        json!({"username":"test-admin","password":password}),
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, bootstrap, _) =
        request(&app, Method::GET, "/api/bootstrap", Value::Null, &cookie).await;
    assert_eq!(status, StatusCode::OK, "{bootstrap}");
    let period = bootstrap["today"]["id"].as_str().unwrap();
    assert_eq!(bootstrap["today"]["phase"], "open");
    let play_id = bootstrap["plays"][2]["id"].as_i64().unwrap();
    let body = payload(period, play_id, 1);
    let (r1, r2) = tokio::join!(
        request(&app, Method::POST, "/api/bets", body.clone(), &cookie),
        request(&app, Method::POST, "/api/bets", body.clone(), &cookie)
    );
    assert_eq!(r1.0, StatusCode::OK, "{}", r1.1);
    assert_eq!(r2.0, StatusCode::OK, "{}", r2.1);
    assert_eq!(r1.1["id"], r2.1["id"]);
    let bet_id = r1.1["id"].as_str().unwrap();
    let (status, p, _) = request(
        &app,
        Method::GET,
        &format!("/api/periods/{period}"),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(p["totals"]["records"], 1);
    assert_eq!(p["totals"]["units"], 21);
    assert_eq!(p["totals"]["stake"], 210000);
    assert!(p["totals"]["net"].is_null());
    let mut mismatched = body.clone();
    mismatched["amount"] = json!("101");
    assert_eq!(
        request(&app, Method::POST, "/api/bets", mismatched, &cookie)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut invalid = payload(period, play_id, 1);
    invalid["compound"] = json!(false);
    invalid["selections"] = json!([0, 1, 2, 3]);
    assert_eq!(
        request(&app, Method::POST, "/api/bets", invalid, &cookie)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let second = request(
        &app,
        Method::POST,
        "/api/bets",
        payload(period, play_id, 1),
        &cookie,
    )
    .await;
    assert_eq!(second.0, StatusCode::OK);
    let second_id = second.1["id"].as_str().unwrap();
    let cancel_path = format!("/api/bets/{second_id}/cancel");
    assert_eq!(
        request(&app, Method::POST, &cancel_path, json!({}), &cookie)
            .await
            .0,
        StatusCode::OK
    );
    // Snapshot survives a later edit, while stale clients must refresh before new bets.
    let mut edited = defaults()[2].clone();
    edited.odds = "12".into();
    edited.special_odds = Some("9".into());
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &format!("/api/plays/{play_id}"),
            json!({"version":1,"rule":edited,"enabled":true}),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/bets",
            payload(period, play_id, 1),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, details, _) = request(
        &app,
        Method::GET,
        &format!("/api/bets/{bet_id}"),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(details["record"]["rule"]["odds"], "10", "{details}");
    // Compute the live portfolio, then verify witness settlement and version publication.
    worker::start_risk(&state).await.unwrap();
    let mut ready = false;
    for _ in 0..100 {
        let status: String = sqlx::query_scalar("SELECT risk_status FROM periods WHERE id=?")
            .bind(period)
            .fetch_one(&pool)
            .await
            .unwrap();
        if status == "complete" {
            ready = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(ready);
    let (_, p, _) = request(
        &app,
        Method::GET,
        &format!("/api/periods/{period}"),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(p["risk_result"]["max_payout"], 1800000);
    assert_eq!(p["risk_version"], p["bet_version"]);
    // Future configuration never mutates today's immutable period snapshot.
    assert_eq!(
        request(
            &app,
            Method::PUT,
            "/api/settings/closing",
            json!({"open_time":"09:00","close_time":"20:00","username":"test-admin","password":password}),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    let mapping = Mapping {
        natal: 5,
        ..Mapping::default()
    };
    assert_eq!(
        request(
            &app,
            Method::PUT,
            "/api/settings/mapping",
            json!({"effective_date":"2026-10-14","mapping":mapping}),
            &cookie
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        request(
            &app,
            Method::PUT,
            "/api/settings/mapping",
            json!({"effective_date":"2026-10-15","mapping":mapping}),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    let today = ensure_period(&state, date).await.unwrap();
    assert_eq!(today.close_time, "21:28");
    assert_eq!(today.mapping.natal, 6);
    *clock.write().unwrap() = date.and_hms_opt(21, 28, 0).unwrap();
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/bets",
            payload(period, play_id, 2),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/api/bets/{bet_id}/cancel"),
            json!({}),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // An acknowledged request can still be replayed safely after the cutoff.
    assert_eq!(
        request(&app, Method::POST, "/api/bets", body, &cookie)
            .await
            .0,
        StatusCode::OK
    );
    *clock.write().unwrap() = date.and_hms_opt(21, 34, 0).unwrap();
    let raw = json!({"expect":period,"openTime":"2026-10-14 21:32:32","openCode":"01,13,07,06,05,04,03","zodiac":"馬,馬,鼠,牛,虎,兔,龍","wave":"red,red,red,green,green,blue,blue"});
    let draw = parse_draw(&raw).unwrap();
    worker::accept_draw(&state, &draw, &raw).await.unwrap();
    worker::accept_draw(&state, &draw, &raw).await.unwrap();
    let (_, p, _) = request(
        &app,
        Method::GET,
        &format!("/api/periods/{period}"),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(p["state"], "settled");
    assert_eq!(p["totals"]["payout"], 500000);
    assert_eq!(p["totals"]["rebate"], 4200);
    assert_eq!(p["totals"]["net"], -294200);
    assert_eq!(p["totals"]["units"], 21);
    let mut conflict_draw = draw.clone();
    conflict_draw.zodiac[0] = 0;
    worker::accept_draw(&state, &conflict_draw, &raw)
        .await
        .unwrap();
    let p: Period = sqlx::query_as("SELECT * FROM periods WHERE id=?")
        .bind(period)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(p.draw.unwrap().0, draw);
    assert!(p.error.unwrap().contains("不同"));
    let cancelled: String = sqlx::query_scalar("SELECT status FROM bets WHERE id=?")
        .bind(second_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cancelled, "cancelled");
    // Recover a persisted accepted draw after a restart; cancelled rows stay untouched.
    let next = date.succ_opt().unwrap();
    *clock.write().unwrap() = next.and_hms_opt(12, 0, 0).unwrap();
    let next_p = ensure_period(&state, next).await.unwrap();
    assert_eq!(next_p.close_time, "20:00");
    assert_eq!(next_p.mapping.natal, 5);
    let mut future_draw = draw.clone();
    future_draw.expect = next_p.id.clone();
    future_draw.open_time = next.and_hms_opt(21, 32, 32).unwrap();
    sqlx::query("UPDATE periods SET state='settling',draw=? WHERE id=?")
        .bind(Json(&future_draw))
        .bind(&next_p.id)
        .execute(&pool)
        .await
        .unwrap();
    worker::recover(&state).await.unwrap();
    worker::settle_period(&state, &next_p.id).await.unwrap();
    let status: String = sqlx::query_scalar("SELECT state FROM periods WHERE id=?")
        .bind(&next_p.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "settled");
    // Latest-only feed stops obsolete polling, preserving the missing period.
    let missing_date = next.succ_opt().unwrap();
    let missing_p = ensure_period(&state, missing_date).await.unwrap();
    *clock.write().unwrap() = missing_date
        .succ_opt()
        .unwrap()
        .and_hms_opt(21, 34, 0)
        .unwrap();
    let later = json!({"expect":period_id(state.now().date()),"openTime":state.now().format("%Y-%m-%d %H:%M:%S").to_string(),"openCode":"01,13,07,06,05,04,03","zodiac":"馬,馬,鼠,牛,虎,兔,龍","wave":"red,red,red,green,green,blue,blue"});
    worker::process_response(&state, &missing_p, &[later])
        .await
        .unwrap();
    let status: String = sqlx::query_scalar("SELECT state FROM periods WHERE id=?")
        .bind(&missing_p.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "missing");
    let audit: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event='period_settled' AND period_id=?",
    )
    .bind(period)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit, 1);
    // v0.2 ledger: all writes go through authenticated API and actual MySQL locks.
    let ledger_date = date + chrono::Duration::days(3);
    *clock.write().unwrap() = ledger_date.and_hms_opt(12, 0, 0).unwrap();
    let ledger_period = ensure_period(&state, ledger_date).await.unwrap().id;
    let mut rule = defaults()[0].clone();
    rule.name = "账本测试特码".into();
    rule.odds = "2".into();
    rule.rebate_percent = "2".into();
    let created = request(&app, Method::POST, "/api/plays", json!(rule), &cookie).await;
    assert_eq!(created.0, StatusCode::OK, "{}", created.1);
    let number_id = created.1["id"].as_i64().unwrap();
    let single = |play, options: Vec<u8>| json!({"period":ledger_period,"play_id":play,"play_version":1,"selections":options,"compound":false,"amount":"100","bettor":"张三","request_id":uuid::Uuid::new_v4().to_string()});
    let mut invalid = single(number_id, vec![49]);
    invalid["bettor"] = json!("  ");
    assert_eq!(
        request(&app, Method::POST, "/api/bets", invalid, &cookie)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let created = request(
        &app,
        Method::POST,
        "/api/bets",
        single(number_id, vec![49]),
        &cookie,
    )
    .await;
    assert_eq!(created.0, StatusCode::OK, "{}", created.1);
    let ledger_id = created.1["id"].as_str().unwrap();
    let mutation = |revision, amount: &str, receiver: Option<&str>| json!({"revision":revision,"amount":amount,"receiver":receiver,"request_id":uuid::Uuid::new_v4().to_string()});
    let fly_path = format!("/api/bets/{ledger_id}/layoffs");
    let correction_path = format!("/api/bets/{ledger_id}/amount");
    let fly = mutation(1, "40", Some("李四"));
    let (first, replay) = tokio::join!(
        request(&app, Method::POST, &fly_path, fly.clone(), &cookie),
        request(&app, Method::POST, &fly_path, fly.clone(), &cookie)
    );
    assert_eq!(first.0, StatusCode::OK, "{}", first.1);
    assert_eq!(first.1, replay.1);
    let fly_id = first.1["id"].as_str().unwrap();
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &correction_path,
            mutation(1, "150", None),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &correction_path,
            mutation(2, "39", None),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &fly_path,
            mutation(2, "61", Some("李四")),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/api/bets/{ledger_id}/cancel"),
            json!({}),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let correction = mutation(2, "150", None);
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &correction_path,
            correction.clone(),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, Method::PUT, &correction_path, correction, &cookie)
            .await
            .0,
        StatusCode::OK
    );
    let second_fly = request(
        &app,
        Method::POST,
        &fly_path,
        mutation(3, "10", Some("王五")),
        &cookie,
    )
    .await;
    assert_eq!(second_fly.0, StatusCode::OK);
    let cancel_fly = format!(
        "/api/layoffs/{}/cancel",
        second_fly.1["id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, Method::POST, &cancel_fly, json!({}), &cookie)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, Method::POST, &cancel_fly, json!({}), &cookie)
            .await
            .0,
        StatusCode::OK
    );
    // A size bet is entirely void when the configured special scope draws 49.
    rule.kind = Kind::Size;
    rule.name = "大小".into();
    let size = request(&app, Method::POST, "/api/plays", json!(rule), &cookie)
        .await
        .1["id"]
        .as_i64()
        .unwrap();
    let size_bet = request(
        &app,
        Method::POST,
        "/api/bets",
        single(size, vec![1]),
        &cookie,
    )
    .await;
    assert_eq!(size_bet.0, StatusCode::OK);
    let size_id = size_bet.1["id"].as_str().unwrap();
    let size_fly = request(
        &app,
        Method::POST,
        &format!("/api/bets/{size_id}/layoffs"),
        mutation(1, "20", Some("李四")),
        &cookie,
    )
    .await;
    assert_eq!(size_fly.0, StatusCode::OK);
    let filtered = request(
        &app,
        Method::POST,
        "/api/bets/search",
        json!({"period":ledger_period,"min_amount":"120","max_amount":"180"}),
        &cookie,
    )
    .await;
    assert_eq!(filtered.1["total"], 1);
    assert_eq!(filtered.1["items"][0]["id"], ledger_id);
    let stats_path = format!("/api/periods/{ledger_period}/statistics");
    let before = request(&app, Method::GET, &stats_path, Value::Null, &cookie)
        .await
        .1;
    assert_eq!(before["incoming"]["stake"], 25000);
    assert_eq!(before["outgoing"]["stake"], 6000);
    assert!(before["retained"]["net"].is_null());
    assert_eq!(before["receivers"].as_array().unwrap().len(), 1);
    assert_eq!(request(&app,Method::PUT,"/api/settings/closing",json!({"open_time":"08:00","close_time":"21:00","username":"test-admin","password":"wrong"}),&cookie).await.0,StatusCode::FORBIDDEN);
    *clock.write().unwrap() = ledger_date.and_hms_opt(20, 0, 0).unwrap();
    for (method, path, body) in [
        (
            Method::PUT,
            correction_path.clone(),
            mutation(5, "180", None),
        ),
        (
            Method::POST,
            fly_path.clone(),
            mutation(5, "1", Some("李四")),
        ),
        (
            Method::POST,
            format!("/api/layoffs/{fly_id}/cancel"),
            json!({}),
        ),
    ] {
        assert_eq!(
            request(&app, method, &path, body, &cookie).await.0,
            StatusCode::CONFLICT
        );
    }
    // An acknowledged fly-out can safely be replayed after cutoff.
    assert_eq!(
        request(&app, Method::POST, &fly_path, fly, &cookie).await.0,
        StatusCode::OK
    );
    let mut draw = Draw::predicted([1, 2, 3, 4, 5, 6, 49], &Mapping::default());
    draw.expect = ledger_period.clone();
    draw.open_time = ledger_date.and_hms_opt(21, 32, 32).unwrap();
    worker::accept_draw(&state, &draw, &json!({"fixture":"ledger"}))
        .await
        .unwrap();
    worker::accept_draw(&state, &draw, &json!({"fixture":"ledger"}))
        .await
        .unwrap();
    let stats = request(&app, Method::GET, &stats_path, Value::Null, &cookie)
        .await
        .1;
    assert_eq!(stats["incoming"]["stake"], 15000);
    assert_eq!(stats["incoming"]["units"], 1);
    assert_eq!(stats["incoming"]["refunded"], 10000);
    assert_eq!(stats["incoming"]["rebate"], 300);
    assert_eq!(stats["incoming"]["net"], -15300);
    assert_eq!(stats["outgoing"]["stake"], 4000);
    assert_eq!(stats["outgoing"]["refunded"], 2000);
    assert_eq!(stats["outgoing"]["net"], 4080);
    assert_eq!(stats["retained"]["net"], -11220);
    assert_eq!(stats["bettors"][0]["name"], "张三");
    assert_eq!(stats["receivers"][0]["name"], "李四");
    let detail = request(
        &app,
        Method::GET,
        &format!("/api/bets/{ledger_id}"),
        Value::Null,
        &cookie,
    )
    .await
    .1;
    assert_eq!(detail["record"]["amount"], 15000);
    assert_eq!(detail["record"]["revision"], 5);
    assert!(detail["events"].as_array().unwrap().len() >= 4);
    // Year boundary overrides prior-year mappings, and preserves snapshots.
    let new_year = ensure_period(&state, NaiveDate::from_ymd_opt(2027, 1, 1).unwrap())
        .await
        .unwrap();
    assert_eq!(new_year.id, "2027001");
    assert_eq!(new_year.mapping.natal, 7);
    assert_eq!(new_year.mapping.zodiac[1], 6);
    // Real API boundaries: concurrent final slots and cancellation releasing capacity.
    let capacity_date = date + chrono::Duration::days(5);
    *clock.write().unwrap() = capacity_date.and_hms_opt(12, 0, 0).unwrap();
    let capacity_period = ensure_period(&state, capacity_date).await.unwrap().id;
    let number_play = bootstrap["plays"][0]["id"].as_i64().unwrap();
    let number_payload = |period: &str, selections: Vec<u8>, compound: bool| {
        json!({"period":period,"play_id":number_play,"play_version":1,"selections":selections,
            "compound":compound,"bettor":"容量客户","amount":"1","request_id":uuid::Uuid::new_v4().to_string()})
    };
    for _ in 0..999 {
        let result = request(
            &app,
            Method::POST,
            "/api/bets",
            number_payload(&capacity_period, vec![1], false),
            &cookie,
        )
        .await;
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    }
    let (last_a, last_b) = tokio::join!(
        request(
            &app,
            Method::POST,
            "/api/bets",
            number_payload(&capacity_period, vec![1], false),
            &cookie
        ),
        request(
            &app,
            Method::POST,
            "/api/bets",
            number_payload(&capacity_period, vec![1], false),
            &cookie
        )
    );
    assert!(
        (last_a.0 == StatusCode::OK && last_b.0 == StatusCode::CONFLICT)
            || (last_b.0 == StatusCode::OK && last_a.0 == StatusCode::CONFLICT)
    );
    let successful = if last_a.0 == StatusCode::OK {
        last_a.1
    } else {
        last_b.1
    };
    let path = format!("/api/bets/{}/cancel", successful["id"].as_str().unwrap());
    assert_eq!(
        request(&app, Method::POST, &path, json!({}), &cookie)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/bets",
            number_payload(&capacity_period, vec![2], false),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bets WHERE period_id=?")
        .bind(&capacity_period)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 1001); // The cancelled row is permanent but consumes no active slot.

    let unit_date = capacity_date.succ_opt().unwrap();
    *clock.write().unwrap() = unit_date.and_hms_opt(12, 0, 0).unwrap();
    let unit_period = ensure_period(&state, unit_date).await.unwrap().id;
    for _ in 0..204 {
        let result = request(
            &app,
            Method::POST,
            "/api/bets",
            number_payload(&unit_period, (1..=49).collect(), true),
            &cookie,
        )
        .await;
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    }
    // 204 * 49 + 4 = 10,000, well below the 1,000-record cap.
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/bets",
            number_payload(&unit_period, vec![1, 2, 3, 4], true),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/bets",
            number_payload(&unit_period, vec![1], false),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let units: i64 =
        sqlx::query_scalar("SELECT CAST(SUM(unit_count) AS SIGNED) FROM bets WHERE period_id=?")
            .bind(&unit_period)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(units, 10000);
    // Portable import is atomic, updates same-name IDs and preserves bet snapshots.
    let exported = request(&app, Method::GET, "/api/plays/export", Value::Null, &cookie).await;
    assert_eq!(exported.0, StatusCode::OK);
    let mut invalid = exported.1.clone();
    invalid["plays"][1]["rule"]["odds"] = json!("bad");
    let old_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plays")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, Method::POST, "/api/plays/import", invalid, &cookie)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM plays")
            .fetch_one(&pool)
            .await
            .unwrap(),
        old_count
    );
    let mut duplicate_file = exported.1.clone();
    duplicate_file["plays"] = json!([
        exported.1["plays"][0].clone(),
        exported.1["plays"][0].clone()
    ]);
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/plays/import",
            duplicate_file,
            &cookie
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let imported = request(
        &app,
        Method::POST,
        "/api/plays/import",
        exported.1.clone(),
        &cookie,
    )
    .await;
    assert_eq!(imported.0, StatusCode::OK, "{}", imported.1);
    let imported_id = imported.1["ids"][0].as_i64().unwrap();
    assert_eq!(imported.1["created"], 0);
    assert_eq!(
        imported.1["updated"],
        exported.1["plays"].as_array().unwrap().len()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM plays")
            .fetch_one(&pool)
            .await
            .unwrap(),
        old_count
    );
    let imported_version: i64 = sqlx::query_scalar("SELECT version FROM plays WHERE id=?")
        .bind(imported_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let original_snapshot: Value =
        sqlx::query_scalar::<_, Json<Value>>("SELECT rule FROM bets WHERE id=?")
            .bind(bet_id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
    assert_ne!(original_snapshot["odds"], "12");
    let target_version: i64 = sqlx::query_scalar("SELECT version FROM plays WHERE id=?")
        .bind(play_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let batch_targets = json!([{"id":imported_id,"version":imported_version},{"id":play_id,"version":target_version}]);
    let invalid_batch = request(
        &app,
        Method::POST,
        "/api/plays/batch",
        json!({"targets":batch_targets,"action":"update","odds":"bad"}),
        &cookie,
    )
    .await;
    assert_eq!(
        invalid_batch.0,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        invalid_batch.1
    );
    let updated_batch=request(&app,Method::POST,"/api/plays/batch",json!({"targets":batch_targets,"action":"update","odds":"44","rebate_percent":"8","enabled":false}),&cookie).await;
    assert_eq!(updated_batch.0, StatusCode::OK, "{}", updated_batch.1);
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/plays/batch",
            json!({"targets":batch_targets,"action":"delete"}),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        sqlx::query_scalar::<_, Json<Value>>("SELECT rule FROM bets WHERE id=?")
            .bind(bet_id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .0,
        original_snapshot
    );
    let mixed_stale = json!([{"id":imported_id,"version":imported_version+1},{"id":play_id,"version":target_version}]);
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/plays/batch",
            json!({"targets":mixed_stale,"action":"update","odds":"45"}),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT version FROM plays WHERE id=?")
            .bind(imported_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        imported_version + 1
    );
    let imported_version = imported_version + 1;
    let deletion = request(
        &app,
        Method::DELETE,
        &format!("/api/plays/{imported_id}"),
        json!({"version":999}),
        &cookie,
    )
    .await;
    assert_eq!(deletion.0, StatusCode::CONFLICT);
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/api/plays/{imported_id}"),
            json!({"version":imported_version}),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &format!("/api/plays/{imported_id}"),
            json!({"version":1,"enabled":true,"rule":exported.1["plays"][0]["rule"]}),
            &cookie
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    // Deleting a referenced original play preserves settled bets and their details.
    let version: i64 = sqlx::query_scalar("SELECT version FROM plays WHERE id=?")
        .bind(play_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/api/plays/{play_id}"),
            json!({"version":version}),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets WHERE play_id=?")
            .bind(play_id)
            .fetch_one(&pool)
            .await
            .unwrap()
            > 0
    );
    let current = request(&app, Method::GET, "/api/bootstrap", Value::Null, &cookie).await;
    assert!(
        !current.1["plays"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == play_id)
    );
    let (status, _, _) = request(&app, Method::POST, "/api/logout", json!({}), &cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        request(&app, Method::GET, "/api/bootstrap", Value::Null, &cookie)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    pool.close().await;
}
