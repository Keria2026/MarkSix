use marksix::{configuration::bundled, domain::*, risk};
use std::{collections::HashSet, sync::atomic::AtomicBool, time::Duration};

fn rule(name: &str) -> Rule {
    bundled()
        .unwrap()
        .plays
        .into_iter()
        .find(|p| p.rule.name == name)
        .unwrap()
        .rule
}
fn input(selections: &[u8]) -> BetInput {
    BetInput {
        market: Default::default(),
        period: "2040001".into(),
        play_id: 1,
        play_version: 1,
        selections: selections.to_vec(),
        compound: false,
        amount: "100".into(),
        package_zodiacs: vec![],
        drag: None,
        request_id: uuid::Uuid::new_v4().to_string(),
        bettor: "sample".into(),
    }
}
fn planned(name: &str, selections: &[u8]) -> BetPlan {
    plan(&rule(name), &input(selections), &Mapping::default()).unwrap()
}
#[test]
fn decimal_boundaries_and_rounding() {
    for (text, cents) in [
        ("0.1", 10),
        ("1", 100),
        ("001.5", 150),
        ("90000000000000", MONEY_LIMIT),
    ] {
        assert_eq!(entry_amount(text).unwrap(), cents);
    }
    for text in [
        "0",
        "-1",
        "+1",
        "1.01",
        "1.",
        ".1",
        " 1",
        "1e2",
        "90000000000001",
    ] {
        assert!(entry_amount(text).is_err(), "{text}");
    }
    assert_eq!(rounded_product(10, 1500).unwrap(), 2);
    assert_eq!(checked_sum([100, -50]).unwrap(), 50);
    assert!(checked_sum([MONEY_LIMIT, 1]).is_err());
    assert!(rounded_product(MONEY_LIMIT, 20_000).is_err());
}
#[test]
fn defaults_are_valid_unique_and_produce_legal_plans() {
    let mut names = HashSet::new();
    for play in bundled().unwrap().plays {
        let r = play.rule;
        assert!(names.insert(r.name.clone()));
        r.validate().unwrap();
        let start = u8::from(matches!(r.kind, Kind::Number | Kind::ZodiacCount));
        let selections = if r.kind == Kind::ZodiacCount {
            vec![r.zodiac_count.unwrap()]
        } else {
            (start..start + r.quantity).collect()
        };
        let p = plan(&r, &input(&selections), &Mapping::default()).unwrap();
        assert!(!p.atoms.is_empty(), "{}", r.name);
        assert_eq!(p.stake, 10_000 * p.atoms.len() as i64);
    }
}
#[test]
fn single_compound_drag_and_package_have_distinct_units() {
    assert_eq!(planned("特码", &[1, 2, 3]).stake, 30_000);
    let r = rule("三有");
    let mut i = input(&[1, 6, 10, 11]);
    i.compound = true;
    let p = plan(&r, &i, &Mapping::default()).unwrap();
    assert_eq!(p.atoms.len(), 4);
    assert_eq!(p.stake, 40_000);
    let mut i = input(&[]);
    i.compound = true;
    i.drag = Some(DragInput {
        left: vec![1],
        right: vec![2, 3, 4],
        zodiac: false,
    });
    let p = plan(&rule("二中二"), &i, &Mapping::default()).unwrap();
    assert_eq!(
        p.atoms
            .iter()
            .map(|a| a.options.clone())
            .collect::<Vec<_>>(),
        vec![vec![1, 2], vec![1, 3], vec![1, 4]]
    );
    i.drag.as_mut().unwrap().right.push(1);
    assert!(plan(&rule("二中二"), &i, &Mapping::default()).is_err());
    let mut i = input(&[]);
    i.package_zodiacs = vec![1, 6];
    let p = plan(&rule("特码"), &i, &Mapping::default()).unwrap();
    assert_eq!(p.stake, 20_000);
    assert_eq!(p.atoms.len(), 9);
    for z in [1, 6] {
        assert_eq!(
            p.atoms
                .iter()
                .filter(|a| Mapping::default().zodiac[a.options[0] as usize - 1] == z)
                .map(|a| a.stake)
                .sum::<i64>(),
            10_000
        );
    }
}
#[test]
fn selections_and_rule_constraints_fail_closed() {
    for selection in [vec![], vec![0], vec![50], vec![1, 1]] {
        assert!(plan(&rule("特码"), &input(&selection), &Mapping::default()).is_err());
    }
    let mut r = rule("三有");
    r.selection_limit = Some(2);
    assert!(r.validate().is_err());
    let mut r = rule("波色");
    r.scope = Scope::All;
    assert!(r.validate().is_err());
    let mut i = input(&(1..=49).collect::<Vec<_>>());
    i.compound = true;
    assert!(plan(&rule("三中三"), &i, &Mapping::default()).is_err());
    let mut i = input(&[1]);
    i.amount = "0.01".into();
    assert!(plan(&rule("特码"), &i, &Mapping::default()).is_err());
}
#[test]
fn settlement_uses_scope_rates_and_positional_pairs() {
    let m = Mapping::default();
    let d = Draw::predicted([1, 2, 3, 4, 5, 6, 7], &m);
    let result = settle(&planned("特码", &[1, 7]).atoms, &d);
    assert_eq!(
        (result[1].payout, result[1].rebate, result[1].net),
        (440_000, 1_000, -431_000)
    );
    assert_eq!((result[0].payout, result[0].net), (0, 9_000));
    assert!(settle(&planned("平码", &[1]).atoms, &d)[0].won);
    assert!(!settle(&planned("平码", &[7]).atoms, &d)[0].won);
    for (name, opts, won) in [
        ("特碰", vec![7, 1], true),
        ("特碰", vec![1, 7], false),
        ("软碰", vec![1, 7], true),
        ("三中二", vec![1, 2, 49], true),
        ("五不中", vec![8, 9, 10, 11, 12], true),
    ] {
        assert_eq!(
            settle(&planned(name, &opts).atoms, &d)[0].won,
            won,
            "{name}"
        );
    }
    for (opts, payout) in [(vec![1, 2], 550_000), (vec![1, 7], 250_000)] {
        assert_eq!(
            settle(&planned("二中二含特", &opts).atoms, &d)[0].payout,
            payout
        );
    }
}
#[test]
fn special_rates_zero_tail_and_49_refund() {
    let a = planned("一肖中", &[6]).atoms.remove(0);
    assert_eq!((a.payout, a.rebate), (18_000, 500));
    let a = planned("尾中", &[0]).atoms.remove(0);
    assert_eq!(a.payout, 20_000);
    let mut r = rule("特码");
    r.kind = Kind::Size;
    r.odds = "2".into();
    r.rebate_percent = "5".into();
    let atoms = plan(&r, &input(&[1]), &Mapping::default()).unwrap().atoms;
    let d = Draw::predicted([1, 2, 3, 4, 5, 6, 49], &Mapping::default());
    let s = settle(&atoms, &d).remove(0);
    assert!(s.voided && !s.won);
    assert_eq!((s.payout, s.rebate, s.net), (10_000, 0, 0));
}
#[test]
fn business_day_and_draw_input_boundaries() {
    let date = chrono::NaiveDate::from_ymd_opt(2040, 1, 1).unwrap();
    assert_eq!(
        business_date(date.and_hms_opt(5, 59, 59).unwrap()),
        date.pred_opt().unwrap()
    );
    assert_eq!(business_date(date.and_hms_opt(6, 0, 0).unwrap()), date);
    let v = serde_json::json!({"expect":"2040001","openTime":"2040-01-01 21:34:00","openCode":"1,2,3,4,5,6,7","zodiac":"鼠,牛,虎,兔,龍,蛇,馬","wave":"red,red,blue,blue,green,green,red"});
    assert!(parse_draw(&v).is_ok());
    for (field, value) in [
        ("expect", "2040002"),
        ("openCode", "1,1,3,4,5,6,7"),
        ("openCode", "0,2,3,4,5,6,7"),
        ("wave", "red"),
    ] {
        let mut bad = v.clone();
        bad[field] = value.into();
        assert!(parse_draw(&bad).is_err());
    }
}
#[test]
fn risk_extrema_are_attained_and_cancellation_is_explicit() {
    let atoms = planned("特码", &[7]).atoms;
    let m = Mapping::default();
    let cancel = AtomicBool::new(false);
    let r = risk::solve(&atoms, &m, Duration::from_secs(5), &cancel).unwrap();
    assert_eq!(
        (r.min_payout, r.max_payout, r.min_net, r.max_net),
        (0, 440_000, -431_000, 9_000)
    );
    for (draw, pay) in [(r.best_draw, r.min_payout), (r.worst_draw, r.max_payout)] {
        assert_eq!(draw.into_iter().collect::<HashSet<_>>().len(), 7);
        assert_eq!(settle(&atoms, &Draw::predicted(draw, &m))[0].payout, pay);
    }
    assert_eq!(
        risk::solve(&atoms, &m, Duration::ZERO, &cancel).unwrap_err(),
        risk::RiskError::Timeout
    );
    assert_eq!(
        risk::solve(&atoms, &m, Duration::from_secs(5), &AtomicBool::new(true)).unwrap_err(),
        risk::RiskError::Cancelled
    );
}

#[test]
fn every_default_settles_against_an_independent_predicate_oracle() {
    let mapping = Mapping::default();
    for p in bundled().unwrap().plays {
        let r = p.rule;
        let start = u8::from(matches!(r.kind, Kind::Number | Kind::ZodiacCount));
        let opts = if r.kind == Kind::ZodiacCount {
            vec![r.zodiac_count.unwrap()]
        } else {
            (start..start + r.quantity).collect::<Vec<_>>()
        };
        let atoms = plan(&r, &input(&opts), &mapping).unwrap().atoms;
        for offset in 0..49 {
            let numbers = std::array::from_fn(|i| ((offset + i * 5) % 49 + 1) as u8);
            let draw = Draw::predicted(numbers, &mapping);
            let settled = settle(&atoms, &draw);
            for (a, s) in atoms.iter().zip(&settled) {
                let selected = &a.options;
                let indexes = match r.scope {
                    Scope::Regular => 0..6,
                    Scope::Special => 6..7,
                    Scope::All => 0..7,
                };
                let observed = indexes
                    .map(|i| match r.kind {
                        Kind::Number => numbers[i],
                        Kind::Zodiac => mapping.zodiac[numbers[i] as usize - 1],
                        Kind::Tail => numbers[i] % 10,
                        Kind::Wave => wave(numbers[i]),
                        Kind::Size => u8::from(numbers[i] >= 25),
                        Kind::Parity => numbers[i] % 2,
                        Kind::ZodiacCount => 0,
                    })
                    .collect::<HashSet<_>>();
                let hits = selected.iter().filter(|o| observed.contains(o)).count();
                let won = if r.kind == Kind::ZodiacCount {
                    draw.zodiac.iter().collect::<HashSet<_>>().len()
                        == r.zodiac_count.unwrap() as usize
                } else {
                    match r.condition {
                        Condition::All => hits == selected.len(),
                        Condition::None => hits == 0,
                        Condition::Any => hits > 0,
                        Condition::AtLeast => hits >= r.minimum_hits as usize,
                        Condition::HardPair => {
                            numbers[6] == selected[0] && numbers[..6].contains(&selected[1])
                        }
                        Condition::SoftPair => {
                            (numbers[6] == selected[0] && numbers[..6].contains(&selected[1]))
                                || (numbers[6] == selected[1]
                                    && numbers[..6].contains(&selected[0]))
                        }
                    }
                };
                assert_eq!(s.won, won, "{} at {offset}", r.name);
                let payout = if !won {
                    0
                } else if selected.contains(&numbers[6]) {
                    a.special_hit_payout.unwrap_or(a.payout)
                } else {
                    a.payout
                };
                assert_eq!(
                    (s.payout, s.net),
                    (payout, a.stake - payout - a.rebate),
                    "{} at {offset}",
                    r.name
                );
            }
        }
    }
}

#[test]
fn fixed_precision_rejects_overflow_and_negative_rounding_inputs() {
    for digits in [19, 20, 100, u32::MAX] {
        assert!(scaled("1", digits).is_err());
    }
    assert_eq!(scaled("12", 0).unwrap(), 12);
    assert_eq!(scaled("0.000000000000000001", 18).unwrap(), 1);
    assert!(scaled("9223372036854775808", 0).is_err());
    assert!(scaled("9223372036854775807", 1).is_err());
    for (cents, rate) in [(-1, 1), (1, -1), (-1, -1), (i64::MIN, 0)] {
        assert!(rounded_product(cents, rate).is_err());
    }
    assert_eq!(rounded_product(0, 10000).unwrap(), 0);
    assert_eq!(rounded_product(1, 4999).unwrap(), 0);
    assert_eq!(rounded_product(1, 5000).unwrap(), 1);
}

#[test]
fn rule_validation_rejects_incoherent_combinations_and_financial_bounds() {
    use serde_json::json;
    for (name, patch, message) in [
        ("特码", json!({"name":"\n"}), "名称"),
        ("特码", json!({"name":"x".repeat(41)}), "名称"),
        ("特码", json!({"zodiac_count":4}), "目标种数"),
        ("特码", json!({"special_hit_odds":"1"}), "含特码赔率"),
        ("特码", json!({"quantity":0}), "数量关系"),
        ("特码", json!({"combination_size":0}), "拆分数量"),
        ("特码", json!({"selection_limit":0}), "可选数量"),
        ("特码", json!({"odds":"0"}), "赔率"),
        ("特码", json!({"odds":"10000001"}), "赔率"),
        ("特码", json!({"rebate_percent":"100.01"}), "反水"),
        (
            "特码",
            json!({"special_rebate_percent":"100.01"}),
            "特殊反水",
        ),
        ("特码", json!({"special_odds":"0"}), "特殊赔率"),
        ("特码", json!({"zero_tail_odds":"2"}), "尾特殊赔率"),
        ("波色", json!({"special_odds":"2"}), "本命肖"),
        ("波色", json!({"special_rebate_percent":"1"}), "特殊反水"),
        ("三中二", json!({"minimum_hits":0}), "最少命中数"),
        ("特碰", json!({"compound_enabled":true}), "特碰"),
        ("六肖量", json!({"zodiac_count":8}), "生肖种数"),
    ] {
        let mut value = serde_json::to_value(rule(name)).unwrap();
        for (key, item) in patch.as_object().unwrap() {
            value[key] = item.clone();
        }
        let invalid: Rule = serde_json::from_value(value).unwrap();
        assert!(
            invalid.validate().unwrap_err().contains(message),
            "{name}: {message}"
        );
    }
}

#[test]
fn invalid_draw_fields_and_mapping_are_rejected_before_settlement() {
    use serde_json::json;
    let raw = json!({"expect":"2040001","openTime":"2040-01-01 21:34:00","openCode":"1,2,3,4,5,6,7","zodiac":"鼠,牛,虎,兔,龍,蛇,馬","wave":"red,red,blue,blue,green,green,red"});
    assert!(parse_draw(&raw).is_ok());
    for (field, value) in [
        ("expect", json!(2040001)),
        ("openTime", json!("invalid")),
        ("expect", json!("2039001")),
        ("openCode", json!("bad,2,3,4,5,6,7")),
        ("openCode", json!("0,2,3,4,5,6,7")),
        ("openCode", json!("1,1,3,4,5,6,7")),
        ("zodiac", json!("猫,牛,虎,兔,龙,蛇,马")),
        ("wave", json!("pink,red,blue,blue,green,green,red")),
        ("wave", json!("red")),
    ] {
        let mut invalid = raw.clone();
        invalid[field] = value;
        assert!(parse_draw(&invalid).is_err(), "{field}");
    }
    let mut mapping = Mapping {
        natal: 12,
        ..Default::default()
    };
    assert!(mapping.validate().is_err());
    mapping.natal = 0;
    mapping.zodiac[0] = 12;
    assert!(mapping.validate().is_err());
    assert_eq!(choose(2, 3), 0);
    assert!(combinations(&[1, 2], 0).is_empty());
    assert!(combinations(&[1, 2], 3).is_empty());
}

#[test]
fn hk_source_issue_is_not_a_day_ordinal_and_year_reset_uses_source() {
    use marksix::market::{Market, next_expect};
    let raw = serde_json::json!({"expect":"2026115","openTime":"2026-10-27 21:32:32","openCode":"47,21,04,02,24,18,31","zodiac":"猴,狗,兔,蛇,羊,牛,鼠","wave":"blue,green,blue,red,red,red,blue","verify":false});
    assert!(parse_draw(&raw).is_err());
    let draw = parse_market_draw(&raw, Market::Hk).unwrap();
    assert_eq!(draw.expect, "2026115");
    assert_eq!(draw.numbers, [47, 21, 4, 2, 24, 18, 31]);
    for (field, value) in [
        ("type", serde_json::json!("1")),
        (
            "numbers",
            serde_json::json!(["1", "2", "3", "4", "5", "6", "7"]),
        ),
    ] {
        let mut invalid = raw.clone();
        invalid[field] = value;
        assert!(parse_market_draw(&invalid, Market::Hk).is_err());
    }
    let mut matching = raw.clone();
    matching["type"] = serde_json::json!("9");
    matching["numbers"] = serde_json::json!(["47", "21", "04", "02", "24", "18", "31"]);
    assert!(parse_market_draw(&matching, Market::Hk).is_ok());

    assert_eq!(next_expect("2026115", 2026), Some("2026116".into()));
    assert_eq!(next_expect("2026115", 2027), None);
    for expect in ["2026000", "2027115", "20261150", "bad"] {
        let mut value = raw.clone();
        value["expect"] = serde_json::json!(expect);
        assert!(parse_market_draw(&value, Market::Hk).is_err());
    }
}
