//! Destructive upgrade fixture, run separately before workflow/e2e tests.
use marksix::{domain::*, store, worker};
use serde_json::{Value, json};
use sqlx::{Row, mysql::MySqlPoolOptions, types::Json};
use std::borrow::Cow;

#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL ending in /marksix_test"]
async fn v1_upgrade_preserves_snapshots_and_settlement() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test"));
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    for table in [
        "hosted_sessions",
        "hosted_codes",
        "hosted_accounts",
        "authority_sessions",
        "authority_administrators",
        "authority_audit",
        "hosted_deletions",
        "history_clear_requests",
        "client_license",
        "license_codes",
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
        "audit_events",
        "_sqlx_migrations",
    ] {
        sqlx::query(&format!("DROP TABLE IF EXISTS {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let all = sqlx::migrate!("./migrations");
    let first = sqlx::migrate::Migrator {
        migrations: Cow::Owned(vec![all.iter().next().unwrap().clone()]),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    first.run(&pool).await.unwrap();
    // Authentic v1 JSON: the new fields do not exist and 49 was an odd number.
    let old_rule = json!({"name":"旧单双","kind":"parity","scope":"special","condition":"all","relation":"eq","quantity":1,"combination_size":1,"odds":"2","rebate_percent":"2","special_odds":null});
    let old_atoms = json!([{"options":[1],"mask":2,"kind":"parity","scope":"special","condition":"all","stake":10000,"payout":20000,"rebate":200,"odds":"2"}]);
    sqlx::query("INSERT INTO plays(id,version,rule) VALUES(1,1,?)")
        .bind(Json(&old_rule))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO play_versions(play_id,version,rule) VALUES(1,1,?)")
        .bind(Json(&old_rule))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO periods(id,business_date,close_time,mapping) VALUES('2026287','2026-10-14','21:28',?)").bind(Json(Mapping::default())).execute(&pool).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO bets(id,request_id,request_hash,period_id,play_id,play_version,rule,selections,compound,amount,unit_count,stake,rebate,exposure,natal,atoms) VALUES(?,?,?,'2026287',1,1,?,JSON_ARRAY(1),false,10000,1,10000,200,20000,6,?)")
        .bind(&id).bind(uuid::Uuid::new_v4().to_string()).bind("a".repeat(64)).bind(Json(&old_rule)).bind(Json(&old_atoms)).execute(&pool).await.unwrap();
    // Reach the last released schema, then simulate an old completed risk cache.
    let released = sqlx::migrate::Migrator {
        migrations: Cow::Owned(all.iter().filter(|m| m.version < 8).cloned().collect()),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    released.run(&pool).await.unwrap();
    sqlx::query("UPDATE periods SET risk_status='complete',risk_result=JSON_OBJECT('legacy',true),risk_version=0,risk_requested_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 DAY),risk_started_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 DAY),risk_finished_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 DAY) WHERE id='2026287'")
        .execute(&pool).await.unwrap();
    pool.close().await;
    let pool = store::connect(&url).await.unwrap(); // Apply real production migrations.
    let refreshed = sqlx::query("SELECT risk_status,risk_result,risk_started_at,risk_finished_at,TIMESTAMPDIFF(SECOND,risk_requested_at,UTC_TIMESTAMP(6)) age FROM periods WHERE id='2026287'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(refreshed.get::<String, _>("risk_status"), "queued");
    assert!(
        refreshed
            .get::<Option<Json<Value>>, _>("risk_result")
            .is_none()
    );
    assert!(
        refreshed
            .get::<Option<chrono::NaiveDateTime>, _>("risk_started_at")
            .is_none()
    );
    assert!(
        refreshed
            .get::<Option<chrono::NaiveDateTime>, _>("risk_finished_at")
            .is_none()
    );
    assert!((0..10).contains(&refreshed.get::<i64, _>("age")));
    let row = sqlx::query("SELECT rule,atoms,bettor,revision FROM bets WHERE id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<Json<Value>, _>("rule").0, old_rule);
    assert_eq!(row.get::<Json<Value>, _>("atoms").0, old_atoms);
    assert_eq!(row.get::<String, _>("bettor"), "");
    assert_eq!(row.get::<i64, _>("revision"), 1);
    let current: Json<Rule> = sqlx::query_scalar("SELECT rule FROM plays WHERE id=1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!current.compound_enabled);
    let state = store::AppState::new(pool.clone()).unwrap();
    worker::start_risk(&state).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !state.cancellations.lock().await.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let status: String = sqlx::query_scalar("SELECT risk_status FROM periods WHERE id='2026287'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        status, "complete",
        "migration must grant a fresh calculation budget"
    );
    let mut draw = Draw::predicted([1, 2, 3, 4, 5, 6, 49], &Mapping::default());
    draw.expect = "2026287".into();
    draw.open_time = chrono::NaiveDate::from_ymd_opt(2026, 10, 14)
        .unwrap()
        .and_hms_opt(21, 32, 32)
        .unwrap();
    worker::accept_draw(&state, &draw, &json!({"fixture":"v1-upgrade"}))
        .await
        .unwrap();
    let row = sqlx::query("SELECT payout,rebate,void_stake FROM bets WHERE id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<i64, _>("payout"), 20000);
    assert_eq!(row.get::<i64, _>("rebate"), 200);
    assert_eq!(row.get::<i64, _>("void_stake"), 0);
    pool.close().await;
    store::connect(&url).await.unwrap().close().await; // Migrations are repeatable.
}
