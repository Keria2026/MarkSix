import { test, expect } from "bun:test";
import {
  parseText,
  compileRow,
  confirmedPreferences,
} from "../../src/lib/text-entry";
import { annualMapping } from "../../src/lib/types";
import { clipboardRows } from "../../src/lib/text-entry/clipboard";
import { plays } from "./support";
const mapping = annualMapping(2026);
const cases: [string, string, number[], string][] = [
  ["尾中0尾各100", "尾中", [0], "100"],
  ["3尾5000", "尾中", [3], "5000"],
  ["4尾500", "尾中", [4], "500"],
  ["红波100", "波色", [0], "100"],
  ["藍波各500斤", "波色", [1], "500"],
  ["绿100米", "波色", [2], "100"],
  ["牛中5000", "一肖中", [1], "5000"],
  ["澳 一肖中：嗎下100", "一肖中", [6], "100"],
  ["新澳门平特一肖：龍各100元", "一肖中", [4], "100"],
  ["二中特【01 07}各100", "二中二含特", [1, 7], "100"],
  [
    "八不中{01 02 03 04 05 06 07 08]各100",
    "八不中",
    [1, 2, 3, 4, 5, 6, 7, 8],
    "100",
  ],
  ["二尾连3尾4尾各100", "二尾连", [3, 4], "100"],
  ["特码45倍：07/100", "特码45倍", [7], "100"],
  ["特：07各0.1", "特码", [7], "0.1"],
];
for (const [raw, name, objects, amount] of cases)
  test(`semantic record: ${raw}`, () => {
    const rows = parseText(raw, plays);
    expect(rows).toHaveLength(1);
    const p = plays.find((p) => p.id === rows[0].playId)!;
    expect(p?.rule.name).toBe(name);
    const compiled = compileRow(rows[0], plays, mapping);
    expect(compiled.error).toBe("");
    expect(compiled.items).toHaveLength(1);
    expect(compiled.items[0].selections).toEqual(objects);
    expect(compiled.items[0].amount).toBe(amount);
  });
test("completed rows inherit context; decoration does not become a financial row", () => {
  const rows = parseText("* 尾中0尾各100；3尾5000、4尾500。红波100 ***", plays);
  expect(rows).toHaveLength(4);
  expect(parseText("***", plays)).toEqual([]);
  expect(compileRow(rows[0], plays, mapping).error).not.toBe("");
  for (const row of rows.slice(1))
    expect(compileRow(row, plays, mapping).error).toBe("");
});
test("compound and drag preserve grouping", () => {
  const rows = parseText("另复三有 牛狗马猪 各注600", plays);
  const c = compileRow(rows[0], plays, mapping);
  expect(rows).toHaveLength(1);
  expect(c.error).toBe("");
  expect(c.items[0].compound).toBe(true);
  expect(c.items[0].selections).toEqual([1, 10, 6, 11]);
  const drag = parseText("二中二 01托02 03各100", plays);
  const d = compileRow(drag[0], plays, mapping);
  expect(d.error).toBe("");
  expect(d.items[0].drag).toEqual({ left: [1], right: [2, 3], zodiac: false });
});
for (const raw of [
  "尾中10尾各100",
  "特码01 01各100",
  "特码0102各100",
  "二中二{01 02各100",
  "二中二【】各100",
  "二中二{01{02}}各100",
  "特码01各0",
  "特码01各1.01",
  "二有牛狗马各100",
])
  test(`reject unsafe input: ${raw}`, () => {
    const rows = parseText(raw, plays);
    expect(rows.some((r) => !!compileRow(r, plays, mapping).error)).toBe(true);
  });
test("inference does not choose between competing enabled plays", () => {
  const duplicate = {
    ...plays.find((p) => p.rule.name === "波色")!,
    id: 100,
    rule: {
      ...plays.find((p) => p.rule.name === "波色")!.rule,
      name: "另一波色",
    },
  };
  expect(parseText("红波100", [...plays, duplicate])[0].playId).toBe(0);
  for (const raw of ["牛500", "07各100"])
    expect(parseText(raw, plays)[0].playId).toBe(0);
});
test("current exact name wins over a learned alias, disabled and stale bindings are ignored", () => {
  const selected = plays.find((p) => p.rule.name === "特码45倍")!;
  const habit = {
    alias: "特码",
    play_id: selected.id,
    play_version: 1,
    amount_mode: "each" as const,
  };
  expect(parseText("特码07各100", plays, [habit])[0].playId).toBe(
    plays.find((p) => p.rule.name === "特码")!.id,
  );
  expect(
    parseText("自用07各100", plays, [
      { ...habit, alias: "自用", play_version: 2 },
    ])[0].playId,
  ).toBe(0);
  const disabled = plays.map((p) => ({ ...p, enabled: p.id !== selected.id }));
  expect(
    parseText("自用07各100", disabled, [{ ...habit, alias: "自用" }])[0].playId,
  ).toBe(0);
});
test("contradictory alias learning is omitted", () => {
  const rows = parseText("特码01各100；特码45倍02各100", plays);
  rows[1].playLabel = rows[0].playLabel;
  expect(confirmedPreferences(rows, plays)).toEqual([]);
});
test("clipboard relevance needs objects and valid money", () => {
  for (const raw of ["普通聊天内容", "尾中0尾", "波色", "", "特码07各0"])
    expect(clipboardRows(raw, plays, [])).toBeNull();
  expect(clipboardRows("4尾500", plays, [])).not.toBeNull();
  expect(() => parseText("牛".repeat(12001), plays)).toThrow();
});
