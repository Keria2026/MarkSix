import { test, expect } from "./authenticated";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import type { Play } from "../src/lib/types";
import type { Page } from "@playwright/test";

const review = (page: Page) =>
  page.getByRole("dialog", { name: "确认投注单", exact: true });
async function openEntry(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  return page.getByRole("region", { name: "文本录注" });
}

test("paste and validate opens one review dialog, auto-quotes edits and saves one idempotent slip", async ({
  page,
}) => {
  await page.request.delete("/api/text-entry/preferences/特", {
    headers: { "X-MarkSix": "1" },
  });
  const panel = await openEntry(page);
  await panel.getByLabel("投注原文").fill("特：07各10\n特：08各20");
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  const dialog = review(page);
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("投注人", { exact: true })
    .fill(`文本验收-${Date.now()}`);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const play = boot.plays.find((p: Play) => p.rule.name === "特码直选");
  await expect(dialog.locator(".text-entry-rows > li")).toHaveCount(2);
  const submit = dialog.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeDisabled();
  await dialog
    .getByLabel("特码费率", { exact: true })
    .selectOption(String(play.id));
  const records = async () =>
    (
      await page.request.post("/api/records/search", {
        headers: { "X-MarkSix": "1" },
        data: {
          period: boot.today.id,
          bettors: [
            await dialog.getByLabel("投注人", { exact: true }).inputValue(),
          ],
        },
      })
    ).json();
  expect((await records()).total).toBe(0);
  await expect(submit).toBeEnabled();
  await expect(dialog.locator(".text-review-total")).toContainText(
    "2 个分项 · 2 注",
  );
  expect((await records()).total).toBe(0);
  expect(
    await (await page.request.get("/api/text-entry/preferences")).json(),
  ).not.toContainEqual(expect.objectContaining({ alias: "特" }));
  await dialog.getByLabel("第1项金额", { exact: true }).fill("15");
  await expect(submit).toBeDisabled();
  await expect(dialog.locator(".text-review-total")).toContainText("35");
  await expect(submit).toBeEnabled();
  expect(
    (
      await new AxeBuilder({ page })
        .include('dialog[aria-label="确认投注单"]')
        .analyze()
    ).violations,
  ).toEqual([]);
  const bettor = await dialog
    .getByLabel("投注人", { exact: true })
    .inputValue();
  const requests: {
    request_id: string;
    items: unknown[];
    text_preferences: unknown[];
  }[] = [];
  await page.route("**/api/slips", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  await submit.click();
  await expect(dialog.getByRole("alert").last()).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByLabel("投注原文")).toHaveValue("");
  expect(requests).toHaveLength(2);
  expect(requests[0].request_id).toBe(requests[1].request_id);
  expect(requests[0]).not.toHaveProperty("raw");
  expect(requests[0].text_preferences ?? []).toEqual([]);
  expect(requests[0]).toMatchObject({
    entry_mode: "text",
    bettor_preference: {
      play_id: play.id,
      play_version: play.version,
      amount_mode: "auto",
    },
  });
  const saved = await (
    await page.request.post("/api/records/search", {
      headers: { "X-MarkSix": "1" },
      data: { period: boot.today.id, bettors: [bettor] },
    })
  ).json();
  expect(saved.total).toBe(1);
  expect(saved.items[0].grouped).toBe(true);
  expect(saved.items[0].items).toHaveLength(2);
  expect(saved.items[0].stake).toBe(3500);
  await panel.getByLabel("投注原文").fill("特：09各30");
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await expect(dialog.getByLabel("特码费率", { exact: true })).toHaveValue(
    String(play.id),
  );
  await expect(submit).toBeEnabled();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const box = (await submit.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(1000);
    await page.screenshot({
      path: `test-results/text-entry-review-${width}.png`,
    });
  }
  await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "校验", exact: true }),
  ).toBeFocused();
  await expect
    .poll(
      async () =>
        await (await page.request.get("/api/text-entry/preferences")).json(),
    )
    .not.toContainEqual(expect.objectContaining({ alias: "特" }));
});

test("unknown fragments are visible in the modal, block confirmation and preserve the raw draft on close", async ({
  page,
}) => {
  const panel = await openEntry(page);
  await panel
    .getByLabel("投注原文")
    .fill("特码直选：羊300\n特码直选：07各10 未知要求");
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  const dialog = review(page);
  await dialog.getByLabel("投注人", { exact: true }).fill("文本阻断验收");
  await expect(dialog.locator(".text-entry-rows > li")).toHaveCount(2);
  await expect(
    dialog.getByRole("button", { name: "确认录入", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("第1项金额含义").selectOption("package");
  await expect(
    dialog.getByRole("button", { name: "确认录入", exact: true }),
  ).toBeDisabled();
  await expect(dialog.locator("blockquote").last()).toContainText("未知要求");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "校验", exact: true }),
  ).toBeFocused();
  await expect(panel.getByLabel("投注原文")).toHaveValue(/未知要求/u);
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "本期概览", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await expect(panel.getByLabel("投注原文")).toHaveValue(/未知要求/u);
  const oversized = "特码".repeat(6001);
  await panel.getByLabel("投注原文").fill(oversized);
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await expect(panel.getByRole("alert").last()).toContainText("12,000");
  await expect(dialog).toHaveCount(0);
});

test("modal corrections teach an alias and package amount automatically after successful recording", async ({
  page,
}) => {
  const alias = "个人新简称";
  await page.request.delete(`/api/text-entry/preferences/${alias}`, {
    headers: { "X-MarkSix": "1" },
  });
  const panel = await openEntry(page);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const play = boot.plays.find((p: Play) => p.rule.name === "特码直选");
  await panel.getByLabel("投注原文").fill(`${alias}羊300`);
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  const dialog = review(page);
  await dialog.getByLabel("投注人", { exact: true }).fill("学习金额验收");
  await dialog
    .getByRole("combobox", { name: "对应玩法", exact: true })
    .selectOption(String(play.id));
  await dialog.getByLabel("未识别的玩法简称（可选）").fill(alias);
  await dialog.getByLabel("第1项投注项").fill("羊");
  await dialog.getByLabel("第1项金额含义").selectOption("package");
  await expect(dialog.locator(".text-review-total")).toContainText("300");
  await dialog.getByRole("button", { name: "确认录入", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByLabel("投注原文")).toHaveValue("");
  await page.reload();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  await panel.getByLabel("投注原文").fill(`${alias}马300`);
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await dialog.getByLabel("投注人", { exact: true }).fill("学习金额验收");
  await expect(dialog.getByLabel(`“${alias}”对应玩法`)).toHaveValue(
    String(play.id),
  );
  await expect(dialog.getByLabel("第1项金额含义")).toHaveValue("package");
  await expect(dialog.locator(".text-review-total")).toContainText("5 注");
  await expect(dialog.locator(".text-review-total")).toContainText("300");
  await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await panel.getByText("已记住的习惯", { exact: false }).click();
  await panel
    .getByRole("button", { name: `忘记${alias}`, exact: true })
    .click();
});

test("domain grammar opens direct confirmation with exact server principal", async ({
  page,
}) => {
  const defaults = JSON.parse(
    readFileSync(
      new URL("../../backend/src/default-plays.json", import.meta.url),
      "utf8",
    ),
  );
  const existing = await (await page.request.get("/api/bootstrap")).json();
  const ids = new Map<string, number>();
  for (const name of ["特码", "三有", "一肖中", "四肖中特"]) {
    const play = existing.plays.find((p: Play) => p.rule.name === name);
    if (play) {
      ids.set(name, play.id);
    } else {
      const response = await page.request.post("/api/plays", {
        headers: { "X-MarkSix": "1" },
        data: defaults.plays.find((p: Play) => p.rule.name === name)?.rule ?? {
          ...defaults.plays.find((p: Play) => p.rule.name === "三有").rule,
          name,
          quantity: 4,
          combination_size: 4,
          scope: "special",
        },
      });
      expect(response.ok()).toBe(true);
      ids.set(name, (await response.json()).id);
    }
  }
  const panel = await openEntry(page);
  const cases = [
    { raw: "牛特500", rows: 1, stake: 50000, aliases: [] },
    {
      raw: "三有牛狗马500.另复三友牛狗马猪各600",
      rows: 2,
      stake: 290000,
      aliases: [["三友", "三有"]],
    },
    { raw: "牛中5000", rows: 1, stake: 500000, aliases: [] },
    {
      raw: "平特一肖牛30000*",
      rows: 1,
      stake: 3000000,
      aliases: [["平特一肖", "一肖中"]],
    },
    { raw: "新澳门四肖\n兔龙虎蛇100米", rows: 1, stake: 10000, aliases: [] },
    { raw: "特码12.5包牛狗", rows: 1, stake: 2500, aliases: [] },
  ];
  for (const item of cases) {
    await panel.getByLabel("投注原文").fill(item.raw);
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/slips/preview") &&
        r.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "校验", exact: true }).click();
    const dialog = review(page);
    await dialog.getByLabel("投注人", { exact: true }).fill("领域语义验收");
    await expect(dialog.locator(".text-entry-rows > li")).toHaveCount(
      item.rows,
    );
    for (const [alias, name] of item.aliases)
      await expect(dialog.getByLabel(`“${alias}”对应玩法`)).toHaveValue(
        String(ids.get(name)),
      );
    const preview = await (await response).json();
    expect(preview).toMatchObject({ valid: true, stake: item.stake });
    if (item.rows === 2)
      expect(
        preview.items.map((line: { units: number; stake: number }) => [
          line.units,
          line.stake,
        ]),
      ).toEqual([
        [1, 50000],
        [4, 240000],
      ]);
    await expect(
      dialog.getByRole("button", { name: "确认录入", exact: true }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
    await expect(panel.getByLabel("投注原文")).toHaveValue(item.raw);
  }
});

test("edited and closed modal drafts reject late quotes and recover from preview failure", async ({
  page,
}) => {
  const panel = await openEntry(page);
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => (releaseFirst = resolve));
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => (firstStarted = resolve));
  let failOnce = true;
  await page.route("**/api/slips/preview", async (route) => {
    const amount = route.request().postDataJSON().items[0].amount;
    if (amount === "10") {
      const response = await route.fetch();
      firstStarted();
      await first;
      await route.fulfill({ response }).catch(() => {});
    } else if (amount === "40" && failOnce) {
      failOnce = false;
      await route.abort("failed");
    } else await route.continue();
  });
  await panel.getByLabel("投注原文").fill("特码直选07各10");
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  const dialog = review(page);
  await dialog.getByLabel("投注人", { exact: true }).fill("异步校验验收");
  await started;
  const submit = dialog.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("第1项金额", { exact: true }).fill("20");
  await expect(submit).toBeEnabled();
  releaseFirst();
  await expect(dialog.locator(".text-review-total")).toContainText("20");
  await dialog.getByLabel("第1项金额", { exact: true }).fill("40");
  await expect(
    dialog.getByRole("button", { name: "重新校验", exact: true }),
  ).toBeVisible();
  await expect(submit).toBeDisabled();
  await dialog.getByRole("button", { name: "重新校验", exact: true }).click();
  await expect(submit).toBeEnabled();
  await expect(dialog.locator(".text-review-total")).toContainText("40");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await expect(dialog.getByLabel("第1项金额", { exact: true })).toHaveValue(
    "40",
  );
  await expect(submit).toBeEnabled();
  await page.keyboard.press("Escape");
});

test("clearing or removing an invalid item excludes it, highlights the required field and records the remaining item", async ({
  page,
}) => {
  const panel = await openEntry(page);
  await panel.getByLabel("投注原文").fill("特码直选07各10\n五有牛各10");
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  const dialog = review(page);
  const submit = dialog.getByRole("button", { name: "确认录入", exact: true });
  const bettor = `空项验收-${Date.now()}`;
  await expect(
    dialog.locator(".text-review-total.needs-attention"),
  ).toContainText("请填写投注人");
  await dialog
    .getByRole("button", { name: "请填写投注人", exact: true })
    .click();
  await expect(dialog.getByLabel("投注人", { exact: true })).toBeFocused();
  await dialog.getByLabel("投注人", { exact: true }).fill(bettor);
  const invalid = dialog.getByLabel("第2项投注项", { exact: true });
  await expect(invalid).toHaveAttribute("aria-invalid", "true");
  await expect(invalid).toHaveCSS("border-color", "rgb(174, 53, 66)");
  await expect(dialog.locator(".text-row-state.attention")).toHaveText(
    "待处理",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .include('dialog[aria-label="确认投注单"]')
        .analyze()
    ).violations,
  ).toEqual([]);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/text-entry-attention-${width}.png`,
    });
  }
  await dialog
    .getByRole("button", { name: "请处理第 2 项", exact: true })
    .click();
  await expect(invalid).toBeFocused();
  await expect(submit).toBeDisabled();
  await invalid.fill("");
  await expect(dialog.locator(".text-entry-rows > li.excluded")).toHaveCount(1);
  await expect(dialog.locator(".text-entry-rows > li.excluded")).toContainText(
    "不录入",
  );
  await expect(submit).toBeEnabled();
  await invalid.fill("牛");
  await expect(submit).toBeDisabled();
  await dialog.getByRole("button", { name: "移除第2项", exact: true }).click();
  await expect(dialog.locator(".text-entry-rows > li")).toHaveCount(1);
  await expect(submit).toBeEnabled();
  await dialog.getByLabel("第1项投注项", { exact: true }).fill("");
  await expect(
    dialog.locator(".text-review-total.needs-attention"),
  ).toContainText("没有可录入的投注项");
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("第1项投注项", { exact: true }).fill("07");
  await expect(submit).toBeEnabled();
  await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await panel.getByLabel("投注原文").fill("特码直选07各10\n特码直选各20");
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await expect(submit).toBeDisabled();
  await expect(dialog.locator(".text-entry-rows > li.excluded")).toHaveCount(0);
  await expect(
    dialog.getByLabel("第2项投注项", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  // Keep an excluded invalid alias row present during submission: its preference
  // must not be sent, because it is not represented by any recorded line.
  await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await panel.getByLabel("投注原文").fill("特码直选07各10\n待排除玩法：牛各10");
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await dialog.getByLabel("第2项投注项", { exact: true }).fill("");
  await expect(submit).toBeEnabled();
  const request = page.waitForRequest(
    (r) => r.url().endsWith("/api/slips") && r.method() === "POST",
  );
  await submit.click();
  const payload = (await request).postDataJSON();
  expect(payload.items).toHaveLength(1);
  expect(payload.text_preferences ?? []).not.toContainEqual(
    expect.objectContaining({ alias: "待排除玩法" }),
  );
  await expect(dialog).toHaveCount(0);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const saved = await (
    await page.request.post("/api/records/search", {
      headers: { "X-MarkSix": "1" },
      data: { period: boot.today.id, bettors: [bettor] },
    })
  ).json();
  expect(saved.total).toBe(1);
  expect(saved.items[0].items).toHaveLength(1);
  expect(saved.items[0].stake).toBe(1000);
});
