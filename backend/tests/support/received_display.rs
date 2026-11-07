use super::*;
fn received() -> ReceivedDistribution {
    let mut value = ReceivedDistribution::empty();
    value.special[0] = 10000;
    value.special[1] = 8000;
    value.zodiac[0] = 5000;
    value.tail[9] = 3000;
    value
}
fn deduction(index: usize, amount: &str) -> Change {
    Change::Deduct {
        items: vec![Item {
            index,
            amount: amount.into(),
        }],
    }
}
#[test]
fn reductions_are_cumulative_snapshots_and_new_receipts_add_without_changing_the_original() {
    let raw = received();
    let first = apply(
        &raw,
        ReceivedDistribution::empty(),
        DisplayKind::Special,
        &deduction(0, "30"),
    )
    .unwrap();
    let mut later = raw.clone();
    later.special[0] += 5000;
    let second = apply(&later, first, DisplayKind::Special, &deduction(0, "20")).unwrap();
    let shown = presentation(later.clone(), second, 2).unwrap();
    assert_eq!(shown.received, later);
    assert_eq!(shown.display.special[0], 10000);
    assert_eq!(shown.deducted.special[0], 5000);
    assert_eq!(raw.special[0], 10000);
    assert_eq!(shown.display.zodiac[0], 5000);
    assert_eq!(shown.display.tail[9], 3000);
    let restored = apply(&later, shown.deducted, DisplayKind::Special, &Change::Reset).unwrap();
    assert_eq!(
        presentation(later.clone(), restored, 3).unwrap().display,
        later
    );
}
#[test]
fn every_bucket_uses_exact_cents_and_validates_the_entire_batch_before_persisting() {
    for kind in [DisplayKind::Special, DisplayKind::Zodiac, DisplayKind::Tail] {
        let mut raw = ReceivedDistribution::empty();
        kind.values_mut(&mut raw).fill(1000);
        let next = apply(
            &raw,
            ReceivedDistribution::empty(),
            kind,
            &deduction(0, "0.01"),
        )
        .unwrap();
        assert_eq!(
            kind.values(&presentation(raw, next, 1).unwrap().display)[0],
            999
        );
    }
    for change in [
        deduction(0, "100.01"),
        deduction(49, "1"),
        deduction(0, "0"),
        deduction(0, "-1"),
        deduction(0, "1.001"),
        Change::Deduct { items: vec![] },
        Change::Deduct {
            items: vec![
                Item {
                    index: 0,
                    amount: "1".into(),
                },
                Item {
                    index: 0,
                    amount: "1".into(),
                },
            ],
        },
        Change::Deduct {
            items: vec![
                Item {
                    index: 0,
                    amount: "1".into(),
                },
                Item {
                    index: 1,
                    amount: "81".into(),
                },
            ],
        },
    ] {
        assert!(
            apply(
                &received(),
                ReceivedDistribution::empty(),
                DisplayKind::Special,
                &change
            )
            .is_err()
        );
    }
}
#[test]
fn corrections_do_not_create_negative_home_amounts_or_rewrite_the_original() {
    let mut raw = received();
    let previous = apply(
        &raw,
        ReceivedDistribution::empty(),
        DisplayKind::Special,
        &deduction(0, "80"),
    )
    .unwrap();
    raw.special[0] = 1000;
    let shown = presentation(raw.clone(), previous, 1).unwrap();
    assert_eq!(shown.display.special[0], 0);
    assert_eq!(shown.received.special[0], 1000);
    assert_eq!(shown.deducted.special[0], 8000);
    assert!(presentation(raw, ReceivedDistribution::empty(), -1).is_err());
    let mut invalid = ReceivedDistribution::empty();
    invalid.tail.pop();
    assert!(validate(&invalid).is_err());
    let mut invalid = ReceivedDistribution::empty();
    invalid.special[0] = -1;
    assert!(validate(&invalid).is_err());
}
