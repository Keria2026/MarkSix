import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { unzipSync } from "fflate";
import {
  createBettorArchive,
  type BettorStatement,
} from "../../src/lib/bettor-statement";

function emptyStatement(): BettorStatement {
  return {
    period: "2040001",
    settled: false,
    draw: null,
    bet_version: 1,
    generated_at: "2040-01-01T00:00:00",
    bettors: ["样本", "样本"].map((name) => ({
      name,
      totals: {
        records: 0,
        units: 0,
        stake: 0,
        rebate: 0,
        payout: 0,
        refunded: 0,
        net: null,
      },
      bets: [],
    })),
  };
}

test("PDF archive embeds the real Chinese font, preserves separate bettors and yields readable PDFs", async () => {
  const bytes = new Uint8Array(
    await Bun.file(
      new URL("../../src/assets/NotoSansSC-Regular.ttf", import.meta.url),
    ).arrayBuffer(),
  );
  const progress: [number, number][] = [];
  const result = await createBettorArchive(
    emptyStatement(),
    bytes,
    new AbortController().signal,
    (done, total) => progress.push([done, total]),
    "pdf",
  );
  const files = unzipSync(result);
  expect(Object.keys(files).sort()).toEqual(["样本 (2).pdf", "样本.pdf"]);
  for (const file of Object.values(files)) {
    const pdf = await PDFDocument.load(file, { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe("新澳门 第2040001期 · 样本 · 投注对账单");
    expect(pdf.getProducer()).toBe("MarkSix");
  }
  expect(progress).toEqual([
    [1, 2],
    [2, 2],
  ]);
}, 30000);

test("cancelled exports never return a partial archive or report progress", async () => {
  let progress = 0;
  await expect(
    createBettorArchive(
      emptyStatement(),
      new Uint8Array(),
      AbortSignal.abort(),
      () => {
        progress++;
      },
      "pdf",
    ),
  ).rejects.toThrow();
  expect(progress).toBe(0);
});

test("Hong Kong statement uses the accepted source issue instead of its internal period id", async () => {
  const data = emptyStatement();
  data.market = "hk";
  data.period = "hk-2040031";
  data.draw = {
    expect: "2040007",
    open_time: "2040-02-01T21:32:32",
    numbers: [1, 2, 3, 4, 5, 6, 7],
    zodiac: [0, 1, 2, 3, 4, 5, 6],
    waves: [0, 1, 2, 0, 1, 2, 0],
  };
  const bytes = new Uint8Array(
    await Bun.file(
      new URL("../../src/assets/NotoSansSC-Regular.ttf", import.meta.url),
    ).arrayBuffer(),
  );
  const files = unzipSync(
    await createBettorArchive(
      data,
      bytes,
      new AbortController().signal,
      () => {},
      "pdf",
    ),
  );
  const pdf = await PDFDocument.load(files["样本.pdf"]);
  expect(pdf.getTitle()).toBe("香港 第2040007期 · 样本 · 投注对账单");
});
