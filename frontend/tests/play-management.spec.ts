import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
}

test("same-name import and multi-select changes preserve IDs and manage all selected rules", async ({
  page,
}) => {
  await login(page);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const prefix = `批量-${randomUUID().slice(0, 8)}`;
  const original = boot.plays.find(
    (p: { rule: { kind: string } }) => p.rule.kind === "number",
  ).rule;
  const plays = ["甲", "乙"].map((name) => ({
    rule: { ...original, name: prefix + name },
    enabled: true,
  }));
  const ids: number[] = [];
  try {
    for (const play of plays) {
      const r = await page.request.post("/api/plays", {
        headers: { "X-MarkSix": "1" },
        data: play.rule,
      });
      expect(r.ok()).toBe(true);
      ids.push((await r.json()).id);
    }
    await page
      .getByRole("navigation", { name: "主要导航" })
      .getByRole("button", { name: "玩法与配置", exact: true })
      .click();
    await page.getByLabel("选择玩法文件").setInputFiles({
      name: "rules.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "marksix-play-rules",
          schema: 1,
          plays: plays.map((p) => ({
            ...p,
            rule: { ...p.rule, odds: "45" },
          })),
        }),
      ),
    });
    const preview = page.getByRole("dialog", { name: "导入玩法规则" });
    await expect(preview).toContainText("同名默认覆盖");
    await preview
      .getByRole("button", { name: "确认导入", exact: true })
      .click();
    await expect(preview).toHaveCount(0);
    let state = await (await page.request.get("/api/bootstrap")).json();
    expect(
      state.plays
        .filter((p: { id: number }) => ids.includes(p.id))
        .map((p: { version: number }) => p.version),
    ).toEqual([2, 2]);
    await page.getByLabel("搜索配置玩法").fill(prefix);
    await page.getByLabel("选择当前结果").check();
    await page.getByRole("button", { name: "批量调整", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "批量调整玩法",
      exact: true,
    });
    await dialog.getByLabel("批量含本赔率").fill("46");
    await dialog.getByLabel("批量反水比例（%）").fill("9");
    // A background refresh must not silently replace the versions reviewed in this dialog.
    const external = await page.request.put(`/api/plays/${ids[0]}`, {
      headers: { "X-MarkSix": "1" },
      data: {
        version: 2,
        rule: { ...plays[0].rule, odds: "45" },
        enabled: true,
      },
    });
    expect(external.ok()).toBe(true);
    await expect(
      page.getByRole("button").filter({
        has: page.getByRole("heading", {
          name: plays[0].rule.name,
          exact: true,
        }),
      }),
    ).toContainText("V3", { timeout: 10000 });
    await dialog
      .getByRole("button", { name: "保存批量调整", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("所选玩法已变化");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "批量调整", exact: true }).click();
    await dialog.getByLabel("批量含本赔率").fill("46");
    await dialog.getByLabel("批量反水比例（%）").fill("9");

    await dialog
      .getByRole("button", { name: "保存批量调整", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    state = await (await page.request.get("/api/bootstrap")).json();
    for (const id of ids) {
      const p = state.plays.find((p: { id: number }) => p.id === id);
      expect(p.version).toBe(id === ids[0] ? 4 : 3);
      expect(p.rule.odds).toBe("46");
      expect(p.rule.rebate_percent).toBe("9");
    }
    await page.getByLabel("选择当前结果").check();
    await page.getByRole("button", { name: "批量删除", exact: true }).click();
    await page
      .getByRole("dialog", { name: "批量删除玩法" })
      .getByRole("button", { name: "确认批量删除", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".play-management-item")).toHaveCount(0);
    await page.getByRole("button", { name: "配置设置", exact: false }).click();
    await expect(
      page.getByRole("heading", { name: "投注时间", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "清空我的历史记录", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".play-settings-grid")).toHaveCount(0);
  } finally {
    const state = await (await page.request.get("/api/bootstrap")).json();
    const targets = state.plays
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

test("long picker collapses while search and explicit submenu preferences survive navigation and reload", async ({
  page,
}) => {
  await login(page);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const base = boot.plays.find(
    (p: { rule: { kind: string } }) => p.rule.kind === "number",
  ).rule;
  const prefix = `折叠-${randomUUID().slice(0, 8)}`;
  const ids: number[] = [];
  try {
    for (let i = 0; i < 7; i++) {
      const r = await page.request.post("/api/plays", {
        headers: { "X-MarkSix": "1" },
        data: { ...base, name: `${prefix}-${i}` },
      });
      expect(r.ok()).toBe(true);
      ids.push((await r.json()).id);
    }
    const nav = page.getByRole("navigation", { name: "主要导航" });
    await nav.getByRole("button", { name: "录入投注", exact: true }).click();
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect(page.locator(".play-picker button")).toHaveCount(6);
    await page.getByRole("button", { name: /展开全部 .* 个玩法/ }).click();
    await expect(page.locator(".play-picker button")).toHaveCount(
      boot.plays.filter((p: { enabled: boolean }) => p.enabled).length + 7,
    );
    await page
      .getByRole("button", { name: "收起玩法列表", exact: true })
      .click();
    await page.getByLabel("搜索玩法名称").fill(`${prefix}-6`);
    await expect(page.locator(".play-picker button")).toHaveCount(1);
    await expect(page.locator(".play-picker button.selected")).toContainText(
      `${prefix}-6`,
    );
    await nav.getByRole("button", { name: "本期统计", exact: true }).click();
    await expect(nav.locator(".nav-submenu")).toHaveCount(0);
    await nav
      .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
      .click();
    await nav.getByRole("button", { name: "本期概览", exact: true }).click();
    await nav.getByRole("button", { name: "本期统计", exact: true }).click();
    await expect(nav.locator(".nav-submenu")).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "本期概览", exact: true }),
    ).toBeVisible();
    await nav.getByRole("button", { name: "本期统计", exact: true }).click();
    await expect(nav.locator(".nav-submenu")).toBeVisible();
    await nav
      .getByRole("button", { name: "收起本期统计二级菜单", exact: true })
      .click();
    await nav.getByRole("button", { name: "本期概览", exact: true }).click();
    await nav.getByRole("button", { name: "本期统计", exact: true }).click();
    await expect(nav.locator(".nav-submenu")).toHaveCount(0);
  } finally {
    const state = await (await page.request.get("/api/bootstrap")).json();
    const targets = state.plays
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
