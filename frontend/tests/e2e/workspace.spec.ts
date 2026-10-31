import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
declare global {
  interface Window {
    clip?: string;
  }
}
async function signIn(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "" },
    });
  });
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("navigation", { name: "主要导航" }),
  ).toBeVisible();
  const response = await page.request.put("/api/settings/features", {
    headers: { "X-Marksix": "1" },
    data: { layoffs: false, manual_entry: true, text_entry: true },
  });
  expect(response.ok()).toBe(true);
}
async function textMode(page: Page) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  await expect(page.getByLabel("投注原文")).toBeVisible();
}
async function check(page: Page, raw: string, bettor: string) {
  await page.getByLabel("投注原文").fill(raw);
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await expect(modal).toBeVisible();
  await modal.getByPlaceholder("填写投注人").fill(bettor);
  await expect(
    modal.getByRole("button", { name: "确认录入", exact: true }),
  ).toBeEnabled();
  return modal;
}
test("text entry previews, commits exactly once, and keeps the latest mode", async ({
  page,
}) => {
  await signIn(page);
  await textMode(page);
  const name = `text-${Date.now()}`;
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/slips")) writes++;
  });
  const modal = await check(page, "尾中0尾各100；红波100", name);
  expect(writes).toBe(0);
  await modal.getByRole("button", { name: "确认录入", exact: true }).click();
  await expect(modal).toBeHidden();
  expect(writes).toBe(1);
  await page.reload();
  await textMode(page);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  expect(boot.features.entry_mode).toBe("text");
  const search = await (
    await page.request.post("/api/records/search", {
      headers: { "X-Marksix": "1" },
      data: { period: boot.today.id, bettors: [name] },
    })
  ).json();
  expect(search.items).toHaveLength(1);
  expect(search.items[0].stake).toBe(20000);
});
test("lost success response is recovered across refresh", async ({ page }) => {
  await signIn(page);
  await textMode(page);
  const name = `recovery-${Date.now()}`;
  let posts = 0;
  await page.route("**/api/slips", async (route) => {
    posts++;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort("failed");
  });
  const modal = await check(page, "3尾5000", name);
  await modal.getByRole("button", { name: "确认录入", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((k) =>
          k.startsWith("marksix:pending-text:"),
        ),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((k) =>
          k.startsWith("marksix:pending-text:"),
        ),
      ),
    )
    .toBe(false);
  expect(posts).toBe(1);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const rows = await (
    await page.request.post("/api/records/search", {
      headers: { "X-Marksix": "1" },
      data: { period: boot.today.id, bettors: [name] },
    })
  ).json();
  expect(rows.items).toHaveLength(1);
});
test("manual entry writes selected objects and declared money", async ({
  page,
}) => {
  await signIn(page);
  await page.request.put("/api/settings/entry-mode", {
    headers: { "X-Marksix": "1" },
    data: { entry_mode: "manual" },
  });
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByLabel("搜索玩法名称").fill("特码");
  await page
    .locator(".play-picker button")
    .filter({ has: page.locator("span", { hasText: /^特码$/ }) })
    .click();
  await page.getByRole("button", { name: /^07 / }).click();
  await page
    .getByPlaceholder("手工填写姓名或代号")
    .fill(`manual-${Date.now()}`);
  await page
    .getByRole("textbox", { name: "每注金额", exact: true })
    .fill("25.5");
  const submitted = page.waitForRequest(
    (r) => r.method() === "POST" && /\/api\/(bets|slips)$/.test(r.url()),
  );
  await page.getByRole("button", { name: "确认录入投注", exact: true }).click();
  const body = (await submitted).postDataJSON();
  expect(body.amount ?? body.items?.[0].amount).toBe("25.5");
});
test("disabled entry modules hide navigation and server rejects bypass", async ({
  page,
}) => {
  await signIn(page);
  await page.request.put("/api/settings/features", {
    headers: { "X-Marksix": "1" },
    data: { layoffs: false, manual_entry: false, text_entry: false },
  });
  await page.reload();
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "录入投注", exact: true }),
  ).toBeHidden();
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const p = boot.plays.find(
    (p: { rule: { name: string } }) => p.rule.name === "特码",
  );
  const r = await page.request.post("/api/slips", {
    headers: { "X-Marksix": "1" },
    data: {
      period: boot.today.id,
      bettor: "bypass",
      request_id: crypto.randomUUID(),
      entry_mode: "text",
      items: [
        {
          play_id: p.id,
          play_version: p.version,
          selections: [1],
          compound: false,
          amount: "10",
        },
      ],
    },
  });
  expect(r.status()).toBe(403);
  await page.request.put("/api/settings/features", {
    headers: { "X-Marksix": "1" },
    data: { layoffs: false, manual_entry: true, text_entry: true },
  });
});
for (const width of [390, 1440])
  test(`login and confirmation stay accessible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await textMode(page);
    const modal = await check(page, "4尾500", `viewport-${width}`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const result = await new AxeBuilder({ page })
      .include("dialog")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(result.violations).toEqual([]);
    await page.getByRole("button", { name: "关闭对话框" }).click();
    await expect(modal).toBeHidden();
  });
test("returning to foreground offers related clipboard text but not the last recorded original", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window;
    state.clip = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => state.clip },
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
  });
  // This scenario uses its own clipboard provider rather than the empty provider in signIn.
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.request.put("/api/settings/features", {
    headers: { "X-Marksix": "1" },
    data: { layoffs: false, manual_entry: true, text_entry: true },
  });
  await page.reload();
  await expect(page.getByRole("navigation")).toBeVisible();
  const raw = "尾中8尾各125";
  await page.evaluate((raw) => {
    window.clip = raw;
    window.dispatchEvent(new Event("focus"));
  }, raw);
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await expect(modal).toBeVisible();
  await modal.getByPlaceholder("填写投注人").fill(`clip-${Date.now()}`);
  await modal.getByRole("button", { name: "确认录入", exact: true }).click();
  await expect(modal).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);
  await expect(modal).toBeHidden();
});

test("mixed markets share daily overview, statistics and export with per-entry labels", async ({
  page,
}) => {
  await signIn(page);
  await textMode(page);
  const name = `synthetic-markets-${Date.now()}`;
  const dialog = await check(page, "新澳 三友 狗牛虎100\n港 特22. 100", name);
  await expect(dialog.getByLabel("第2项市场", { exact: true })).toHaveValue(
    "hk",
  );
  await dialog.getByRole("button", { name: "确认录入", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "本期概览", exact: true })
    .click();
  await expect(page.getByLabel("统计市场")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "新澳门开奖", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "香港开奖", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("盘口风险洞察")).toHaveCount(0);
  await expect(page.getByText("最大可能净盈利")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include("main")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("combined-overview.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  expect(boot.hk.market).toBe("hk");
  expect(boot.hk.totals.stake).toBeGreaterThanOrEqual(10000);
  const response = await page.request.post("/api/records/search", {
    headers: { "X-Marksix": "1" },
    data: { period: boot.today.id, combined: true, bettors: [name] },
  });
  const records = await response.json();
  expect(records.items).toHaveLength(1);
  expect(
    records.items[0].items.map((item: { market: string }) => item.market),
  ).toEqual(["macau", "hk"]);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "本期统计", exact: true })
    .click();
  await expect(page.getByLabel("统计市场")).toHaveCount(0);
  const stats = await (
    await page.request.get(
      `/api/periods/${boot.today.id}/statistics?combined=true`,
    )
  ).json();
  expect(
    stats.bettors.find((b: { name: string }) => b.name === name).totals.stake,
  ).toBe(20000);
  const exported = await (
    await page.request.get(
      `/api/periods/${boot.today.id}/bettor-export?combined=true`,
    )
  ).json();
  const bettor = exported.bettors.find(
    (b: { name: string }) => b.name === name,
  );
  expect(bettor.totals.stake).toBe(20000);
  expect(
    bettor.bets.map((b: { record: { market: string } }) => b.record.market),
  ).toEqual(["macau", "hk"]);
  expect(boot.day.totals.stake).toBe(
    boot.today.totals.stake + boot.hk.totals.stake,
  );
  await page.getByRole("button", { name: "展开本期统计二级菜单" }).click();
  await page
    .getByRole("button", { name: "投注人分类统计", exact: true })
    .click();
  let releaseFont!: () => void;
  const fontGate = new Promise<void>((resolve) => {
    releaseFont = resolve;
  });
  await page.route("**/NotoSansSC-Regular.ttf", async (route) => {
    await fontGate;
    await route.continue();
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出全部投注人账单" }).click();
  await expect(page.getByText("正在准备中文对账单…")).toBeVisible();
  const refreshed = page.waitForResponse((r) =>
    r.url().includes("/statistics?page="),
  );
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await refreshed;
  releaseFont();
  const file = await download;
  expect(file.suggestedFilename()).toBe(
    `${boot.day.business_date}-投注人对账单-pdf.zip`,
  );
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const { unzipSync } = await import("fflate");
  const files = unzipSync(Buffer.concat(chunks));
  const { PDFDocument } = await import("pdf-lib");
  expect((await PDFDocument.load(files[`${name}.pdf`])).getTitle()).toContain(
    boot.day.business_date,
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "历史统计", exact: true })
    .click();
  await page.getByLabel("搜索期号或日期").fill(boot.day.business_date);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  const dayRow = page
    .getByRole("row")
    .filter({ hasText: boot.day.business_date });
  await expect(dayRow).toHaveCount(1);
  await dayRow.getByRole("button", { name: "查看", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: `历史统计 · ${boot.day.business_date}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "香港开奖", exact: true }),
  ).toBeVisible();
});

test("manual Hong Kong entry retains its market without requesting risk predictions", async ({
  page,
}) => {
  const predictionRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/(quote|risk)(?:\?|$)/u.test(request.url()))
      predictionRequests.push(request.url());
  });
  await signIn(page);
  await page.request.put("/api/settings/entry-mode", {
    headers: { "X-Marksix": "1" },
    data: { entry_mode: "manual" },
  });
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByLabel("投注市场").selectOption("hk");
  await page.getByLabel("搜索玩法名称").fill("特码");
  await page
    .locator(".play-picker button")
    .filter({ has: page.locator("span", { hasText: /^特码$/ }) })
    .click();
  await page.getByRole("button", { name: /^07 / }).click();
  await page.getByPlaceholder("手工填写姓名或代号").fill("synthetic-hk-manual");
  await page.getByRole("textbox", { name: "每注金额", exact: true }).fill("25");
  const submitted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/bets"),
  );
  await page.getByRole("button", { name: "确认录入投注", exact: true }).click();
  const response = await submitted;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().market).toBe("hk");
  expect(predictionRequests).toEqual([]);
  await expect(page.getByText("投注者收益预览")).toHaveCount(0);
});
