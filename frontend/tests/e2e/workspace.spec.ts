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
