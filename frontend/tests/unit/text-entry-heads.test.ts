import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { clipboardRows } from "../../src/lib/text-entry/clipboard";
import { annualMapping, basicCount } from "../../src/lib/types";
import { plays } from "./support";
const mapping = annualMapping(2026);
const special = plays.find((p) => p.rule.name === "特码")!;
function compile(raw: string, configured = plays) {
  const rows = parseText(raw, configured);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return { rows, result: compileText(rows, configured, mapping) };
}
function valid(raw: string) {
  const { rows, result } = compile(raw);
  expect(rows.length).toBeGreaterThan(0);
  expect(result.map((r) => r.error)).toEqual(rows.map(() => ""));
  return result.flatMap((r) => r.items);
}
for (const [head, expected] of [
  ["0", [1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ["一", [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]],
  ["２", [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]],
  ["三", [30, 31, 32, 33, 34, 35, 36, 37, 38, 39]],
  ["4", [40, 41, 42, 43, 44, 45, 46, 47, 48, 49]],
] as const) {
  for (const suffix of ["头", "頭"]) {
    test(`number head ${head}${suffix} expands to the legal 01-49 pool`, () => {
      const raw = `特码 ${head}${suffix}\u00a0各80`;
      const [item] = valid(raw);
      expect(item.play_id).toBe(special.id);
      expect(item.selections).toEqual([...expected]);
      expect(item.amount).toBe("80");
      expect(item.compound).toBe(false);
      expect(basicCount(special.rule, item.selections, item.compound)).toBe(
        expected.length,
      );
      expect(clipboardRows(raw, plays, [])).not.toBeNull();
    });
  }
}
test("heads preserve postfix plays, bare prices, multiple pools and inherited number plays", () => {
  expect(valid("一头特码各70")[0].selections).toEqual([
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  ]);
  expect(valid("特码一头70")[0].amount).toBe("70");
  expect(valid("特码0头1头各40")[0].selections).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  ]);
  const inherited = valid("特码1头各70；4头各60");
  expect(inherited.map((i) => i.play_id)).toEqual([special.id, special.id]);
  expect(inherited[1].selections).toEqual([
    40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  ]);
  expect(inherited.map((i) => i.amount)).toEqual(["70", "60"]);
  const [regular] = valid("平码三头各80");
  expect(regular.play_id).toBe(plays.find((p) => p.rule.name === "平码")!.id);
});
test("head totals use the expanded count and react to draft edits", () => {
  const { rows, result } = compile("特码0头共900\n9组共900");
  expect(result.map((r) => r.error)).toEqual(["", ""]);
  expect(result[0].items[0].amount).toBe("100.0");
  rows[0].body = "1头";
  const changed = compileText(rows, plays, mapping);
  expect(changed[0].items[0].amount).toBe("90.0");
  expect(changed[1].error).toContain("合计与投注不符");
});
test("head pools use the same number expansion in compound, drag and miss plays", () => {
  const [compound] = valid("二中二复式1头各10");
  expect(compound.compound).toBe(true);
  expect(compound.selections).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  expect(
    basicCount(
      plays.find((p) => p.id === compound.play_id)!.rule,
      compound.selections,
      true,
    ),
  ).toBe(45);
  const [drag] = valid("二中二1头拖31 41各20");
  expect(drag.drag).toEqual({
    left: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    right: [31, 41],
    zodiac: false,
  });
  expect(valid("十不中4头各400")[0].selections).toEqual([
    40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  ]);
  expect(valid("4头不中各400")[0].selections).toEqual([
    40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  ]);
});
test("heads reject invalid ranges, overlap, unknown text and incompatible plays", () => {
  for (const raw of [
    "特码5头各80",
    "特码5头1头各80",
    "特码12头各80",
    "特码00头各80",
    "特码1头1头各80",
    "特码1头15各80",
    "特码1头3尾各80",
    "特码1头各80.55",
    "特码0头共1000",
    "特码1头未知各80",
    "尾中1头各80",
    "二中二1头各80",
    "二中二1头拖15各80",
    "二中二1头拖兔各20",
    "1头各80",
  ]) {
    const { rows, result } = compile(raw);
    expect(rows.length).toBeGreaterThan(0);
    expect(result.some((r) => r.error)).toBe(true);
  }
  const disabled = plays.map((p) => ({ ...p, enabled: p.id !== special.id }));
  expect(compile("特码1头各80", disabled).result.some((r) => r.error)).toBe(
    true,
  );
});

test("explicit trailing prices keep additional numbers in the head selection list", () => {
  const [item] = valid("特码1头 25各80");
  expect(item.selections).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 25]);
  expect(item.amount).toBe("80");
  expect(valid("特码1头80一组共800")[0].amount).toBe("80");
  const items = valid("特码1头80\n31各20");
  expect(items.map((i) => i.amount)).toEqual(["80", "20"]);
  expect(items[1].selections).toEqual([31]);
});
