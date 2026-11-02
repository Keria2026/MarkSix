//! Differential checks: synthetic human text -> actual TypeScript payload -> Rust.
//! Expected atoms come from the independent test model, never the Rust planner.
use marksix::{configuration::bundled, domain::*};
use serde_json::Value;

#[test]
fn frontend_payloads_match_independent_cent_and_combination_vectors() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/text-entry-vectors.json")).unwrap();
    assert_eq!(fixture["schema"], 1);
    let vectors = fixture["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 192);
    let defaults = bundled().unwrap();
    let mut families = std::collections::BTreeSet::new();
    let mut rules = std::collections::BTreeSet::new();
    for vector in vectors {
        families.insert(vector["family"].as_str().unwrap());
        for item in vector["items"].as_array().unwrap() {
            let mut input = item["input"].clone();
            input["period"] = "synthetic".into();
            input["bettor"] = "synthetic".into();
            input["request_id"] = uuid::Uuid::nil().to_string().into();
            let input: BetInput = serde_json::from_value(input).unwrap();
            let rule = &defaults.plays[input.play_id as usize - 1].rule;
            rules.insert(&rule.name);
            let market = if input.market.is_macau() {
                "macau"
            } else {
                "hk"
            };
            let mapping: Mapping =
                serde_json::from_value(vector["mappings"][market].clone()).unwrap();
            let actual = plan(rule, &input, &mapping).unwrap();
            let mut actual_atoms: Vec<_> = actual
                .atoms
                .iter()
                .map(|atom| {
                    format!(
                        "{:?}/{}/{}/{}/{}",
                        atom.options,
                        atom.stake,
                        atom.rebate,
                        atom.payout,
                        atom.max_payout()
                    )
                })
                .collect();
            let mut expected_atoms: Vec<_> = item["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|atom| {
                    let options: Vec<u8> = serde_json::from_value(atom["options"].clone()).unwrap();
                    format!(
                        "{:?}/{}/{}/{}/{}",
                        options,
                        atom["stake"].as_str().unwrap(),
                        atom["rebate"].as_str().unwrap(),
                        atom["payout"].as_str().unwrap(),
                        atom["exposure"].as_str().unwrap()
                    )
                })
                .collect();
            actual_atoms.sort();
            expected_atoms.sort();
            assert_eq!(
                actual_atoms, expected_atoms,
                "{} {} {}",
                vector["id"], rule.name, vector["raw"]
            );
        }
    }
    assert!(families.len() >= 14);
    assert!(rules.len() >= 25);
}
