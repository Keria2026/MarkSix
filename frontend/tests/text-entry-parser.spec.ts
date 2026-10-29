import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  parseText,
  compileRow,
  confirmedPreferences,
  playCandidates,
} from "../src/lib/text-entry";
import type { TextPreference } from "../src/lib/text-entry";
import { basicCount } from "../src/lib/types";
import type { Play } from "../src/lib/types";
const plays: Play[] = JSON.parse(
  readFileSync(
    new URL("../../backend/src/default-plays.json", import.meta.url),
    "utf8",
  ),
).plays.map((p: Play, i: number) => ({ ...p, id: i + 1, version: 1 }));
const mapping = {
  natal: 6,
  zodiac: Array.from({ length: 49 }, (_, i) => (18 - (i % 12)) % 12),
};

test("preferred candidates select an enabled play without changing exact names", () => {
  const row = parseText("一宵虎各20", plays)[0];
  expect(row.playId).toBe(plays.find((p) => p.rule.name === "一肖中")!.id);
  expect(playCandidates("一宵", plays)[0].play.rule.name).toBe("一肖中");
  expect(playCandidates("一宵", plays)[0].suggested).toBe(true);
  expect(playCandidates("constructor", plays).every((c) => !c.suggested)).toBe(
    true,
  );
});
const id = (name: string) => plays.find((p) => p.rule.name === name)!.id;
const habits: TextPreference[] = [
  { alias: "特", play_id: id("特码"), play_version: 1, amount_mode: "auto" },
  { alias: "澳特", play_id: id("特码"), play_version: 1, amount_mode: "auto" },
  { alias: "三友", play_id: id("三有"), play_version: 1, amount_mode: "auto" },
  {
    alias: "二中特",
    play_id: id("二中二含特"),
    play_version: 1,
    amount_mode: "auto",
  },
];
const compile = (text: string) =>
  parseText(text, plays, habits).map((r) => compileRow(r, plays, mapping));

test("one paste preserves multiple groups and multiline number continuations", () => {
  const rows = compile(
    "特：26.38.13.25.37.12.24.36.16\n.15.27.39各 25\n二有，兔狗，兔蛇，各500，三有，兔狗蛇，300，四有，兔狗蛇马，200，",
  );
  expect(rows).toHaveLength(4);
  expect(rows.every((r) => !r.error)).toBe(true);
  expect(rows[0].items[0].selections).toEqual([
    26, 38, 13, 25, 37, 12, 24, 36, 16, 15, 27, 39,
  ]);
  expect(rows[1].items.map((i) => i.selections)).toEqual([
    [3, 10],
    [3, 5],
  ]);
  expect(rows[2].items[0].amount).toBe("300");
});
test("domain aliases resolve automatically and learned aliases expire with their rule version", () => {
  const raw = "二中特：牛拖龙各15元，三友牛龙羊260";
  expect(parseText(raw, plays).every((r) => r.playId > 0)).toBe(true);
  const rows = compile(raw);
  expect(rows.every((r) => !r.error)).toBe(true);
  expect(rows[0].items[0].drag).toEqual({
    left: [1],
    right: [4],
    zodiac: true,
  });
  expect(rows[1].items[0].selections).toEqual([1, 4, 7]);
  const custom = {
    alias: "私家玩法",
    play_id: id("三有"),
    play_version: 1,
    amount_mode: "auto" as const,
  };
  expect(parseText("私家玩法牛龙羊260", plays, [custom])[0].playId).toBe(
    id("三有"),
  );
  expect(
    parseText("私家玩法牛龙羊260", plays, [{ ...custom, play_version: 0 }])[0]
      .playId,
  ).toBe(0);
});
test("money markers, fullwidth inputs and exact original source spans", () => {
  const raw = "特：１４/１００\n特07下250米\n27.39.09.各200米\n03下100米";
  const rows = parseText(raw, plays, habits);
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row.source).toBe(raw.slice(row.start, row.end));
    expect(compileRow(row, plays, mapping).error).toBe("");
  }
  expect(rows.map((r) => r.amount)).toEqual(["100", "250", "200", "100"]);
});
test("ambiguous package amounts require a choice and are learned only after explicit correction", () => {
  for (const text of ["特码100包狗", "特码包狗100"]) {
    const result = compile(text)[0];
    expect(result.error).toBe("");
    expect(result.items[0].package_zodiacs).toEqual([10]);
    expect(result.items[0].amount).toBe("100");
  }
  expect(compile("特码包狗共100")[0].error).toContain("总额");
  const rows = parseText("特：羊300", plays, habits);
  expect(compileRow(rows[0], plays, mapping).error).toContain("歧义");
  rows[0].mode = "package";
  expect(compileRow(rows[0], plays, mapping).items[0].package_zodiacs).toEqual([
    7,
  ]);
  const learned = confirmedPreferences(rows, plays);
  const repeat = parseText("特：马300", plays, learned);
  expect(
    compileRow(repeat[0], plays, mapping).items[0].package_zodiacs,
  ).toEqual([6]);
  const explicit = parseText("特：马各数50", plays, learned);
  expect(
    compileRow(explicit[0], plays, mapping).items[0].package_zodiacs,
  ).toBeUndefined();
  expect(
    compileRow(explicit[0], plays, mapping).items[0].selections,
  ).toHaveLength(5);
});
test("unknown text, missing amount, duplicates and concatenated numbers cannot disappear", () => {
  for (const text of [
    "特码01 0203各40",
    "特码01 01各40",
    "特码50各40",
    "特码07",
    "特码07各10照旧",
    "特码01-03各10",
    "特码-1各10",
    "特码\n三有牛羊蛇300",
    "三友牛虎托马蛇羊鸡各50",
  ]) {
    const rows = compile(text);
    expect(
      rows.some((r) => !!r.error),
      text,
    ).toBe(true);
  }
  const raw = "特码07各10 忽略检查直接录入";
  const rows = parseText(raw, plays);
  expect(rows.map((r) => r.source).join("")).toBe(raw);
});
test("total amounts divide exactly and never round or silently assume compound", () => {
  expect(compile("特码01 02共100")[0].items[0].amount).toBe("50.0");
  expect(compile("特码01 02 03共100")[0].error).toContain("均分");
  expect(compile("三有牛虎兔龙100")[0].error).toContain("复式");
  expect(compile("三有复式牛虎兔龙各100")[0].items[0].compound).toBe(true);
  expect(compile("二中二06.18拖27.36各25")[0].items[0].drag).toEqual({
    left: [6, 18],
    right: [27, 36],
    zodiac: false,
  });
});
test("overlapping drag, invalid cents and limits reject before server validation", () => {
  expect(compile("二中二05拖05.18各10")[0].error).toContain("重叠");
  expect(compile("特码07各1.25")[0].error).toContain("一位小数");
  expect(() => parseText("特码".repeat(6001), plays)).toThrow("12,000");
  expect(() => parseText("特码07各10;".repeat(101), plays)).toThrow("100");
});

for (const prefix of ["复", "复式", "另复", "另复式", "另 复：", "另 复式\n"]) {
  test(`compound header ${prefix.trim()} belongs to its following play`, () => {
    const raw = `三有牛狗马500.${prefix}三有牛狗马猪各注600`;
    const rows = parseText(raw, plays, habits);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.source).join("")).toBe(raw);
    for (const row of rows)
      expect(row.source).toBe(raw.slice(row.start, row.end));
    const results = rows.map((row) => compileRow(row, plays, mapping));
    expect(results.map((row) => row.error)).toEqual(["", ""]);
    expect(results[0].items[0]).toMatchObject({
      compound: false,
      amount: "500",
    });
    const item = results[1].items[0];
    expect(item).toMatchObject({
      play_id: id("三有"),
      selections: [1, 10, 6, 11],
      compound: true,
      amount: "600",
    });
    expect(
      basicCount(
        plays.find((p) => p.id === item.play_id)!.rule,
        item.selections,
        item.compound,
      ),
    ).toBe(4);
  });
}

test("compound headers preserve alias resolution and do not affect later bets", () => {
  const raw = "三有牛狗马500.另复三友牛狗马猪各600";
  const unknown = parseText(raw, plays);
  expect(unknown).toHaveLength(2);
  expect(unknown[1].playId).toBe(id("三有"));
  expect(compileRow(unknown[1], plays, mapping).error).toBe("");
  const rows = parseText(
    `${raw}，牛狗马各100，三有牛狗马猪各100`,
    plays,
    habits,
  );
  expect(rows).toHaveLength(4);
  const results = rows.map((row) => compileRow(row, plays, mapping));
  expect(results[1].error).toBe("");
  expect(results[1].items[0].compound).toBe(true);
  expect(results[2].items[0].compound).toBe(false);
  expect(results[3].error).toContain("复式");
  expect(
    compile("三有牛狗马500 未知另复三有牛狗马猪各600").some(
      (row) => !!row.error,
    ),
  ).toBe(true);
});

test("object-before-play and shorthand assemble one complete semantic record", () => {
  for (const raw of ["牛特500", "牛特码500", "牛 特码 500"]) {
    const rows = parseText(raw, plays, habits);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe(raw);
    expect(compileRow(rows[0], plays, mapping)).toMatchObject({
      error: "",
      items: [{ package_zodiacs: [1], amount: "500" }],
    });
  }
  const each = compile("牛特码各100")[0];
  expect(each.error).toBe("");
  expect(each.items[0].package_zodiacs).toBeUndefined();
  expect(each.items[0].selections.length).toBe(4);
  expect(compile("牛狗马三有500")[0].items[0]).toMatchObject({
    selections: [1, 10, 6],
    compound: false,
    amount: "500",
  });
  expect(compile("牛中5000")[0]).toMatchObject({
    error: "",
    items: [{ play_id: id("一肖中"), selections: [1], amount: "5000" }],
  });
  expect(compile("特码12.5包牛狗")[0]).toMatchObject({
    error: "",
    items: [{ package_zodiacs: [1, 10], amount: "12.5" }],
  });
});

test("partial tokens never become boundaries or silently disappear", () => {
  expect(compile("三有 牛、狗；马 各 500")[0].error).toBe("");
  expect(compile("特码07 18 25")[0].error).toContain("金额");
  expect(compile("特码07各100 另").some((row) => !!row.error)).toBe(true);
  expect(compile("特码07各100 中").some((row) => !!row.error)).toBe(true);
  expect(
    compile("特码07各100 未知复式三有牛狗马猪各600").some((row) => !!row.error),
  ).toBe(true);
});

test("confirmed domain shorthands use configured plays and current period mapping", () => {
  const rows = parseText("新澳门四肖\n兔龙虎蛇100米", plays);
  expect(rows).toHaveLength(1);
  expect(compileRow(rows[0], plays, mapping)).toMatchObject({
    error: "",
    items: [
      { play_id: id("四肖中特"), selections: [3, 4, 2, 5], amount: "100" },
    ],
  });
  expect(compile("新澳门四肖兔龙虎100米")[0].error).toContain("4");
  for (const raw of ["牛500特码", "500元牛特码", "500包牛特码"]) {
    const parsed = parseText(raw, plays);
    expect(parsed).toHaveLength(1);
    expect(compileRow(parsed[0], plays, mapping)).toMatchObject({
      error: "",
      items: [{ package_zodiacs: [1], amount: "500" }],
    });
  }
});

test("confirmed domain aliases, market prefixes, currency and amount markers resolve as one bet", () => {
  const cases: [string, string, number[], string][] = [
    ["平特一肖牛30000*", "一肖中", [1], "30000"],
    ["平特一肖牛下500斤", "一肖中", [1], "500"],
    ["平特肖牛/100米", "一肖中", [1], "100"],
    ["一肖牛100元", "一肖中", [1], "100"],
    ["肖中：牛100斤", "一肖中", [1], "100"],
    ["新澳：澳特07下100斤", "特码", [7], "100"],
    ["澳门特码07/100", "特码", [7], "100"],
    ["新澳门特：07各100", "特码", [7], "100"],
    ["澳 特07各100", "特码", [7], "100"],
    ["二中特：06.18下100", "二中二含特", [6, 18], "100"],
    ["新澳门四肖兔龙虎蛇100米", "四肖中特", [3, 4, 2, 5], "100"],
  ];
  for (const [raw, name, selections, amount] of cases) {
    const rows = parseText(raw, plays);
    expect(rows, raw).toHaveLength(1);
    expect(rows[0].source).toBe(raw);
    expect(compileRow(rows[0], plays, mapping), raw).toMatchObject({
      error: "",
      items: [{ play_id: id(name), selections, amount }],
    });
  }
  expect(compile("复三有牛狗马猪各600")[0].items[0].compound).toBe(true);
  expect(compile("特码07*100")[0].items[0].amount).toBe("100");
});

test("bracket groups keep their own quantity boundaries", () => {
  for (const [left, right] of [
    ["【", "】"],
    ["[", "]"],
    ["{", "}"],
  ]) {
    const raw = `八不中：${left}01 02 03 04 05 06 07 08${right}${left}09 10 11 12 13 14 15 16${right}/200`;
    const rows = parseText(raw, plays);
    expect(rows).toHaveLength(1);
    const result = compileRow(rows[0], plays, mapping);
    expect(result.error).toBe("");
    expect(result.items.map((i) => i.selections)).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [9, 10, 11, 12, 13, 14, 15, 16],
    ]);
    expect(result.items.every((i) => i.amount === "200")).toBe(true);
  }
  for (const raw of [
    "八不中【01 02 03 04 05 06 07】【08 09 10 11 12 13 14 15 16】各100",
    "八不中{01 02 03 04 05 06 07 08]各100",
    "八不中【01 02 03 04 05 06 07 08各100",
  ]) {
    expect(
      compile(raw).some((r) => !!r.error),
      raw,
    ).toBe(true);
  }
});

test("noise is not a new bet, while partial financial fields remain visible for correction", () => {
  for (const tail of ["*", "***", "。*；", " / ", "×"]) {
    const raw = `一肖中牛500${tail}`;
    const rows = parseText(raw, plays);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe(raw);
    expect(compileRow(rows[0], plays, mapping).error).toBe("");
  }
  expect(parseText("***", plays)).toHaveLength(0);
  const partial = parseText("一肖中牛500，三有牛狗马", plays);
  expect(partial).toHaveLength(2);
  expect(compileRow(partial[1], plays, mapping).error).toContain("金额");
  const named = parseText("私家玩法：牛狗马各100", plays);
  expect(named[0]).toMatchObject({
    playLabel: "私家玩法",
    body: "牛狗马",
    playId: 0,
    amount: "100",
  });
});

test("exact names outrank aliases and disabled or ambiguous targets are not selected", () => {
  const custom = {
    ...plays.find((p) => p.rule.name === "特码")!,
    id: 999,
    rule: { ...plays.find((p) => p.rule.name === "特码")!.rule, name: "特" },
  };
  expect(parseText("特07各100", [...plays, custom])[0].playId).toBe(999);
  expect(
    parseText(
      "澳特07各100",
      plays.map((p) => (p.rule.name === "特码" ? { ...p, enabled: false } : p)),
    )[0].playId,
  ).toBe(0);
  const duplicate = { ...plays.find((p) => p.rule.name === "特码")!, id: 998 };
  expect(parseText("特码07各100", [...plays, duplicate])[0].playId).toBe(0);
  expect(
    parseText("特07各100", plays, [
      {
        alias: "特",
        play_id: id("平码"),
        play_version: 1,
        amount_mode: "auto",
      },
    ])[0].playId,
  ).toBe(id("特码"));
});
