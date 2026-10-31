#[path = "../test_support/database.rs"]
mod database;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use marksix::{api, domain::*, store, worker};
use serde_json::{Value, json};
use std::sync::Arc;
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
#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn ledger_transaction_contract() {
    let pool = database::reset().await.unwrap();
    store::require_current_schema(&pool).await.unwrap();
    let mut state = store::AppState::new(pool.clone()).unwrap();
    let date = chrono::NaiveDate::from_ymd_opt(2040, 1, 1).unwrap();
    state.clock = Arc::new(move || date.and_hms_opt(12, 0, 0).unwrap());
    let app = api::router(state.clone());
    assert_eq!(
        call(&app, "GET", "/api/bootstrap", json!({}), "").await.0,
        StatusCode::UNAUTHORIZED
    );
    let (s, _, cookie) = call(
        &app,
        "POST",
        "/api/login",
        json!({"username":"test-admin","password":std::env::var("TEST_ADMIN_PASSWORD").unwrap()}),
        "",
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, boot, _) = call(&app, "GET", "/api/bootstrap", json!({}), &cookie).await;
    assert_eq!(s, StatusCode::OK);
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    assert_eq!(boot["features"]["layoffs"], false);
    let line = json!({"play_id":play["id"],"play_version":play["version"],"selections":[7],"compound":false,"amount":"100"});
    let request = uuid::Uuid::new_v4().to_string();
    let body = json!({"period":boot["today"]["id"],"bettor":"sample","request_id":request,"entry_mode":"text","items":[line.clone()]});
    let preview = json!({"period":body["period"],"bettor":"sample","items":body["items"]});
    let (s, p, _) = call(&app, "POST", "/api/slips/preview", preview, &cookie).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(p["stake"], 10_000);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let mut bad = body.clone();
    bad["items"].as_array_mut().unwrap().push(json!({"play_id":play["id"],"play_version":1,"selections":[50],"compound":false,"amount":"100"}));
    assert_eq!(
        call(&app, "POST", "/api/slips", bad, &cookie).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let (a, b) = tokio::join!(
        call(&app, "POST", "/api/slips", body.clone(), &cookie),
        call(&app, "POST", "/api/slips", body.clone(), &cookie)
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(a.1["id"], b.1["id"]);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    let receipt = format!("/api/slips/submission/{request}");
    assert_eq!(
        call(&app, "GET", &receipt, json!({}), &cookie).await.1["id"],
        a.1["id"]
    );
    let mut different = body.clone();
    different["items"][0]["amount"] = "200".into();
    assert_eq!(
        call(&app, "POST", "/api/slips", different, &cookie).await.0,
        StatusCode::CONFLICT
    );
    let (s, _, _) = call(
        &app,
        "PUT",
        "/api/settings/features",
        json!({"layoffs":false,"manual_entry":true,"text_entry":false}),
        &cookie,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let mut fresh = body.clone();
    fresh["request_id"] = uuid::Uuid::new_v4().to_string().into();
    assert_eq!(
        call(&app, "POST", "/api/slips", fresh, &cookie).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "POST", "/api/slips", body.clone(), &cookie)
            .await
            .0,
        StatusCode::OK
    );
    let bet_id: String = sqlx::query_scalar("SELECT id FROM bets LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    let fly_path = format!("/api/bets/{bet_id}/layoffs");
    let outgoing = json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":1,"amount":"10","receiver":"receiver"});
    assert_eq!(
        call(&app, "POST", &fly_path, outgoing, &cookie).await.0,
        StatusCode::FORBIDDEN
    );
    call(
        &app,
        "PUT",
        "/api/settings/features",
        json!({"layoffs":true,"manual_entry":true,"text_entry":true}),
        &cookie,
    )
    .await;
    let correction = json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":1,"amount":"120","receiver":null});
    let amount_path = format!("/api/bets/{bet_id}/amount");
    assert_eq!(
        call(&app, "PUT", &amount_path, correction.clone(), &cookie)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "PUT", &amount_path, correction, &cookie).await.0,
        StatusCode::OK
    );
    let outgoing = json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":2,"amount":"20","receiver":"receiver"});
    let sent = call(&app, "POST", &fly_path, outgoing.clone(), &cookie).await;
    assert_eq!(sent.0, StatusCode::OK);
    assert_eq!(
        call(&app, "POST", &fly_path, outgoing, &cookie).await.0,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM layoffs")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM bets WHERE id=?")
        .bind(&bet_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let excessive = json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":revision,"amount":"101","receiver":"receiver"});
    assert_eq!(
        call(&app, "POST", &fly_path, excessive, &cookie).await.0,
        StatusCode::CONFLICT
    );
    let mut changed = play["rule"].clone();
    changed["odds"] = "99".into();
    assert_eq!(
        call(
            &app,
            "PUT",
            &format!("/api/plays/{}", play["id"]),
            json!({"version":1,"rule":changed,"enabled":true}),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut draw = Draw::predicted([1, 2, 3, 4, 5, 6, 7], &Mapping::default());
    draw.expect = boot["today"]["id"].as_str().unwrap().into();
    draw.open_time = date.and_hms_opt(21, 34, 0).unwrap();
    worker::accept_draw(&state, &draw, &json!({}))
        .await
        .unwrap();
    worker::accept_draw(&state, &draw, &json!({}))
        .await
        .unwrap();
    let result: (i64, i64) = sqlx::query_as("SELECT payout,rebate FROM bets")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(result, (528_000, 1_200));
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>("SELECT payout,rebate FROM layoffs")
            .fetch_one(&pool)
            .await
            .unwrap(),
        (88_000, 200)
    );
    let audit: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE event='period_settled'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audit, 1);
    assert_eq!(
        call(&app, "POST", "/api/slips", body, &cookie).await.0,
        StatusCode::OK
    );
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn preview_and_submission_reject_unsafe_aggregate_without_writes() {
    let pool = database::reset().await.unwrap();
    let mut state = store::AppState::new(pool.clone()).unwrap();
    state.clock = Arc::new(|| {
        chrono::NaiveDate::from_ymd_opt(2040, 1, 1)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    });
    let app = api::router(state);
    let (status, _, cookie) = call(
        &app,
        "POST",
        "/api/login",
        json!({"username":"test-admin","password":std::env::var("TEST_ADMIN_PASSWORD").unwrap()}),
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let boot = call(&app, "GET", "/api/bootstrap", json!({}), &cookie)
        .await
        .1;
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let mut rule = play["rule"].clone();
    rule["odds"] = "1".into();
    rule["special_odds"] = Value::Null;
    rule["rebate_percent"] = "0".into();
    rule["special_rebate_percent"] = Value::Null;
    let response = call(
        &app,
        "PUT",
        &format!("/api/plays/{}", play["id"]),
        json!({"version":play["version"],"rule":rule,"enabled":true}),
        &cookie,
    )
    .await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.1);
    let line = json!({"play_id":play["id"],"play_version":2,"selections":[7],"compound":false,"amount":"30000000000000"});
    // One row has 3e15 cents principal + 3e15 exposure, inside the 9e15 budget.
    let preview =
        json!({"period":boot["today"]["id"],"bettor":"synthetic-budget","items":[line.clone()]});
    let response = call(&app, "POST", "/api/slips/preview", preview.clone(), &cookie).await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.1);
    assert_eq!(response.1["valid"], true);
    assert_eq!(response.1["stake"], 3_000_000_000_000_000_i64);
    for count in [2, 4] {
        let mut request = preview.clone();
        request["items"] = json!(vec![line.clone(); count]);
        let response = call(&app, "POST", "/api/slips/preview", request.clone(), &cookie).await;
        assert_eq!(
            response.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            response.1
        );
        assert!(
            response.1["error"]
                .as_str()
                .unwrap()
                .contains("安全计算范围")
        );
        request["request_id"] = uuid::Uuid::new_v4().to_string().into();
        request["entry_mode"] = "text".into();
        assert_eq!(
            call(&app, "POST", "/api/slips", request, &cookie).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    for table in [
        "bets",
        "bet_slips",
        "bettor_play_preferences",
        "text_entry_preferences",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn configuration_import_batch_order_and_delete_preserve_versions_atomically() {
    let pool = database::reset().await.unwrap();
    let mut state = store::AppState::new(pool.clone()).unwrap();
    state.clock = Arc::new(|| {
        chrono::NaiveDate::from_ymd_opt(2040, 1, 1)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    });
    let app = api::router(state);
    let (status, _, cookie) = call(
        &app,
        "POST",
        "/api/login",
        json!({"username":"test-admin","password":std::env::var("TEST_ADMIN_PASSWORD").unwrap()}),
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let export = call(&app, "GET", "/api/plays/export", json!({}), &cookie).await;
    assert_eq!(export.0, StatusCode::OK);
    let mut first = export.1["plays"][0].clone();
    first["rule"]["name"] = "synthetic-config-a".into();
    let mut second = first.clone();
    second["rule"]["name"] = "synthetic-config-b".into();
    let file = json!({"format":"marksix-play-rules","schema":1,"plays":[first.clone(),second]});
    let imported = call(&app, "POST", "/api/plays/import", file.clone(), &cookie).await;
    assert_eq!(imported.0, StatusCode::OK, "{}", imported.1);
    assert_eq!(imported.1["created"], 2);
    let ids = imported.1["ids"].as_array().unwrap();
    let a = ids[0].as_i64().unwrap();
    let b = ids[1].as_i64().unwrap();
    first["rule"]["odds"] = "2".into();
    let updated = call(
        &app,
        "POST",
        "/api/plays/import",
        json!({"format":"marksix-play-rules","schema":1,"plays":[first.clone()]}),
        &cookie,
    )
    .await;
    assert_eq!(updated.0, StatusCode::OK);
    assert_eq!(updated.1["updated"], 1);
    let rejected = call(&app, "POST", "/api/plays/batch", json!({"action":"update","targets":[{"id":a,"version":2},{"id":b,"version":99}],"odds":"3"}), &cookie).await;
    assert_eq!(rejected.0, StatusCode::CONFLICT);
    let stored: (i64, String) = sqlx::query_as(
        "SELECT version,CAST(JSON_UNQUOTE(JSON_EXTRACT(rule,'$.odds')) AS CHAR CHARACTER SET utf8mb4) FROM plays WHERE id=?",
    )
    .bind(a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, (2, "2".into()));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM play_versions WHERE play_id=?")
            .bind(a)
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/plays/import",
            json!({"format":"marksix-play-rules","schema":1,"plays":[first.clone(),first]}),
            &cookie
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let batch = call(&app, "POST", "/api/plays/batch", json!({"action":"update","targets":[{"id":a,"version":2},{"id":b,"version":1}],"odds":"3","rebate_percent":"1","enabled":true}), &cookie).await;
    assert_eq!(batch.0, StatusCode::OK, "{}", batch.1);
    assert_eq!(batch.1["changed"], 2);
    let boot = call(&app, "GET", "/api/bootstrap", json!({}), &cookie)
        .await
        .1;
    let order: Vec<Value> = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .map(|play| json!({"id":play["id"],"version":play["version"]}))
        .collect();
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/plays/order",
            json!({"plays":order}),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    let reordered = call(&app, "GET", "/api/bootstrap", json!({}), &cookie)
        .await
        .1;
    assert_eq!(reordered["plays"][0]["id"], order[0]["id"]);
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/plays/order",
            json!({"plays":[{"id":a,"version":3}]}),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("/api/plays/{a}"),
            json!({"version":2}),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("/api/plays/{a}"),
            json!({"version":3}),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/plays/export?id={a}"),
            json!({}),
            &cookie
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM play_versions WHERE play_id=?")
            .bind(a)
            .fetch_one(&pool)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/plays/batch",
            json!({"action":"delete","targets":[{"id":b,"version":2}]}),
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    let exported = call(&app, "GET", "/api/plays/export", json!({}), &cookie)
        .await
        .1;
    assert!(!exported["plays"].as_array().unwrap().iter().any(|play| {
        play["rule"]["name"]
            .as_str()
            .unwrap()
            .starts_with("synthetic-config-")
    }));
    pool.close().await;
}
