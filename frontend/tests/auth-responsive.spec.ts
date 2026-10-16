import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("auth customer actions and dialogs fit mobile glass layouts", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/site")
      return route.fulfill({ json: { mode: "authority" } });
    if (path === "/api/session")
      return route.fulfill({ json: { username: "owner" } });
    if (path === "/api/accounts")
      return route.fulfill({
        json: {
          items: [
            {
              id: "responsive-test",
              username: "测试客户账号很长仍需正确换行123456789",
              permanent: false,
              authorized_through: "2027-01-01",
              disabled: false,
              state: "ready",
              active: true,
            },
          ],
        },
      });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "客户管理", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".owner-brand")).toContainText("auth");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const card = page.locator(".owner-card").first();
    const bounds = (await card.boundingBox())!;
    for (const button of await card.getByRole("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    for (const name of ["新增客户", "修改账号", "签发激活码"]) {
      await page.getByRole("button", { name, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(
        true,
      );
      await dialog.locator(".owner-actions").scrollIntoViewIfNeeded();
      const dialogBounds = (await dialog.boundingBox())!;
      for (const button of await dialog
        .locator(".owner-actions button")
        .all()) {
        const box = (await button.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(dialogBounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(
          dialogBounds.x + dialogBounds.width,
        );
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
    }
    if (width === 390)
      await page.screenshot({
        path: "test-results/auth-mobile.png",
        fullPage: true,
      });
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
