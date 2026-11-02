import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping, basicCount } from "../../src/lib/types";
import type { Play } from "../../src/lib/types";
import { plays } from "./fixtures";
const mapping = annualMapping(2026);
function compile(raw: string, configured: Play[] = plays) {
  const rows = parseText(raw, configured);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return { rows, result: compileText(rows, configured, mapping) };
}
function valid(raw: string) {
  const { rows, result } = compile(raw);
  expect(result.map((r) => r.error)).toEqual(rows.map(() => ""));
  return result.flatMap((r) => r.items);
}
test("slash separates completed clauses and preserves shared compound candidates", () => {
  const items = valid("12.48各180/36.24各40；兔特各70/07.43各90");
  expect(items.map((i) => i.selections)).toEqual([
    [12, 48],
    [36, 24],
    [4, 16, 28, 40],
    [7, 43],
  ]);
  expect(items.map((i) => i.amount)).toEqual(["180", "40", "70", "90"]);
  const compound = valid("鼠牛虎兔龙蛇付五有各90/四有各40");
  expect(compound.map((i) => i.selections)).toEqual([
    [0, 1, 2, 3, 4, 5],
    [0, 1, 2, 3, 4, 5],
  ]);
  expect(compound.map((i) => i.compound)).toEqual([true, true]);
});
test("enumeration and slash amount have distinct roles", () => {
  const [item] = valid("17-37-07三中三/6米");
  expect(item.selections).toEqual([17, 37, 7]);
  expect(item.amount).toBe("6");
  expect(valid("-17-37-07三中三/6")[0].selections).toEqual([17, 37, 7]);
  for (const raw of ["17-37三中三/6", "17-17-07三中三/6", "17-50-07三中三/6"])
    expect(compile(raw).result.some((r) => r.error)).toBe(true);
});
test("tail pools expand in number plays and mixed drag, flat tails keep their meaning", () => {
  const [drag] = valid("澳二中二：8尾拖狗各组30");
  expect(drag.drag).toEqual({
    left: [8, 18, 28, 38, 48],
    right: [9, 21, 33, 45],
    zodiac: false,
  });
  expect(valid("2尾五不中700")[0].selections).toEqual([2, 12, 22, 32, 42]);
  const [flat] = valid("平8尾700");
  expect(plays.find((p) => p.id === flat.play_id)?.rule.name).toBe("尾中");
  expect(flat.selections).toEqual([8]);
  expect(valid("2尾5尾8尾各打1500")[0].selections).toEqual([2, 5, 8]);
  for (const raw of [
    "0尾五不中700",
    "12尾五不中700",
    "2尾2尾五不中700",
    "2尾五不中700.55",
    "澳二中二8尾拖猪各30",
  ])
    expect(compile(raw).result.some((r) => r.error)).toBe(true);
});
for (const [head, expected] of [
  ["0", [1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ["二", [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]],
  ["4", [40, 41, 42, 43, 44, 45, 46, 47, 48, 49]],
] as const) {
  test(`head pool ${head} chooses the configured miss quantity`, () => {
    const [item] = valid(`${head}头不中各400`);
    expect(item.selections).toEqual([...expected]);
    expect(item.amount).toBe("400");
    const disabled = plays.map((p) => ({
      ...p,
      enabled: p.id !== item.play_id,
    }));
    expect(
      compile(`${head}头不中各400`, disabled).result.some((r) => r.error),
    ).toBe(true);
  });
}
test("exact configured head name retains its rule", () => {
  const base = plays.find((p) => p.rule.name === "十不中")!;
  const custom = { ...base, id: 1000, rule: { ...base.rule, name: "4头不中" } };
  expect(compile("4头不中各400", [...plays, custom]).rows[0].playId).toBe(1000);
});
test("omitted linked suffix shares candidates; local and grand totals validate independently", () => {
  const raw =
    "鼠牛虎兔龙复试3.4.5有个组50\n16组共800\n鼠牛虎，牛虎兔，虎兔龙，兔龙蛇，龙蛇马，蛇马羊三有个组100共600\n三有四鼠牛虎兔120一组共600\n共2000";
  const { rows, result } = compile(raw);
  expect(result.map((r) => r.error)).toEqual(rows.map(() => ""));
  const items = result.flatMap((r) => r.items);
  expect(items).toHaveLength(11);
  expect(
    items
      .slice(-2)
      .map((i) =>
        basicCount(
          plays.find((p) => p.id === i.play_id)!.rule,
          i.selections,
          i.compound,
        ),
      ),
  ).toEqual([4, 1]);
  for (const wrong of [
    raw.replace("100共600", "100共601"),
    raw.replace("一组共600", "一组共601"),
    raw.replace("共2000", "共1999"),
  ])
    expect(compile(wrong).result.some((r) => r.error)).toBe(true);
  rows[0].amount = "60";
  expect(compileText(rows, plays, mapping).at(-1)?.error).not.toBe("");
});
test("totals attached to selections remain amounts; unknown input stays blocked", () => {
  expect(valid("三有鼠牛虎共600")[0].amount).toBe("600.0");
  for (const raw of [
    "三有鼠牛虎各100/不明指令共100",
    "5头不中各500",
    "三有四鼠牛虎兔120一组共601",
  ])
    expect(compile(raw).result.some((r) => r.error)).toBe(true);
});
test("special shorthand and trailing punctuation retain their amounts", () => {
  expect(valid("15.27.各200")[0].selections).toEqual([15, 27]);
  const items = valid("奥特鼠牛虎各数300元25买100元。");
  expect(items.map((i) => i.amount)).toEqual(["300", "100"]);
  expect(items[1].selections).toEqual([25]);
});

test("standalone amount summaries use their prefix or the whole slip when leading", () => {
  valid("特码12各100\n共100\n特码13各200");
  valid("共300\n特码12各100\n特码13各200");
  for (const label of ["二有三", "2有3", "二有三有"]) {
    const items = valid(`${label}鼠牛虎兔20一组共200`);
    expect(items.map((item) => item.amount)).toEqual(["20", "20"]);
    expect(items.map((item) => item.selections)).toEqual([
      [0, 1, 2, 3],
      [0, 1, 2, 3],
    ]);
  }
});

for (const raw of [
  "特2尾 8尾 共1400",
  "特2尾\u00a08尾\u00a0共1400",
  "特码２尾\u202f８尾\u202f共１４００",
  "特二尾八尾共一千四百",
  "澳特2尾，8尾，共1400",
  "特码2尾\n8尾合计1400",
  "2尾8尾特共1400",
]) {
  test(`special tails keep the number play and divide the total across all numbers: ${raw}`, () => {
    const { rows, result } = compile(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBeUndefined();
    expect(rows[0].marker).toMatch(/^(共|合计)$/u);
    expect(result[0].error).toBe("");
    expect(result[0].items).toHaveLength(1);
    const [item] = result[0].items;
    expect(item.play_id).toBe(plays.find((p) => p.rule.name === "特码")!.id);
    expect(item.selections).toEqual([2, 12, 22, 32, 42, 8, 18, 28, 38, 48]);
    expect(item.amount).toBe("140.0");
    expect(
      basicCount(
        plays.find((p) => p.id === item.play_id)!.rule,
        item.selections,
        item.compound,
      ),
    ).toBe(10);
    expect(item.package_zodiacs).toBeUndefined();
  });
}

test("special-tail totals use the actual 01-49 pool and recompute after edits", () => {
  const { rows } = compile("特码0尾 5尾共900");
  let result = compileText(rows, plays, mapping);
  expect(result[0].error).toBe("");
  expect(result[0].items[0].selections).toEqual([
    10, 20, 30, 40, 5, 15, 25, 35, 45,
  ]);
  expect(result[0].items[0].amount).toBe("100.0");
  rows[0].amount = "990";
  result = compileText(rows, plays, mapping);
  expect(result[0].items[0].amount).toBe("110.0");
  rows[0].amount = "1000";
  expect(compileText(rows, plays, mapping)[0].error).toContain("均分");
});

test("special-tail prices distinguish per-number money, totals, and flat-tail plays", () => {
  expect(valid("特码2尾8尾各70")[0].amount).toBe("70");
  const [flat] = valid("尾中2尾8尾共1400");
  expect(flat.play_id).toBe(plays.find((p) => p.rule.name === "尾中")!.id);
  expect(flat.selections).toEqual([2, 8]);
  expect(flat.amount).toBe("700.0");
  expect(valid("特2尾2尾共1400")[0].selections).toEqual([
    2, 12, 22, 32, 42, 2, 12, 22, 32, 42,
  ]);
  expect(valid("特2尾12共600")[0].selections).toEqual([2, 12, 22, 32, 42, 12]);
  for (const raw of [
    "特10尾共1400",
    "特2尾8尾共1400.05",
    "特2尾8尾共1400未明要求",
  ])
    expect(compile(raw).result.some((r) => r.error)).toBe(true);
  const disabled = plays.map((p) => ({
    ...p,
    enabled: p.rule.name !== "特码",
  }));
  expect(compile("特2尾8尾共1400", disabled).result.some((r) => r.error)).toBe(
    true,
  );
});

test("repeated numeric slashes remain ambiguous without complete amount boundaries", () => {
  for (const raw of ["11/22/33各50", "12/24/36各80"])
    expect(compile(raw).result.some((r) => r.error)).toBe(true);
  const items = valid("特码11/50/特码22各60");
  expect(items.map((item) => item.selections)).toEqual([[11], [22]]);
  expect(items.map((item) => item.amount)).toEqual(["50", "60"]);
});
