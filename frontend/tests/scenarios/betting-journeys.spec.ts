import { test, expect } from "./scenario-fixtures";
import AxeBuilder from "@axe-core/playwright";
import { money } from "../../src/lib/types";
declare global {
  interface Window {
    clip?: string;
  }
}
import { signIn, textMode, check } from "./customer-fixtures";
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
  await expect(page.getByLabel("统计市场", { exact: true })).toHaveCount(0);
  const distribution = page.getByRole("region", { name: "受注金额分布" });
  const marketSwitch = distribution.getByRole("group", {
    name: "受注统计市场",
    exact: true,
  });
  await expect(marketSwitch).toBeVisible();
  await expect(
    marketSwitch.getByRole("button", { name: "新澳门", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  for (const [market, title] of [
    ["hk", "香港"],
    ["macau", "新澳门"],
  ]) {
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/received-display") &&
        url.searchParams.get("market") === market &&
        response.ok()
      );
    });
    await marketSwitch
      .getByRole("button", { name: title, exact: true })
      .click();
    const received = (await (await response).json()).display;
    if (market === "hk")
      expect(received.special[21]).toBeGreaterThanOrEqual(10000);
    await expect(
      distribution.getByRole("listitem").nth(21).locator("strong"),
    ).toHaveText(money(received.special[21]));
    await expect(
      marketSwitch.getByRole("button", { name: title, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
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
  await expect(page.getByLabel("统计市场", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "受注统计市场", exact: true }),
  ).toHaveCount(0);
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
  await expect(
    page.getByRole("button", { name: "本期统计", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "全部受注统计", exact: true }).click();
  let releaseFont!: () => void;
  const fontGate = new Promise<void>((resolve) => {
    releaseFont = resolve;
  });
  await page.route("**/NotoSansSC-Regular.ttf", async (route) => {
    await fontGate;
    await route.continue();
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出账单（全部投注人）" }).click();
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
  await page.getByRole("radio", { name: "香港", exact: true }).check();
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

for (const width of [390, 1440]) {
  test(`repeated bets and hyphen lists keep their units through manual and text submission at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
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
    await page.getByLabel("输入投注项").fill("09-21-09-33-21-09");
    await expect(page.getByLabel("输入投注项")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    await expect(
      page
        .locator(".bet-summary .ledger-row")
        .filter({ hasText: "基础注数量" }),
    ).toContainText("6 注");
    const manual = `synthetic-repeated-manual-${width}-${Date.now()}`;
    await page.getByPlaceholder("手工填写姓名或代号").fill(manual);
    await page
      .getByRole("textbox", { name: "每注金额", exact: true })
      .fill("100");
    const sent = page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/api\/bets$/.test(r.url()),
    );
    await page
      .getByRole("button", { name: "确认录入投注", exact: true })
      .click();
    const response = await sent;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().selections).toEqual([
      9, 9, 9, 21, 21, 33,
    ]);
    await textMode(page);
    const bettor = `synthetic-repeated-text-${width}-${Date.now()}`;
    const modal = await check(
      page,
      "09.21.33.45.39.10.46.14.09.45.14.09.07.33.34各100\n1-2-3-4-5-6各100\n21注共2100",
      bettor,
    );
    const slip = page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/api\/slips$/.test(r.url()),
    );
    await modal.getByRole("button", { name: "确认录入", exact: true }).click();
    expect((await slip).ok()).toBe(true);
    await expect(modal).toBeHidden();
    const boot = await (await page.request.get("/api/bootstrap")).json();
    for (const [name, units, stake] of [
      [manual, 6, 60000],
      [bettor, 21, 210000],
    ] as const) {
      const records = await page.request.post("/api/records/search", {
        headers: { "X-Marksix": "1" },
        data: { period: boot.today.id, bettors: [name] },
      });
      expect(records.ok()).toBe(true);
      const data = await records.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].unit_count).toBe(units);
      expect(data.items[0].stake).toBe(stake);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

for (const sample of [
  {
    name: "bare-zodiac-and-postfix-prices",
    raw: "狗各25，牛兔各数5，33特50，09，30各25，复式四有龙牛狗兔马虎10一组。",
    amounts: ["25", "5", "50", "25", "10"],
    units: 30,
    stake: 39000,
  },
  {
    name: "issue-prefixed-slash-lists",
    raw: "312期澳特19/39/47/28/09/06/40/30/22/34/23/42各买10米！04/16/02/38/27/21各买5米！",
    amounts: ["10", "5"],
    units: 18,
    stake: 15000,
  },
]) {
  test(`text entry prices ${sample.name} exactly without using issue metadata as money`, async ({
    page,
  }) => {
    await signIn(page);
    await textMode(page);
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const bettor = `synthetic-${sample.name}-${Date.now()}`;
    const dialog = await check(page, sample.raw, bettor);
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/slips",
    );
    await dialog.getByRole("button", { name: "确认录入", exact: true }).click();
    const saved = await response;
    expect(saved.ok()).toBe(true);
    const body = saved.request().postDataJSON();
    expect(body.period).toBe(boot.today.id);
    expect(body.items.map((item: { amount: string }) => item.amount)).toEqual(
      sample.amounts,
    );
    const slip = await (
      await page.request.get(`/api/slips/${(await saved.json()).id}`)
    ).json();
    const records = slip.items as { stake: number; unit_count: number }[];
    expect(
      records.reduce(
        (sum: number, item: { stake: number }) => sum + item.stake,
        0,
      ),
    ).toBe(sample.stake);
    expect(
      records.reduce(
        (sum: number, item: { unit_count: number }) => sum + item.unit_count,
        0,
      ),
    ).toBe(sample.units);
    if (sample.name === "issue-prefixed-slash-lists") {
      expect(
        body.items.map((item: { selections: number[] }) => item.selections),
      ).toEqual([
        [19, 39, 47, 28, 9, 6, 40, 30, 22, 34, 23, 42],
        [4, 16, 2, 38, 27, 21],
      ]);
    } else {
      expect(
        body.items
          .slice(2, 4)
          .map((item: { selections: number[] }) => item.selections),
      ).toEqual([[33], [9, 30]]);
      expect(
        body.items.map(
          (item: { play_id: number }) =>
            boot.plays.find((play: { id: number }) => play.id === item.play_id)
              .rule.name,
        ),
      ).toEqual(["特码", "特码", "特码", "特码", "四有"]);
    }
    await expect(dialog).toBeHidden();
  });
}

for (const sample of [
  {
    name: "linked-aliases-and-rare-monkey",
    raw: "5友复式牛龙兔狗猴马各150元，5友牛龙兔狗猴／100\n5友复式牛羊虎鸡猪𤠣各80\n总1480",
    amounts: ["150", "100", "80"],
    units: 13,
    stake: 148000,
    selections: [
      [1, 4, 3, 10, 8, 6],
      [1, 4, 3, 10, 8],
      [1, 7, 2, 9, 11, 8],
    ],
  },
  {
    name: "dotted-pools-and-alternating-prices",
    raw: "特29，33，34各200元，30.31.32.35.36.37.38各100\n特08.200.26.100.二有牛狗200\n总1800",
    amounts: ["200", "100", "200", "100", "200"],
    units: 13,
    stake: 180000,
    selections: [
      [29, 33, 34],
      [30, 31, 32, 35, 36, 37, 38],
      [8],
      [26],
      [1, 10],
    ],
  },
  {
    name: "suffix-prices-qualified-drag-and-double-slash",
    raw: "奥虎兔特各90元一肖，28码60元，特04.07.12.15.18.20.23.28.各2O元一甲数，奥三有虎兔猴80元。\n六尾拖九尾，二中二，韩特各六元\n十不中06.30.20.32.10.46.26.38.11.31//200\n总830",
    amounts: ["90", "60", "20", "80", "6", "200"],
    units: 44,
    stake: 83000,
    selections: [
      [],
      [28],
      [4, 7, 12, 15, 18, 20, 23, 28],
      [2, 3, 8],
      [],
      [6, 30, 20, 32, 10, 46, 26, 38, 11, 31],
    ],
  },
]) {
  test(`colloquial text ${sample.name} persists exact options and prices`, async ({
    page,
  }) => {
    await signIn(page);
    await textMode(page);
    const dialog = await check(
      page,
      sample.raw,
      `synthetic-${sample.name}-${Date.now()}`,
    );
    const sent = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/slips",
    );
    await dialog.getByRole("button", { name: "确认录入", exact: true }).click();
    const response = await sent;
    expect(response.ok()).toBe(true);
    const body = response.request().postDataJSON();
    expect(body.items.map((item: { amount: string }) => item.amount)).toEqual(
      sample.amounts,
    );
    expect(
      body.items.map((item: { selections: number[] }) => item.selections),
    ).toEqual(sample.selections);
    if (sample.name === "suffix-prices-qualified-drag-and-double-slash") {
      expect(body.items[0].package_zodiacs).toEqual([2, 3]);
      expect(body.items[4].drag).toEqual({
        left: [6, 16, 26, 36, 46],
        right: [9, 19, 29, 39, 49],
        zodiac: false,
      });
      const play = (
        await (await page.request.get("/api/bootstrap")).json()
      ).plays.find((p: { id: number }) => p.id === body.items[4].play_id);
      expect(play.rule.name).toBe("二中二含特");
    }
    const saved = await (
      await page.request.get(`/api/slips/${(await response.json()).id}`)
    ).json();
    expect(
      saved.items.reduce(
        (sum: number, item: { stake: number }) => sum + item.stake,
        0,
      ),
    ).toBe(sample.stake);
    expect(
      saved.items.reduce(
        (sum: number, item: { unit_count: number }) => sum + item.unit_count,
        0,
      ),
    ).toBe(sample.units);
    await expect(dialog).toBeHidden();
  });
}

for (const sample of [
  {
    name: "ocr-and-financial-numerals",
    raw: "澳门特码03.15个数２O元；特码07各壹佰元\n3注共140",
    amounts: ["20", "100"],
    stake: 14000,
    units: 3,
  },
  {
    name: "consistent-financial-explanations",
    raw: "特码牛虎个数20，是每个号码20；特码牛虎各肖20，这项是每肖，不是总共\n总200",
    amounts: ["20", "20"],
    stake: 20000,
    units: 16,
  },
]) {
  test(`audited text ${sample.name} reaches the ledger at its exact price`, async ({
    page,
  }) => {
    await signIn(page);
    await textMode(page);
    const dialog = await check(
      page,
      sample.raw,
      `synthetic-audit-${sample.name}-${Date.now()}`,
    );
    const sent = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/slips",
    );
    await dialog.getByRole("button", { name: "确认录入", exact: true }).click();
    const response = await sent;
    expect(response.ok()).toBe(true);
    expect(
      response
        .request()
        .postDataJSON()
        .items.map((item: { amount: string }) => item.amount),
    ).toEqual(sample.amounts);
    const saved = await (
      await page.request.get(`/api/slips/${(await response.json()).id}`)
    ).json();
    expect(
      saved.items.reduce(
        (sum: number, item: { stake: number }) => sum + item.stake,
        0,
      ),
    ).toBe(sample.stake);
    expect(
      saved.items.reduce(
        (sum: number, item: { unit_count: number }) => sum + item.unit_count,
        0,
      ),
    ).toBe(sample.units);
    await expect(dialog).toBeHidden();
  });
}

test("conflicting financial explanations and pending amount headings cannot be confirmed or written", async ({
  page,
}) => {
  await signIn(page);
  await textMode(page);
  const bettor = `synthetic-audit-blocked-${Date.now()}`;
  for (const raw of [
    "特码牛各数20，是每个号码30",
    "特码牛各数20，这项是每肖，不是总共",
    "200待定\n特码03各20",
    "上期同上\n特码03各20",
    "明天那张\n特码03各20",
  ]) {
    await page.getByLabel("投注原文").fill(raw);
    await page.getByRole("button", { name: "校验", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认投注单" });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder("填写投注人").fill(bettor);
    await expect(
      dialog.getByRole("button", { name: "确认录入", exact: true }),
    ).toBeDisabled();
    await expect(dialog.getByRole("alert").first()).toBeVisible();
    await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  }
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const records = await page.request.post("/api/records/search", {
    headers: { "X-Marksix": "1" },
    data: { period: boot.today.id, bettors: [bettor] },
  });
  expect(records.ok()).toBe(true);
  expect((await records.json()).items).toHaveLength(0);
});

test("an exact traditional personal play retains its own financial snapshot", async ({
  page,
}) => {
  await signIn(page);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const base = boot.plays.find(
    (play: { rule: { name: string } }) => play.rule.name === "特码",
  );
  const rule = {
    ...base.rule,
    name: "特碼",
    odds: "99",
    rebate_percent: "8",
    special_odds: null,
    special_rebate_percent: null,
  };
  const created = await page.request.post("/api/plays", {
    headers: { "X-Marksix": "1" },
    data: rule,
  });
  expect(created.ok()).toBe(true);
  const id = (await created.json()).id;
  try {
    await page.reload();
    await textMode(page);
    const dialog = await check(
      page,
      "特碼03各20",
      `synthetic-exact-rule-${Date.now()}`,
    );
    const sent = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/slips",
    );
    await dialog.getByRole("button", { name: "确认录入", exact: true }).click();
    const response = await sent;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().items[0]).toMatchObject({
      play_id: id,
      play_version: 1,
      selections: [3],
      amount: "20",
    });
    const saved = await (
      await page.request.get(`/api/slips/${(await response.json()).id}`)
    ).json();
    expect(saved.items[0]).toMatchObject({
      play_id: id,
      play_version: 1,
      stake: 2000,
      rebate: 160,
    });
    const detail = await (
      await page.request.get(`/api/bets/${saved.items[0].id}`)
    ).json();
    expect(detail.record.rule).toMatchObject({
      name: "特碼",
      odds: "99",
      rebate_percent: "8",
    });
    expect(detail.atoms[0]).toMatchObject({
      odds: "99",
      stake: 2000,
      rebate: 160,
    });
    await expect(dialog).toBeHidden();
  } finally {
    const removed = await page.request.delete(`/api/plays/${id}`, {
      headers: { "X-Marksix": "1" },
      data: { version: 1 },
    });
    expect(removed.ok()).toBe(true);
  }
});
