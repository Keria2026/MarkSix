import { test, expect } from "./scenario-fixtures";
import { signIn } from "./customer-fixtures";
import { money } from "../../src/lib/types";
import AxeBuilder from "@axe-core/playwright";

for (const width of [390, 1440]) {
  test(`bettor settings adjust only home amounts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const endpoint = `/api/periods/${boot.today.id}/received-display?market=macau`;
    const read = async () => await (await page.request.get(endpoint)).json();
    const baseline = await read();
    const bettor = `ratio-ui-${width}-${Date.now()}`;
    await page
      .getByRole("navigation", { name: "主要导航" })
      .getByRole("button", { name: "玩法与配置", exact: true })
      .click();
    await page.getByRole("button", { name: "投注人", exact: true }).click();
    const settings = page.getByRole("region", { name: "投注人首页比例" });
    await settings.getByLabel("投注人名称").fill(bettor);
    await settings.getByLabel("首页显示比例（%）").fill("80");
    await settings.getByRole("button", { name: "保存投注人" }).click();
    await expect(settings.getByRole("status")).toContainText("已保存");
    await expect(
      settings.getByRole("listitem").filter({ hasText: bettor }),
    ).toContainText("80.00%");
    const parties = await (await page.request.get("/api/parties")).json();
    expect(parties.bettors).toContain(bettor);
    const accessibility = await new AxeBuilder({ page })
      .include(".bettor-settings")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const play = boot.plays.find(
      (p: { rule: { name: string } }) => p.rule.name === "特码",
    );
    const write = await page.request.post("/api/slips", {
      headers: { "X-Marksix": "1" },
      data: {
        request_id: crypto.randomUUID(),
        period: boot.today.id,
        bettor,
        items: [
          {
            play_id: play.id,
            play_version: play.version,
            market: "macau",
            selections: [7],
            amount: "100",
            compound: false,
          },
        ],
      },
    });
    expect(write.ok()).toBe(true);
    const totals = (
      await (await page.request.get(`/api/days/${boot.today.id}`)).json()
    ).totals;
    expect((await read()).received.special[6]).toBe(
      baseline.received.special[6] + 8000,
    );
    await page
      .getByRole("navigation", { name: "主要导航" })
      .getByRole("button", { name: "本期概览", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "受注金额分布" });
    await expect(
      panel.getByRole("button", { name: "减出", exact: true }),
    ).toBeEnabled();
    await panel.getByRole("button", { name: "减出", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "首页减出 · 新澳门特码" });
    await dialog.getByRole("checkbox", { name: "减出07", exact: true }).check();
    await dialog.getByLabel("每项减出金额（元）").fill("20");
    await dialog.getByRole("button", { name: "确认减出", exact: true }).click();
    await expect(dialog).toBeHidden();
    const afterDeduct = await read();
    expect(afterDeduct.deducted.special[6]).toBe(
      baseline.deducted.special[6] + 2000,
    );
    await page
      .getByRole("navigation", { name: "主要导航" })
      .getByRole("button", { name: "玩法与配置", exact: true })
      .click();
    await page.getByRole("button", { name: "投注人", exact: true }).click();
    await settings.getByRole("button", { name: `编辑 ${bettor}` }).click();
    await settings.getByLabel("首页显示比例（%）").fill("50");
    await settings.getByRole("button", { name: "保存投注人" }).click();
    await expect(
      settings.getByRole("listitem").filter({ hasText: bettor }),
    ).toContainText("50.00%");
    const adjusted = await read();
    expect(adjusted.received.special[6]).toBe(
      afterDeduct.received.special[6] - 3000,
    );
    expect(adjusted.deducted).toEqual(afterDeduct.deducted);
    expect(
      (await (await page.request.get(`/api/days/${boot.today.id}`)).json())
        .totals,
    ).toEqual(totals);
    await page
      .getByRole("navigation", { name: "主要导航" })
      .getByRole("button", { name: "本期概览", exact: true })
      .click();
    await expect(
      panel.getByRole("listitem").nth(6).locator("strong"),
    ).toHaveText(money(adjusted.display.special[6]));
    await page.reload();
    await expect(
      panel.getByRole("listitem").nth(6).locator("strong"),
    ).toHaveText(money(adjusted.display.special[6]));
    await panel.getByRole("button", { name: "恢复显示", exact: true }).click();
    const restore = page.getByRole("dialog", { name: "恢复显示 · 新澳门特码" });
    await expect(restore).toContainText("按投注人比例计算");
    await restore
      .getByRole("button", { name: "确认恢复显示", exact: true })
      .click();
    await expect(restore).toBeHidden();
    const restored = await read();
    expect(restored.display.special[6]).toBe(restored.received.special[6]);
    expect(restored.received.special[6]).toBe(adjusted.received.special[6]);
  });
}

test("a late settings response cannot overwrite a newly saved bettor", async ({
  page,
}) => {
  await signIn(page);
  let release!: () => void;
  let arrived!: () => void;
  let delivered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  let first = true;
  await page.route("**/api/settings/bettors", async (route) => {
    if (route.request().method() !== "GET" || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
    delivered();
  });
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "玩法与配置", exact: true })
    .click();
  await page.getByRole("button", { name: "投注人", exact: true }).click();
  await pending;
  const settings = page.getByRole("region", { name: "投注人首页比例" });
  const bettor = `ratio-race-${Date.now()}`;
  await settings.getByLabel("投注人名称").fill(bettor);
  await settings.getByLabel("首页显示比例（%）").fill("80");
  await settings.getByRole("button", { name: "保存投注人" }).click();
  await expect(
    settings.getByRole("listitem").filter({ hasText: bettor }),
  ).toContainText("80.00%");
  release();
  await completed;
  await page.waitForTimeout(200);
  await expect(
    settings.getByRole("listitem").filter({ hasText: bettor }),
  ).toContainText("80.00%");
});
