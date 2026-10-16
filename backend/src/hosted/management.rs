use super::accounts::*;
use crate::api::{ApiResult, digest};
use axum::{
    Extension, Json, Router,
    extract::{Path, Request, State},
    http::{HeaderMap, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{ConnectOptions, MySqlPool, Row};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

pub async fn serve(pool: MySqlPool, address: &str) -> anyhow::Result<()> {
    let provision_url = std::env::var("PROVISION_DATABASE_URL")?;
    let provision = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect_with(
            provision_url
                .parse::<sqlx::mysql::MySqlConnectOptions>()?
                .disable_statement_logging(),
        )
        .await?;
    let control = Control::new(
        pool,
        Some(provision),
        std::env::var("SECURE_COOKIE").is_ok_and(|s| s == "true"),
        PathBuf::from(std::env::var("BACKUP_ROOT").unwrap_or_else(|_| "/backups".into())),
    )
    .await?;
    if std::env::var("CONFIGURE_PORTAL_GRANTS").is_ok_and(|s| s == "true") {
        let database: String = sqlx::query_scalar("SELECT DATABASE()")
            .fetch_one(&control.pool)
            .await?;
        anyhow::ensure!(
            database
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
            "Invalid control database name"
        );
        let root = control.provision.as_ref().unwrap();
        for grant in [
            "SELECT ON {db}._sqlx_migrations",
            "SELECT ON {db}.hosted_accounts",
            "UPDATE (authorized_through) ON {db}.hosted_accounts",
            "SELECT,INSERT,DELETE ON {db}.hosted_sessions",
            "SELECT ON {db}.hosted_codes",
            "UPDATE (redeemed_at,redemption_id,granted_through) ON {db}.hosted_codes",
            "INSERT ON {db}.authority_audit",
        ] {
            sqlx::query(&format!(
                "GRANT {} TO 'portal'@'%'",
                grant.replace("{db}", &format!("`{database}`"))
            ))
            .execute(root)
            .await?;
        }
    }
    bootstrap(&control).await?;
    sqlx::query("UPDATE hosted_accounts SET state='failed' WHERE state='provisioning'")
        .execute(&control.pool)
        .await?;
    for account in sqlx::query_as::<_, Account>(
        "SELECT * FROM hosted_accounts WHERE state='ready' ORDER BY id",
    )
    .fetch_all(&control.pool)
    .await?
    {
        let pool = super::tenancy::pool(&account, 2).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        pool.close().await;
    }
    axum::serve(
        tokio::net::TcpListener::bind(address).await?,
        router(control),
    )
    .with_graceful_shutdown(crate::shutdown_signal())
    .await?;
    Ok(())
}
async fn bootstrap(c: &Control) -> anyhow::Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM authority_administrators")
        .fetch_one(&c.pool)
        .await?;
    if count != 0 {
        return Ok(());
    }
    let name = std::env::var("AUTHORITY_ADMIN_USERNAME")?;
    username(&name).map_err(|e| anyhow::anyhow!(e.1))?;
    let hash = hash_password(std::env::var("AUTHORITY_ADMIN_PASSWORD")?).await?;
    sqlx::query("INSERT INTO authority_administrators(id,username,password_hash) VALUES(?,?,?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(name)
        .bind(hash)
        .execute(&c.pool)
        .await?;
    Ok(())
}
pub(super) fn router(c: Control) -> Router {
    let protected = Router::new()
        .route("/session", get(session))
        .route("/logout", post(logout))
        .route("/accounts", get(accounts).post(create_account))
        .route("/accounts/{id}", put(change_account))
        .route("/accounts/{id}/provision", post(retry_provision))
        .route("/accounts/{id}/codes", post(create_code))
        .route("/codes", get(codes))
        .route("/codes/{id}/revoke", post(revoke_code))
        .route(
            "/administrators",
            get(administrators).post(create_administrator),
        )
        .route("/audit", get(audit))
        .route_layer(middleware::from_fn_with_state(c.clone(), authenticate));
    Router::new()
        .nest(
            "/api",
            protected
                .route(
                    "/site",
                    get(|| async { Json(crate::build_info("authority")) }),
                )
                .route("/login", post(login))
                .route("/customer/history/clear", post(super::history::clear))
                .route("/health", get(health)),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16384))
        .layer(middleware::from_fn(crate::api::security_headers))
        .with_state(c)
}
async fn authenticate(State(c): State<Control>, mut request: Request, next: Next) -> Response {
    let value = token(request.headers(), "marksix_authority");
    let result:ApiResult<String>=match value {
        Some(value)=>sqlx::query_scalar("SELECT administrator_id FROM authority_sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP(6)").bind(digest(&value)).fetch_optional(&c.pool).await.map_err(crate::api::ApiError::from).and_then(|id|id.ok_or_else(unauthorized)),
        None=>Err(unauthorized()),
    };
    match result {
        Ok(id) => {
            request.extensions_mut().insert(id);
            next.run(request).await
        }
        Err(e) => e.into_response(),
    }
}
async fn login(State(c): State<Control>, Json(input): Json<Login>) -> ApiResult<Response> {
    username(&input.username)?;
    let row = sqlx::query("SELECT id,password_hash FROM authority_administrators WHERE username=?")
        .bind(&input.username)
        .fetch_optional(&c.pool)
        .await?;
    c.verify(
        &input.username,
        input.password,
        row.as_ref().map(|r| r.get("password_hash")),
    )
    .await?;
    let id: String = row.unwrap().get("id");
    let value = random_token();
    let mut tx = c.pool.begin().await?;
    sqlx::query(
        "DELETE FROM authority_sessions WHERE administrator_id=? OR expires_at<=UTC_TIMESTAMP(6)",
    )
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO authority_sessions(token_hash,administrator_id,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 8 HOUR))").bind(digest(&value)).bind(&id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        [(
            header::SET_COOKIE,
            cookie(&c, "marksix_authority", &value, 28800),
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn logout(State(c): State<Control>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(t) = token(&headers, "marksix_authority") {
        sqlx::query("DELETE FROM authority_sessions WHERE token_hash=?")
            .bind(digest(&t))
            .execute(&c.pool)
            .await?;
    }
    Ok((
        [(header::SET_COOKIE, cookie(&c, "marksix_authority", "", 0))],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn session(
    State(c): State<Control>,
    Extension(id): Extension<String>,
) -> ApiResult<Json<Value>> {
    let name: String =
        sqlx::query_scalar("SELECT username FROM authority_administrators WHERE id=?")
            .bind(id)
            .fetch_one(&c.pool)
            .await?;
    Ok(Json(json!({"username":name})))
}
async fn health(State(c): State<Control>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1").execute(&c.pool).await?;
    Ok(Json(
        json!({"status":"ok","version":env!("CARGO_PKG_VERSION"),"commit":option_env!("MARKSIX_REVISION").unwrap_or("development")}),
    ))
}
async fn accounts(State(c): State<Control>) -> ApiResult<Json<Value>> {
    let rows = sqlx::query_as::<_, Account>(
        "SELECT * FROM hosted_accounts ORDER BY created_at DESC LIMIT 1000",
    )
    .fetch_all(&c.pool)
    .await?;
    Ok(Json(
        json!({"items":rows.iter().map(Account::public).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateAccount {
    username: String,
    password: String,
    #[serde(default)]
    permanent: bool,
}
async fn create_account(
    State(c): State<Control>,
    Extension(owner): Extension<String>,
    Json(input): Json<CreateAccount>,
) -> ApiResult<Json<Value>> {
    username(&input.username)?;
    if input.password.chars().count() < 12 || input.password.len() > 256 {
        return Err(invalid("密码须至少 12 个字符且不超过 256 字节"));
    }
    let _permit = c
        .gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| invalid("正在处理其他账号操作，请稍后重试"))?;
    let hash = hash_password(input.password).await?;
    let uuid = uuid::Uuid::new_v4();
    let id = uuid.to_string();
    let db = format!("marksix_t_{}", uuid.simple());
    let dbuser = format!("mt_{}", &uuid.simple().to_string()[..24]);
    let mut tx = c.pool.begin().await?;
    sqlx::query("INSERT INTO hosted_accounts(id,username,password_hash,permanent,database_name,database_user,database_password) VALUES(?,?,?,?,?,?,?)").bind(&id).bind(input.username).bind(hash).bind(input.permanent).bind(db).bind(dbuser).bind(random_token()).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO authority_audit(administrator_id,account_id,event) VALUES(?,?,'create_account')").bind(owner).bind(&id).execute(&mut *tx).await?;
    tx.commit().await?;
    provision(&c, &id).await?;
    let a = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=?")
        .bind(&id)
        .fetch_one(&c.pool)
        .await?;
    Ok(Json(a.public()))
}
async fn provision(c: &Control, id: &str) -> ApiResult<()> {
    let a = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=?")
        .bind(id)
        .fetch_optional(&c.pool)
        .await?
        .ok_or_else(crate::api::missing)?;
    if !matches!(a.state.as_str(), "provisioning" | "failed") {
        return Err(invalid("该账号不能重复初始化"));
    }
    let result = provision_inner(c, &a).await;
    sqlx::query(
        "UPDATE hosted_accounts SET state=? WHERE id=? AND state IN ('provisioning','failed')",
    )
    .bind(if result.is_ok() { "ready" } else { "failed" })
    .bind(id)
    .execute(&c.pool)
    .await?;
    if let Err(e) = result {
        tracing::error!(account_id=%id,error=%e,"tenant provisioning failed");
        return Err(invalid("客户数据库初始化失败，账号已保留，可重试初始化"));
    }
    Ok(())
}
pub(super) fn identifiers(a: &Account) -> anyhow::Result<()> {
    let id = uuid::Uuid::parse_str(&a.id)?;
    anyhow::ensure!(
        a.database_name == format!("marksix_t_{}", id.simple())
            && a.database_user == format!("mt_{}", &id.simple().to_string()[..24])
            && a.database_password.len() == 64
            && a.database_password.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid generated tenant identifiers"
    );
    Ok(())
}
async fn provision_inner(c: &Control, a: &Account) -> anyhow::Result<()> {
    identifiers(a)?;
    let root = c
        .provision
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Missing provision connection"))?;
    sqlx::query(&format!(
        "CREATE DATABASE IF NOT EXISTS `{}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
        a.database_name
    ))
    .execute(root)
    .await?;
    sqlx::query(&format!(
        "CREATE USER IF NOT EXISTS '{}'@'%' IDENTIFIED BY '{}'",
        a.database_user, a.database_password
    ))
    .execute(root)
    .await?;
    sqlx::query(&format!(
        "GRANT ALL PRIVILEGES ON `{}`.* TO '{}'@'%'",
        a.database_name.replace('_', "\\_"),
        a.database_user
    ))
    .execute(root)
    .await?;
    let pool = super::tenancy::pool(a, 2).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    crate::store::initialize(&pool, &a.username, Some(&random_token())).await?;
    sqlx::query("UPDATE administrators SET password_hash=? WHERE id=1")
        .bind(&a.password_hash)
        .execute(&pool)
        .await?;
    pool.close().await;
    Ok(())
}
async fn retry_provision(
    State(c): State<Control>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let _permit = c
        .gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| invalid("正在处理账号，请稍后重试"))?;
    provision(&c, &id).await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Change {
    Rename { username: String },
    Disable,
    Enable,
    Password { password: String },
    Permanent { enabled: bool },
    Revoke,
    Delete { confirmation: String },
}
async fn change_account(
    State(c): State<Control>,
    Extension(owner): Extension<String>,
    Path(id): Path<String>,
    Json(input): Json<Change>,
) -> ApiResult<Json<Value>> {
    if let Change::Delete { confirmation } = input {
        delete_account(&c, &id, &confirmation, &owner).await?;
        return Ok(Json(json!({"ok":true})));
    }
    let hash = if let Change::Password { ref password } = input {
        if password.chars().count() < 12 || password.len() > 256 {
            return Err(invalid("密码须至少 12 个字符且不超过 256 字节"));
        }
        let _permit = c
            .gate
            .clone()
            .try_acquire_owned()
            .map_err(|_| invalid("正在处理账号，请稍后重试"))?;
        Some(hash_password(password.clone()).await?)
    } else {
        None
    };
    let mut tx = c.pool.begin().await?;
    let a = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=? FOR UPDATE")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(crate::api::missing)?;
    if a.state == "deleting" {
        return Err(invalid("账号正在永久删除"));
    }
    let event = match input {
        Change::Rename { username: name } => {
            username(&name)?;
            sqlx::query("UPDATE hosted_accounts SET username=?,credential_version=credential_version+1 WHERE id=?").bind(name).bind(&id).execute(&mut *tx).await?;
            sqlx::query("UPDATE hosted_codes SET revoked_at=UTC_TIMESTAMP(6) WHERE account_id=? AND redeemed_at IS NULL").bind(&id).execute(&mut *tx).await?;
            "username_changed"
        }
        Change::Disable => {
            sqlx::query("UPDATE hosted_accounts SET disabled=TRUE WHERE id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            "disable"
        }
        Change::Enable => {
            sqlx::query("UPDATE hosted_accounts SET disabled=FALSE WHERE id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            "enable"
        }
        Change::Password { .. } => {
            sqlx::query("UPDATE hosted_accounts SET password_hash=?,credential_version=credential_version+1 WHERE id=?").bind(hash).bind(&id).execute(&mut *tx).await?;
            sqlx::query("UPDATE hosted_codes SET revoked_at=UTC_TIMESTAMP(6) WHERE account_id=? AND redeemed_at IS NULL").bind(&id).execute(&mut *tx).await?;
            "password_reset"
        }
        Change::Permanent { enabled } => {
            sqlx::query("UPDATE hosted_accounts SET permanent=? WHERE id=?")
                .bind(enabled)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            "permanent_changed"
        }
        Change::Revoke => {
            sqlx::query(
                "UPDATE hosted_accounts SET permanent=FALSE,authorized_through=NULL WHERE id=?",
            )
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("UPDATE hosted_codes SET revoked_at=UTC_TIMESTAMP(6) WHERE account_id=? AND redeemed_at IS NULL").bind(&id).execute(&mut *tx).await?;
            "authorization_revoked"
        }
        Change::Delete { .. } => unreachable!(),
    };
    sqlx::query("DELETE FROM hosted_sessions WHERE account_id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO authority_audit(administrator_id,account_id,event) VALUES(?,?,?)")
        .bind(owner)
        .bind(&id)
        .bind(event)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
async fn create_code(
    State(c): State<Control>,
    Extension(owner): Extension<String>,
    Path(id): Path<String>,
    Json(input): Json<CodeInput>,
) -> ApiResult<Json<Value>> {
    Ok(Json(issue_code(&c, &id, input, &owner).await?))
}
async fn codes(State(c): State<Control>) -> ApiResult<Json<Value>> {
    let rows=sqlx::query("SELECT c.id,c.account_id,a.username,c.days,c.redeem_through,c.redeemed_at,c.granted_through,c.revoked_at FROM hosted_codes c JOIN hosted_accounts a ON a.id=c.account_id ORDER BY c.created_at DESC LIMIT 1000").fetch_all(&c.pool).await?;
    Ok(Json(
        json!({"items":rows.into_iter().map(|r|json!({"id":r.get::<String,_>("id"),"account_id":r.get::<String,_>("account_id"),"username":r.get::<String,_>("username"),"days":r.get::<i32,_>("days"),"redeem_through":r.get::<chrono::NaiveDate,_>("redeem_through"),"redeemed_at":r.get::<Option<chrono::NaiveDateTime>,_>("redeemed_at"),"granted_through":r.get::<Option<chrono::NaiveDate>,_>("granted_through"),"revoked_at":r.get::<Option<chrono::NaiveDateTime>,_>("revoked_at")})).collect::<Vec<_>>()}),
    ))
}
async fn revoke_code(
    State(c): State<Control>,
    Extension(owner): Extension<String>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut tx = c.pool.begin().await?;
    let account_id: Option<String> =
        sqlx::query_scalar("SELECT account_id FROM hosted_codes WHERE id=?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    let account_id = account_id.ok_or_else(crate::api::missing)?;
    sqlx::query("SELECT id FROM hosted_accounts WHERE id=? FOR UPDATE")
        .bind(&account_id)
        .fetch_one(&mut *tx)
        .await?;
    let n=sqlx::query("UPDATE hosted_codes SET revoked_at=UTC_TIMESTAMP(6) WHERE id=? AND redeemed_at IS NULL AND revoked_at IS NULL").bind(&id).execute(&mut *tx).await?;
    if n.rows_affected() != 1 {
        return Err(invalid(
            "只能作废尚未使用的激活码；撤销已激活授权请在客户管理操作",
        ));
    }
    sqlx::query(
        "INSERT INTO authority_audit(administrator_id,account_id,event) VALUES(?,?,'revoke_code')",
    )
    .bind(owner)
    .bind(account_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
async fn administrators(State(c): State<Control>) -> ApiResult<Json<Value>> {
    let rows = sqlx::query("SELECT id,username FROM authority_administrators ORDER BY created_at")
        .fetch_all(&c.pool)
        .await?;
    Ok(Json(
        json!({"items":rows.into_iter().map(|r|json!({"id":r.get::<String,_>("id"),"username":r.get::<String,_>("username")})).collect::<Vec<_>>()}),
    ))
}
async fn create_administrator(
    State(c): State<Control>,
    Extension(owner): Extension<String>,
    Json(input): Json<Login>,
) -> ApiResult<Json<Value>> {
    username(&input.username)?;
    if input.password.chars().count() < 12 || input.password.len() > 256 {
        return Err(invalid("密码须至少 12 个字符且不超过 256 字节"));
    }
    let _permit = c
        .gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| invalid("正在处理账号，请稍后重试"))?;
    let hash = hash_password(input.password).await?;
    let mut tx = c.pool.begin().await?;
    sqlx::query("INSERT INTO authority_administrators(id,username,password_hash) VALUES(?,?,?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(input.username)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO authority_audit(administrator_id,event) VALUES(?,'create_administrator')",
    )
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
async fn audit(State(c): State<Control>) -> ApiResult<Json<Value>> {
    let rows=sqlx::query("SELECT id,administrator_id,account_id,event,created_at FROM authority_audit ORDER BY id DESC LIMIT 500").fetch_all(&c.pool).await?;
    Ok(Json(
        json!({"items":rows.into_iter().map(|r|json!({"id":r.get::<i64,_>("id"),"administrator_id":r.get::<Option<String>,_>("administrator_id"),"account_id":r.get::<Option<String>,_>("account_id"),"event":r.get::<String,_>("event"),"created_at":r.get::<chrono::NaiveDateTime,_>("created_at")})).collect::<Vec<_>>()}),
    ))
}
// The same lock file is used by backup/restore. Blocking filesystem work never
// runs on an async executor thread. The descriptor holds flock until drop.
pub(super) async fn backup_lock(root: PathBuf) -> anyhow::Result<Arc<std::fs::File>> {
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&root)?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(".lock"))?;
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            anyhow::ensure!(
                unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0,
                "Backup lock failed"
            );
        }
        #[cfg(not(target_os = "linux"))]
        anyhow::bail!("Hosted production deletion requires Linux backup locking");
        #[allow(unreachable_code)]
        Ok(Arc::new(file))
    })
    .await?
}
pub(super) async fn remove_tree(path: &FsPath) -> anyhow::Result<()> {
    if tokio::fs::try_exists(path).await? {
        tokio::fs::remove_dir_all(path).await?;
    }
    Ok(())
}
async fn delete_account(c: &Control, id: &str, confirmation: &str, owner: &str) -> ApiResult<()> {
    // Account initialization performs DDL outside SQL transactions. Serialize it
    // with deletion so no late initializer can recreate an erased database.
    let _permit = c.gate.clone().try_acquire_owned().map_err(|_| {
        crate::api::ApiError(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "正在初始化或处理账号，请稍后重试删除".into(),
        )
    })?;
    uuid::Uuid::parse_str(id).map_err(|_| invalid("客户编号无效"))?;
    let _lock = backup_lock(c.backup_root.clone()).await?;
    let mut tx = c.pool.begin().await?;
    let a = sqlx::query_as::<_, Account>("SELECT * FROM hosted_accounts WHERE id=? FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(crate::api::missing)?;
    if confirmation != format!("永久删除 {}", a.username) {
        return Err(invalid("请输入“永久删除 客户账号”进行确认"));
    }
    identifiers(&a)?;
    sqlx::query("UPDATE hosted_accounts SET state='deleting',disabled=TRUE WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM hosted_sessions WHERE account_id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // Failed deletion stays disabled/deleting and can safely be retried.
    remove_tree(&c.backup_root.join("tenants").join(id)).await?;
    // Historical control dumps contain account details. Remove those dumps;
    // independent backups of other customers' ledgers remain intact.
    remove_tree(&c.backup_root.join("control")).await?;
    let root = c
        .provision
        .as_ref()
        .ok_or_else(|| invalid("未配置数据库管理连接"))?;
    sqlx::query(&format!("DROP DATABASE IF EXISTS `{}`", a.database_name))
        .execute(root)
        .await?;
    sqlx::query(&format!("DROP USER IF EXISTS '{}'@'%'", a.database_user))
        .execute(root)
        .await?;
    let mut tx = c.pool.begin().await?;
    sqlx::query("INSERT IGNORE INTO hosted_deletions(account_id) VALUES(?)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM authority_audit WHERE account_id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM hosted_accounts WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO authority_audit(administrator_id,event) VALUES(?,'permanent_delete_completed')").bind(owner).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
