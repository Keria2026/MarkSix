import { test, expect } from "./scenario-fixtures";
import type { Page } from "@playwright/test";
import { plays } from "../contracts/fixtures";
import { annualMapping } from "../../src/lib/types";

// Interface contract only. Database and financial API behavior have separate tests.
async function openText(page: Page, configured = plays) {
  const writes: object[] = [];
  const totals = Object.fromEntries(
    [
      "records",
      "units",
      "stake",
      "rebate",
      "exposure",
      "payout",
      "winning_stake",
      "losing_stake",
      "gross",
      "refunded",
      "flyout_stake",
      "flyout_net",
      "retained_net",
      "net",
    ].map((k) => [k, 0]),
  );
  const features = {
    layoffs: false,
    manual_entry: true,
    text_entry: true,
    entry_mode: "text",
  };
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "" },
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let json: unknown = {};
    if (path === "/api/site") json = { mode: "hosted" };
    else if (path === "/api/session") json = { username: "synthetic-browser" };
    else if (path === "/api/license")
      json = { active: true, hosted: true, permanent: true };
    else if (path === "/api/bootstrap")
      json = {
        features,
        plays: configured,
        zodiacs: [],
        day: {
          id: "2040001",
          business_date: "2040-01-01",
          phase: "open",
          state: "pending",
          totals,
          periods: [],
        },
        today: {
          id: "2040001",
          business_date: "2040-01-01",
          phase: "open",
          state: "pending",
          accepting_entries: true,
          mapping: annualMapping(2026),
          bet_version: 0,
          draw: null,
          totals,
          server_time: new Date().toISOString(),
        },
      };
    else if (path === "/api/records/search")
      json = { items: [], total: 0, page: 1, page_size: 25 };
    else if (path.endsWith("/bet-filters")) json = { bettors: [], plays: [] };
    else if (path.endsWith("/statistics")) json = { period: "unused" };
    else if (path === "/api/parties") json = { bettors: [], receivers: [] };
    else if (path === "/api/text-entry/preferences") json = [];
    else if (path === "/api/text-entry/bettor-preference")
      json = { preference: null };
    else if (path.startsWith("/api/slips/submission/")) json = { id: null };
    else if (path === "/api/slips/preview") {
      const { items } = request.postDataJSON();
      const quotes = items.map(
        (item: {
          play_id: number;
          amount: string;
          package_zodiacs?: number[];
        }) => {
          const name = configured.find((p) => p.id === item.play_id)!.rule.name;
          const units =
            name === "三有"
              ? 10
              : name === "四有"
                ? 5
                : name === "五有"
                  ? 1
                  : item.package_zodiacs?.length
                    ? 8
                    : 2;
          return {
            units,
            stake:
              (item.package_zodiacs?.length || units) *
              Number(item.amount) *
              100,
            error: null,
          };
        },
      );
      json = {
        valid: true,
        items: quotes,
        units: quotes.reduce(
          (s: number, q: { units: number }) => s + q.units,
          0,
        ),
        stake: quotes.reduce(
          (s: number, q: { stake: number }) => s + q.stake,
          0,
        ),
        error: null,
      };
    } else if (path === "/api/slips") {
      writes.push(request.postDataJSON());
      json = { id: "synthetic-receipt" };
    } else {
      await route.fulfill({
        status: 404,
        json: { error: `Unhandled fixture: ${path}` },
      });
      return;
    }
    await route.fulfill({ json });
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await expect(page.getByLabel("投注原文")).toBeVisible();
  return writes;
}

test("multiple plays and summary can be edited before a single financial request", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const writes = await openText(page);
  await page
    .getByLabel("投注原文")
    .fill("鼠牛虎兔龙复试345有每组40\n　十六组共640");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await modal.getByPlaceholder("填写投注人").fill("合成投注人");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  expect(writes).toHaveLength(0);
  await expect(modal.locator(".text-entry-rows > li")).toHaveCount(4);
  await expect(modal.getByLabel(/^第\d+项金额$/)).toHaveCount(3);
  await modal.getByLabel("第1项金额", { exact: true }).fill("50");
  await expect(submit).toBeDisabled();
  await expect(modal.getByText(/原文合计与投注不符/)).toBeVisible();
  await modal.getByLabel("第4项投注项", { exact: true }).fill("16组共740");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(modal).toBeHidden();
  expect(writes).toHaveLength(1);
  const body = writes[0] as {
    items: { play_id: number; amount: string }[];
    request_id: string;
  };
  expect(
    body.items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["三有", "四有", "五有"]);
  expect(body.items.map((i) => i.amount)).toEqual(["50", "40", "40"]);
  expect(body.request_id).toMatch(/^[\da-f-]{36}$/u);
  expect(errors).toEqual([]);
});

test("each-zodiac defaults to special packages and allows a different play", async ({
  page,
}) => {
  await openText(page);
  await page.getByLabel("投注原文").fill("牛龙各肖80");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await modal.getByPlaceholder("填写投注人").fill("合成投注人");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  await expect(modal.getByText(/包肖 牛、龙/)).toBeVisible();
  await modal
    .getByLabel("第1项对应玩法", { exact: true })
    .selectOption(String(plays.find((p) => p.rule.name === "一肖中")!.id));
  await expect(submit).toBeEnabled();
  await modal
    .getByLabel("第1项对应玩法", { exact: true })
    .selectOption(String(plays.find((p) => p.rule.name === "特码")!.id));
  await expect(submit).toBeEnabled();
  await expect(modal.getByText(/包肖 牛、龙/)).toBeVisible();
});

test("pinyin and reordered fields submit their normalized selections", async ({
  page,
}) => {
  const writes = await openText(page);
  await page
    .getByLabel("投注原文")
    .fill(
      "xin ao er you ma yang each group shi qi；san shi yi、si shi qi te 各35",
    );
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await modal.getByPlaceholder("填写投注人").fill("合成投注人");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(modal).toBeHidden();
  expect(writes).toHaveLength(1);
  const body = writes[0] as {
    items: { play_id: number; selections: number[]; amount: string }[];
  };
  expect(
    body.items.map((i) => ({
      play: plays.find((p) => p.id === i.play_id)!.rule.name,
      selections: i.selections,
      amount: i.amount,
    })),
  ).toEqual([
    { play: "二有", selections: [6, 7], amount: "17" },
    { play: "特码", selections: [31, 47], amount: "35" },
  ]);
});

test("each-number homophones and linked tails retain their meanings through confirmation", async ({
  page,
}) => {
  const writes = await openText(page);
  await page
    .getByLabel("投注原文")
    .fill("牛个数70 马牛个数90 羊兔马牛个数90\n268三连尾80 359三连尾60");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await modal.getByPlaceholder("填写投注人").fill("synthetic-tail-entry");
  await expect(modal.locator(".text-entry-rows > li")).toHaveCount(5);
  const special = String(plays.find((p) => p.rule.name === "特码")!.id);
  const tail = String(plays.find((p) => p.rule.name === "三尾连")!.id);
  for (const [index, id] of [special, special, special].entries()) {
    await expect(
      modal.getByLabel(`第${index + 1}项对应玩法`, { exact: true }),
    ).toHaveValue(id);
  }
  await expect(
    modal.getByRole("combobox", { name: "“三连尾”对应玩法", exact: true }),
  ).toHaveValue(tail);
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  expect(writes).toHaveLength(0);
  await submit.click();
  await expect(modal).toBeHidden();
  expect(writes).toHaveLength(1);
  const { items } = writes[0] as {
    items: {
      play_id: number;
      selections: number[];
      amount: string;
      package_zodiacs?: number[];
      compound: boolean;
    }[];
  };
  expect(
    items.map((i) => ({
      play: plays.find((p) => p.id === i.play_id)!.rule.name,
      selections: i.selections,
      amount: i.amount,
    })),
  ).toEqual([
    { play: "特码", selections: [6, 18, 30, 42], amount: "70" },
    {
      play: "特码",
      selections: [1, 6, 13, 18, 25, 30, 37, 42, 49],
      amount: "90",
    },
    {
      play: "特码",
      selections: [
        1, 4, 6, 12, 13, 16, 18, 24, 25, 28, 30, 36, 37, 40, 42, 48, 49,
      ],
      amount: "90",
    },
    { play: "三尾连", selections: [2, 6, 8], amount: "80" },
    { play: "三尾连", selections: [3, 5, 9], amount: "60" },
  ]);
  expect(items.every((i) => !i.compound && !i.package_zodiacs)).toBe(true);
});

test("leading totals validate future rows and track edits", async ({
  page,
}) => {
  await openText(page);
  await page
    .getByLabel("投注原文")
    .fill(
      "合计先写：16组，共560。\n下面这些：马羊猴鸡狗，复式，3/4/5连肖，一组35米。",
    );
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await modal.getByPlaceholder("填写投注人").fill("合成投注人");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  await modal.getByLabel("第2项金额", { exact: true }).fill("45");
  await expect(submit).toBeDisabled();
  await modal.getByLabel("第1项投注项", { exact: true }).fill("16组共660");
  await expect(submit).toBeEnabled();
});

test("cancellation headings preserve the whole source and block submission", async ({
  page,
}) => {
  const writes = await openText(page);
  const raw = "取消这张\n二有龙蛇各35";
  await page.getByLabel("投注原文").fill(raw);
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await modal.getByPlaceholder("填写投注人").fill("合成投注人");
  await expect(modal.getByLabel("第1项投注项", { exact: true })).toHaveValue(
    raw,
  );
  await expect(
    modal.getByRole("button", { name: "确认录入", exact: true }),
  ).toBeDisabled();
  expect(writes).toHaveLength(0);
});

test("confirmation traps keyboard focus and Escape restores the initiating control", async ({
  page,
}) => {
  await openText(page);
  await page.getByLabel("投注原文").fill("三有龙蛇兔各35");
  const trigger = page.getByRole("button", { name: "校验", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "确认投注单" });
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 18; index++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
  }
  for (let index = 0; index < 3; index++) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("confirmation.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.body.style.position)).not.toBe(
    "fixed",
  );
  await expect(page.getByLabel("投注原文")).toHaveValue("三有龙蛇兔各35");
});

test("a mixed Macau and Hong Kong slip keeps market choices in the confirmed request", async ({
  page,
}) => {
  const writes = await openText(page);
  await page.getByLabel("投注原文").fill("特码12各100香港\n特码13澳门各200");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认投注单" });
  await expect(dialog.getByLabel("第1项市场", { exact: true })).toHaveValue(
    "hk",
  );
  await expect(dialog.getByLabel("第2项市场", { exact: true })).toHaveValue(
    "macau",
  );
  await dialog.getByPlaceholder("填写投注人").fill("synthetic-mixed-market");
  await dialog.getByLabel("第2项市场", { exact: true }).selectOption("hk");
  await dialog.getByLabel("第2项市场", { exact: true }).selectOption("macau");
  await dialog.getByRole("button", { name: "确认录入", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(writes).toHaveLength(1);
  const items = (
    writes[0] as {
      items: { market?: string; amount: string; selections: number[] }[];
    }
  ).items;
  expect(
    items.map((i) => ({
      market: i.market ?? "macau",
      amount: i.amount,
      selections: i.selections,
    })),
  ).toEqual([
    { market: "hk", amount: "100", selections: [12] },
    { market: "macau", amount: "200", selections: [13] },
  ]);
});

test("conflicting market markers require an explicit choice before submission", async ({
  page,
}) => {
  const writes = await openText(page);
  await page.getByLabel("投注原文").fill("香港特码12各100澳门");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认投注单" });
  await dialog.getByPlaceholder("填写投注人").fill("synthetic-market-conflict");
  await expect(
    dialog.getByRole("button", { name: "确认录入", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel("第1项市场", { exact: true })).toHaveValue("");
  await dialog.getByLabel("第1项市场", { exact: true }).selectOption("hk");
  await dialog.getByRole("button", { name: "确认录入", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(writes).toHaveLength(1);
  expect((writes[0] as { items: { market: string }[] }).items[0].market).toBe(
    "hk",
  );
});

test("special tail pools submit explicit numbers at the divided total price", async ({
  page,
}) => {
  const writes = await openText(page);
  const previewItems: unknown[] = [];
  await page.route("**/api/slips/preview", async (route) => {
    previewItems.push(route.request().postDataJSON().items);
    await route.fulfill({
      json: {
        valid: true,
        units: 10,
        stake: 140000,
        error: null,
        items: [{ units: 10, stake: 140000, error: null }],
      },
    });
  });
  await page.getByLabel("投注原文").fill("特2尾\u00a08尾\u00a0共1400");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await expect(modal.locator(".text-entry-rows > li")).toHaveCount(1);
  await modal.getByPlaceholder("填写投注人").fill("合成尾数投注人");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  expect(writes).toHaveLength(0);
  await submit.click();
  await expect(modal).toBeHidden();
  expect(writes).toHaveLength(1);
  const body = writes[0] as {
    items: { play_id: number; selections: number[]; amount: string }[];
  };
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    play_id: plays.find((p) => p.rule.name === "特码")!.id,
    selections: [2, 12, 22, 32, 42, 8, 18, 28, 38, 48],
    amount: "140.0",
  });
  expect(previewItems.length).toBeGreaterThan(0);
  expect(
    previewItems.every(
      (items) => JSON.stringify(items) === JSON.stringify(body.items),
    ),
  ).toBe(true);
});

test("tail-to-zodiac number drag survives preview and confirmation", async ({
  page,
}) => {
  const writes = await openText(page);
  await page.route("**/api/slips/preview", async (route) => {
    await route.fulfill({
      json: {
        valid: true,
        units: 20,
        stake: 60000,
        error: null,
        items: [{ units: 20, stake: 60000, error: null }],
      },
    });
  });
  await page.getByLabel("投注原文").fill("澳二中二：8尾拖狗各组30");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await expect(modal.locator(".text-entry-rows > li")).toHaveCount(1);
  await modal.getByPlaceholder("填写投注人").fill("合成拖投注人");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  expect(writes).toHaveLength(0);
  await submit.click();
  await expect(modal).toBeHidden();
  expect(writes).toHaveLength(1);
  const body = writes[0] as { items: unknown[] };
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    play_id: plays.find((p) => p.rule.name === "二中二")!.id,
    selections: [],
    compound: true,
    amount: "30",
    drag: { left: [8, 18, 28, 38, 48], right: [9, 21, 33, 45], zodiac: false },
  });
});

test("per-group point prices inherit the number-play heading without merging pools", async ({
  page,
}) => {
  const writes = await openText(page);
  const previews: unknown[] = [];
  await page.route("**/api/slips/preview", async (route) => {
    previews.push(route.request().postDataJSON().items);
    await route.fulfill({
      json: {
        valid: true,
        units: 20,
        stake: 20000,
        error: null,
        items: [
          { units: 10, stake: 12000, error: null },
          { units: 10, stake: 8000, error: null },
        ],
      },
    });
  });
  await page
    .getByLabel("投注原文")
    .fill("二中二带特\n17.21.29.32.48/12点一组\n09.21.29.48.17/8点一组");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await expect(modal.locator(".text-entry-rows > li")).toHaveCount(2);
  await expect(modal.getByLabel("第1项金额", { exact: true })).toHaveValue(
    "12",
  );
  await expect(modal.getByLabel("第2项金额", { exact: true })).toHaveValue("8");
  await modal.getByPlaceholder("填写投注人").fill("合成分组投注人");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  expect(writes).toHaveLength(0);
  await submit.click();
  await expect(modal).toBeHidden();
  expect(writes).toHaveLength(1);
  const body = writes[0] as { items: unknown[] };
  expect(body.items).toEqual([
    {
      play_id: plays.find((p) => p.rule.name === "二中二含特")!.id,
      play_version: 1,
      selections: [17, 21, 29, 32, 48],
      compound: true,
      amount: "12",
    },
    {
      play_id: plays.find((p) => p.rule.name === "二中二含特")!.id,
      play_version: 1,
      selections: [9, 21, 29, 48, 17],
      compound: true,
      amount: "8",
    },
  ]);
  expect(previews.length).toBeGreaterThan(0);
  expect(
    previews.every(
      (items) => JSON.stringify(items) === JSON.stringify(body.items),
    ),
  ).toBe(true);
});

test("number head selections preview and submit explicit numbers at each-number prices", async ({
  page,
}) => {
  const writes = await openText(page);
  const previews: unknown[] = [];
  await page.route("**/api/slips/preview", async (route) => {
    previews.push(route.request().postDataJSON().items);
    await route.fulfill({
      json: {
        valid: true,
        units: 10,
        stake: 80000,
        error: null,
        items: [{ units: 10, stake: 80000, error: null }],
      },
    });
  });
  await page.getByLabel("投注原文").fill("特码 三头 各80");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await expect(modal.locator(".text-entry-rows > li")).toHaveCount(1);
  await modal.getByPlaceholder("填写投注人").fill("合成头数投注人");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  expect(writes).toHaveLength(0);
  await submit.click();
  await expect(modal).toBeHidden();
  expect(writes).toHaveLength(1);
  const body = writes[0] as { items: unknown[] };
  expect(body.items).toEqual([
    {
      play_id: plays.find((p) => p.rule.name === "特码")!.id,
      play_version: 1,
      selections: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39],
      amount: "80",
      compound: false,
    },
  ]);
  expect(previews.length).toBeGreaterThan(0);
  expect(
    previews.every(
      (items) => JSON.stringify(items) === JSON.stringify(body.items),
    ),
  ).toBe(true);
});

test("head tail and zodiac selectors retain the chosen number play through confirmation", async ({
  page,
}) => {
  const writes = await openText(page);
  const previews: unknown[] = [];
  await page.route("**/api/slips/preview", async (route) => {
    previews.push(route.request().postDataJSON().items);
    await route.fulfill({
      json: {
        valid: true,
        units: 29,
        stake: 90000,
        error: null,
        items: [
          { units: 10, stake: 30000, error: null },
          { units: 5, stake: 20000, error: null },
          { units: 4, stake: 20000, error: null },
          { units: 10, stake: 20000, error: null },
        ],
      },
    });
  });
  await page
    .getByLabel("投注原文")
    .fill("平码1头各30；2尾各40；蛇各数50；二中二复式蛇40各组20");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await expect(modal.locator(".text-entry-rows > li")).toHaveCount(4);
  await modal.getByPlaceholder("填写投注人").fill("合成选号投注人");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  expect(writes).toHaveLength(0);
  await submit.click();
  await expect(modal).toBeHidden();
  expect(writes).toHaveLength(1);
  const body = writes[0] as {
    items: {
      play_id: number;
      selections: number[];
      amount: string;
      compound: boolean;
    }[];
  };
  expect(
    body.items.map((i) => plays.find((p) => p.id === i.play_id)!.rule.name),
  ).toEqual(["平码", "平码", "平码", "二中二"]);
  expect(body.items.map((i) => i.selections)).toEqual([
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    [2, 12, 22, 32, 42],
    [2, 14, 26, 38],
    [2, 14, 26, 38, 40],
  ]);
  expect(body.items.map((i) => i.amount)).toEqual(["30", "40", "50", "20"]);
  expect(body.items.map((i) => i.compound)).toEqual([
    false,
    false,
    false,
    true,
  ]);
  expect(previews.length).toBeGreaterThan(0);
  expect(
    previews.every(
      (items) => JSON.stringify(items) === JSON.stringify(body.items),
    ),
  ).toBe(true);
});

for (const width of [390, 1440]) {
  test(`complete each-number wording previews and submits every number at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const writes = await openText(page);
    const previews: object[] = [];
    await page.route("**/api/slips/preview", async (route) => {
      previews.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          valid: true,
          items: [{ units: 7, stake: 42000, error: null }],
          units: 7,
          stake: 42000,
          error: null,
        },
      });
    });
    await page
      .getByLabel("投注原文")
      .fill("03-15-27-39-04-16-28 个数字60\n7注共420");
    await page.getByRole("button", { name: "校验", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "确认投注单" });
    await modal.getByPlaceholder("填写投注人").fill("synthetic-number-wording");
    await expect(modal.locator(".text-entry-rows > li")).toHaveCount(2);
    await expect(
      modal.getByText("7 注 · 本金 ¥ 420.00", { exact: true }),
    ).toBeVisible();
    await expect(modal.getByLabel("第1项金额", { exact: true })).toHaveValue(
      "60",
    );
    const submit = modal.getByRole("button", { name: "确认录入", exact: true });
    await expect(submit).toBeEnabled();
    expect(previews.length).toBeGreaterThan(0);
    expect(writes).toHaveLength(0);
    await submit.click();
    await expect(modal).toBeHidden();
    expect(writes).toHaveLength(1);
    const { items } = writes[0] as {
      items: { play_id: number; selections: number[]; amount: string }[];
    };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      play_id: plays.find((p) => p.rule.name === "特码")!.id,
      selections: [3, 15, 27, 39, 4, 16, 28],
      amount: "60",
    });
  });
}

for (const width of [390, 1440]) {
  test(`mixed slash and letter separators preserve confirmation and submission at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const writes = await openText(page);
    const previews: object[] = [];
    await page.route("**/api/slips/preview", async (route) => {
      previews.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          valid: true,
          items: [
            { units: 2, stake: 2500, error: null },
            { units: 2, stake: 4000, error: null },
            { units: 2, stake: 6000, error: null },
            { units: 2, stake: 8000, error: null },
          ],
          units: 8,
          stake: 20500,
          error: null,
        },
      });
    });
    await page
      .getByLabel("投注原文")
      .fill(
        "香港特码03///15各12.5 /// 澳门特码27 ll 39各20 x 尾中2尾 ii 8尾各30 ll 一肖中鼠 x 牛各40",
      );
    await page.getByRole("button", { name: "校验", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "确认投注单" });
    await modal.getByPlaceholder("填写投注人").fill("synthetic-separators");
    await expect(modal.locator(".text-entry-rows > li")).toHaveCount(4);
    await expect(
      modal.getByText("4 个分项 · 8 注", { exact: true }),
    ).toBeVisible();
    await expect(modal.getByText("¥ 205.00", { exact: true })).toBeVisible();
    for (const [index, amount] of ["12.5", "20", "30", "40"].entries())
      await expect(
        modal.getByLabel(`第${index + 1}项金额`, { exact: true }),
      ).toHaveValue(amount);
    const submit = modal.getByRole("button", { name: "确认录入", exact: true });
    await expect(submit).toBeEnabled();
    expect(writes).toHaveLength(0);
    await submit.click();
    await expect(modal).toBeHidden();
    expect(writes).toHaveLength(1);
    const { items } = writes[0] as {
      items: {
        play_id: number;
        market?: string;
        selections: number[];
        amount: string;
      }[];
    };
    expect(
      items.map((item) => ({
        play: plays.find((play) => play.id === item.play_id)!.rule.name,
        market: item.market ?? "macau",
        selections: item.selections,
        amount: item.amount,
      })),
    ).toEqual([
      { play: "特码", market: "hk", selections: [3, 15], amount: "12.5" },
      { play: "特码", market: "macau", selections: [27, 39], amount: "20" },
      { play: "尾中", market: "macau", selections: [2, 8], amount: "30" },
      { play: "一肖中", market: "macau", selections: [0, 1], amount: "40" },
    ]);
    expect(previews.length).toBeGreaterThan(0);
    expect(
      previews.every(
        (preview) =>
          JSON.stringify((preview as { items: object[] }).items) ===
          JSON.stringify(items),
      ),
    ).toBe(true);
  });
}

for (const account of ["A", "B"] as const) {
  test(`collaborator ${account} confirms and submits only their own configured play`, async ({
    page,
  }) => {
    const offset = account === "A" ? 1000 : 2000;
    const configured = plays.map((play) => ({
      ...play,
      id: play.id + offset,
      rule: {
        ...play.rule,
        odds:
          play.rule.name === "特码"
            ? account === "A"
              ? "44"
              : "48"
            : play.rule.odds,
      },
    }));
    const writes = await openText(page, configured);
    await page.getByLabel("投注原文").fill("特码03 15各10");
    await page.getByRole("button", { name: "校验", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "确认投注单" });
    await modal
      .getByPlaceholder("填写投注人")
      .fill(`synthetic-personal-${account}`);
    const own = configured.find((play) => play.rule.name === "特码")!;
    const rate = modal.getByRole("combobox", { name: "特码费率", exact: true });
    await expect(rate).toHaveValue(String(own.id));
    const optionValues = await rate
      .locator("option")
      .evaluateAll((options) =>
        options
          .map((option) => Number((option as HTMLOptionElement).value))
          .filter((id) => id > 0),
      );
    expect(
      optionValues.every((id) => configured.some((play) => play.id === id)),
    ).toBe(true);
    await modal.getByRole("button", { name: "确认录入", exact: true }).click();
    await expect(modal).toBeHidden();
    expect(writes).toHaveLength(1);
    const { items } = writes[0] as {
      items: { play_id: number; selections: number[]; amount: string }[];
    };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      play_id: own.id,
      selections: [3, 15],
      amount: "10",
    });
  });
}
