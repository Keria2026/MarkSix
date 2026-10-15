import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("administrator records compound bets, cancels atomically, configures rules, and navigates mobile", async ({
  page,
}) => {
  const password = process.env.TEST_ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      "TEST_ADMIN_PASSWORD must match the disposable e2e_server account",
    );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("管理员账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "录入投注" }).click();
  await page.getByRole("button", { name: "五有" }).click();
  await expect(
    page.getByRole("button", { name: "复式", exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "玩法与配置" }).click();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "五有", exact: true }) })
    .click();
  await page.getByLabel("启用复式投注").check();
  await page.getByRole("button", { name: "保存玩法" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav.getByRole("button", { name: "录入投注" }).click();
  await page.getByRole("button", { name: "五有" }).click();
  await page.getByRole("button", { name: "复式", exact: true }).click();
  for (const name of ["鼠", "牛", "虎", "兔", "龙", "蛇", "马"])
    await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByText("¥ 18,000.00", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-total")).toContainText("¥ 2,100.00");
  await page.getByLabel("投注人", { exact: true }).fill("张三");
  await page.getByRole("button", { name: "确认录入投注" }).click();
  await expect(page.getByRole("status")).toContainText("投注已记录");
  await nav.getByRole("button", { name: "本期概览" }).click();
  const row = page.locator("tbody tr").filter({ hasText: "五有" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("21 注");
  await row.getByRole("button", { name: "详情" }).click();
  await expect(
    page.getByRole("dialog", { name: "投注记录详情" }).locator("tbody tr"),
  ).toHaveCount(21);
  await page.getByRole("button", { name: "修改金额", exact: true }).click();
  await page.getByLabel("修改后的每注金额（整数元）").fill("150");
  await page.getByRole("button", { name: "确认修改", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "投注记录详情" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "飞出", exact: true }).click();
  await page.getByLabel("飞出受注方").fill("李四");
  await page.getByLabel("每条基础注飞出金额（元）").fill("40");
  await page.getByRole("button", { name: "确认飞出", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "投注记录详情" }),
  ).toContainText("李四");
  await page.keyboard.press("Escape");
  await nav.getByRole("button", { name: "本期统计", exact: true }).click();
  await nav.getByRole("button", { name: "飞出受注统计", exact: true }).click();
  await expect(page.locator(".ledger-stats")).toContainText("¥ 840.00");
  await expect(page.locator(".ledger-stats")).toContainText("¥ 2,310.00");
  await nav
    .getByRole("button", { name: "投注人分类统计", exact: true })
    .click();
  await expect(page.locator("tbody")).toContainText("张三");
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  await page.getByLabel("投注总额下限（元）").fill("3200");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await row.getByRole("button", { name: "详情" }).click();
  await page.getByRole("button", { name: "撤销飞出", exact: true }).click();
  await page.getByRole("button", { name: "确认撤销飞出", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await row.getByRole("button", { name: "详情" }).click();
  await page.getByRole("button", { name: "撤销整条记录" }).click();
  await page.getByRole("button", { name: "确认撤销", exact: true }).click();
  await expect(row).toContainText("已撤销");
  await expect(page.locator(".stat").first()).toContainText("¥ 0.00");
  await nav.getByRole("button", { name: "玩法与配置" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "新建玩法" }).click();
  await page.getByLabel("玩法名称").fill("尾数验收玩法");
  await page.getByLabel("投注对象", { exact: true }).selectOption("tail");
  await page.getByLabel("开奖对比范围").selectOption("all");
  await page.getByLabel("命中条件").selectOption("any");
  await page.getByLabel("含本赔率", { exact: true }).fill("3.1234");
  await page.getByRole("button", { name: "保存玩法" }).click();
  await expect(
    page.getByRole("heading", { name: "尾数验收玩法" }),
  ).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "五有", exact: true }) })
    .click();
  await expect(page.getByLabel("玩法名称")).toHaveValue("五有");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "新建玩法" }).click();
  await page.getByLabel("玩法名称").fill("三中二验收");
  await page.getByLabel("命中条件").selectOption("at_least");
  await page.getByLabel("开奖对比范围").selectOption("regular");
  await page.getByLabel("数量阈值", { exact: true }).fill("3");
  await page.getByLabel("最少命中数量").fill("2");
  await page.getByRole("button", { name: "保存玩法" }).click();
  await expect(page.getByRole("heading", { name: "三中二验收" })).toBeVisible();
  await nav.getByRole("button", { name: "历史统计" }).click();
  await expect(page.locator("tbody")).toContainText("2026287");
  await page
    .locator("tbody tr")
    .filter({ hasText: "2026287" })
    .getByRole("button")
    .click();
  await expect(
    page.getByRole("heading", { name: "历史统计 · 第 2026287 期" }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "历史统计", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await nav.getByRole("button", { name: "官方频道", exact: true }).click();
  await expect(page.locator("iframe")).toHaveAttribute(
    "src",
    "https://macaujc.com/picker/",
  );
  // API waves take precedence over the local table: 01 is normally red.
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.today.draw = {
      expect: "2026287",
      open_time: "2026-10-14T21:32:00",
      numbers: [1, 2, 3, 4, 5, 6, 7],
      waves: [2, 0, 1, 2, 0, 1, 2],
      zodiac: [6, 5, 4, 3, 2, 1, 0],
    };
    await route.fulfill({ response, json });
  });
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.locator(".draw-panel .ball").first()).toHaveAttribute(
    "data-wave",
    "2",
  );
  await expect(page.locator(".draw-panel .ball").first()).toHaveAttribute(
    "aria-label",
    "01 绿波",
  );
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await nav.getByRole("button", { name: "本期概览" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/overview-mobile.png",
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations.map((v) => ({
      id: v.id,
      description: v.description,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  expect(errors).toEqual([]);
});
