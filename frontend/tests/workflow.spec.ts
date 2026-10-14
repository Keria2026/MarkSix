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
    page.getByRole("heading", { name: "每一期，都清晰在握。" }),
  ).toBeVisible();
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "录入投注" }).click();
  await page.getByRole("button", { name: "五有" }).click();
  await page.getByRole("button", { name: "复式", exact: true }).click();
  for (const name of ["鼠", "牛", "虎", "兔", "龙", "蛇", "马"])
    await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByText("¥ 18,000.00", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-total")).toContainText("¥ 2,100.00");
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
  await nav.getByRole("button", { name: "历史统计" }).click();
  await expect(page.locator("tbody")).toContainText("2026287");
  await page.setViewportSize({ width: 390, height: 844 });
  await nav.getByRole("button", { name: "本期概览" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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
