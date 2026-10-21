//! Deterministic, reproducible 10,000-unit exact-risk workloads.
use marksix::{domain::*, risk};
include!("../test_support/rules.rs");
use std::{sync::atomic::AtomicBool, time::Duration};
fn main() {
    let seconds = std::env::var("BENCH_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let only = std::env::var("BENCH_CASE").unwrap_or_default();
    let mapping = Mapping::default();
    let input = BetInput {
        period: "2026287".into(),
        play_id: 1,
        play_version: 1,
        selections: vec![0, 1, 2, 3, 4, 5, 6],
        compound: true,
        amount: "100".into(),
        package_zodiacs: vec![],
        request_id: String::new(),
        bettor: "基准测试".into(),
    };
    let mut rule = defaults()[2].clone();
    rule.compound_enabled = true;
    let compound = plan(&rule, &input, &mapping).unwrap();
    let mut new_rules = Vec::new();
    for condition in [Condition::HardPair, Condition::SoftPair, Condition::AtLeast] {
        let mut rule = defaults()[0].clone();
        rule.scope = Scope::All;
        rule.condition = condition;
        rule.quantity = if condition == Condition::AtLeast {
            3
        } else {
            2
        };
        rule.combination_size = rule.quantity;
        rule.minimum_hits = 2;
        let mut bet = input.clone();
        bet.compound = false;
        bet.selections = if condition == Condition::AtLeast {
            vec![6, 45, 49]
        } else {
            vec![6, 45]
        };
        new_rules.extend(plan(&rule, &bet, &mapping).unwrap().atoms);
    }
    for scope in [Scope::Regular, Scope::Special, Scope::All] {
        let mut rule = defaults()[0].clone();
        rule.kind = Kind::Size;
        rule.scope = scope;
        rule.odds = "1.95".into();
        let mut bet = input.clone();
        bet.compound = false;
        bet.selections = vec![0, 1];
        new_rules.extend(plan(&rule, &bet, &mapping).unwrap().atoms);
    }
    let mut count_and_pairs = Vec::new();
    for (count, odds) in [(4, "15"), (5, "3"), (6, "2"), (7, "5")] {
        let mut rule = defaults()[0].clone();
        rule.kind = Kind::ZodiacCount;
        rule.scope = Scope::All;
        rule.zodiac_count = Some(count);
        rule.odds = odds.into();
        rule.rebate_percent = "10".into();
        let mut bet = input.clone();
        bet.compound = false;
        bet.selections = vec![count];
        count_and_pairs.extend(plan(&rule, &bet, &mapping).unwrap().atoms);
    }
    let mut rule = defaults()[0].clone();
    rule.scope = Scope::All;
    rule.quantity = 2;
    rule.combination_size = 2;
    rule.odds = "55".into();
    rule.special_hit_odds = Some("25".into());
    let mut bet = input.clone();
    bet.compound = false;
    bet.selections = vec![6, 45];
    count_and_pairs.extend(plan(&rule, &bet, &mapping).unwrap().atoms);
    for name in [
        "special_numbers",
        "zodiac_compound",
        "mixed",
        "new_rules_with_layoffs",
        "zodiac_counts_and_pair_rates",
    ] {
        if !only.is_empty() && name != only {
            continue;
        }
        let atoms: Vec<Atom> = (0..10000)
            .map(|i| {
                if name == "new_rules_with_layoffs" || name == "zodiac_counts_and_pair_rates" {
                    let source = if name == "new_rules_with_layoffs" {
                        &new_rules
                    } else {
                        &count_and_pairs
                    };
                    let mut atom = source[i % source.len()].clone();
                    // Separate received and outgoing positions, with signed settlement.
                    if i >= 5000 {
                        atom.position = -1;
                        atom.stake /= 2;
                        atom.payout /= 2;
                        atom.special_hit_payout = atom.special_hit_payout.map(|p| p / 2);
                        atom.rebate /= 2;
                    }
                    return atom;
                }
                if name == "zodiac_compound" || (name == "mixed" && i % 5 == 2) {
                    return compound.atoms[i % compound.atoms.len()].clone();
                }
                let (kind, scope, condition, index, pay) = if name == "mixed" {
                    match i % 5 {
                        0 => (Kind::Number, Scope::Special, Condition::All, i % 49, 430000),
                        1 => (Kind::Zodiac, Scope::All, Condition::Any, i % 12, 20000),
                        3 => (Kind::Tail, Scope::All, Condition::Any, i % 10, 30000),
                        _ => (Kind::Parity, Scope::Regular, Condition::Any, i % 2, 18000),
                    }
                } else {
                    (Kind::Number, Scope::Special, Condition::All, i % 49, 430000)
                };
                Atom {
                    options: vec![index as u8],
                    mask: 1 << index,
                    kind,
                    scope,
                    condition,
                    minimum_hits: 1,
                    stake: 10000,
                    payout: pay,
                    rebate: 200,
                    odds: "43".into(),
                    rebate_percent: "2".into(),
                    void_on_49: false,
                    position: 1,
                    special_hit_odds: None,
                    special_hit_payout: None,
                }
            })
            .collect();
        match risk::solve(
            &atoms,
            &mapping,
            Duration::from_secs(seconds),
            &AtomicBool::new(false),
        ) {
            Ok(result) => {
                for (numbers, expected) in [
                    (result.best_draw, result.max_net),
                    (result.worst_draw, result.min_net),
                ] {
                    let draw = Draw::predicted(numbers, &mapping);
                    assert_eq!(
                        settle(&atoms, &draw)
                            .iter()
                            .zip(&atoms)
                            .map(|(r, a)| r.net * i64::from(a.position))
                            .sum::<i64>(),
                        expected
                    );
                    let mut ns = numbers;
                    ns.sort();
                    assert!(ns.windows(2).all(|w| w[0] != w[1]));
                }
                println!(
                    "{}",
                    serde_json::json!({"case":name,"units":atoms.len(),"status":"exact","result":result})
                );
            }
            Err(e) => {
                println!(
                    "{}",
                    serde_json::json!({"case":name,"units":atoms.len(),"status":"failed","error":e.to_string()})
                );
                std::process::exit(1);
            }
        }
    }
}
