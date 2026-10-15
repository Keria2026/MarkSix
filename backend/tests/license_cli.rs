//! The owner's real executable must create signed, routable codes only with
//! authority credentials and a private key. No production private key is used.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, SigningKey};
use marksix::store;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    path::PathBuf,
    process::{Command, Output},
};

struct TestKey(PathBuf);
impl Drop for TestKey {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn run(args: &[&str], url: &str, key: &TestKey, public_url: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_marksix"));
    command
        .args(args)
        .env("AUTHORITY_DATABASE_URL", url)
        .env("LICENSE_SIGNING_KEY_FILE", &key.0)
        .env_remove("PUBLIC_AUTHORITY_URL")
        .env_remove("LICENSE_DISCOVERY_URL");
    if let Some(url) = public_url {
        command.env("PUBLIC_AUTHORITY_URL", url).env(
            "LICENSE_DISCOVERY_URL",
            "https://discovery.example.com/route.json",
        );
    }
    command.output().unwrap()
}
#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL ending in /marksix_test"]
async fn owner_cli_signs_durations_absolute_expiry_binding_and_migration() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    assert!(url.ends_with("/marksix_test"));
    let pool = store::connect(&url).await.unwrap();
    let key = SigningKey::generate(&mut rand::rngs::OsRng);
    let path =
        std::env::temp_dir().join(format!("marksix-owner-test-{}.hex", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options
        .open(&path)
        .unwrap()
        .write_all(hex::encode(key.to_bytes()).as_bytes())
        .unwrap();
    let file = TestKey(path);
    let binding = "a".repeat(64);
    let issued = run(
        &["--license-issue", "30", "--bind", &binding],
        &url,
        &file,
        Some("https://first.example.com"),
    );
    assert!(
        issued.status.success(),
        "{}",
        String::from_utf8_lossy(&issued.stderr)
    );
    let code = String::from_utf8(issued.stdout).unwrap();
    let parts = code.trim().split('.').collect::<Vec<_>>();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0], "MSX1");
    let bytes = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
    key.verifying_key()
        .verify_strict(
            &bytes,
            &Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap(),
        )
        .unwrap();
    let claims: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(claims["authority_url"], "https://first.example.com");
    assert_eq!(
        claims["discovery_url"],
        "https://discovery.example.com/route.json"
    );
    let id = hex::encode(Sha256::digest(claims["token"].as_str().unwrap().as_bytes()));
    let row = sqlx::query(
        "SELECT valid_days,intended_binding,redeemed_at FROM license_codes WHERE code_hash=?",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<i32, _>("valid_days"), 30);
    assert_eq!(row.get::<String, _>("intended_binding"), binding);
    assert!(row.get::<Option<i64>, _>("redeemed_at").is_none());
    let expiry = chrono::Utc::now() + chrono::Duration::days(45);
    let deadline = expiry.to_rfc3339();
    let issued = run(
        &["--license-until", &deadline],
        &url,
        &file,
        Some("https://second.example.com"),
    );
    assert!(issued.status.success());
    let code = String::from_utf8(issued.stdout).unwrap();
    let payload: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(code.trim().split('.').nth(1).unwrap())
            .unwrap(),
    )
    .unwrap();
    let id = hex::encode(Sha256::digest(
        payload["token"].as_str().unwrap().as_bytes(),
    ));
    let actual: i64 = sqlx::query_scalar("SELECT expires_at FROM license_codes WHERE code_hash=?")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(actual, expiry.timestamp());
    let route = run(
        &["--license-route", "2"],
        &url,
        &file,
        Some("https://second.example.com"),
    );
    assert!(route.status.success());
    let signed: Value = serde_json::from_slice(&route.stdout).unwrap();
    let bytes = hex::decode(signed["payload"].as_str().unwrap()).unwrap();
    key.verifying_key()
        .verify_strict(
            &bytes,
            &Signature::from_slice(&hex::decode(signed["signature"].as_str().unwrap()).unwrap())
                .unwrap(),
        )
        .unwrap();
    let route: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(route["revision"], 2);
    assert_eq!(route["authority_url"], "https://second.example.com");
    assert!(
        !run(&["--license-issue", "30"], &url, &file, None)
            .status
            .success()
    );
    for args in [
        vec!["--license-issue", "0"],
        vec!["--license-issue", "3651"],
        vec!["--license-until", "2000-01-01T00:00:00Z"],
        vec!["--license-route", "0"],
    ] {
        assert!(
            !run(&args, &url, &file, Some("https://first.example.com"))
                .status
                .success()
        );
    }
    pool.close().await;
}
