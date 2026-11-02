import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping } from "../../src/lib/types";
import { plays } from "./fixtures";
for (const prefix of [
  "二中二01 02待确认",
  "尾中3尾备注",
  "红波备注12",
  "红波待定",
  "平特笔记",
  "鼠牛待定",
  "01 02待定",
  "01待确认",
  "三中三01 02 03先留着",
])
  test("a financial first line cannot become a nickname: " + prefix, () => {
    const raw = prefix + "\n特码03各10";
    const rows = parseText(raw, plays);
    expect(rows.some((row) => row.source.includes(prefix))).toBe(true);
    expect(
      compileText(rows, plays, annualMapping(2026)).some((row) => row.error),
    ).toBe(true);
  });
test("an explicit ordinary nickname still leaves all following bets intact", () => {
  const raw = "张三1314\n特码03各10";
  const rows = parseText(raw, plays);
  const compiled = compileText(rows, plays, annualMapping(2026));
  expect(compiled.map((row) => row.error)).toEqual([""]);
  expect(compiled[0].items[0].selections).toEqual([3]);
});

test("edited selection bodies obey the same size boundary as original text", () => {
  const rows = parseText("特码01各10", plays);
  rows[0].body = "01" + " ".repeat(12000);
  expect(compileText(rows, plays, annualMapping(2026))[0].error).toContain(
    "过长",
  );
});
