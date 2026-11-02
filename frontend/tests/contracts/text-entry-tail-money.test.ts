import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping, basicCount, entryCents } from "../../src/lib/types";
import { plays } from "./fixtures";
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
  ).toEqual(["一肖中", "一肖中", "三有", "二有"]);
  expect(items[0].selections).toEqual([1, 6]);
  expect(items[1].selections).toEqual([1, 6]);
  expect(items[1].package_zodiacs).toBeUndefined();
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

for (const prefix of ["个", "個", "各", "各个", "各個", "每个", "每個", "每"]) {
  for (const noun of ["数字", "數字", "号码", "號碼"]) {
    const marker = prefix + noun;
    test(`complete each-number wording keeps every selection and unit price: ${marker}`, () => {
      const numbers = [3, 15, 27, 39, 4, 16, 28];
      for (const raw of [
        `${numbers.join("-")} ${marker}60`,
        `${marker}60 ${numbers.join("、")}`,
        `${numbers.join(".")}${marker}六十元`,
        `${numbers.join("－")}${marker}６０.０元`,
      ]) {
        const items = compile(raw);
        expect(items).toHaveLength(1);
        const [item] = items;
        expect(item.play_id).toBe(special.id);
        expect(item.selections).toEqual(numbers);
        expect(item.amount).toBe("60");
        expect(item.package_zodiacs).toBeUndefined();
        expect(basicCount(special.rule, item.selections, item.compound)).toBe(
          7,
        );
        expect(entryCents(item.amount)! * 7n).toBe(42000n);
      }
    });
  }
}
test("each-number wording preserves markets, inherited plays and repeated bets", () => {
  const items = compile(
    "香港平码03-15-03个数字60；27-39每個數字12.5\n5注共205",
  );
  expect(items).toHaveLength(2);
  const regular = plays.find((p) => p.rule.name === "平码")!;
  expect(
    items.map((i) => [i.market, i.play_id, i.amount, i.selections]),
  ).toEqual([
    ["hk", regular.id, "60", [3, 15, 3]],
    ["hk", regular.id, "12.5", [27, 39]],
  ]);
  expect(compile("二中二复式03-15-27各个数字60")[0]).toMatchObject({
    compound: true,
    selections: [3, 15, 27],
    amount: "60",
  });
  expect(compile("一肖中鼠牛每個數字60")[0].selections).toEqual([0, 1]);
});
test("spaced each-number phrases remain complete tokens with original source spans", () => {
  const items = compile("03-15-27 个 数 字 60元");
  expect(items).toHaveLength(1);
  expect(items[0].selections).toEqual([3, 15, 27]);
  expect(items[0].amount).toBe("60");
  const raw = "個數字６０";
  const tokens = tokenize(raw, []);
  expect(
    tokens.map((t) => [t.kind, t.text, raw.slice(t.start, t.end)]),
  ).toEqual([
    ["amount", "各数", "個數字"],
    ["number", "60", "６０"],
  ]);
});
test("new amount phrases retain exact configured play names", () => {
  for (const name of [
    "个数字",
    "各数字",
    "每个数字",
    "个号码",
    "每个号码",
    "每号",
  ]) {
    const custom = { ...special, id: 999, rule: { ...special.rule, name } };
    const items = compile(`${name}03各60`, [...plays, custom]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      play_id: 999,
      selections: [3],
      amount: "60",
    });
  }
});
test("each-number wording cannot erase unknown text or invent an amount", () => {
  for (const raw of [
    "03-15个数字备注60",
    "03-15每个数字",
    "03-15个数字0",
    "03-15个数字-60",
    "03-15个数字1.01",
    "03-15个数字60未知要求",
    "03-15个数值60",
    "03-15个数宇60",
    "03-15数字60",
  ]) {
    const rows = parseText(raw, plays);
    expect(rows.length).toBeGreaterThan(0);
    expect(compileText(rows, plays, mapping).some((r) => !!r.error)).toBe(true);
  }
});
