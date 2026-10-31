import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping } from "../../src/lib/types";
import { plays } from "./support";
const mapping = annualMapping(2026);
function items(raw: string) {
  const rows = parseText(raw, plays);
  const result = compileText(rows, plays, mapping);
  expect(result.map((r) => r.error)).toEqual(rows.map(() => ""));
  return result
    .flatMap((r) => r.items)
    .map((i) => ({
      market: i.market ?? "macau",
      amount: i.amount,
      selections: i.selections,
    }));
}
test("Hong Kong headings and abbreviated or trailing markers select Hong Kong", () => {
  for (const raw of [
    "香港六合彩 特码12各100",
    "港 特码12各100",
    "香12各100",
    "特码12各100 香港",
  ]) {
    expect(items(raw)).toEqual([
      { market: "hk", amount: "100", selections: [12] },
    ]);
  }
  expect(items("特码12各100")).toEqual([
    { market: "macau", amount: "100", selections: [12] },
  ]);
});
test("mixed slip switches markets while each heading applies to following continuations", () => {
  expect(
    items("香港特码12各100\n13各20\n澳门特码14各30\n港特码15各40"),
  ).toEqual([
    { market: "hk", amount: "100", selections: [12] },
    { market: "hk", amount: "20", selections: [13] },
    { market: "macau", amount: "30", selections: [14] },
    { market: "hk", amount: "40", selections: [15] },
  ]);
  expect(items("澳门特码12各20，香港二有牛虎各30")).toEqual([
    { market: "macau", amount: "20", selections: [12] },
    { market: "hk", amount: "30", selections: [1, 2] },
  ]);
});
test("mixed market subtotal remains independently editable and source is preserved", () => {
  const raw = "香港特码12各100\n澳门特码13各200\n2组共300";
  const rows = parseText(raw, plays);
  expect(rows.map((r) => r.source).join("")).toBe(raw);
  expect(compileText(rows, plays, mapping).every((r) => !r.error)).toBe(true);
  rows[0].market = "macau";
  expect(compileText(rows, plays, mapping)[0].items[0].market).toBeUndefined();
  rows[0].amount = "50";
  expect(compileText(rows, plays, mapping).at(-1)!.error).not.toBe("");
});

test("adjacent contradictory market headings remain reviewable", () => {
  const rows = parseText("香港澳门特码12各100", plays);
  expect(compileText(rows, plays, mapping).some((row) => !!row.error)).toBe(
    true,
  );
});

test("a same-market marker between objects and play preserves postfix syntax", () => {
  expect(items("14、27、43澳门三中三各组50")).toEqual([
    { market: "macau", amount: "50", selections: [14, 27, 43] },
  ]);
  expect(items("14、27、43香港三中三各组50")).toEqual([
    { market: "hk", amount: "50", selections: [14, 27, 43] },
  ]);
});

test("mixed postfix market labels cannot silently reverse financial assignments", () => {
  const rows = parseText("特码12各100香港，特码13各200澳门", plays);
  expect(compileText(rows, plays, mapping).some((row) => !!row.error)).toBe(
    true,
  );
});
