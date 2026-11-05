use super::*;
use crate::hosted::workspaces;

async fn viewed(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    view: &str,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("x-marksix", "1")
                .header("cookie", cookie)
                .header("x-marksix-records", view)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let value = serde_json::from_slice(&to_bytes(response.into_body(), 2_000_000).await.unwrap())
        .unwrap_or(Value::Null);
    (status, value)
}
async fn visible(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    view: &str,
) -> Value {
    let (status, value) = viewed(app, method, path, body, cookie, view).await;
    assert_eq!(status, StatusCode::OK, "{view} {method} {path}: {value}");
    value
}
fn slip(boot: &Value, amount: &str, number: u8) -> Value {
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码" && p["enabled"] == true)
        .unwrap();
    json!({"period":boot["today"]["id"],"bettor":"synthetic-collaborator","request_id":uuid::Uuid::new_v4().to_string(),"items":[{"play_id":play["id"],"play_version":play["version"],"selections":[number],"compound":false,"amount":amount}]})
}
async fn own_configuration_contract(app: &Router, a: &str, b: &str) {
    let boot_a = ok(app, "GET", "/api/bootstrap", json!({}), a).await;
    let boot_b = ok(app, "GET", "/api/bootstrap", json!({}), b).await;
    let source = boot_a["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let mut rule = source["rule"].clone();
    rule["name"] = json!("合成个人专用");
    let custom_a = ok(app, "POST", "/api/plays", rule.clone(), a).await;
    let custom_b = ok(app, "POST", "/api/plays", rule.clone(), b).await;
    assert_ne!(custom_a["id"], custom_b["id"]);
    assert_eq!(
        call(
            app,
            "GET",
            &format!("/api/plays/export?id={}", custom_a["id"]),
            json!({}),
            b
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for (method, path, body) in [
        (
            "DELETE",
            format!("/api/plays/{}", custom_a["id"]),
            json!({"version":1}),
        ),
        (
            "POST",
            "/api/plays/batch".into(),
            json!({"targets":[{"id":custom_a["id"],"version":1}],"action":"delete"}),
        ),
    ] {
        assert_eq!(
            call(app, method, &path, body, b).await.0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(call(app,"POST","/api/plays/batch",json!({"targets":[{"id":custom_a["id"],"version":1},{"id":custom_b["id"],"version":1}],"action":"update","odds":"11"}),a).await.0,StatusCode::NOT_FOUND);
    assert_eq!(
        ok(
            app,
            "GET",
            &format!("/api/plays/export?id={}", custom_a["id"]),
            json!({}),
            a
        )
        .await["plays"][0]["rule"],
        rule
    );
    let mut imported = rule.clone();
    imported["odds"] = json!("12");
    ok(app,"POST","/api/plays/import",json!({"format":"marksix-play-rules","schema":1,"plays":[{"rule":imported,"enabled":true}]}),b).await;
    assert_eq!(
        ok(
            app,
            "GET",
            &format!("/api/plays/export?id={}", custom_a["id"]),
            json!({}),
            a
        )
        .await["plays"][0]["rule"],
        rule
    );
    let b_boot = ok(app, "GET", "/api/bootstrap", json!({}), b).await;
    let ids_a: Vec<_> = ok(app, "GET", "/api/bootstrap", json!({}), a).await["plays"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| json!({"id":p["id"],"version":p["version"]}))
        .collect();
    let mut forged = ids_a.clone();
    forged[0] = json!({"id":custom_b["id"],"version":2});
    assert_eq!(
        call(app, "PUT", "/api/plays/order", json!({"plays":forged}), a)
            .await
            .0,
        StatusCode::CONFLICT
    );
    ok(
        app,
        "PUT",
        "/api/plays/order",
        json!({"plays":ids_a.into_iter().rev().collect::<Vec<_>>()}),
        a,
    )
    .await;
    assert_eq!(
        ok(app, "GET", "/api/bootstrap", json!({}), b).await["plays"],
        b_boot["plays"]
    );
    let foreign = slip(&boot_a, "1", 31);
    let quote = ok(
        app,
        "POST",
        "/api/slips/preview",
        json!({"period":foreign["period"],"bettor":foreign["bettor"],"items":foreign["items"]}),
        b,
    )
    .await;
    assert_eq!(quote["valid"], false);
    assert_eq!(
        call(app, "POST", "/api/slips", foreign, b).await.0,
        StatusCode::CONFLICT
    );
    for (cookie, boot, mode) in [(a, &boot_a, "each"), (b, &boot_b, "total")] {
        let mut request = slip(boot, "1", 29);
        let line = &request["items"][0];
        let preference = json!({"play_id":line["play_id"],"play_version":line["play_version"],"amount_mode":mode});
        let mut alias = preference.clone();
        alias["alias"] = json!("本人简称");
        request["entry_mode"] = json!("text");
        request["text_preferences"] = json!([alias]);
        request["bettor_preference"] = preference;
        ok(app, "POST", "/api/slips", request, cookie).await;
    }
    let aliases_a = ok(app, "GET", "/api/text-entry/preferences", json!({}), a).await;
    let aliases_b = ok(app, "GET", "/api/text-entry/preferences", json!({}), b).await;
    let alias_a = aliases_a
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["alias"] == "本人简称")
        .unwrap();
    let alias_b = aliases_b
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["alias"] == "本人简称")
        .unwrap();
    assert_ne!(alias_a["play_id"], alias_b["play_id"]);
    assert_eq!(alias_a["amount_mode"], "each");
    assert_eq!(alias_b["amount_mode"], "total");
    for (cookie, alias) in [(a, alias_a), (b, alias_b)] {
        let preference = ok(
            app,
            "POST",
            "/api/text-entry/bettor-preference",
            json!({"bettor":"synthetic-collaborator"}),
            cookie,
        )
        .await;
        assert_eq!(preference["preference"]["play_id"], alias["play_id"]);
        assert_eq!(
            preference["preference"]["amount_mode"],
            alias["amount_mode"]
        );
    }
    ok(
        app,
        "DELETE",
        "/api/text-entry/preferences/%E6%9C%AC%E4%BA%BA%E7%AE%80%E7%A7%B0",
        json!({}),
        a,
    )
    .await;
    assert_eq!(
        ok(app, "GET", "/api/text-entry/preferences", json!({}), b).await,
        aliases_b
    );
}
#[tokio::test]
#[ignore = "requires isolated marksix_test and provision database identity"]
async fn future_only_collaboration_ownership_shared_edits_configuration_and_lifecycle() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    let provision_url = std::env::var("TEST_PROVISION_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test") && provision_url.ends_with("/marksix_test"));
    let pool = crate::store::connect(&url).await.unwrap();
    let provision = sqlx::MySqlPool::connect(&provision_url).await.unwrap();
    let root = std::env::temp_dir().join(format!("marksix-collaboration-{}", uuid::Uuid::new_v4()));
    let control = Control::new(pool.clone(), Some(provision.clone()), false, root.clone())
        .await
        .unwrap();
    let password = uuid::Uuid::new_v4().to_string();
    let admin_name = format!("collaboration-{}", uuid::Uuid::new_v4());
    let admin_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO authority_administrators(id,username,password_hash) VALUES(?,?,?)")
        .bind(&admin_id)
        .bind(&admin_name)
        .bind(hash_password(password.clone()).await.unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let admin = management::router(control.clone());
    let owner = login(&admin, &admin_name, &password).await;
    let mut registry = Registry::new(control.clone()).unwrap();
    registry.clock = std::sync::Arc::new(|| {
        chrono::NaiveDate::from_ymd_opt(2026, 1, 2)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    });
    let app = portal::router(registry.clone());
    let mut accounts = vec![];
    let mut cookies = vec![];
    let mut boots = vec![];
    let mut old_slips = vec![];
    for (index, amount) in ["100", "200", "300"].iter().enumerate() {
        let name = format!("collab-{index}-{}", uuid::Uuid::new_v4());
        let created = ok(
            &admin,
            "POST",
            "/api/accounts",
            json!({"username":name,"password":password,"permanent":true}),
            &owner,
        )
        .await;
        let account: Account = sqlx::query_as("SELECT * FROM hosted_accounts WHERE id=?")
            .bind(created["id"].as_str().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
        let cookie = login(&app, &name, &password).await;
        let boot = ok(&app, "GET", "/api/bootstrap", json!({}), &cookie).await;
        old_slips.push(
            ok(&app, "POST", "/api/slips", slip(&boot, amount, 3), &cookie).await["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
        accounts.push(account);
        cookies.push(cookie);
        boots.push(boot);
    }
    // Each member retains independent definitions, including identical names/settings.
    let changed = boots[1]["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let mut rule = changed["rule"].clone();
    rule["odds"] = json!("48");
    ok(
        &app,
        "PUT",
        &format!("/api/plays/{}", changed["id"]),
        json!({"version":changed["version"],"rule":rule,"enabled":true}),
        &cookies[1],
    )
    .await;
    for account in &accounts[..2] {
        let private = registry.lease(account).await.unwrap();
        let (id,version): (i64,i64) = sqlx::query_as("SELECT id,version FROM plays WHERE JSON_UNQUOTE(JSON_EXTRACT(rule,'$.name'))='特码' LIMIT 1").fetch_one(&private.pool).await.unwrap();
        sqlx::query("INSERT INTO text_entry_preferences(alias,play_id,play_version,amount_mode) VALUES('个人原简称',?,?, 'each')").bind(id).bind(version).execute(&private.pool).await.unwrap();
        sqlx::query("INSERT INTO bettor_play_preferences(bettor,play_id,amount_mode) VALUES('synthetic-collaborator',?,?)")
            .bind(id).bind(if account.id == accounts[0].id { "each" } else { "total" }).execute(&private.pool).await.unwrap();
    }
    let path = format!("/api/accounts/{}/link", accounts[0].id);
    let link = json!({"account_id":accounts[1].id});
    assert_eq!(
        call(&admin, "POST", &path, link.clone(), "").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &admin,
            "POST",
            &path,
            json!({"account_id":accounts[0].id}),
            &owner
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // Failed provisioning is visible and retryable, with private books intact.
    let mut broken = control.clone();
    broken.provision = None;
    assert_eq!(
        call(
            &management::router(broken),
            "POST",
            &path,
            link.clone(),
            &owner
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let reserved: String =
        sqlx::query_scalar("SELECT workspace_id FROM hosted_accounts WHERE id=?")
            .bind(&accounts[0].id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        workspaces::get(&control, &reserved).await.unwrap().state,
        "failed"
    );
    let linked = ok(&admin, "POST", &path, link.clone(), &owner).await;
    assert_eq!(linked["workspace_id"], reserved);
    for cookie in &cookies[..2] {
        assert_eq!(
            call(&app, "GET", "/api/bootstrap", json!({}), cookie)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    for index in 0..2 {
        cookies[index] = login(&app, &accounts[index].username, &password).await;
    }
    let a = &cookies[0];
    let b = &cookies[1];
    let c = &cookies[2];
    let session = ok(&app, "GET", "/api/session", json!({}), a).await;
    assert_eq!(
        session["collaboration"]["members"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(!session.to_string().contains("database_password"));
    let boot = ok(&app, "GET", "/api/bootstrap", json!({}), a).await;
    assert_eq!(boot["day"]["totals"]["stake"], 0);
    let boot_b = ok(&app, "GET", "/api/bootstrap", json!({}), b).await;
    for personal in [&boot, &boot_b] {
        assert_eq!(
            personal["plays"].as_array().unwrap().len(),
            boots[0]["plays"].as_array().unwrap().len()
        );
        assert_eq!(
            personal["plays"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["rule"]["name"] == "特码")
                .count(),
            1
        );
    }
    assert!(boot["plays"].as_array().unwrap().iter().all(|p| {
        !boot_b["plays"]
            .as_array()
            .unwrap()
            .iter()
            .any(|other| other["id"] == p["id"])
    }));
    assert_eq!(
        boot_b["plays"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["rule"]["name"] == "特码")
            .unwrap()["rule"]["odds"],
        "48"
    );
    for (cookie, personal, mode) in [(a, &boot, "each"), (b, &boot_b, "total")] {
        let preferences = ok(
            &app,
            "GET",
            "/api/text-entry/preferences",
            json!({}),
            cookie,
        )
        .await;
        assert_eq!(preferences.as_array().unwrap().len(), 1);
        assert!(
            personal["plays"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["id"] == preferences[0]["play_id"])
        );
        let rate = ok(
            &app,
            "POST",
            "/api/text-entry/bettor-preference",
            json!({"bettor":"synthetic-collaborator"}),
            cookie,
        )
        .await;
        assert_eq!(rate["preference"]["amount_mode"], mode);
        assert!(
            personal["plays"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["id"] == rate["preference"]["play_id"])
        );
        assert_eq!(
            visible(&app, "GET", "/api/bootstrap", json!({}), cookie, "mine").await["plays"],
            personal["plays"]
        );
    }
    let period = boot["today"]["id"].as_str().unwrap();
    for (index, cookie) in [a, b].iter().enumerate() {
        let history = visible(&app, "GET", "/api/bootstrap", json!({}), cookie, "history").await;
        assert_eq!(history["day"]["totals"]["stake"], (index + 1) * 10000);
        assert_eq!(
            viewed(
                &app,
                "POST",
                "/api/slips",
                slip(&history, "10", 15),
                cookie,
                "history"
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            viewed(
                &app,
                "GET",
                &format!("/api/slips/{}", old_slips[1 - index]),
                json!({}),
                cookie,
                "history"
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/api/slips/{}", old_slips[index]),
                json!({}),
                cookie
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    let request_a = slip(&boot, "10", 3);
    let created_a = ok(&app, "POST", "/api/slips", request_a.clone(), a).await;
    assert_eq!(
        ok(&app, "POST", "/api/slips", request_a.clone(), a).await["id"],
        created_a["id"]
    );
    assert_eq!(
        call(&app, "POST", "/api/slips", request_a, b).await.0,
        StatusCode::CONFLICT
    );
    let request_b = slip(&boot_b, "20", 15);
    let created_b = visible(&app, "POST", "/api/slips", request_b.clone(), b, "mine").await;
    for (cookie, view, stake, count) in [
        (a, "shared", 3000, 2),
        (b, "shared", 3000, 2),
        (a, "mine", 1000, 1),
        (b, "mine", 2000, 1),
    ] {
        let rows = visible(
            &app,
            "POST",
            "/api/records/search",
            json!({"period":period,"combined":true}),
            cookie,
            view,
        )
        .await;
        assert_eq!(rows["total"], count);
        let day = visible(
            &app,
            "GET",
            &format!("/api/days/{period}"),
            json!({}),
            cookie,
            view,
        )
        .await;
        assert_eq!(day["totals"]["stake"], stake);
        let stats = visible(
            &app,
            "GET",
            &format!("/api/periods/{period}/statistics?combined=true"),
            json!({}),
            cookie,
            view,
        )
        .await;
        assert_eq!(stats["incoming"]["stake"], stake);
        let export = visible(
            &app,
            "GET",
            &format!("/api/periods/{period}/bettor-export?combined=true"),
            json!({}),
            cookie,
            view,
        )
        .await;
        assert_eq!(export["bettors"].as_array().unwrap().len(), 1);
        assert_eq!(export["bettors"][0]["totals"]["stake"], stake);
        let distribution = visible(
            &app,
            "GET",
            &format!("/api/periods/{period}/received-distribution?combined=true"),
            json!({}),
            cookie,
            view,
        )
        .await;
        assert_eq!(
            distribution["special"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_i64().unwrap())
                .sum::<i64>(),
            stake
        );
        for (market, expected) in [("macau", stake), ("hk", 0)] {
            let distribution = visible(
                &app,
                "GET",
                &format!(
                    "/api/periods/{period}/received-distribution?combined=true&market={market}"
                ),
                json!({}),
                cookie,
                view,
            )
            .await;
            assert_eq!(
                distribution["special"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_i64().unwrap())
                    .sum::<i64>(),
                expected
            );
        }
    }
    assert_eq!(
        viewed(&app, "GET", "/api/bootstrap", json!({}), c, &reserved)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/slips/{}", created_a["id"].as_str().unwrap()),
            json!({}),
            c
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &admin,
            "POST",
            &path,
            json!({"account_id":accounts[2].id}),
            &owner
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // A collaborator may correct/cancel another member's entries; ownership stays original.
    let detail = ok(
        &app,
        "GET",
        &format!("/api/slips/{}", created_a["id"].as_str().unwrap()),
        json!({}),
        b,
    )
    .await;
    let bet = &detail["items"][0];
    ok(
        &app,
        "PUT",
        &format!("/api/bets/{}/amount", bet["id"].as_str().unwrap()),
        json!({"request_id":uuid::Uuid::new_v4().to_string(),"revision":1,"amount":"15"}),
        b,
    )
    .await;
    assert_eq!(
        visible(
            &app,
            "GET",
            &format!("/api/days/{period}"),
            json!({}),
            a,
            "mine"
        )
        .await["totals"]["stake"],
        1500
    );
    let cancel = json!({"versions":[{"id":bet["id"],"revision":2}]});
    ok(
        &app,
        "POST",
        &format!("/api/slips/{}/cancel", created_a["id"].as_str().unwrap()),
        cancel,
        b,
    )
    .await;
    assert_eq!(
        ok(&app, "GET", &format!("/api/days/{period}"), json!({}), a).await["totals"]["stake"],
        2000
    );
    // Personal definitions may be changed only by their owner; shared records remain collaborative.
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let personal_b = boot_b["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let mut updated_rule = personal_b["rule"].clone();
    updated_rule["rebate_percent"] = json!("1.5");
    assert_eq!(
        call(
            &app,
            "PUT",
            &format!("/api/plays/{}", play["id"]),
            json!({"version":play["version"],"rule":updated_rule,"enabled":true}),
            b
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    ok(
        &app,
        "PUT",
        &format!("/api/plays/{}", personal_b["id"]),
        json!({"version":personal_b["version"],"rule":updated_rule,"enabled":true}),
        b,
    )
    .await;
    assert!(
        ok(&app, "GET", "/api/bootstrap", json!({}), a).await["plays"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["rule"]["rebate_percent"] != "1.5")
    );
    // Upgrade an already-deployed shared configuration without rewriting receipts.
    let migration_workspace = workspaces::get(&control, &reserved).await.unwrap();
    let legacy = registry
        .collaborative(&accounts[0], &migration_workspace)
        .await
        .unwrap();
    let before = ok(
        &app,
        "GET",
        &format!("/api/slips/{}", created_b["id"].as_str().unwrap()),
        json!({}),
        b,
    )
    .await;
    sqlx::query("UPDATE plays SET owner_account_id=NULL")
        .execute(&legacy.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM account_play_initializations")
        .execute(&legacy.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM text_entry_preferences WHERE owner_account_id=?")
        .bind(&accounts[1].id)
        .execute(&legacy.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE text_entry_preferences SET owner_account_id=''")
        .execute(&legacy.pool)
        .await
        .unwrap();
    // Legacy preferences were shared; ownership did not yet exist.
    sqlx::query("DELETE FROM bettor_play_preferences WHERE owner_account_id=?")
        .bind(&accounts[1].id)
        .execute(&legacy.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE bettor_play_preferences SET owner_account_id=''")
        .execute(&legacy.pool)
        .await
        .unwrap();
    let cold = Registry::new(control.clone()).unwrap();
    assert_eq!(
        cold.collaborative(&accounts[0], &migration_workspace)
            .await
            .err()
            .unwrap()
            .0,
        StatusCode::CONFLICT
    );
    for account in &accounts[..2] {
        let source = registry.lease(account).await.unwrap();
        workspaces::initialize_account_plays(&legacy.pool, &source.pool, &account.id)
            .await
            .unwrap();
        workspaces::initialize_account_plays(&legacy.pool, &source.pool, &account.id)
            .await
            .unwrap();
    }
    assert_eq!(
        ok(
            &app,
            "GET",
            &format!("/api/slips/{}", created_b["id"].as_str().unwrap()),
            json!({}),
            a
        )
        .await,
        before
    );
    assert_eq!(
        ok(&app, "POST", "/api/slips", request_b.clone(), b).await["id"],
        created_b["id"]
    );
    let mut fresh_old_request = request_b.clone();
    fresh_old_request["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    assert_eq!(
        call(&app, "POST", "/api/slips", fresh_old_request, b)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let after_a = ok(&app, "GET", "/api/bootstrap", json!({}), a).await;
    let after_b = ok(&app, "GET", "/api/bootstrap", json!({}), b).await;
    for personal in [&after_a, &after_b] {
        assert_eq!(
            personal["plays"].as_array().unwrap().len(),
            boots[0]["plays"].as_array().unwrap().len()
        );
        assert!(
            personal["plays"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p["id"] != play["id"] && p["id"] != personal_b["id"])
        );
    }
    assert_eq!(
        after_b["plays"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["rule"]["name"] == "特码")
            .unwrap()["rule"]["rebate_percent"],
        boots[1]["plays"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["rule"]["name"] == "特码")
            .unwrap()["rule"]["rebate_percent"]
    );
    drop(legacy);
    own_configuration_contract(&app, a, b).await;
    // Private and collaborative principals cannot read each other's schemas.
    let workspace = workspaces::get(&control, &reserved).await.unwrap();
    let shared = registry
        .collaborative(&accounts[0], &workspace)
        .await
        .unwrap();
    assert!(
        sqlx::query(&format!(
            "SELECT * FROM `{}`.bets",
            accounts[2].database_name
        ))
        .fetch_all(&shared.pool)
        .await
        .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT created_by FROM bets WHERE slip_id=?")
            .bind(created_b["id"].as_str().unwrap())
            .fetch_one(&shared.pool)
            .await
            .unwrap(),
        accounts[1].id
    );
    drop(shared);
    let clear = json!({"password":password,"confirmation":"永久清空历史记录","request_id":uuid::Uuid::new_v4().to_string()});
    ok(
        &admin,
        "POST",
        "/api/customer/history/clear",
        clear.clone(),
        a,
    )
    .await;
    ok(&admin, "POST", "/api/customer/history/clear", clear, a).await;
    assert!(
        root.join("erasures")
            .join(format!("{reserved}.json"))
            .is_file()
    );
    assert_eq!(
        visible(&app, "GET", "/api/bootstrap", json!({}), a, "history").await["day"]["totals"]["stake"],
        10000
    );
    // Removing one member preserves the shared ledger for the survivor.
    for (index, account) in accounts.iter().enumerate() {
        ok(
            &admin,
            "PUT",
            &format!("/api/accounts/{}", accounts[index].id),
            json!({"action":"delete","confirmation":format!("永久删除 {}",account.username)}),
            &owner,
        )
        .await;
        if index == 0 {
            assert_eq!(
                workspaces::get(&control, &reserved).await.unwrap().state,
                "ready"
            );
            ok(&app, "GET", "/api/bootstrap", json!({}), b).await;
        }
    }
    assert!(workspaces::get(&control, &reserved).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name=?"
        )
        .bind(&workspace.database_name)
        .fetch_one(&provision)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM hosted_deletions WHERE account_id=?")
            .bind(&reserved)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("DELETE FROM authority_administrators WHERE id=?")
        .bind(admin_id)
        .execute(&pool)
        .await
        .unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
    pool.close().await;
    provision.close().await;
}
