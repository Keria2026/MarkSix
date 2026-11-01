import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { plays } from "../unit/support";
import { annualMapping, zodiacs } from "../../src/lib/types";
import type {
  Bootstrap,
  Period,
  Statistics,
  Totals,
} from "../../src/lib/types";

// Synthetic API responses exercise the UI independently of a live account/database.
async function workspace(page: Page) {
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
    bettors: [],
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
for (const width of [320, 390, 768, 1440]) {
  test(`workspace controls and layouts remain accessible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await workspace(page);
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
