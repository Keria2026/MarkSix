import { test, expect } from "./authenticated";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
});

test("time changes request credentials only after submission; modal blocks background and restores scrolling", async ({
  page,
}) => {
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "玩法与配置", exact: true })
    .click();
  await page.getByRole("button", { name: "配置设置", exact: false }).click();
  const submissions: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/settings/closing"))
      submissions.push(request.postDataJSON());
  });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(page.getByLabel("验证密码", { exact: true })).toHaveCount(0);
    await page.getByLabel("新的开始时间").fill("09:00");
    await page.getByLabel("新的封盘时间").fill("22:00");
    await page
      .getByRole("button", { name: "保存时间", exact: false })
      .evaluate((element) =>
        element.scrollIntoView({ block: "center", behavior: "instant" }),
      );
    const offset = await page.evaluate(() => window.scrollY);
    const original = await page.locator(".closing-panel").boundingBox();
    await page.getByRole("button", { name: "保存时间", exact: false }).click();
    const dialog = page.getByRole("dialog", { name: "验证身份并保存投注时间" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("验证账号")).toHaveValue("test-admin");
    await expect(dialog.getByLabel("验证密码")).toHaveValue("");
    expect(submissions.length).toBe(width === 390 ? 0 : 2);
    await expect
      .poll(() => page.evaluate(() => document.body.style.position))
      .toBe("fixed");
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).overflow,
      ),
    ).toBe("hidden");
    await page.mouse.move(2, 100);
    await page.mouse.wheel(0, 650);
    const after = await page.locator(".closing-panel").boundingBox();
    expect(Math.abs(after!.y - original!.y)).toBeLessThan(2);
    expect(
      await page.evaluate(() => {
        const event = new Event("touchmove", {
          cancelable: true,
          bubbles: true,
        });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      page.locator('dialog[aria-label="验证身份并保存投注时间"]'),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.position)).not.toBe(
      "fixed",
    );
    expect(
      Math.abs((await page.evaluate(() => window.scrollY)) - offset),
    ).toBeLessThan(2);
    // Reauthentication is viewport-independent; exercise it once against the real server.
    if (width === 1440) continue;
    await page.getByRole("button", { name: "保存时间", exact: false }).click();
    await dialog.getByLabel("验证密码").fill("incorrect-test-password");
    await dialog
      .getByRole("button", { name: "验证并保存", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("账号或密码错误");
    await expect(dialog.getByLabel("验证密码")).toHaveValue("");
    await dialog.getByLabel("验证密码").fill(process.env.TEST_ADMIN_PASSWORD!);
    await dialog
      .getByRole("button", { name: "验证并保存", exact: true })
      .click();
    await expect(
      page.locator('dialog[aria-label="验证身份并保存投注时间"]'),
    ).toHaveCount(0);
    const last = submissions.at(-1) as {
      open_time: string;
      close_time: string;
    };
    expect(last.open_time).toBe("09:00");
    expect(last.close_time).toBe("22:00");
    await expect(page.getByLabel("验证密码", { exact: true })).toHaveCount(0);
  }
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
