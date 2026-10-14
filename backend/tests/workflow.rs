//! Run only against a disposable database named marksix_test.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use chrono::NaiveDate;
use marksix::{api, domain::*, store::*, worker};
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
    json!({"period":period,"play_id":play_id,"play_version":version,"selections":[6,0,1,2,3,4,5],"compound":true,"amount":"100","request_id":uuid::Uuid::new_v4().to_string()})
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL ending in /marksix_test; see docs/DEVELOPMENT.md"]
async fn transactional_workflow_and_recovery() {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL required");
    assert!(
        url.ends_with("/marksix_test"),
        "Only the disposable marksix_test database may be reset"
    );
    let pool = connect(&url).await.unwrap();
    for table in [
        "audit_events",
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
    assert_eq!(details["record"]["rule"]["odds"], "10");
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
            json!({"close_time":"20:00"}),
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
    // Real API boundaries: concurrent final slots and cancellation releasing capacity.
    let capacity_date = date + chrono::Duration::days(5);
    *clock.write().unwrap() = capacity_date.and_hms_opt(12, 0, 0).unwrap();
    let capacity_period = ensure_period(&state, capacity_date).await.unwrap().id;
    let number_play = bootstrap["plays"][0]["id"].as_i64().unwrap();
    let number_payload = |period: &str, selections: Vec<u8>, compound: bool| {
        json!({"period":period,"play_id":number_play,"play_version":1,"selections":selections,
            "compound":compound,"amount":"1","request_id":uuid::Uuid::new_v4().to_string()})
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
