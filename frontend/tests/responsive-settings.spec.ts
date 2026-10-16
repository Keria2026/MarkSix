import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
});

test("statistics submenu highlights only the current section on mobile and desktop", async ({
  page,
}) => {
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "本期统计", exact: true }).click();
  await nav
    .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
    .click();
  const submenu = nav.locator(".nav-submenu");
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of [
      "全部受注统计",
      "飞出受注统计",
      "投注人分类统计",
      "投注记录",
    ]) {
      const current = submenu.getByRole("button", { name, exact: true });
      await current.click();
      await expect(current).toHaveAttribute("aria-current", "location");
      await expect(submenu.locator("button.active")).toHaveCount(1);
      await expect(submenu.locator("[aria-current]")).toHaveCount(1);
      expect(
        await current.evaluate(
          (element) => getComputedStyle(element).backgroundImage,
        ),
      ).not.toBe("none");
      for (const other of await submenu.locator("button:not(.active)").all())
        expect(
          await other.evaluate(
            (element) => getComputedStyle(element).backgroundImage,
          ),
        ).toBe("none");
      const box = (await current.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test("rule editor fields and all actions fit the dialog without horizontal scrolling", async ({
  page,
}) => {
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "玩法与配置" })
    .click();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name: "五有", exact: true }) })
      .click();
    const dialog = page.getByRole("dialog", { name: "编辑玩法" });
    await expect(dialog).toBeVisible();
    const content = await dialog.locator(".modal-body").boundingBox();
    const nameField = (await dialog.getByLabel("玩法名称").boundingBox())!;
    const odds = (await dialog
      .getByLabel("含本赔率", { exact: true })
      .boundingBox())!;
    const rebate = (await dialog.getByLabel("反水比例（%）").boundingBox())!;
    expect(
      Math.abs(rebate.x + rebate.width - nameField.x - nameField.width),
    ).toBeLessThanOrEqual(1);
    expect(odds.x).toBeGreaterThanOrEqual(content!.x);
    expect(rebate.x + rebate.width).toBeLessThanOrEqual(
      content!.x + content!.width,
    );
    await dialog
      .getByRole("button", { name: "保存玩法", exact: true })
      .scrollIntoViewIfNeeded();
    const bounds = (await dialog.boundingBox())!;
    for (const name of ["删除玩法", "导出此玩法", "取消", "保存玩法"]) {
      const button = dialog.getByRole("button", { name, exact: true });
      await expect(button).toBeInViewport();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await dialog.evaluate((element) => {
        element.scrollLeft = 100;
        return element.scrollLeft;
      }),
    ).toBe(0);
    if (width === 390)
      await page.screenshot({
        path: "test-results/rule-editor-mobile-actions.png",
      });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  // The formerly clipped delete action remains usable, including its confirmation.
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "五有", exact: true }) })
    .click();
  await page
    .getByRole("dialog", { name: "编辑玩法" })
    .getByRole("button", { name: "删除玩法", exact: true })
    .click();
  const confirm = page.getByRole("dialog", { name: "删除玩法？" });
  await expect(
    confirm.getByRole("button", { name: "确认删除玩法" }),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "新建玩法", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建玩法" });
  await create
    .getByRole("button", { name: "保存玩法", exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await create.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(
    create.getByRole("button", { name: "取消", exact: true }),
  ).toBeInViewport();
  await create.getByRole("button", { name: "取消", exact: true }).click();
});
