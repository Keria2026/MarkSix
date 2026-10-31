import { expect, test } from "bun:test";
import { parseText, compileText, compileRow } from "../../src/lib/text-entry";
import { annualMapping, basicCount } from "../../src/lib/types";
import { plays } from "./support";
const mapping = annualMapping(2026);
function compiled(raw: string) {
  const rows = parseText(raw, plays);
  const result = compileText(rows, plays, mapping);
  expect(result.map((r) => r.error)).toEqual(rows.map(() => ""));
  return result.flatMap((r) => r.items);
}
const cn = "一二三四五";
const options = "鼠牛虎兔龙蛇";
for (let size = 2; size <= 5; size++) {
  for (const spelling of [
    `${cn[size - 1]}有`,
    `${cn[size - 1]}友`,
    `${size}有`,
    `${size}连`,
    `${size}连肖`,
  ]) {
    for (const postfix of [false, true]) {
      test(`linked-zodiac spelling ${spelling}, postfix ${postfix}`, () => {
        const selection = options.slice(0, size);
        const items = compiled(
          postfix
            ? `${selection}${spelling}各80`
            : `${spelling}${selection}各80`,
        );
        expect(items).toHaveLength(1);
        expect(plays.find((p) => p.id === items[0].play_id)?.rule.name).toBe(
          `${cn[size - 1]}有`,
        );
        expect(items[0].selections).toEqual(
          Array.from({ length: size }, (_, i) => i),
        );
        expect(items[0].amount).toBe("80");
      });
    }
  }
}
for (const marker of ["复式", "复试", "付", "复"]) {
  for (const label of ["三四有", "34有", "3有4有"]) {
    test(`multiple linked plays: ${marker} ${label}`, () => {
      const items = compiled(`${options.slice(0, 5)}${marker}${label}每组40`);
      expect(
        items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
      ).toEqual(["三有", "四有"]);
      expect(items.map((i) => i.selections)).toEqual([
        [0, 1, 2, 3, 4],
        [0, 1, 2, 3, 4],
      ]);
      expect(items.every((i) => i.compound && i.amount === "40")).toBe(true);
      expect(
        items.map((i) =>
          basicCount(
            plays.find((p) => p.id === i.play_id)!.rule,
            i.selections,
            i.compound,
          ),
        ),
      ).toEqual([10, 5]);
    });
  }
}
test("same candidates with separately declared compound amounts remain editable rows", () => {
  const rows = parseText("鼠牛虎兔龙蛇复四有各40五有各70", plays);
  expect(rows).toHaveLength(2);
  let result = compileText(rows, plays, mapping);
  expect(result.map((r) => r.error)).toEqual(["", ""]);
  expect(result.map((r) => r.items[0].amount)).toEqual(["40", "70"]);
  rows[1].amount = "90";
  result = compileText(rows, plays, mapping);
  expect(result[1].items[0].amount).toBe("90");
});
test("consecutive exact-size groups preserve duplicate occurrences across groups", () => {
  const items = compiled("2连鼠牛鼠虎鼠兔各90；3连牛虎兔龙蛇马各60");
  expect(items.map((i) => i.selections)).toEqual([
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2, 3],
    [4, 5, 6],
  ]);
  expect(items.map((i) => i.amount)).toEqual(["90", "90", "90", "60", "60"]);
  for (const raw of ["2连鼠鼠牛虎各30", "3连鼠牛虎兔各30"]) {
    expect(
      compileText(parseText(raw, plays), plays, mapping).some((r) => r.error),
    ).toBe(true);
  }
});
test("summary validates unit count and exact money and never produces a bet", () => {
  const raw = "鼠牛虎兔龙复试345有各40\n16组共640";
  const rows = parseText(raw, plays);
  const items = compiled(raw);
  expect(rows).toHaveLength(4);
  expect(rows[3].summary).toBe(true);
  expect(items).toHaveLength(3);
  for (const wrong of ["15组共640", "16组共641", "16组共640.01"]) {
    rows[3].body = wrong;
    expect(compileText(rows, plays, mapping)[3].error).not.toBe("");
  }
  rows[3].excluded = true;
  expect(compileText(rows, plays, mapping).every((r) => !r.error)).toBe(true);
  rows[3].excluded = false;
  rows[3].body = "16组共640";
  rows[0].amount = "50";
  expect(compileText(rows, plays, mapping)[3].error).not.toBe("");
});
test("bare numbers, leading zeros and fixed two-digit chunks use confirmed conventions", () => {
  const items = compiled("017.28各30；09 1536各40；26.350");
  expect(items.map((i) => i.selections)).toEqual([[17, 28], [9, 15, 36], [26]]);
  expect(items.map((i) => i.amount)).toEqual(["30", "40", "350"]);
  expect(
    items.every(
      (i) => plays.find((p) => p.id === i.play_id)!.rule.name === "特码",
    ),
  ).toBe(true);
  for (const raw of ["123各40", "0150各40", "0000各40", "2323各40"])
    expect(
      compileText(parseText(raw, plays), plays, mapping).some((r) => r.error),
    ).toBe(true);
});
test("each-zodiac defaults to special packages and remains editable", () => {
  const rows = parseText("牛龙各肖80", plays);
  expect(rows[0].playId).toBe(plays.find((p) => p.rule.name === "特码")!.id);
  expect(rows[0].customAlias).toBe(true);
  rows[0].playId = plays.find((p) => p.rule.name === "一肖中")!.id;
  const single = compileRow(rows[0], plays, mapping);
  expect(single.error).toBe("");
  expect(single.items[0].selections).toEqual([1, 4]);
  rows[0].playId = plays.find((p) => p.rule.name === "特码")!.id;
  const pack = compileRow(rows[0], plays, mapping);
  expect(pack.error).toBe("");
  expect(pack.items[0].package_zodiacs).toEqual([1, 4]);
});
test("generic flat aliases, tail qualifiers, count target and special/regular split", () => {
  const items = compiled(
    "平龙600；平特4尾700；5肖亮800；鼠T90；28号特平各两百",
  );
  expect(
    items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["一肖中", "尾中", "五肖量", "特码", "特码", "平码"]);
  expect(items.map((i) => i.amount)).toEqual([
    "600",
    "700",
    "800",
    "90",
    "200",
    "200",
  ]);
  expect(items[2].selections).toEqual([5]);
  expect(items[3].package_zodiacs).toEqual([0]);
  expect(items.slice(-2).map((i) => i.selections)).toEqual([[28], [28]]);
});
test("headings are allowed only before the business text; unknown instructions stay visible", () => {
  const raw = "测试昵称\n新澳\n三有牛龙蛇各50";
  const rows = parseText(raw, plays);
  expect(rows[0].source).toBe(raw);
  expect(compileText(rows, plays, mapping)[0].error).toBe("");
  expect(
    compileText(
      parseText("三有牛龙蛇各50\n照旧要求", plays),
      plays,
      mapping,
    ).some((r) => r.error),
  ).toBe(true);
  for (const raw of ["4头不中700；三有牛龙蛇50", "单平900；一肖中牛600"]) {
    const rows = parseText(raw, plays);
    expect(rows).toHaveLength(2);
    const result = compileText(rows, plays, mapping);
    expect(result[0].error).not.toBe("");
    expect(result[1].error).toBe("");
  }
});
test("disabled or absent configured plays cannot be resurrected through dialects", () => {
  const disabled = plays.map((p) => ({
    ...p,
    enabled: p.rule.name !== "四有",
  }));
  const rows = parseText("牛虎龙蛇猴复34有各20", disabled);
  expect(compileText(rows, disabled, mapping).some((r) => r.error)).toBe(true);
});

test("inferred new kinds end inherited multi-play context", () => {
  const items = compiled("鼠牛虎兔龙复34有各30；4尾200；红波150");
  expect(
    items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["三有", "四有", "尾中", "波色"]);
  expect(items.slice(-2).map((i) => i.compound)).toEqual([false, false]);
});
