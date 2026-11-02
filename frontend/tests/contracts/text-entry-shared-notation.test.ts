import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping, basicCount } from "../../src/lib/types";
import { plays } from "./fixtures";
const mapping = annualMapping(2026);
function result(raw: string) {
  const rows = parseText(raw, plays);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return { rows, compiled: compileText(rows, plays, mapping) };
}
function valid(raw: string) {
  const { compiled } = result(raw);
  expect(compiled.length).toBeGreaterThan(0);
  expect(compiled.map((r) => r.error)).toEqual(compiled.map(() => ""));
  return compiled.flatMap((r) => r.items);
}
for (const alias of ["复式", "复试", "复氏", "富士"])
  test(`compound spelling ${alias} keeps all pair bets`, () => {
    const items = valid(`03-15-27-39-44二中二${alias}各10`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      selections: [3, 15, 27, 39, 44],
      compound: true,
      amount: "10",
    });
    expect(
      basicCount(
        plays.find((p) => p.id === items[0].play_id)!.rule,
        items[0].selections,
        true,
      ),
    ).toBe(10);
  });
for (const sep of [".", "、", "，", "-", "—"])
  test(`a shared tail suffix expands every digit across ${sep}`, () => {
    const [item] = valid(`澳二中二：2${sep}8尾拖鼠各组20`);
    expect(item.drag).toEqual({
      left: [2, 12, 22, 32, 42, 8, 18, 28, 38, 48],
      right: [7, 19, 31, 43],
      zodiac: false,
    });
  });

test("mixed group punctuation and local totals preserve independent zodiac groups", () => {
  const source =
    "三有鼠牛虎。兔龙蛇 马羊猴 鸡狗猪 鼠龙猴 牛蛇鸡个组40共240\n鼠牛虎兔龙复试3.4.5有个组20，16组共320\n蛇马羊猴鸡复试3.4.5有个组10，16组共160\n总720";
  const items = valid(source);
  expect(items).toHaveLength(12);
  expect(items.slice(0, 6).map((i) => i.selections)).toEqual([
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [9, 10, 11],
    [0, 4, 8],
    [1, 5, 9],
  ]);
  expect(items.slice(6).map((i) => i.amount)).toEqual([
    "20",
    "20",
    "20",
    "10",
    "10",
    "10",
  ]);
  const wrong = result(source.replace("总720", "总800"));
  expect(wrong.compiled.at(-1)!.error).toContain("合计");
  expect(wrong.compiled.slice(0, -1).every((r) => !r.error)).toBe(true);
  expect(wrong.compiled.at(-1)!.items).toEqual([]);
});
test("shared notation retains incomplete groups, invalid selectors and unknown words for correction", () => {
  for (const raw of [
    "二中二03-15富士未知各10",
    "三有鼠牛。虎兔龙蛇各20",
    "二中二2.2尾拖鼠各20",
    "二中二10.8尾拖鼠各20",
    "总2000",
  ]) {
    expect(result(raw).compiled.some((r) => !!r.error)).toBe(true);
  }
});
