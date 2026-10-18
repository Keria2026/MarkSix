import { test, expect } from "./authenticated";
import AxeBuilder from "@axe-core/playwright";
import type { Statistics, Period } from "../src/lib/types";

const totals = (stake: number, net: number | null) => ({
  records: 4,
  units: 8,
  stake,
  rebate: 1000,
  payout: 9000,
  refunded: 0,
  net,
});
const reportFixture = (period: string, settled = true): Statistics => ({
  period,
  settled,
  incoming: totals(10001, settled ? -100 : null),
  outgoing: { ...totals(4000, settled ? -2100 : null), records: 2, units: 3 },
  retained: { stake: 6001, rebate: 0, payout: 0, net: settled ? -2200 : null },
  bettors: ["甲", "乙", "丙"].map((name) => ({
    name,
    totals: totals(0, settled ? 0 : null),
  })),
  receivers: [
    { name: "受注方甲", totals: totals(4000, settled ? -2100 : null) },
  ],
  layoffs: [],
  layoffs_total: 0,
  layoffs_page: 1,
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
});

test("glass indicator follows navigation, submenus toggle, and reduced motion is respected", async ({
  page,
}) => {
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await expect(nav.locator(".nav-plus")).toHaveCount(0);
  const bet = nav.getByRole("button", { name: "录入投注", exact: true });
  await expect(bet.locator("svg.lucide-plus")).toHaveCount(0);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["录入投注", "本期统计", "官方频道"]) {
      const target = nav.getByRole("button", { name, exact: true });
      await target.click();
      await expect
        .poll(async () => {
          const [surface, button] = await Promise.all([
            nav.locator(".nav-indicator").boundingBox(),
            target.boundingBox(),
          ]);
          return (
            Math.abs(surface!.x - button!.x) +
            Math.abs(surface!.y - button!.y) +
            Math.abs(surface!.width - button!.width) +
            Math.abs(surface!.height - button!.height)
          );
        })
        .toBeLessThan(4);
      if (name !== "录入投注") {
        const toggle = nav.getByRole("button", {
          name: new RegExp(`(展开|收起)${name}二级菜单`),
        });
        const clickToggle = async () => {
          if (width <= 960) await target.click();
          else await toggle.click();
        };
        if ((await target.getAttribute("aria-expanded")) === "true")
          await clickToggle();
        await clickToggle();
        await expect(nav.locator(".nav-submenu")).toBeVisible();
        await clickToggle();
        await expect(nav.locator(".nav-submenu")).toHaveCount(0);
      }
    }
  }
  const statistics = nav.getByRole("button", { name: "本期统计", exact: true });
  await statistics.click();
  await nav
    .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
    .click();
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  await expect(statistics).toHaveAttribute("aria-expanded", "false");
  const disclosure = nav.getByRole("button", {
    name: "展开本期统计二级菜单",
    exact: true,
  });
  const primaryBox = (await statistics.boundingBox())!;
  const arrowBox = (await disclosure.boundingBox())!;
  expect(
    Math.abs(
      primaryBox.y + primaryBox.height / 2 - arrowBox.y - arrowBox.height / 2,
    ),
  ).toBeLessThan(3);
  await disclosure.click();
  await expect(statistics).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByLabel("本期统计分类")).toBeVisible();
  await nav
    .getByRole("button", { name: "收起本期统计二级菜单", exact: true })
    .click();
  expect(
    await nav
      .locator(".nav-indicator")
      .evaluate((n) => getComputedStyle(n).transitionDuration),
  ).toContain("0.28s");
  // Observe page animations without relying on their short visible duration.
  await page.locator("main").evaluate((node) => {
    const original = node.animate.bind(node);
    (window as unknown as { pageAnimations: number }).pageAnimations = 0;
    node.animate = (...args: Parameters<typeof node.animate>) => {
      (window as unknown as { pageAnimations: number }).pageAnimations++;
      return original(...args);
    };
  });
  await bet.click();
  expect(
    await page.evaluate(
      () => (window as unknown as { pageAnimations: number }).pageAnimations,
    ),
  ).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await nav
      .locator(".nav-indicator")
      .evaluate((n) => getComputedStyle(n).transitionDuration),
  ).toBe("0s");
  const count = await page.evaluate(
    () => (window as unknown as { pageAnimations: number }).pageAnimations,
  );
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { pageAnimations: number }).pageAnimations,
    ),
  ).toBe(count);
});

test("navigation selection updates immediately and remains aligned after rapid switches and submenu changes", async ({
  page,
}) => {
  const nav = page.getByRole("navigation", { name: "主要导航" });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const overview = nav.getByRole("button", { name: "本期概览", exact: true });
    await overview.click();
    const colors = await nav.evaluate((node) => ({
      active: getComputedStyle(node.querySelector(".nav-link.active")!).color,
      inactive: getComputedStyle(
        node.querySelector('.nav-link[aria-label="录入投注"]')!,
      ).color,
    }));
    // Sample the first frame of a real transition, before the glass finishes sliding.
    const firstFrame = await nav.evaluate(async (node) => {
      const previous = node.querySelector<HTMLElement>(".nav-link.active")!;
      const next = node.querySelector<HTMLButtonElement>(
        '.nav-link[aria-label="本期统计"]',
      )!;
      next.click();
      await new Promise(requestAnimationFrame);
      return {
        previous: getComputedStyle(previous).color,
        next: getComputedStyle(next).color,
        active: next.getAttribute("aria-current"),
      };
    });
    expect(firstFrame).toEqual({
      previous: colors.inactive,
      next: colors.active,
      active: "page",
    });

    const statistics = nav.getByRole("button", {
      name: "本期统计",
      exact: true,
    });
    const disclosure = nav.getByRole("button", {
      name: /(?:展开|收起)本期统计二级菜单/,
    });
    if ((await statistics.getAttribute("aria-expanded")) !== "true") {
      if (width <= 960) await statistics.click();
      else await disclosure.click();
    }
    await expect(nav.getByLabel("本期统计分类")).toBeVisible();
    // These clicks interrupt the indicator while removing/reinserting the submenu.
    await nav.evaluate(async (node) => {
      for (const name of [
        "官方频道",
        "本期统计",
        "录入投注",
        "本期统计",
        "本期统计",
        "历史统计",
      ]) {
        node
          .querySelector<HTMLButtonElement>(`.nav-link[aria-label="${name}"]`)!
          .click();
        await new Promise(requestAnimationFrame);
      }
    });
    const history = nav.getByRole("button", { name: "历史统计", exact: true });
    await expect(nav.locator(".nav-link[aria-current='page']")).toHaveCount(1);
    await expect(history).toHaveAttribute("aria-current", "page");
    await expect
      .poll(async () => {
        const [surface, button] = await Promise.all([
          nav.locator(".nav-indicator").boundingBox(),
          history.boundingBox(),
        ]);
        return Math.max(
          Math.abs(surface!.x - button!.x),
          Math.abs(surface!.y - button!.y),
          Math.abs(surface!.width - button!.width),
          Math.abs(surface!.height - button!.height),
        );
      })
      .toBeLessThan(1);
    await expect(nav.locator(".nav-submenu")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "历史统计", exact: true }),
    ).toBeVisible();
  }
});

test("statistics summaries show category-specific amounts, profit direction, pending and empty states", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  let report = reportFixture(boot.today.id);
  await page.route("**/api/periods/*/statistics*", (route) =>
    route.fulfill({ json: report }),
  );
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "本期统计", exact: true }).click();
  await nav
    .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
    .click();
  const cards = page.getByLabel("分类统计摘要");
  await expect(cards).toContainText("自留本金");
  await expect(cards).toContainText("¥ 60.01");
  await nav.getByRole("button", { name: "飞出受注统计", exact: true }).click();
  await expect(cards).not.toContainText("自留本金");
  await expect(cards).toContainText("飞出受注方");
  await expect(cards).toContainText("¥ 40.00");
  await expect(cards).toContainText("1 人");
  await expect(cards).toContainText("2 条");
  await expect(cards).toContainText("−¥ 21.00");
  await expect(cards.locator(".negative")).toContainText("−¥ 21.00");
  await nav
    .getByRole("button", { name: "投注人分类统计", exact: true })
    .click();
  await expect(cards).toContainText("3 人");
  await expect(cards).toContainText("¥ 33.34");
  await expect(cards.locator(".positive")).toHaveText("+¥ 1.00");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/navigation-mobile-statistics.png",
  });
  await page.setViewportSize({ width: 1440, height: 1080 });
  report = reportFixture(boot.today.id, false);
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(cards).toContainText("待结算");
  await expect(cards.locator(".positive, .negative")).toHaveCount(0);
  report = {
    ...report,
    incoming: totals(0, null),
    bettors: [],
    receivers: [],
    outgoing: totals(0, null),
  };
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(cards).toContainText("0 人");
  await expect(cards).toContainText("¥ 0.00");
  await expect(cards).not.toContainText("NaN");
  // A fully voided customer/receiver remains in the API grouping, but is not active.
  const voidTotals = {
    records: 0,
    units: 0,
    stake: 0,
    rebate: 0,
    payout: 0,
    refunded: 1000,
    net: 0,
  };
  report = {
    ...report,
    settled: true,
    incoming: voidTotals,
    outgoing: voidTotals,
    bettors: [{ name: "和局客户", totals: voidTotals }],
    receivers: [{ name: "和局受注方", totals: voidTotals }],
  };
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(cards).toContainText("0 人");
  await expect(cards).not.toContainText("NaN");
  await expect(cards).not.toContainText("Infinity");
  await nav.getByRole("button", { name: "飞出受注统计", exact: true }).click();
  await expect(cards).toContainText("0 人");
  await expect(cards).toContainText("0 条");
  await expect(cards).toContainText("和局退本 ¥ 10.00");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("historical periods remain individually closable navigation tabs without deleting records", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const periods: Period[] = ["2026285", "2026286", "2026287"].map((id, i) => ({
    ...boot.today,
    id,
    business_date: `2026-10-${12 + i}`,
    state: "settled",
    phase: "settled",
  }));
  const mutations: string[] = [];
  page.on("request", (req) => {
    if (
      req.method() !== "GET" &&
      req.url().includes("/api/") &&
      !req.url().endsWith("/records/search")
    )
      mutations.push(req.url());
  });
  await page.route("**/api/periods?*", (route) =>
    route.fulfill({
      json: { items: periods, total: 3, page: 1, page_size: 20 },
    }),
  );
  await page.route("**/api/periods/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const period = periods.find((p) => path.split("/")[3] === p.id);
    if (!period) return route.fallback();
    if (path.endsWith("/statistics"))
      return route.fulfill({ json: reportFixture(period.id) });
    if (path.endsWith("/bet-filters"))
      return route.fulfill({
        json: { period: period.id, bettors: [], plays: [] },
      });
    return route.fulfill({ json: period });
  });
  const nav = page.getByRole("navigation", { name: "主要导航" });
  const history = nav.getByRole("button", { name: "历史统计", exact: true });
  await history.click();
  for (const [index, period] of periods.entries()) {
    if (index > 0)
      await page
        .getByRole("button", { name: "返回历史统计", exact: true })
        .click();
    await page
      .locator(".history-panel tbody tr")
      .filter({ hasText: period.id })
      .getByRole("button", { name: "查看" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: `历史统计 · 第 ${period.id} 期`,
        exact: true,
      }),
    ).toBeVisible();
  }
  const tabs = nav.getByLabel("已打开的历史期次");
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  await history.click();
  if (
    await nav
      .getByRole("button", { name: "展开历史统计二级菜单", exact: true })
      .count()
  )
    await nav
      .getByRole("button", { name: "展开历史统计二级菜单", exact: true })
      .click();
  await expect(tabs.locator(".history-tab")).toHaveCount(3);
  await tabs
    .getByRole("button", { name: "第 2026287 期", exact: true })
    .click();
  await expect(tabs.locator(".history-tab")).toHaveCount(3);
  // Close a background tab while keeping the active period unchanged.
  await nav.getByRole("button", { name: "关闭第 2026286 期标签" }).click();
  await expect(
    page.getByRole("heading", {
      name: "历史统计 · 第 2026287 期",
      exact: true,
    }),
  ).toBeVisible();
  await nav
    .getByRole("button", { name: "收起历史统计二级菜单", exact: true })
    .click();
  await expect(tabs).toHaveCount(0);
  await nav
    .getByRole("button", { name: "展开历史统计二级菜单", exact: true })
    .click();
  await expect(tabs.locator(".history-tab")).toHaveCount(2);
  await page.setViewportSize({ width: 320, height: 844 });
  for (const close of await tabs.locator(".history-tab-close").all()) {
    const box = (await close.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await nav.getByRole("button", { name: "关闭第 2026287 期标签" }).click();
  await expect(
    page.getByRole("heading", {
      name: "历史统计 · 第 2026285 期",
      exact: true,
    }),
  ).toBeVisible();
  await nav.getByRole("button", { name: "关闭第 2026285 期标签" }).click();
  await expect(
    page.getByRole("heading", { name: "历史统计", exact: true }),
  ).toBeVisible();
  await expect(nav.locator(".history-tab")).toHaveCount(0);
  await expect(history).toBeFocused();
  await expect(page.locator(".history-panel tbody tr")).toHaveCount(3);
  expect(mutations).toEqual([]);
});
