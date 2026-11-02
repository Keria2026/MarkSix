import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping, basicCount } from "../../src/lib/types";
import { plays } from "./fixtures";
const mapping = annualMapping(2026);
const play = plays.find((p) => p.rule.name === "二中二含特")!;
function compile(raw: string, configured = plays) {
  const rows = parseText(raw, configured);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return { rows, result: compileText(rows, configured, mapping) };
}
for (const suffix of ["点一组", "點一組", "点 1组", "元一组", "一组"]) {
  test(`numeric group prices preserve the heading and independent pools: ${suffix}`, () => {
    const raw = `二中二带特\n17.21.29.32.48/12${suffix}\n09.21.29.48.17/8${suffix}\n20组共200`;
    const { rows, result } = compile(raw);
    expect(rows).toHaveLength(3);
    expect(result.map((r) => r.error)).toEqual(["", "", ""]);
    const items = result.flatMap((r) => r.items);
    expect(items.map((i) => i.play_id)).toEqual([play.id, play.id]);
    expect(items.map((i) => i.selections)).toEqual([
      [17, 21, 29, 32, 48],
      [9, 21, 29, 48, 17],
    ]);
    expect(items.map((i) => i.amount)).toEqual(["12", "8"]);
    expect(items.map((i) => i.compound)).toEqual([true, true]);
    expect(
      items.map((i) => basicCount(play.rule, i.selections, i.compound)),
    ).toEqual([10, 10]);
    expect(rows[0].source.endsWith(suffix)).toBe(true);
    rows[1].amount = "9";
    const edited = compileText(rows, plays, mapping);
    expect(edited[1].items[0].amount).toBe("9");
    expect(edited[2].error).toContain("合计与投注不符");
  });
}
test("group-price inference uses rule quantity and ends with a new explicit play", () => {
  const { result } = compile(
    "三中三\n01.07.19.34/12.5点一组\n二中二带特09.23/6点一组\n特码18.28各30",
  );
  expect(result.map((r) => r.error)).toEqual(["", "", ""]);
  const items = result.flatMap((r) => r.items);
  expect(items.map((i) => i.compound)).toEqual([true, false, false]);
  expect(items.map((i) => i.amount)).toEqual(["12.5", "6", "30"]);
  expect(
    items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["三中三", "二中二含特", "特码"]);
});
test("point-unit syntax leaves ambiguous money, grouping and invalid pools blocked", () => {
  for (const raw of [
    "二中二带特17.21.29/12点5一组",
    "二中二带特17.21.29/12点整一组",
    "二中二带特17.21.29/12点",
    "二中二带特17.21.29/12.55点一组",
    "二中二带特17.21.17/12点一组",
    "二中二带特17.21.50/12点一组",
    "二中二带特17.21.29各12",
    "二中二带特17.21.29共120点一组",
    "二中二带特17.21.29照旧/12点一组",
  ])
    expect(compile(raw).result.some((r) => r.error)).toBe(true);
  for (const modified of [
    plays.map((p) => ({ ...p, enabled: p.id !== play.id })),
    plays.map((p) =>
      p.id === play.id
        ? { ...p, rule: { ...p.rule, compound_enabled: false } }
        : p,
    ),
  ])
    expect(
      compile("二中二带特17.21.29/12点一组", modified).result.some(
        (r) => r.error,
      ),
    ).toBe(true);
});

test("complete number groups retain their boundaries instead of becoming one compound pool", () => {
  for (const separator of ["\n", "；"]) {
    const { result } = compile(`二中二带特17.21${separator}29.32/12点一组`);
    expect(result.map((r) => r.error)).toEqual([""]);
    const items = result.flatMap((r) => r.items);
    expect(items.map((i) => i.selections)).toEqual([
      [17, 21],
      [29, 32],
    ]);
    expect(items.map((i) => i.compound)).toEqual([false, false]);
    expect(items.map((i) => i.amount)).toEqual(["12", "12"]);
  }
});
