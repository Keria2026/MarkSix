import { test, expect, type Page } from "@playwright/test";

let bootstrap: import("../src/lib/types").Bootstrap;
let settings: import("../src/lib/types").Settings;
test.beforeAll(async ({ request }) => {
  const login = await request.post("/api/login", {
    headers: { "X-MarkSix": "1" },
    data: { username: "test-admin", password: process.env.TEST_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  bootstrap = await (await request.get("/api/bootstrap")).json();
  settings = await (await request.get("/api/settings")).json();
  await request.post("/api/logout", {
    headers: { "X-MarkSix": "1" },
    data: {},
  });
});

async function fixture(page: Page) {
  // Reuse one validated contract fixture; account responses remain isolated.
  let account: string | null = null;
  let active = true;
  let release: (() => void) | undefined;
  let delayParties = false;
  const zero = {
    records: 0,
    units: 0,
    stake: 0,
    rebate: 0,
    payout: 0,
    refunded: 0,
    net: null,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/site")
      return route.fulfill({ json: { mode: "hosted" } });
    if (path === "/api/login") {
      account = route.request().postDataJSON().username;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/logout") {
      account = null;
      return route.fulfill({ json: { ok: true } });
    }
    if (!account)
      return route.fulfill({
        status: 401,
        json: { error: "test session expired" },
      });
    if (path === "/api/session")
      return route.fulfill({ json: { username: account } });
    if (path === "/api/license")
      return route.fulfill({ json: { active, testing: true } });
    if (path === "/api/bootstrap") {
      const value = structuredClone(bootstrap);
      value.plays[0].rule.name = `private-${account}`;
      return route.fulfill({ json: value });
    }
    if (path === "/api/settings") return route.fulfill({ json: settings });
    if (path === "/api/bets/search")
      return route.fulfill({
        json: { items: [], total: 0, page: 1, page_size: 25 },
      });
    if (path.endsWith("/bet-filters"))
      return route.fulfill({
        json: { period: bootstrap.today.id, bettors: [], plays: [] },
      });
    if (path.endsWith("/statistics"))
      return route.fulfill({
        json: {
          period: bootstrap.today.id,
          settled: false,
          incoming: zero,
          outgoing: zero,
          retained: zero,
          bettors: [],
          receivers: [],
          layoffs: [],
          layoffs_total: 0,
          layoffs_page: 1,
        },
      });
    if (path === "/api/parties") {
      const captured = account;
      if (delayParties && captured === "A")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return route
        .fulfill({
          json: {
            bettors: [`bettor-${captured}`],
            receivers: [`receiver-${captured}`],
          },
        })
        .catch(() => {});
    }
    return route.fulfill({ status: 404, json: { error: `unmocked ${path}` } });
  });
  async function login(name: string) {
    await page.getByLabel("客户账号").fill(name);
    await page.getByLabel("登录密码").fill("mock-password-123");
    await page.getByRole("button", { name: "进入工作台" }).click();
    await expect(
      page.getByRole("heading", { name: "本期概览", exact: true }),
    ).toBeVisible();
  }
  await page.goto("/");
  await login("A");
  return {
    login,
    expire: () => {
      account = null;
    },
    revoke: () => {
      active = false;
    },
    delay: () => {
      delayParties = true;
    },
    release: () => release?.(),
  };
}
const nav = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name, exact: true });

test("logout destroys account drafts and candidate lists before another login", async ({
  page,
}) => {
  const f = await fixture(page);
  await expect(page.locator('datalist option[value="bettor-A"]')).toHaveCount(
    1,
  );
  await nav(page, "录入投注").click();
  await page.getByLabel("投注人", { exact: true }).fill("draft-A");
  await nav(page, "本期概览").click();
  await nav(page, "录入投注").click();
  await expect(page.getByLabel("投注人", { exact: true })).toHaveValue(
    "draft-A",
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await f.login("B");
  await nav(page, "录入投注").click();
  await expect(page.getByLabel("投注人", { exact: true })).toHaveValue("");
  await expect(page.locator('datalist option[value="bettor-B"]')).toHaveCount(
    1,
  );
  await expect(page.locator('datalist option[value="bettor-A"]')).toHaveCount(
    0,
  );
});

for (const reason of ["session", "license"] as const) {
  test(`${reason} invalidation closes pending business dialogs`, async ({
    page,
  }) => {
    const f = await fixture(page);
    await nav(page, "玩法与配置").click();
    await page
      .getByRole("checkbox", { name: "选择玩法 private-A", exact: true })
      .check();
    await page.getByRole("button", { name: "批量调整", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "批量调整玩法", exact: true }),
    ).toBeVisible();
    if (reason === "session") f.expire();
    else f.revoke();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 12000 });
    if (reason === "session") {
      await page.getByLabel("客户账号").click({ trial: true });
      await f.login("B");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } else
      await expect(
        page.getByRole("heading", { name: "激活工作台" }),
      ).toBeVisible();
  });
}

test("late responses from disposed account cannot overwrite the next workspace", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  f.delay();
  await f.login("A");
  await expect
    .poll(() => page.locator('datalist option[value="bettor-A"]').count())
    .toBe(0);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await f.login("B");
  await expect(page.locator('datalist option[value="bettor-B"]')).toHaveCount(
    1,
  );
  f.release();
  await page.waitForTimeout(300);
  await expect(page.locator('datalist option[value="bettor-A"]')).toHaveCount(
    0,
  );
  await expect(page.locator('datalist option[value="bettor-B"]')).toHaveCount(
    1,
  );
});
