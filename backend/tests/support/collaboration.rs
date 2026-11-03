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
    // One differing rate must survive union; identical defaults collapse.
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
    assert_eq!(
        boot["plays"].as_array().unwrap().len(),
        boots[0]["plays"].as_array().unwrap().len() + 1
    );
    assert_eq!(
        boot["plays"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["rule"]["name"] == "特码")
            .count(),
        2
    );
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
    let created_b = visible(&app, "POST", "/api/slips", slip(&boot, "20", 15), b, "mine").await;
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
    // Shared configuration edits are immediately visible to the other account.
    let play = boot["plays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["rule"]["name"] == "特码")
        .unwrap();
    let mut updated_rule = play["rule"].clone();
    updated_rule["rebate_percent"] = json!("1.5");
    ok(
        &app,
        "PUT",
        &format!("/api/plays/{}", play["id"]),
        json!({"version":play["version"],"rule":updated_rule,"enabled":true}),
        b,
    )
    .await;
    assert!(
        ok(&app, "GET", "/api/bootstrap", json!({}), a).await["plays"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["rule"]["rebate_percent"] == "1.5")
    );
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
