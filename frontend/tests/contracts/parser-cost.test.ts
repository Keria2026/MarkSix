import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { normalizeLanguage } from "../../src/lib/text-entry/language";
import { annualMapping } from "../../src/lib/types";
import { plays } from "./fixtures";

for (const [name, raw] of [
  ["homophone", "未".repeat(12000)],
  ["unknown", "甲".repeat(12000)],
  ["numeric headings", "01\n".repeat(4000)],
  ["spaces after a quantity", "三" + " ".repeat(11999)],
  ["near-match compound", "三有".repeat(6000)],
] as const) {
  test(
    "bounded parsing of attack-sized " + name,
    () => {
      const started = performance.now();
      const rows = parseText(raw, plays);
      expect(
        rows.length === 0 ||
          compileText(rows, plays, annualMapping(2026)).some(
            (row) => row.error,
          ),
      ).toBe(true);
      // Deliberately generous: catches the observed minute-long synchronous freeze,
      // not scheduler noise. Scaling measurements are recorded by the campaign.
      expect(performance.now() - started).toBeLessThan(5000);
    },
    10000,
  );
}

test("compound suffixes preserve both successive clauses and source bounds", () => {
  const raw = "三有鼠牛虎兔都做复式；四有鼠牛虎兔龙都要复试";
  const normalized = normalizeLanguage(raw);
  expect(normalized.text).toBe("三有复式鼠牛虎兔；四有复式鼠牛虎兔龙");
  for (const span of normalized.spans) {
    expect(span.start).toBeGreaterThanOrEqual(0);
    expect(span.end).toBeLessThanOrEqual(raw.length);
    expect(span.end).toBeGreaterThan(span.start);
  }
});

test("normalization preserves repeated exact configured spellings within its resource bound", () => {
  const raw = "９".repeat(12000);
  const started = performance.now();
  const result = normalizeLanguage(raw, ["９", "９９"]);
  expect(result.text).toBe(raw);
  expect(result.spans).toHaveLength(raw.length);
  expect(performance.now() - started).toBeLessThan(5000);
}, 10000);
