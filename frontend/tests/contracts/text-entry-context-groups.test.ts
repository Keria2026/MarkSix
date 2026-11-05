import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping, basicCount } from "../../src/lib/types";
import { plays } from "./fixtures";
const mapping = annualMapping(2026);
function result(raw: string, configured = plays) {
  const rows = parseText(raw, configured);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return { rows, compiled: compileText(rows, configured, mapping) };
}
function accepted(raw: string, configured = plays) {
  const { rows, compiled } = result(raw, configured);
  expect(compiled.length).toBeGreaterThan(0);
  expect(compiled.map((row) => row.error)).toEqual(compiled.map(() => ""));
  return { rows, items: compiled.flatMap((row) => row.items) };
}
for (const label of [
  "三四连尾",
  "三四尾连",
  "3.4连尾",
  "三、四连尾",
  "三四連尾",
]) {
  test(`shared tail quantities preserve the selection pool: ${label}`, () => {
    const { items } = accepted(`7.8.5.4付${label}各200\n5组共1000`);
    expect(
      items.map(
        (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
      ),
    ).toEqual(["三尾连", "四尾连"]);
    expect(items.map((item) => item.selections)).toEqual([
      [7, 8, 5, 4],
      [7, 8, 5, 4],
    ]);
    expect(items.map((item) => item.compound)).toEqual([true, true]);
    expect(items.map((item) => item.amount)).toEqual(["200", "200"]);
    expect(
      items.map((item) =>
        basicCount(
          plays.find((play) => play.id === item.play_id)!.rule,
          item.selections,
          item.compound,
        ),
      ),
    ).toEqual([4, 1]);
  });
}
test("compact tail selection digits still precede one quantity-qualified play", () => {
  const shared = accepted("7.8.5.4三四连尾各200").items;
  expect(shared.map((item) => item.selections)).toEqual([
    [7, 8, 5, 4],
    [7, 8, 5, 4],
  ]);
  expect(shared.map((item) => item.compound)).toEqual([true, true]);
  const { items } = accepted("2683连尾每注20");
  expect(items).toHaveLength(1);
  expect(items[0].selections).toEqual([2, 6, 8]);
  expect(plays.find((play) => play.id === items[0].play_id)!.rule.name).toBe(
    "三尾连",
  );
});
for (const newline of ["\n", "\r\n", "\n\n"]) {
  test(`a completed zodiac entry cannot capture the next numeric entry across ${JSON.stringify(newline)}`, () => {
    const { items } = accepted(
      [
        "一肖龙400",
        "二有龙虎100",
        "复试3有龙虎兔猴30一组",
        "03.05.08.11.19个数10",
        "总670",
      ].join(newline),
    );
    expect(
      items.map(
        (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
      ),
    ).toEqual(["一肖中", "二有", "三有", "特码"]);
    expect(items.map((item) => item.selections)).toEqual([
      [4],
      [4, 2],
      [4, 2, 3, 8],
      [3, 5, 8, 11, 19],
    ]);
    expect(items.map((item) => item.compound)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(items.map((item) => item.amount)).toEqual([
      "400",
      "100",
      "30",
      "10",
    ]);
  });
}
test("a new number line can use each prices while explicit headings keep their meaning", () => {
  const { items } = accepted("三有龙虎兔各50\n01.02各10\n总70");
  expect(
    items.map(
      (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
    ),
  ).toEqual(["三有", "特码"]);
  const continued = accepted(
    "二中二\n01.07.14/10一组\n02.08.15/20一组\n6组共90",
  ).items;
  expect(continued.map((item) => item.compound)).toEqual([true, true]);
  expect(result("三有\n01.02.03各10").compiled.some((row) => row.error)).toBe(
    true,
  );
});
test("complete pairs and triples remain separate across line breaks and trailing play names", () => {
  const pairs = accepted(
    "08-38 07-28 08-28 08-23\n09-37二中二各组25\n5组共125",
  ).items;
  expect(pairs.map((item) => item.selections)).toEqual([
    [8, 38],
    [7, 28],
    [8, 28],
    [8, 23],
    [9, 37],
  ]);
  const triples = accepted(
    "11.38.47 11.38.35\n45.38.47 三中三各35一组\n3组共105",
  ).items;
  expect(triples.map((item) => item.selections)).toEqual([
    [11, 38, 47],
    [11, 38, 35],
    [45, 38, 47],
  ]);
});
test("star selections and adjacent postfix plays keep both compound pools and shared prices", () => {
  const { items } = accepted(
    "26*42*43*44*18复二中二各20。05.32.44.12.33复式三中三二中二各组10\n总400",
  );
  expect(items.map((item) => item.selections)).toEqual([
    [26, 42, 43, 44, 18],
    [5, 32, 44, 12, 33],
    [5, 32, 44, 12, 33],
  ]);
  expect(
    items.map(
      (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
    ),
  ).toEqual(["二中二", "三中三", "二中二"]);
  expect(items.map((item) => item.amount)).toEqual(["20", "10", "10"]);
  expect(items.every((item) => item.compound)).toBe(true);
});
test("stars retain their original unit-price meaning without a later shared price", () => {
  expect(accepted("特码03*100").items[0]).toMatchObject({
    selections: [3],
    amount: "100",
  });
  const { items } = accepted("03*15 04*16二中二各20");
  expect(items.map((item) => item.selections)).toEqual([
    [3, 15],
    [4, 16],
  ]);
  expect(items.map((item) => item.compound)).toEqual([false, false]);
});
test("shared price rows remain editable and totals follow each play independently", () => {
  const { rows } = accepted("01.07.14.22.31复式三中三二中二各10\n总200");
  expect(rows).toHaveLength(3);
  expect(rows[0].source).toBe(rows[1].source);
  rows[0].amount = "20";
  const compiled = compileText(rows, plays, mapping);
  expect(compiled[0].items[0].amount).toBe("20");
  expect(compiled[1].items[0].amount).toBe("10");
  expect(compiled[2].error).toContain("合计");
});
for (const raw of [
  "7.8.5.4付三四连尾未知各200",
  "10.8.5.4付三四连尾各200",
  "7.8.5.5付三四连尾各200",
  "7.8.5.4付三四连尾各200\n总800",
  "26*42*43未知复二中二各20",
  "01.07.14三中三二中二各10",
  "三有龙虎兔各50 01.02各10",
]) {
  test(`unresolved shared notation stays blocked: ${raw}`, () => {
    expect(result(raw).compiled.some((row) => !!row.error)).toBe(true);
  });
}
test("missing and exact custom multi-tail plays cannot silently change quantity meaning", () => {
  const missing = plays.map((play) => ({
    ...play,
    enabled: play.rule.name !== "三尾连",
  }));
  expect(
    result("7.8.5.4付三四连尾各200", missing).compiled.some(
      (row) => !!row.error,
    ),
  ).toBe(true);
  const custom = {
    ...plays.find((play) => play.rule.name === "三尾连")!,
    id: 900,
    rule: {
      ...plays.find((play) => play.rule.name === "三尾连")!.rule,
      name: "三四连尾",
    },
  };
  expect(
    accepted("7.8.5.4付三四连尾各200", [...plays, custom]).items.map(
      (item) => item.play_id,
    ),
  ).toEqual([900]);
});
