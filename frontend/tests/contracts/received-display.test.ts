import { expect, test } from "bun:test";
import {
  readReceivedDisplay,
  displayCents,
  displayAmount,
  receivedItemName,
} from "../../src/lib/received-display";
import { receivedSummary } from "../../src/lib/received";
import { entryCents } from "../../src/lib/types";
import { receivedDisplayFixture } from "../model/received-display";
const blank = () => ({
  special: Array(49).fill(0),
  zodiac: Array(12).fill(0),
  tail: Array(10).fill(0),
});
test("a presentation offset changes displayed totals and averages while preserving the exact raw snapshot", () => {
  const snapshot = receivedDisplayFixture(blank());
  snapshot.received.special[0] = 15000;
  snapshot.display = structuredClone(snapshot.received);
  snapshot.deducted.special[0] = 5000;
  snapshot.display.special[0] = 10000;
  const state = readReceivedDisplay(snapshot);
  expect(state.received.special[0]).toBe(15000);
  expect(state.display.special[0]).toBe(10000);
  expect(receivedSummary(state.display.special).total).toBe(10000n);
  expect(receivedSummary(state.display.special).average).toBe(204n);
});
test("invalid or inconsistent snapshots are rejected rather than fabricating a zero display", () => {
  for (const value of [
    null,
    {},
    { ...receivedDisplayFixture(blank()), revision: -1 },
    { ...receivedDisplayFixture(blank()), revision: 0.1 },
    { ...receivedDisplayFixture(blank()), deducted: { ...blank(), tail: [1] } },
    {
      ...receivedDisplayFixture(blank()),
      display: { ...blank(), special: Array(49).fill(1) },
    },
  ])
    expect(() => readReceivedDisplay(value)).toThrow();
  const value = receivedDisplayFixture(blank());
  value.deducted.special[0] = 20000;
  expect(readReceivedDisplay(value).display.special[0]).toBe(0);
});
test("display-only input permits cents without changing ledger entry precision", () => {
  expect(entryCents("0.01")).toBeNull();
  for (const [text, cents] of [
    ["100", 10000n],
    ["0.01", 1n],
    ["020.50", 2050n],
    [" 30.5 ", 3050n],
    ["90000000000000", 9000000000000000n],
  ] as const) {
    expect(displayCents(text)).toBe(cents);
    expect(displayCents(displayAmount(cents))).toBe(cents);
  }
  for (const text of [
    "",
    "0",
    "-1",
    "1.001",
    "1e2",
    "1,000",
    "90000000000000.01",
    "1.",
    ".5",
  ])
    expect(displayCents(text)).toBeNull();
  expect(receivedItemName("special", 0)).toBe("01");
  expect(receivedItemName("special", 48)).toBe("49");
  expect(receivedItemName("zodiac", 0)).toBe("鼠");
  expect(receivedItemName("zodiac", 11)).toBe("猪");
  expect(receivedItemName("tail", 9)).toBe("9尾");
});
