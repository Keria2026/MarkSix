import { test, expect } from "./authenticated";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Play } from "../src/lib/types";

const navigation = (page: Page) =>
  page.getByRole("navigation", { name: "主要导航" });
async function settings(page: Page) {
  await navigation(page)
    .getByRole("button", { name: "玩法与配置", exact: true })
    .click();
  await page.getByRole("button", { name: "配置设置", exact: false }).click();
  return page.getByRole("region", { name: "功能模块", exact: true });
}
async function entry(page: Page) {
  await navigation(page)
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
}
async function toggle(page: Page, name: string, value: boolean) {
  const panel = await settings(page);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/settings/features") &&
      r.request().method() === "PUT",
  );
  await panel.getByRole("switch", { name, exact: true }).setChecked(value);
  expect((await response).ok()).toBe(true);
  await expect(panel.getByRole("switch", { name, exact: true })).toBeEnabled();
}

test("module switches persist, hide all disabled entries and reject disabled write paths", async ({
  page,
}) => {
  const bettor = `禁用路径验收-${Date.now()}`;
  const flags = { layoffs: false, manual_entry: true, text_entry: true };
  expect(
    (
      await page.request.put("/api/settings/features", {
        headers: { "X-MarkSix": "1" },
        data: flags,
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  await navigation(page)
    .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
    .click();
  await expect(
    navigation(page).getByRole("button", { name: "飞出受注统计", exact: true }),
  ).toHaveCount(0);
  await navigation(page)
    .getByRole("button", { name: "全部受注统计", exact: true })
    .click();
  await expect(page.getByText("飞出本金", { exact: true })).toHaveCount(0);
  await expect(page.getByText("自留本金", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "飞出记录", exact: true }),
  ).toHaveCount(0);
  await entry(page);
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "文本录注", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await entry(page);
  await expect(
    page.getByRole("button", { name: "文本录注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await toggle(page, "手工录注", false);
  await entry(page);
  await expect(
    page.getByRole("button", { name: "手工录注", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "文本录注", exact: true }),
  ).toBeVisible();
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const play = boot.plays.find((p: Play) => p.rule.name === "特码直选");
  const item = {
    play_id: play.id,
    play_version: play.version,
    selections: [7],
    compound: false,
    amount: "10",
  };
  const single = {
    ...item,
    period: boot.today.id,
    bettor,
    request_id: crypto.randomUUID(),
  };
  expect(
    (
      await page.request.post("/api/bets", {
        headers: { "X-MarkSix": "1" },
        data: single,
      })
    ).status(),
  ).toBe(403);
  await toggle(page, "文本录注", false);
  await expect(
    navigation(page).getByRole("button", { name: "录入投注", exact: true }),
  ).toHaveCount(0);
  await navigation(page)
    .getByRole("button", { name: "本期概览", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "录入投注", exact: true }),
  ).toHaveCount(0);
  const slip = {
    period: boot.today.id,
    bettor,
    request_id: crypto.randomUUID(),
    entry_mode: "text",
    items: [item],
  };
  expect(
    (
      await page.request.post("/api/slips", {
        headers: { "X-MarkSix": "1" },
        data: slip,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post("/api/slips/preview", {
        headers: { "X-MarkSix": "1" },
        data: { period: boot.today.id, bettor, items: [item] },
      })
    ).status(),
  ).toBe(403);
  await toggle(page, "手工录注", true);
  expect(
    (await (await page.request.get("/api/bootstrap")).json()).features
      .entry_mode,
  ).toBe("manual");
  await entry(page);
  await expect(
    page.getByRole("button", { name: "手工录注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "文本录注", exact: true }),
  ).toHaveCount(0);
  const panel = await settings(page);
  await page.route("**/api/settings/features", (route) =>
    route.abort("failed"),
  );
  await panel.getByRole("switch", { name: "飞出投注", exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(
    panel.getByRole("switch", { name: "飞出投注", exact: true }),
  ).not.toBeChecked();
  await page.unroute("**/api/settings/features");
  await toggle(page, "飞出投注", true);
  await expect(
    navigation(page).getByRole("button", { name: "飞出受注统计", exact: true }),
  ).toBeVisible();
  await navigation(page)
    .getByRole("button", { name: "全部受注统计", exact: true })
    .click();
  await expect(page.getByText("飞出本金", { exact: true })).toBeVisible();
  const created = await page.request.post("/api/bets", {
    headers: { "X-MarkSix": "1" },
    data: { ...single, request_id: crypto.randomUUID() },
  });
  expect(created.ok()).toBe(true);
  const betId = (await created.json()).id;
  const flown = await page.request.post(`/api/bets/${betId}/layoffs`, {
    headers: { "X-MarkSix": "1" },
    data: {
      request_id: crypto.randomUUID(),
      revision: 1,
      amount: "2",
      receiver: "模块保留验收",
    },
  });
  expect(flown.ok()).toBe(true);
  const flyId = (await flown.json()).id;
  await toggle(page, "飞出投注", false);
  const retained = await (await page.request.get(`/api/bets/${betId}`)).json();
  expect(retained.layoffs).toHaveLength(1);
  expect(retained.layoffs[0].id).toBe(flyId);
  expect(
    (
      await page.request.post(`/api/layoffs/${flyId}/cancel`, {
        headers: { "X-MarkSix": "1" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await navigation(page)
    .getByRole("button", { name: "本期概览", exact: true })
    .click();
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await page.getByText("投注人多选", { exact: false }).click();
  await page.getByRole("checkbox", { name: bettor, exact: true }).check();
  await page
    .getByRole("region", { name: "数据表格，可横向滚动", exact: true })
    .getByRole("row")
    .filter({ hasText: bettor })
    .getByRole("button", { name: "详情", exact: false })
    .click();
  const detail = page.getByRole("dialog", {
    name: "投注记录详情",
    exact: true,
  });
  await expect(
    detail.getByRole("button", { name: "飞出", exact: true }),
  ).toHaveCount(0);
  await expect(
    detail.getByRole("heading", { name: "关联飞出", exact: true }),
  ).toHaveCount(0);
});

test("confirmed special-number fee variants follow each bettor and preserve explicit original names", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const base: Play = boot.plays.find((p: Play) => p.rule.name === "特码直选");
  const variants: { id: number; name: string }[] = [];
  for (const [tag, odds, water] of [
    ["甲", "44", "3"],
    ["乙", "48", "1"],
  ]) {
    const rule = {
      ...base.rule,
      name: `特码费率${tag}-${Date.now()}`,
      odds,
      rebate_percent: water,
    };
    const response = await page.request.post("/api/plays", {
      headers: { "X-MarkSix": "1" },
      data: rule,
    });
    expect(response.ok()).toBe(true);
    variants.push({ id: (await response.json()).id, name: rule.name });
  }
  const bettors = [`费率甲-${Date.now()}`, `费率乙-${Date.now()}`];
  await page.goto("/");
  await entry(page);
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  const panel = page.getByRole("region", { name: "文本录注", exact: true });
  const dialog = page.getByRole("dialog", { name: "确认投注单", exact: true });
  const submit = dialog.getByRole("button", { name: "确认录入", exact: true });
  for (let i = 0; i < 2; i++) {
    await panel.getByLabel("投注原文").fill("特码直选07各10");
    await panel.getByRole("button", { name: "校验", exact: true }).click();
    await dialog.getByLabel("投注人", { exact: true }).fill(bettors[i]);
    await expect(dialog.getByLabel("特码费率", { exact: true })).toBeEnabled();
    await expect(submit).toBeEnabled();
    await expect(dialog.getByLabel("特码费率", { exact: true })).toHaveValue(
      String(base.id),
    );
    await dialog
      .getByLabel("特码费率", { exact: true })
      .selectOption(String(variants[i].id));
    await expect(submit).toBeEnabled();
    const request = page.waitForRequest(
      (r) => r.url().endsWith("/api/slips") && r.method() === "POST",
    );
    await submit.click();
    const payload = (await request).postDataJSON();
    expect(payload.entry_mode).toBe("text");
    expect(payload.bettor_preference.play_id).toBe(variants[i].id);
    expect(payload.items[0].play_id).toBe(variants[i].id);
    await expect(dialog).toHaveCount(0);
    const lookup = await (
      await page.request.post("/api/text-entry/bettor-preference", {
        headers: { "X-MarkSix": "1" },
        data: { bettor: bettors[i] },
      })
    ).json();
    expect(lookup.preference.play_id).toBe(variants[i].id);
  }
  const invalidBettor = `费率事务失败-${Date.now()}`;
  const invalidReceipt = {
    period: boot.today.id,
    bettor: invalidBettor,
    request_id: crypto.randomUUID(),
    entry_mode: "text",
    items: [
      {
        play_id: base.id,
        play_version: base.version,
        selections: [7],
        compound: false,
        amount: "10",
      },
    ],
    bettor_preference: {
      play_id: variants[0].id,
      play_version: 1,
      amount_mode: "auto",
    },
  };
  expect(
    (
      await page.request.post("/api/slips", {
        headers: { "X-MarkSix": "1" },
        data: invalidReceipt,
      })
    ).status(),
  ).toBe(422);
  const invalidSearch = await (
    await page.request.post("/api/records/search", {
      headers: { "X-MarkSix": "1" },
      data: { period: boot.today.id, bettors: [invalidBettor] },
    })
  ).json();
  expect(invalidSearch.total).toBe(0);
  expect(
    (
      await (
        await page.request.post("/api/text-entry/bettor-preference", {
          headers: { "X-MarkSix": "1" },
          data: { bettor: invalidBettor },
        })
      ).json()
    ).preference,
  ).toBeNull();
  await page.reload();
  await entry(page);
  await expect(
    page.getByRole("button", { name: "文本录注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await panel.getByLabel("投注原文").fill("特码直选08各10");
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await dialog.getByLabel("投注人", { exact: true }).fill(bettors[0]);
  await expect(dialog.getByLabel("特码费率", { exact: true })).toHaveValue(
    String(variants[0].id),
  );
  await expect(submit).toBeEnabled();
  await dialog.getByLabel("第1项金额", { exact: true }).fill("15");
  await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await expect(dialog.getByLabel("第1项金额", { exact: true })).toHaveValue(
    "15",
  );
  await expect(dialog.getByLabel("特码费率", { exact: true })).toHaveValue(
    String(variants[0].id),
  );
  await dialog.getByLabel("投注人", { exact: true }).fill(bettors[1]);
  await expect(dialog.getByLabel("特码费率", { exact: true })).toHaveValue(
    String(variants[1].id),
  );
  await expect(submit).toBeEnabled();
  await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await panel.getByLabel("投注原文").fill(`${variants[1].name}08各10`);
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await dialog.getByLabel("投注人", { exact: true }).fill(bettors[0]);
  await expect(submit).toBeEnabled();
  await expect(dialog.getByLabel("特码费率", { exact: true })).toHaveValue(
    String(variants[1].id),
  );
  await dialog.getByLabel("投注人", { exact: true }).fill("");
  await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await panel.getByLabel("投注原文").fill("特码直选09各10");
  await panel.getByRole("button", { name: "校验", exact: true }).click();
  await dialog.getByLabel("投注人", { exact: true }).fill("");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  await page.route("**/api/text-entry/bettor-preference", async (route) => {
    if (route.request().postDataJSON().bettor === bettors[0]) {
      const response = await route.fetch();
      markStarted();
      await held;
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await dialog.getByLabel("投注人", { exact: true }).fill(bettors[0]);
  await started;
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("投注人", { exact: true }).fill(bettors[1]);
  await expect(submit).toBeEnabled();
  await expect(dialog.getByLabel("特码费率", { exact: true })).toHaveValue(
    String(variants[1].id),
  );
  release();
  await expect(dialog.getByLabel("特码费率", { exact: true })).toHaveValue(
    String(variants[1].id),
  );
});

test("overview functional text, primary contrast and flat record filters remain readable at narrow widths", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  for (const width of [1499, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const selector of [
      ".connection",
      ".top-clock small",
      ".account small",
      ".version",
      ".ball-caption small",
      ".page-heading p",
      ".risk-state .status-badge",
      ".count-badge",
      ".table-tag",
      ".table-footer",
    ]) {
      for (const element of await page.locator(selector).all())
        if (await element.isVisible()) {
          expect(
            await element.evaluate((el) =>
              parseFloat(getComputedStyle(el).fontSize),
            ),
            selector,
          ).toBeGreaterThanOrEqual(11);
        }
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator(".record-picker").first()).toHaveCSS(
      "border-radius",
      "0px",
    );
    await page.screenshot({
      path: `test-results/readability-${width}.png`,
      fullPage: true,
    });
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
