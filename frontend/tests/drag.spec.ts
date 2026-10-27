import { test, expect } from "./authenticated";
import { randomUUID } from "node:crypto";

test("drag builds cross-pool and fixed-option slips, preserves drafts and rejects boundaries", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const base = boot.plays.find(
    (p: { rule: { kind: string; quantity: number } }) =>
      p.rule.kind === "number" && p.rule.quantity === 1,
  ).rule;
  const prefix = `拖测试-${randomUUID().slice(0, 8)}`;
  const ids: number[] = [];
  const rules = [
    {
      ...base,
      name: `${prefix}二中特`,
      scope: "all",
      condition: "all",
      quantity: 2,
      relation: "eq",
      combination_size: 2,
      compound_enabled: true,
      odds: "55",
      rebate_percent: "10",
      special_hit_odds: "25",
      special_odds: null,
      special_rebate_percent: null,
      selection_limit: null,
    },
    {
      ...base,
      name: `${prefix}三有`,
      kind: "zodiac",
      scope: "all",
      condition: "all",
      quantity: 3,
      relation: "eq",
      combination_size: 3,
      compound_enabled: true,
      odds: "10",
      rebate_percent: "10",
      special_hit_odds: null,
      special_odds: null,
      special_rebate_percent: null,
      selection_limit: null,
    },
  ];
  try {
    for (const rule of rules) {
      const response = await page.request.post("/api/plays", {
        headers: { "X-MarkSix": "1" },
        data: rule,
      });
      expect(response.ok()).toBeTruthy();
      ids.push((await response.json()).id);
    }
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "主要导航" });
    await nav.getByRole("button", { name: "录入投注", exact: true }).click();
    await page.getByLabel("搜索玩法名称").fill(rules[0].name);
    await page.getByRole("button", { name: "拖", exact: true }).click();
    await page.getByLabel("投注人", { exact: true }).fill(prefix);
    await page.getByLabel("每注金额", { exact: true }).fill("15");
    await page.getByLabel("拖左边选项").fill("06、18");
    await page.getByLabel("拖右边选项").fill("27.36");
    const summary = page.locator(".bet-summary");
    await expect(summary).toContainText("4 注");
    await expect(summary.locator(".summary-total")).toContainText("60.00");
    await nav.getByRole("button", { name: "本期概览", exact: true }).click();
    await nav.getByRole("button", { name: "录入投注", exact: true }).click();
    await expect(page.getByLabel("拖左边选项")).toHaveValue("06、18");
    await page.getByLabel("拖右边选项").fill("06 27");
    await expect(
      page.getByRole("button", { name: "确认录入投注", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("重叠");
    await page
      .getByRole("button", { name: "生肖展开号码", exact: true })
      .click();
    await page.getByLabel("拖左边选项").fill("牛");
    await page.getByLabel("拖右边选项").fill("龙");
    await expect(summary).toContainText("16 注");
    await expect(summary.locator(".summary-total")).toContainText("240.00");
    await page.getByRole("button", { name: "加入组合单", exact: true }).click();
    await page.getByLabel("搜索玩法名称").fill(rules[1].name);
    await page.getByRole("button", { name: "拖", exact: true }).click();
    await page.getByLabel("拖左边选项").fill("鼠 牛");
    await page.getByLabel("拖右边选项").fill("龙 兔 狗");
    await expect(summary).toContainText("3 注");
    await page.getByLabel("每注金额", { exact: true }).fill("20.5");
    await page.getByRole("button", { name: "加入组合单", exact: true }).click();
    const slip = page.getByLabel("组合单草稿");
    await expect(slip).toContainText("牛 拖 龙");
    await expect(slip).toContainText("鼠、牛 拖 龙、兔、狗");
    await expect(slip).toContainText("301.50");
    const submitted = page.waitForResponse(
      (r) => r.url().endsWith("/api/slips") && r.request().method() === "POST",
    );
    await slip.getByRole("button", { name: /确认录入组合单/ }).click();
    const response = await submitted;
    expect(response.ok()).toBeTruthy();
    const saved = await response.json();
    const record = await (
      await page.request.get(`/api/slips/${saved.id}`)
    ).json();
    expect(record.stake).toBe(30150);
    expect(record.unit_count).toBe(19);
    expect(record.items[0].drag).toEqual({
      left: [1],
      right: [4],
      zodiac: true,
    });
    expect(record.items[1].drag).toEqual({
      left: [0, 1],
      right: [4, 3, 10],
      zodiac: false,
    });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
    }
  } finally {
    const current = await (await page.request.get("/api/bootstrap")).json();
    const targets = current.plays
      .filter((p: { id: number }) => ids.includes(p.id))
      .map((p: { id: number; version: number }) => ({
        id: p.id,
        version: p.version,
      }));
    if (targets.length)
      await page.request.post("/api/plays/batch", {
        headers: { "X-MarkSix": "1" },
        data: { action: "delete", targets },
      });
  }
});
