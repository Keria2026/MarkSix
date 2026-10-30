import { expect, test } from "bun:test";
import { monetaryLiteral } from "../../src/lib/text-entry/amount";
import { parseText, compileRow } from "../../src/lib/text-entry";
import { annualMapping } from "../../src/lib/types";
import { plays } from "./support";

test("explicit Chinese money and multipliers preserve integer values", () => {
  for (const [input, expected] of [
    ["两千", "2000"],
    ["一百", "100"],
    ["三百零五", "305"],
    ["十", "10"],
    ["十五", "15"],
    ["一万二千", "12000"],
    ["2千", "2000"],
    ["1.5千", "1500"],
    ["零点五", null],
    ["一百五", null],
    ["一千二", null],
    ["十百", null],
    ["3万万", null],
  ] as const)
    expect(monetaryLiteral(input)).toBe(expected);
  for (const [text, expected] of [
    ["一肖中龙1千", "1000"],
    ["特码18各一百", "100"],
    ["三有虎龙猴各两千元", "2000"],
  ]) {
    const rows = parseText(text, plays);
    expect(rows).toHaveLength(1);
    const result = compileRow(rows[0], plays, annualMapping(2026));
    expect(result.error).toBe("");
    expect(result.items[0].amount).toBe(expected);
  }
});

test("postfix play and shared amount apply to complete numeric lines", () => {
  const rows = parseText("02,09,16,25,31\n03,07,21,33,48\n五不中各400", plays);
  expect(rows).toHaveLength(1);
  const result = compileRow(rows[0], plays, annualMapping(2026));
  expect(result.error).toBe("");
  expect(result.items.map((i) => i.selections)).toEqual([
    [2, 9, 16, 25, 31],
    [3, 7, 21, 33, 48],
  ]);
  expect(result.items.map((i) => i.amount)).toEqual(["400", "400"]);
});

test("compound groups keep their own pools and inherit only within the same play", () => {
  const rows = parseText(
    "三有复试牛兔龙猴，每组80，马狗鸡猪每组90；二有虎鼠各20",
    plays,
  );
  const compiled = rows.map((row) =>
    compileRow(row, plays, annualMapping(2026)),
  );
  expect(compiled.map((c) => c.error)).toEqual(["", "", ""]);
  expect(compiled.map((c) => c.items[0].compound)).toEqual([true, true, false]);
  const grouped = compileRow(
    parseText("三有复试鼠牛虎兔，龙蛇马羊各50元一组", plays)[0],
    plays,
    annualMapping(2026),
  );
  expect(grouped.error).toBe("");
  expect(grouped.items.map((i) => i.selections)).toEqual([
    [0, 1, 2, 3],
    [4, 5, 6, 7],
  ]);
});

test("mixed drag expands zodiac and tail selectors against the supplied mapping", () => {
  const mapping = annualMapping(2026);
  for (const [text, right] of [
    ["二中二18拖7尾各25元", [7, 17, 27, 37, 47]],
    ["二中二18拖蛇各25元", [2, 14, 26, 38]],
  ] as const) {
    const rows = parseText(text, plays);
    expect(rows).toHaveLength(1);
    const result = compileRow(rows[0], plays, mapping);
    expect(result.error).toBe("");
    expect(result.items[0].drag).toEqual({ left: [18], right, zodiac: false });
  }
});

test("numeric spelling uses the current configured play name and rule", () => {
  const rows = parseText("4有龙蛇马羊各80元；6肖亮900元", plays);
  expect(rows).toHaveLength(2);
  expect(plays.find((p) => p.id === rows[0].playId)?.rule.name).toBe("四有");
  expect(plays.find((p) => p.id === rows[1].playId)?.rule.name).toBe("六肖量");
});

test("drag expansions reject malformed tails and overlapping pools", () => {
  for (const raw of [
    "二中二18拖10尾各20",
    "二中二17拖7尾各20",
    "二中二18拖7尾17各20",
  ]) {
    const rows = parseText(raw, plays);
    expect(
      rows.some((row) => compileRow(row, plays, annualMapping(2026)).error),
    ).toBe(true);
  }
});
