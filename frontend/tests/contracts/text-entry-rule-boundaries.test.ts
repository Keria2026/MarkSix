import { expect, test } from "bun:test";
import {
  parseText,
  compileText,
  type TextPreference,
} from "../../src/lib/text-entry";
import { annualMapping, type Play } from "../../src/lib/types";
import {
  boundaryFamilies,
  ruleBoundaryCases,
} from "../model/text-rule-boundaries";
import {
  canonical,
  price,
  type ReferenceLine,
} from "../model/financial-oracle";
import { plays } from "./fixtures";

const records = [...ruleBoundaryCases(80173, boundaryFamilies.length * 24)];
for (const family of boundaryFamilies) {
  test(`rule interaction independently preserves amounts, options, markets and source: ${family}`, () => {
    const cases = records.filter((record) => record.family === family);
    expect(cases).toHaveLength(24);
    for (const record of cases) {
      const rows = parseText(record.raw, plays);
      const compiled = compileText(
        rows,
        plays,
        record.mappings.macau,
        record.mappings.hk,
      );
      const ready =
        rows.length > 0 &&
        compiled.every((row) => !row.error) &&
        compiled.some((row) => row.items.length > 0);
      expect({ raw: record.raw, ready }).toEqual({
        raw: record.raw,
        ready: record.accept,
      });
      expect(rows.length).toBeGreaterThan(0);
      let end = 0;
      for (const row of rows) {
        expect(row.source).toBe(record.raw.slice(row.start, row.end));
        expect(row.start).toBeLessThanOrEqual(end);
        end = Math.max(end, row.end);
      }
      expect(end).toBe(record.raw.length);
      if (!record.accept) continue;
      const actual: ReferenceLine[] = compiled
        .flatMap((row) => row.items)
        .map((item) => ({
          ...item,
          market: item.market ?? "macau",
          play: plays.find((play) => play.id === item.play_id)!.rule.name,
        }));
      expect(
        canonical(
          price(
            actual,
            plays.map((play) => play.rule),
            record.mappings,
          ),
        ),
      ).toBe(
        canonical(
          price(
            record.lines,
            plays.map((play) => play.rule),
            record.mappings,
          ),
        ),
      );
    }
  });
}

for (const name of ["特碼", "貳中特", "個數", "各买"]) {
  test(`exact personal rule ${name} retains its own version and rates before normalization`, () => {
    const custom: Play = {
      ...plays.find((play) => play.rule.name === "特码")!,
      id: 900,
      version: 7,
      rule: {
        ...plays.find((play) => play.rule.name === "特码")!.rule,
        name,
        odds: "99",
        rebate_percent: "8",
      },
    };
    const raw = `${name}03各20`;
    const rows = parseText(raw, [...plays, custom]);
    const compiled = compileText(rows, [...plays, custom], annualMapping(2026));
    expect(compiled.map((row) => row.error)).toEqual([""]);
    expect(compiled[0].items[0]).toMatchObject({
      play_id: 900,
      play_version: 7,
      selections: [3],
      amount: "20",
    });
    expect(rows[0].source).toBe(raw);
    const ambiguous = compileText(
      parseText(raw, [...plays, custom, { ...custom, id: 901 }]),
      [...plays, custom, { ...custom, id: 901 }],
      annualMapping(2026),
    );
    expect(ambiguous.some((row) => !!row.error)).toBe(true);
  });
}

test("only current personal aliases protect exact spelling", () => {
  const alias: TextPreference = {
    alias: "特碼",
    play_id: 2,
    play_version: 1,
    amount_mode: "each",
  };
  const raw = "特碼03各20";
  const rows = parseText(raw, plays, [alias]);
  expect(rows[0].playLabel).toBe("特碼");
  const stale = parseText(raw, plays, [{ ...alias, play_version: 0 }]);
  expect(stale[0].playLabel).toBe("特码");
  expect(compileText(rows, plays, annualMapping(2026))[0].items[0].amount).toBe(
    "20",
  );
});

test("the rule matrix is deterministic without using parsed output as labels", () => {
  expect([...ruleBoundaryCases(80173, boundaryFamilies.length)]).toEqual(
    records.slice(0, boundaryFamilies.length),
  );
  expect(new Set(records.map((record) => record.family)).size).toBe(
    boundaryFamilies.length,
  );
});

for (const heading of [
  "上期同上",
  "上一期",
  "明天那张",
  "上次照抄",
  "昨晚那张",
  "前天",
  "下期",
  "下一期",
]) {
  test(`historical or future heading ${heading} remains an explicit review of the whole source`, () => {
    const raw = heading + "\n特码03各20";
    const rows = parseText(raw, plays);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      playId: 0,
      source: raw,
      start: 0,
      end: raw.length,
    });
    expect(compileText(rows, plays, annualMapping(2026))[0].error).not.toBe("");
  });
}
