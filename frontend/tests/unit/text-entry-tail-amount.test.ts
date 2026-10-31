import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping, basicCount } from "../../src/lib/types";
import { plays } from "./support";
import { tokenize } from "../../src/lib/text-entry/lexer";
const mapping = annualMapping(2026);
function compile(raw: string, configured = plays) {
  const rows = parseText(raw, configured);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  const result = compileText(rows, configured, mapping);
  expect(result.map((r) => r.error)).toEqual(rows.map(() => ""));
  return result.flatMap((r) => r.items);
}
const special = plays.find((p) => p.rule.name === "特码")!;
test("each-number homophone expands zodiacs to special numbers at the stated per-number price", () => {
  const items = compile("牛个数70 马牛个数90 羊兔马牛个数90");
  expect(
    items.map((i) => [i.play_id, i.selections, i.amount, i.package_zodiacs]),
  ).toEqual([
    [special.id, [6, 18, 30, 42], "70", undefined],
    [special.id, [1, 6, 13, 18, 25, 30, 37, 42, 49], "90", undefined],
    [
      special.id,
      [1, 4, 6, 12, 13, 16, 18, 24, 25, 28, 30, 36, 37, 40, 42, 48, 49],
      "90",
      undefined,
    ],
  ]);
  expect(
    items.reduce(
      (n, i) =>
        n +
        basicCount(special.rule, i.selections, i.compound) * Number(i.amount),
      0,
    ),
  ).toBe(2620);
});
for (const marker of [
  "各数",
  "个数",
  "各个数",
  "個數",
  "各個數",
  "個数",
  "个 数",
  "个\n数",
]) {
  for (const raw of [
    `牛马${marker}七十`,
    `${marker}70 牛马`,
    `牛马${marker}７０元`,
  ]) {
    test(`each-number spelling retains its unit price and original span: ${raw}`, () => {
      const [item] = compile(raw);
      expect(item.play_id).toBe(special.id);
      expect(item.selections).toEqual([1, 6, 13, 18, 25, 30, 37, 42, 49]);
      expect(item.package_zodiacs).toBeUndefined();
      expect(item.amount).toBe("70");
    });
  }
}
test("amount aliases preserve explicit plays, per-zodiac packages and per-group meaning", () => {
  const items = compile(
    "一肖中牛马个数70；牛马个肖90；三有鼠牛虎个组40；二有牛马个30",
  );
  expect(
    items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["一肖中", "特码", "三有", "二有"]);
  expect(items[0].selections).toEqual([1, 6]);
  expect(items[1].package_zodiacs).toEqual([1, 6]);
  expect(items[2].selections).toEqual([0, 1, 2]);
  expect(items.map((i) => i.amount)).toEqual(["70", "90", "40", "30"]);
});
for (const separator of [" ", "\n", "；", "，"]) {
  test(`complete tail labels win over shorter linked-zodiac aliases: ${JSON.stringify(separator)}`, () => {
    const items = compile(`268三连尾80${separator}359三连尾60`);
    expect(
      items.map((i) => [
        plays.find((p) => p.id === i.play_id)!.rule.name,
        i.selections,
        i.amount,
        i.compound,
      ]),
    ).toEqual([
      ["三尾连", [2, 6, 8], "80", false],
      ["三尾连", [3, 5, 9], "60", false],
    ]);
  });
}
for (const [size, selection] of [
  [2, [0, 6]],
  [3, [2, 6, 8]],
  [4, [0, 2, 6, 8]],
] as const) {
  const cn = "一二三四"[size - 1];
  for (const label of [
    `${cn}连尾`,
    `${size}连尾`,
    `${cn}尾连`,
    `${size} 连 尾`,
    `${cn}連尾`,
  ]) {
    for (const body of [
      selection.join(""),
      selection.map((n) => "零一二三四五六七八九"[n]).join(""),
      selection.map((n) => `${n}尾`).join("、"),
    ]) {
      for (const raw of [`${label}${body}各70`, `${body}${label}七十元`]) {
        test(`tail quantity and digit lists compose with field positions: ${raw}`, () => {
          const items = compile(raw);
          expect(items).toHaveLength(1);
          expect(plays.find((p) => p.id === items[0].play_id)!.rule.name).toBe(
            `${cn}尾连`,
          );
          expect(items[0].selections).toEqual([...selection]);
          expect(items[0].amount).toBe("70");
        });
      }
    }
  }
}
test("compound tails and plain linked zodiacs remain distinct in a mixed-market slip", () => {
  const items = compile(
    "香港三连尾0268复式各70；澳门三连鼠牛虎各40；3連尾２６８各90",
  );
  expect(
    items.map((i) => [
      plays.find((p) => p.id === i.play_id)!.rule.name,
      i.market ?? "macau",
      i.selections,
      i.compound,
    ]),
  ).toEqual([
    ["三尾连", "hk", [0, 2, 6, 8], true],
    ["三有", "macau", [0, 1, 2], false],
    ["三尾连", "macau", [2, 6, 8], false],
  ]);
  expect(
    basicCount(
      plays.find((p) => p.id === items[0].play_id)!.rule,
      items[0].selections,
      true,
    ),
  ).toBe(4);
});
for (const raw of [
  "三连尾226各70",
  "三连尾26各70",
  "三连尾0268各70",
  "三连尾十各70",
  "三连尾268各70.55",
  "三连尾1000",
  "五连尾12345各70",
]) {
  test(`invalid or unavailable tail bets stay reviewable: ${raw}`, () => {
    const rows = parseText(raw, plays);
    expect(rows.length).toBeGreaterThan(0);
    expect(compileText(rows, plays, mapping).some((r) => r.error)).toBe(true);
    expect(
      rows.every(
        (r) => plays.find((p) => p.id === r.playId)?.rule.kind !== "zodiac",
      ),
    ).toBe(true);
  });
}
test("disabling a tail play cannot reinterpret its full alias as a zodiac play", () => {
  const configured = plays.map((p) => ({
    ...p,
    enabled: p.rule.name === "三尾连" ? false : p.enabled,
  }));
  const rows = parseText("268三连尾70", configured);
  expect(rows).toHaveLength(1);
  expect(rows[0].playId).toBe(0);
  expect(compileText(rows, configured, mapping)[0].error).toBeTruthy();
});
test("an explicit amount operator owns the entire following number", () => {
  const tokens = tokenize(
    "各2683连尾",
    plays.map((p) => p.rule.name),
  );
  expect(tokens.filter((t) => t.kind === "number").map((t) => t.text)).toEqual([
    "2683",
  ]);
  expect(tokens.some((t) => t.text === "3连尾")).toBe(false);
});
test("exact configured names retain priority over amount and tail aliases", () => {
  for (const name of ["个数", "三连尾"]) {
    const custom = { ...special, id: 999, rule: { ...special.rule, name } };
    const [item] = compile(`${name}12各70`, [...plays, custom]);
    expect(item.play_id).toBe(999);
    expect(item.selections).toEqual([12]);
    expect(item.amount).toBe("70");
  }
});
