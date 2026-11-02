import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping, basicCount } from "../../src/lib/types";
import { plays } from "./support";
const mapping = annualMapping(2026);
function compile(raw: string, configured = plays) {
  const rows = parseText(raw, configured);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return { rows, result: compileText(rows, configured, mapping) };
}
function valid(raw: string) {
  const { rows, result } = compile(raw);
  expect(rows.length).toBeGreaterThan(0);
  expect(result.map((r) => r.error)).toEqual(rows.map(() => ""));
  return result.flatMap((r) => r.items);
}
test("number selectors preserve regular-number plays and their inherited context", () => {
  const items = valid("平码1头各30；2尾各40；蛇各数50；牛各数60");
  expect(items.map((i) => i.play_id)).toEqual(
    Array(4).fill(plays.find((p) => p.rule.name === "平码")!.id),
  );
  expect(items.map((i) => i.selections)).toEqual([
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    [2, 12, 22, 32, 42],
    [2, 14, 26, 38],
    [6, 18, 30, 42],
  ]);
  expect(items.map((i) => i.amount)).toEqual(["30", "40", "50", "60"]);
});
for (const [name, selector, expected, count] of [
  ["二中二", "蛇", [2, 14, 26, 38], 6],
  ["二中二含特", "蛇40", [2, 14, 26, 38, 40], 10],
  ["三中三", "羊", [12, 24, 36, 48], 4],
  ["二中二", "0头羊", [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 24, 36, 48], 78],
] as const) {
  test(`${name} compiles the selector pool ${selector} using its own combination rule`, () => {
    const [item] = valid(`${name}复式${selector}各组20`);
    const play = plays.find((p) => p.rule.name === name)!;
    expect(item.play_id).toBe(play.id);
    expect(item.selections).toEqual([...expected]);
    expect(item.compound).toBe(true);
    expect(item.amount).toBe("20");
    expect(basicCount(play.rule, item.selections, true)).toBe(count);
  });
}
test("zodiac number pools inherit combination plays and total prices use combination counts", () => {
  const items = valid("二中二复式蛇各组20；羊各数30\n12组共300");
  expect(items.map((i) => i.play_id)).toEqual(
    Array(2).fill(plays.find((p) => p.rule.name === "二中二")!.id),
  );
  expect(items.map((i) => i.selections)).toEqual([
    [2, 14, 26, 38],
    [12, 24, 36, 48],
  ]);
  expect(valid("二中二复式蛇共120")[0].amount).toBe("20.0");
});
test("native zodiac and tail plays keep their object types and explicit new plays end inheritance", () => {
  const items = valid(
    "一肖中蛇各数50；牛各肖60；二尾连2尾8尾各70；二中二复式羊各组20",
  );
  expect(
    items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["一肖中", "一肖中", "二尾连", "二中二"]);
  expect(items.map((i) => i.selections)).toEqual([
    [5],
    [1],
    [2, 8],
    [12, 24, 36, 48],
  ]);
  expect(valid("蛇各数40")[0].play_id).toBe(
    plays.find((p) => p.rule.name === "特码")!.id,
  );
  expect(valid("蛇各肖40")[0].package_zodiacs).toEqual([5]);
});
test("mixed number selectors expand identically on either side of drag", () => {
  const [item] = valid("二中二0头拖羊各组20");
  expect(item.drag).toEqual({
    left: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    right: [12, 24, 36, 48],
    zodiac: false,
  });
});
test("zodiac pools use each market's period mapping", () => {
  const rows = parseText(
    "香港二中二复式蛇各组20；澳门二中二复式蛇各组20",
    plays,
  );
  const result = compileText(rows, plays, mapping, annualMapping(2027));
  expect(result.map((r) => r.error)).toEqual(["", ""]);
  expect(result.map((r) => r.items[0].selections)).toEqual([
    [3, 15, 27, 39],
    [2, 14, 26, 38],
  ]);
});
test("selectors do not hide overlap, invalid rules, grouping or incomplete period mappings", () => {
  for (const raw of [
    "二中二复式蛇14各组20",
    "二中二复式蛇蛇各组20",
    "二中二复式1头蛇各组20",
    "二中二蛇各组20",
    "二中二包蛇各肖20",
    "波色蛇各40",
    "尾中羊各40",
    "二中二复式蛇未知各组20",
    "二中二1头拖兔各20",
  ])
    expect(compile(raw).result.some((r) => r.error)).toBe(true);
  const play = plays.find((p) => p.rule.name === "二中二")!;
  const disabled = plays.map((p) => ({ ...p, enabled: p.id !== play.id }));
  expect(
    compile("二中二复式蛇各组20", disabled).result.some((r) => r.error),
  ).toBe(true);
  for (const ruleChange of [
    { compound_enabled: false },
    { selection_limit: 3 },
  ]) {
    const configured = plays.map((p) =>
      p.id === play.id ? { ...p, rule: { ...p.rule, ...ruleChange } } : p,
    );
    expect(
      compile("二中二复式蛇各组20", configured).result.some((r) => r.error),
    ).toBe(true);
  }
  const rows = parseText("二中二复式蛇各组20", plays);
  expect(
    compileText(rows, plays, { ...mapping, zodiac: [] })[0].error,
  ).toContain("映射不完整");
});

test("an explicit number play replaces a preceding fallback default", () => {
  const items = valid("蛇各数40；平码羊各数50；牛各数60");
  expect(
    items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["特码", "平码", "平码"]);
});

test("shared selector pools keep every explicitly selected number play", () => {
  const items = valid("特平蛇各数40；羊各数50");
  expect(
    items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["特码", "平码", "特码", "平码"]);
  expect(items.map((i) => i.selections)).toEqual([
    [2, 14, 26, 38],
    [2, 14, 26, 38],
    [12, 24, 36, 48],
    [12, 24, 36, 48],
  ]);
  expect(items.map((i) => i.amount)).toEqual(["40", "40", "50", "50"]);
});
