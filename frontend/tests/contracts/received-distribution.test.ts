import { expect, test } from "bun:test";
import { readReceived, receivedSummary } from "../../src/lib/received";
const blank = () => ({
  special: Array(49).fill(0),
  zodiac: Array(12).fill(0),
  tail: Array(10).fill(0),
});
test("all slots including zero stakes contribute to the exact average and threshold", () => {
  const d = blank();
  d.special[0] = 4900;
  const s = receivedSummary(readReceived(d).special);
  expect(s.total).toBe(4900n);
  expect(s.average).toBe(100n);
  expect(s.cells.filter((c) => c.above)).toHaveLength(1);
  expect(s.cells[0].excess).toBe(4800n);
  expect(
    receivedSummary(Array(12).fill(100)).cells.every((c) => !c.above),
  ).toBe(true);
  expect(receivedSummary(Array(10).fill(0)).cells.every((c) => !c.above)).toBe(
    true,
  );
});
test("fractional-cent averages use exact comparisons and display rounded cents", () => {
  const s = receivedSummary([1, 0, 0]);
  expect(s.average).toBe(0n);
  expect(s.cells[0].above).toBe(true);
  expect(s.cells[0].excess).toBe(1n);
  expect(receivedSummary([1, 1, 0]).cells[0]).toMatchObject({
    above: true,
    excess: 0n,
  });
  const big = Array(49).fill(0);
  big[48] = 9_000_000_000_000_000;
  expect(receivedSummary(big).total).toBe(9_000_000_000_000_000n);
});
test("incomplete or invalid responses cannot silently display zero totals", () => {
  for (const value of [
    null,
    {},
    { ...blank(), tail: [] },
    { ...blank(), special: Array(49).fill(-1) },
    { ...blank(), zodiac: Array(12).fill(0.1) },
    { ...blank(), tail: Array(10).fill(9_000_000_000_000_000) },
  ])
    expect(() => readReceived(value)).toThrow();
});
