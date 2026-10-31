import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping } from "../../src/lib/types";
import { plays } from "./support";
const mapping = annualMapping(2026);
function compiled(raw: string) {
  const rows = parseText(raw, plays);
  expect(rows.length).toBeGreaterThan(0);
  let cursor = 0;
  for (const row of rows) {
    expect(row.start).toBeGreaterThanOrEqual(0);
    expect(row.end).toBeGreaterThanOrEqual(row.start);
    expect(row.source).toBe(raw.slice(row.start, row.end));
    expect(row.start).toBeLessThanOrEqual(cursor);
    cursor = Math.max(cursor, row.end);
  }
  expect(cursor).toBe(raw.length);
  const result = compileText(rows, plays, mapping);
  expect(result.map((r) => r.error)).toEqual(rows.map(() => ""));
  return result.flatMap((r) => r.items);
}
function blocked(raw: string) {
  const rows = parseText(raw, plays);
  expect(
    rows.some((r) => r.source.includes(raw) || raw.includes(r.source)),
  ).toBe(true);
  expect(compileText(rows, plays, mapping).some((r) => r.error)).toBe(true);
}
test("pinyin numbers compose beyond previously labelled examples", () => {
  const items = compiled(
    "xin ao er you ma yang each group shi qi；san shi yi、si shi qi te 各35",
  );
  expect(items.map((i) => i.selections)).toEqual([
    [6, 7],
    [31, 47],
  ]);
  expect(items.map((i) => i.amount)).toEqual(["17", "35"]);
  expect(plays.find((p) => p.id === items[0].play_id)!.rule.name).toBe("二有");
  expect(
    compiled("san you ma yang hou each group yi bai ling wu")[0].amount,
  ).toBe("105");
  blocked("san you ma yang hou each group yi bai wu");
});
test("amount first and trailing compound qualifiers stay in the same record", () => {
  const items = compiled(
    "每注45，龙蛇马羊猴鸡，四五有都做复式；32号，特码，90元。",
  );
  expect(items.map((i) => i.selections)).toEqual([
    [4, 5, 6, 7, 8, 9],
    [4, 5, 6, 7, 8, 9],
    [32],
  ]);
  expect(items.map((i) => i.compound)).toEqual([true, true, false]);
  expect(items.map((i) => i.amount)).toEqual(["45", "45", "90"]);
});
test("postfix plays after an amount stop at actual record separators", () => {
  const items = compiled(
    "04、18、32，一组35，三中三；二有龙蛇各45\n马羊各55\n三有鼠兔鸡各65",
  );
  expect(
    items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["三中三", "二有", "二有", "三有"]);
  expect(items.map((i) => i.amount)).toEqual(["35", "45", "55", "65"]);
});
test("spoken number followed by 码 is never expanded as the horse", () => {
  const item = compiled(
    "二中二带特，二十三码托三十二和四十一，每组二十五斤",
  )[0];
  expect(item.drag).toEqual({ left: [23], right: [32, 41], zodiac: false });
});
test("leading summary checks the whole slip and responds to edits", () => {
  const raw =
    "合计先写：16组，共560。\n下面这些：马羊猴鸡狗，复式，3/4/5连肖，一组35米。";
  expect(compiled(raw)).toHaveLength(3);
  const rows = parseText(raw, plays);
  expect(rows[0].summary).toBe(true);
  rows[1].amount = "45";
  expect(compileText(rows, plays, mapping)[0].error).toContain(
    "合计与投注不符",
  );
});
test("per-play summary checks subtotals as well as total units and stake", () => {
  const raw =
    "鼠兔龙蛇马羊复式四五有各35\n四有十五组，五有六组，共二十一组735元。";
  expect(compiled(raw)).toHaveLength(2);
  blocked(raw.replace("四有十五组，五有六组", "四有十四组，五有七组"));
  blocked(raw.replace("735", "736"));
});
test("punctuation, newline and group boundaries compose", () => {
  const items = compiled(
    "复试三四有\n鼠兔龙蛇，鼠兔龙马\n牛羊猴鸡，牛羊猴狗\n各组35米",
  );
  expect(items).toHaveLength(8);
  expect(items.every((i) => i.compound && i.amount === "35")).toBe(true);
});
test("politeness removal preserves repeated bets and actual unknown text", () => {
  const items = compiled(
    "先下二有龙蛇35米，再加一组龙蛇35米，刚才龙蛇那组也保留；然后三有鼠兔鸡各45，就这些。",
  );
  expect(items.map((i) => i.selections)).toEqual([
    [4, 5],
    [4, 5],
    [0, 3, 9],
  ]);
  blocked("先下二有龙蛇35米，临时特别要求");
  blocked("三有鼠兔鸡各45，照旧要求");
});
test("explicit previous candidate counts cannot contradict their reference", () => {
  compiled("三有复试鼠兔龙蛇马各35；四有复式还是这五肖各45");
  blocked("三有复试鼠兔龙蛇马各35；四有复式还是这六肖各45");
});
for (const raw of [
  "取消这张\n二有龙蛇35米",
  "三有鼠兔鸡各45，哦，是鼠兔狗各45",
  "转发旧单\n三有鼠兔鸡各45",
  "昨天那张照旧，二有龙蛇35米",
  "二有龙蛇35米，先别下",
])
  test(`instruction affecting financial intent remains reviewable: ${raw}`, () => {
    const rows = parseText(raw, plays);
    expect(rows[0].playId).toBe(0);
    expect(rows[0].source).toBe(raw);
    blocked(raw);
  });

test("field slashes before a Chinese multi-play label are not money", () => {
  const items = compiled(
    "每组35米／复式／鼠兔龙蛇马羊／四五有。\n每个尾数45元／2、8／平特尾中。",
  );
  expect(items.map((i) => i.amount)).toEqual(["35", "35", "45"]);
  expect(items[2].selections).toEqual([2, 8]);
});
