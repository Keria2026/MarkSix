import { test, expect } from "./authenticated";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
});

test("recording schedule is fixed to Beijing 06:00 and has no obsolete time editor", async ({
  page,
}) => {
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "玩法与配置", exact: true })
    .click();
  await page.getByRole("button", { name: "配置设置", exact: false }).click();
  const schedule = page.locator(".closing-panel");
  await expect(schedule).toContainText("次日 06:00");
  await expect(schedule).toContainText("21:34");
  await expect(schedule.locator("input")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存时间", exact: false }),
  ).toHaveCount(0);
});

test("all shared dialogs animate, reduced motion is respected, and nested dialogs keep the page locked", async ({
  page,
}) => {
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "玩法与配置", exact: true })
    .click();
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    (window as unknown as { modalDurations: number[] }).modalDurations = [];
    Element.prototype.animate = function (
      ...args: Parameters<typeof original>
    ) {
      if (this.matches("dialog.modal")) {
        const timing = args[1];
        (window as unknown as { modalDurations: number[] }).modalDurations.push(
          typeof timing === "number" ? timing : Number(timing?.duration ?? 0),
        );
      }
      return original.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "新建玩法", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建玩法" });
  await expect(create).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { modalDurations: number[] }).modalDurations.some(
          (d) => d > 0,
        ),
      ),
    )
    .toBe(true);
  await create.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator('dialog[aria-label="新建玩法"]')).toHaveCount(0);
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "五有", exact: true }) })
    .click();
  await page.getByRole("button", { name: "删除玩法", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "删除玩法？" });
  await expect(confirm).toBeVisible();
  expect(await page.evaluate(() => document.body.style.position)).toBe("fixed");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator('dialog[aria-label="删除玩法？"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.position)).not.toBe(
    "fixed",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  const before = await page.evaluate(
    () =>
      (window as unknown as { modalDurations: number[] }).modalDurations.filter(
        (d) => d > 0,
      ).length,
  );
  await page.getByRole("button", { name: "新建玩法", exact: true }).click();
  await expect(create).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { modalDurations: number[] }
        ).modalDurations.filter((d) => d > 0).length,
    ),
  ).toBe(before);
  await create.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator('dialog[aria-label="新建玩法"]')).toHaveCount(0);
});
