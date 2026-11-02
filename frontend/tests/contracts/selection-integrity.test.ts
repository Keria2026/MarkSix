import { expect, test } from "bun:test";
import { parseSelections } from "../../src/lib/selection";
import { dragPreview } from "../../src/lib/drag";
import { entryCents, annualMapping } from "../../src/lib/types";
import { plays } from "./fixtures";

for (const raw of [
  "-01",
  "−01",
  "－０１",
  "+01",
  "01-09",
  "01–09",
  "01—09",
  "01至09",
  "01×02",
  "￥01",
  "01%02",
  "01=02",
  "01🧧02",
])
  test(
    "manual selection never silently drops signed/range meaning: " + raw,
    () => {
      expect(() => parseSelections("number", raw)).toThrow();
      const rule = plays.find((play) => play.rule.name === "二中二")!.rule;
      expect(
        dragPreview(
          rule,
          { left: raw, right: "20 21", zodiac: false },
          annualMapping(2026),
        ).input,
      ).toBeNull();
    },
  );
for (const raw of ["01 01", "01、０１", "鼠 鼠", "1尾 1尾"])
  test("repeated manual choices need correction: " + raw, () => {
    const kind = raw.includes("鼠")
      ? "zodiac"
      : raw.includes("尾")
        ? "tail"
        : "number";
    expect(() => parseSelections(kind, raw)).toThrow();
  });
for (const value of ["90000000000000.1", "90000000000001", "9".repeat(12000)])
  test(
    "frontend money rejects amounts outside the server exact range: " +
      value.slice(0, 30),
    () => expect(entryCents(value)).toBeNull(),
  );
test("exact money boundary is retained without floating point", () => {
  expect(entryCents("90000000000000")).toBe(9_000_000_000_000_000n);
  expect(entryCents("0000.1")).toBe(10n);
});

test("oversized typed choices fail explicitly instead of accepting a truncated prefix", () => {
  const raw = "01" + " ".repeat(2047) + "02";
  expect(() => parseSelections("number", raw)).toThrow("过长");
});
