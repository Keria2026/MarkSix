use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use marksix::{api, store::AppState};
use tower::ServiceExt;

#[tokio::test]
async fn native_frontend_and_api_boundaries() {
    let directory = std::env::temp_dir().join(format!("marksix-static-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(
        directory.join("index.html"),
        "<!doctype html><html>MarkSix</html>",
    )
    .unwrap();
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .connect_lazy("mysql://test:test@localhost/unused")
        .unwrap();
    let app = api::router_with_frontend(AppState::new(pool).unwrap(), Some(directory.clone()));
    let response = app
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-frame-options"], "DENY");
    assert!(
        response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    for path in ["/api/not-a-route", "/missing.js", "/../config.json"] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}
