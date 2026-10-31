import { expect, test } from "bun:test";
import {
  statementFilename,
  statementRows,
  statementTotals,
  type Bettor,
} from "../../src/lib/statement";
import type { Atom, AtomResult, Bet } from "../../src/lib/types";

// Independent fixed amounts: stake 100, payout 200, rebate 2; bettor net +102.
function sample(settled = true): Bettor {
  return {
    name: "synthetic-statement",
    totals: {
      records: 1,
      units: 1,
      stake: 10000,
      payout: settled ? 20000 : 0,
      rebate: 200,
      refunded: 0,
      net: settled ? -10200 : null,
    },
    bets: [
      {
        record: {
          id: "b",
          slip_id: "slip",
          created_at: "2040-01-01T00:00:00",
          status: settled ? "settled" : "pending",
          unit_count: 1,
          stake: 10000,
          payout: settled ? 20000 : null,
          rebate: 200,
          void_stake: 0,
          rule: { rebate_percent: "2" },
        } as Bet,
        atoms: [{ stake: 10000, rebate: 200, rebate_percent: "2.00" } as Atom],
        results: settled
          ? [{ payout: 20000, rebate: 200, voided: false } as AtomResult]
          : null,
      },
    ],
  };
}

test("statement totals use the bettor's financial direction and leave pending payout unknown", () => {
  const rows = statementRows(sample(), true);
  expect(rows).toEqual([
    {
      id: "slip",
      createdAt: "2040-01-01T00:00:00",
      stake: 10000n,
      payout: 20000n,
      rebate: 200n,
      net: 10200n,
      bands: [{ rate: "2", base: 10000n, amount: 200n }],
    },
  ]);
  const pending = statementRows(sample(false), false);
  expect(statementTotals(pending, false)).toEqual({
    stake: 10000n,
    payout: null,
    rebate: 200n,
    net: null,
    bands: [{ rate: "2", base: 10000n, amount: 200n }],
  });
});

test("cancelled bets contribute no money and grouped records retain earliest creation time", () => {
  const data = sample();
  const extra = structuredClone(data.bets[0]);
  extra.record.id = "cancelled";
  extra.record.created_at = "2039-12-31T23:00:00";
  extra.record.status = "cancelled";
  data.bets.push(extra);
  const rows = statementRows(data, true);
  expect(rows).toHaveLength(1);
  expect(rows[0].stake).toBe(10000n);
  expect(rows[0].createdAt).toBe("2039-12-31T23:00:00");
});

test("same slip merges normalized rebate bands without mutating original atoms", () => {
  const data = sample();
  data.bets.push(structuredClone(data.bets[0]));
  data.bets[1].record.id = "second";
  data.bets[1].atoms[0].rebate_percent = "";
  Object.assign(data.totals, {
    stake: 20000,
    payout: 40000,
    rebate: 400,
    net: -20400,
  });
  const rows = statementRows(data, true);
  expect(rows).toHaveLength(1);
  expect(rows[0].bands).toEqual([{ rate: "2", base: 20000n, amount: 400n }]);
  expect(rows[0].net).toBe(20400n);
  expect(data.bets[0].atoms[0].stake).toBe(10000);
});

test("void returns stake and removes rebate from both rows and totals", () => {
  const data = sample();
  Object.assign(data.bets[0].record, {
    payout: 10000,
    rebate: 0,
    void_stake: 10000,
  });
  Object.assign(data.bets[0].results![0], {
    payout: 10000,
    rebate: 0,
    voided: true,
  });
  Object.assign(data.totals, {
    stake: 0,
    payout: 0,
    rebate: 0,
    refunded: 10000,
    net: 0,
  });
  expect(statementTotals(statementRows(data, true), true)).toEqual({
    stake: 10000n,
    payout: 10000n,
    rebate: 0n,
    net: 0n,
    bands: [],
  });
  data.bets[0].results![0].rebate = 1;
  expect(() => statementRows(data, true)).toThrow("和局金额不一致");
});

for (const alter of [
  (b: Bettor) => {
    b.bets[0].atoms = [];
  },
  (b: Bettor) => {
    b.bets[0].record.unit_count = 2;
  },
  (b: Bettor) => {
    b.bets[0].record.status = "pending";
  },
  (b: Bettor) => {
    b.bets[0].record.payout = null;
  },
  (b: Bettor) => {
    b.bets[0].results = null;
  },
  (b: Bettor) => {
    b.bets[0].results = [];
  },
])
  test("incomplete financial snapshots cannot be exported", () => {
    const data = sample();
    alter(data);
    expect(() => statementRows(data, true)).toThrow("结算记录不完整");
  });
for (const alter of [
  (b: Bettor) => {
    b.bets[0].record.stake++;
  },
  (b: Bettor) => {
    b.bets[0].record.rebate++;
  },
  (b: Bettor) => {
    b.bets[0].record.payout!++;
  },
  (b: Bettor) => {
    b.bets[0].record.void_stake++;
  },
])
  test("atom and record discrepancies cannot be exported", () => {
    const data = sample();
    alter(data);
    expect(() => statementRows(data, true)).toThrow("基础注与投注单金额不一致");
  });
for (const alter of [
  (b: Bettor) => {
    b.totals.stake++;
  },
  (b: Bettor) => {
    b.totals.rebate++;
  },
  (b: Bettor) => {
    b.totals.payout++;
  },
  (b: Bettor) => {
    b.totals.net = null;
  },
  (b: Bettor) => {
    b.totals.net!++;
  },
])
  test("record and summary discrepancies cannot be exported", () => {
    const data = sample();
    alter(data);
    expect(() => statementRows(data, true)).toThrow("账单明细与汇总不一致");
  });
for (const rate of ["1.234", "-1", "not a rate", "101", "100.01"])
  test(`invalid rebate rate blocks export: ${rate}`, () => {
    const data = sample();
    data.bets[0].atoms[0].rebate_percent = rate;
    expect(() => statementRows(data, true)).toThrow("水钱比例");
  });
for (const amount of [0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
  test(`unsafe integer blocks export: ${amount}`, () => {
    const data = sample();
    data.bets[0].atoms[0].stake = amount;
    expect(() => statementRows(data, true)).toThrow("账单金额不合法");
  });

test("filenames cannot traverse, collide by case, or use reserved Windows names", () => {
  const used = new Set<string>();
  expect(statementFilename("../A:*?", used, "pdf")).toBe("_A___.pdf");
  expect(statementFilename("CON", used, "pdf")).toBe("投注人-CON.pdf");
  expect(statementFilename("...", used, "png")).toBe("未登记.png");
  expect(statementFilename("Sample", used, "pdf")).toBe("Sample.pdf");
  expect(statementFilename("sample", used, "pdf")).toBe("sample (2).pdf");
  expect(
    new TextEncoder().encode(statementFilename("测".repeat(200), used, "pdf"))
      .length,
  ).toBeLessThanOrEqual(255);
});

test("separate slips sort by creation and identity and aggregate distinct rebate bands", () => {
  const data = sample();
  const rows = ["z", "a", "middle"].map((id, index) => {
    const row = structuredClone(data.bets[0]);
    row.record.id = id;
    row.record.slip_id = null;
    row.record.created_at =
      index === 2 ? "2039-12-30T00:00:00" : "2040-01-01T00:00:00";
    if (index === 1) {
      row.atoms[0].rebate_percent = "2.5";
      row.atoms[0].rebate = 250;
      row.results![0].rebate = 250;
      row.record.rebate = 250;
    }
    return row;
  });
  data.bets = rows;
  Object.assign(data.totals, {
    stake: 30000,
    payout: 60000,
    rebate: 650,
    net: -30650,
  });
  const result = statementRows(data, true);
  expect(result.map((row) => row.id)).toEqual(["middle", "a", "z"]);
  expect(statementTotals(result, true)).toEqual({
    stake: 30000n,
    payout: 60000n,
    rebate: 650n,
    net: 30650n,
    bands: [
      { rate: "2", base: 20000n, amount: 400n },
      { rate: "2.5", base: 10000n, amount: 250n },
    ],
  });
});
