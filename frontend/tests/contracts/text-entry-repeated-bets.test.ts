import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import {
  annualMapping,
  basicCount,
  entryCents,
  selectionBoundary,
} from "../../src/lib/types";
import { parseSelections } from "../../src/lib/selection";
import { price, totals } from "../model/financial-oracle";
import { plays } from "./fixtures";
const mapping = annualMapping(2026);
function compile(raw: string) {
  const rows = parseText(raw, plays);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  const result = compileText(rows, plays, mapping);
  expect(result.length).toBeGreaterThan(0);
  expect(result.map((row) => row.error)).toEqual(result.map(() => ""));
  return result.flatMap((row) => row.items);
}
test("each repeated number remains a separate basic bet and participates in totals", () => {
  const numbers = [9, 21, 33, 45, 39, 10, 46, 14, 9, 45, 14, 9, 7, 33, 34];
  for (const separator of [".", "、", "-", "－", "—", " "]) {
    const items = compile(numbers.join(separator) + "各100\n15注共1500");
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.selections).toEqual(numbers);
    const rule = plays.find((play) => play.id === item.play_id)!.rule;
    expect(basicCount(rule, item.selections, false)).toBe(15);
    expect(entryCents(item.amount)! * 15n).toBe(150000n);
    expect(selectionBoundary(rule, item.selections, false)).toBeNull();
  }
});
test("hyphens delimit explicit numbers in all number plays without creating ranges", () => {
  for (const separator of ["-", "－", "−", "‐", "‑", "‒", "–", "—", "―"]) {
    expect(compile(`特码01${separator}09各20`)[0].selections).toEqual([1, 9]);
    expect(
      compile(`三中三1${separator}2${separator}3各组20`)[0].selections,
    ).toEqual([1, 2, 3]);
    const [item] = compile(
      `二中二复式1${separator}2${separator}3${separator}4各组20`,
    );
    expect(item.selections).toEqual([1, 2, 3, 4]);
    expect(
      basicCount(
        plays.find((p) => p.id === item.play_id)!.rule,
        item.selections,
        true,
      ),
    ).toBe(6);
    expect(compile(`二中二1${separator}2拖3${separator}4各20`)[0].drag).toEqual(
      { left: [1, 2], right: [3, 4], zodiac: false },
    );
  }
  expect(compile("1-2-3-4-5-6各100")[0].selections).toEqual([1, 2, 3, 4, 5, 6]);
});
test("repeated selectors and overlapping single-number pools retain multiplicity", () => {
  expect(compile("特码1头10各100")[0].selections).toEqual([
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 10,
  ]);
  expect(compile("平码1尾11各100")[0].selections).toEqual([
    1, 11, 21, 31, 41, 11,
  ]);
  expect(compile("特码蛇蛇各数100")[0].selections).toEqual([
    2, 2, 14, 14, 26, 26, 38, 38,
  ]);
  expect(compile("特码蛇蛇各肖100\n8注共200")[0].package_zodiacs).toEqual([
    5, 5,
  ]);
  const packageIntent = [
    {
      play: "特码",
      market: "macau" as const,
      selections: [],
      compound: false,
      amount: "100",
      package_zodiacs: [5, 5],
    },
  ];
  expect(
    totals(
      price(
        packageIntent,
        plays.map((p) => p.rule),
        { macau: mapping, hk: mapping },
      ),
    ),
  ).toMatchObject({ units: 8, stake: "20000" });
  expect(compile("一肖中鼠鼠各100")[0].selections).toEqual([0, 0]);
  expect(compile("尾中1尾-1尾各100")[0].selections).toEqual([1, 1]);
  expect(compile("波色红波红波各100")[0].selections).toEqual([0, 0]);
  expect(compile("四肖量4-4各100")[0].selections).toEqual([4, 4]);
  expect(compile("特码09-09-21共300")[0].amount).toBe("100.0");
  expect(
    compile("二中二【09-21】【09-21】各100").map((item) => item.selections),
  ).toEqual([
    [9, 21],
    [9, 21],
  ]);
});
test("generated repeated mixed-market bets match independent integer-cent totals", () => {
  // Intentions and amounts are fixed before rendering; no expected value comes
  // from the production parser or counter. Repeated values are never a set.
  for (let seed = 1; seed <= 240; seed++) {
    const count = 3 + (seed % 25);
    const numbers = Array.from(
      { length: count },
      (_, i) => 1 + ((seed + (i % 4)) % 49),
    );
    const amount = seed % 2 ? "12.5" : "20";
    const separator = ["-", ".", "、", "－"][seed % 4];
    const market = seed % 3 ? ("macau" as const) : ("hk" as const);
    const name = seed % 2 ? "特码" : "平码";
    const expected = [
      { play: name, market, selections: numbers, compound: false, amount },
    ];
    const reference = totals(
      price(
        expected,
        plays.map((p) => p.rule),
        { macau: mapping, hk: mapping },
      ),
    );
    const items = compile(
      `${market === "hk" ? "香港" : "澳"}${name}${numbers.join(separator)}各${amount}\n${count}注共${Number(reference.stake) / 100}`,
    );
    expect(items).toHaveLength(1);
    const [actual] = items;
    expect(actual.selections).toEqual(numbers);
    expect(actual.market ?? "macau").toBe(market);
    expect(actual.amount).toBe(amount);
    const rule = plays.find((play) => play.id === actual.play_id)!.rule;
    expect(basicCount(rule, actual.selections, actual.compound)).toBe(count);
    expect(entryCents(actual.amount)! * BigInt(count)).toBe(
      BigInt(reference.stake),
    );
    expect(parseSelections("number", numbers.join(separator))).toEqual(numbers);
  }
});
test("duplicate support preserves atomic combination validity and amount boundaries", () => {
  for (const raw of [
    "二中二09-09各100",
    "二中二复式09-09-21各100",
    "三有鼠鼠牛各100",
    "特码09各-100",
    "特码09各−100",
    "特码09各0",
    "特码09各1.01",
    "特码09-09共100.1",
    "特码50-50各100",
    "特码09-09各100\n2注共201",
  ]) {
    const result = compileText(parseText(raw, plays), plays, mapping);
    expect(result.some((row) => !!row.error)).toBe(true);
  }
  expect(
    compile(Array(1000).fill("09").join("-") + "各0.1")[0].selections,
  ).toHaveLength(1000);
  const invalid = compileText(
    parseText(Array(1001).fill("09").join("-") + "各0.1", plays),
    plays,
    mapping,
  );
  expect(invalid.some((row) => !!row.error)).toBe(true);
});

test("unit summaries cannot become extra zodiac bets through homophones", () => {
  for (const summary of [
    "21注共2100",
    "２１注合计２１００元",
    "二十一注共二千一百",
    "21组共2100",
  ]) {
    const items = compile(
      "09.21.33.45.39.10.46.14.09.45.14.09.07.33.34各100\n1-2-3-4-5-6各100\n" +
        summary,
    );
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.selections.length)).toEqual([15, 6]);
    expect(items.map((i) => i.amount)).toEqual(["100", "100"]);
  }
});

test("custom rules enforce distinct choices by actual basic bet size", () => {
  const original = plays.find((p) => p.rule.name === "特码")!;
  const custom = {
    ...original,
    rule: {
      ...original.rule,
      relation: "ge" as const,
      combination_size: 2,
      compound_enabled: true,
    },
  };
  const configured = plays.map((p) => (p.id === custom.id ? custom : p));
  const result = compileText(
    parseText("特码复式09-09-21各100", configured),
    configured,
    mapping,
  );
  expect(result[0].error).toContain("不同对象");
  expect(basicCount(custom.rule, [9, 9, 21], true)).toBe(0);
  expect(selectionBoundary(custom.rule, [9, 9, 21], true)).toContain(
    "不同对象",
  );
  const single = {
    ...custom.rule,
    quantity: 2,
    relation: "le" as const,
    combination_size: 1,
  };
  expect(basicCount(single, [9, 9, 21], true)).toBe(3);
});
