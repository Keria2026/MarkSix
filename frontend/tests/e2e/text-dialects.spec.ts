import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { plays } from "../unit/support";
import { annualMapping } from "../../src/lib/types";

// Interface contract only. Database and financial API behavior have separate tests.
async function openText(page: Page) {
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
        plays,
        zodiacs: [],
        today: {
          id: "2040001",
          business_date: "2040-01-01",
          phase: "open",
          state: "pending",
          accepting_entries: true,
          mapping: annualMapping(2026),
          bet_version: 0,
          draw: null,
          risk_status: "stale",
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
          const name = plays.find((p) => p.id === item.play_id)!.rule.name;
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
