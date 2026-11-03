//! Explicit, administrator-created collaboration. Private ledgers stay untouched.
use super::{accounts::*, management, tenancy};
use crate::{
    api::{ApiResult, conflict, missing},
    domain::{Rule, scaled},
};
use axum::{
    Extension, Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, types::Json as DbJson};
use std::collections::HashSet;

#[derive(Clone, FromRow)]
pub(super) struct Workspace {
    pub id: String,
    pub database_name: String,
    pub database_user: String,
    pub database_password: String,
    pub state: String,
}
impl Workspace {
    pub fn database(&self, member: &Account) -> Account {
        let mut database = member.clone();
        database.id = self.id.clone();
        database.database_name = self.database_name.clone();
        database.database_user = self.database_user.clone();
        database.database_password = self.database_password.clone();
        database.workspace_id = None;
        database
    }
}
pub(super) async fn get(c: &Control, id: &str) -> ApiResult<Workspace> {
    sqlx::query_as("SELECT * FROM hosted_workspaces WHERE id=?")
        .bind(id)
        .fetch_optional(&c.pool)
        .await?
        .ok_or_else(missing)
}
pub(super) async fn information(c: &Control, a: &Account) -> ApiResult<Value> {
    let Some(id) = &a.workspace_id else {
        return Ok(Value::Null);
    };
    let workspace = get(c, id).await?;
    let members: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,username FROM hosted_accounts WHERE workspace_id=? ORDER BY username,id",
    )
    .bind(id)
    .fetch_all(&c.pool)
    .await?;
    Ok(
        json!({"id":id,"state":workspace.state,"members":members.into_iter().map(|(id,username)|json!({"id":id,"username":username})).collect::<Vec<_>>()}),
    )
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RecordView {
    Shared,
    Mine,
    History,
}
impl RecordView {
    pub fn parse(headers: &HeaderMap) -> ApiResult<Self> {
        match headers
            .get("x-marksix-records")
            .map(|s| s.to_str())
            .transpose()
            .map_err(|_| invalid("记录范围无效"))?
            .unwrap_or("shared")
        {
            "shared" => Ok(Self::Shared),
            "mine" => Ok(Self::Mine),
            "history" => Ok(Self::History),
            _ => Err(invalid("记录范围无效")),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Link {
    account_id: String,
}
pub(super) async fn link(
    State(c): State<Control>,
    Extension(operator): Extension<String>,
    Path(id): Path<String>,
    Json(input): Json<Link>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&id).map_err(|_| invalid("客户编号无效"))?;
    uuid::Uuid::parse_str(&input.account_id).map_err(|_| invalid("关联客户编号无效"))?;
    if id == input.account_id {
        return Err(invalid("不能关联同一个账户"));
    }
    let _permit = c
        .gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| conflict("正在处理其他账号操作，请稍后重试"))?;
    let _backup = management::backup_lock(c.backup_root.clone()).await?;
    let mut tx = c.pool.begin().await?;
    let members: Vec<Account> =
        sqlx::query_as("SELECT * FROM hosted_accounts WHERE id IN (?,?) ORDER BY id FOR UPDATE")
            .bind(&id)
            .bind(&input.account_id)
            .fetch_all(&mut *tx)
            .await?;
    if members.len() != 2 {
        return Err(missing());
    }
    if members.iter().any(|a| a.state != "ready" || a.disabled) {
        return Err(conflict("仅能关联初始化完成且未停用的账户"));
    }
    let primary = members.iter().find(|a| a.id == id).unwrap();
    let secondary = members.iter().find(|a| a.id != id).unwrap();
    let workspace = match (&primary.workspace_id, &secondary.workspace_id) {
        (None, None) => {
            let uuid = uuid::Uuid::new_v4();
            let workspace = Workspace {
                id: uuid.to_string(),
                database_name: format!("marksix_t_{}", uuid.simple()),
                database_user: format!("mt_{}", &uuid.simple().to_string()[..24]),
                database_password: random_token(),
                state: "provisioning".into(),
            };
            sqlx::query("INSERT INTO hosted_workspaces(id,database_name,database_user,database_password) VALUES(?,?,?,?)")
                .bind(&workspace.id).bind(&workspace.database_name).bind(&workspace.database_user).bind(&workspace.database_password).execute(&mut *tx).await?;
            sqlx::query("UPDATE hosted_accounts SET workspace_id=? WHERE id IN (?,?)")
                .bind(&workspace.id)
                .bind(&id)
                .bind(&input.account_id)
                .execute(&mut *tx)
                .await?;
            workspace
        }
        (Some(a), Some(b)) if a == b => {
            let workspace: Workspace =
                sqlx::query_as("SELECT * FROM hosted_workspaces WHERE id=? FOR UPDATE")
                    .bind(a)
                    .fetch_one(&mut *tx)
                    .await?;
            if workspace.state == "ready" {
                return Ok(Json(json!({"ok":true,"workspace_id":a})));
            }
            workspace
        }
        _ => return Err(conflict("账户已经关联，不能加入另一个协作账本")),
    };
    sqlx::query("DELETE FROM hosted_sessions WHERE account_id IN (?,?)")
        .bind(&id)
        .bind(&input.account_id)
        .execute(&mut *tx)
        .await?;
    // Dispatch pins account rows for the entire business request. This commit is
    // the cutover: no request can keep writing the old ledger after linking.
    tx.commit().await?;
    let result = provision(&c, &workspace, primary, secondary).await;
    let mut tx = c.pool.begin().await?;
    sqlx::query("UPDATE hosted_workspaces SET state=? WHERE id=?")
        .bind(if result.is_ok() { "ready" } else { "failed" })
        .bind(&workspace.id)
        .execute(&mut *tx)
        .await?;
    if result.is_ok() {
        for member in &members {
            sqlx::query("INSERT INTO authority_audit(administrator_id,account_id,event) VALUES(?,?,'accounts_linked')").bind(&operator).bind(&member.id).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    if let Err(e) = result {
        tracing::error!(workspace_id=%workspace.id,error=%e,"collaboration provisioning failed");
        return Err(conflict("协作账本初始化未完成，旧账本保留，请重试关联"));
    }
    Ok(Json(json!({"ok":true,"workspace_id":workspace.id})))
}

// Compare complete typed settings. Numeric spelling alone is not a new rate.
fn fingerprint(rule: &Rule, enabled: bool) -> anyhow::Result<String> {
    rule.validate().map_err(anyhow::Error::msg)?;
    let mut value = serde_json::to_value(rule)?;
    for field in [
        "odds",
        "special_odds",
        "zero_tail_odds",
        "special_hit_odds",
        "rebate_percent",
        "special_rebate_percent",
        "zero_tail_rebate_percent",
    ] {
        if let Some(text) = value[field].as_str() {
            let digits = if field.contains("rebate") { 2 } else { 4 };
            value[field] = json!(scaled(text, digits).map_err(anyhow::Error::msg)?);
        }
    }
    Ok(json!({"rule":value,"enabled":enabled}).to_string())
}
async fn provision(
    c: &Control,
    workspace: &Workspace,
    primary: &Account,
    secondary: &Account,
) -> anyhow::Result<()> {
    let database = workspace.database(primary);
    management::provision_inner(c, &database).await?;
    let target = tenancy::pool(&database, 1).await?;
    let first = tenancy::pool(primary, 1).await?;
    let second = tenancy::pool(secondary, 1).await?;
    let result = copy_configuration(&target, &first, &second).await;
    target.close().await;
    first.close().await;
    second.close().await;
    result
}
async fn copy_configuration(
    target: &sqlx::MySqlPool,
    first: &sqlx::MySqlPool,
    second: &sqlx::MySqlPool,
) -> anyhow::Result<()> {
    let mut tx = target.begin().await?;
    // Safe to retry only while the workspace is not ready and has no entries.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bets")
        .fetch_one(&mut *tx)
        .await?;
    anyhow::ensure!(count == 0, "Cannot reinitialize a populated collaboration");
    sqlx::query("DELETE FROM play_versions")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM plays").execute(&mut *tx).await?;
    let mut seen = HashSet::new();
    let mut order = 0_i64;
    for source in [first, second] {
        let plays: Vec<(DbJson<Rule>, bool)> = sqlx::query_as(
            "SELECT rule,enabled FROM plays WHERE deleted_at IS NULL ORDER BY sort_order,id",
        )
        .fetch_all(source)
        .await?;
        for (rule, enabled) in plays {
            if !seen.insert(fingerprint(&rule.0, enabled)?) {
                continue;
            }
            order += 1;
            let result =
                sqlx::query("INSERT INTO plays(version,rule,enabled,sort_order) VALUES(1,?,?,?)")
                    .bind(&rule)
                    .bind(enabled)
                    .bind(order)
                    .execute(&mut *tx)
                    .await?;
            sqlx::query("INSERT INTO play_versions(play_id,version,rule) VALUES(?,1,?)")
                .bind(result.last_insert_id() as i64)
                .bind(&rule)
                .execute(&mut *tx)
                .await?;
        }
    }
    sqlx::query("DELETE FROM mapping_configs")
        .execute(&mut *tx)
        .await?;
    let mappings: Vec<(chrono::NaiveDate, DbJson<crate::domain::Mapping>)> =
        sqlx::query_as("SELECT effective_date,mapping FROM mapping_configs")
            .fetch_all(first)
            .await?;
    for (date, mapping) in mappings {
        sqlx::query("INSERT INTO mapping_configs(effective_date,mapping) VALUES(?,?)")
            .bind(date)
            .bind(mapping)
            .execute(&mut *tx)
            .await?;
    }
    let features = crate::features::read(first).await?;
    sqlx::query(
        "UPDATE module_features SET layoffs=?,manual_entry=?,text_entry=?,entry_mode=? WHERE id=1",
    )
    .bind(features.layoffs)
    .bind(features.manual_entry)
    .bind(features.text_entry)
    .bind(features.entry_mode)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_plays_compare_all_typed_settings_and_numeric_values() {
        let rules = crate::configuration::bundled().unwrap().plays;
        let original = rules.iter().find(|p| p.rule.name == "特码").unwrap();
        let key = fingerprint(&original.rule, true).unwrap();
        let mut same = original.rule.clone();
        same.odds.push_str(".0");
        same.rebate_percent.push_str(".0");
        assert_eq!(fingerprint(&same, true).unwrap(), key);
        assert_ne!(fingerprint(&original.rule, false).unwrap(), key);
        for (field, value) in [
            ("name", json!("其他名称")),
            ("odds", json!("48")),
            ("rebate_percent", json!("1.5")),
            ("selection_limit", json!(20)),
        ] {
            let mut rule = serde_json::to_value(&original.rule).unwrap();
            rule[field] = value;
            let rule: Rule = serde_json::from_value(rule).unwrap();
            assert_ne!(fingerprint(&rule, true).unwrap(), key, "{field}");
        }
        let tail = rules
            .iter()
            .find(|p| p.rule.kind == crate::domain::Kind::Tail && p.rule.quantity == 1)
            .unwrap();
        let mut rule = tail.rule.clone();
        let key = fingerprint(&rule, true).unwrap();
        rule.zero_tail_odds = Some("4".into());
        rule.zero_tail_rebate_percent = Some("2".into());
        assert_ne!(fingerprint(&rule, true).unwrap(), key);
        let mut invalid_rule = original.rule.clone();
        invalid_rule.odds = "invalid".into();
        assert!(fingerprint(&invalid_rule, true).is_err());
    }
    #[test]
    fn record_scope_is_a_closed_set_and_cannot_select_another_account() {
        let mut headers = HeaderMap::new();
        assert!(RecordView::parse(&headers).unwrap() == RecordView::Shared);
        for value in ["mine", "history", "shared"] {
            headers.insert("x-marksix-records", value.parse().unwrap());
            assert!(RecordView::parse(&headers).is_ok());
        }
        for value in ["", "another-account", "mine; DROP TABLE bets"] {
            headers.insert("x-marksix-records", value.parse().unwrap());
            assert!(RecordView::parse(&headers).is_err());
        }
    }
}
