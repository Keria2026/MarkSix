import { test, expect } from "./scenario-fixtures";
import AxeBuilder from "@axe-core/playwright";
import type { Download, Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { unzipSync } from "fflate";
import type { BettorStatement } from "../../src/lib/statement";
import { plays } from "../contracts/fixtures";
import { annualMapping, zodiacs } from "../../src/lib/types";
import type {
  Bootstrap,
  Period,
  Statistics,
  Totals,
  Bet,
  Atom,
} from "../../src/lib/types";

// Synthetic API responses exercise the UI independently of a live account/database.
async function workspace(page: Page, statement?: BettorStatement) {
  const queries: Record<string, unknown>[] = [];
  const totals: Totals = {
    records: 0,
    units: 0,
    stake: 0,
    rebate: 0,
    exposure: 0,
    payout: 0,
    winning_stake: 0,
    losing_stake: 0,
    gross: null,
    refunded: 0,
    flyout_stake: 0,
    flyout_net: null,
    retained_net: null,
    net: null,
  };
  for (const bettor of statement?.bettors ?? []) {
    for (const key of ["records", "units", "stake", "rebate"] as const)
      totals[key] += bettor.totals[key];
  }
  const today: Period = {
    id: "sample-period",
    market: "macau",
    business_date: "2026-11-01",
    close_time: "2026-11-01T21:30:00+08:00",
    open_time: "2026-11-01T21:34:00+08:00",
    server_time: "2026-11-01T15:18:00+08:00",
    mapping: annualMapping(2026),
    state: "open",
    phase: "scheduled",
    accepting_entries: true,
    bet_version: 1,
    draw: null,
    error: null,
    mapping_warning: false,
    last_fetch_at: null,
    settled_at: null,
    totals,
  };
  const boot: Bootstrap = {
    today,
    hk: { ...today, id: "sample-hk", market: "hk" },
    day: {
      id: today.id,
      business_date: today.business_date,
      state: today.state,
      phase: today.phase,
      totals,
      periods: [today],
    },
    plays,
    zodiacs,
    features: {
      layoffs: false,
      manual_entry: true,
      text_entry: true,
      entry_mode: "manual",
    },
  };
  const report: Statistics = {
    period: today.id,
    settled: false,
    incoming: totals,
    outgoing: totals,
    retained: totals,
    bettors: statement?.bettors ?? [],
    receivers: [],
    layoffs: [],
    layoffs_total: 0,
    layoffs_page: 1,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;
    if (path === "/api/site") json = { mode: "hosted", version: "preview" };
    else if (path === "/api/session") json = { username: "演示账号" };
    else if (path === "/api/license") json = { active: true, permanent: true };
    else if (path === "/api/bootstrap") json = boot;
    else if (path.endsWith("/statistics")) json = report;
    else if (path.endsWith("/bet-filters"))
      json = {
        bettors: [
          "张三",
          "李四",
          ...Array.from({ length: 8 }, (_, i) => `示例客户 ${i + 1}`),
        ],
        plays: plays.map((p) => ({ id: p.id, name: p.rule.name })),
      };
    else if (path === "/api/records/search") {
      const body = route.request().postDataJSON();
      queries.push(body);
      json = { items: [], total: 0, page: body.page ?? 1, page_size: 25 };
    } else if (path === "/api/parties") json = { bettors: [], receivers: [] };
    else if (path === "/api/days")
      json = { items: [], total: 0, page: 1, page_size: 25 };
    else if (path === "/api/settings/entry-mode") {
      boot.features.entry_mode = route.request().postDataJSON().entry_mode;
      json = boot.features;
    } else if (path === "/api/settings")
      json = {
        features: boot.features,
        cutover_time: "06:00",
        mappings: [],
        tomorrow: "2026-11-02",
      };
    else if (path.endsWith("/bettor-export"))
      return route.fulfill({
        status: 503,
        json: { error: "导出暂不可用，请重试" },
      });
    else
      return route.fulfill({
        status: 404,
        json: { error: `Unmocked path: ${path}` },
      });
    await route.fulfill({ json });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  return { queries };
}
async function navigate(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function records(page: Page) {
  await navigate(page, "本期统计");
  await navigate(page, "投注记录");
  await expect(page.getByRole("form", { name: "筛选投注记录" })).toBeVisible();
}
async function accessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
for (const width of [320, 390, 768, 1440, 1920, 2560, 3440]) {
  test(`workspace controls and layouts remain accessible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await workspace(page);
    if (width >= 1440) {
      for (const selector of [".topbar", ".stats-grid", ".records-panel"]) {
        const box = await page.locator(selector).first().boundingBox();
        expect(box).not.toBeNull();
        expect(width - box!.x - box!.width).toBeLessThanOrEqual(48);
        expect(box!.x).toBe(264);
      }
    }
    await accessible(page);
    await records(page);
    await accessible(page);
    await page.screenshot({
      path: test.info().outputPath(`records-${width}.png`),
      fullPage: true,
    });
    const trigger = page.getByRole("button", {
      name: /^投注人：/,
    });
    await trigger.click();
    await page.getByRole("searchbox", { name: "搜索投注人" }).fill("张三");
    await page.getByLabel("张三", { exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await navigate(page, "投注人分类统计");
    await accessible(page);
    await page.screenshot({
      path: test.info().outputPath(`statistics-${width}.png`),
      fullPage: true,
    });
    await navigate(page, "录入投注");
    await page.getByRole("radio", { name: "香港", exact: true }).check();
    await expect(page.locator(".summary-market")).toHaveText("香港");
    await expect(
      page.getByRole("button", { name: "确认录入投注", exact: true }),
    ).toBeDisabled();
    await accessible(page);
    await page.screenshot({
      path: test.info().outputPath(`entry-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "文本录注", exact: true }).click();
    await expect(page.getByLabel("投注原文")).toBeVisible();
    await accessible(page);
    await navigate(page, "玩法与配置");
    await accessible(page);
    await page.screenshot({
      path: test.info().outputPath(`settings-${width}.png`),
      fullPage: true,
    });
    await navigate(page, "历史统计");
    await accessible(page);
    expect(errors).toEqual([]);
  });
}

function exportSnapshot(): BettorStatement {
  return {
    period: "sample-period",
    business_date: "2026-11-01",
    combined: true,
    settled: false,
    draw: null,
    bet_version: 1,
    generated_at: "2026-11-01T15:18:00",
    bettors: [
      { name: "张三", amounts: [10000, 2500], rebates: [200, 50] },
      { name: "张三丰", amounts: [98765], rebates: [1975] },
    ].map(({ name, amounts, rebates }) => ({
      name,
      totals: {
        records: amounts.length,
        units: amounts.length,
        stake: amounts.reduce((a, b) => a + b, 0),
        rebate: rebates.reduce((a, b) => a + b, 0),
        payout: 0,
        refunded: 0,
        net: null,
      },
      bets: amounts.map((stake, index) => ({
        record: {
          id: `${name}-${index}`,
          slip_id: `${name}-mixed-market`,
          market: index === 0 ? "macau" : "hk",
          period_id: index === 0 ? "sample-period" : "sample-hk",
          created_at: "2026-11-01T15:18:00",
          status: "pending",
          unit_count: 1,
          stake,
          rebate: rebates[index],
          payout: null,
          void_stake: 0,
          rule: { rebate_percent: "2" },
        } as Bet,
        atoms: [{ stake, rebate: rebates[index], rebate_percent: "2" } as Atom],
        results: null,
      })),
    })),
  };
}

async function downloadBytes(file: Download) {
  const chunks: Buffer[] = [];
  for await (const chunk of (await file.createReadStream())!)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportGeometry(page: Page) {
  return page
    .locator(".records-panel")
    .first()
    .evaluate((panel) =>
      [".section-head", ".bettor-export", ".ledger-table", "tbody tr"].map(
        (selector) => {
          const { x, y, width, height } = panel
            .querySelector(selector)!
            .getBoundingClientRect();
          return { x, y, width, height };
        },
      ),
    );
}

for (const width of [390, 2560]) {
  test(`exports keep geometry stable and single files contain only the chosen bettor at ${width}px`, async ({
    page,
  }) => {
    const data = exportSnapshot();
    await page.setViewportSize({ width, height: 1080 });
    await workspace(page, data);
    await navigate(page, "本期统计");
    await navigate(page, "投注人分类统计");
    await page.route("**/bettor-export?combined=true", (route) =>
      route.fulfill({ json: data }),
    );
    const all = page.getByRole("button", { name: "导出账单（全部投注人）" });
    const individual = page.getByRole("button", {
      name: "导出账单（张三）",
      exact: true,
    });
    // On mobile, scroll only the table to its operation column before measuring.
    await individual.scrollIntoViewIfNeeded();
    const before = await exportGeometry(page);
    const pdfEvent = page.waitForEvent("download");
    await individual.click();
    const pdfFile = await pdfEvent;
    expect(pdfFile.suggestedFilename()).toBe("张三.pdf");
    const pdf = await PDFDocument.load(await downloadBytes(pdfFile));
    expect(pdf.getTitle()).toBe("录入日期 2026-11-01 · 张三 · 投注对账单");
    await expect(page.getByRole("status")).toContainText(
      "已导出「张三」 PDF 账单",
    );
    expect(await exportGeometry(page)).toEqual(before);

    await page.evaluate(() => {
      const target = window as unknown as { statementPaint: string[] };
      target.statementPaint = [];
      const paint = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (
        text,
        x,
        y,
        maxWidth,
      ) {
        target.statementPaint.push(text);
        if (maxWidth === undefined) paint.call(this, text, x, y);
        else paint.call(this, text, x, y, maxWidth);
      };
    });
    await page.getByLabel("账单导出格式").selectOption("png");
    const pngEvent = page.waitForEvent("download");
    await individual.click();
    const pngFile = await pngEvent;
    expect(pngFile.suggestedFilename()).toBe("张三.png");
    expect([...(await downloadBytes(pngFile)).subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    const painted = await page.evaluate(() =>
      (window as unknown as { statementPaint: string[] }).statementPaint.join(
        "\n",
      ),
    );
    expect(painted).toContain("投注人：张三");
    expect(painted).not.toContain("张三丰");
    expect(painted).toContain("新澳门");
    expect(painted).toContain("香港");
    expect(painted).toContain("125.00");
    expect(painted).not.toContain("987.65");
    await expect(page.getByRole("status")).toContainText(
      "已导出「张三」 PNG 账单",
    );
    expect(await exportGeometry(page)).toEqual(before);
    await accessible(page);
    await page.screenshot({
      path: test.info().outputPath(`export-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "关闭导出提示" }).click();
    await expect(page.locator(".export-notice")).toBeHidden();

    const archiveEvent = page.waitForEvent("download");
    await all.click();
    const archive = await archiveEvent;
    expect(archive.suggestedFilename()).toBe("2026-11-01-投注人对账单-png.zip");
    expect(Object.keys(unzipSync(await downloadBytes(archive))).sort()).toEqual(
      ["张三.png", "张三丰.png"],
    );
    expect(await exportGeometry(page)).toEqual(before);
  });
}

test("export loading, cancellation and errors leave the table in place and allow retry", async ({
  page,
}) => {
  await workspace(page, exportSnapshot());
  await navigate(page, "本期统计");
  await navigate(page, "投注人分类统计");
  const before = await exportGeometry(page);
  const individual = page.getByRole("button", {
    name: "导出账单（张三）",
    exact: true,
  });
  const all = page.getByRole("button", { name: "导出账单（全部投注人）" });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/bettor-export?combined=true", async (route) => {
    await pending;
    await route
      .fulfill({ status: 503, json: { error: "导出暂不可用，请重试" } })
      .catch(() => {});
  });
  let downloads = 0;
  page.on("download", () => downloads++);
  await individual.click();
  await expect(page.getByRole("status")).toHaveText("正在读取账单…");
  await expect(individual).toBeDisabled();
  await expect(all).toBeDisabled();
  expect(await exportGeometry(page)).toEqual(before);
  await page.getByRole("button", { name: "取消导出" }).click();
  release();
  await expect(page.getByRole("status")).toHaveText("已取消导出");
  await expect(individual).toBeEnabled();
  expect(await exportGeometry(page)).toEqual(before);
  await individual.click();
  await expect(page.getByRole("alert")).toHaveText("导出暂不可用，请重试");
  expect(await exportGeometry(page)).toEqual(before);
  await expect(individual).toBeEnabled();
  await accessible(page);
  expect(downloads).toBe(0);
});

test("filters apply together, survive background refresh, validate ranges and reset", async ({
  page,
}) => {
  const { queries } = await workspace(page);
  await records(page);
  await page.getByRole("button", { name: "投注人：全部", exact: true }).click();
  await page.getByLabel("张三", { exact: true }).check();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByLabel("投注总额下限（元）", { exact: true }).fill("500");
  await page.getByLabel("投注总额上限（元）", { exact: true }).fill("100");
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "刷新数据", exact: true }),
  ).toBeEnabled();
  expect(queries.at(-1)?.bettors).toEqual([]);
  expect(queries.at(-1)?.min_amount).toBeNull();
  await expect(
    page.getByLabel("投注总额下限（元）", { exact: true }),
  ).toHaveValue("500");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("金额下限不能大于上限");
  await page.getByLabel("投注总额下限（元）", { exact: true }).fill("50.001");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("最多保留两位小数");
  await page.getByLabel("投注总额下限（元）", { exact: true }).fill("50");
  await page
    .getByLabel("记录排序", { exact: true })
    .selectOption("amount_desc");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "没有符合条件的记录" }),
  ).toBeVisible();
  expect(queries.at(-1)).toMatchObject({
    bettors: ["张三"],
    min_amount: "50",
    max_amount: "100",
    order: "amount_desc",
    page: 1,
  });
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(
    page.getByLabel("投注总额下限（元）", { exact: true }),
  ).toHaveValue("");
  expect(queries.at(-1)).toMatchObject({
    bettors: [],
    min_amount: null,
    max_amount: null,
    order: "newest",
  });
});

test("export stays with its table and exposes a recoverable failure", async ({
  page,
}) => {
  await workspace(page);
  await navigate(page, "本期统计");
  await navigate(page, "投注人分类统计");
  const panel = page.locator(".records-panel");
  await expect(panel.getByLabel("账单导出格式")).toBeVisible();
  await panel.getByLabel("账单导出格式").selectOption("png");
  await panel.getByRole("button", { name: "导出账单（全部投注人）" }).click();
  await expect(page.getByRole("alert")).toContainText("导出暂不可用");
  await expect(
    panel.getByRole("button", { name: "导出账单（全部投注人）" }),
  ).toBeEnabled();
  await accessible(page);
});

test("manual market selection and amount reach the submitted request", async ({
  page,
}) => {
  await workspace(page);
  await page.route("**/api/bets", (route) =>
    route.fulfill({ json: { id: "synthetic-bet" } }),
  );
  await navigate(page, "录入投注");
  await page.getByRole("radio", { name: "香港", exact: true }).check();
  await page.getByLabel("搜索玩法名称").fill("特码");
  await page
    .locator(".play-picker button")
    .filter({ has: page.locator("span", { hasText: /^特码$/ }) })
    .click();
  await page.getByRole("button", { name: /^07 / }).click();
  await page.getByPlaceholder("手工填写姓名或代号").fill("合成客户");
  await page
    .getByRole("textbox", { name: "每注金额", exact: true })
    .fill("25.5");
  const request = page.waitForRequest(
    (r) => r.url().endsWith("/api/bets") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "确认录入投注", exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({
    market: "hk",
    amount: "25.5",
    selections: [7],
    bettor: "合成客户",
  });
  await expect(
    page.getByRole("button", { name: "确认录入投注", exact: true }),
  ).toBeDisabled();
});

test("record filters show pending and failed loads without duplicate submissions", async ({
  page,
}) => {
  await workspace(page);
  await records(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/records/search", async (route) => {
    await pending;
    await route.fulfill({
      status: 503,
      json: { error: "记录暂不可用，请重试" },
    });
  });
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(page.getByRole("button", { name: "筛选中…" })).toBeDisabled();
  await expect(
    page.getByLabel("投注总额下限（元）", { exact: true }),
  ).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText("记录暂不可用");
  await expect(
    page.getByRole("button", { name: "筛选", exact: true }),
  ).toBeEnabled();
});

test("populated records keep names and monetary columns readable", async ({
  page,
}) => {
  await workspace(page);
  const play = plays.find((p) => p.rule.name === "特码")!;
  const bet = {
    id: "synthetic-record",
    period_id: "sample-period",
    slip_id: null,
    slip_position: null,
    bettor: "示例客户 · 长名称核对",
    market: "macau",
    created_at: "2026-11-01T07:18:00",
    rule: play.rule,
    play_id: play.id,
    play_version: 1,
    selections: [7],
    compound: false,
    amount: 2550,
    stake: 2550,
    unit_count: 1,
    status: "pending",
    rebate: 255,
    payout: null,
  };
  const group = {
    id: bet.id,
    period_id: bet.period_id,
    bettor: bet.bettor,
    created_at: bet.created_at,
    grouped: false,
    status: bet.status,
    stake: 2550,
    unit_count: 1,
    totals: {
      records: 1,
      units: 1,
      stake: 2550,
      rebate: 255,
      payout: 0,
      refunded: 0,
      net: null,
    },
    items: [bet],
  };
  await page.route("**/api/records/search", (route) =>
    route.fulfill({
      json: { items: [group], total: 1, page: 1, page_size: 25 },
    }),
  );
  await records(page);
  await expect(
    page.getByRole("cell", { name: "¥ 25.50", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(bet.bettor, { exact: true })).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: test.info().outputPath("records-populated.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await accessible(page);
  const table = page.getByRole("region", { name: "数据表格，可横向滚动" });
  await table.focus();
  await page.keyboard.press("End");
  await expect(table).toBeFocused();
});

for (const width of [390, 1440]) {
  test(`statistics navigation reopens saved collapsed categories at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem(
        `marksix:menus:${encodeURIComponent("演示账号")}`,
        JSON.stringify({ statistics: false, history: false }),
      );
    });
    await workspace(page);
    const statistics = page
      .getByRole("navigation", { name: "主要导航" })
      .getByRole("button", { name: "本期统计", exact: true });
    const category = page.getByRole("button", {
      name: "投注人分类统计",
      exact: true,
    });
    await expect(statistics).toHaveAttribute("aria-expanded", "false");
    await statistics.click();
    await expect(statistics).toHaveAttribute("aria-expanded", "true");
    await expect(category).toBeVisible();
    // The active destination remains keyboard-toggleable on desktop and mobile.
    await statistics.focus();
    await page.keyboard.press("Enter");
    await expect(statistics).toHaveAttribute("aria-expanded", "false");
    await expect(category).toBeHidden();
    await navigate(page, "本期概览");
    await statistics.click();
    await expect(statistics).toHaveAttribute("aria-expanded", "true");
    await category.click();
    await expect(page.getByLabel("账单导出格式")).toBeVisible();
  });
}

for (const width of [320, 390, 720]) {
  test(`liquid glass dock tracks selection and preserves menus at ${width}px`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await workspace(page, exportSnapshot());
    const nav = page.getByRole("navigation", { name: "主要导航" });
    const lens = nav.locator(".nav-glass-lens");
    await expect(nav).toHaveAttribute("data-glass-ready", "true");
    const backdrop = await nav
      .locator(".nav-glass-surface")
      .evaluate((surface) => getComputedStyle(surface).backdropFilter);
    expect(backdrop).toContain("blur(");
    if (browserName === "webkit") expect(backdrop).not.toContain("url(");
    const buttons = nav.locator(".nav-link");
    await expect(buttons).toHaveCount(5);
    for (const button of await buttons.all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const stats = nav.getByRole("button", { name: "本期统计", exact: true });
    const centerError = async () => {
      const a = (await lens.boundingBox())!,
        b = (await stats.boundingBox())!;
      return Math.abs(a.x + a.width / 2 - b.x - b.width / 2);
    };
    await stats.click();
    await expect(stats).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("button", { name: "投注人分类统计", exact: true }),
    ).toBeVisible();
    await expect.poll(centerError).toBeLessThan(1.5);
    await expect(nav).not.toHaveAttribute("data-glass-settling");
    const before = (await lens.boundingBox())!;
    await stats.focus();
    await page.keyboard.press("Enter");
    await expect(stats).toHaveAttribute("aria-expanded", "false");
    await expect.poll(centerError).toBeLessThan(1.5);
    const after = (await lens.boundingBox())!;
    expect(Math.abs(before.y - after.y)).toBeLessThan(1);
    expect(
      await nav.locator('[data-glass-map="lens"]').getAttribute("href"),
    ).toMatch(/^data:image\/png/);
    await accessible(page);
    expect(errors).toEqual([]);
    await stats.evaluate((button) => button.blur());
    await page.screenshot({
      path: test.info().outputPath(`liquid-glass-${width}.png`),
    });
  });
}

test("liquid glass drag commits one destination and cancellation keeps the active page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace(page);
  const nav = page.getByRole("navigation", { name: "主要导航" });
  const first = nav.getByRole("button", { name: "本期概览", exact: true });
  const target = nav.getByRole("button", { name: "玩法与配置", exact: true });
  const a = (await first.boundingBox())!,
    b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await expect(nav).toHaveAttribute("data-glass-drag", "true");
  await expect(first).toHaveAttribute("aria-current", "page");
  await page.mouse.up();
  await expect(target).toHaveAttribute("aria-current", "page");
  await expect(target).toBeFocused();
  await expect(nav).not.toHaveAttribute("data-glass-press");
  await target.dispatchEvent("pointerdown", {
    pointerId: 9,
    isPrimary: true,
    button: 0,
    clientX: b.x + b.width / 2,
    clientY: b.y + b.height / 2,
  });
  await target.dispatchEvent("pointercancel", { pointerId: 9 });
  await expect(nav).not.toHaveAttribute("data-glass-press");
  await expect(target).toHaveAttribute("aria-current", "page");
  await target.dispatchEvent("pointerdown", {
    pointerId: 10,
    isPrimary: true,
    button: 0,
    clientX: b.x + b.width / 2,
    clientY: b.y + b.height / 2,
  });
  await target.dispatchEvent("pointermove", {
    pointerId: 10,
    clientX: b.x + b.width / 2,
    clientY: b.y - 40,
  });
  await expect(nav).not.toHaveAttribute("data-glass-press");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2, { steps: 8 });
  await page.mouse.move(a.x + a.width / 2, 100, { steps: 4 });
  await page.mouse.up();
  await expect(target).toHaveAttribute("aria-current", "page");
});

test("liquid glass has static high-contrast fallback and stays off the desktop sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await workspace(page);
  const lens = page.locator(".nav-glass-lens");
  const transition = await lens.evaluate(
    (element) => getComputedStyle(element).transitionDuration,
  );
  expect(parseFloat(transition)).toBeLessThan(0.01);
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "本期统计", exact: true }).click();
  await expect(nav).not.toHaveAttribute("data-glass-settling");
  expect(
    await lens.evaluate((element) => getComputedStyle(element).scale),
  ).toBe("1");
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(lens).toBeHidden();
  await expect(
    page
      .getByRole("navigation", { name: "主要导航" })
      .getByRole("button", { name: "本期统计", exact: true }),
  ).toBeVisible();
});

type NavigationFrame = {
  time: number;
  x: number;
  height: number;
  icon: number;
};
type RecordedNavigation = HTMLElement & {
  motionFrames?: Promise<NavigationFrame[]>;
};

test.describe("liquid glass touch motion", () => {
  test.use({ hasTouch: true });

  test("a quick tap visibly slides and enlarges the lens, then restores its compact size", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await workspace(page);
    const nav = page.getByRole("navigation", { name: "主要导航" });
    const lens = nav.locator(".nav-glass-lens");
    await expect(nav).toHaveAttribute("data-glass-ready", "true");
    await expect
      .poll(() => lens.evaluate((element) => element.getAnimations().length))
      .toBe(0);
    const initial = (await lens.boundingBox())!;
    const target = nav.getByRole("button", { name: "玩法与配置", exact: true });
    const destination = (await target.boundingBox())!;
    await nav.evaluate((node) => {
      const element = node as RecordedNavigation;
      const lens = element.querySelector<HTMLElement>(".nav-glass-lens")!;
      // Install the recorder synchronously, then sample from the actual click.
      // WebKit must not wait on an evaluation promise before delivering input.
      element.motionFrames = new Promise<NavigationFrame[]>((resolve) => {
        element.addEventListener(
          "click",
          () => {
            const samples: NavigationFrame[] = [];
            const start = performance.now();
            function frame() {
              const box = lens.getBoundingClientRect();
              const icon = element
                .querySelector(".nav-link.active > svg")!
                .getBoundingClientRect();
              samples.push({
                time: performance.now() - start,
                x: box.x + box.width / 2,
                height: box.height,
                icon: icon.height,
              });
              if (performance.now() - start < 950) requestAnimationFrame(frame);
              else resolve(samples);
            }
            frame();
          },
          { once: true, capture: true },
        );
      });
    });
    await page.touchscreen.tap(
      destination.x + destination.width / 2,
      destination.y + destination.height / 2,
    );
    await expect(target).toHaveAttribute("aria-current", "page");
    const samples = await nav.evaluate(
      (node) => (node as RecordedNavigation).motionFrames!,
    );
    await test.info().attach("tap-animation-frames", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
    const start = initial.x + initial.width / 2;
    const end = destination.x + destination.width / 2;
    expect(
      samples.some((sample) => sample.x > start + 20 && sample.x < end - 20),
    ).toBe(true);
    expect(Math.max(...samples.map((sample) => sample.height))).toBeGreaterThan(
      initial.height * 1.16,
    );
    expect(Math.max(...samples.map((sample) => sample.icon))).toBeGreaterThan(
      27,
    );
    await expect(nav).not.toHaveAttribute("data-glass-settling");
    const resting = (await lens.boundingBox())!;
    expect(resting.height).toBeCloseTo(initial.height, 0);
    expect(resting.height).toBeLessThan(destination.height);
    expect(resting.y).toBeGreaterThan(destination.y);
    expect(Math.abs(resting.x + resting.width / 2 - end)).toBeLessThan(1.5);
    expect(
      (await target.locator("svg").first().boundingBox())!.height,
    ).toBeCloseTo(25, 0);
  });

  test("rapid taps and a cancelled hold always return to a compact selection", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await workspace(page);
    const nav = page.getByRole("navigation", { name: "主要导航" });
    const lens = nav.locator(".nav-glass-lens");
    for (const name of ["本期统计", "玩法与配置", "录入投注", "本期概览"]) {
      const box = (await nav
        .getByRole("button", { name, exact: true })
        .boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect(nav).not.toHaveAttribute("data-glass-settling");
    await expect
      .poll(async () => (await lens.boundingBox())!.height)
      .toBeCloseTo(56, 0);
    const current = nav.getByRole("button", { name: "本期概览", exact: true });
    const box = (await current.boundingBox())!;
    await current.dispatchEvent("pointerdown", {
      pointerId: 25,
      isPrimary: true,
      button: 0,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });
    await expect
      .poll(async () => (await lens.boundingBox())!.height)
      .toBeGreaterThan(65);
    await current.dispatchEvent("pointercancel", { pointerId: 25 });
    await expect(nav).not.toHaveAttribute("data-glass-press");
    await expect(nav).not.toHaveAttribute("data-glass-settling");
    await expect(current).toHaveAttribute("aria-current", "page");
    await expect
      .poll(async () => (await lens.boundingBox())!.height)
      .toBeCloseTo(56, 0);
    await expect
      .poll(
        async () =>
          (await current.locator("svg").first().boundingBox())!.height,
      )
      .toBeCloseTo(25, 0);
  });
});
