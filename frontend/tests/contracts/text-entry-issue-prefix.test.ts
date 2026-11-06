import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping } from "../../src/lib/types";
import { plays } from "./fixtures";
const mapping = annualMapping(2026);
function compile(raw: string, configured = plays) {
  const rows = parseText(raw, configured);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return { rows, result: compileText(rows, configured, mapping) };
}
function valid(raw: string, configured = plays) {
  const { rows, result } = compile(raw, configured);
  expect(result.length).toBeGreaterThan(0);
  expect(result.map((row) => row.error)).toEqual(result.map(() => ""));
  return { rows, items: result.flatMap((row) => row.items) };
}
for (const separator of ["，", ",", "；", "\n", "\r\n"]) {
  test(`bare zodiac prices and postfix special prices keep five independent rows across ${JSON.stringify(separator)}`, () => {
    const { items } = valid(
      [
        "狗各25",
        "牛兔各数5",
        "33特50",
        "09，30各25",
        "复式四有龙牛狗兔马虎10一组",
        "总390",
      ].join(separator),
    );
    expect(
      items.map(
        (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
      ),
    ).toEqual(["特码", "特码", "特码", "特码", "四有"]);
    expect(items.map((item) => item.amount)).toEqual([
      "25",
      "5",
      "50",
      "25",
      "10",
    ]);
    expect(items.map((item) => item.selections)).toEqual([
      [9, 21, 33, 45],
      [4, 6, 16, 18, 28, 30, 40, 42],
      [33],
      [9, 30],
      [4, 1, 10, 3, 6, 2],
    ]);
    expect(items.map((item) => item.compound)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });
}
for (const marker of ["各", "个", "各买", "各打", "每注"]) {
  test(`an unqualified zodiac with ${marker} uses per-number special prices`, () => {
    const { items } = valid(`狗${marker}25`);
    expect(items[0]).toMatchObject({
      play_id: plays.find((play) => play.rule.name === "特码")!.id,
      selections: [9, 21, 33, 45],
      amount: "25",
    });
    expect(items[0].package_zodiacs).toBeUndefined();
  });
}
test("explicit and inherited native zodiac plays retain their own objects", () => {
  const { items } = valid("一肖中狗各25，牛兔各5；二有牛兔各10");
  expect(
    items.map(
      (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
    ),
  ).toEqual(["一肖中", "一肖中", "二有"]);
  expect(items.map((item) => item.selections)).toEqual([[10], [1, 3], [1, 3]]);
  expect(compile("狗25").result.some((row) => !!row.error)).toBe(true);
});
for (const prefix of [
  "312期",
  "第312期",
  "第３１２期",
  "第 三百一十二 期：",
  "2040312期",
  "  312期\n",
]) {
  test(`leading issue metadata is excluded from numbers and prices: ${prefix}`, () => {
    const raw = `${prefix}澳特19/39/47/28/09/06/40/30/22/34/23/42各买10米！04/16/02/38/27/21各买5米！\n总150`;
    const { rows, items } = valid(raw);
    expect(rows[0].source.startsWith(prefix)).toBe(true);
    expect(items.map((item) => item.selections)).toEqual([
      [19, 39, 47, 28, 9, 6, 40, 30, 22, 34, 23, 42],
      [4, 16, 2, 38, 27, 21],
    ]);
    expect(items.map((item) => item.amount)).toEqual(["10", "5"]);
    expect(items.map((item) => item.market ?? "macau")).toEqual([
      "macau",
      "macau",
    ]);
  });
}
test("line-specific issue metadata keeps each market and repeated selections", () => {
  const { items } = valid(
    "312期澳特03/15/03各10元!\n313期香港特04/16各20元！\n总70",
  );
  expect(
    items.map((item) => ({
      market: item.market ?? "macau",
      selections: item.selections,
      amount: item.amount,
    })),
  ).toEqual([
    { market: "macau", selections: [3, 15, 3], amount: "10" },
    { market: "hk", selections: [4, 16], amount: "20" },
  ]);
});
test("slash unit prices remain valid without a later explicit shared price", () => {
  const { items } = valid("312期澳特03/15；特04/20");
  expect(
    items.map((item) => ({ selections: item.selections, amount: item.amount })),
  ).toEqual([
    { selections: [3], amount: "15" },
    { selections: [4], amount: "20" },
  ]);
});
test("postfix explicit fee names keep their amount and subsequent inherited fee", () => {
  const { items } = valid(
    "33特码45倍50，09，30各25，复式四有龙牛狗兔马虎10一组",
  );
  expect(items.slice(0, 2).map((item) => item.play_id)).toEqual(
    Array(2).fill(plays.find((play) => play.rule.name === "特码45倍")!.id),
  );
  expect(items.map((item) => item.amount)).toEqual(["50", "25", "10"]);
  expect(items[0].selections).toEqual([33]);
  expect(items[1].selections).toEqual([9, 30]);
});
for (const raw of [
  "312澳特03/15各10",
  "特码03各312期",
  "312期取消特码03各10",
  "312期澳特03/50/07",
  "狗未知各25",
  "狗各25，特码03各10.55",
  "狗各25，牛兔各数5，总1",
]) {
  test(`unknown text and malformed financial fields still block: ${raw}`, () => {
    expect(compile(raw).result.some((row) => !!row.error)).toBe(true);
  });
}
test("implicit defaults cannot revive a disabled special play", () => {
  const configured = plays.map((play) => ({
    ...play,
    enabled: play.rule.name !== "特码",
  }));
  expect(compile("狗各25", configured).result.some((row) => !!row.error)).toBe(
    true,
  );
});
