import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping } from "../../src/lib/types";
import type { Play } from "../../src/lib/types";
import { plays } from "./fixtures";
const mapping = annualMapping(2026);
function compile(raw: string, configured: Play[] = plays) {
  const rows = parseText(raw, configured);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return { rows, results: compileText(rows, configured, mapping) };
}
function accepted(
  raw: string,
  selections: number[][],
  name: string,
  amount: string,
) {
  const { results } = compile(raw);
  expect(results.length).toBeGreaterThan(0);
  expect(results.map((result) => result.error)).toEqual(results.map(() => ""));
  const items = results.flatMap((result) => result.items);
  expect(items.map((item) => item.selections)).toEqual(selections);
  expect(items.map((item) => item.amount)).toEqual(
    selections.map(() => amount),
  );
  expect(items.map((item) => item.compound)).toEqual(
    selections.map(() => false),
  );
  expect(
    items.map(
      (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
    ),
  ).toEqual(selections.map(() => name));
  return { items, results };
}

test("postfix triples and a Chinese group price preserve all four groups", () => {
  accepted(
    "29.06.27，41.30.02，03.17.23，41.34.43，三中三一组十块\n4组共40",
    [
      [29, 6, 27],
      [41, 30, 2],
      [3, 17, 23],
      [41, 34, 43],
    ],
    "三中三",
    "10",
  );
});
test("slashes separate number groups before a shared group price", () => {
  accepted(
    "三中三，48 26 11 /48 26 23/一组10米\n2组共20",
    [
      [48, 26, 11],
      [48, 26, 23],
    ],
    "三中三",
    "10",
  );
});
test("spaces separate dotted pairs without merging their repeated banker", () => {
  accepted(
    "08.09 08.33 08.45 二中二各50\n3组共150",
    [
      [8, 9],
      [8, 33],
      [8, 45],
    ],
    "二中二",
    "50",
  );
});
for (const groupSeparator of [
  ",",
  "，",
  "/",
  " / ",
  ";",
  "；",
  "\n",
  " ",
  "\t",
]) {
  for (const marker of ["各10", "一组10米", "/每组10元", " 10点一组"]) {
    test(`complete groups retain boundaries across ${JSON.stringify(groupSeparator)} and ${marker}`, () => {
      accepted(
        `三中三01.07.14${groupSeparator}22.31.49${marker}\n2组共20`,
        [
          [1, 7, 14],
          [22, 31, 49],
        ],
        "三中三",
        "10",
      );
    });
  }
}
test("different combination sizes, total prices and exact duplicate groups stay independent", () => {
  accepted(
    "三中二01.07.14，22.31.49各20\n2组共40",
    [
      [1, 7, 14],
      [22, 31, 49],
    ],
    "三中二",
    "20",
  );
  accepted(
    "五不中01.07.14.22.31 02.08.15.23.49一组10",
    [
      [1, 7, 14, 22, 31],
      [2, 8, 15, 23, 49],
    ],
    "五不中",
    "10",
  );
  accepted(
    "二中二01.07 01.07共30\n2组共30",
    [
      [1, 7],
      [1, 7],
    ],
    "二中二",
    "15.0",
  );
});
test("grouped pools retain explicit compound semantics, never joining groups", () => {
  const { results } = compile("二中二复式01.07.14，22.31.49各10\n6组共60");
  expect(results.map((row) => row.error)).toEqual(["", ""]);
  const items = results.flatMap((row) => row.items);
  expect(items.map((item) => item.selections)).toEqual([
    [1, 7, 14],
    [22, 31, 49],
  ]);
  expect(items.map((item) => item.compound)).toEqual([true, true]);
});
test("per-group suffix keeps grouped sets single and still infers a flat compound pool", () => {
  accepted(
    "二中二01.07，22.31/10点一组\n2组共20",
    [
      [1, 7],
      [22, 31],
    ],
    "二中二",
    "10",
  );
  const { results } = compile("二中二01.07.22.31/10点一组\n6组共60");
  expect(results.map((row) => row.error)).toEqual(["", ""]);
  expect(results[0].items).toMatchObject([
    { selections: [1, 7, 22, 31], compound: true, amount: "10" },
  ]);
});
test("market, following play and editable group amount preserve the same group boundaries", () => {
  const raw =
    "香港三中三01.07.14/22.31.49/每组10元\n澳门二中二08.09 08.33各50\n4组共120";
  const { rows, results } = compile(raw);
  expect(results.map((row) => row.error)).toEqual(["", "", ""]);
  expect(
    results.flatMap((row) => row.items).map((item) => item.market ?? "macau"),
  ).toEqual(["hk", "hk", "macau", "macau"]);
  rows[0].amount = "20";
  const edited = compileText(rows, plays, mapping);
  expect(edited[0].items.map((item) => item.amount)).toEqual(["20", "20"]);
  expect(edited.at(-1)!.error).toContain("合计");
});
for (const raw of [
  "三中三01.07.14，22.31每组10",
  "三中三01.07.14/22.31/每组10",
  "三中三01.07.14 22.31每组10",
  "三中三01.07.14，22.31.50每组10",
  "三中三01.07.14，22.31.31每组10",
  "三中三01.07.14，22.31.49备注各10",
  "三中三01.07.14，22.31.49每组10.55",
  "三中三01.07.14，22.31.49每组10\n2组共30",
  "二中二01 07 22 31各10",
  "二中二复式01.07，22各10",
])
  test(`invalid or incomplete grouped input remains blocked: ${raw}`, () => {
    expect(compile(raw).results.some((row) => !!row.error)).toBe(true);
  });
test("grouping cannot bypass a disabled play and slash unit prices keep their original role", () => {
  const disabled = plays.map((play) => ({
    ...play,
    enabled: play.rule.name !== "三中三",
  }));
  expect(
    compile("三中三01.07.14/22.31.49/每组10", disabled).results.some(
      (row) => !!row.error,
    ),
  ).toBe(true);
  accepted("01.07.14三中三/5米", [[1, 7, 14]], "三中三", "5");
  accepted("二中二01.07/12.5元", [[1, 7]], "二中二", "12.5");
  const { results } = compile("二中二01.07/10一组，22.31/20一组");
  expect(results.map((row) => row.error)).toEqual(["", ""]);
  expect(
    results.flatMap((row) => row.items).map((item) => item.amount),
  ).toEqual(["10", "20"]);
});
