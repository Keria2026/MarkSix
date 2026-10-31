import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping } from "../../src/lib/types";
import { plays } from "./support";
const mapping = annualMapping(2026);
function compile(raw: string) {
  const rows = parseText(raw, plays);
  const result = compileText(rows, plays, mapping);
  expect(result.map((r) => r.error)).toEqual(rows.map(() => ""));
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return result.flatMap((r) => r.items);
}
for (const suffix of [
  "\n 16组共1120",
  "\n\t十六组共一千一百二十元",
  "，16 组 共 1120 斤",
]) {
  test(`summary never becomes additional bets: ${suffix}`, () => {
    const items = compile("鼠牛虎兔龙复试345有各70" + suffix);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.amount)).toEqual(["70", "70", "70"]);
  });
}
for (const suffix of ["\n十五组共1120", "\n待核对共1120", "四有照旧各70"]) {
  test(`unknown or contradictory continuation stays blocked: ${suffix}`, () => {
    const rows = parseText("鼠牛虎兔龙复试345有各70" + suffix, plays);
    expect(compileText(rows, plays, mapping).some((r) => r.error)).toBe(true);
  });
}
for (const [raw, selections] of [
  ["平特一二三四五六七八九尾各七十", [1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ["平特123456789尾各70", [1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ["二尾连一、三各七十", [1, 3]],
  ["二十三.四十各七十", [23, 40]],
  ["023.0642各70", [23, 6, 42]],
  ["二十三，四十，七三中三七十米", [23, 40, 7]],
] as const) {
  test(`numeric representations preserve selection and amount: ${raw}`, () => {
    const items = compile(raw);
    expect(items).toHaveLength(1);
    expect(items[0].selections).toEqual([...selections]);
    expect(items[0].amount).toBe("70");
  });
}
test("decimal trailing zeros normalize without rounding", () => {
  expect(compile("三有鼠牛虎各12.50")[0].amount).toBe("12.5");
  expect(
    compileText(parseText("三有鼠牛虎各12.55", plays), plays, mapping).some(
      (r) => r.error,
    ),
  ).toBe(true);
});
test("aliases cannot swallow the selected horse", () => {
  const single = compile("平马鼠各70")[0];
  expect(plays.find((p) => p.id === single.play_id)!.rule.name).toBe("一肖中");
  expect(single.selections).toEqual([6, 0]);
  const numbers = compile("特马鼠各数70")[0];
  expect(numbers.selections).toEqual(
    mapping.zodiac.flatMap((z, i) => ([6, 0].includes(z) ? [i + 1] : [])),
  );
});
test("spaced multi-play declarations share candidates", () => {
  for (const label of ["4有 5有", "4/5有", "四五连肖"]) {
    const items = compile(`鼠牛虎兔龙蛇复${label}各70`);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.selections)).toEqual([
      [0, 1, 2, 3, 4, 5],
      [0, 1, 2, 3, 4, 5],
    ]);
  }
});
test("number play quantities include twelve in either representation", () => {
  const numbers = "01 02 03 04 05 06 07 08 09 10 11 12";
  expect(compile(`12不中${numbers}各70`)).toEqual(
    compile(`十二不中${numbers}各七十`),
  );
});

for (const marker of ["一组", "一 组", "1组"]) {
  test(`group amount prefix: ${marker}`, () => {
    const items = compile(`新澳三中三\n08、19、36 ${marker}七十米`);
    expect(items).toHaveLength(1);
    expect(items[0].selections).toEqual([8, 19, 36]);
    expect(items[0].amount).toBe("70");
  });
}
for (const label of [
  "3.4.5连肖",
  "三.四.五连肖",
  "3．4．5连肖",
  "3 . 4 . 5连肖",
]) {
  test(`flat linked combinations share trailing candidates and amount: ${label}`, () => {
    const items = compile(`新澳平特${label}复式：鼠牛兔蛇羊，各组70米`);
    expect(items).toHaveLength(3);
    expect(
      items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
    ).toEqual(["三有", "四有", "五有"]);
    expect(items.every((i) => i.compound && i.amount === "70")).toBe(true);
    expect(items.map((i) => i.selections)).toEqual([
      [0, 1, 3, 5, 7],
      [0, 1, 3, 5, 7],
      [0, 1, 3, 5, 7],
    ]);
  });
}
test("unspecified each-zodiac and each-number use special even after another play", () => {
  const items = compile("一肖中牛70元；鼠羊各肖90元；兔蛇各数40元");
  expect(
    items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["一肖中", "特码", "特码"]);
  expect(items[1].package_zodiacs).toEqual([0, 7]);
  expect(items[2].selections).toEqual(
    mapping.zodiac.flatMap((z, i) => ([3, 5].includes(z) ? [i + 1] : [])),
  );
  expect(compile("一肖中鼠羊各肖70")[0].selections).toEqual([0, 7]);
});
