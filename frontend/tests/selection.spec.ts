import { test, expect, type Locator, type Page } from "@playwright/test";

async function openZodiacs(page: Page) {
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注" })
    .click();
  await page.getByRole("button", { name: "五有" }).click();
}

async function appearance(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      image: style.backgroundImage,
      border: style.borderTopColor,
      shadow: style.boxShadow,
    };
  });
}

test.describe("touch selection", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("deselecting a zodiac restores the untouched white appearance", async ({
    page,
  }) => {
    await openZodiacs(page);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    const dog = page.getByRole("button", { name: "狗", exact: true });
    const base = await appearance(
      page.getByRole("button", { name: "猪", exact: true }),
    );
    for (const name of ["蛇", "马", "羊", "鸡"])
      await page.getByRole("button", { name, exact: true }).tap();

    // Repeat without tapping elsewhere: touch Safari can retain the last hover.
    for (let i = 0; i < 2; i++) {
      await dog.tap();
      await expect(dog).toHaveAttribute("aria-pressed", "true");
      await expect(dog.locator(".selection-check")).toHaveCount(1);
      await expect
        .poll(async () => (await appearance(dog)).image)
        .not.toBe("none");
      await dog.tap();
      await expect(dog).toHaveAttribute("aria-pressed", "false");
      await expect(dog.locator(".selection-check")).toHaveCount(0);
      await expect.poll(() => appearance(dog)).toEqual(base);
      await expect(page.locator(".selection-meta")).toContainText("已选 4 项");
      await expect(page.locator(".option.selected")).toHaveCount(4);
    }
    await page.getByRole("button", { name: "清空选择", exact: true }).tap();
    await expect(page.locator(".option.selected")).toHaveCount(0);
    await expect.poll(() => appearance(dog)).toEqual(base);
  });
});

test("mouse hover preserves selection fill and keyboard focus stays visible", async ({
  page,
}) => {
  await openZodiacs(page);
  const dog = page.getByRole("button", { name: "狗", exact: true });
  const base = await appearance(
    page.getByRole("button", { name: "猪", exact: true }),
  );
  await dog.click();
  await dog.hover();
  await expect(dog).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await appearance(dog)).image).not.toBe("none");
  await dog.click();
  await expect(dog).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () => (await appearance(dog)).background)
    .toBe(base.background);
  await expect.poll(async () => (await appearance(dog)).image).toBe("none");
  await expect(dog.locator(".selection-check")).toHaveCount(0);
  await page.keyboard.press("Tab");
  const pig = page.getByRole("button", { name: "猪", exact: true });
  await expect(pig).toBeFocused();
  expect(
    await pig.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.matches(":focus-visible") && style.outlineStyle !== "none";
    }),
  ).toBe(true);
});
