import { expect, test } from "bun:test";
import {
  decimal,
  yuan,
  combinations,
  atomSets,
  price,
  totals,
  mapping,
  type ReferenceLine,
} from "../model/financial-oracle";
import { oracle } from "../../../scripts/generate_text_entry";
import { plays } from "./fixtures";
const rules = plays.map((play) => play.rule);
const maps = { macau: mapping(6), hk: mapping(7) };
const line = (
  play: string,
  patch: Partial<ReferenceLine> = {},
): ReferenceLine => ({
  play,
  market: "macau",
  selections: [1, 2],
  compound: false,
  amount: "10",
  ...patch,
});
test("reference money is exact and rejects unsupported precision", () => {
  expect(decimal("90000000000000.1", 2)).toBe(9_000_000_000_000_010n);
  expect(decimal("00001.5", 2)).toBe(150n);
  expect(yuan(1250n)).toBe("12.5");
  expect(yuan(1201n)).toBe("12.01");
  expect(() => decimal("1e2", 2)).toThrow();
  expect(() => decimal("1.001", 2)).toThrow();
});
test("reference enumeration exposes every combination and respects fixed drag items", () => {
  expect(combinations([1, 2, 3, 4], 3)).toEqual([
    [1, 2, 3],
    [1, 2, 4],
    [1, 3, 4],
    [2, 3, 4],
  ]);
  const r = rules.find((rule) => rule.name === "三中三")!;
  const drag = line(r.name, {
    selections: [],
    compound: true,
    drag: { left: [1, 2], right: [3, 4, 5, 6, 7], zodiac: false },
  });
  expect(atomSets(drag, r, maps.macau)).toEqual([
    [1, 2, 3],
    [1, 2, 4],
    [1, 2, 5],
    [1, 2, 6],
    [1, 2, 7],
  ]);
  expect(
    oracle(
      [
        {
          play: r.name,
          quantity: 3,
          selections: [],
          compound: true,
          amount: "10",
          drag: drag.drag!,
        },
      ],
      maps.macau,
    ),
  ).toEqual({ units: 5, stake: 5000 });
});
test("reference package distributes cents by number while retaining each zodiac total", () => {
  const atoms = price(
    [line("特码", { selections: [], package_zodiacs: [0, 6], amount: "0.1" })],
    rules,
    maps,
  );
  expect(
    atoms
      .filter((atom) => maps.macau.zodiac[atom.options[0] - 1] === 0)
      .map((atom) => atom.stake),
  ).toEqual(["3", "3", "2", "2"]);
  expect(
    atoms
      .filter((atom) => maps.macau.zodiac[atom.options[0] - 1] === 6)
      .map((atom) => atom.stake),
  ).toEqual(["2", "2", "2", "2", "2"]);
  expect(totals(atoms).stake).toBe("20");
});
test("reference market mapping and native zero-tail rate priority are independent", () => {
  const configured = rules.map((rule) =>
    rule.name === "尾中"
      ? {
          ...rule,
          special_odds: "8",
          special_rebate_percent: "9",
          zero_tail_odds: "3",
          zero_tail_rebate_percent: "1.5",
        }
      : rule,
  );
  const atoms = price(
    [line("尾中", { selections: [0], amount: "0.1" })],
    configured,
    maps,
  );
  expect(atoms[0]).toMatchObject({
    stake: "10",
    payout: "30",
    rebate: "0",
    exposure: "30",
  });
  expect(mapping(6).zodiac.slice(0, 8)).toEqual([6, 5, 4, 3, 2, 1, 0, 11]);
  expect(mapping(7).zodiac.slice(0, 8)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
});
