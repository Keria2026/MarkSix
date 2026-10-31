//! Production binary startup and internal authority forwarding on disposable databases.
use serde_json::{Value, json};
use std::{
    process::{Child, Command, Stdio},
    time::Duration,
};
struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        // SIGTERM exercises production graceful shutdown and flushes coverage profiles.
        unsafe {
            libc::kill(self.0.id() as i32, libc::SIGTERM);
        }
        let _ = self.0.wait();
    }
}
fn address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().to_string()
}
async fn ready(client: &reqwest::Client, host: &str) {
    for _ in 0..100 {
        if client
            .get(format!("http://{host}/api/health"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("production server did not become ready");
}
async fn send(
    client: &reqwest::Client,
    host: &str,
    path: &str,
    body: Value,
    cookie: &str,
) -> reqwest::Response {
    client
        .post(format!("http://{host}/api{path}"))
        .header("X-Marksix", "1")
        .header("Cookie", cookie)
        .json(&body)
        .send()
        .await
        .unwrap()
}
async fn login(client: &reqwest::Client, host: &str, name: &str) -> String {
    let response = send(
        client,
        host,
        "/login",
        json!({"username":name,"password":"synthetic-process-password"}),
        "",
    )
    .await;
    assert!(response.status().is_success());
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into()
}
#[tokio::test]
#[ignore = "requires isolated marksix_test and provision database identity"]
async fn production_modes_forward_history_and_password_then_shutdown_cleanly() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test"));
    let provision = std::env::var("TEST_PROVISION_DATABASE_URL").unwrap();
    assert!(provision.ends_with("/marksix_test"));
    let pool = marksix::store::connect(&url).await.unwrap();
    for table in [
        "authority_audit",
        "authority_sessions",
        "authority_administrators",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let root = std::env::temp_dir().join(format!("marksix-process-{}", uuid::Uuid::new_v4()));
    let authority = address();
    let portal = address();
    let spawn = |mode: &str, bind: &str| {
        Server(
            Command::new(env!("CARGO_BIN_EXE_marksix"))
                .arg(mode)
                .env("CONTROL_DATABASE_URL", &url)
                .env("PROVISION_DATABASE_URL", &provision)
                .env("BIND_ADDR", bind)
                .env("AUTHORITY_ADMIN_USERNAME", "process-owner")
                .env("AUTHORITY_ADMIN_PASSWORD", "synthetic-process-password")
                .env("BACKUP_ROOT", &root)
                .env("SECURE_COOKIE", "false")
                .env("INTERNAL_AUTHORITY_URL", format!("http://{authority}"))
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        )
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let owner_server = spawn("--hosted-authority", &authority);
    ready(&client, &authority).await;
    let owner = login(&client, &authority, "process-owner").await;
    let response = send(
        &client,
        &authority,
        "/accounts",
        json!({"username":"process-customer","password":"synthetic-process-password"}),
        &owner,
    )
    .await;
    assert!(response.status().is_success());
    let account: Value = response.json().await.unwrap();
    let response = client
        .put(format!(
            "http://{authority}/api/accounts/{}",
            account["id"].as_str().unwrap()
        ))
        .header("X-Marksix", "1")
        .header("Cookie", &owner)
        .json(&json!({"action":"permanent","enabled":true}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let customer_server = spawn("--hosted", &portal);
    ready(&client, &portal).await;
    assert!(
        Command::new(env!("CARGO_BIN_EXE_marksix"))
            .arg("--hosted-healthcheck")
            .env("BIND_ADDR", &portal)
            .status()
            .unwrap()
            .success()
    );
    let customer = login(&client, &portal, "process-customer").await;
    let response = client
        .get(format!("http://{portal}/api/bootstrap"))
        .header("Cookie", &customer)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let response = send(
        &client,
        &portal,
        "/history/clear",
        json!({
            "password": "synthetic-process-password",
            "confirmation": "永久清空历史记录",
            "request_id": uuid::Uuid::new_v4().to_string()
        }),
        &customer,
    )
    .await;
    assert!(
        response.status().is_success(),
        "{}",
        response.text().await.unwrap()
    );
    let response = send(
        &client,
        &portal,
        "/account/password",
        json!({
            "old_password": "synthetic-process-password",
            "new_password": "synthetic-process-new-password"
        }),
        &customer,
    )
    .await;
    assert!(response.status().is_success());
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    let response = send(&client, &portal, "/logout", json!({}), &customer).await;
    assert!(response.status().is_success());
    let response = client
        .put(format!(
            "http://{authority}/api/accounts/{}",
            account["id"].as_str().unwrap()
        ))
        .header("X-Marksix", "1")
        .header("Cookie", &owner)
        .json(&json!({"action":"delete","confirmation":"永久删除 process-customer"}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    drop(customer_server);
    drop(owner_server);
    pool.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn binary_rejects_unselected_mode_and_documents_supported_modes() {
    for flag in ["--help", "-h"] {
        let output = Command::new(env!("CARGO_BIN_EXE_marksix"))
            .arg(flag)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .contains("--hosted-authority")
        );
    }
    let output = Command::new(env!("CARGO_BIN_EXE_marksix"))
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("Choose --hosted")
    );
}
