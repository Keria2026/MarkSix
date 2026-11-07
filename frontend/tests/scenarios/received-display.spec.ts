import { test, expect } from "./scenario-fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn } from "./customer-fixtures";
import { money } from "../../src/lib/types";
import type { ReceivedDisplay } from "../../src/lib/received-display";

const boards = [
  { kind: "special", title: "特码", label: "07", index: 6, selections: [7, 9] },
  {
    kind: "zodiac",
    title: "一肖中",
    label: "鼠",
    index: 0,
    selections: [0, 1],
  },
  { kind: "tail", title: "尾中", label: "9尾", index: 9, selections: [0, 9] },
] as const;
const markets = [
  ["macau", "新澳门"],
  ["hk", "香港"],
] as const;
async function prepare(page: Page) {
  await signIn(page);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const endpoint = (market: string) =>
    `/api/periods/${boot.today.id}/received-display?market=${market}`;
  const read = async (market: string): Promise<ReceivedDisplay> =>
    (await page.request.get(endpoint(market))).json();
  const add = async (all: boolean) => {
    const items = markets.flatMap(([market]) =>
      boards
        .filter((_, index) => all || index === 0)
        .map((board) => {
          const play = boot.plays.find(
            (p: { rule: { name: string } }) => p.rule.name === board.title,
          );
          return {
            play_id: play.id,
            play_version: play.version,
            market,
            selections: all ? board.selections : [7],
            amount: all ? "100" : "50",
            compound: false,
          };
        }),
    );
    const response = await page.request.post("/api/slips", {
      headers: { "X-Marksix": "1" },
      data: {
        request_id: crypto.randomUUID(),
        period: boot.today.id,
        bettor: "synthetic-home-display",
        items,
      },
    });
    expect(response.ok()).toBe(true);
  };
  await add(true);
  for (const [market] of markets)
    for (const board of boards) {
      const current = await read(market);
      const response = await page.request.post(endpoint(market), {
        headers: { "X-Marksix": "1" },
        data: {
          request_id: crypto.randomUUID(),
          revision: current.revision,
          kind: board.kind,
          change: { action: "reset" },
        },
      });
      expect(response.ok()).toBe(true);
    }
  await page.reload();
  const panel = page.getByRole("region", { name: "受注金额分布" });
  await expect(
    panel.getByRole("button", { name: "减出", exact: true }),
  ).toBeEnabled();
  const ledger = async () =>
    (await (await page.request.get(`/api/days/${boot.today.id}`)).json())
      .totals;
  return { endpoint, read, add, panel, ledger };
}

for (const width of [390, 1440])
  test(`home display deductions persist and accumulate independently in six market boards at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { panel, read, add, ledger } = await prepare(page);
    const totals = await ledger();
    for (const [market, marketTitle] of markets) {
      await panel
        .getByRole("button", { name: marketTitle, exact: true })
        .click();
      for (const board of boards) {
        await panel
          .getByRole("tab", { name: board.title, exact: true })
          .click();
        const before = await read(market);
        await panel.getByRole("button", { name: "减出", exact: true }).click();
        const dialog = page.getByRole("dialog", {
          name: `首页减出 · ${marketTitle}${board.title}`,
        });
        await dialog
          .getByRole("checkbox", { name: `减出${board.label}`, exact: true })
          .check();
        await dialog
          .getByLabel("每项减出金额（元）", { exact: true })
          .fill("30.25");
        await dialog
          .getByRole("button", { name: "确认减出", exact: true })
          .click();
        await expect(dialog).toBeHidden();
        const cell = panel.getByRole("listitem").filter({
          has: page.locator(".received-label", {
            hasText: new RegExp(`^${board.label}$`),
          }),
        });
        await expect(cell.locator("strong")).toHaveText(
          money(before.display[board.kind][board.index] - 3025),
        );
        const after = await read(market);
        expect(after.received).toEqual(before.received);
        expect(after.deducted[board.kind][board.index]).toBe(3025);
        expect(after.display[board.kind][board.index]).toBe(
          before.display[board.kind][board.index] - 3025,
        );
        expect(await ledger()).toEqual(totals);
      }
    }
    await page.reload();
    await expect(
      panel.getByRole("listitem").nth(6).locator("strong"),
    ).toHaveText(money((await read("macau")).display.special[6]));
    const beforeNew = await read("macau");
    await add(false);
    await page.reload();
    const afterNew = await read("macau");
    expect(afterNew.display.special[6]).toBe(
      beforeNew.display.special[6] + 5000,
    );
    expect(afterNew.deducted).toEqual(beforeNew.deducted);
    await expect(
      panel.getByRole("button", { name: "减出", exact: true }),
    ).toBeEnabled();
    await panel.getByRole("button", { name: "减出", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "首页减出 · 新澳门特码" });
    await dialog.getByRole("checkbox", { name: "减出07", exact: true }).check();
    await dialog.getByLabel("每项减出金额（元）", { exact: true }).fill("10");
    await dialog
      .getByLabel("每项减出金额（元）", { exact: true })
      .press("Enter");
    await expect(dialog).toBeHidden();
    expect((await read("macau")).display.special[6]).toBe(
      afterNew.display.special[6] - 1000,
    );
    await panel.getByRole("button", { name: "恢复显示", exact: true }).click();
    await page
      .getByRole("dialog", { name: "恢复显示 · 新澳门特码" })
      .getByRole("button", { name: "确认恢复显示", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(
      panel.getByRole("button", { name: "减出", exact: true }),
    ).toBeFocused();
    const restored = await read("macau");
    expect(restored.display.special).toEqual(restored.received.special);
    expect(restored.deducted.zodiac[0]).toBe(3025);
    expect((await read("hk")).deducted.special[6]).toBe(3025);
  });

test("home deduction retries a lost success exactly once and recovers stale drafts safely", async ({
  page,
}) => {
  const { endpoint, read, panel, ledger } = await prepare(page);
  const initial = await read("macau");
  const totals = await ledger();
  const bodies: { request_id: string }[] = [];
  await page.route(`**${endpoint("macau")}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postDataJSON());
    if (bodies.length !== 1) return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort("failed");
  });
  await panel.getByRole("button", { name: "减出", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "首页减出 · 新澳门特码" });
  await dialog.getByRole("checkbox", { name: "减出07", exact: true }).check();
  await dialog.getByLabel("每项减出金额（元）", { exact: true }).fill("10");
  await dialog.getByRole("button", { name: "确认减出", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "确认减出", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect((await read("macau")).display.special[6]).toBe(
    initial.display.special[6] - 1000,
  );
  await expect(
    panel.getByRole("button", { name: "减出", exact: true }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "减出", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "减出07", exact: true }).check();
  await dialog.getByLabel("每项减出金额（元）", { exact: true }).fill("10");
  const current = await read("macau");
  const other = await page.request.post(endpoint("macau"), {
    headers: { "X-Marksix": "1" },
    data: {
      request_id: crypto.randomUUID(),
      revision: current.revision,
      kind: "special",
      change: { action: "deduct", items: [{ index: 6, amount: "20" }] },
    },
  });
  expect(other.ok()).toBe(true);
  await dialog.getByRole("button", { name: "确认减出", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("已更新");
  await dialog
    .getByRole("button", { name: "刷新后重新选择", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByRole("listitem").nth(6).locator("strong")).toHaveText(
    money(initial.display.special[6] - 3000),
  );
  expect(await ledger()).toEqual(totals);
});

test("mobile deduction selection validates bounds and remains keyboard accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { panel, read } = await prepare(page);
  const before = await read("macau");
  const trigger = panel.getByRole("button", { name: "减出", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "首页减出 · 新澳门特码" });
  const confirm = dialog.getByRole("button", { name: "确认减出", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole("button", { name: "选择全部有金额项", exact: true })
    .click();
  await dialog.getByRole("button", { name: "清空选择", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "减出07", exact: true }).check();
  const amount = dialog.getByLabel("每项减出金额（元）", { exact: true });
  for (const invalid of ["-1", "0", "1.001", "90000000000000"]) {
    await amount.fill(invalid);
    await expect(confirm).toBeDisabled();
    await expect(dialog.getByRole("alert")).toBeVisible();
  }
  await amount.fill("0.01");
  await expect(confirm).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const accessibility = await new AxeBuilder({ page })
    .include("dialog")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("home-deduction-mobile.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await read("macau")).toEqual(before);
  await trigger.click();
  for (const label of ["07", "09"])
    await dialog
      .getByRole("checkbox", { name: `减出${label}`, exact: true })
      .check();
  await dialog.getByLabel("每项减出金额（元）", { exact: true }).fill("0.01");
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  const after = await read("macau");
  expect(after.display.special[6]).toBe(before.display.special[6] - 1);
  expect(after.display.special[8]).toBe(before.display.special[8] - 1);
});
