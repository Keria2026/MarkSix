import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  parseText,
  compileRow,
  confirmedPreferences,
  playCandidates,
} from "../src/lib/text-entry";
import type { TextPreference } from "../src/lib/text-entry";
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

test("trained vocabulary suggestions never auto-bind an unconfirmed alias", () => {
  const row = parseText("一宵虎各20", plays)[0];
  expect(row.playId).toBe(0);
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
test("aliases require confirmation and expire with their bound rule version", () => {
  const raw = "二中特：牛拖龙各15元，三友牛龙羊260";
  expect(parseText(raw, plays).every((r) => r.playId === 0)).toBe(true);
  const rows = compile(raw);
  expect(rows.every((r) => !r.error)).toBe(true);
  expect(rows[0].items[0].drag).toEqual({
    left: [1],
    right: [4],
    zodiac: true,
  });
  expect(rows[1].items[0].selections).toEqual([1, 4, 7]);
  expect(
    parseText(
      raw,
      plays,
      habits.map((p) => ({ ...p, play_version: 0 })),
    ).every((r) => r.playId === 0),
  ).toBe(true);
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
    "牛中5000",
    "特码07各10照旧",
    "特码07各10*",
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
