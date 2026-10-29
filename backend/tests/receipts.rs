//! Real SQL, HTTP and worker checks for receipt grouping; disposable database only.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::NaiveDate;
use marksix::{api, domain::*, store::*, worker};
use serde_json::{Value, json};
use std::sync::{Arc, RwLock};
use tower::ServiceExt;
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    data: Value,
    cookie: &str,
) -> (StatusCode, Value, String) {
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("Content-Type", "application/json")
                .header("X-MarkSix", "1")
                .header("Cookie", cookie)
                .body(Body::from(data.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status();
    let cookie = r
        .headers()
        .get("set-cookie")
        .map(|s| s.to_str().unwrap().split(';').next().unwrap().to_owned())
        .unwrap_or_default();
    let bytes = to_bytes(r.into_body(), 16 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap(), cookie)
}
async fn ok(app: &Router, method: &str, path: &str, data: Value, cookie: &str) -> Value {
    let (s, v, _) = call(app, method, path, data, cookie).await;
    assert_eq!(s, StatusCode::OK, "{method} {path}: {v}");
    v
}
fn line(p: &Value, options: Value, amount: &str) -> Value {
    json!({"play_id":p["id"],"play_version":p["version"],"selections":options,"compound":false,"amount":amount})
}
fn slip(period: &str, items: Vec<Value>) -> Value {
    json!({"period":period,"bettor":"组合客户甲","request_id":uuid::Uuid::new_v4(),"items":items})
}
fn versions(record: &Value) -> Value {
    json!({"versions":record["items"].as_array().unwrap().iter().map(|b|json!({"id":b["id"],"revision":b["revision"]})).collect::<Vec<_>>()})
}
#[tokio::test]
#[ignore = "requires disposable marksix_test; never production"]
async fn atomic_slips_order_statements_and_capacity() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test"));
    let pool = connect(&url).await.unwrap();
    for table in [
        "bettor_play_preferences",
        "module_features",
        "text_entry_preferences",
        "audit_events",
        "bet_mutations",
        "layoffs",
        "bets",
        "bet_slips",
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
    initialize(&pool, "receipt-admin", Some(&password))
        .await
        .unwrap();
    let date = NaiveDate::from_ymd_opt(2026, 10, 14).unwrap();
    let clock = Arc::new(RwLock::new(date.and_hms_opt(12, 0, 0).unwrap()));
    let mut state = AppState::new(pool.clone()).unwrap();
    let c = clock.clone();
    state.clock = Arc::new(move || *c.read().unwrap());
    let app = api::router(state.clone());
    let (_, _, cookie) = call(
        &app,
        "POST",
        "/api/login",
        json!({"username":"receipt-admin","password":password}),
        "",
    )
    .await;
    assert!(!cookie.is_empty());
    let boot = ok(&app, "GET", "/api/bootstrap", json!({}), &cookie).await;
    assert_eq!(
        boot["features"],
        json!({"layoffs":false,"manual_entry":true,"text_entry":true,"entry_mode":"manual"})
    );
    ok(
        &app,
        "PUT",
        "/api/settings/features",
        json!({"layoffs":true,"manual_entry":true,"text_entry":true}),
        &cookie,
    )
    .await;
    let period = boot["today"]["id"].as_str().unwrap().to_owned();
    let mut rule = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["kind"] == "number" && p["rule"]["quantity"] == 1)
        .unwrap()["rule"]
        .clone();
    for (k, v) in [
        ("name", json!("验收特码")),
        ("odds", json!("43")),
        ("rebate_percent", json!("10")),
        ("special_odds", Value::Null),
        ("special_rebate_percent", Value::Null),
        ("scope", json!("special")),
        ("condition", json!("all")),
    ] {
        rule[k] = v;
    }
    let number_id = ok(&app, "POST", "/api/plays", rule.clone(), &cookie).await["id"].clone();
    for (k, v) in [
        ("name", json!("验收一肖")),
        ("kind", json!("zodiac")),
        ("scope", json!("all")),
        ("odds", json!("2")),
        ("special_odds", json!("1.8")),
    ] {
        rule[k] = v;
    }
    let zodiac_id = ok(&app, "POST", "/api/plays", rule.clone(), &cookie).await["id"].clone();
    for (k, v) in [
        ("name", json!("验收二有")),
        ("quantity", json!(2)),
        ("combination_size", json!(2)),
        ("odds", json!("4")),
        ("special_odds", json!("3.5")),
    ] {
        rule[k] = v;
    }
    let pair_id = ok(&app, "POST", "/api/plays", rule, &cookie).await["id"].clone();
    let boot = ok(&app, "GET", "/api/bootstrap", json!({}), &cookie).await;
    let plays = boot["plays"].as_array().unwrap();
    let number = plays.iter().find(|p| p["id"] == number_id).unwrap();
    let zodiac = plays.iter().find(|p| p["id"] == zodiac_id).unwrap();
    let pair = plays.iter().find(|p| p["id"] == pair_id).unwrap();
    let mut order: Vec<_> = plays
        .iter()
        .rev()
        .map(|p| json!({"id":p["id"],"version":p["version"]}))
        .collect();
    ok(
        &app,
        "PUT",
        "/api/plays/order",
        json!({"plays":order}),
        &cookie,
    )
    .await;
    let sorted = ok(&app, "GET", "/api/bootstrap", json!({}), &cookie).await;
    assert_eq!(sorted["plays"][0]["id"], pair_id);
    assert_eq!(sorted["plays"][0]["version"], 1);
    assert_eq!(
        ok(&app, "GET", "/api/plays/export", json!({}), &cookie).await["plays"][0]["rule"]["name"],
        "验收二有"
    );
    order.push(order[0].clone());
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
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut data = slip(
        &period,
        vec![
            line(zodiac, json!([2]), "200"),
            line(zodiac, json!([6]), "400"),
            line(pair, json!([6, 2]), "500"),
            line(number, json!([44, 10, 9]), "10"),
            line(number, json!([4, 1, 8]), "20"),
        ],
    );
    data["text_preferences"] = json!([{"alias":"测试特","play_id":number["id"],"play_version":number["version"],"amount_mode":"each"}]);
    let preview_body = json!({"period":period,"bettor":"组合客户甲","items":data["items"]});
    let preview = ok(
        &app,
        "POST",
        "/api/slips/preview",
        preview_body.clone(),
        &cookie,
    )
    .await;
    assert_eq!(preview["valid"], true);
    assert_eq!(preview["stake"], 119000);
    assert_eq!(preview["units"], 9);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bet_slips")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let mut invalid_preview = preview_body.clone();
    invalid_preview["items"][0]["selections"] = json!([99]);
    let rejected = ok(&app, "POST", "/api/slips/preview", invalid_preview, &cookie).await;
    assert_eq!(rejected["valid"], false);
    assert!(rejected["items"][0]["error"].is_string());
    let mut stale = preview_body.clone();
    stale["items"][0]["play_version"] = json!(-1);
    assert_eq!(
        ok(&app, "POST", "/api/slips/preview", stale, &cookie).await["valid"],
        false
    );
    let mut old = preview_body.clone();
    old["period"] = json!("missing");
    assert_eq!(
        call(&app, "POST", "/api/slips/preview", old, &cookie)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut bad = data.clone();
    bad["request_id"] = json!(uuid::Uuid::new_v4());
    bad["items"][4]["selections"] = json!([50]);
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
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM text_entry_preferences")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let mut bad_learning = data.clone();
    bad_learning["text_preferences"][0]["play_id"] = json!(-1);
    assert_eq!(
        call(&app, "POST", "/api/slips", bad_learning, &cookie)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bet_slips")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let (a, b) = tokio::join!(
        call(&app, "POST", "/api/slips", data.clone(), &cookie),
        call(&app, "POST", "/api/slips", data.clone(), &cookie)
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(a.1["id"], b.1["id"]);
    assert_ne!(a.1["replayed"], b.1["replayed"]);
    let learned = ok(
        &app,
        "GET",
        "/api/text-entry/preferences",
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(learned.as_array().unwrap().len(), 1);
    assert_eq!(learned[0]["alias"], "测试特");
    assert_eq!(learned[0]["amount_mode"], "each");
    sqlx::query("UPDATE text_entry_preferences SET play_version=0")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        ok(
            &app,
            "GET",
            "/api/text-entry/preferences",
            json!({}),
            &cookie
        )
        .await[0]["play_version"],
        json!(0)
    );
    sqlx::query("UPDATE text_entry_preferences SET play_version=?")
        .bind(number["version"].as_i64().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    ok(
        &app,
        "DELETE",
        "/api/text-entry/preferences/%E6%B5%8B%E8%AF%95%E7%89%B9",
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(
        ok(
            &app,
            "GET",
            "/api/text-entry/preferences",
            json!({}),
            &cookie
        )
        .await,
        json!([])
    );
    let id = a.1["id"].as_str().unwrap();
    let path = format!("/api/slips/{id}");
    let record = ok(&app, "GET", &path, json!({}), &cookie).await;
    assert_eq!(record["stake"], 119000);
    assert_eq!(record["unit_count"], 9);
    assert_eq!(record["totals"]["rebate"], 11900);
    let listed = ok(
        &app,
        "POST",
        "/api/records/search",
        json!({"period":period,"play_ids":[number_id],"min_amount":"1100","max_amount":"1200"}),
        &cookie,
    )
    .await;
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["items"][0]["items"].as_array().unwrap().len(), 5);
    let mut bad = data.clone();
    bad["items"][0]["amount"] = json!("201");
    assert_eq!(
        call(&app, "POST", "/api/slips", bad, &cookie).await.0,
        StatusCode::CONFLICT
    );
    let tiger = record["items"][0]["id"].as_str().unwrap();
    for (revision, amount) in [(1, "250"), (2, "200")] {
        ok(&app,"PUT",&format!("/api/bets/{tiger}/amount"),json!({"revision":revision,"amount":amount,"receiver":null,"request_id":uuid::Uuid::new_v4()}),&cookie).await;
    }
    let horse = record["items"][1]["id"].as_str().unwrap();
    ok(&app,"POST",&format!("/api/bets/{horse}/layoffs"),json!({"revision":1,"amount":"100","receiver":"受注方甲","request_id":uuid::Uuid::new_v4()}),&cookie).await;
    let updated = ok(&app, "GET", &path, json!({}), &cookie).await;
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/cancel"),
            versions(&updated),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let other = ok(
        &app,
        "POST",
        "/api/slips",
        slip(
            &period,
            vec![
                line(number, json!([1]), "10"),
                line(number, json!([2]), "20"),
            ],
        ),
        &cookie,
    )
    .await;
    let other_path = format!("/api/slips/{}", other["id"].as_str().unwrap());
    let other = ok(&app, "GET", &other_path, json!({}), &cookie).await;
    let stale = versions(&other);
    ok(
        &app,
        "POST",
        &format!(
            "/api/bets/{}/cancel",
            other["items"][0]["id"].as_str().unwrap()
        ),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{other_path}/cancel"),
            stale,
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let other = ok(&app, "GET", &other_path, json!({}), &cookie).await;
    assert_eq!(other["stake"], 2000);
    ok(
        &app,
        "POST",
        &format!("{other_path}/cancel"),
        versions(&other),
        &cookie,
    )
    .await;
    *clock.write().unwrap() = date.and_hms_opt(21, 34, 0).unwrap();
    let mut draw = Draw::predicted([1, 5, 9, 10, 44, 4, 8], &Mapping::for_year(2026));
    draw.expect = period.clone();
    draw.open_time = *clock.read().unwrap();
    worker::accept_draw(&state, &draw, &json!({"test":"slips"}))
        .await
        .unwrap();
    let final_record = ok(&app, "GET", &path, json!({}), &cookie).await;
    assert_eq!(final_record["totals"]["net"], -265900);
    assert_eq!(final_record["totals"]["payout"], 373000);
    let stats = ok(
        &app,
        "GET",
        &format!("/api/periods/{period}/statistics"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(stats["incoming"]["net"], -265900);
    assert_eq!(stats["outgoing"]["net"], 9000);
    assert_eq!(stats["retained"]["net"], -256900);
    let export = ok(
        &app,
        "GET",
        &format!("/api/periods/{period}/bettor-export"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(export["bettors"][0]["totals"]["net"], -265900);
    assert_eq!(export["bettors"][0]["bets"].as_array().unwrap().len(), 7);
    std::fs::create_dir_all("../test-results").unwrap();
    std::fs::write(
        "../test-results/slip-export.json",
        serde_json::to_vec(&export).unwrap(),
    )
    .unwrap();
    assert_eq!(
        ok(&app, "POST", "/api/slips", data, &cookie).await["id"],
        id
    );
    *clock.write().unwrap() = date.succ_opt().unwrap().and_hms_opt(6, 0, 0).unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/slips",
            slip(&period, vec![line(number, json!([1]), "1")]),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    *clock.write().unwrap() = date.succ_opt().unwrap().and_hms_opt(12, 0, 0).unwrap();
    let next = ok(&app, "GET", "/api/bootstrap", json!({}), &cookie).await["today"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let options: Vec<_> = (1..=49).collect();
    let mut thousand = vec![line(number, json!(options), "1"); 20];
    thousand.push(line(number, json!((1..=20).collect::<Vec<_>>()), "1"));
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/slips",
            slip(&next, vec![line(number, json!(options), "1"); 21]),
            &cookie
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut first = None;
    for _ in 0..10 {
        let entry = ok(
            &app,
            "POST",
            "/api/slips",
            slip(&next, thousand.clone()),
            &cookie,
        )
        .await;
        if first.is_none() {
            first = Some(entry);
        }
    }
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/slips",
            slip(&next, vec![line(number, json!([1]), "1")]),
            &cookie
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let path = format!("/api/slips/{}", first.unwrap()["id"].as_str().unwrap());
    let first = ok(&app, "GET", &path, json!({}), &cookie).await;
    ok(
        &app,
        "POST",
        &format!("{path}/cancel"),
        versions(&first),
        &cookie,
    )
    .await;
    ok(&app, "POST", "/api/slips", slip(&next, thousand), &cookie).await;
    let units:i64=sqlx::query_scalar("SELECT CAST(SUM(unit_count) AS SIGNED) FROM bets WHERE period_id=? AND status<>'cancelled'").bind(next).fetch_one(&pool).await.unwrap();
    assert_eq!(units, 10000);
    // Package intent survives SQL snapshots, retries, corrections, layoffs and settlement.
    *clock.write().unwrap() = date
        .succ_opt()
        .unwrap()
        .succ_opt()
        .unwrap()
        .and_hms_opt(12, 0, 0)
        .unwrap();
    let package_period = ok(&app, "GET", "/api/bootstrap", json!({}), &cookie).await["today"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let package = |amount: &str| json!({"period":package_period,"play_id":number_id,"play_version":1,"selections":[],"package_zodiacs":[10],"compound":false,"amount":amount,"bettor":"包肖测试","request_id":uuid::Uuid::new_v4()});
    let body = package("100.1");
    let created = ok(&app, "POST", "/api/bets", body.clone(), &cookie).await;
    assert_eq!(
        created["id"],
        ok(&app, "POST", "/api/bets", body, &cookie).await["id"]
    );
    let package_path = format!("/api/bets/{}", created["id"].as_str().unwrap());
    let detail = ok(&app, "GET", &package_path, json!({}), &cookie).await;
    assert_eq!(detail["record"]["package_zodiacs"], json!([10]));
    assert_eq!(detail["record"]["amount"], 10010);
    assert_eq!(detail["record"]["stake"], 10010);
    assert_eq!(
        detail["atoms"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["stake"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![2503, 2503, 2502, 2502]
    );
    ok(
        &app,
        "PUT",
        &format!("{package_path}/amount"),
        json!({"revision":1,"amount":"100.2","receiver":null,"request_id":uuid::Uuid::new_v4()}),
        &cookie,
    )
    .await;
    ok(
        &app,
        "PUT",
        &format!("{package_path}/amount"),
        json!({"revision":2,"amount":"100.1","receiver":null,"request_id":uuid::Uuid::new_v4()}),
        &cookie,
    )
    .await;
    let tiny = ok(&app, "POST", "/api/bets", package("0.1"), &cookie).await;
    let tiny_path = format!("/api/bets/{}", tiny["id"].as_str().unwrap());
    let tiny_fly = ok(&app,"POST",&format!("{tiny_path}/layoffs"),json!({"revision":1,"amount":"0.05","receiver":"包肖受注方","request_id":uuid::Uuid::new_v4()}),&cookie).await;
    assert_eq!(call(&app,"POST",&format!("{tiny_path}/layoffs"),json!({"revision":2,"amount":"0.05","receiver":"包肖受注方","request_id":uuid::Uuid::new_v4()}),&cookie).await.0,StatusCode::CONFLICT);
    ok(
        &app,
        "POST",
        &format!("/api/layoffs/{}/cancel", tiny_fly["id"].as_str().unwrap()),
        json!({}),
        &cookie,
    )
    .await;
    ok(
        &app,
        "POST",
        &format!("{tiny_path}/cancel"),
        json!({}),
        &cookie,
    )
    .await;
    let invalid = package("10.01");
    assert_eq!(
        call(&app, "POST", "/api/bets", invalid, &cookie).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let package_date = clock.read().unwrap().date();
    *clock.write().unwrap() = package_date.and_hms_opt(21, 34, 0).unwrap();
    let mut package_draw = Draw::predicted([1, 2, 3, 4, 5, 6, 9], &Mapping::for_year(2026));
    package_draw.expect = package_period;
    package_draw.open_time = *clock.read().unwrap();
    worker::accept_draw(&state, &package_draw, &json!({"test":"package"}))
        .await
        .unwrap();
    let settled = ok(&app, "GET", &package_path, json!({}), &cookie).await;
    assert_eq!(settled["record"]["payout"], 107629);
    assert_eq!(settled["record"]["rebate"], 1000);
    let late_slip = ok(
        &app,
        "POST",
        "/api/slips",
        slip(
            &package_draw.expect,
            vec![
                line(number, json!([9]), "10.5"),
                line(number, json!([21]), "0.1"),
            ],
        ),
        &cookie,
    )
    .await;
    let late_path = format!("/api/slips/{}", late_slip["id"].as_str().unwrap());
    let late_detail = ok(&app, "GET", &late_path, json!({}), &cookie).await;
    assert_eq!(late_detail["status"], "settled");
    assert_eq!(late_detail["totals"]["payout"], 45150);
    assert_eq!(late_detail["totals"]["rebate"], 106);
    ok(
        &app,
        "POST",
        &format!("{late_path}/cancel"),
        versions(&late_detail),
        &cookie,
    )
    .await;
    assert_eq!(
        ok(&app, "GET", &late_path, json!({}), &cookie).await["status"],
        "cancelled"
    );
    // Drag intent is persisted, atomic with slips, and repriced using snapshotted atoms.
    let mut rule = number["rule"].clone();
    rule["name"] = json!("拖二中二含特");
    rule["scope"] = json!("all");
    rule["quantity"] = json!(2);
    rule["combination_size"] = json!(2);
    rule["compound_enabled"] = json!(true);
    rule["odds"] = json!("55");
    rule["special_hit_odds"] = json!("25");
    let drag_id = ok(&app, "POST", "/api/plays", rule, &cookie).await["id"].clone();
    let drag = json!({"left":[1,2],"right":[3,9],"zodiac":false});
    let drag_line = json!({"play_id":drag_id,"play_version":1,"selections":[],"compound":true,"amount":"15","drag":drag});
    let mut bad_line = drag_line.clone();
    bad_line["drag"]["right"] = json!([1, 9]);
    let count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bets")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/slips",
            slip(&package_draw.expect, vec![drag_line.clone(), bad_line]),
            &cookie
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM bets")
            .fetch_one(&pool)
            .await
            .unwrap(),
        count_before
    );
    let body = slip(&package_draw.expect, vec![drag_line]);
    let created = ok(&app, "POST", "/api/slips", body.clone(), &cookie).await;
    assert_eq!(
        created["id"],
        ok(&app, "POST", "/api/slips", body, &cookie).await["id"]
    );
    let drag_slip_path = format!("/api/slips/{}", created["id"].as_str().unwrap());
    let receipt = ok(&app, "GET", &drag_slip_path, json!({}), &cookie).await;
    let bet = &receipt["items"][0];
    assert_eq!(bet["drag"], drag);
    assert_eq!(bet["stake"], 6000);
    assert_eq!(bet["payout"], 240000);
    assert_eq!(bet["rebate"], 600);
    let path = format!("/api/bets/{}", bet["id"].as_str().unwrap());
    ok(
        &app,
        "PUT",
        &format!("{path}/amount"),
        json!({"revision":1,"amount":"20","request_id":uuid::Uuid::new_v4()}),
        &cookie,
    )
    .await;
    let repriced = ok(&app, "GET", &path, json!({}), &cookie).await;
    assert_eq!(repriced["record"]["drag"], drag);
    assert_eq!(repriced["record"]["payout"], 320000);
    assert_eq!(repriced["record"]["rebate"], 800);
    let flown = ok(
        &app,
        "POST",
        &format!("{path}/layoffs"),
        json!({"revision":2,"amount":"5","receiver":"拖受注方","request_id":uuid::Uuid::new_v4()}),
        &cookie,
    )
    .await;
    let outgoing = sqlx::query("SELECT stake,payout,rebate,status FROM layoffs WHERE id=?")
        .bind(flown["id"].as_str().unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    use sqlx::Row;
    assert_eq!(outgoing.get::<i64, _>("stake"), 2000);
    assert_eq!(outgoing.get::<Option<i64>, _>("payout"), Some(80000));
    assert_eq!(outgoing.get::<i64, _>("rebate"), 200);
    assert_eq!(outgoing.get::<String, _>("status"), "settled");
    assert_eq!(
        call(&app, "POST", &format!("{path}/cancel"), json!({}), &cookie)
            .await
            .0,
        StatusCode::CONFLICT
    );
    ok(
        &app,
        "POST",
        &format!("/api/layoffs/{}/cancel", flown["id"].as_str().unwrap()),
        json!({}),
        &cookie,
    )
    .await;
    let receipt = ok(&app, "GET", &drag_slip_path, json!({}), &cookie).await;
    ok(
        &app,
        "POST",
        &format!("{drag_slip_path}/cancel"),
        versions(&receipt),
        &cookie,
    )
    .await;
    assert_eq!(
        ok(&app, "GET", &drag_slip_path, json!({}), &cookie).await["status"],
        "cancelled"
    );
}
