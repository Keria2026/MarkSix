import { test, expect } from "./fixtures";
import type { Bet, Atom } from "../../src/lib/types";
import type { BettorStatement } from "../../src/lib/statement";

test("a bettor's long statement exports as one decoded PNG with its final rows and total", async ({
  page,
}) => {
  await page.goto("/");
  const data: BettorStatement = {
    period: "2040001",
    settled: false,
    draw: null,
    bet_version: 1,
    generated_at: "2040-01-01T00:00:00",
    bettors: [120, 0].map((count) => ({
      name: "合成长账单",
      totals: {
        records: count,
        units: count,
        stake: count * 10000,
        rebate: count * 200,
        payout: 0,
        refunded: 0,
        net: null,
      },
      bets: Array.from({ length: count }, (_, i) => ({
        record: {
          id: `r${i}`,
          slip_id: `s${i}`,
          period_id: "2040001",
          created_at: "2040-01-01T00:00:00",
          status: "pending",
          unit_count: 1,
          stake: 10000,
          rebate: 200,
          payout: null,
          void_stake: 0,
          rule: { rebate_percent: "2" },
        } as Bet,
        atoms: [{ stake: 10000, rebate: 200, rebate_percent: "2" } as Atom],
        results: null,
      })),
    })),
  };
  const result = await page.evaluate(async (data) => {
    const modulePath = "/src/lib/bettor-statement.ts";
    const { createBettorArchive } = await import(modulePath);
    const zipPath = "/node_modules/fflate/esm/browser.js";
    // Use the application's dependency through Vite's module resolver.
    const { unzipSync } = await import(zipPath);
    const bytes = new Uint8Array(
      await (await fetch("/src/assets/NotoSansSC-Regular.ttf")).arrayBuffer(),
    );
    const painted: string[] = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text,
      x,
      y,
      maxWidth,
    ) {
      painted.push(text);
      if (maxWidth === undefined) original.call(this, text, x, y);
      else original.call(this, text, x, y, maxWidth);
    };
    try {
      const files = unzipSync(
        await createBettorArchive(
          data,
          bytes,
          new AbortController().signal,
          () => {},
          "png",
        ),
      );
      const images = [];
      for (const [name, value] of Object.entries(files)) {
        const bitmap = await createImageBitmap(
          new Blob([value as Uint8Array<ArrayBuffer>], { type: "image/png" }),
        );
        images.push({ name, width: bitmap.width, height: bitmap.height });
        bitmap.close();
      }
      const result = {
        images,
        last: painted.includes("120"),
        total: painted.filter((s) => s === "合计").length,
        pageNumbers: painted.filter((s) => /^\d+ \/ \d+$/.test(s)),
      };
      const controller = new AbortController();
      let progress = 0,
        cancelled = false;
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y) {
        if (text === "001") controller.abort();
        original.call(this, text, x, y);
      };
      try {
        await createBettorArchive(
          data,
          bytes,
          controller.signal,
          () => {
            progress++;
          },
          "png",
        );
      } catch {
        cancelled = controller.signal.aborted;
      }
      return { ...result, cancelled, progress };
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original;
    }
  }, data);
  expect(result.images.map((i) => i.name)).toEqual([
    "合成长账单.png",
    "合成长账单 (2).png",
  ]);
  expect(result.images[0].height).toBeGreaterThan(10000);
  expect(result.images[0].width).toBe(1191);
  expect(result.images[1].height).toBe(1684);
  expect(result.last).toBe(true);
  expect(result.total).toBe(2);
  expect(result.pageNumbers).toEqual([]);
  expect(result.cancelled).toBe(true);
  expect(result.progress).toBe(0);
});
