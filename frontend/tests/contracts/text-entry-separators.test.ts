import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping, basicCount } from "../../src/lib/types";
import { tokenize } from "../../src/lib/text-entry/lexer";
import { plays } from "./fixtures";
const mapping = annualMapping(2026);
function compile(raw: string, configured = plays) {
  const rows = parseText(raw, configured);
  let end = 0;
  for (const row of rows) {
    expect(row.source).toBe(raw.slice(row.start, row.end));
    expect(row.start).toBeLessThanOrEqual(end);
    end = Math.max(end, row.end);
  }
  expect(end).toBe(raw.length);
  return compileText(rows, configured, mapping);
}
function valid(raw: string) {
  const result = compile(raw);
  expect(result.length).toBeGreaterThan(0);
  expect(result.map((r) => r.error)).toEqual(result.map(() => ""));
  return result.flatMap((r) => r.items);
}
for (const sep of [
  "//",
  "///",
  "//////",
  "／／／",
  "/ / /",
  "ll",
  "ii",
  "LL",
  "II",
  "ｌｌ",
  "ｉｉ",
  "x",
  "X",
]) {
  test(`separator ${sep} preserves completed records and inherited prices`, () => {
    const items = valid(`特码03各10 ${sep} 15各20`);
    expect(items.map((i) => [i.selections, i.amount])).toEqual([
      [[3], "10"],
      [[15], "20"],
    ]);
  });
  test(`separator ${sep} preserves number lists and totals`, () => {
    const items = valid(`特码03 ${sep} 15 ${sep} 27各10\n3注共30`);
    expect(items.flatMap((i) => i.selections)).toEqual([3, 15, 27]);
    expect(items.every((i) => i.amount === "10")).toBe(true);
    expect(
      items.reduce(
        (n, i) =>
          n +
          basicCount(
            plays.find((p) => p.id === i.play_id)!.rule,
            i.selections,
            i.compound,
          ),
        0,
      ),
    ).toBe(3);
  });
  test(`separator ${sep} preserves independent complete zodiac groups`, () => {
    const items = valid(`三有鼠牛虎 ${sep} 兔龙蛇各组10`);
    expect(items.map((i) => i.selections)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(items.map((i) => i.amount)).toEqual(["10", "10"]);
  });
}
test("repeated slashes separate slash-priced records without swapping selections and money", () => {
  expect(
    valid("特码03/10///15/20").map((i) => [i.selections, i.amount]),
  ).toEqual([
    [[3], "10"],
    [[15], "20"],
  ]);
  expect(valid("///特码03///15各10").flatMap((i) => i.selections)).toEqual([
    3, 15,
  ]);
  expect(compile("特码03///10").some((r) => !!r.error)).toBe(true);
});
test("ordinary x and slash retain their amount semantics", () => {
  for (const raw of [
    "特码03x100",
    "特码03X100",
    "特码03/100",
    "二中二03-15/20",
  ]) {
    const items = valid(raw);
    expect(items).toHaveLength(1);
    expect(items[0].amount).toBe(raw.endsWith("20") ? "20" : "100");
  }
});
test("letter separators are bounded and configured exact names keep priority", () => {
  for (const raw of [
    "特码03hello15各10",
    "特码03bill15各10",
    "特码03invalid15各10",
    "特码03unknown15各10",
    "二中二03///各10",
  ])
    expect(compile(raw).some((r) => !!r.error)).toBe(true);
  for (const name of ["ll", "ii", "x"]) {
    const base = plays.find((p) => p.rule.name === "特码")!;
    const configured = [
      ...plays,
      { ...base, id: 999, rule: { ...base.rule, name } },
    ];
    const rows = compile(`${name}03各10`, configured);
    expect(rows[0].error).toBe("");
    expect(rows[0].items[0].play_id).toBe(999);
  }
  const raw = "03／／／15";
  expect(
    tokenize(raw, []).map((t) => [t.kind, t.text, raw.slice(t.start, t.end)]),
  ).toEqual([
    ["number", "03", "03"],
    ["separator", ";", "／／／"],
    ["number", "15", "15"],
  ]);
});

test("existing x prices keep ownership before later separately priced choices", () => {
  for (const separator of ["；", "/", "///", " "]) {
    expect(
      valid(`特码03x10${separator}15各20`).map((i) => [i.selections, i.amount]),
    ).toEqual([
      [[3], "10"],
      [[15], "20"],
    ]);
  }
  expect(
    valid("特码03x10///15/20").map((i) => [i.selections, i.amount]),
  ).toEqual([
    [[3], "10"],
    [[15], "20"],
  ]);
  expect(valid("特码03x15各20").flatMap((i) => i.selections)).toEqual([3, 15]);
});
test("mixed markets, decimal prices and tail selectors retain their business fields", () => {
  const items = valid(
    "香港特码03各12.5///澳门平码15各20 ll 27各30 ii 尾中2尾8尾各10",
  );
  expect(
    items.map((i) => [i.market ?? "macau", i.amount, i.selections]),
  ).toEqual([
    ["hk", "12.5", [3]],
    ["macau", "20", [15]],
    ["macau", "30", [27]],
    ["macau", "10", [2, 8]],
  ]);
  expect(valid("特码3尾 x 6尾各10").flatMap((i) => i.selections)).toEqual([
    3, 13, 23, 33, 43, 6, 16, 26, 36, 46,
  ]);
});

test("mixed delimiter runs cannot create amount-only phantom items", () => {
  expect(
    valid("特码03各10 /// x ll ii 15各20").map((i) => [i.selections, i.amount]),
  ).toEqual([
    [[3], "10"],
    [[15], "20"],
  ]);
});
