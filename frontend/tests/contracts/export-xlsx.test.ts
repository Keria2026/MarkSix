import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import {
  createBettorArchive,
  createBettorFile,
} from "../../src/lib/statement-export";
import type { BettorStatement } from "../../src/lib/statement";
import type { Atom, AtomResult, Bet } from "../../src/lib/types";

interface Input {
  stake: number;
  rebate: number;
  payout: number | null;
  slip?: string;
  market?: "macau" | "hk";
  voided?: boolean;
  cancelled?: boolean;
  rate?: string;
}
function snapshot(inputs: Input[], name = "合成样本"): BettorStatement {
  const active = inputs.filter((row) => !row.cancelled);
  const known = active.every((row) => row.payout !== null);
  const stake = active.reduce(
    (sum, row) => sum + (row.voided ? 0 : row.stake),
    0,
  );
  const rebate = active.reduce((sum, row) => sum + row.rebate, 0);
  const payout = active.reduce(
    (sum, row) => sum + (row.voided ? 0 : (row.payout ?? 0)),
    0,
  );
  return {
    period: "2040001",
    business_date: "2040-01-01",
    combined: true,
    settled: known,
    draw: null,
    bet_version: 1,
    generated_at: "2040-01-01T12:00:00",
    bettors: [
      {
        name,
        totals: {
          records: active.filter((row) => !row.voided).length,
          units: active.filter((row) => !row.voided).length,
          stake,
          rebate,
          payout,
          refunded: active.reduce(
            (sum, row) => sum + (row.voided ? row.stake : 0),
            0,
          ),
          net: known ? stake - rebate - payout : null,
        },
        bets: inputs.map((row, index) => ({
          record: {
            id: "record-" + index,
            slip_id: row.slip ?? "slip-" + index,
            market: row.market ?? "macau",
            period_id: row.market === "hk" ? "hk-2040001" : "2040001",
            created_at: "2040-01-01T12:00:" + String(index).padStart(2, "0"),
            status: row.cancelled
              ? "cancelled"
              : row.payout === null
                ? "pending"
                : "settled",
            unit_count: 1,
            stake: row.stake,
            rebate: row.rebate,
            payout: row.payout,
            void_stake: row.voided ? row.stake : 0,
            rule: { rebate_percent: row.rate ?? "3" },
          } as Bet,
          atoms: [
            {
              stake: row.stake,
              rebate: row.rebate,
              rebate_percent: row.rate ?? "3",
            } as Atom,
          ],
          results:
            row.payout === null
              ? null
              : [
                  {
                    payout: row.payout,
                    rebate: row.rebate,
                    voided: row.voided ?? false,
                  } as AtomResult,
                ],
        })),
      },
    ],
  };
}
const rows: Input[] = [
  { stake: 12500, rebate: 375, payout: 20000 },
  { stake: 8000, rebate: 240, payout: 0 },
  { stake: 1600, rebate: 40, payout: 0, rate: "2.5" },
];
async function file(data = snapshot(rows)) {
  return createBettorFile(
    data,
    data.bettors[0].name,
    new Uint8Array(),
    new AbortController().signal,
    () => {},
    "xlsx",
  );
}
function sheet(bytes: Uint8Array) {
  return strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]);
}
function cell(xml: string, ref: string) {
  const tag = xml.match(
    new RegExp('<c r="' + ref + '"[^>]*>[\\s\\S]*?</c>'),
  )?.[0];
  if (!tag) throw Error("Missing exported cell " + ref);
  return tag;
}
test("xlsx has the five requested columns, exact operator balances, red winnings and final sums", async () => {
  const result = await file();
  expect(result.name).toBe("合成样本.xlsx");
  const parts = unzipSync(result.bytes),
    xml = sheet(result.bytes);
  expect(Object.keys(parts).sort()).toEqual(
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ].sort(),
  );
  for (const [ref, title] of [
    ["A1", "序号"],
    ["B1", "总单"],
    ["C1", "水"],
    ["D1", "中"],
    ["E1", "结账"],
    ["A5", "总数"],
  ])
    expect(cell(xml, ref)).toContain(">" + title + "<");
  for (const [ref, value] of [
    ["A2", "1"],
    ["B2", "125"],
    ["C2", "3.75"],
    ["D2", "200"],
    ["E2", "-78.75"],
    ["E3", "77.6"],
    ["E4", "15.6"],
    ["B5", "221"],
    ["C5", "6.55"],
    ["D5", "200"],
    ["E5", "14.45"],
  ])
    expect(cell(xml, ref)).toContain("<v>" + value + "</v>");
  expect(cell(xml, "E2")).toContain("<f>ROUND(B2-C2-D2,2)</f>");
  expect(cell(xml, "B5")).toContain("<f>ROUND(SUM(B2:B4),2)</f>");
  expect(cell(xml, "D3")).toContain('s="6"'); // Red zero section is intentionally blank.
  expect(strFromU8(parts["xl/styles.xml"])).toContain('rgb="FFFF0000"');
  expect(strFromU8(parts["xl/styles.xml"])).toContain('style="thin"');
  expect(xml).toContain('ySplit="1"');
});
test("same mixed-market receipt is one row and cancelled entries do not affect totals", async () => {
  const data = snapshot([
    { ...rows[0], slip: "joint" },
    { ...rows[1], slip: "joint", market: "hk" },
    rows[2],
    { stake: 99999, rebate: 3000, payout: 0, cancelled: true },
  ]);
  const xml = sheet((await file(data)).bytes);
  expect(xml.match(/<row /g)).toHaveLength(4);
  for (const [ref, value] of [
    ["B2", "205"],
    ["C2", "6.15"],
    ["D2", "200"],
    ["E2", "-1.15"],
    ["B4", "221"],
    ["E4", "14.45"],
  ])
    expect(cell(xml, ref)).toContain("<v>" + value + "</v>");
});
test("void refunds are neutral and are excluded from both principal and winnings", async () => {
  const xml = sheet(
    (
      await file(
        snapshot([
          { stake: 10000, rebate: 0, payout: 10000, voided: true },
          rows[2],
        ]),
      )
    ).bytes,
  );
  for (const ref of ["B2", "C2", "D2", "E2"])
    expect(cell(xml, ref)).toContain("<v>0</v>");
  expect(cell(xml, "B4")).toContain("<v>16</v>");
  expect(cell(xml, "E4")).toContain("<v>15.6</v>");
});
test("partial settlement does not invent winnings or final balance, including a mixed receipt", async () => {
  const data = snapshot([
    { ...rows[0], payout: null, slip: "joint" },
    { ...rows[1], slip: "joint", market: "hk" },
    rows[2],
  ]);
  const xml = sheet((await file(data)).bytes);
  for (const ref of ["D2", "E2", "D4", "E4"]) {
    expect(cell(xml, ref)).toContain("待结算");
    expect(cell(xml, ref)).not.toContain("<f>");
  }
  expect(cell(xml, "E3")).toContain("<v>15.6</v>");
  expect(cell(xml, "B4")).toContain("<v>221</v>");
});
test("values beyond Excel's 15 significant digits stay exact and avoid unsafe formulas", async () => {
  const data = snapshot([
    { stake: 8_000_000_000_000_001, rebate: 0, payout: 0, rate: "0" },
  ]);
  const xml = sheet((await file(data)).bytes);
  for (const ref of ["B2", "E2", "B3", "E3"]) {
    expect(cell(xml, ref)).toContain('t="inlineStr"');
    expect(cell(xml, ref)).toContain(">80000000000000.01<");
    expect(cell(xml, ref)).not.toContain("<f>");
  }
  const aggregate = snapshot(
    Array.from({ length: 11 }, () => ({
      stake: 800_000_000_000_001,
      rebate: 0,
      payout: 0,
      rate: "0",
    })),
  );
  const summed = sheet((await file(aggregate)).bytes);
  expect(cell(summed, "B13")).toContain(">88000000000000.11<");
  expect(cell(summed, "B13")).not.toContain("<f>");
});
test("empty sheets have zero totals without circular SUM ranges", async () => {
  const xml = sheet((await file(snapshot([]))).bytes);
  expect(xml.match(/<row /g)).toHaveLength(2);
  for (const ref of ["B2", "C2", "D2", "E2"]) {
    expect(cell(xml, ref)).toContain("<v>0</v>");
    expect(cell(xml, ref)).not.toContain("<f>");
  }
});
test("single and bulk exports isolate exact bettors, sanitize names and escape metadata", async () => {
  const data = snapshot(rows, '=HYPERLINK("<&")');
  data.bettors.push(snapshot([rows[2]], "Other").bettors[0]);
  const single = await createBettorFile(
    data,
    data.bettors[0].name,
    new Uint8Array(),
    new AbortController().signal,
    () => {},
    "xlsx",
  );
  const parts = unzipSync(single.bytes);
  expect(strFromU8(parts["docProps/core.xml"])).toContain("&lt;&amp;");
  expect(strFromU8(parts["docProps/core.xml"])).not.toContain("Other");
  expect(sheet(single.bytes)).not.toContain("HYPERLINK");
  const ticks: number[] = [];
  const archive = unzipSync(
    await createBettorArchive(
      data,
      new Uint8Array(),
      new AbortController().signal,
      (n) => ticks.push(n),
      "xlsx",
    ),
  );
  expect(Object.keys(archive)).toHaveLength(2);
  expect(ticks).toEqual([1, 2]);
  expect(archive["Other.xlsx"]).toBeDefined();
  const collision = snapshot([], "Sample");
  collision.bettors.push(snapshot([], "sample").bettors[0]);
  const names = Object.keys(
    unzipSync(
      await createBettorArchive(
        collision,
        new Uint8Array(),
        new AbortController().signal,
        () => {},
        "xlsx",
      ),
    ),
  );
  expect(names).toEqual(["Sample.xlsx", "sample (2).xlsx"]);
});
test("aborted, incomplete and inconsistent exports return no downloaded workbook", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    createBettorArchive(
      snapshot(rows),
      new Uint8Array(),
      controller.signal,
      () => {},
      "xlsx",
    ),
  ).rejects.toThrow();
  const later = new AbortController(),
    data = snapshot(rows);
  data.bettors.push(snapshot(rows, "second").bettors[0]);
  await expect(
    createBettorArchive(
      data,
      new Uint8Array(),
      later.signal,
      () => later.abort(),
      "xlsx",
    ),
  ).rejects.toThrow();
  const bad = snapshot(rows);
  bad.bettors[0].totals.stake++;
  await expect(file(bad)).rejects.toThrow("汇总不一致");
  const incomplete = snapshot(rows);
  incomplete.bettors[0].bets[0].results = null;
  await expect(file(incomplete)).rejects.toThrow("结算记录不完整");
  await expect(
    createBettorFile(
      data,
      "missing",
      new Uint8Array(),
      new AbortController().signal,
      () => {},
      "xlsx",
    ),
  ).rejects.toThrow("完整账单");
});
