use super::*;
#[test]
fn reduced_universe_matches_exhaustive_cashflow() {
    let mapping = Mapping::default();
    let mut atoms = vec![];
    for (name, selections) in [
        ("三中二", vec![1, 2, 3]),
        ("二中二含特", vec![2, 7]),
        ("二尾连", vec![0, 1]),
        ("波色", vec![2]),
        ("特碰", vec![7, 1]),
        ("四肖量", vec![4]),
    ] {
        let rule = crate::configuration::bundled()
            .unwrap()
            .plays
            .into_iter()
            .find(|p| p.rule.name == name)
            .unwrap()
            .rule;
        let input = BetInput {
            period: String::new(),
            play_id: 1,
            play_version: 1,
            selections,
            compound: false,
            amount: "10".into(),
            package_zodiacs: vec![],
            drag: None,
            request_id: String::new(),
            bettor: String::new(),
        };
        atoms.extend(plan(&rule, &input, &mapping).unwrap().atoms);
    }
    let mut outgoing = atoms[0].clone();
    outgoing.position = -1;
    atoms.push(outgoing);
    let universe = vec![1, 2, 3, 4, 7, 10, 25, 49, 48];
    let r = solve_universe(
        &atoms,
        &mapping,
        Duration::from_secs(10),
        &AtomicBool::new(false),
        &universe,
    )
    .unwrap();
    let mut values = vec![];
    for &special in &universe {
        let regular = universe
            .iter()
            .copied()
            .filter(|n| *n != special)
            .collect::<Vec<_>>();
        for mut group in combinations(&regular, 6) {
            group.push(special);
            let d = Draw::predicted(group.try_into().unwrap(), &mapping);
            let pay: i64 = settle(&atoms, &d)
                .iter()
                .zip(&atoms)
                .map(|(s, a)| (s.payout + s.rebate - a.rebate) * i64::from(a.position))
                .sum();
            values.push(pay);
        }
    }
    assert_eq!(r.min_payout, *values.iter().min().unwrap());
    assert_eq!(r.max_payout, *values.iter().max().unwrap());
}
