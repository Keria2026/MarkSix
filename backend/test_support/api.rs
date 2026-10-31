use super::*;
use axum::{
    body::{Body, to_bytes},
    http::Method,
};
use tower::ServiceExt;

#[tokio::test]
async fn every_response_including_rejected_writes_has_security_headers() {
    let app = Router::new()
        .route(
            "/resource",
            get(|| async { "read" }).post(|| async { "written" }),
        )
        .layer(middleware::from_fn(security_headers));
    for (method, marker, expected) in [
        (Method::GET, None, StatusCode::OK),
        (Method::HEAD, None, StatusCode::OK),
        (Method::POST, None, StatusCode::FORBIDDEN),
        (Method::POST, Some("0"), StatusCode::FORBIDDEN),
        (Method::POST, Some("1"), StatusCode::OK),
        (Method::OPTIONS, None, StatusCode::METHOD_NOT_ALLOWED),
    ] {
        let mut request = Request::builder().uri("/resource").method(method);
        if let Some(marker) = marker {
            request = request.header("X-Marksix", marker);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()["x-frame-options"], "DENY");
        assert_eq!(response.headers()["referrer-policy"], "same-origin");
        assert!(
            response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        if expected == StatusCode::FORBIDDEN {
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            let json: Value = serde_json::from_slice(&body).unwrap();
            assert!(json["error"].as_str().unwrap().contains("请求校验失败"));
        }
    }
}

#[tokio::test]
async fn authentication_limits_reject_before_database_or_expensive_hashing() {
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .connect_lazy("mysql://unused:unused@127.0.0.1/unused")
        .unwrap();
    let state = AppState::new(pool).unwrap();
    for (username, password) in [("x".repeat(241), "x".into()), ("x".into(), "x".repeat(257))] {
        assert_eq!(
            verify_admin(&state, Login { username, password })
                .await
                .unwrap_err()
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let permit = state.auth_gate.clone().acquire_owned().await.unwrap();
    state
        .login_attempts
        .lock()
        .await
        .push_back(Instant::now() - Duration::from_secs(61));
    assert_eq!(
        verify_admin(
            &state,
            Login {
                username: "test".into(),
                password: "test".into()
            }
        )
        .await
        .unwrap_err()
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(state.login_attempts.lock().await.len(), 1);
    drop(permit);
    state
        .login_attempts
        .lock()
        .await
        .extend([Instant::now(); 12]);
    assert_eq!(
        verify_admin(
            &state,
            Login {
                username: "test".into(),
                password: "test".into()
            }
        )
        .await
        .unwrap_err()
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        "other=1; marksix_session=synthetic; final=2"
            .parse()
            .unwrap(),
    );
    assert_eq!(token(&headers), Some("synthetic"));
    let mut secure = state.clone();
    secure.secure_cookie = true;
    assert!(cookie(&secure, "synthetic", 10).ends_with("; Secure"));
}
