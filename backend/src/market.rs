//! Market identity and period admission. Calendar dates use Beijing civil time.
use crate::{domain::*, store::*};
use chrono::{Datelike, Duration, NaiveDateTime};
use serde::{Deserialize, Serialize};
use sqlx::types::Json;
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Market {
    #[default]
    Macau,
    Hk,
}
impl Market {
    pub fn is_macau(&self) -> bool {
        *self == Self::Macau
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Macau => "macau",
            Self::Hk => "hk",
        }
    }
}
pub fn accepts(p: &Period, now: NaiveDateTime) -> bool {
    if p.market == "macau" {
        return accepts_entries(now, p.business_date);
    }
    if let Some(draw) = &p.draw {
        return now
            < (draw.open_time.date() + Duration::days(1))
                .and_hms_opt(6, 0, 0)
                .unwrap();
    }
    p.state == "pending" && now.date() >= p.business_date
}
pub fn next_expect(previous: &str, year: i32) -> Option<String> {
    if previous.len() != 7 || !previous.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if previous[..4].parse::<i32>().ok()? != year {
        return None;
    }
    let number = previous[4..].parse::<u16>().ok()?.checked_add(1)?;
    (number <= 999).then(|| format!("{year}{number:03}"))
}
pub async fn ensure_hk(state: &AppState) -> anyhow::Result<Period> {
    let now = state.now();
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM administrators WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let latest: Option<Period> = sqlx::query_as(
        "SELECT * FROM periods WHERE market='hk' ORDER BY business_date DESC LIMIT 1 FOR UPDATE",
    )
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(p) = latest
        && accepts(&p, now)
    {
        tx.commit().await?;
        return Ok(p);
    }
    let date = business_date(now);
    let id = format!("hk-{}", period_id(date));
    let previous: String =
        sqlx::query_scalar("SELECT expect FROM market_cursors WHERE market='hk'")
            .fetch_one(&mut *tx)
            .await?;
    let mapping:Option<Json<Mapping>>=sqlx::query_scalar("SELECT mapping FROM mapping_configs WHERE effective_date BETWEEN ? AND ? ORDER BY effective_date DESC LIMIT 1").bind(chrono::NaiveDate::from_ymd_opt(date.year(),1,1).unwrap()).bind(date).fetch_optional(&mut *tx).await?;
    sqlx::query("INSERT IGNORE INTO periods(id,business_date,open_time,close_time,mapping,market,previous_expect) VALUES(?,?,'06:00','06:00',?,'hk',?)").bind(&id).bind(date).bind(mapping.unwrap_or_else(||Json(Mapping::for_year(date.year())))).bind(previous).execute(&mut *tx).await?;
    let p = sqlx::query_as("SELECT * FROM periods WHERE id=?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(p)
}
