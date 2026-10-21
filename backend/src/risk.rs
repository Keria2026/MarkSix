//! Exact extrema. Equivalence classes preserve every predicate; interval bounds
//! only prune subtrees unable to improve either attained incumbent. No sampling
//! result is ever returned as exact. A deadline/cancellation discards the result.
use crate::domain::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskResult {
    pub min_payout: i64,
    pub max_payout: i64,
    pub best_draw: [u8; 7],
    pub worst_draw: [u8; 7],
    pub nodes: u64,
    pub elapsed_ms: u64,
    pub strategy: String,
    pub min_net: i64,
    pub max_net: i64,
}
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RiskError {
    #[error("精确计算超过 60 秒，未发布估算结果")]
    Timeout,
    #[error("投注快照已过期")]
    Cancelled,
    #[error("风险输入不合法")]
    Invalid,
}
#[derive(Clone)]
struct Term {
    kind: Kind,
    scope: Scope,
    condition: Condition,
    minimum_hits: u8,
    mask: u64,
    pay: i64,
    event_numbers: u64,
    special_gate: u64,
    void_regular: bool,
}
struct Search<'a> {
    terms: Vec<Term>,
    mapping: &'a Mapping,
    cancel: &'a AtomicBool,
    deadline: Instant,
    start: Instant,
    result: RiskResult,
    groups: Vec<Vec<u8>>,
    suffix: Vec<[u64; 6]>,
    suffix_count: Vec<usize>,
    feature_numbers: [[u64; 49]; 6],
    special: u8,
    special_masks: [u64; 6],
    fixed: i64,
}
fn merge(a: [u64; 6], b: [u64; 6]) -> [u64; 6] {
    std::array::from_fn(|i| a[i] | b[i])
}
fn draw_payout(atoms: &[Atom], numbers: [u8; 7], mapping: &Mapping) -> i64 {
    let draw = Draw::predicted(numbers, mapping);
    settle(atoms, &draw)
        .iter()
        .zip(atoms)
        .map(|(r, a)| (r.payout + r.rebate - a.rebate) * i64::from(a.position))
        .sum()
}
fn update(result: &mut RiskResult, pay: i64, draw: [u8; 7]) {
    if pay < result.min_payout {
        result.min_payout = pay;
        result.best_draw = draw;
    }
    if pay > result.max_payout {
        result.max_payout = pay;
        result.worst_draw = draw;
    }
}

fn finish(mut result: RiskResult, atoms: &[Atom]) -> Result<RiskResult, RiskError> {
    let base = checked_sum(
        atoms
            .iter()
            .map(|a| (a.stake - a.rebate) * i64::from(a.position)),
    )
    .map_err(|_| RiskError::Invalid)?;
    result.min_net = checked_sum([base, -result.max_payout]).map_err(|_| RiskError::Invalid)?;
    result.max_net = checked_sum([base, -result.min_payout]).map_err(|_| RiskError::Invalid)?;
    if result.min_payout.abs() > MONEY_LIMIT || result.max_payout.abs() > MONEY_LIMIT {
        return Err(RiskError::Invalid);
    }
    Ok(result)
}
fn special_payout(atoms: &[Atom], n: u8, mapping: &Mapping) -> i64 {
    let masks = mapping.features(n);
    atoms
        .iter()
        .filter(|a| a.scope == Scope::Special)
        .map(|a| {
            let payout = if a.void_on_49 && n == 49 {
                a.stake - a.rebate
            } else if matches_minimum(a.condition, a.mask, masks[a.kind.index()], a.minimum_hits) {
                a.payout
            } else {
                0
            };
            payout * i64::from(a.position)
        })
        .sum()
}

pub fn solve(
    atoms: &[Atom],
    mapping: &Mapping,
    budget: Duration,
    cancel: &AtomicBool,
) -> Result<RiskResult, RiskError> {
    solve_universe(
        atoms,
        mapping,
        budget,
        cancel,
        &(1..=49).collect::<Vec<_>>(),
    )
}
fn solve_universe(
    atoms: &[Atom],
    mapping: &Mapping,
    budget: Duration,
    cancel: &AtomicBool,
    universe: &[u8],
) -> Result<RiskResult, RiskError> {
    let start = Instant::now();
    if mapping.validate().is_err()
        || universe.len() < 7
        || checked_sum(atoms.iter().map(|a| a.max_payout().max(a.stake))).is_err()
        || atoms.iter().any(|a| {
            !matches!(a.position, -1 | 1)
                || (a.kind == Kind::ZodiacCount && a.scope != Scope::All)
                || (a.special_hit_payout.is_some()
                    && (a.kind != Kind::Number
                        || a.scope != Scope::All
                        || a.condition != Condition::All
                        || a.mask.count_ones() != 2
                        || a.options.len() != 2))
        })
    {
        return Err(RiskError::Invalid);
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(RiskError::Cancelled);
    }
    if budget.is_zero() {
        return Err(RiskError::Timeout);
    }
    let mut result = RiskResult {
        min_payout: i64::MAX,
        max_payout: i64::MIN,
        best_draw: [0; 7],
        worst_draw: [0; 7],
        nodes: 0,
        elapsed_ms: 0,
        strategy: "branch_and_bound".into(),
        min_net: 0,
        max_net: 0,
    };
    // Linear number bets and arbitrary special-only bets have a direct exact solution.
    if atoms.iter().all(|a| {
        !matches!(a.condition, Condition::HardPair | Condition::SoftPair)
            && (a.scope == Scope::Special || (a.kind == Kind::Number && a.mask.count_ones() == 1))
    }) {
        let mut regular = [0_i64; 50];
        let mut all = [0_i64; 50];
        let mut constant = 0;
        for a in atoms.iter().filter(|a| a.scope != Scope::Special) {
            let n = a.mask.trailing_zeros() as usize + 1;
            let pay = a.payout * i64::from(a.position);
            let coeff = if a.condition == Condition::None {
                constant += pay;
                -pay
            } else {
                pay
            };
            regular[n] += coeff;
            if a.scope == Scope::All {
                all[n] += coeff;
            }
        }
        for &s in universe {
            if cancel.load(Ordering::Relaxed) {
                return Err(RiskError::Cancelled);
            }
            if start.elapsed() >= budget {
                return Err(RiskError::Timeout);
            }
            let mut rest: Vec<u8> = universe.iter().copied().filter(|n| *n != s).collect();
            rest.sort_by_key(|n| regular[*n as usize]);
            let special = special_payout(atoms, s, mapping);
            for ns in [&rest[..6], &rest[rest.len() - 6..]] {
                let mut draw = [0; 7];
                draw[..6].copy_from_slice(ns);
                draw[..6].sort_unstable();
                draw[6] = s;
                let value = constant
                    + all[s as usize]
                    + special
                    + ns.iter().map(|n| regular[*n as usize]).sum::<i64>();
                update(&mut result, value, draw);
            }
        }
        result.nodes = universe.len() as u64;
        result.elapsed_ms = start.elapsed().as_millis() as u64;
        result.strategy = "linear".into();
        return finish(result, atoms);
    }
    // Seed valid witnesses only to tighten bounds. Proof still requires the full search.
    for shift in 0..universe.len() {
        let numbers = std::array::from_fn(|i| universe[(i + shift) % universe.len()]);
        update(&mut result, draw_payout(atoms, numbers, mapping), numbers);
    }
    let all_numbers = (1_u64 << 49) - 1;
    let mut aggregated = HashMap::<(Kind, Scope, Condition, u64, u64, bool, u8), i64>::new();
    for a in atoms.iter().filter(|a| a.scope != Scope::Special) {
        let pay = a.payout * i64::from(a.position);
        if matches!(a.condition, Condition::HardPair | Condition::SoftPair) {
            if a.options.len() != 2 {
                return Err(RiskError::Invalid);
            }
            let x = 1_u64 << (a.options[0] - 1);
            let y = 1_u64 << (a.options[1] - 1);
            *aggregated
                .entry((Kind::Number, Scope::Regular, Condition::All, y, x, false, 1))
                .or_default() += pay;
            if a.condition == Condition::SoftPair {
                *aggregated
                    .entry((Kind::Number, Scope::Regular, Condition::All, x, y, false, 1))
                    .or_default() += pay;
            }
        } else {
            let gate = if a.void_on_49 && a.scope == Scope::All {
                all_numbers & !(1 << 48)
            } else {
                all_numbers
            };
            *aggregated
                .entry((
                    a.kind,
                    a.scope,
                    a.condition,
                    a.mask,
                    gate,
                    a.void_on_49,
                    a.minimum_hits,
                ))
                .or_default() += pay;
            if let Some(special_payout) = a.special_hit_payout {
                let delta = (special_payout - a.payout) * i64::from(a.position);
                for &n in &a.options {
                    let special = 1_u64 << (n - 1);
                    *aggregated
                        .entry((
                            Kind::Number,
                            Scope::Regular,
                            Condition::All,
                            a.mask & !special,
                            special,
                            false,
                            1,
                        ))
                        .or_default() += delta;
                }
            }
            if a.void_on_49 {
                *aggregated
                    .entry((
                        Kind::Number,
                        a.scope,
                        Condition::Any,
                        1 << 48,
                        all_numbers,
                        false,
                        1,
                    ))
                    .or_default() += (a.stake - a.rebate) * i64::from(a.position);
            }
        }
    }
    let mut feature_numbers = [[0; 49]; 6];
    for &n in universe {
        let f = mapping.features(n);
        for k in 0..6 {
            feature_numbers[k][f[k].trailing_zeros() as usize] |= 1 << (n - 1);
        }
    }
    let mut terms: Vec<Term> = aggregated
        .into_iter()
        .map(
            |((kind, scope, condition, mask, special_gate, void_regular, minimum_hits), pay)| {
                let event_numbers = universe
                    .iter()
                    .filter(|n| mapping.features(**n)[kind.index()] & mask != 0)
                    .fold(0, |m, n| m | 1 << (*n - 1));
                Term {
                    kind,
                    scope,
                    condition,
                    minimum_hits,
                    mask,
                    pay,
                    event_numbers,
                    special_gate,
                    void_regular,
                }
            },
        )
        .collect();
    terms.sort_by_key(|a| (a.kind.index(), a.scope as u8, a.condition as u8, a.mask));
    let mut classes: Vec<(Vec<u64>, Vec<u8>)> = vec![];
    for &n in universe {
        let features = mapping.features(n);
        let mut signature = vec![];
        for (kind, feature) in features.iter().enumerate().skip(1) {
            if terms.iter().any(|t| t.kind.index() == kind) {
                signature.push(*feature);
            }
        }
        // Number predicates depend on counts within identical membership classes.
        for t in terms.iter().filter(|t| t.kind == Kind::Number) {
            signature.push(u64::from(features[0] & t.mask != 0));
        }
        if terms.iter().any(|t| t.void_regular) {
            signature.push(u64::from(n == 49));
        }
        if let Some((_, numbers)) = classes.iter_mut().find(|(sig, _)| *sig == signature) {
            numbers.push(n);
        } else {
            classes.push((signature, vec![n]));
        }
    }
    let mut search = Search {
        terms,
        mapping,
        cancel,
        deadline: start + budget,
        start,
        result,
        groups: vec![],
        suffix: vec![],
        suffix_count: vec![],
        feature_numbers,
        special: 0,
        special_masks: [0; 6],
        fixed: 0,
    };
    let mut special_classes = std::collections::HashSet::new();
    for &special in universe {
        search.check()?;
        let masks = mapping.features(special);
        let fixed = special_payout(atoms, special, mapping);
        let gates: Vec<bool> = search
            .terms
            .iter()
            .map(|t| t.special_gate & (1 << (special - 1)) != 0)
            .collect();
        let group_id = classes
            .iter()
            .position(|(_, ns)| ns.contains(&special))
            .unwrap();
        if !special_classes.insert((group_id, fixed, gates)) {
            continue;
        }
        search.special = special;
        search.special_masks = masks;
        search.fixed = fixed;
        search.groups = classes
            .iter()
            .map(|(_, ns)| {
                ns.iter()
                    .copied()
                    .filter(|n| *n != special)
                    .collect::<Vec<_>>()
            })
            .filter(|ns| !ns.is_empty())
            .collect();
        let count = search.groups.len();
        search.suffix = vec![[0; 6]; count + 1];
        search.suffix_count = vec![0; count + 1];
        for i in (0..count).rev() {
            search.suffix[i] = search.suffix[i + 1];
            for &n in &search.groups[i] {
                search.suffix[i] = merge(search.suffix[i], mapping.features(n));
            }
            search.suffix_count[i] = search.suffix_count[i + 1] + search.groups[i].len();
        }
        search.visit(0, 6, [0; 6], &mut Vec::with_capacity(6))?;
    }
    search.check()?;
    search.result.elapsed_ms = search.start.elapsed().as_millis() as u64;
    finish(search.result, atoms)
}
impl Search<'_> {
    fn check(&self) -> Result<(), RiskError> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(RiskError::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(RiskError::Timeout)
        } else {
            Ok(())
        }
    }
    fn bounds(&self, masks: [u64; 6], future: [u64; 6], remaining: usize) -> (i64, i64) {
        let (mut low, mut high) = (self.fixed, self.fixed);
        for t in &self.terms {
            if t.special_gate & (1 << (self.special - 1)) == 0 {
                continue;
            }
            if t.kind == Kind::ZodiacCount {
                let selected = masks[1] | self.special_masks[1];
                let have = selected.count_ones() as usize;
                let same_capacity = (0..12)
                    .filter(|i| selected & (1 << i) != 0)
                    .map(|i| (future[0] & self.feature_numbers[1][i]).count_ones() as usize)
                    .sum::<usize>();
                let mut missing = remaining.saturating_sub(same_capacity);
                let mut capacities = (0..12)
                    .filter(|i| selected & (1 << i) == 0)
                    .map(|i| (future[0] & self.feature_numbers[1][i]).count_ones() as usize)
                    .filter(|n| *n > 0)
                    .collect::<Vec<_>>();
                capacities.sort_unstable_by(|a, b| b.cmp(a));
                let max = have + remaining.min(capacities.len());
                let mut min = have;
                for capacity in capacities {
                    if missing == 0 {
                        break;
                    }
                    min += 1;
                    missing = missing.saturating_sub(capacity);
                }
                let feasible = (min..=max).fold(0_u64, |mask, n| mask | (1 << n));
                let certain = feasible & t.mask == feasible;
                let possible = feasible & t.mask != 0;
                if t.pay >= 0 {
                    if certain {
                        low += t.pay;
                    }
                    if possible {
                        high += t.pay;
                    }
                } else {
                    if possible {
                        low += t.pay;
                    }
                    if certain {
                        high += t.pay;
                    }
                }
                continue;
            }
            let selected = if t.scope == Scope::All {
                masks[t.kind.index()] | self.special_masks[t.kind.index()]
            } else {
                masks[t.kind.index()]
            };
            let hit = selected & t.mask;
            let possible = future[t.kind.index()] & t.mask;
            let forced_hit = (future[0] & !t.event_numbers).count_ones() < remaining as u32;
            let (mut certain, mut possible_win) = match t.condition {
                Condition::AtLeast => {
                    let have = hit.count_ones();
                    let can_add = (possible & !hit).count_ones().min(remaining as u32);
                    (
                        have >= u32::from(t.minimum_hits),
                        have + can_add >= u32::from(t.minimum_hits),
                    )
                }
                Condition::Any => (hit != 0 || forced_hit, hit != 0 || possible != 0),
                Condition::None => (hit == 0 && possible == 0, hit == 0 && !forced_hit),
                Condition::HardPair | Condition::SoftPair => {
                    unreachable!("pair terms are expanded")
                }
                Condition::All => {
                    let missing = t.mask & !hit;
                    let can = missing & !future[t.kind.index()] == 0
                        && missing.count_ones() <= remaining as u32;
                    let mut bits = missing;
                    let mut must = can;
                    while bits != 0 && must {
                        let i = bits.trailing_zeros() as usize;
                        bits &= bits - 1;
                        must = (future[0] & !self.feature_numbers[t.kind.index()][i]).count_ones()
                            < remaining as u32;
                    }
                    (missing == 0 || must, missing == 0 || can)
                }
            };
            if t.void_regular {
                if masks[0] & (1 << 48) != 0 {
                    certain = false;
                    possible_win = false;
                } else if remaining > 0 && future[0] & (1 << 48) != 0 {
                    certain = false;
                }
            }
            if t.pay >= 0 {
                if certain {
                    low += t.pay;
                }
                if possible_win {
                    high += t.pay;
                }
            } else {
                if possible_win {
                    low += t.pay;
                }
                if certain {
                    high += t.pay;
                }
            }
        }
        (low, high)
    }
    fn visit(
        &mut self,
        index: usize,
        remaining: usize,
        masks: [u64; 6],
        picked: &mut Vec<u8>,
    ) -> Result<(), RiskError> {
        self.result.nodes += 1;
        if self.result.nodes & 255 == 0 {
            self.check()?;
        }
        if self.suffix_count[index] < remaining {
            return Ok(());
        }
        let (low, high) = self.bounds(
            masks,
            if remaining == 0 {
                [0; 6]
            } else {
                self.suffix[index]
            },
            remaining,
        );
        if low >= self.result.min_payout && high <= self.result.max_payout {
            return Ok(());
        }
        if remaining == 0 {
            debug_assert_eq!(low, high);
            let mut draw = [0; 7];
            draw[..6].copy_from_slice(picked);
            draw[..6].sort_unstable();
            draw[6] = self.special;
            update(&mut self.result, low, draw);
            return Ok(());
        }
        if index == self.groups.len() {
            return Ok(());
        }
        let max = self.groups[index].len().min(remaining);
        let min = remaining.saturating_sub(self.suffix_count[index + 1]);
        let original = picked.len();
        for take in (min..=max).rev() {
            let mut next = masks;
            for i in 0..take {
                let n = self.groups[index][i];
                next = merge(next, self.mapping.features(n));
                picked.push(n);
            }
            self.visit(index + 1, remaining - take, next, picked)?;
            picked.truncate(original);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn atom(kind: Kind, scope: Scope, condition: Condition, mask: u64, payout: i64) -> Atom {
        Atom {
            options: vec![],
            mask,
            kind,
            scope,
            condition,
            minimum_hits: 1,
            stake: 100,
            payout,
            rebate: 0,
            odds: "1".into(),
            rebate_percent: "0".into(),
            void_on_49: false,
            position: 1,
            special_hit_odds: None,
            special_hit_payout: None,
        }
    }
    #[test]
    fn mutually_exclusive_specials() {
        let a = vec![
            atom(Kind::Number, Scope::Special, Condition::All, 1, 430000),
            atom(Kind::Number, Scope::Special, Condition::All, 2, 430000),
        ];
        let m = Mapping::default();
        let r = solve(&a, &m, Duration::from_secs(1), &AtomicBool::new(false)).unwrap();
        assert_eq!(r.min_payout, 0);
        assert_eq!(r.max_payout, 430000);
        assert_eq!(draw_payout(&a, r.worst_draw, &m), 430000);
    }
    #[test]
    fn branch_bounds_match_independent_exhaustion() {
        let m = Mapping::default();
        let universe: Vec<u8> = (1..=11).collect();
        for seed in 0..18_u64 {
            let mut random = seed + 1;
            let mut atoms = vec![];
            for i in 0..24 {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                let kind = [
                    Kind::Number,
                    Kind::Zodiac,
                    Kind::Tail,
                    Kind::Parity,
                    Kind::Wave,
                ][i % 5];
                let scope = if kind == Kind::Wave {
                    Scope::Special
                } else {
                    [Scope::Regular, Scope::Special, Scope::All][i % 3]
                };
                let a = random % kind.size() as u64;
                let b = (random >> 16) % kind.size() as u64;
                atoms.push(atom(
                    kind,
                    scope,
                    [Condition::All, Condition::Any, Condition::None][(i / 2) % 3],
                    (1 << a) | (1 << b),
                    ((random >> 32) % 100 + 1) as i64,
                ));
            }
            let r = solve_universe(
                &atoms,
                &m,
                Duration::from_secs(5),
                &AtomicBool::new(false),
                &universe,
            )
            .unwrap();
            let (mut min, mut max) = (i64::MAX, 0);
            for &s in &universe {
                let rest: Vec<u8> = universe.iter().copied().filter(|n| *n != s).collect();
                for combo in combinations(&rest, 6) {
                    let mut draw = [0; 7];
                    draw[..6].copy_from_slice(&combo);
                    draw[6] = s;
                    let p = draw_payout(&atoms, draw, &m);
                    min = min.min(p);
                    max = max.max(p);
                }
            }
            assert_eq!((r.min_payout, r.max_payout), (min, max), "seed {seed}");
            assert_eq!(draw_payout(&atoms, r.best_draw, &m), min);
            assert_eq!(draw_payout(&atoms, r.worst_draw, &m), max);
        }
    }
    #[test]
    fn new_rules_and_outgoing_positions_match_exhaustive_settlement() {
        let m = Mapping::default();
        let universe = vec![1, 2, 6, 10, 13, 24, 25, 37, 45, 48, 49];
        for scenario in 0..9 {
            let mut atoms = Vec::new();
            for (i, scope) in [Scope::Regular, Scope::Special, Scope::All]
                .into_iter()
                .enumerate()
            {
                for kind in [Kind::Parity, Kind::Size] {
                    let mut a = atom(
                        kind,
                        scope,
                        [Condition::All, Condition::None, Condition::Any][scenario % 3],
                        1,
                        193 + i as i64 * 37,
                    );
                    a.void_on_49 = true;
                    a.rebate = 3;
                    a.position = if (scenario + i) % 2 == 0 { -1 } else { 1 };
                    atoms.push(a);
                }
            }
            for condition in [Condition::HardPair, Condition::SoftPair] {
                let mut a = atom(
                    Kind::Number,
                    Scope::All,
                    condition,
                    (1 << 5) | (1 << 44),
                    234,
                );
                a.options = vec![6, 45];
                a.position = if scenario % 2 == 0 { -1 } else { 1 };
                atoms.push(a);
            }
            let mut a = atom(
                Kind::Number,
                Scope::Regular,
                Condition::AtLeast,
                (1 << 0) | (1 << 12) | (1 << 48),
                657,
            );
            a.minimum_hits = 2;
            atoms.push(a);
            for count in 2..=7 {
                let mut a = atom(
                    Kind::ZodiacCount,
                    Scope::All,
                    Condition::All,
                    1 << count,
                    173 + count * 31,
                );
                a.position = if (scenario + count as usize).is_multiple_of(2) {
                    -1
                } else {
                    1
                };
                atoms.push(a);
            }
            let mut pair = atom(
                Kind::Number,
                Scope::All,
                Condition::All,
                (1 << 5) | (1 << 44),
                550,
            );
            pair.options = vec![6, 45];
            pair.special_hit_payout = Some(if scenario % 2 == 0 { 250 } else { 750 });
            pair.special_hit_odds = Some("2.5".into());
            pair.position = if scenario % 3 == 0 { -1 } else { 1 };
            atoms.push(pair);
            let mut tail = defaults()[0].clone();
            tail.kind = Kind::Tail;
            tail.scope = Scope::All;
            tail.odds = "1.8".into();
            tail.zero_tail_odds = Some("2.1234".into());
            tail.special_odds = Some("1.7".into());
            let input: BetInput = serde_json::from_value(serde_json::json!({"period":"2026287","play_id":1,"play_version":1,"selections":[0,1],"compound":false,"amount":"1","request_id":"risk-fixture","bettor":"risk"})).unwrap();
            for mut atom in plan(&tail, &input, &m).unwrap().atoms {
                atom.position = if scenario.is_multiple_of(2) { -1 } else { 1 };
                atoms.push(atom);
            }
            let result = solve_universe(
                &atoms,
                &m,
                Duration::from_secs(5),
                &AtomicBool::new(false),
                &universe,
            )
            .unwrap();
            let (mut min, mut max) = (i64::MAX, i64::MIN);
            for &special in &universe {
                let rest = universe
                    .iter()
                    .copied()
                    .filter(|n| *n != special)
                    .collect::<Vec<_>>();
                for regular in combinations(&rest, 6) {
                    let mut draw = [0; 7];
                    draw[..6].copy_from_slice(&regular);
                    draw[6] = special;
                    let net = settle(&atoms, &Draw::predicted(draw, &m))
                        .iter()
                        .zip(&atoms)
                        .map(|(r, a)| r.net * i64::from(a.position))
                        .sum::<i64>();
                    min = min.min(net);
                    max = max.max(net);
                }
            }
            assert_eq!(
                (result.min_net, result.max_net),
                (min, max),
                "scenario {scenario}"
            );
            for (draw, expected) in [(result.best_draw, max), (result.worst_draw, min)] {
                assert_eq!(
                    settle(&atoms, &Draw::predicted(draw, &m))
                        .iter()
                        .zip(&atoms)
                        .map(|(r, a)| r.net * i64::from(a.position))
                        .sum::<i64>(),
                    expected
                );
            }
        }
    }
    #[test]
    fn timeouts_and_cancellation_never_return_an_estimate() {
        let m = Mapping::default();
        assert_eq!(
            solve(&[], &m, Duration::ZERO, &AtomicBool::new(false)).unwrap_err(),
            RiskError::Timeout
        );
        assert_eq!(
            solve(&[], &m, Duration::from_secs(1), &AtomicBool::new(true)).unwrap_err(),
            RiskError::Cancelled
        );
    }
    #[test]
    fn full_universe_exact_zodiac_count_extrema() {
        let m = Mapping::default();
        let atoms = [(4, 1500), (5, 300), (6, 200), (7, 500)].map(|(count, payout)| {
            let mut a = atom(
                Kind::ZodiacCount,
                Scope::All,
                Condition::All,
                1 << count,
                payout,
            );
            a.rebate = 10;
            a
        });
        let result = solve(&atoms, &m, Duration::from_secs(5), &AtomicBool::new(false)).unwrap();
        assert_eq!((result.min_net, result.max_net), (-1140, 360));
        assert_eq!(
            Draw::predicted(result.worst_draw, &m)
                .zodiac
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            4
        );
    }
    #[test]
    fn five_zodiac_extrema() {
        let mut rule = defaults()[2].clone();
        rule.compound_enabled = true;
        let p = plan(
            &rule,
            &BetInput {
                period: "2026287".into(),
                play_id: 1,
                play_version: 1,
                selections: vec![0, 1, 2, 3, 4, 5, 6],
                compound: true,
                amount: "100".into(),
                package_zodiacs: vec![],
                request_id: "test".into(),
                bettor: "测试投注人".into(),
            },
            &Mapping::default(),
        )
        .unwrap();
        let m = Mapping::default();
        let r = solve(
            &p.atoms,
            &m,
            Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(r.min_payout, 0);
        assert_eq!(r.max_payout, 1800000);
    }
}
