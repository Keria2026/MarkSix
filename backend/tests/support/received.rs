use super::*;
#[test]
fn received_buckets_follow_snapshot_semantics_and_each_atom_occurrence() {
    let mapping = Mapping::default();
    let defaults = crate::configuration::bundled().unwrap();
    let mut result = ReceivedDistribution::empty();
    for (name, selected, amount) in [
        ("特码", vec![1, 1, 49], "100"),
        ("特码45倍", vec![1], "12.5"),
        ("一肖中", vec![0, 11, 0], "20"),
        ("尾中", vec![0, 9, 0], "30"),
        ("平码", vec![1], "200"),
        ("一肖不中", vec![0], "300"),
        ("二中二", vec![1, 2], "400"),
    ] {
        let rule = &defaults
            .plays
            .iter()
            .find(|p| p.rule.name == name)
            .unwrap()
            .rule;
        let input = BetInput {
            market: Default::default(),
            period: "synthetic".into(),
            play_id: 1,
            play_version: 1,
            selections: selected,
            compound: false,
            amount: amount.into(),
            package_zodiacs: vec![],
            drag: None,
            request_id: uuid::Uuid::nil().to_string(),
            bettor: "synthetic".into(),
        };
        for a in plan(rule, &input, &mapping).unwrap().atoms {
            result.add(&a).unwrap();
        }
    }
    assert_eq!(result.special.len(), 49);
    assert_eq!(result.zodiac.len(), 12);
    assert_eq!(result.tail.len(), 10);
    assert_eq!(result.special[0], 21250);
    assert_eq!(result.special[48], 10000);
    assert_eq!(result.special.iter().sum::<i64>(), 31250);
    assert_eq!(result.zodiac[0], 4000);
    assert_eq!(result.zodiac[11], 2000);
    assert_eq!(result.tail[0], 6000);
    assert_eq!(result.tail[9], 3000);
}
#[test]
fn package_amounts_are_allocated_per_number_without_multiplying_the_package_total() {
    let r = crate::configuration::bundled()
        .unwrap()
        .plays
        .into_iter()
        .find(|p| p.rule.name == "特码")
        .unwrap()
        .rule;
    let i = BetInput {
        market: Default::default(),
        period: "synthetic".into(),
        play_id: 1,
        play_version: 1,
        selections: vec![],
        compound: false,
        amount: "100.1".into(),
        package_zodiacs: vec![1, 1],
        drag: None,
        request_id: uuid::Uuid::nil().to_string(),
        bettor: "synthetic".into(),
    };
    let mut result = ReceivedDistribution::empty();
    for a in plan(&r, &i, &Mapping::default()).unwrap().atoms {
        result.add(&a).unwrap();
    }
    assert_eq!(result.special.iter().sum::<i64>(), 20020);
    assert_eq!(result.special[5], 5006);
    assert_eq!(result.special[17], 5006);
    assert_eq!(result.special[29], 5004);
    assert_eq!(result.special[41], 5004);
}
