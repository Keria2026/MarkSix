import { receivedDisplayFixture } from "../model/received-display";
import { test, expect } from "./scenario-fixtures";
import { plays } from "../contracts/fixtures";
import { annualMapping } from "../../src/lib/types";

for (const width of [390, 1440]) {
  test(`avatar switches the entire record scope without exposing legacy entry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const scopes: { path: string; view: string }[] = [];
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      const view = request.headers()["x-marksix-records"] ?? "shared";
      scopes.push({ path, view });
      let json: unknown = {};
      const stake =
        view === "mine" ? 10000 : view === "history" ? 50000 : 30000;
      const totals = {
        records: 1,
        units: 1,
        stake,
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
      const today = {
        id: "2040001",
        market: "macau",
        business_date: "2040-01-01",
        state: "pending",
        phase: "open",
        accepting_entries: true,
        mapping: annualMapping(2026),
        bet_version: 1,
        draw: null,
        totals,
        server_time: new Date().toISOString(),
      };
      if (path === "/api/site") json = { mode: "hosted" };
      else if (path === "/api/session")
        json = {
          username: "合成甲",
          account_id: "a",
          collaboration: {
            id: "synthetic-workspace",
            state: "ready",
            members: [
              { id: "a", username: "合成甲" },
              { id: "b", username: "合成乙" },
            ],
          },
        };
      else if (path === "/api/license")
        json = { active: true, permanent: true };
      else if (path === "/api/bootstrap")
        json = {
          today,
          day: { ...today, periods: [today] },
          plays,
          zodiacs: [],
          features: {
            layoffs: false,
            manual_entry: true,
            text_entry: true,
            entry_mode: "manual",
          },
        };
      else if (path.endsWith("/received-display"))
        json = receivedDisplayFixture({
          special: Array(49).fill(0),
          zodiac: Array(12).fill(0),
          tail: Array(10).fill(0),
        });
      else if (path === "/api/records/search")
        json = { items: [], total: 0, page: 1, page_size: 25 };
      else if (path.endsWith("/bet-filters") || path === "/api/parties")
        json = { bettors: [], plays: [], receivers: [] };
      else if (path.endsWith("/statistics"))
        json = {
          period: today.id,
          settled: false,
          incoming: totals,
          outgoing: { ...totals, stake: 0 },
          retained: totals,
          bettors: [],
          receivers: [],
          layoffs: [],
          layoffs_total: 0,
          layoffs_page: 1,
        };
      else
        return route.fulfill({
          status: 404,
          json: { error: `Unhandled ${path}` },
        });
      await route.fulfill({ json });
    });
    await page.goto("/");
    await expect(page.getByText("¥ 300.00", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    const avatar = page
      .getByRole("button", { name: "切换记录范围", exact: true })
      .filter({ visible: true });
    await avatar.click();
    let dialog = page.getByRole("dialog", { name: "记录范围" });
    await expect(
      dialog.getByText("合成甲、合成乙", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(avatar).toBeFocused();
    await avatar.click();
    await dialog.getByRole("button", { name: "仅我录入", exact: true }).click();
    await expect(page.getByText("¥ 100.00", { exact: true })).toBeVisible();
    await expect(avatar).toBeFocused();
    await avatar.click();
    dialog = page.getByRole("dialog", { name: "记录范围" });
    await expect(
      dialog.getByRole("button", { name: "仅我录入", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: /关联前记录/ }).click();
    await expect(page.getByText("¥ 500.00", { exact: true })).toBeVisible();
    await expect(page.getByText(/关联前记录仅供查看/)).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "主要导航" });
    await expect(
      navigation.getByRole("button", { name: "录入投注", exact: true }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("button", { name: "玩法与配置", exact: true }),
    ).toHaveCount(0);
    await avatar.click();
    await page
      .getByRole("dialog", { name: "记录范围" })
      .getByRole("button", { name: "协作记录", exact: true })
      .click();
    await expect(page.getByText("¥ 300.00", { exact: true })).toBeVisible();
    expect(
      scopes.filter((s) => s.path === "/api/bootstrap").map((s) => s.view),
    ).toEqual(["shared", "mine", "history", "shared"]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const bounds = await avatar.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  });
}

test("admin links only eligible existing accounts and keeps failed selection reviewable", async ({
  page,
}) => {
  const customers = ["合成甲", "合成乙", "已关联账户"].map(
    (username, index) => ({
      id: `synthetic-${index}`,
      username,
      state: "ready",
      disabled: false,
      permanent: true,
      active: true,
      authorized_through: null,
      workspace_id: index === 2 ? "another-workspace" : null,
      workspace_state: index === 2 ? "ready" : null,
    }),
  );
  const links: unknown[] = [];
  let reject = true;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith("/link")) {
      const body = request.postDataJSON();
      links.push({ path, body });
      if (reject) {
        reject = false;
        return route.fulfill({
          status: 409,
          json: { error: "合成关联失败，可重试" },
        });
      }
      for (const customer of customers.slice(0, 2)) {
        customer.workspace_id = "new-workspace";
        customer.workspace_state = "ready";
      }
      return route.fulfill({ json: { ok: true } });
    }
    const json =
      path === "/api/site"
        ? { mode: "authority" }
        : path === "/api/session"
          ? { username: "synthetic-owner" }
          : path === "/api/accounts"
            ? { items: customers }
            : {};
    await route.fulfill({ json });
  });
  await page.goto("/");
  const card = page.locator(".owner-card").filter({
    has: page.getByRole("heading", { name: "合成甲", exact: true }),
  });
  await card.getByRole("button", { name: "关联账户", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "关联协作账户" });
  const selector = dialog.getByRole("combobox", {
    name: "关联账户",
    exact: true,
  });
  await expect(selector.locator("option")).toHaveText([
    "请选择已有账户",
    "合成乙",
  ]);
  const confirm = dialog.getByRole("button", { name: "确认", exact: true });
  await expect(confirm).toBeDisabled();
  await selector.selectOption("synthetic-1");
  await confirm.click();
  await expect(dialog.getByRole("alert")).toHaveText("合成关联失败，可重试");
  await expect(selector).toHaveValue("synthetic-1");
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(
    card.getByText("协作账户：合成乙", { exact: true }),
  ).toBeVisible();
  expect(links).toEqual(
    Array(2).fill({
      path: "/api/accounts/synthetic-0/link",
      body: { account_id: "synthetic-1" },
    }),
  );
});
