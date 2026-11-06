import { expect, test } from "bun:test";
import { parseText, compileText } from "../../src/lib/text-entry";
import { annualMapping } from "../../src/lib/types";
import { plays } from "./fixtures";
const mapping = annualMapping(2026);
function result(raw: string) {
  const rows = parseText(raw, plays);
  for (const row of rows)
    expect(row.source).toBe(raw.slice(row.start, row.end));
  return { rows, compiled: compileText(rows, plays, mapping) };
}
function accepted(raw: string) {
  const { compiled } = result(raw);
  expect(compiled.length).toBeGreaterThan(0);
  expect(compiled.map((row) => row.error)).toEqual(compiled.map(() => ""));
  return compiled.flatMap((row) => row.items);
}
test("five-linked aliases keep the compound pool and following plain group independent", () => {
  const items = accepted(
    "5友复式牛龙兔狗猴马各150元，5友牛龙兔狗猴／100\n7组共1000",
  );
  expect(items.map((item) => item.selections)).toEqual([
    [1, 4, 3, 10, 8, 6],
    [1, 4, 3, 10, 8],
  ]);
  expect(items.map((item) => item.compound)).toEqual([true, false]);
  expect(items.map((item) => item.amount)).toEqual(["150", "100"]);
});
test("the supplementary-plane monkey variant preserves its raw source and exact zodiac", () => {
  const items = accepted("5友复式牛羊虎鸡猪𤠣各80\n6组共480");
  expect(items[0].selections).toEqual([1, 7, 2, 9, 11, 8]);
  expect(items[0].amount).toBe("80");
  expect(items[0].compound).toBe(true);
  expect(result("三有牛猴𤠣各80").compiled.some((row) => !!row.error)).toBe(
    true,
  );
});
test("successive special pools keep their separate prices", () => {
  const items = accepted(
    "特29，33，34各200元，30.31.32.35.36.37.38各100\n总1300",
  );
  expect(items.map((item) => item.selections)).toEqual([
    [29, 33, 34],
    [30, 31, 32, 35, 36, 37, 38],
  ]);
  expect(items.map((item) => item.amount)).toEqual(["200", "100"]);
});
test("dot-separated complete number/price pairs do not become invalid decimals", () => {
  const items = accepted("特08.200.26.100.二有牛狗200\n总500");
  expect(items.map((item) => item.selections)).toEqual([[8], [26], [1, 10]]);
  expect(items.map((item) => item.amount)).toEqual(["200", "100", "200"]);
  expect(
    items.map(
      (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
    ),
  ).toEqual(["特码", "特码", "二有"]);
  expect(accepted("特08各200.10元")[0].amount).toBe("200.1");
  expect(result("特08各200.27元").compiled.some((row) => !!row.error)).toBe(
    true,
  );
});
for (const suffix of ["一甲数", "一个数", "一個數"]) {
  test(`amount suffix ${suffix} stays attached to its own numeric price`, () => {
    const items = accepted(
      `奥虎兔特各90元一肖，28码60元，特04.07.12.15.18.20.23.28.各2O元${suffix}，奥三有虎兔猴80元。\n总480`,
    );
    expect(items.map((item) => item.amount)).toEqual(["90", "60", "20", "80"]);
    expect(items[0].package_zodiacs).toEqual([2, 3]);
    expect(items[1].selections).toEqual([28]);
    expect(items[2].selections).toEqual([4, 7, 12, 15, 18, 20, 23, 28]);
    expect(items[3].selections).toEqual([2, 3, 8]);
  });
}
test("a following explicit single-zodiac play is not consumed as a package suffix", () => {
  const items = accepted("特码牛各100元一肖中狗各20");
  expect(
    items.map(
      (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
    ),
  ).toEqual(["特码", "一肖中"]);
  expect(items[0].package_zodiacs).toBeUndefined();
  const repeated = accepted("特码牛各100元一肖狗各20");
  expect(
    repeated.map(
      (item) => plays.find((play) => play.id === item.play_id)!.rule.name,
    ),
  ).toEqual(["特码", "一肖中"]);
});
for (const qualifier of ["韩特", "韓特", "含特"]) {
  test(`tail drag uses the qualified number play: ${qualifier}`, () => {
    const items = accepted(`六尾拖九尾，二中二，${qualifier}各六元\n25组共150`);
    expect(plays.find((play) => play.id === items[0].play_id)!.rule.name).toBe(
      "二中二含特",
    );
    expect(items[0].drag).toEqual({
      left: [6, 16, 26, 36, 46],
      right: [9, 19, 29, 39, 49],
      zodiac: false,
    });
    expect(items[0].amount).toBe("6");
  });
}
for (const slash of ["//", "///", "/ /", "／／"]) {
  for (const price of ["50", "59", "200", "200.5"]) {
    test(`complete non-hit group followed by ${slash}${price} uses the number as a price`, () => {
      const items = accepted(
        `十不中：06.30.20.32.10.46.26.38.11.31${slash}${price}`,
      );
      expect(items).toHaveLength(1);
      expect(items[0].selections).toEqual([
        6, 30, 20, 32, 10, 46, 26, 38, 11, 31,
      ]);
      expect(items[0].amount).toBe(price);
      expect(items[0].compound).toBe(false);
    });
  }
}
for (const raw of [
  "十不中06.30.20.32.10.46.26.38.11//200",
  "十不中06.30.20.32.10.46.26.38.11.31//200各10",
  "特码03//59各10",
  "特04.07各2O未知元一甲数",
  "三有牛狗未知各80",
  "二中二03 15韩特未知各10",
  "特码牛各100元\n一肖",
  "特码牛各100元；一肖",
  "特码03各60元\n各数",
]) {
  test(`incomplete objects, contradictory prices and unknown words stay blocked: ${raw}`, () => {
    expect(result(raw).compiled.some((row) => !!row.error)).toBe(true);
  });
}
