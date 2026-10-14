//! Deterministic, reproducible 10,000-unit exact-risk workloads.
use marksix::{domain::*, risk};
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
        request_id: String::new(),
    };
    let compound = plan(&defaults()[2], &input, &mapping).unwrap();
    for name in ["special_numbers", "zodiac_compound", "mixed"] {
        if !only.is_empty() && name != only {
            continue;
        }
        let atoms: Vec<Atom> = (0..10000)
            .map(|i| {
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
                    stake: 10000,
                    payout: pay,
                    rebate: 200,
                    odds: "43".into(),
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
                    (result.best_draw, result.min_payout),
                    (result.worst_draw, result.max_payout),
                ] {
                    let draw = Draw::predicted(numbers, &mapping);
                    assert_eq!(
                        settle(&atoms, &draw).iter().map(|r| r.payout).sum::<i64>(),
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
