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

test("mixed postfix labels belong to the preceding bets", () => {
  expect(items("特码12各100香港，特码13各200澳门")).toEqual([
    { market: "hk", amount: "100", selections: [12] },
    { market: "macau", amount: "200", selections: [13] },
  ]);
});

for (const [market, labels] of [
  ["hk", ["香港", "港", "香"]],
  ["macau", ["新澳门", "澳门", "澳"]],
] as const) {
  for (const label of labels)
    for (const raw of [
      `${label}特码12各100`,
      `特码${label}12各100`,
      `特码12${label}各100`,
      `特码12各${label}100`,
      `特码12各100${label}`,
      `特码12各100${label}元`,
      `特${label}码12各100`,
      `特码12各1${label}00`,
      `特码12各12.${label}50`,
      `（${label}）特码12各100`,
      `特码12（${label}）各100`,
      `特码12各100（${label}）`,
    ])
      test(`explicit market at any field position: ${raw}`, () => {
        expect(items(raw)).toEqual([
          {
            market,
            amount: raw.includes("12.") ? "12.5" : "100",
            selections: [12],
          },
        ]);
      });
}

test("local labels override inherited headings without changing unmarked earlier bets", () => {
  expect(
    items("特码12各10\n特码13各20香港\n澳门\n特码14各30\n特码15各40香"),
  ).toEqual([
    { market: "macau", amount: "10", selections: [12] },
    { market: "hk", amount: "20", selections: [13] },
    { market: "macau", amount: "30", selections: [14] },
    { market: "hk", amount: "40", selections: [15] },
  ]);
});

test("contradictory explicit markets require an editable decision", () => {
  const rows = parseText("香港特码12各100澳门", plays);
  expect(rows[0].marketConflict).toBe(true);
  expect(compileText(rows, plays, mapping)[0].error).toContain("请选择市场");
  rows[0].market = "macau";
  rows[0].marketConflict = false;
  expect(compileText(rows, plays, mapping)[0].error).toBe("");
});

for (const separator of ["，", ";", "；", "\n", "\r\n", "。"]) {
  for (let a = 0; a <= 4; a++)
    for (let b = 0; b <= 4; b++) {
      test(`mixed field positions ${a}/${b} with ${JSON.stringify(separator)}`, () => {
        const left = ["特码", "12", "各", "100"];
        const right = ["特码", "13", "各", "200"];
        left.splice(a, 0, "香港");
        right.splice(b, 0, "澳门");
        const raw = left.join("") + separator + right.join("");
        expect(items(raw)).toEqual([
          { market: "hk", amount: "100", selections: [12] },
          { market: "macau", amount: "200", selections: [13] },
        ]);
        const rows = parseText(raw, plays);
        expect(rows.map((r) => r.source).join("")).toBe(raw);
        expect(rows[0].source).toContain("香港");
        expect(rows[1].source).toContain("澳门");
      });
    }
}

test("market insertion preserves compound and drag financial structures", () => {
  const raw =
    "澳门三中三14、27、43一组50米；三四有龙马香港猪虎复式各100；二中特22拖香港9尾各15元";
  const rows = parseText(raw, plays);
  const compiled = compileText(rows, plays, mapping);
  expect(compiled.every((r) => !r.error)).toBe(true);
  const lines = compiled.flatMap((r) => r.items);
  expect(lines.map((i) => i.market ?? "macau")).toEqual([
    "macau",
    "hk",
    "hk",
    "hk",
  ]);
  expect(lines.map((i) => i.amount)).toEqual(["50", "100", "100", "15"]);
  expect(lines[0].selections).toEqual([14, 27, 43]);
  expect(lines[1].compound).toBe(true);
  expect(lines[2].compound).toBe(true);
  expect(lines[3].drag?.left).toEqual([22]);
});

test("recognized market transcriptions still work at the end of mixed bets", () => {
  expect(items("特码12各100香港；特码13各200新奥")).toEqual([
    { market: "hk", amount: "100", selections: [12] },
    { market: "macau", amount: "200", selections: [13] },
  ]);
});

test("market placement cannot erase the amount operator 下", () => {
  expect(
    items("特码44\n36澳门下2785；二有龙兔香港各2785；特码26\n24澳门下2785"),
  ).toEqual([
    { market: "macau", amount: "2785", selections: [44, 36] },
    { market: "hk", amount: "2785", selections: [4, 3] },
    { market: "macau", amount: "2785", selections: [26, 24] },
  ]);
});
for (const mark of ["，", "；", "：", "\n"])
  test(`market followed by a field separator ${JSON.stringify(mark)}`, () => {
    expect(items(`特码34下香港${mark}1610`)).toEqual([
      { market: "hk", amount: "1610", selections: [34] },
    ]);
  });

test("an exact configured play containing a market label keeps its own rule", () => {
  const base = plays.find((p) => p.rule.name === "特码")!;
  const configured = {
    ...base,
    id: 9876,
    rule: { ...base.rule, name: "香港特码", odds: "42" },
  };
  const options = [...plays, configured];
  const rows = parseText("香港特码12各100", options);
  const compiled = compileText(rows, options, mapping);
  expect(compiled[0].error).toBe("");
  expect(compiled[0].items[0].play_id).toBe(9876);
  expect(compiled[0].items[0].market).toBe("hk");
});

test("a following linked play cannot consume the preceding market-tagged amount", () => {
  expect(
    items("特码11\n01澳门下525\n二有兔马香港各525\n特码41\n40下澳门525"),
  ).toEqual([
    { market: "macau", amount: "525", selections: [11, 1] },
    { market: "hk", amount: "525", selections: [3, 6] },
    { market: "macau", amount: "525", selections: [41, 40] },
  ]);
});
