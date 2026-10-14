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
    mask: u64,
    pay: i64,
    event_numbers: u64,
}
struct Search<'a> {
    terms: Vec<Term>,
    mapping: &'a Mapping,
    cancel: &'a AtomicBool,
    deadline: Instant,
    start: Instant,
    result: RiskResult,
    groups: Vec<Vec<u8>>,
    suffix: Vec<[u64; 5]>,
    suffix_count: Vec<usize>,
    feature_numbers: [[u64; 49]; 5],
    special: u8,
    special_masks: [u64; 5],
    fixed: i64,
}
fn merge(a: [u64; 5], b: [u64; 5]) -> [u64; 5] {
    std::array::from_fn(|i| a[i] | b[i])
}
fn draw_payout(atoms: &[Atom], numbers: [u8; 7], mapping: &Mapping) -> i64 {
    let draw = Draw::predicted(numbers, mapping);
    atoms
        .iter()
        .filter(|a| wins(a, &draw))
        .map(|a| a.payout)
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
        || checked_sum(atoms.iter().map(|a| a.payout)).is_err()
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
        max_payout: -1,
        best_draw: [0; 7],
        worst_draw: [0; 7],
        nodes: 0,
        elapsed_ms: 0,
        strategy: "branch_and_bound".into(),
    };
    // Linear number bets and arbitrary special-only bets have a direct exact solution.
    if atoms
        .iter()
        .all(|a| a.scope == Scope::Special || (a.kind == Kind::Number && a.mask.count_ones() == 1))
    {
        let mut regular = [0_i64; 50];
        let mut all = [0_i64; 50];
        let mut constant = 0;
        for a in atoms.iter().filter(|a| a.scope != Scope::Special) {
            let n = a.mask.trailing_zeros() as usize + 1;
            let coeff = if a.condition == Condition::None {
                constant += a.payout;
                -a.payout
            } else {
                a.payout
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
            let mask = mapping.features(s);
            let special: i64 = atoms
                .iter()
                .filter(|a| {
                    a.scope == Scope::Special
                        && condition_matches(a.condition, a.mask, mask[a.kind.index()])
                })
                .map(|a| a.payout)
                .sum();
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
        return Ok(result);
    }
    // Seed valid witnesses only to tighten bounds. Proof still requires the full search.
    for shift in 0..universe.len() {
        let numbers = std::array::from_fn(|i| universe[(i + shift) % universe.len()]);
        update(&mut result, draw_payout(atoms, numbers, mapping), numbers);
    }
    let mut aggregated = HashMap::<(Kind, Scope, Condition, u64), i64>::new();
    for a in atoms.iter().filter(|a| a.scope != Scope::Special) {
        *aggregated
            .entry((a.kind, a.scope, a.condition, a.mask))
            .or_default() += a.payout;
    }
    let mut feature_numbers = [[0; 49]; 5];
    for &n in universe {
        let f = mapping.features(n);
        for k in 0..5 {
            feature_numbers[k][f[k].trailing_zeros() as usize] |= 1 << (n - 1);
        }
    }
    let mut terms: Vec<Term> = aggregated
        .into_iter()
        .map(|((kind, scope, condition, mask), pay)| {
            let event_numbers = universe
                .iter()
                .filter(|n| mapping.features(**n)[kind.index()] & mask != 0)
                .fold(0, |m, n| m | 1 << (*n - 1));
            Term {
                kind,
                scope,
                condition,
                mask,
                pay,
                event_numbers,
            }
        })
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
        special_masks: [0; 5],
        fixed: 0,
    };
    let mut special_classes = std::collections::HashSet::new();
    for &special in universe {
        search.check()?;
        let masks = mapping.features(special);
        let fixed: i64 = atoms
            .iter()
            .filter(|a| {
                a.scope == Scope::Special
                    && condition_matches(a.condition, a.mask, masks[a.kind.index()])
            })
            .map(|a| a.payout)
            .sum();
        let group_id = classes
            .iter()
            .position(|(_, ns)| ns.contains(&special))
            .unwrap();
        if !special_classes.insert((group_id, fixed)) {
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
        search.suffix = vec![[0; 5]; count + 1];
        search.suffix_count = vec![0; count + 1];
        for i in (0..count).rev() {
            search.suffix[i] = search.suffix[i + 1];
            for &n in &search.groups[i] {
                search.suffix[i] = merge(search.suffix[i], mapping.features(n));
            }
            search.suffix_count[i] = search.suffix_count[i + 1] + search.groups[i].len();
        }
        search.visit(0, 6, [0; 5], &mut Vec::with_capacity(6))?;
    }
    search.check()?;
    search.result.elapsed_ms = search.start.elapsed().as_millis() as u64;
    Ok(search.result)
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
    fn bounds(&self, masks: [u64; 5], future: [u64; 5], remaining: usize) -> (i64, i64) {
        let (mut low, mut high) = (self.fixed, self.fixed);
        for t in &self.terms {
            let selected = if t.scope == Scope::All {
                masks[t.kind.index()] | self.special_masks[t.kind.index()]
            } else {
                masks[t.kind.index()]
            };
            let hit = selected & t.mask;
            let possible = future[t.kind.index()] & t.mask;
            let forced_hit = (future[0] & !t.event_numbers).count_ones() < remaining as u32;
            let (certain, possible_win) = match t.condition {
                Condition::Any => (hit != 0 || forced_hit, hit != 0 || possible != 0),
                Condition::None => (hit == 0 && possible == 0, hit == 0 && !forced_hit),
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
            if certain {
                low += t.pay;
            }
            if possible_win {
                high += t.pay;
            }
        }
        (low, high)
    }
    fn visit(
        &mut self,
        index: usize,
        remaining: usize,
        masks: [u64; 5],
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
                [0; 5]
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
            stake: 100,
            payout,
            rebate: 0,
            odds: "1".into(),
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
    fn five_zodiac_extrema() {
        let p = plan(
            &defaults()[2],
            &BetInput {
                period: "2026287".into(),
                play_id: 1,
                play_version: 1,
                selections: vec![0, 1, 2, 3, 4, 5, 6],
                compound: true,
                amount: "100".into(),
                request_id: "test".into(),
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
