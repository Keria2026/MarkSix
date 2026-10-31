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
    let period_id = boot["today"]["id"].as_str().unwrap();
    let statistics = ok(
        &app,
        "GET",
        &format!("/api/periods/{period_id}/statistics?page=0"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(statistics["incoming"]["stake"], 12_000);
    assert_eq!(statistics["outgoing"]["stake"], 2_000);
    assert_eq!(statistics["retained"]["stake"], 10_000);
    assert_eq!(statistics["retained"]["payout"], 440_000);
    assert_eq!(statistics["retained"]["rebate"], 1_000);
    assert_eq!(statistics["retained"]["net"], -431_000);
    assert_eq!(statistics["receivers"][0]["name"], "receiver");
    assert_eq!(statistics["layoffs_total"], 1);
    assert_eq!(statistics["layoffs_page"], 1);
    let filters = ok(
        &app,
        "GET",
        &format!("/api/periods/{period_id}/bet-filters"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(filters["bettors"], json!(["sample"]));
    assert_eq!(filters["plays"][0]["name"], "特码");
    let parties = ok(&app, "GET", "/api/parties", json!({}), &cookie).await;
    assert_eq!(parties["receivers"], json!(["receiver"]));

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
    for (count, mixed) in [(2, false), (4, false), (2, true), (4, true)] {
        let mut request = preview.clone();
        request["items"] = json!(vec![line.clone(); count]);
        if mixed {
            request["items"][1]["market"] = json!("hk");
        }
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
        request["entry_mode"] = if mixed { "manual" } else { "text" }.into();
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
    // Two independent period budgets must also serialize edits to a shared slip.
    let mut small = line.clone();
    small["amount"] = json!("10000000000000");
    let mut hk_small = small.clone();
    hk_small["market"] = json!("hk");
    let saved = ok(&app, "POST", "/api/slips", json!({"period":boot["today"]["id"],"bettor":"synthetic-mixed-budget","items":[small,hk_small],"request_id":uuid::Uuid::new_v4().to_string()}), &cookie).await;
    let path = format!("/api/slips/{}", saved["id"].as_str().unwrap());
    let detail = ok(&app, "GET", &path, json!({}), &cookie).await;
    let a = &detail["items"][0];
    let b = &detail["items"][1];
    let a_path = format!("/api/bets/{}/amount", a["id"].as_str().unwrap());
    let b_path = format!("/api/bets/{}/amount", b["id"].as_str().unwrap());
    assert_eq!(call(&app, "PUT", &a_path, json!({"amount":"40000000000000","revision":a["revision"],"request_id":uuid::Uuid::new_v4().to_string()}), &cookie).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    let (first, second) = tokio::join!(
        call(
            &app,
            "PUT",
            &a_path,
            json!({"amount":"25000000000000","revision":a["revision"],"request_id":uuid::Uuid::new_v4().to_string()}),
            &cookie
        ),
        call(
            &app,
            "PUT",
            &b_path,
            json!({"amount":"25000000000000","revision":b["revision"],"request_id":uuid::Uuid::new_v4().to_string()}),
            &cookie
        ),
    );
    let mut statuses = [first.0.as_u16(), second.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 422]);
    assert_eq!(
        ok(&app, "GET", &path, json!({}), &cookie).await["stake"],
        3_500_000_000_000_000_i64
    );
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

async fn ok(app: &Router, method: &str, path: &str, body: Value, cookie: &str) -> Value {
    let (status, result, _) = call(app, method, path, body, cookie).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {result}");
    result
}

#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn query_export_preferences_cancellation_and_mapping_contract() {
    let pool = database::reset().await.unwrap();
    let mut state = store::AppState::new(pool.clone()).unwrap();
    state.clock = Arc::new(|| {
        chrono::NaiveDate::from_ymd_opt(2040, 1, 1)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    });
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
    let period = boot["today"]["id"].as_str().unwrap();
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let line = json!({"play_id":play["id"],"play_version":1,"selections":[7,8],"compound":false,"amount":"10"});
    let pref =
        json!({"alias":"合成词条","play_id":play["id"],"play_version":1,"amount_mode":"each"});
    let bettor_pref = json!({"play_id":play["id"],"play_version":1,"amount_mode":"each"});
    let body = json!({"period":period,"bettor":"synthetic-query","request_id":uuid::Uuid::new_v4().to_string(),"items":[line.clone(),line.clone()],"entry_mode":"text","text_preferences":[pref],"bettor_preference":bettor_pref});
    let slip = ok(&app, "POST", "/api/slips", body, &cookie).await;
    let path = format!("/api/slips/{}", slip["id"].as_str().unwrap());
    let detail = ok(&app, "GET", &path, json!({}), &cookie).await;
    assert_eq!(detail["stake"], 4000);
    assert_eq!(detail["unit_count"], 4);
    let bets = detail["items"].as_array().unwrap();
    let id = bets[0]["id"].as_str().unwrap();
    for order in ["newest", "amount_asc", "amount_desc"] {
        let query = json!({"period":period,"min_amount":"20","max_amount":"40","bettors":["synthetic-query"],"play_ids":[play["id"]],"order":order,"page":0});
        let records = ok(&app, "POST", "/api/records/search", query.clone(), &cookie).await;
        assert_eq!(records["total"], 1);
        assert_eq!(records["items"][0]["stake"], 4000);
        let records = ok(&app, "POST", "/api/bets/search", query, &cookie).await;
        assert_eq!(records["total"], 2);
        assert_eq!(records["page"], 1);
    }
    for query in [
        json!({"min_amount":"40","max_amount":"20"}),
        json!({"play_ids":[0]}),
        json!({"bettors":["x".repeat(81)]}),
        json!({"order":"invalid"}),
    ] {
        for route in ["/api/bets/search", "/api/records/search"] {
            assert_eq!(
                call(&app, "POST", route, query.clone(), &cookie).await.0,
                StatusCode::CONFLICT
            );
        }
    }
    assert_eq!(
        ok(
            &app,
            "GET",
            "/api/periods?search=2040&page=0",
            json!({}),
            &cookie
        )
        .await["total"],
        1
    );
    assert_eq!(
        ok(
            &app,
            "GET",
            &format!("/api/periods/{period}"),
            json!({}),
            &cookie
        )
        .await["id"],
        period
    );
    let export = ok(
        &app,
        "GET",
        &format!("/api/periods/{period}/bettor-export"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(export["bettors"][0]["bets"].as_array().unwrap().len(), 2);
    assert_eq!(export["bettors"][0]["totals"]["stake"], 4000);
    assert_eq!(
        ok(
            &app,
            "GET",
            "/api/text-entry/preferences",
            json!({}),
            &cookie
        )
        .await
        .as_array()
        .unwrap()
        .len(),
        1
    );
    assert_eq!(
        ok(
            &app,
            "POST",
            "/api/text-entry/bettor-preference",
            json!({"bettor":"synthetic-query"}),
            &cookie
        )
        .await["preference"],
        bettor_pref
    );
    ok(
        &app,
        "DELETE",
        "/api/text-entry/preferences/%E5%90%88%E6%88%90%E8%AF%8D%E6%9D%A1",
        json!({}),
        &cookie,
    )
    .await;
    assert!(
        ok(
            &app,
            "GET",
            "/api/text-entry/preferences",
            json!({}),
            &cookie
        )
        .await
        .as_array()
        .unwrap()
        .is_empty()
    );
    let mut quote = line.clone();
    quote["period"] = period.into();
    quote["bettor"] = "synthetic-query".into();
    quote["request_id"] = uuid::Uuid::new_v4().to_string().into();
    let priced = ok(&app, "POST", "/api/quote", quote.clone(), &cookie).await;
    assert_eq!(priced["stake"], 2000);
    assert_eq!(priced["max_return"], 44000);
    let permit = state.risk_gate.clone().acquire_owned().await.unwrap();
    assert_eq!(
        call(&app, "POST", "/api/quote", quote.clone(), &cookie)
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(permit);
    ok(
        &app,
        "PUT",
        "/api/settings/features",
        json!({"layoffs":true,"manual_entry":true,"text_entry":true}),
        &cookie,
    )
    .await;
    let fly = ok(&app,"POST",&format!("/api/bets/{id}/layoffs"),json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":1,"amount":"2","receiver":"synthetic-receiver"}),&cookie).await;
    let cancel = format!("{path}/cancel");
    assert_eq!(
        call(&app, "POST", &cancel, json!({"versions":[]}), &cookie)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let versions = json!({"versions":bets.iter().map(|b| json!({"id":b["id"],"revision":if b["id"]==id {2} else {1}})).collect::<Vec<_>>()});
    assert_eq!(
        call(&app, "POST", &cancel, versions, &cookie).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/bets/{id}/cancel"),
            json!({}),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let detail = ok(&app, "GET", &format!("/api/bets/{id}"), json!({}), &cookie).await;
    assert_eq!(detail["layoffs"].as_array().unwrap().len(), 1);
    assert!(!detail["events"].as_array().unwrap().is_empty());
    let cancel_fly = format!("/api/layoffs/{}/cancel", fly["id"].as_str().unwrap());
    for _ in 0..2 {
        ok(&app, "POST", &cancel_fly, json!({}), &cookie).await;
    }
    let versions = json!({"versions":bets.iter().map(|b| json!({"id":b["id"],"revision":if b["id"]==id {3} else {1}})).collect::<Vec<_>>()});
    for _ in 0..2 {
        ok(&app, "POST", &cancel, versions.clone(), &cookie).await;
    }
    assert_eq!(
        ok(&app, "GET", &path, json!({}), &cookie).await["status"],
        "cancelled"
    );
    assert_eq!(
        ok(
            &app,
            "GET",
            &format!("/api/periods/{period}/bettor-export"),
            json!({}),
            &cookie
        )
        .await["bettors"][0]["totals"]["stake"],
        0
    );
    let single = ok(&app, "POST", "/api/bets", quote.clone(), &cookie).await;
    let single_cancel = format!("/api/bets/{}/cancel", single["id"].as_str().unwrap());
    for _ in 0..2 {
        ok(&app, "POST", &single_cancel, json!({}), &cookie).await;
    }
    assert_eq!(
        ok(&app, "GET", "/api/settings", json!({}), &cookie).await["cutover_time"],
        "06:00"
    );
    ok(
        &app,
        "PUT",
        "/api/settings/mapping",
        json!({"effective_date":"2040-01-02","mapping":Mapping::default()}),
        &cookie,
    )
    .await;
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/settings/mapping",
            json!({"effective_date":"2040-01-01","mapping":Mapping::default()}),
            &cookie
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut rule = play["rule"].clone();
    rule["name"] = "synthetic-created".into();
    assert!(
        ok(&app, "POST", "/api/plays", rule, &cookie).await["id"]
            .as_i64()
            .unwrap()
            > 0
    );
    for route in [
        "/api/periods/missing",
        "/api/slips/missing",
        "/api/bets/missing",
        "/api/periods/missing/bettor-export",
    ] {
        assert_eq!(
            call(&app, "GET", route, json!({}), &cookie).await.0,
            StatusCode::NOT_FOUND
        );
    }
    let mut draw = Draw::predicted([1, 2, 3, 4, 5, 6, 7], &Mapping::default());
    draw.expect = period.into();
    draw.open_time = state.now();
    worker::accept_draw(&state, &draw, &json!({}))
        .await
        .unwrap();
    assert_eq!(
        ok(&app, "POST", "/api/quote", quote, &cookie).await["settled"],
        true
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/periods/{period}/risk"),
            json!({}),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    ok(&app, "POST", "/api/logout", json!({}), &cookie).await;
    assert_eq!(
        call(&app, "GET", "/api/session", json!({}), &cookie)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn package_rounding_mutations_and_preview_failure_contract() {
    let pool = database::reset().await.unwrap();
    let mut state = store::AppState::new(pool.clone()).unwrap();
    state.clock = Arc::new(|| {
        chrono::NaiveDate::from_ymd_opt(2040, 1, 1)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    });
    let app = api::router(state.clone());
    for input in [
        json!({"username":"missing","password":"wrong"}),
        json!({"username":"test-admin","password":"wrong"}),
    ] {
        assert_eq!(
            call(&app, "POST", "/api/login", input, "").await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (_, _, cookie) = call(
        &app,
        "POST",
        "/api/login",
        json!({"username":"test-admin","password":std::env::var("TEST_ADMIN_PASSWORD").unwrap()}),
        "",
    )
    .await;
    let boot = ok(&app, "GET", "/api/bootstrap", json!({}), &cookie).await;
    let period = boot["today"]["id"].as_str().unwrap();
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let mapping: Mapping = serde_json::from_value(boot["today"]["mapping"].clone()).unwrap();
    let zodiac = (0_u8..12)
        .find(|z| mapping.zodiac.iter().filter(|x| *x == z).count() == 4)
        .unwrap();
    let line = json!({"play_id":play["id"],"play_version":1,"selections":[],"package_zodiacs":[zodiac],"compound":false,"amount":"1"});
    let body = json!({"period":period,"bettor":"synthetic-package","request_id":uuid::Uuid::new_v4().to_string(),"items":[line.clone()]});
    let slip = ok(&app, "POST", "/api/slips", body.clone(), &cookie).await;
    let detail = ok(
        &app,
        "GET",
        &format!("/api/slips/{}", slip["id"].as_str().unwrap()),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(detail["stake"], 100);
    assert_eq!(detail["unit_count"], 4);
    let id = detail["items"][0]["id"].as_str().unwrap();
    let fly_path = format!("/api/bets/{id}/layoffs");
    let amount_path = format!("/api/bets/{id}/amount");
    ok(
        &app,
        "PUT",
        "/api/settings/features",
        json!({"layoffs":true,"manual_entry":true,"text_entry":true}),
        &cookie,
    )
    .await;
    let fly = json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":1,"amount":"0.50","receiver":"synthetic-rounding"});
    let result = ok(&app, "POST", &fly_path, fly.clone(), &cookie).await;
    let mut conflict = fly.clone();
    conflict["amount"] = "0.49".into();
    assert_eq!(
        call(&app, "POST", &fly_path, conflict, &cookie).await.0,
        StatusCode::CONFLICT
    );
    let second = json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":2,"amount":"0.50","receiver":"synthetic-rounding"});
    let response = call(&app, "POST", &fly_path, second, &cookie).await;
    assert_eq!(response.0, StatusCode::CONFLICT);
    assert!(response.1["error"].as_str().unwrap().contains("余分"));
    let correction =
        json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":2,"amount":"2"});
    ok(&app, "PUT", &amount_path, correction.clone(), &cookie).await;
    let repriced = ok(&app, "GET", &format!("/api/bets/{id}"), json!({}), &cookie).await;
    assert_eq!(repriced["record"]["stake"], 200);
    assert!(
        repriced["atoms"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["stake"] == 50)
    );
    for (path, method, patch) in [
        (&fly_path, "POST", json!({"amount":"0"})),
        (&fly_path, "POST", json!({"receiver":""})),
        (&amount_path, "PUT", json!({"receiver":"invalid"})),
        (&amount_path, "PUT", json!({"request_id":"bad"})),
        (&amount_path, "PUT", json!({"revision":1})),
    ] {
        let mut invalid = correction.clone();
        invalid["request_id"] = uuid::Uuid::new_v4().to_string().into();
        for (k, v) in patch.as_object().unwrap() {
            invalid[k] = v.clone();
        }
        assert!(
            call(&app, method, path, invalid, &cookie)
                .await
                .0
                .is_client_error()
        );
    }
    let preview = json!({"period":period,"bettor":"synthetic-preview","items":[line.clone()]});
    for patch in [
        json!({"play_id":999999}),
        json!({"play_version":999}),
        json!({"amount":"0"}),
    ] {
        let mut invalid = preview.clone();
        for (k, v) in patch.as_object().unwrap() {
            invalid["items"][0][k] = v.clone();
        }
        let response = ok(&app, "POST", "/api/slips/preview", invalid, &cookie).await;
        assert_eq!(response["valid"], false);
        assert!(!response["items"][0]["error"].is_null());
    }
    for items in [json!([]), json!(vec![line.clone(); 101])] {
        let mut invalid = preview.clone();
        invalid["items"] = items;
        assert_eq!(
            call(&app, "POST", "/api/slips/preview", invalid, &cookie)
                .await
                .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let mut many = preview.clone();
    many["items"] = json!(vec![
        json!({"play_id":play["id"],"play_version":1,"selections":(1..=49).collect::<Vec<_>>(),"compound":false,"amount":"1"});
        21
    ]);
    assert_eq!(
        ok(&app, "POST", "/api/slips/preview", many, &cookie).await["valid"],
        false
    );
    let mut invalid = body.clone();
    invalid["request_id"] = uuid::Uuid::new_v4().to_string().into();
    invalid["text_preferences"] =
        json!([{"alias":"bad alias","play_id":play["id"],"play_version":1,"amount_mode":"each"}]);
    assert_eq!(
        call(&app, "POST", "/api/slips", invalid, &cookie).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    ok(
        &app,
        "POST",
        &format!("/api/layoffs/{}/cancel", result["id"].as_str().unwrap()),
        json!({}),
        &cookie,
    )
    .await;
    sqlx::query("UPDATE periods SET risk_status='failed' WHERE id=?")
        .bind(period)
        .execute(&pool)
        .await
        .unwrap();
    ok(
        &app,
        "POST",
        &format!("/api/periods/{period}/risk"),
        json!({}),
        &cookie,
    )
    .await;
    let status: String = sqlx::query_scalar("SELECT risk_status FROM periods WHERE id=?")
        .bind(period)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "queued");
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated marksix_test database"]
async fn mixed_market_slip_keeps_independent_draws_and_hk_waits_across_dates() {
    use marksix::market;
    use std::sync::{
        RwLock,
        atomic::{AtomicUsize, Ordering},
    };
    let pool = database::reset().await.unwrap();
    sqlx::query("UPDATE market_cursors SET expect='2026115',open_time='2026-10-27 21:32:32' WHERE market='hk'").execute(&pool).await.unwrap();
    let time = Arc::new(RwLock::new(
        chrono::NaiveDate::from_ymd_opt(2026, 10, 31)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap(),
    ));
    let clock = time.clone();
    let mut state = store::AppState::new(pool.clone()).unwrap();
    state.clock = Arc::new(move || *clock.read().unwrap());
    state.risk_gate = Arc::new(tokio::sync::Semaphore::new(0));
    state.client = reqwest::Client::builder().no_proxy().build().unwrap();
    let source = Arc::new(RwLock::new(
        json!({"expect":"2026115","openTime":"2026-10-27 21:32:32","openCode":"47,21,04,02,24,18,31","zodiac":"猴,狗,兔,蛇,羊,牛,鼠","wave":"blue,green,blue,red,red,red,blue","verify":false}),
    ));
    let requests = Arc::new(AtomicUsize::new(0));
    let response = source.clone();
    let count = requests.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    state.hk_draw_url = format!("http://{}/hk", listener.local_addr().unwrap());
    state.draw_url = format!("http://{}/macau", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let router = Router::new()
            .route(
                "/hk",
                axum::routing::get(move || {
                    let response = response.clone();
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        axum::Json(response.read().unwrap().clone())
                    }
                }),
            )
            .route(
                "/macau",
                axum::routing::get(|| async { axum::Json(json!([])) }),
            );
        axum::serve(listener, router).await.unwrap();
    });
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
    assert!(boot["hk"].is_null());
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let macau = boot["today"]["id"].as_str().unwrap().to_owned();
    let hk = market::ensure_hk(&state).await.unwrap();
    *time.write().unwrap() = hk.business_date.and_hms_opt(21, 34, 0).unwrap();
    worker::tick(&state).await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "no HK polling before accepted bets"
    );
    let line = json!({"play_id":play["id"],"play_version":1,"selections":[31],"compound":false,"amount":"10"});
    let mut hk_line = line.clone();
    hk_line["market"] = json!("hk");
    let input = json!({"period":macau,"bettor":"synthetic-markets","request_id":uuid::Uuid::new_v4().to_string(),"items":[line,hk_line]});
    ok(
        &app,
        "POST",
        "/api/slips/preview",
        json!({"period":macau,"bettor":"synthetic-markets","items":input["items"]}),
        &cookie,
    )
    .await;
    let mut rejected = input.clone();
    rejected["items"][1]["selections"] = json!([50]);
    assert_eq!(
        call(&app, "POST", "/api/slips", rejected, &cookie).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    worker::tick(&state).await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "preview/rejected bets do not start polling"
    );
    *time.write().unwrap() = hk.business_date.and_hms_opt(12, 0, 0).unwrap();
    let receipt = ok(&app, "POST", "/api/slips", input.clone(), &cookie).await;
    let id = receipt["id"].as_str().unwrap();
    let replay = ok(&app, "POST", "/api/slips", input.clone(), &cookie).await;
    assert_eq!(replay["id"], receipt["id"]);
    assert_eq!(replay["replayed"], true);
    let mut conflict = input.clone();
    conflict["items"][1]["market"] = json!("macau");
    assert_eq!(
        call(&app, "POST", "/api/slips", conflict, &cookie).await.0,
        StatusCode::CONFLICT
    );
    let detail = ok(&app, "GET", &format!("/api/slips/{id}"), json!({}), &cookie).await;
    assert_eq!(detail["items"][0]["market"], "macau");
    assert_eq!(detail["items"][1]["market"], "hk");
    assert_eq!(detail["items"][1]["period_id"], hk.id);
    assert_eq!(detail["stake"], 2000);
    for period in [&macau, &hk.id] {
        let search = ok(
            &app,
            "POST",
            "/api/records/search",
            json!({"period":period}),
            &cookie,
        )
        .await;
        assert_eq!(search["items"][0]["items"].as_array().unwrap().len(), 2);
        let report = ok(
            &app,
            "GET",
            &format!("/api/periods/{period}"),
            json!({}),
            &cookie,
        )
        .await;
        assert_eq!(report["totals"]["stake"], 1000);
    }
    let mut invalid = input.clone();
    invalid["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    invalid["items"][1]["selections"] = json!([50]);
    assert_eq!(
        call(&app, "POST", "/api/slips", invalid, &cookie).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    // Both legs of a second mixed slip cancel in a single transaction.
    let mut cancellable = input.clone();
    cancellable["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    let second = ok(&app, "POST", "/api/slips", cancellable, &cookie).await;
    let second_id = second["id"].as_str().unwrap();
    let second_detail = ok(
        &app,
        "GET",
        &format!("/api/slips/{second_id}"),
        json!({}),
        &cookie,
    )
    .await;
    let versions: Vec<_> = second_detail["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| json!({"id":i["id"],"revision":i["revision"]}))
        .collect();
    ok(
        &app,
        "POST",
        &format!("/api/slips/{second_id}/cancel"),
        json!({"versions":versions}),
        &cookie,
    )
    .await;
    *time.write().unwrap() = hk.business_date.and_hms_opt(21, 33, 59).unwrap();
    worker::tick(&state).await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "accepted bets wait until 21:34 Beijing time"
    );
    let before: store::Period = sqlx::query_as("SELECT * FROM periods WHERE id=?")
        .bind(&hk.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(before.last_fetch_at.is_none());
    assert_eq!(store::view(&state, before).await.unwrap().phase, "open");
    *time.write().unwrap() = hk.business_date.and_hms_opt(21, 34, 0).unwrap();
    worker::tick(&state).await.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    worker::tick(&state).await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "do not refetch within 60 seconds"
    );
    sqlx::query(
        "UPDATE periods SET last_fetch_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 60 SECOND) WHERE id=?",
    )
    .bind(&hk.id)
    .execute(&pool)
    .await
    .unwrap();
    worker::tick(&state).await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        2,
        "retry after 60 seconds even when the result is still old"
    );
    let unchanged: store::Period = sqlx::query_as("SELECT * FROM periods WHERE id=?")
        .bind(&hk.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(unchanged.draw.is_none());
    assert_eq!(
        store::view(&state, unchanged.clone()).await.unwrap().phase,
        "fetching"
    );
    // Macau result cannot settle the HK leg.
    let raw = json!({"expect":macau,"openTime":"2026-10-31 21:34:00","openCode":"1,2,3,4,5,6,7","zodiac":"鼠,牛,虎,兔,龙,蛇,马","wave":"red,red,blue,blue,green,green,red"});
    worker::accept_draw(&state, &parse_draw(&raw).unwrap(), &raw)
        .await
        .unwrap();
    let partial = ok(&app, "GET", &format!("/api/slips/{id}"), json!({}), &cookie).await;
    assert_eq!(partial["items"][0]["status"], "settled");
    assert_eq!(partial["items"][1]["status"], "pending");
    assert!(partial["totals"]["net"].is_null());
    *time.write().unwrap() = chrono::NaiveDate::from_ymd_opt(2026, 11, 2)
        .unwrap()
        .and_hms_opt(22, 0, 0)
        .unwrap();
    assert_eq!(market::ensure_hk(&state).await.unwrap().id, hk.id);
    let mut draw = source.read().unwrap().clone();
    draw["expect"] = json!("2026117");
    draw["openTime"] = json!("2026-11-02 21:45:00");
    worker::process_hk_response(&state, &unchanged, &[draw.clone()])
        .await
        .unwrap();
    draw["expect"] = json!("2026116");
    draw["openTime"] = json!("2026-11-01 21:45:00");
    worker::process_hk_response(&state, &unchanged, &[draw.clone()])
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM periods WHERE id=?")
            .bind(&hk.id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "pending"
    );
    draw["openTime"] = json!("2026-11-02 21:45:00");
    *source.write().unwrap() = draw;
    sqlx::query("UPDATE periods SET last_fetch_at=NULL WHERE id=?")
        .bind(&hk.id)
        .execute(&pool)
        .await
        .unwrap();
    worker::tick(&state).await.unwrap();
    let done: store::Period = sqlx::query_as("SELECT * FROM periods WHERE id=?")
        .bind(&hk.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(done.state, "settled");
    let fetched = requests.load(Ordering::SeqCst);
    sqlx::query("UPDATE periods SET last_fetch_at=NULL WHERE id=?")
        .bind(&hk.id)
        .execute(&pool)
        .await
        .unwrap();
    worker::tick(&state).await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        fetched,
        "accepted draw stops polling"
    );
    let complete = ok(&app, "GET", &format!("/api/slips/{id}"), json!({}), &cookie).await;
    assert_eq!(complete["status"], "settled");
    assert_eq!(complete["items"][0]["payout"], 0);
    assert!(complete["items"][1]["payout"].as_i64().unwrap() > 0);
    let payout = complete["items"][1]["payout"].clone();
    worker::settle_period(&state, &hk.id).await.unwrap();
    assert_eq!(
        ok(&app, "GET", &format!("/api/slips/{id}"), json!({}), &cookie).await["items"][1]["payout"],
        payout
    );
    // Post-draw backfill settles immediately until the following 06:00.
    *time.write().unwrap() = chrono::NaiveDate::from_ymd_opt(2026, 11, 3)
        .unwrap()
        .and_hms_opt(5, 59, 0)
        .unwrap();
    assert!(market::accepts(&done, state.now()));
    let mut backfill = input.clone();
    backfill["period"] = json!(hk.id);
    backfill["items"] = json!([hk_line]);
    backfill["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    let saved = ok(&app, "POST", "/api/slips", backfill, &cookie).await;
    assert_eq!(
        ok(
            &app,
            "GET",
            &format!("/api/slips/{}", saved["id"].as_str().unwrap()),
            json!({}),
            &cookie
        )
        .await["status"],
        "settled"
    );
    *time.write().unwrap() = chrono::NaiveDate::from_ymd_opt(2026, 11, 3)
        .unwrap()
        .and_hms_opt(6, 0, 0)
        .unwrap();
    assert!(!market::accepts(&done, state.now()));
    let next = market::ensure_hk(&state).await.unwrap();
    assert_ne!(next.id, hk.id);
    assert_eq!(next.previous_expect.as_deref(), Some("2026116"));
    let mut historical = source.read().unwrap().clone();
    historical["expect"] = json!("2026118");
    historical["openTime"] = json!("2026-11-02 21:45:00");
    worker::process_hk_response(&state, &next, &[historical])
        .await
        .unwrap();
    let refreshed: store::Period = sqlx::query_as("SELECT * FROM periods WHERE id=?")
        .bind(&next.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(refreshed.previous_expect.as_deref(), Some("2026118"));
    let mut future = source.read().unwrap().clone();
    future["expect"] = json!("2026119");
    future["openTime"] = json!("2026-11-04 21:00:00");
    worker::process_hk_response(&state, &refreshed, &[future])
        .await
        .unwrap();
    *time.write().unwrap() = chrono::NaiveDate::from_ymd_opt(2027, 1, 2)
        .unwrap()
        .and_hms_opt(22, 0, 0)
        .unwrap();
    let mut first_year = source.read().unwrap().clone();
    first_year["expect"] = json!("2027007");
    first_year["openTime"] = json!("2027-01-02 21:00:00");
    worker::process_hk_response(&state, &refreshed, &[first_year])
        .await
        .unwrap();
    let reset: store::Period = sqlx::query_as("SELECT * FROM periods WHERE id=?")
        .bind(&next.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(reset.draw.as_ref().unwrap().expect, "2027007");
    // A first bet entered after 21:34 starts on the next tick; cancelling all
    // outstanding HK bets stops requests even when the retry interval is due.
    *time.write().unwrap() = chrono::NaiveDate::from_ymd_opt(2027, 1, 3)
        .unwrap()
        .and_hms_opt(22, 0, 0)
        .unwrap();
    let current = store::ensure_period(&state, business_date(state.now()))
        .await
        .unwrap();
    let mut late = input.clone();
    late["period"] = json!(current.id);
    late["items"] = json!([hk_line]);
    late["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    let saved = ok(&app, "POST", "/api/slips", late, &cookie).await;
    let saved_id = saved["id"].as_str().unwrap();
    let details = ok(
        &app,
        "GET",
        &format!("/api/slips/{saved_id}"),
        json!({}),
        &cookie,
    )
    .await;
    let before_late = requests.load(Ordering::SeqCst);
    worker::tick(&state).await.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), before_late + 1);
    ok(&app, "POST", &format!("/api/slips/{saved_id}/cancel"),
        json!({"versions":[{"id":details["items"][0]["id"],"revision":details["items"][0]["revision"]}]}), &cookie).await;
    sqlx::query("UPDATE periods SET last_fetch_at=NULL WHERE id=?")
        .bind(details["items"][0]["period_id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    worker::tick(&state).await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        before_late + 1,
        "cancelled HK bets do not keep polling alive"
    );
    server.abort();
    pool.close().await;
}
