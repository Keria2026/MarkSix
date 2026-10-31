//! Pure business rules. Money is integer cents; multipliers are fixed at 1/10,000.
use chrono::{Datelike, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

pub const ZODIACS: [&str; 12] = [
    "鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪",
];
pub const MONEY_LIMIT: i64 = 9_000_000_000_000_000; // Below JavaScript's exact integer limit.
pub const MAX_UNITS: usize = 1_000;
pub type RuleResult<T> = Result<T, String>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Number,
    Zodiac,
    Wave,
    Tail,
    Parity,
    Size,
    ZodiacCount,
}
impl Kind {
    pub fn index(self) -> usize {
        match self {
            Self::Number => 0,
            Self::Zodiac => 1,
            Self::Wave => 2,
            Self::Tail => 3,
            Self::Parity => 4,
            Self::Size => 5,
            // Count predicates are derived from the zodiac-union feature slot.
            Self::ZodiacCount => 1,
        }
    }
    pub fn size(self) -> u8 {
        match self {
            Self::Number => 49,
            Self::Zodiac => 12,
            Self::Wave => 3,
            Self::Tail => 10,
            Self::Parity | Self::Size => 2,
            Self::ZodiacCount => 7,
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Regular,
    Special,
    All,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    All,
    None,
    Any,
    HardPair,
    SoftPair,
    AtLeast,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    Eq,
    Le,
    Ge,
}
impl Relation {
    pub fn accepts(self, n: u8, q: u8) -> bool {
        match self {
            Self::Eq => n == q,
            Self::Le => n <= q,
            Self::Ge => n >= q,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub name: String,
    pub kind: Kind,
    pub scope: Scope,
    pub condition: Condition,
    #[serde(default = "one_hit")]
    pub minimum_hits: u8,
    pub relation: Relation,
    pub quantity: u8,
    pub combination_size: u8,
    #[serde(default)]
    pub compound_enabled: bool,
    #[serde(default)]
    pub selection_limit: Option<u8>,
    pub odds: String,
    pub rebate_percent: String,
    pub special_odds: Option<String>,
    #[serde(default)]
    pub zero_tail_odds: Option<String>,
    #[serde(default)]
    pub special_rebate_percent: Option<String>,
    #[serde(default)]
    pub zodiac_count: Option<u8>,
    #[serde(default)]
    pub special_hit_odds: Option<String>,
}
impl Rule {
    pub fn validate(&self) -> RuleResult<()> {
        if self.name.trim().is_empty()
            || self.name.chars().count() > 40
            || self.name.chars().any(char::is_control)
        {
            return Err("玩法名称须为 1–40 个字符".into());
        }
        if self.kind == Kind::ZodiacCount {
            if !self.zodiac_count.is_some_and(|n| (1..=7).contains(&n))
                || self.scope != Scope::All
                || self.condition != Condition::All
                || self.relation != Relation::Eq
                || self.quantity != 1
                || self.combination_size != 1
                || self.compound_enabled
                || self.special_odds.is_some()
                || self.special_rebate_percent.is_some()
            {
                return Err(
                    "生肖种数须配置 1–7 种、全部范围、等于 1 项、全部命中、关闭复式及本命费率"
                        .into(),
                );
            }
        } else if self.zodiac_count.is_some() {
            return Err("只有生肖种数玩法可以设置目标种数".into());
        }
        if let Some(odds) = &self.special_hit_odds {
            let value = scaled(odds, 4)?;
            if self.kind != Kind::Number
                || self.scope != Scope::All
                || self.condition != Condition::All
                || self.relation != Relation::Eq
                || self.quantity != 2
                || self.combination_size != 2
                || value == 0
                || value > 100_000_000_000
            {
                return Err("含特码赔率仅用于号码、全部范围、等于 2、全部命中；赔率须大于 0 且不超过 10000000".into());
            }
        }
        if self.selection_limit.is_some_and(|n| {
            n == 0
                || n > self.kind.size()
                || (self.compound_enabled && n < self.combination_size)
                || !(1..=n).any(|k| {
                    self.relation.accepts(k, self.quantity)
                        && (self.condition != Condition::AtLeast || k >= self.minimum_hits)
                })
        }) {
            return Err("最多可选数量不能产生合法基础注".into());
        }
        if self.quantity == 0
            || !(1..=self.kind.size()).any(|n| self.relation.accepts(n, self.quantity))
        {
            return Err("数量关系不能产生合法基础注".into());
        }
        if self.combination_size == 0
            || self.combination_size > self.kind.size()
            || !self.relation.accepts(self.combination_size, self.quantity)
        {
            return Err("复式拆分数量必须满足玩法的数量关系".into());
        }
        if self.kind == Kind::Wave && self.scope != Scope::Special {
            return Err("波色只支持特码范围".into());
        }
        if matches!(self.condition, Condition::HardPair | Condition::SoftPair)
            && (self.kind != Kind::Number
                || self.scope != Scope::All
                || self.relation != Relation::Eq
                || self.quantity != 2
                || self.combination_size != 2
                || self.compound_enabled)
        {
            return Err("特碰、软碰须设置：号码、全部范围、等于 2、每注 2 个选项，关闭复式".into());
        }
        if self.condition == Condition::AtLeast
            && (self.minimum_hits == 0
                || self.minimum_hits > self.combination_size
                || self.minimum_hits > self.quantity)
        {
            return Err("最少命中数须为正数，且不能超过每注选项数／数量阈值".into());
        }
        if let Some(value) = &self.special_rebate_percent
            && (self.kind == Kind::Wave || scaled(value, 2)? > 10_000)
        {
            return Err("本命肖特殊反水不适用于波色，比例须为 0%–100%".into());
        }
        let odds = scaled(&self.odds, 4)?;
        if odds == 0 || odds > 100_000_000_000 {
            return Err("赔率须大于 0，且不超过 10000000".into());
        }
        if scaled(&self.rebate_percent, 2)? > 10_000 {
            return Err("反水比例须在 0%–100% 之间".into());
        }
        if let Some(ref value) = self.special_odds {
            if self.kind == Kind::Wave {
                return Err("波色不能设置本命肖特殊赔率".into());
            }
            let odds = scaled(value, 4)?;
            if odds == 0 || odds > 100_000_000_000 {
                return Err("特殊赔率须大于 0，且不超过 10000000".into());
            }
        }
        if let Some(value) = &self.zero_tail_odds {
            let odds = scaled(value, 4)?;
            if self.kind != Kind::Tail || odds == 0 || odds > 100_000_000_000 {
                return Err("0 尾特殊赔率仅适用于尾数玩法，须大于 0 且不超过 10000000".into());
            }
        }
        Ok(())
    }
}

pub fn scaled(input: &str, digits: u32) -> RuleResult<i64> {
    let scale = 10_i64.checked_pow(digits).ok_or("数值过大")?;
    let (whole, fraction) = input.split_once('.').unwrap_or((input, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > digits as usize
        || (input.contains('.') && fraction.is_empty())
    {
        return Err(format!("请输入非负十进制数，最多 {digits} 位小数"));
    }
    let fraction_digits = fraction.len() as u32;
    let whole = whole.parse::<i64>().map_err(|_| "数值过大")?;
    let fraction = if fraction.is_empty() {
        0
    } else {
        fraction.parse::<i64>().map_err(|_| "数值过大")?
    };
    whole
        .checked_mul(scale)
        .and_then(|w| w.checked_add(fraction * 10_i64.pow(digits - fraction_digits)))
        .filter(|n| *n <= MONEY_LIMIT)
        .ok_or("数值过大".into())
}
pub fn rounded_product(cents: i64, rate: i64) -> RuleResult<i64> {
    if cents < 0 || rate < 0 {
        return Err("金额与倍率不能为负数".into());
    }
    let v = (i128::from(cents) * i128::from(rate) + 5_000) / 10_000;
    if !(0..=i128::from(MONEY_LIMIT)).contains(&v) {
        return Err("金额超出安全计算范围".into());
    }
    Ok(v as i64)
}
pub fn checked_sum(values: impl IntoIterator<Item = i64>) -> RuleResult<i64> {
    values.into_iter().try_fold(0_i64, |sum, n| {
        sum.checked_add(n)
            .filter(|v| v.checked_abs().is_some_and(|n| n <= MONEY_LIMIT))
            .ok_or("汇总金额超出安全计算范围".into())
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub zodiac: Vec<u8>,
    pub natal: u8,
}
impl Default for Mapping {
    fn default() -> Self {
        Self::for_year(2026)
    }
}
impl Mapping {
    pub fn for_year(year: i32) -> Self {
        let natal = (6 + year - 2026).rem_euclid(12) as u8;
        Self {
            natal,
            zodiac: (1..=49)
                .map(|n| (i32::from(natal) - (n - 1)).rem_euclid(12) as u8)
                .collect(),
        }
    }
    pub fn natal_options(&self, kind: Kind) -> u64 {
        if kind == Kind::ZodiacCount {
            return 0;
        }
        (1..=49)
            .filter(|n| self.zodiac[(*n - 1) as usize] == self.natal)
            .fold(0, |mask, n| mask | self.features(n)[kind.index()])
    }
    pub fn validate(&self) -> RuleResult<()> {
        if self.zodiac.len() != 49 || self.zodiac.iter().any(|n| *n >= 12) || self.natal >= 12 {
            Err("映射须覆盖 49 个号码，生肖值须合法".into())
        } else {
            Ok(())
        }
    }
    pub fn features(&self, n: u8) -> [u64; 6] {
        [
            1_u64 << (n - 1),
            1_u64 << self.zodiac[(n - 1) as usize],
            1_u64 << wave(n),
            1_u64 << (n % 10),
            1_u64 << (n % 2),
            1_u64 << u8::from(n >= 25),
        ]
    }
}
pub fn wave(n: u8) -> u8 {
    if [
        1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46,
    ]
    .contains(&n)
    {
        0
    } else if [3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48].contains(&n) {
        1
    } else {
        2
    }
}

/// Pair plays cross the two pools; larger combinations keep all left options fixed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DragInput {
    pub left: Vec<u8>,
    pub right: Vec<u8>,
    pub zodiac: bool,
}
impl DragInput {
    fn sets(&self, rule: &Rule, mapping: &Mapping) -> RuleResult<Vec<Vec<u8>>> {
        let k = rule.combination_size as usize;
        if !rule.compound_enabled
            || k < 2
            || !matches!(rule.kind, Kind::Number | Kind::Zodiac | Kind::Tail)
        {
            return Err("拖仅适用于已启用复式且每注至少两项的号码、生肖或尾数玩法".into());
        }
        if self.zodiac && (rule.kind != Kind::Number || k != 2) {
            return Err("生肖展开号码拖仅适用于每注两个号码的玩法".into());
        }
        let valid = |v: u8| {
            if self.zodiac {
                v < 12
            } else if rule.kind == Kind::Number {
                (1..=49).contains(&v)
            } else {
                v < rule.kind.size()
            }
        };
        let mut seen = std::collections::BTreeSet::new();
        if self.left.is_empty()
            || self.right.is_empty()
            || self
                .left
                .iter()
                .chain(&self.right)
                .any(|v| !valid(*v) || !seen.insert(*v))
        {
            return Err("拖的两边不能为空，选项不能重复或重叠".into());
        }
        let expand = |values: &[u8]| -> Vec<u8> {
            if self.zodiac {
                (1..=49)
                    .filter(|n| values.contains(&mapping.zodiac[*n as usize - 1]))
                    .collect()
            } else {
                let mut result = values.to_vec();
                result.sort_unstable();
                result
            }
        };
        let left = expand(&self.left);
        let right = expand(&self.right);
        if rule
            .selection_limit
            .is_some_and(|max| left.len() + right.len() > max as usize)
        {
            return Err("拖的总候选项超过玩法最多可选数量".into());
        }
        let (left_count, right_count) = if k == 2 {
            (1, 1)
        } else {
            if left.len() >= k {
                return Err("固定项须少于每注选项数".into());
            }
            (left.len(), k - left.len())
        };
        if right.len() < right_count {
            return Err("拖项不足以补齐一条基础注".into());
        }
        let count = choose(left.len(), left_count) * choose(right.len(), right_count);
        if count > MAX_UNITS as u64 {
            return Err("单次提交最多 1000 条基础注，请减少拖项".into());
        }
        let mut sets = Vec::with_capacity(count as usize);
        let right_sets = combinations(&right, right_count);
        for fixed in combinations(&left, left_count) {
            for trailing in &right_sets {
                let mut set = fixed.clone();
                set.extend(trailing);
                set.sort_unstable();
                sets.push(set);
            }
        }
        Ok(sets)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BetInput {
    #[serde(default, skip_serializing_if = "crate::market::Market::is_macau")]
    pub market: crate::market::Market,
    pub period: String,
    pub play_id: i64,
    pub play_version: i64,
    pub selections: Vec<u8>, // number: 1..49; all other kinds: zero-based option index
    pub compound: bool,
    pub amount: String, // yuan, at most one decimal place
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub package_zodiacs: Vec<u8>, // empty for ordinary bets; otherwise total per zodiac
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drag: Option<DragInput>,
    pub request_id: String,
    #[serde(default)]
    pub bettor: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Atom {
    pub options: Vec<u8>,
    pub mask: u64,
    pub kind: Kind,
    pub scope: Scope,
    pub condition: Condition,
    #[serde(default = "one_hit")]
    pub minimum_hits: u8,
    pub stake: i64,
    pub payout: i64,
    pub rebate: i64,
    pub odds: String,
    #[serde(default)]
    pub rebate_percent: String,
    #[serde(default)]
    pub void_on_49: bool,
    #[serde(default = "long_position")]
    pub position: i8,
    #[serde(default)]
    pub special_hit_odds: Option<String>,
    #[serde(default)]
    pub special_hit_payout: Option<i64>,
}
impl Atom {
    pub fn max_payout(&self) -> i64 {
        self.payout.max(self.special_hit_payout.unwrap_or(0))
    }
}
fn long_position() -> i8 {
    1
}
fn one_hit() -> u8 {
    1
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BetPlan {
    pub atoms: Vec<Atom>,
    pub stake: i64,
    pub rebate: i64,
    pub exposure: i64,
}
pub fn plan(rule: &Rule, input: &BetInput, mapping: &Mapping) -> RuleResult<BetPlan> {
    rule.validate()?;
    mapping.validate()?;
    let amount = entry_amount(&input.amount)?;
    if input.drag.is_some()
        && (!input.compound || !input.selections.is_empty() || !input.package_zodiacs.is_empty())
    {
        return Err("拖须选择复式，不能同时使用普通选项或包肖".into());
    }
    if !input.package_zodiacs.is_empty() {
        if rule.kind != Kind::Number
            || rule.quantity != 1
            || input.compound
            || !input.selections.is_empty()
            || !rule.relation.accepts(1, rule.quantity)
        {
            return Err("包肖仅适用于单号码玩法，不能同时选择普通号码或复式".into());
        }
        let mut zodiacs = input.package_zodiacs.clone();
        zodiacs.sort_unstable();
        if zodiacs.iter().any(|z| *z >= 12) || zodiacs.windows(2).any(|w| w[0] == w[1]) {
            return Err("包肖生肖重复或不合法".into());
        }
        let mut regular = input.clone();
        regular.package_zodiacs.clear();
        regular.selections = (1..=49)
            .filter(|n| zodiacs.contains(&mapping.zodiac[*n as usize - 1]))
            .collect();
        let mut planned = plan(rule, &regular, mapping)?;
        price_package(&mut planned.atoms, &zodiacs, mapping, amount)?;
        return total_plan(planned.atoms);
    }
    let sets = if let Some(drag) = &input.drag {
        drag.sets(rule, mapping)?
    } else {
        let mut options = input.selections.clone();
        if rule.condition != Condition::HardPair {
            options.sort_unstable();
        }
        if input.compound && !rule.compound_enabled {
            return Err("此玩法未启用复式".into());
        }
        if rule.condition == Condition::HardPair && options.len() != 2 {
            return Err("特碰请依次选择一个特码、一个平码，位置不可互换".into());
        }
        if options.is_empty()
            || options
                .iter()
                .enumerate()
                .any(|(i, n)| options[..i].contains(n))
            || options.iter().any(|n| {
                if rule.kind == Kind::Number {
                    !(1..=49).contains(n)
                } else if rule.kind == Kind::ZodiacCount {
                    !(1..=7).contains(n)
                } else {
                    *n >= rule.kind.size()
                }
            })
        {
            return Err("投注选项为空、重复或不合法".into());
        }
        if rule
            .selection_limit
            .is_some_and(|n| options.len() > n as usize)
        {
            return Err(format!(
                "此玩法最多选择 {} 项",
                rule.selection_limit.unwrap()
            ));
        }
        if rule.kind == Kind::ZodiacCount && options.as_slice() != [rule.zodiac_count.unwrap()] {
            return Err("请选择该玩法配置的目标生肖种数".into());
        }
        let k = if input.compound {
            rule.combination_size as usize
        } else if rule.quantity == 1 {
            1 // Multi-select single-option plays produce independent basic bets.
        } else {
            if !rule.relation.accepts(options.len() as u8, rule.quantity) {
                return Err("未启用复式时，选择数量必须满足配置的数量关系".into());
            }
            options.len().min(rule.quantity as usize)
        };
        if rule.condition == Condition::AtLeast && k < rule.minimum_hits as usize {
            return Err("选项数量不能少于最少命中数".into());
        }
        let split = input.compound || k < options.len();
        if k > options.len() || !rule.relation.accepts(k as u8, rule.quantity) {
            return Err("选项数量不满足玩法配置".into());
        }
        let count = if split { choose(options.len(), k) } else { 1 };
        if count > MAX_UNITS as u64 {
            return Err("单次提交最多 1000 条基础注，请减少候选选项".into());
        }
        if split {
            combinations(&options, k)
        } else {
            vec![options]
        }
    };
    let mut atoms = Vec::with_capacity(sets.len());
    for opts in sets {
        let mask = opts.iter().fold(0_u64, |m, n| {
            m | 1_u64
                << (if rule.kind == Kind::Number {
                    *n - 1
                } else {
                    *n
                })
        });
        let natal = rule.kind != Kind::Wave && mask & mapping.natal_options(rule.kind) != 0;
        let odds = if rule.kind == Kind::Tail && mask & 1 != 0 && rule.zero_tail_odds.is_some() {
            rule.zero_tail_odds.as_ref().unwrap()
        } else if natal {
            rule.special_odds.as_ref().unwrap_or(&rule.odds)
        } else {
            &rule.odds
        };
        let rebate_percent = if natal {
            rule.special_rebate_percent
                .as_ref()
                .unwrap_or(&rule.rebate_percent)
        } else {
            &rule.rebate_percent
        };
        let rebate = rounded_product(amount, scaled(rebate_percent, 2)?)?;
        atoms.push(Atom {
            options: opts,
            mask,
            kind: rule.kind,
            scope: rule.scope,
            condition: rule.condition,
            minimum_hits: rule.minimum_hits,
            stake: amount,
            payout: rounded_product(amount, scaled(odds, 4)?)?,
            rebate,
            odds: odds.clone(),
            rebate_percent: rebate_percent.clone(),
            void_on_49: matches!(rule.kind, Kind::Parity | Kind::Size),
            position: 1,
            special_hit_odds: rule.special_hit_odds.clone(),
            special_hit_payout: rule
                .special_hit_odds
                .as_ref()
                .map(|v| scaled(v, 4).and_then(|v| rounded_product(amount, v)))
                .transpose()?,
        });
    }
    total_plan(atoms)
}
pub fn entry_amount(value: &str) -> RuleResult<i64> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || (value.contains('.')
            && (fraction.len() != 1 || !fraction.bytes().all(|b| b.is_ascii_digit())))
    {
        return Err("投注金额须为正数，最多一位小数".into());
    }
    let amount = scaled(value, 2)?;
    if amount < 10 {
        return Err("投注金额最少 0.1 元".into());
    }
    Ok(amount)
}
pub fn price_atom(a: &mut Atom, amount: i64) -> RuleResult<()> {
    if amount <= 0 {
        return Err("基础注金额必须大于零".into());
    }
    a.stake = amount;
    a.payout = rounded_product(amount, scaled(&a.odds, 4)?)?;
    a.special_hit_payout = a
        .special_hit_odds
        .as_ref()
        .map(|v| scaled(v, 4).and_then(|v| rounded_product(amount, v)))
        .transpose()?;
    a.rebate = rounded_product(amount, scaled(&a.rebate_percent, 2)?)?;
    Ok(())
}
pub fn price_package(
    atoms: &mut [Atom],
    packages: &[u8],
    mapping: &Mapping,
    amount: i64,
) -> RuleResult<()> {
    for zodiac in packages {
        let mut indices: Vec<usize> = atoms
            .iter()
            .enumerate()
            .filter(|(_, a)| mapping.zodiac[a.options[0] as usize - 1] == *zodiac)
            .map(|(i, _)| i)
            .collect();
        indices.sort_unstable_by_key(|i| atoms[*i].options[0]);
        if indices.is_empty() || amount < indices.len() as i64 {
            return Err("包肖分配后每个号码至少一分钱".into());
        }
        for (position, index) in indices.iter().enumerate() {
            price_atom(
                &mut atoms[*index],
                amount / indices.len() as i64
                    + i64::from((position as i64) < amount % indices.len() as i64),
            )?;
        }
    }
    Ok(())
}
pub fn total_plan(atoms: Vec<Atom>) -> RuleResult<BetPlan> {
    Ok(BetPlan {
        stake: checked_sum(atoms.iter().map(|a| a.stake))?,
        rebate: checked_sum(atoms.iter().map(|a| a.rebate))?,
        exposure: checked_sum(atoms.iter().map(Atom::max_payout))?,
        atoms,
    })
}

pub fn choose(n: usize, k: usize) -> u64 {
    if k > n {
        return 0;
    }
    let k = k.min(n - k);
    (0..k).fold(1_u64, |r, i| r * (n - i) as u64 / (i + 1) as u64)
}
pub fn combinations<T: Copy>(values: &[T], k: usize) -> Vec<Vec<T>> {
    fn walk<T: Copy>(
        values: &[T],
        k: usize,
        start: usize,
        current: &mut Vec<T>,
        out: &mut Vec<Vec<T>>,
    ) {
        if current.len() == k {
            out.push(current.clone());
            return;
        }
        for i in start..=values.len() - (k - current.len()) {
            current.push(values[i]);
            walk(values, k, i + 1, current, out);
            current.pop();
        }
    }
    let mut out = vec![];
    if k > 0 && k <= values.len() {
        walk(values, k, 0, &mut vec![], &mut out);
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Draw {
    pub expect: String,
    pub open_time: NaiveDateTime,
    pub numbers: [u8; 7],
    pub zodiac: [u8; 7],
    pub waves: [u8; 7],
}
impl Draw {
    pub fn predicted(numbers: [u8; 7], mapping: &Mapping) -> Self {
        Self {
            expect: String::new(),
            open_time: NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            zodiac: numbers.map(|n| mapping.zodiac[n as usize - 1]),
            waves: numbers.map(wave),
            numbers,
        }
    }
    pub fn masks(&self, scope: Scope) -> [u64; 6] {
        let indexes = match scope {
            Scope::Regular => 0..6,
            Scope::Special => 6..7,
            Scope::All => 0..7,
        };
        let mut masks = [0; 6];
        for i in indexes {
            masks[0] |= 1 << (self.numbers[i] - 1);
            masks[1] |= 1 << self.zodiac[i];
            masks[2] |= 1 << self.waves[i];
            masks[3] |= 1 << (self.numbers[i] % 10);
            masks[4] |= 1 << (self.numbers[i] % 2);
            masks[5] |= 1 << u8::from(self.numbers[i] >= 25);
        }
        masks
    }
    pub fn differs_from(&self, mapping: &Mapping) -> bool {
        (0..7).any(|i| {
            self.zodiac[i] != mapping.zodiac[self.numbers[i] as usize - 1]
                || self.waves[i] != wave(self.numbers[i])
        })
    }
}
pub fn is_void(atom: &Atom, draw: &Draw) -> bool {
    atom.void_on_49
        && match atom.scope {
            Scope::Regular => draw.numbers[..6].contains(&49),
            Scope::Special => draw.numbers[6] == 49,
            Scope::All => draw.numbers.contains(&49),
        }
}
pub fn wins(atom: &Atom, draw: &Draw) -> bool {
    if is_void(atom, draw) {
        return false;
    }
    if atom.kind == Kind::ZodiacCount {
        let count = draw
            .zodiac
            .iter()
            .fold(0u16, |mask, z| mask | (1 << z))
            .count_ones();
        return atom.mask & (1 << count) != 0;
    }
    if matches!(atom.condition, Condition::HardPair | Condition::SoftPair) {
        if atom.options.len() != 2 {
            return false;
        }
        let a = atom.options[0];
        let b = atom.options[1];
        return (draw.numbers[6] == a && draw.numbers[..6].contains(&b))
            || (atom.condition == Condition::SoftPair
                && draw.numbers[6] == b
                && draw.numbers[..6].contains(&a));
    }
    matches_minimum(
        atom.condition,
        atom.mask,
        draw.masks(atom.scope)[atom.kind.index()],
        atom.minimum_hits,
    )
}
pub fn condition_matches(condition: Condition, mask: u64, draw: u64) -> bool {
    matches_minimum(condition, mask, draw, 1)
}
pub fn matches_minimum(condition: Condition, mask: u64, draw: u64, minimum_hits: u8) -> bool {
    let hit = mask & draw;
    match condition {
        Condition::All => hit == mask,
        Condition::None => hit == 0,
        Condition::Any => hit != 0,
        Condition::AtLeast => hit.count_ones() >= u32::from(minimum_hits),
        Condition::HardPair | Condition::SoftPair => false,
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AtomResult {
    #[serde(default)]
    pub voided: bool,
    pub won: bool,
    pub payout: i64,
    pub rebate: i64,
    pub net: i64,
}
pub fn settle(atoms: &[Atom], draw: &Draw) -> Vec<AtomResult> {
    atoms
        .iter()
        .map(|a| {
            let voided = is_void(a, draw);
            let won = wins(a, draw);
            let payout = if voided {
                a.stake
            } else if won {
                if a.options.contains(&draw.numbers[6]) {
                    a.special_hit_payout.unwrap_or(a.payout)
                } else {
                    a.payout
                }
            } else {
                0
            };
            let rebate = if voided { 0 } else { a.rebate };
            AtomResult {
                voided,
                won,
                payout,
                rebate,
                net: a.stake - payout - rebate,
            }
        })
        .collect()
}

pub fn period_id(date: NaiveDate) -> String {
    format!("{}{:03}", date.year(), date.ordinal())
}
/// Input is the server's Beijing civil time. A draw date owns [06:00, next 06:00).
pub fn business_date(now: NaiveDateTime) -> NaiveDate {
    (now - chrono::Duration::hours(6)).date()
}
pub fn accepts_entries(now: NaiveDateTime, date: NaiveDate) -> bool {
    business_date(now) == date
}
/// Both markets start draw polling at 21:34 Beijing time on the period's date.
pub fn draw_fetch_start(date: NaiveDate) -> NaiveDateTime {
    date.and_hms_opt(21, 34, 0).unwrap()
}
pub fn normalize_zodiac(s: &str) -> Option<u8> {
    let s = match s {
        "龍" => "龙",
        "馬" => "马",
        "雞" | "鷄" => "鸡",
        "豬" => "猪",
        other => other,
    };
    ZODIACS.iter().position(|z| *z == s).map(|i| i as u8)
}
pub fn parse_draw(value: &serde_json::Value) -> RuleResult<Draw> {
    parse_market_draw(value, crate::market::Market::Macau)
}
pub fn parse_market_draw(
    value: &serde_json::Value,
    market: crate::market::Market,
) -> RuleResult<Draw> {
    let field = |name: &str| {
        value
            .get(name)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("开奖字段 {name} 缺失或不是字符串"))
    };
    let expect = field("expect")?.to_string();
    let open_time = NaiveDateTime::parse_from_str(field("openTime")?, "%Y-%m-%d %H:%M:%S")
        .map_err(|_| "开奖时间格式不合法")?;
    if market.is_macau() && expect != period_id(open_time.date()) {
        return Err("接口期号与开奖业务日期不一致".into());
    }
    if expect.len() != 7
        || !expect.bytes().all(|b| b.is_ascii_digit())
        || expect[..4].parse::<i32>().ok() != Some(open_time.year())
        || expect[4..].parse::<u16>().unwrap_or(0) == 0
    {
        return Err("接口期号格式或年份不合法".into());
    }
    let numbers: Vec<u8> = field("openCode")?
        .split(',')
        .map(|v| v.trim().parse::<u8>().map_err(|_| "开奖号码不合法"))
        .collect::<Result<_, _>>()?;
    if market == crate::market::Market::Hk {
        if value.get("type").is_some_and(|v| v.as_str() != Some("9")) {
            return Err("香港开奖来源类型不匹配".into());
        }
        if let Some(raw) = value.get("numbers") {
            let parsed: Option<Vec<u8>> = raw.as_array().and_then(|items| {
                items
                    .iter()
                    .map(|v| v.as_str()?.trim().parse().ok())
                    .collect()
            });
            if parsed.as_ref() != Some(&numbers) {
                return Err("香港开奖号码字段不一致".into());
            }
        }
    }
    let zodiac: Vec<u8> = field("zodiac")?
        .split(',')
        .map(|v| normalize_zodiac(v.trim()).ok_or("开奖生肖不合法"))
        .collect::<Result<_, _>>()?;
    let waves: Vec<u8> = field("wave")?
        .split(',')
        .map(|v| match v.trim() {
            "red" => Ok(0),
            "blue" => Ok(1),
            "green" => Ok(2),
            _ => Err("开奖波色不合法"),
        })
        .collect::<Result<_, _>>()?;
    if numbers.len() != 7
        || zodiac.len() != 7
        || waves.len() != 7
        || numbers.iter().any(|n| !(1..=49).contains(n))
    {
        return Err("开奖须包含七个合法号码及对应生肖、波色".into());
    }
    let mut sorted = numbers.clone();
    sorted.sort_unstable();
    if sorted.windows(2).any(|w| w[0] == w[1]) {
        return Err("开奖号码不能重复".into());
    }
    Ok(Draw {
        expect,
        open_time,
        numbers: numbers.try_into().unwrap(),
        zodiac: zodiac.try_into().unwrap(),
        waves: waves.try_into().unwrap(),
    })
}
