import { expect, test } from "bun:test";
import { parseSelections } from "../../src/lib/selection";
import { dragPreview } from "../../src/lib/drag";
import { entryCents, annualMapping } from "../../src/lib/types";
import { plays } from "./fixtures";

for (const raw of [
  "+01",
  "01至09",
  "01×02",
  "￥01",
  "01%02",
  "01=02",
  "01🧧02",
])
  test("manual selection retains unsupported operators: " + raw, () => {
    expect(() => parseSelections("number", raw)).toThrow();
    const rule = plays.find((play) => play.rule.name === "二中二")!.rule;
    expect(
      dragPreview(
        rule,
        { left: raw, right: "20 21", zodiac: false },
        annualMapping(2026),
      ).input,
    ).toBeNull();
  });
for (const [kind, raw, expected] of [
  ["number", "01 01", [1, 1]],
  ["number", "01、０１", [1, 1]],
  ["zodiac", "鼠 鼠", [0, 0]],
  ["tail", "1尾 1尾", [1, 1]],
] as const)
  test("repeated manual choices retain each occurrence: " + raw, () => {
    expect(parseSelections(kind, raw)).toEqual([...expected]);
  });
for (const delimiter of ["-", "－", "−", "‐", "‑", "‒", "–", "—", "―"])
  test(
    "hyphens enumerate selections without expanding ranges: " + delimiter,
    () => {
      expect(parseSelections("number", `01${delimiter}09`)).toEqual([1, 9]);
      expect(
        parseSelections(
          "number",
          `1${delimiter}2${delimiter}3${delimiter}4${delimiter}5${delimiter}6`,
        ),
      ).toEqual([1, 2, 3, 4, 5, 6]);
      expect(parseSelections("number", `${delimiter}01`)).toEqual([1]);
    },
  );
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
